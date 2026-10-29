const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  return new Response(JSON.stringify({
    success: false,
    status: "disabled",
    message: "This service endpoint has been retired. Please refresh Sparkle and use the current number service.",
  }), { status: 410, headers });
});
