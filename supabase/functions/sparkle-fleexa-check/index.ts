
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
      message: "Provider reference is missing. Please contact support.",
    }, 409);
  }

  if (["failed", "cancelled"].includes(order.status)) {
    return reply({
      success: true,
      status: order.status,
      message: "This order is no longer active.",
    });
  }

  let providerData: any;

  try {
    const response = await fetch(
      `${BASE}/sms4/check/${encodeURIComponent(order.provider_request_id)}`,
      { headers: { Authorization: `Bearer ${fleexaKey}` } },
    );

    providerData = await response.json();

    if (!response.ok || providerData?.success !== true) {
      return reply({
        success: false,
        status: order.status,
        message: "Fleexa could not confirm the order status. Try again later.",
      }, 502);
    }
  } catch {
    return reply({
      success: false,
      status: order.status,
      message: "Could not contact Fleexa. Try again later.",
    }, 502);
  }

  const data = providerData.data ?? {};
  const providerStatus = String(data.status ?? data.code ?? "").toUpperCase();
  const received = providerStatus === "RECEIVED" ||
    (providerStatus === "COMPLETED" && Boolean(data.sms_code));

  if (received && data.sms_code) {
    const { error: saveError } = await admin
      .from("sparkle_sms_otp_orders")
      .update({
        status: "success",
        provider_response: providerData,
        phone_number: data.phone ?? order.phone_number,
        updated_at: new Date().toISOString(),
      })
      .eq("request_id", requestId)
      .eq("user_id", authData.user.id);

    if (saveError) {
      return reply({
        success: false,
        status: "unknown",
        message: "OTP arrived but could not be saved. Please contact support.",
      }, 500);
    }

    await admin
      .from("wallet_transactions")
      .update({ status: "success" })
      .eq("reference", requestId)
      .eq("user_id", authData.user.id);

    return reply({
      success: true,
      status: "received",
      phoneNumber: data.phone ?? order.phone_number,
      serviceName: order.service_name,
      otp: String(data.sms_code),
      message: "OTP received.",
    });
  }

  // Do not automatically refund based only on an unverified terminal status.
  // Keep the order traceable until cancellation/refund handling is implemented.
  if (["CANCELED", "CANCELLED", "EXPIRED", "FINISHED"].includes(providerStatus)) {
    await admin
      .from("sparkle_sms_otp_orders")
      .update({
        status: "unknown",
        provider_response: providerData,
        error_message: `Provider terminal status: ${providerStatus}; refund review required`,
        updated_at: new Date().toISOString(),
      })
      .eq("request_id", requestId)
      .eq("user_id", authData.user.id);

    return reply({
      success: true,
      status: providerStatus.toLowerCase(),
      phoneNumber: order.phone_number,
      message: "The provider order has ended. Any refund requires reconciliation.",
    });
  }

  await admin
    .from("sparkle_sms_otp_orders")
    .update({
      provider_response: providerData,
      updated_at: new Date().toISOString(),
    })
    .eq("request_id", requestId)
    .eq("user_id", authData.user.id);

  return reply({
    success: true,
    status: "pending",
    phoneNumber: order.phone_number,
    message: "OTP not received yet. Check again in 20–30 seconds.",
  });
});
