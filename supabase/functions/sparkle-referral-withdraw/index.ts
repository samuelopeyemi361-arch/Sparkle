import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ success: false, message: "POST required." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) return reply({ success: false, message: "Withdrawal service is not configured." }, 503);

  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return reply({ success: false, message: "Please sign in again." }, 401);

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return reply({ success: false, message: "Your session is invalid. Sign in again." }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ success: false, message: "Invalid request." }, 400); }

  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  const amount = Number(body.amount);
  if (!/^\d{4,6}$/.test(pin)) return reply({ success: false, message: "Enter your transaction PIN." }, 400);
  if (!Number.isFinite(amount) || amount < 1000 || amount > 100000000 || Math.round(amount * 100) !== amount * 100) {
    return reply({ success: false, message: "Minimum withdrawal is ₦1,000. Enter a valid amount." }, 400);
  }

  let pinResponse: Response;
  try {
    pinResponse = await fetch(`${url}/functions/v1/sparkle-transaction-pin`, {
      method: "POST",
      headers: { Authorization: authorization, apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", pin }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return reply({ success: false, message: "PIN verification is temporarily unavailable. Try again." }, 503);
  }
  const pinResult = await pinResponse.json().catch(() => null);
  if (!pinResponse.ok || pinResult?.success !== true) {
    return reply({ success: false, message: pinResult?.error || pinResult?.message || "Could not verify your transaction PIN." }, pinResponse.status >= 400 && pinResponse.status < 500 ? pinResponse.status : 503);
  }

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const requestId = crypto.randomUUID();
  const { data, error } = await admin.rpc("sparkle_withdraw_referral_earnings", {
    p_user_id: user.id,
    p_amount: amount,
    p_request_id: requestId,
  });
  if (error) {
    console.error("Referral withdrawal RPC failed:", error.message);
    return reply({ success: false, message: "We could not complete the withdrawal. Your wallet was not intentionally credited; refresh your earnings and try again." }, 500);
  }
  if (!data?.success) return reply({ success: false, message: data?.message || "Withdrawal could not be completed.", available: data?.available }, 400);
  return reply({ success: true, message: "Referral earnings added to your Sparkle wallet.", amount: data.amount, withdrawal_id: data.withdrawal_id });
});