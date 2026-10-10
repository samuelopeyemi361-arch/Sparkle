
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
    .select("request_id, provider_request_id, service_name, status, phone_number, sms_code")
    .eq("user_id", user.id)
    .eq("request_id", requestId)
    .maybeSingle();

  if (orderError)
    return reply({ success: false, message: "Could not read the order." }, 500);

  if (!order)
    return reply({ success: false, message: "Order not found." }, 404);

  if (!order.provider_request_id)
    return reply({
      success: false,
      status: order.status,
      message: "The provider order ID is not available yet. Do not buy again.",
    }, 409);

  try {
    const response = await fetch(
      `${BASE}/sms4/check/${encodeURIComponent(order.provider_request_id)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${fleexaKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(20000),
      }
    );

    const result = await response.json().catch(() => null);

    if (!response.ok || !result || result.success === false)
      return reply({
        success: false,
        status: order.status,
        message: "Fleexa could not confirm the order status. Try checking again later.",
      }, 502);

    const data = result.data ?? result;
    const providerStatus = String(
      data.status ?? data.code ?? "pending"
    ).toUpperCase();

    const smsCode =
      data.sms_code ?? data.smsCode ?? data.code_value ?? null;

    const phone =
      data.phone ?? data.number ?? data.phoneNumber ?? order.phone_number;

    const received =
      providerStatus === "RECEIVED" ||
      providerStatus === "COMPLETED" ||
      providerStatus === "SUCCESS";

    if (received && smsCode != null) {
      const { error: updateError } = await admin
        .from("sparkle_fleexa_smsotp_orders")
        .update({
          sms_code: String(smsCode),
          phone_number: phone == null ? null : String(phone),
          provider_response: result,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("request_id", requestId);

      if (updateError)
        return reply({
          success: false,
          status: "unknown",
          message: "Code received, but Sparkle could not save it. Please check again.",
        }, 500);
    } else {
      // Do not refund automatically from an unverified status response.
      const { error: updateError } = await admin
        .from("sparkle_fleexa_smsotp_orders")
        .update({
          provider_response: result,
          phone_number: phone == null ? null : String(phone),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("request_id", requestId);

      if (updateError)
        return reply({ success: false, message: "Could not save provider status." }, 500);
    }

    return reply({
      success: true,
      request_id: requestId,
      status: providerStatus,
      phoneNumber: phone == null ? null : String(phone),
      smsCode: received && smsCode != null ? String(smsCode) : null,
      message: received && smsCode != null
        ? "SMS code received."
        : "No SMS code confirmed yet. Check again later.",
    });
  } catch {
    return reply({
      success: false,
      message: "Could not contact Fleexa. Try checking again later.",
    }, 503);
  }
});
