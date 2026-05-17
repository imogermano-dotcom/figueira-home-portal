// complete-s3-upload/index.ts
// Finaliza um S3 Multipart Upload enviando CompleteMultipartUpload com os ETags.
// Devolve: { done: true, url: publicUrl }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

const BUCKET = "videos-conteudos";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) return err("Sem autorização", 401);

  let uploadId: string, filePath: string, etags: Array<{ partNumber: number; etag: string }>;
  try {
    const body = await req.json();
    uploadId = body.uploadId;
    filePath = body.filePath;
    etags    = body.etags;  // [{ partNumber: 1, etag: '"abc123"' }, ...]
  } catch {
    return err("Body JSON inválido", 400);
  }

  if (!uploadId || !filePath || !etags?.length) {
    return err("uploadId, filePath e etags são obrigatórios", 400);
  }

  const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
  const SVC_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!.trim();
  const S3_BASE  = `${SUPA_URL}/storage/v1/s3`;

  // Montar XML de CompleteMultipartUpload
  const partsXml = etags
    .sort((a, b) => a.partNumber - b.partNumber)
    .map(({ partNumber, etag }) =>
      `<Part><PartNumber>${partNumber}</PartNumber><ETag>${etag}</ETag></Part>`
    )
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

  const completeResp = await fetch(
    `${S3_BASE}/${BUCKET}/${filePath}?uploadId=${encodeURIComponent(uploadId)}`,
    {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${SVC_KEY}`,
        "Content-Type":  "application/xml",
      },
      body: xml,
    }
  );

  const respText = await completeResp.text();
  console.log("[complete-s3-upload] status:", completeResp.status, respText.slice(0, 300));

  if (!completeResp.ok) {
    return err(`S3 complete falhou ${completeResp.status}: ${respText.slice(0, 200)}`, 500);
  }

  // Verificar erro no XML de resposta (S3 pode devolver 200 com erro no body)
  if (respText.includes("<Error>") || respText.includes("<error>")) {
    return err("S3 complete erro no body: " + respText.slice(0, 200), 500);
  }

  const publicUrl = `${SUPA_URL}/storage/v1/object/public/${BUCKET}/${filePath}`;
  return new Response(JSON.stringify({ done: true, url: publicUrl }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});

function err(msg: string, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
