
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return respond({ success: false, error: "POST required." }, 405);
    }

    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = Deno.env.get("FLEEXA_API_KEY");

    if (!url || !anonKey || !serviceKey || !apiKey) {
      return respond({ success: false, error: "Server configuration missing." }, 500);
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization) {
      return respond({ success: false, error: "Please sign in." }, 401);
    }

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: authData, error: authError } =
      await userClient.auth.getUser();

    if (authError || !authData.user) {
      return respond({ success: false, error: "Invalid session." }, 401);
    }

    const user = authData.user;

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await req.json().catch(() => ({}));
    const requestId = String(body.request_id ?? "").trim();

    if (!requestId) {
      return respond({ success: false, error: "Missing request_id." }, 400);
    }

    const { data: order, error: orderError } = await admin
      .from("sparkle_fleexa_smsotp_orders")
      .select("*")
      .eq("user_id", user.id)
      .eq("request_id", requestId)
      .maybeSingle();

    if (orderError) {
      return respond({ success: false, error: "Could not load order." }, 500);
    }

    if (!order) {
      return respond({ success: false, error: "Order not found." }, 404);
    }

    const currentStatus = String(order.status ?? "").toLowerCase();

    if (
      currentStatus === "success" ||
      (order.sms_code != null && String(order.sms_code).trim() !== "")
    ) {
      return respond({
        success: false,
        status: "success",
        error: "This order has received a code and cannot be cancelled here.",
      }, 409);
    }

    if (currentStatus === "cancelled" || currentStatus === "canceled") {
      return respond({
        success: true,
        status: "cancelled",
        message: "This order is already cancelled.",
      });
    }

    if (currentStatus === "failed") {
      return respond({
        success: false,
        status: "failed",
        error: "This order has already failed. Contact support if a refund is missing.",
      }, 409);
    }

    if (!order.provider_request_id) {
      return respond({
        success: false,
        error: "Provider order ID is missing. Contact support.",
      }, 409);
    }

    const providerResponse = await fetch(
      "https://fleexa.com.ng/developer/sms4/cancel",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          requestId: String(order.provider_request_id),
        }),
        signal: AbortSignal.timeout(20000),
      },
    );

    const result = await providerResponse.json().catch(() => null);

    if (!providerResponse.ok || !result || result.success === false) {
      return respond({
        success: false,
        error: "Fleexa did not confirm cancellation. No Sparkle refund was issued.",
      }, 502);
    }

    const data = result.data ?? result;
    const providerStatus = String(
      data.status ?? data.code ?? data.message ?? "",
    ).toLowerCase();

    const confirmedCancelled =
      providerStatus === "cancelled" ||
      providerStatus === "canceled";

    if (!confirmedCancelled) {
      // Preserve the response for support; never refund on an ambiguous result.
      await admin
        .from("sparkle_fleexa_smsotp_orders")
        .update({
          provider_response: result,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("request_id", requestId);

      return respond({
        success: false,
        status: providerStatus || "unknown",
        error:
          "Fleexa's response did not explicitly confirm cancellation. No Sparkle refund was issued. Contact support before retrying.",
      }, 409);
    }

    const { data: finished, error: finishError } = await admin.rpc(
      "sparkle_finish_fleexa_smsotp",
      {
        p_user_id: user.id,
        p_request_id: requestId,
        p_status: "cancelled",
        p_provider_response: result,
        p_error: null,
        p_provider_request_id: String(order.provider_request_id),
        p_phone_number: order.phone ?? null,
        p_sms_code: null,
      },
    );

    if (finishError || !finished?.success) {
      return respond({
        success: false,
        needs_review: true,
        error:
          "Fleexa confirmed cancellation, but Sparkle could not finalize the refund. Do not retry; contact support for review.",
      }, 500);
    }

    return respond({
      success: true,
      status: "cancelled",
      message: "Cancellation confirmed and Sparkle processed the refund.",
    });
  } catch (_error) {
    return respond({
      success: false,
      error: "Temporary error. Check the order status before trying again.",
    }, 500);
  }
});
