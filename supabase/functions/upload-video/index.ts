// upload-video/index.ts
//
// Proxy de upload em chunks para contornar o limite de 100 MB do Cloudflare.
//
// Abordagem "streaming merge" (sem buffer em memória):
//  1. Browser envia o ficheiro em pedaços de 5 MB → edge guarda em temp/
//  2. No último chunk: cria um ReadableStream que lê os chunks do Storage
//     um de cada vez e faz pipe directo para o upload final via fetch.
//     → em memória: apenas 1 chunk (~5 MB) de cada vez, nunca o ficheiro inteiro.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-chunk-index, x-total-chunks, " +
    "x-file-path, x-file-type, x-upload-id",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader) {
      return json({ error: "Sem autorização" }, 401);
    }

    // Service-role client para operações de Storage (sem RLS)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Validar que o JWT pertence a um utilizador real
    const { data: { user }, error: authErr } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();

    if (authErr || !user) {
      return json({ error: "Token inválido" }, 401);
    }

    // ── Headers do chunk ──────────────────────────────────────────────────────
    const chunkIndex  = parseInt(req.headers.get("x-chunk-index")  || "0");
    const totalChunks = parseInt(req.headers.get("x-total-chunks") || "1");
    const filePath    = req.headers.get("x-file-path")  || "";
    const fileType    = req.headers.get("x-file-type")  || "video/mp4";
    const uploadId    = req.headers.get("x-upload-id")  || "";

    if (!filePath || !uploadId) {
      return json({ error: "x-file-path ou x-upload-id em falta" }, 400);
    }

    // ── Guardar chunk em temp/ ────────────────────────────────────────────────
    const chunkData = await req.arrayBuffer();
    const chunkPath = `temp/${uploadId}/chunk_${String(chunkIndex).padStart(5, "0")}`;

    const { error: chunkErr } = await supabase.storage
      .from("videos-conteudos")
      .upload(chunkPath, chunkData, {
        contentType: "application/octet-stream",
        upsert: true,
      });

    if (chunkErr) {
      console.error(`[upload-video] erro chunk ${chunkIndex}:`, chunkErr.message);
      return json({ error: chunkErr.message }, 500);
    }

    console.log(`[upload-video] chunk ${chunkIndex + 1}/${totalChunks} ok`);

    // Não é o último chunk — confirmar recepção e aguardar
    if (chunkIndex < totalChunks - 1) {
      return json({ received: chunkIndex, done: false });
    }

    // ── Último chunk: streaming merge ─────────────────────────────────────────
    // Verifica que todos os chunks chegaram
    const { data: chunkList, error: listErr } = await supabase.storage
      .from("videos-conteudos")
      .list(`temp/${uploadId}`, { sortBy: { column: "name", order: "asc" } });

    if (listErr || !chunkList || chunkList.length < totalChunks) {
      const got = chunkList?.length ?? 0;
      console.error(`[upload-video] chunks incompletos: ${got}/${totalChunks}`);
      return json({ error: `Chunks incompletos: ${got}/${totalChunks}` }, 500);
    }

    console.log(`[upload-video] a fazer streaming merge de ${totalChunks} chunks → ${filePath}`);

    // ReadableStream que emite os chunks um a um — nunca carrega tudo em memória
    let cursor = 0;
    const readable = new ReadableStream({
      async pull(controller) {
        if (cursor >= totalChunks) {
          controller.close();
          return;
        }
        const cp = `temp/${uploadId}/chunk_${String(cursor).padStart(5, "0")}`;
        const { data: blob, error: dlErr } = await supabase.storage
          .from("videos-conteudos")
          .download(cp);

        if (dlErr || !blob) {
          controller.error(new Error(`Chunk ${cursor} não encontrado: ${dlErr?.message}`));
          return;
        }

        // Enfileirar bytes e avançar cursor — chunk anterior pode ser recolhido pelo GC
        const bytes = new Uint8Array(await blob.arrayBuffer());
        controller.enqueue(bytes);
        cursor++;
      },
    });

    // Fazer upload via fetch directo à Storage REST API com body em streaming.
    // Este request é interno (edge → Storage), não passa pelo Cloudflare — sem limite de 100 MB.
    const storageUrl =
      `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/videos-conteudos/${filePath}`;

    const uploadResp = await fetch(storageUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": fileType,
        "x-upsert": "true",
        "cache-control": "3600",
      },
      body: readable,
      // @ts-ignore — duplex necessário para streaming request body em Deno
      duplex: "half",
    });

    // Limpar temp/ (best-effort)
    const tempPaths = (chunkList ?? []).map((f) => `temp/${uploadId}/${f.name}`);
    supabase.storage.from("videos-conteudos").remove(tempPaths).catch(console.warn);

    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => "");
      console.error(`[upload-video] upload final falhou ${uploadResp.status}:`, errText);
      return json({ error: `Upload final falhou (${uploadResp.status}): ${errText}` }, 500);
    }

    const { data: pub } = supabase.storage
      .from("videos-conteudos")
      .getPublicUrl(filePath);

    console.log("[upload-video] concluído:", pub.publicUrl);
    return json({ done: true, url: pub.publicUrl });

  } catch (err) {
    console.error("[upload-video] excepção:", err);
    return json({ error: err instanceof Error ? err.message : "Erro interno" }, 500);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
