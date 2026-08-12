// upload-video/index.ts  (v5 — native fetch, warmup endpoint, sem SDK)
//
// Optimizações vs v4:
//   - Upload do chunk via fetch nativo (sem @supabase/supabase-js) → menos overhead
//   - GET /upload-video responde imediatamente → warmup do worker antes do upload
//   - Validações mínimas — ir directo ao essencial
//   - Auth via createClient mantida (necessária para validar JWT do utilizador)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, " +
    "x-chunk-index, x-total-chunks, x-file-path, x-file-type, x-upload-id, " +
    "x-user-id, x-categoria, x-descricao, x-file-name, x-file-size",
};

const N8N_MERGE_WEBHOOK = "https://imogermano.app.n8n.cloud/webhook/merge-video";

serve(async (req) => {
  // ── Preflight ──────────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS });
  }

  // ── Warmup — GET acorda o worker sem fazer nada ────────────────────────────
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── Env vars (lidos uma vez, sem trim desnecessário em hot path) ──────────
    const SUPA_URL = Deno.env.get("SUPABASE_URL")              ?? "";
    const SVC_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")         ?? "";

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader) return ok({ error: "Sem autorização" }, 401);

    const { data: { user }, error: authErr } = await createClient(
      SUPA_URL, ANON_KEY,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();

    if (authErr || !user) return ok({ error: "Token inválido" }, 401);

    // ── Headers do chunk ──────────────────────────────────────────────────────
    const H = (k: string, d = "") => req.headers.get(k) ?? d;
    const chunkIndex  = parseInt(H("x-chunk-index",  "0"));
    const totalChunks = parseInt(H("x-total-chunks", "1"));
    const filePath    = H("x-file-path");
    const fileType    = H("x-file-type",  "video/mp4");
    const uploadId    = H("x-upload-id");
    const userId      = H("x-user-id",   user.id);
    const categoria   = H("x-categoria", "");
    const descricao   = decodeURIComponent(H("x-descricao", ""));
    const fileName    = decodeURIComponent(H("x-file-name",  ""));
    const fileSize    = parseInt(H("x-file-size", "0"));

    if (!filePath || !uploadId) {
      return ok({ error: "x-file-path ou x-upload-id em falta" }, 400);
    }

    // ── Ler body do chunk ─────────────────────────────────────────────────────
    const chunkData = await req.arrayBuffer();
    const chunkPath = `temp/${uploadId}/chunk_${String(chunkIndex).padStart(5, "0")}`;

    // ── Upload do chunk via fetch nativo (sem SDK) ────────────────────────────
    const storageUrl = `${SUPA_URL}/storage/v1/object/videos-conteudos/${chunkPath}`;
    const storageResp = await fetch(storageUrl, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${SVC_KEY}`,
        "Content-Type":  "application/octet-stream",
        "x-upsert":      "true",
      },
      body: chunkData,
    });

    if (!storageResp.ok) {
      const errText = await storageResp.text();
      console.error(`[upload-video] storage erro chunk ${chunkIndex}:`, storageResp.status, errText.slice(0, 200));
      return ok({ error: `Storage ${storageResp.status}: ${errText.slice(0, 120)}` }, 500);
    }

    console.log(`[upload-video] chunk ${chunkIndex + 1}/${totalChunks} ok`);

    // ── Chunks intermédios — confirmar e sair ─────────────────────────────────
    if (chunkIndex < totalChunks - 1) {
      return ok({ received: chunkIndex, done: false });
    }

    // ── Último chunk — notificar n8n (fire-and-forget) ────────────────────────
    const webhookPayload = {
      uploadId, filePath, fileType, totalChunks,
      bucket:      "videos-conteudos",
      userId, categoria, descricao, fileName, fileSize,
      supabaseUrl: SUPA_URL,
    };

    console.log("[upload-video] a notificar n8n:", { uploadId, filePath, totalChunks });

    fetch(N8N_MERGE_WEBHOOK, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(webhookPayload),
    }).then((r) => console.log("[upload-video] n8n:", r.status))
      .catch((e) => console.warn("[upload-video] n8n erro:", e.message));

    return ok({
      done:    true,
      status:  "merging",
      message: "Todos os chunks recebidos. O vídeo está a ser processado e aparecerá na Biblioteca em breve.",
    });

  } catch (err) {
    console.error("[upload-video] excepção:", err);
    return ok({ error: err instanceof Error ? err.message : "Erro interno" }, 500);
  }
});

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
