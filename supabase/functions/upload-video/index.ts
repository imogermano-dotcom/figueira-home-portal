// upload-video/index.ts  (v3)
//
// Proxy de upload em chunks — contorna o limite de 100 MB do Cloudflare.
//
// Fluxo:
//  1. Browser envia chunks de 5 MB → guardados em temp/{uploadId}/
//  2. No último chunk: streaming merge via ReadableStream → upload final ao Storage
//     (request interno edge→Storage, não passa pelo Cloudflare)
//
// Mem: apenas 1 chunk (~5 MB) em memória de cada vez — sem WORKER_RESOURCE_LIMIT.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-chunk-index, x-total-chunks, " +
    "x-file-path, x-file-type, x-upload-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    // ── Ler env vars com trim() defensivo ─────────────────────────────────────
    const SUPA_URL  = (Deno.env.get("SUPABASE_URL")              ?? "").trim();
    const SVC_KEY   = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
    const ANON_KEY  = (Deno.env.get("SUPABASE_ANON_KEY")         ?? "").trim();

    // Diagnóstico imediato — visível nos logs da Edge Function
    console.log("[upload-video] env check", {
      url:      SUPA_URL.slice(0, 30),
      svc_key:  SVC_KEY  ? SVC_KEY.slice(0, 20) + "…" : "AUSENTE",
      anon_key: ANON_KEY ? ANON_KEY.slice(0, 20) + "…" : "AUSENTE",
    });

    if (!SVC_KEY.startsWith("eyJ")) {
      return json({ error: "SUPABASE_SERVICE_ROLE_KEY inválida ou ausente" }, 500);
    }

    // ── Auth do utilizador ────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader) return json({ error: "Sem autorização" }, 401);

    // Validar JWT do utilizador com cliente anon
    const { data: { user }, error: authErr } = await createClient(
      SUPA_URL, ANON_KEY,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();

    if (authErr || !user) {
      return json({ error: "Token inválido: " + (authErr?.message ?? "") }, 401);
    }

    // ── Cliente service-role (sem RLS, sem refresh de sessão) ─────────────────
    const supabase = createClient(SUPA_URL, SVC_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

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

    if (chunkIndex < totalChunks - 1) {
      return json({ received: chunkIndex, done: false });
    }

    // ── Último chunk: verificar integridade ───────────────────────────────────
    const { data: chunkList, error: listErr } = await supabase.storage
      .from("videos-conteudos")
      .list(`temp/${uploadId}`, { sortBy: { column: "name", order: "asc" } });

    if (listErr || !chunkList || chunkList.length < totalChunks) {
      const got = chunkList?.length ?? 0;
      return json({ error: `Chunks incompletos: ${got}/${totalChunks}` }, 500);
    }

    console.log(`[upload-video] streaming merge ${totalChunks} chunks → ${filePath}`);

    // ── Streaming merge ───────────────────────────────────────────────────────
    // ReadableStream lê um chunk de cada vez — pico de memória: ~5 MB.
    let cursor = 0;
    const readable = new ReadableStream({
      async pull(controller) {
        if (cursor >= totalChunks) { controller.close(); return; }

        const cp = `temp/${uploadId}/chunk_${String(cursor).padStart(5, "0")}`;
        const { data: blob, error: dlErr } = await supabase.storage
          .from("videos-conteudos").download(cp);

        if (dlErr || !blob) {
          controller.error(new Error(`Chunk ${cursor} falhou: ${dlErr?.message}`));
          return;
        }

        controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
        cursor++;
      },
    });

    // Upload interno edge→Storage via fetch directo com service role key.
    // Não passa pelo proxy Cloudflare → sem limite de 100 MB.
    const storageUrl = `${SUPA_URL}/storage/v1/object/videos-conteudos/${filePath}`;
    console.log("[upload-video] fetch final →", storageUrl);
    console.log("[upload-video] auth header:", "Bearer " + SVC_KEY.slice(0, 20) + "…");

    const uploadResp = await fetch(storageUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SVC_KEY}`,
        "Content-Type":  fileType,
        "x-upsert":      "true",
        "cache-control": "3600",
      },
      body: readable,
      // @ts-ignore — duplex necessário para streaming body no Deno edge runtime
      duplex: "half",
    });

    // Limpar temp/ (best-effort)
    const tempPaths = chunkList.map((f) => `temp/${uploadId}/${f.name}`);
    supabase.storage.from("videos-conteudos").remove(tempPaths).catch(console.warn);

    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => "");
      console.error(`[upload-video] fetch final ${uploadResp.status}:`, errText);
      return json({ error: `Upload final falhou (${uploadResp.status}): ${errText}` }, 500);
    }

    const { data: pub } = supabase.storage
      .from("videos-conteudos").getPublicUrl(filePath);

    console.log("[upload-video] concluído:", pub.publicUrl);
    return json({ done: true, url: pub.publicUrl });

  } catch (err) {
    console.error("[upload-video] excepção:", err);
    return json({ error: err instanceof Error ? err.message : "Erro interno" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
