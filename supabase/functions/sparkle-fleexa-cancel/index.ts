
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE = "https://fleexa.com.ng/developer";

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: cors });

  if (req.method !== "POST")
    return reply({ success: false, message: "POST required." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const fleexaKey = Deno.env.get("FLEEXA_API_KEY");

  if (!url || !anon || !serviceKey || !fleexaKey)
    return reply({ success: false, message: "Server secrets are missing." }, 503);

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer "))
    return reply({ success: false, message: "Please sign in." }, 401);

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser();

  if (authError || !user)
    return reply({ success: false, message: "Session expired. Sign in again." }, 401);

  let body: Record<string, unknown>;

  try {
    body = await req.json();
  } catch {
    return reply({ success: false, message: "Invalid request." }, 400);
  }

  const requestId =
    typeof body.request_id === "string" ? body.request_id.trim() : "";

  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(requestId))
    return reply({ success: false, message: "Invalid order reference." }, 400);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  const { data: order, error: orderError } = await admin
    .from("sparkle_fleexa_smsotp_orders")
    .select("request_id, provider_request_id, service_name, status")
    .eq("user_id", user.id)
    .eq("request_id", requestId)
    .maybeSingle();

  if (orderError)
    return reply({ success: false, message: "Could not read the order." }, 500);

  if (!order)
    return reply({ success: false, message: "Order not found." }, 404);

  if (order.status === "success")
    return reply({
      success: false,
      status: "success",
      message: "This order is already marked successful and cannot be cancelled here.",
    }, 409);

  if (order.status === "failed" || order.status === "cancelled")
    return reply({
      success: true,
      status: order.status,
      message: "This order is already closed.",
    });

  if (!order.provider_request_id)
    return reply({
      success: false,
      status: order.status,
      message: "The provider order ID is missing. No cancellation or refund was attempted.",
    }, 409);

  try {
    const response = await fetch(`${BASE}/sms4/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fleexaKey}`,
        "X-API-Key": fleexaKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: order.provider_request_id,
      }),
      signal: AbortSignal.timeout(20000),
    });

    const result = await response.json().catch(() => null);
    const data = result?.data ?? result ?? {};

    const providerStatus = String(
      data.status ?? result?.status ?? ""
    ).toLowerCase();

    const confirmedCancelled =
      response.ok &&
      result != null &&
      result.success !== false &&
      ["cancelled", "canceled"].includes(providerStatus);

    if (!confirmedCancelled) {
      return reply({
        success: false,
        status: "unknown",
        message: "Fleexa has not clearly confirmed cancellation. No refund was issued. Check the order status before trying again.",
      }, 202);
    }

    const { data: finished, error: finishError } = await admin.rpc(
      "sparkle_finish_fleexa_smsotp",
      {
        p_user_id: user.id,
        p_request_id: requestId,
        p_status: "cancelled",
        p_provider_response: result,
        p_error: "Cancellation confirmed by Fleexa.",
        p_provider_request_id: order.provider_request_id,
        p_phone_number: null,
        p_sms_code: null,
      }
    );

    if (finishError || !finished?.success) {
      return reply({
        success: false,
        status: "unknown",
        message: "Fleexa confirmed cancellation, but Sparkle could not confirm the refund. Do not retry; the order needs review.",
      }, 202);
    }

    return reply({
      success: true,
      status: "cancelled",
      refunded: finished.refunded === true,
      message: finished.refunded === true
        ? "Cancellation confirmed and refund processed."
        : "Cancellation confirmed. Check the order and wallet records.",
    });
  } catch {
    return reply({
      success: false,
      status: "unknown",
      message: "The cancellation result could not be confirmed. No refund was issued. Check the order before retrying.",
    }, 202);
  }
});
