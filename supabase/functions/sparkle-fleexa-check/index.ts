
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    if (req.method !== "POST") {
      return respond({ success: false, error: "POST required" }, 405);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = Deno.env.get("FLEEXA_API_KEY");

    if (!supabaseUrl || !anonKey || !serviceKey || !apiKey) {
      return respond({
        success: false,
        error: "Required server configuration is missing.",
      }, 500);
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization) {
      return respond({ success: false, error: "Please sign in." }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: authError } =
      await userClient.auth.getUser();

    if (authError || !userData.user) {
      return respond({ success: false, error: "Invalid session." }, 401);
    }

    const user = userData.user;
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await req.json().catch(() => ({}));
    const requestId = String(body.request_id ?? "").trim();

    if (!requestId) {
      return respond({
        success: false,
        error: "Missing request_id.",
      }, 400);
    }

    const { data: order, error: orderError } = await admin
      .from("sparkle_fleexa_smsotp_orders")
      .select("*")
      .eq("user_id", user.id)
      .eq("request_id", requestId)
      .maybeSingle();

    if (orderError) {
      return respond({
        success: false,
        error: "Could not load the order.",
      }, 500);
    }

    if (!order) {
      return respond({ success: false, error: "Order not found." }, 404);
    }

    if (String(order.status).toLowerCase() === "success") {
      return respond({
        success: true,
        status: "success",
        phone: order.phone_number ?? order.phone ?? null,
        sms_code: order.sms_code ?? null,
        message: "This order is already completed.",
      });
    }

    if (!order.provider_request_id) {
      return respond({
        success: false,
        error: "The provider order ID is missing. Please contact support.",
      }, 409);
    }

    const providerResponse = await fetch(
      `https://fleexa.com.ng/developer/sms4/check/${encodeURIComponent(
        String(order.provider_request_id),
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      },
    );

    const result = await providerResponse.json().catch(() => null);

    if (!providerResponse.ok || !result || result.success === false) {
      return respond({
        success: false,
        error: "Fleexa could not confirm the SMS status. Please try again.",
      }, 502);
    }

    const data = result.data ?? result;
    const status = String(
      data.status ?? data.code ?? "pending",
    ).toLowerCase();

    const smsCode =
      data.sms_code ??
      data.smsCode ??
      data.code_value ??
      null;

    const phone =
      data.phone ??
      data.phone_number ??
      data.number ??
      order.phone_number ??
      order.phone ??
      null;

    const received =
      status === "received" ||
      status === "completed" ||
      status === "complete" ||
      status === "success" ||
      status === "successful";

    if (received && smsCode != null && String(smsCode).trim() !== "") {
      const { data: finished, error: finishError } = await admin.rpc(
        "sparkle_finish_fleexa_smsotp",
        {
          p_user_id: user.id,
          p_request_id: requestId,
          p_status: "success",
          p_provider_response: result,
          p_error: null,
          p_provider_request_id: String(order.provider_request_id),
          p_phone_number: phone ? String(phone) : null,
          p_sms_code: String(smsCode),
        },
      );

      if (finishError || !finished?.success) {
        return respond({
          success: false,
          error:
            "The SMS was received, but Sparkle could not finalize the order. Do not cancel or buy again. Contact support for review.",
          needs_review: true,
        }, 500);
      }

      return respond({
        success: true,
        status: "success",
        phone,
        sms_code: String(smsCode),
        message: "SMS code received and order completed.",
      });
    }

    // Save the latest provider response without issuing a refund.
    const { error: updateError } = await admin
      .from("sparkle_fleexa_smsotp_orders")
      .update({
        provider_response: result,
        phone_number: phone ? String(phone) : order.phone_number,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)
      .eq("request_id", requestId);

    if (updateError) {
      return respond({
        success: false,
        error: "Could not save the latest SMS status.",
      }, 500);
    }

    return respond({
      success: true,
      status: "pending",
      phone,
      message: "No SMS code confirmed yet. Check again later.",
    });
  } catch (_error) {
    return respond({
      success: false,
      error: "A temporary error occurred. Please try again.",
    }, 500);
  }
});
