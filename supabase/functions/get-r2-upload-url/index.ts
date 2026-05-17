// get-r2-upload-url/index.ts
// Gera um URL de upload pre-assinado (AWS SigV4) para o Cloudflare R2.
// O browser faz PUT directo para o R2 — sem proxy Cloudflare, sem limite de tamanho.
//
// Secrets necessários na edge function:
//   R2_ACCOUNT_ID         — Cloudflare Account ID
//   R2_ACCESS_KEY_ID      — R2 API token Access Key ID
//   R2_SECRET_ACCESS_KEY  — R2 API token Secret Access Key
//   R2_BUCKET_NAME        — nome do bucket (ex: videos-figueirahome)
//   R2_PUBLIC_BASE_URL    — base do URL público (ex: https://pub-ACCOUNT.r2.dev/BUCKET)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) return errResp("Sem autorização", 401);

  let filePath: string, fileType: string, fileSize: number;
  try {
    const body = await req.json();
    filePath = body.filePath;
    fileType = body.fileType || "video/mp4";
    fileSize = parseInt(body.fileSize) || 0;
  } catch {
    return errResp("Body JSON inválido", 400);
  }

  if (!filePath || !fileSize) return errResp("filePath e fileSize são obrigatórios", 400);

  const accountId   = Deno.env.get("R2_ACCOUNT_ID")?.trim()          ?? "";
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID")?.trim()        ?? "";
  const secretKey   = Deno.env.get("R2_SECRET_ACCESS_KEY")?.trim()    ?? "";
  const bucket      = Deno.env.get("R2_BUCKET_NAME")?.trim()          ?? "videos-figueirahome";
  // R2_PUBLIC_BASE_URL: ex. https://pub-abc123.r2.dev/videos-figueirahome
  // ou URL de domínio personalizado ex. https://videos.miguelgermano.com
  const publicBase  = Deno.env.get("R2_PUBLIC_BASE_URL")?.trim()      ?? `https://pub-${accountId}.r2.dev/${bucket}`;

  if (!accountId || !accessKeyId || !secretKey) {
    return errResp("Credenciais R2 não configuradas. Definir: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY", 500);
  }

  console.log("[get-r2-upload-url] a assinar PUT para:", `${bucket}/${filePath}`);

  const signedUrl = await presignedPut(accountId, accessKeyId, secretKey, bucket, filePath, 3600);
  const publicUrl = `${publicBase}/${filePath}`;

  return new Response(JSON.stringify({ signedUrl, publicUrl }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});

// ── AWS Signature V4 — pre-signed PUT URL ──────────────────────────────────────
async function presignedPut(
  accountId: string,
  accessKeyId: string,
  secretKey: string,
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<string> {
  const enc = new TextEncoder();

  const now      = new Date();
  const dateStr  = now.toISOString().slice(0, 10).replace(/-/g, "");          // YYYYMMDD
  const amzDate  = dateStr + "T" + now.toISOString().slice(11, 19).replace(/:/g, "") + "Z"; // YYYYMMDDTHHMMSSZ
  const host     = `${accountId}.r2.cloudflarestorage.com`;
  const region   = "auto";
  const service  = "s3";
  const credScope = `${dateStr}/${region}/${service}/aws4_request`;

  // Strict URI encoding (AWS spec: encode all except unreserved chars)
  const uriEnc = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  // Query parameters for pre-signed URL (sorted alphabetically by key)
  const params: Record<string, string> = {
    "X-Amz-Algorithm":     "AWS4-HMAC-SHA256",
    "X-Amz-Credential":    `${accessKeyId}/${credScope}`,
    "X-Amz-Date":          amzDate,
    "X-Amz-Expires":       String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  };

  const canonicalQS = Object.keys(params)
    .sort()
    .map(k => `${uriEnc(k)}=${uriEnc(params[k])}`)
    .join("&");

  // Canonical URI: bucket + key, each segment encoded
  const canonicalUri = "/" + [bucket, ...key.split("/")].map(uriEnc).join("/");

  // Canonical request (format per AWS spec)
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQS,
    `host:${host}`,  // canonical headers
    "",              // blank line after headers
    "host",          // signed headers
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  // Hash canonical request (SHA-256 → hex)
  const crHash = await crypto.subtle.digest("SHA-256", enc.encode(canonicalRequest));
  const crHex  = toHex(crHash);

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, crHex].join("\n");

  // Derive signing key: HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")
  const hmac = async (k: ArrayBuffer, msg: string) => {
    const ck = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return crypto.subtle.sign("HMAC", ck, enc.encode(msg));
  };
  let sk = await hmac(enc.encode(`AWS4${secretKey}`).buffer, dateStr);
  sk = await hmac(sk, region);
  sk = await hmac(sk, service);
  sk = await hmac(sk, "aws4_request");

  const signature = toHex(await hmac(sk, stringToSign));

  // Build final pre-signed URL (same encoding as canonical QS, + signature)
  const finalQS = canonicalQS + `&X-Amz-Signature=${signature}`;
  return `https://${host}${canonicalUri}?${finalQS}`;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function errResp(msg: string, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
