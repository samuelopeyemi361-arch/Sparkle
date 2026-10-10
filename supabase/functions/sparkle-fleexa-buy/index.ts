
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE = "https://fleexa.com.ng/developer";
type Obj = Record<string, any>;

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

function findPriceObject(payload: any): Obj | null {
  const root = payload?.data ?? payload?.result ?? payload;
  if (Array.isArray(root))
    return root.find((x) => x && typeof x === "object") ?? null;

  if (root && typeof root === "object") {
    if (root.price_usd != null || root.price_ngn != null) return root;

    if (Array.isArray(root.prices))
      return root.prices.find((x: any) => x && typeof x === "object") ?? null;

    const match = Object.values(root).find(
      (x: any) =>
        x && typeof x === "object" &&
        (x.price_usd != null || x.price_ngn != null)
    );

    if (match) return match as Obj;
  }

  return null;
}

function getProviderId(d: Obj): string | null {
  const raw =
    d.requestId ?? d.request_id ?? d.activationId ??
    d.activation_id ?? d.orderId ?? d.order_id ?? d.id;

  return raw == null || String(raw).trim() === ""
    ? null
    : String(raw);
}

function getPhone(d: Obj): string | null {
  const raw = d.phoneNumber ?? d.phone_number ?? d.phone ?? d.number ?? d.mobile;
  return raw == null ? null : String(raw);
}

function isRealSmsCode(value: unknown): boolean {
  if (value == null) return false;
  const code = String(value).trim();

  if (!code) return false;

  return ![
    "RECEIVED",
    "PENDING",
    "WAITING",
    "COMPLETED",
    "COMPLETE",
    "SUCCESS",
    "SUCCESSFUL",
    "ACTIVE",
  ].includes(code.toUpperCase());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: cors });

  if (req.method !== "POST")
    return reply({ success: false, message: "POST required." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const fleexaKey = Deno.env.get("FLEEXA_API_KEY");

  if (!url || !anon || !service || !fleexaKey)
    return reply({
      success: false,
      message: "Server secrets are not configured.",
    }, 503);

  const auth = req.headers.get("Authorization");

  if (!auth?.startsWith("Bearer "))
    return reply({ success: false, message: "Sign in required." }, 401);

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } =
    await userClient.auth.getUser();

  if (authError || !user)
    return reply({
      success: false,
      message: "Your session has expired. Sign in again.",
    }, 401);

  let body: Obj;

  try {
    body = await req.json();
  } catch {
    return reply({ success: false, message: "Invalid JSON." }, 400);
  }

  const serviceName =
    typeof body.serviceName === "string" ? body.serviceName.trim() : "";
  const requestId =
    typeof body.request_id === "string" ? body.request_id.trim() : "";
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";

  if (
    !serviceName ||
    serviceName.length > 100 ||
    !/^[a-zA-Z0-9_-]{8,120}$/.test(requestId)
  ) {
    return reply({
      success: false,
      message: "Select a service and use a valid order reference.",
    }, 400);
  }

  if (!/^\d{4}$/.test(pin))
    return reply({
      success: false,
      message: "Enter your 4-digit transaction PIN.",
    }, 400);

  // Preserve Sparkle's existing transaction PIN function.
  try {
    const pinRes = await fetch(
      `${url}/functions/v1/sparkle-transaction-pin`,
      {
        method: "POST",
        headers: {
          Authorization: auth,
          apikey: anon,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "verify", pin }),
      }
    );

    const pinData = await pinRes.json().catch(() => null);

    if (!pinRes.ok || pinData?.success !== true)
      return reply({
        success: false,
        message: pinData?.message ||
          "Transaction PIN verification failed.",
      }, 401);
  } catch {
    return reply({
      success: false,
      message: "Could not verify transaction PIN. Please try again.",
    }, 503);
  }

  const admin = createClient(url, service, {
    auth: { persistSession: false },
  });

  const headers = {
    Authorization: `Bearer ${fleexaKey}`,
    "X-API-Key": fleexaKey,
    "Content-Type": "application/json",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    // Fetch the current provider price.
    const priceRes = await fetch(
      `${BASE}/sms4/prices?serviceName=${encodeURIComponent(serviceName)}`,
      { headers, signal: controller.signal }
    );

    const priceJson = await priceRes.json().catch(() => null);

    if (!priceRes.ok || !priceJson || priceJson.success === false)
      return reply({
        success: false,
        message: "Fleexa could not provide a current price. Your wallet was not charged.",
      }, 502);

    const price = findPriceObject(priceJson);
    const priceUsd = Number(
      price?.price_usd ?? price?.api_rate_usd ?? price?.rate_usd
    );
    const costNgn = Number(
      price?.price_ngn ?? price?.rate ?? price?.price
    );

    if (
      !Number.isFinite(priceUsd) || priceUsd <= 0 ||
      !Number.isFinite(costNgn) || costNgn <= 0
    ) {
      return reply({
        success: false,
        message: "Fleexa price response was not in the expected USD/NGN format. Wallet unchanged.",
      }, 502);
    }

    const sellingNgn = Number((costNgn * 1.75).toFixed(2));

    // Use Sparkle's EXISTING wallet reservation RPC.
    const { data: reservation, error: reserveError } =
      await admin.rpc("sparkle_reserve_fleexa_smsotp", {
        p_user_id: user.id,
        p_request_id: requestId,
        p_service_name: serviceName,
        p_provider_price_usd: priceUsd,
        p_provider_cost_ngn: costNgn,
        p_selling_price_ngn: sellingNgn,
      });

    if (reserveError)
      return reply({
        success: false,
        message: "Could not safely reserve the wallet purchase. No provider order was sent.",
      }, 500);

    if (!reservation?.success)
      return reply({
        success: false,
        message: reservation?.message || "Purchase could not be reserved.",
        status: reservation?.status,
        duplicate: !!reservation?.duplicate,
      }, 409);

    let buyRes: Response;
    let buyJson: any;

    try {
      buyRes = await fetch(`${BASE}/sms4/buy`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          serviceName,
          maxPrice: priceUsd.toFixed(4)
            .replace(/0+$/, "")
            .replace(/\.$/, ""),
        }),
        signal: controller.signal,
      });

      buyJson = await buyRes.json().catch(() => null);
    } catch {
      await admin.rpc("sparkle_finish_fleexa_smsotp", {
        p_user_id: user.id,
        p_request_id: requestId,
        p_status: "unknown",
        p_provider_response: null,
        p_error: "Network/timeout after purchase request; provider result uncertain.",
        p_provider_request_id: null,
        p_phone_number: null,
        p_sms_code: null,
      });

      return reply({
        success: false,
        status: "unknown",
        request_id: requestId,
        message: "Fleexa's response could not be confirmed. Funds remain reserved while the order is checked; do not retry yet.",
      }, 202);
    }

    const data =
      buyJson?.data && typeof buyJson.data === "object"
        ? buyJson.data
        : (buyJson ?? {});

    const providerId = getProviderId(data);
    const phone = getPhone(data);
    const rawCode = data.sms_code ?? data.smsCode ?? data.code ?? null;
    const smsCode = isRealSmsCode(rawCode) ? String(rawCode).trim() : null;

    const providerAccepted =
      buyRes.ok &&
      buyJson &&
      buyJson.success !== false &&
      (
        providerId !== null ||
        data.status === "pending" ||
        data.status === "success" ||
        data.status === "active"
      );

    if (!providerAccepted) {
      const explicitReject =
        !!buyJson &&
        (
          buyJson.success === false ||
          buyJson.status === "failed" ||
          buyJson.status === "error"
        ) &&
        !providerId;

      if (explicitReject) {
        const finish = await admin.rpc(
          "sparkle_finish_fleexa_smsotp",
          {
            p_user_id: user.id,
            p_request_id: requestId,
            p_status: "failed",
            p_provider_response: buyJson,
            p_error: String(
              buyJson.message ?? buyJson.error ?? "Fleexa rejected the purchase."
            ),
            p_provider_request_id: null,
            p_phone_number: null,
            p_sms_code: null,
          }
        );

        return reply({
          success: false,
          status: "failed",
          refunded: !!finish.data?.refunded,
          message: "Fleexa rejected the order. Sparkle processed the refund if the database confirmed it.",
        }, 502);
      }

      await admin.rpc("sparkle_finish_fleexa_smsotp", {
        p_user_id: user.id,
        p_request_id: requestId,
        p_status: "unknown",
        p_provider_response: buyJson,
        p_error: "Provider response did not clearly confirm success or failure.",
        p_provider_request_id: providerId,
        p_phone_number: phone,
        p_sms_code: smsCode,
      });

      return reply({
        success: false,
        status: "unknown",
        request_id: requestId,
        provider_request_id: providerId,
        message: "Fleexa's response is unclear. Funds remain reserved until the order is checked; do not retry yet.",
      }, 202);
    }

    // IMPORTANT: provider acceptance alone is not completion.
    // Only call finish with success if a genuine SMS code is present.
    if (!smsCode) {
      const pendingUpdate = await admin.rpc(
        "sparkle_finish_fleexa_smsotp",
        {
          p_user_id: user.id,
          p_request_id: requestId,
          p_status: "pending",
          p_provider_response: buyJson,
          p_error: null,
          p_provider_request_id: providerId,
          p_phone_number: phone,
          p_sms_code: null,
        }
      );

      if (pendingUpdate.error) {
        return reply({
          success: false,
          status: "unknown",
          request_id: requestId,
          provider_request_id: providerId,
          message: "Fleexa accepted the order, but Sparkle could not update its order record. Do not retry; check the order.",
        }, 202);
      }

      return reply({
        success: true,
        status: "pending",
        request_id: requestId,
        provider_request_id: providerId,
        serviceName,
        phoneNumber: phone,
        smsCode: null,
        provider_cost_ngn: costNgn,
        selling_price_ngn: sellingNgn,
        message: "Order accepted and waiting for the SMS code. Funds remain reserved; check this order instead of buying again.",
      }, 200);
    }

    // Only a real code can reach this success-finalization path.
    const finish = await admin.rpc("sparkle_finish_fleexa_smsotp", {
      p_user_id: user.id,
      p_request_id: requestId,
      p_status: "success",
      p_provider_response: buyJson,
      p_error: null,
      p_provider_request_id: providerId,
      p_phone_number: phone,
      p_sms_code: smsCode,
    });

    if (finish.error || !finish.data?.success)
      return reply({
        success: false,
        status: "unknown",
        request_id: requestId,
        provider_request_id: providerId,
        message: "Sparkle could not finalize the SMS order. Do not retry; order needs reconciliation.",
      }, 202);

    if (finish.data?.awaiting_sms_code)
      return reply({
        success: true,
        status: "pending",
        request_id: requestId,
        provider_request_id: providerId,
        serviceName,
        phoneNumber: phone,
        smsCode: null,
        provider_cost_ngn: costNgn,
        selling_price_ngn: sellingNgn,
        message: "Order is waiting for the SMS code. Check this order instead of buying again.",
      }, 200);

    return reply({
      success: true,
      status: "completed",
      request_id: requestId,
      provider_request_id: providerId,
      serviceName,
      phoneNumber: phone,
      smsCode,
      provider_cost_ngn: costNgn,
      selling_price_ngn: sellingNgn,
      message: "SMS OTP received.",
    });
  } catch (e) {
    return reply({
      success: false,
      message:
        e instanceof Error && e.name === "AbortError"
          ? "Fleexa request timed out. Check the order before retrying."
          : "Purchase could not be completed safely. Check the order before retrying.",
    }, 503);
  } finally {
    clearTimeout(timer);
  }
});
