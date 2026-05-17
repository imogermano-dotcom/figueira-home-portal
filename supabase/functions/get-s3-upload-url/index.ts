// get-s3-upload-url/index.ts
// Inicia um S3 Multipart Upload no Supabase Storage S3 API.
// O endpoint S3 não passa pelo proxy Cloudflare — sem limite de 50 MB.
// Devolve: { uploadId, s3Endpoint, bucket, filePath, partSize, totalParts }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

const BUCKET    = "videos-conteudos";
const PART_SIZE = 10 * 1024 * 1024; // 10 MB por parte (mínimo S3 = 5 MB)

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) {
    return err("Sem autorização", 401);
  }

  let filePath: string, fileType: string, fileSize: number;
  try {
    const body = await req.json();
    filePath = body.filePath;
    fileType = body.fileType || "video/mp4";
    fileSize = parseInt(body.fileSize) || 0;
  } catch {
    return err("Body JSON inválido", 400);
  }

  if (!filePath || !fileSize) return err("filePath e fileSize são obrigatórios", 400);

  const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
  const SVC_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!.trim();
  const S3_BASE  = `${SUPA_URL}/storage/v1/s3`;

  // Iniciar S3 Multipart Upload
  const initResp = await fetch(`${S3_BASE}/${BUCKET}/${filePath}?uploads`, {
    method:  "POST",
    headers: {
      "Authorization":        `Bearer ${SVC_KEY}`,
      "Content-Type":         fileType,
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    },
  });

  const initText = await initResp.text();
  console.log("[get-s3-upload-url] init:", initResp.status, initText.slice(0, 300));

  if (!initResp.ok) {
    return err(`S3 init falhou ${initResp.status}: ${initText.slice(0, 200)}`, 500);
  }

  // Extrair UploadId do XML de resposta
  const match = initText.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!match) {
    return err("UploadId não encontrado na resposta S3: " + initText.slice(0, 200), 500);
  }

  const uploadId   = match[1];
  const totalParts = Math.ceil(fileSize / PART_SIZE);

  return new Response(JSON.stringify({
    uploadId,
    s3Endpoint: S3_BASE,
    bucket:     BUCKET,
    filePath,
    partSize:   PART_SIZE,
    totalParts,
  }), { headers: { ...CORS, "Content-Type": "application/json" } });
});

function err(msg: string, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
