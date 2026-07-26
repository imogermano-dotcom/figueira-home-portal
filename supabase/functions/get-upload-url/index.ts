// get-upload-url/index.ts
// Devolve um URL de upload assinado para o Supabase Storage.
// Executa em < 1 segundo — sem proxy de dados, sem timeout issues.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Sem autorização" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let filePath: string, bucket: string;
  try {
    const body = await req.json();
    filePath = body.filePath;
    bucket   = body.bucket;
  } catch {
    return new Response(JSON.stringify({ error: "Body JSON inválido" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (!filePath || !bucket) {
    return new Response(JSON.stringify({ error: "filePath e bucket são obrigatórios" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUploadUrl(filePath);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ signedUrl: data.signedUrl, token: data.token }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
