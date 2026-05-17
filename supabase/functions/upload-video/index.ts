// upload-video/index.ts  (v4 — sem merge, sem timeout)
//
// Responsabilidade única: guardar cada chunk no Storage.
// Quando todos os chunks chegam, dispara um webhook n8n para fazer o merge
// em background (sem limite de tempo) e devolve imediatamente ao browser.
//
// Fluxo completo:
//   Browser  → chunks (5 MB cada) → edge fn → temp/{uploadId}/chunk_NNNNN
//   Browser  → último chunk       → edge fn → POST n8n/webhook/merge-video
//   n8n      → descarrega chunks, concatena, faz upload final, insere BD

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS em TODOS os responses — incluindo erros e preflight
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, " +
    "x-chunk-index, x-total-chunks, x-file-path, x-file-type, x-upload-id, " +
    "x-user-id, x-categoria, x-descricao, x-file-name, x-file-size",
};

// Endpoint n8n para fazer o merge em background
const N8N_MERGE_WEBHOOK = "https://imogermano.app.n8n.cloud/webhook/merge-video";

serve(async (req) => {
  // OPTIONS preflight — responder SEMPRE antes de qualquer outra lógica
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS });
  }

  try {
    // ── Env vars ──────────────────────────────────────────────────────────────
    const SUPA_URL = (Deno.env.get("SUPABASE_URL")              ?? "").trim();
    const SVC_KEY  = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
    const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY")         ?? "").trim();

    if (!SVC_KEY.startsWith("eyJ")) {
      return ok({ error: "SUPABASE_SERVICE_ROLE_KEY ausente" }, 500);
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader) return ok({ error: "Sem autorização" }, 401);

    const { data: { user }, error: authErr } = await createClient(
      SUPA_URL, ANON_KEY,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();

    if (authErr || !user) {
      return ok({ error: "Token inválido" }, 401);
    }

    // ── Headers do chunk ──────────────────────────────────────────────────────
    const H = (k: string, d = "") => req.headers.get(k) ?? d;
    const chunkIndex  = parseInt(H("x-chunk-index",  "0"));
    const totalChunks = parseInt(H("x-total-chunks", "1"));
    const filePath    = H("x-file-path");
    const fileType    = H("x-file-type",  "video/mp4");
    const uploadId    = H("x-upload-id");

    // Metadata para o n8n (enviada em todos os chunks, usada no último)
    const userId    = H("x-user-id",   user.id);
    const categoria = H("x-categoria", "");
    const descricao = decodeURIComponent(H("x-descricao", ""));
    const fileName  = decodeURIComponent(H("x-file-name",  ""));
    const fileSize  = parseInt(H("x-file-size", "0"));

    if (!filePath || !uploadId) {
      return ok({ error: "x-file-path ou x-upload-id em falta" }, 400);
    }

    // ── Guardar chunk ─────────────────────────────────────────────────────────
    const supabase  = createClient(SUPA_URL, SVC_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const chunkData = await req.arrayBuffer();
    const chunkPath = `temp/${uploadId}/chunk_${String(chunkIndex).padStart(5, "0")}`;

    const { error: chunkErr } = await supabase.storage
      .from("videos-conteudos")
      .upload(chunkPath, chunkData, {
        contentType: "application/octet-stream",
        upsert: true,
      });

    if (chunkErr) {
      console.error(`[upload-video] chunk ${chunkIndex} erro:`, chunkErr.message);
      return ok({ error: chunkErr.message }, 500);
    }

    console.log(`[upload-video] chunk ${chunkIndex + 1}/${totalChunks} ok`);

    // Ainda há chunks por vir — confirmar recepção
    if (chunkIndex < totalChunks - 1) {
      return ok({ received: chunkIndex, done: false });
    }

    // ── Último chunk — delegar merge ao n8n ───────────────────────────────────
    // Fire-and-forget: não aguardamos a resposta do n8n.
    // A edge function responde imediatamente ao browser sem bloquear.
    const webhookPayload = {
      uploadId,
      filePath,
      fileType,
      totalChunks,
      bucket:     "videos-conteudos",
      userId,
      categoria,
      descricao,
      fileName,
      fileSize,
      supabaseUrl: SUPA_URL,
    };

    console.log("[upload-video] a notificar n8n:", N8N_MERGE_WEBHOOK, {
      uploadId, filePath, totalChunks,
    });

    // Não await — devolve ao browser imediatamente
    fetch(N8N_MERGE_WEBHOOK, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(webhookPayload),
    }).then((r) => {
      console.log("[upload-video] n8n respondeu:", r.status);
    }).catch((e) => {
      console.warn("[upload-video] n8n erro:", e.message);
    });

    return ok({
      done:    true,
      status:  "merging",
      message: "Todos os chunks recebidos. O vídeo está a ser processado e aparecerá na Biblioteca em breve.",
    });

  } catch (err) {
    console.error("[upload-video] excepção:", err);
    // CRÍTICO: erros também precisam de CORS headers
    return ok({ error: err instanceof Error ? err.message : "Erro interno" }, 500);
  }
});

// Todas as respostas passam por aqui — CORS garantido sem excepção
function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
