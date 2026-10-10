
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
    .select("request_id, provider_request_id, status")
    .eq("request_id", requestId)
    .eq("user_id", authData.user.id)
    .maybeSingle();

  if (orderError || !order) {
    return reply({ success: false, message: "Order not found" }, 404);
  }

  if (!order.provider_request_id) {
    return reply({
      success: false,
      message: "Provider reference is missing. Contact support.",
    }, 409);
  }

  if (order.status !== "pending") {
    return reply({
      success: false,
      status: order.status,
      message: "Only pending orders can request cancellation.",
    }, 409);
  }

  let providerResponse: any;

  try {
    const response = await fetch(`${BASE}/sms4/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fleexaKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: order.provider_request_id,
      }),
    });

    providerResponse = await response.json();

    if (!response.ok || providerResponse?.success !== true) {
      return reply({
        success: false,
        status: "pending",
        message:
          "Fleexa has not confirmed cancellation. Your order remains under review.",
      }, 502);
    }
  } catch {
    return reply({
      success: false,
      status: "unknown",
      message:
        "Cancellation response is uncertain. Check the order status before retrying.",
    }, 202);
  }

  // Save the response for reconciliation. Do not refund based only on
  // a successful HTTP response; confirm Fleexa's terminal status first.
  const { error: saveError } = await admin
    .from("sparkle_sms_otp_orders")
    .update({
      provider_response: providerResponse,
      error_message: "Cancellation requested; provider status must be verified",
      updated_at: new Date().toISOString(),
    })
    .eq("request_id", requestId)
    .eq("user_id", authData.user.id)
    .eq("status", "pending");

  if (saveError) {
    return reply({
      success: false,
      status: "unknown",
      message:
        "Fleexa responded, but Sparkle could not save the response. Contact support before retrying.",
    }, 202);
  }

  return reply({
    success: true,
    status: "cancellation_requested",
    message:
      "Cancellation request sent. The refund will be handled only after cancellation is confirmed.",
  });
});
