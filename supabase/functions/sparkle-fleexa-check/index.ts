
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BASE = "https://fleexa.com.ng/developer";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reply({ success: false, message: "POST required" }, 405);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const fleexaKey = Deno.env.get("FLEEXA_API_KEY");

  if (!url || !anonKey || !serviceKey || !fleexaKey) {
    return reply({ success: false, message: "Server configuration incomplete" }, 500);
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return reply({ success: false, message: "Please sign in" }, 401);
  }

  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false },
  });

  const { data: authData, error: authError } =
    await authClient.auth.getUser(authorization.slice(7));

  if (authError || !authData.user) {
    return reply({ success: false, message: "Invalid session" }, 401);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  let requestId: string;

  try {
    const body = await req.json();
    requestId = String(body.requestId ?? "").trim();

    if (!requestId || requestId.length > 120) {
      return reply({ success: false, message: "Invalid order reference" }, 400);
    }
  } catch {
    return reply({ success: false, message: "Invalid request body" }, 400);
  }

  const { data: order, error: orderError } = await admin
    .from("sparkle_sms_otp_orders")
    .select("request_id, provider_request_id, phone_number, service_name, status")
    .eq("request_id", requestId)
    .eq("user_id", authData.user.id)
    .maybeSingle();

  if (orderError || !order) {
    return reply({ success: false, message: "Order not found" }, 404);
  }

  if (!order.provider_request_id) {
    return reply({
      success: false,
      status: order.status,
      message: "Provider order reference is not available yet. Please contact support.",
    }, 409);
  }

  if (["success", "failed", "cancelled"].includes(order.status)) {
    return reply({
      success: true,
      status: order.status,
      phoneNumber: order.phone_number,
      message: "Order is already finalized.",
    });
  }

  let providerData: any;

  try {
    const response = await fetch(
      `${BASE}/sms4/check/${encodeURIComponent(order.provider_request_id)}`,
      { headers: { Authorization: `Bearer ${fleexaKey}` } },
    );

    providerData = await response.json();

    if (!response.ok) {
      return reply({
        success: false,
        status: order.status,
        message: "Fleexa status check failed. Please try again later.",
      }, 502);
    }
  } catch {
    return reply({
      success: false,
      status: order.status,
      message: "Could not contact Fleexa. Please try again later.",
    }, 502);
  }

  // Return provider data for now; do not finalize or refund until
  // the exact status and OTP fields are verified against Fleexa's response.
  return reply({
    success: true,
    status: order.status,
    phoneNumber: order.phone_number,
    provider: providerData,
    message: "Provider status retrieved. Final status processing is not enabled yet.",
  });
});
