
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE = "https://fleexa.com.ng/developer";

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
    return reply({
      success: false,
      message: "Server configuration is incomplete",
    }, 500);
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return reply({ success: false, message: "Please sign in" }, 401);
  }

  const token = authorization.slice(7);

  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false },
  });

  const { data: authData, error: authError } =
    await authClient.auth.getUser(token);

  if (authError || !authData.user) {
    return reply({ success: false, message: "Invalid session" }, 401);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  let serviceName: string;

  try {
    const body = await req.json();
    serviceName = String(body.serviceName ?? "").trim();

    if (
      !serviceName ||
      serviceName.length > 100 ||
      !/^[a-zA-Z0-9 _.-]+$/.test(serviceName)
    ) {
      return reply({ success: false, message: "Invalid service name" }, 400);
    }
  } catch {
    return reply({ success: false, message: "Invalid request body" }, 400);
  }

  // Get the current provider price. Never trust a price sent by the browser.
  let priceResponse: Response;
  let priceData: any;

  try {
    priceResponse = await fetch(
      `${BASE}/sms4/prices?serviceName=${encodeURIComponent(serviceName)}`,
      { headers: { Authorization: `Bearer ${fleexaKey}` } },
    );
    priceData = await priceResponse.json();
  } catch {
    return reply({
      success: false,
      message: "Could not verify provider price. Please try again.",
    }, 502);
  }

  if (!priceResponse.ok || priceData?.success !== true) {
    return reply({
      success: false,
      message: "Could not retrieve the provider price",
    }, 502);
  }

  const priceRows = Array.isArray(priceData.data)
    ? priceData.data
    : [priceData.data];

  const price = priceRows.find((item: any) =>
    String(item?.name ?? item?.serviceName ?? "").toLowerCase() ===
    serviceName.toLowerCase()
  ) ?? priceRows[0];

  const providerCost = Number(price?.price_ngn);
  const maxPriceUsd = Number(price?.price_usd);

  if (
    !Number.isFinite(providerCost) ||
    providerCost <= 0 ||
    !Number.isFinite(maxPriceUsd) ||
    maxPriceUsd <= 0
  ) {
    return reply({
      success: false,
      message: "A valid price is unavailable for this service",
    }, 502);
  }

  const requestId = crypto.randomUUID();

  // Reserve the customer's wallet using the protected SQL function.
  const { data: reservation, error: reserveError } = await admin.rpc(
    "sparkle_reserve_sms_otp",
    {
      p_user_id: authData.user.id,
      p_request_id: requestId,
      p_service_name: serviceName,
      p_country: "US",
      p_provider_cost: providerCost,
    },
  );

  if (reserveError || !reservation?.success) {
    return reply({
      success: false,
      message: reserveError?.message ?? reservation?.message ??
        "Could not reserve this purchase",
    }, 400);
  }

  // Call Fleexa only after the wallet reservation succeeds.
  let buyResponse: Response;
  let buyData: any;

  try {
    buyResponse = await fetch(`${BASE}/sms4/buy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fleexaKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        serviceName,
        maxPrice: maxPriceUsd.toFixed(2),
      }),
    });

    buyData = await buyResponse.json();
  } catch {
    // The provider may have accepted the order before the connection failed.
    // Keep the reservation until the provider status is checked.
    await admin.from("sparkle_sms_otp_orders").update({
      status: "unknown",
      error_message: "Provider response unavailable; reconciliation required",
    }).eq("request_id", requestId);

    return reply({
      success: false,
      status: "unknown",
      requestId,
      message:
        "The provider response is uncertain. Your order is being checked; do not purchase again yet.",
    }, 202);
  }

  const providerOrder = buyData?.data ?? {};
  const providerRequestId =
    providerOrder.requestId ?? providerOrder.activation_id ??
    providerOrder.id ?? null;

  if (
    buyResponse.ok &&
    buyData?.success === true &&
    providerRequestId
  ) {
    const { error: saveError } = await admin
      .from("sparkle_sms_otp_orders")
      .update({
        status: "pending",
        phone_number: providerOrder.number ?? providerOrder.phone ?? null,
        provider_response: buyData,
        error_message: null,
      })
      .eq("request_id", requestId);

    if (saveError) {
      // Do not refund: the provider may already have issued the number.
      return reply({
        success: false,
        status: "unknown",
        requestId,
        message:
          "The provider accepted the order, but Sparkle could not save its details. Support reconciliation is required.",
      }, 202);
    }

    return reply({
      success: true,
      status: "pending",
      requestId,
      phoneNumber: providerOrder.number ?? providerOrder.phone ?? null,
      amount: reservation.amount,
      message: "Number purchased. OTP retrieval must be checked separately.",
    });
  }

  // Refund only when the provider explicitly confirms the purchase failed.
  if (buyData?.success === false) {
    const { error: finishError } = await admin.rpc(
      "sparkle_finish_sms_otp",
      {
        p_request_id: requestId,
        p_status: "failed",
        p_provider_response: buyData,
        p_error: String(buyData?.message ?? "Provider rejected purchase"),
      },
    );

    if (finishError) {
      return reply({
        success: false,
        status: "unknown",
        requestId,
        message:
          "Purchase failed at the provider, but the refund needs reconciliation.",
      }, 202);
    }

    return reply({
      success: false,
      status: "failed",
      message: "Provider rejected the purchase. Wallet refund processed.",
    }, 502);
  }

  // Ambiguous provider responses must never trigger an automatic refund.
  await admin.from("sparkle_sms_otp_orders").update({
    status: "unknown",
    provider_response: buyData,
    error_message: "Unrecognized provider response; reconciliation required",
  }).eq("request_id", requestId);

  return reply({
    success: false,
    status: "unknown",
    requestId,
    message:
      "The provider response needs checking before another purchase is attempted.",
  }, 202);
});
