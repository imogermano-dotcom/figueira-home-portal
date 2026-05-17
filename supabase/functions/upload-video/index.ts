// upload-video/index.ts
// Proxy de upload em chunks para contornar o limite de 100 MB do Cloudflare.
// O browser envia o ficheiro em pedaços de 5 MB; esta função guarda cada chunk
// em storage temporário e, no último chunk, junta tudo e faz o upload final.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-chunk-index, x-total-chunks, x-file-path, x-file-type, x-upload-id",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    // Verificar autenticação
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      return new Response(JSON.stringify({ error: "Sem autorização" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Cliente com service role para operações de storage
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verificar que o token pertence a um utilizador válido
    const { data: { user }, error: authErr } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();

    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Ler headers do chunk
    const chunkIndex  = parseInt(req.headers.get("x-chunk-index")  || "0");
    const totalChunks = parseInt(req.headers.get("x-total-chunks") || "1");
    const filePath    = req.headers.get("x-file-path")  || "";
    const fileType    = req.headers.get("x-file-type")  || "video/mp4";
    const uploadId    = req.headers.get("x-upload-id")  || filePath;

    if (!filePath) {
      return new Response(JSON.stringify({ error: "x-file-path em falta" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Guardar chunk temporariamente
    const chunkData = await req.arrayBuffer();
    const chunkPath = `temp/${uploadId}_chunk_${String(chunkIndex).padStart(5, "0")}`;

    const { error: chunkErr } = await supabase.storage
      .from("videos-conteudos")
      .upload(chunkPath, chunkData, {
        contentType: "application/octet-stream",
        upsert: true,
      });

    if (chunkErr) {
      console.error(`[upload-video] erro ao guardar chunk ${chunkIndex}:`, chunkErr);
      return new Response(JSON.stringify({ error: chunkErr.message }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    console.log(`[upload-video] chunk ${chunkIndex + 1}/${totalChunks} guardado: ${chunkPath}`);

    // Não é o último chunk — confirmar recepção
    if (chunkIndex < totalChunks - 1) {
      return new Response(JSON.stringify({ received: chunkIndex, done: false }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Último chunk: juntar tudo ────────────────────────────────────────────
    console.log(`[upload-video] todos os chunks recebidos — a juntar ${totalChunks} chunks`);

    const chunks: Uint8Array[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const cp = `temp/${uploadId}_chunk_${String(i).padStart(5, "0")}`;
      const { data: blob, error: dlErr } = await supabase.storage
        .from("videos-conteudos")
        .download(cp);

      if (dlErr || !blob) {
        console.error(`[upload-video] erro ao ler chunk ${i}:`, dlErr);
        return new Response(JSON.stringify({ error: `Chunk ${i} em falta` }), {
          status: 500,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      chunks.push(new Uint8Array(await blob.arrayBuffer()));
    }

    // Concatenar todos os chunks num único Uint8Array
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    console.log(`[upload-video] ficheiro montado: ${totalLength} bytes → ${filePath}`);

    // Upload do ficheiro completo para o destino final
    const { error: uploadErr } = await supabase.storage
      .from("videos-conteudos")
      .upload(filePath, merged, {
        contentType: fileType,
        upsert: true,
      });

    // Limpar chunks temporários (best-effort — não falhar se apagar falhar)
    const chunkPaths = Array.from({ length: totalChunks }, (_, i) =>
      `temp/${uploadId}_chunk_${String(i).padStart(5, "0")}`
    );
    await supabase.storage.from("videos-conteudos").remove(chunkPaths);
    console.log(`[upload-video] ${totalChunks} chunks temporários apagados`);

    if (uploadErr) {
      console.error("[upload-video] erro no upload final:", uploadErr);
      return new Response(JSON.stringify({ error: uploadErr.message }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { data: pub } = supabase.storage
      .from("videos-conteudos")
      .getPublicUrl(filePath);

    console.log("[upload-video] concluído:", pub.publicUrl);

    return new Response(
      JSON.stringify({ done: true, url: pub.publicUrl }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[upload-video] excepção:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Erro interno" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
