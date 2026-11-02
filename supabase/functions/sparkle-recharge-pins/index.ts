
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};


function supplierBalanceInsufficient(data: any): boolean {
  const code = String(data?.code ?? data?.statusCode ?? data?.data?.code ?? data?.data?.statusCode
    ?? data?.content?.code ?? data?.data?.content?.code ?? "").trim().toUpperCase();
  const status = String(data?.status ?? data?.data?.status ?? data?.content?.status
    ?? data?.data?.content?.status ?? "").trim().toUpperCase().replace(/[\\s-]+/g, "_");
  const details = [
    data?.description, data?.message, data?.api_response, data?.error, data?.detail,
    data?.data?.description, data?.data?.message, data?.data?.api_response,
    data?.content?.description, data?.content?.message, data?.data?.content?.description
  ].map(x => String(x ?? "")).join(" ").toUpperCase();
  return code === "INSUFFICIENT_BALANCE" || status === "INSUFFICIENT_BALANCE"
    || /INSUFFICIENT[_\\s-]*(?:SUPPLIER[_\\s-]*)?(?:WALLET[_\\s-]*)?BALANCE|BALANCE[_\\s-]*(?:IS[_\\s-]*)?(?:INSUFFICIENT|TOO[_\\s-]*LOW)|NOT[_\\s-]*ENOUGH[_\\s-]*BALANCE|LOW[_\\s-]*BALANCE/.test(details)
    || (code === "402" && /BALANCE/.test(details));
}
async function notifySupplierBalanceLow(supplier: string, service: string, reference: string, reason: string) {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !serviceKey) {
    console.error("[sparkle-supplier-alert] missing internal credentials", { supplier, service, reference });
    return false;
  }
  try {
    const response = await fetch(url + "/functions/v1/sparkle-supplier-alert", {
      method: "POST",
      headers: { Authorization: "Bearer " + serviceKey, apikey: serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ supplier, service, reference, reason }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.emailSent !== true) {
      console.error("[sparkle-supplier-alert] dispatch not confirmed", { supplier, service, reference, status: response.status, reason: String(result?.reason || result?.error || "email_not_confirmed").slice(0, 180) });
      return false;
    }
    return true;
  } catch (error) {
    console.error("[sparkle-supplier-alert] dispatch failed", { supplier, service, reference, error: error instanceof Error ? error.message.slice(0, 180) : "unknown" });
    return false;
  }
}
function supplierBalanceReason(data: any): string {
  return String(data?.description ?? data?.message ?? data?.api_response ?? data?.error
    ?? data?.data?.description ?? data?.data?.message ?? "Supplier account has insufficient balance.")
    .replace(/[\\r\\n\\t]+/g, " ").trim().slice(0, 450);
}

Deno.serve(async (req) => {
  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return reply({ error: "POST required" }, 405);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const gsubzKey = Deno.env.get("GSUBZ_API_KEY");

  if (!url || !anon || !service) {
    return reply({ error: "Server not configured" }, 503);
  }

  if (!gsubzKey) {
    return reply({ error: "Provider not configured" }, 503);
  }

  const auth = req.headers.get("Authorization");

  if (!auth?.startsWith("Bearer ")) {
    return reply({ error: "Sign in required" }, 401);
  }

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();

  if (authError || !user) {
    return reply({ error: "Invalid session" }, 401);
  }

  let body: {
    action?: string;
    network?: string;
    denomination?: number;
    quantity?: number;
    request_id?: string;
    requestId?: string;
    reference?: string;
    pin?: string;
  };

  try {
    body = await req.json();
  } catch {
    return reply({ error: "Invalid JSON" }, 400);
  }

  const action = String(body.action ?? "purchase").trim().toLowerCase();
  if (action === "check" || action === "check_order") {
    const requestId = String(body.request_id ?? body.requestId ?? body.reference ?? "").trim();
    if (!/^SPK-[a-f0-9-]{20,}$/i.test(requestId)) return reply({ success: false, status: "not_started", error: "Invalid Recharge PIN order reference." }, 400);
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const { data: order, error: orderError } = await admin.from("sparkle_recharge_pin_orders")
      .select("user_id,request_id,quantity,status,provider_response,error_message,amount,network,denomination")
      .eq("user_id", user.id).eq("request_id", requestId).maybeSingle();
    if (orderError) return reply({ success: false, status: "unknown", request_id: requestId, error: "Sparkle could not read this order yet. Do not submit another order." }, 202);
    if (!order) return reply({ success: false, status: "not_found", error: "Recharge PIN order not found." }, 404);
    const saved = order.provider_response && typeof order.provider_response === "object" ? order.provider_response as Record<string, any> : {};
    const savedPins = Array.isArray(saved.pins) ? saved.pins : Array.isArray(saved.content?.pins) ? saved.content.pins : [];
    if (order.status === "success") return reply({ success: true, status: "success", request_id: requestId, pins: savedPins });
    if (order.status === "failed") return reply({ success: false, status: "failed", request_id: requestId, error: order.error_message || "The provider confirmed failure and Sparkle processed the refund." });

    const transactionID = String(saved.transactionID ?? saved.content?.transactionID ?? saved.data?.transactionID ?? "").trim();
    if (!transactionID) return reply({
      success: false, status: "unknown", request_id: requestId,
      error: order.error_message || "The supplier did not return a transaction ID that Sparkle can verify. Your funds remain reserved. Contact Sparkle support with this reference; do not buy again.",
    }, 202);

    try {
      const form = new FormData();
      form.append("api", gsubzKey);
      form.append("transactionID", transactionID);
      const response = await fetch("https://api.gsubz.com/api/verify/", {
        method: "POST",
        headers: { Authorization: `Bearer ${gsubzKey}`, Accept: "application/json" },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      const provider = await response.json().catch(() => null);
      const providerStatus = String(provider?.status ?? provider?.data?.status ?? provider?.content?.status ?? provider?.data?.content?.status ?? "").trim().toLowerCase().replace(/[\\s-]+/g, "_");
      const providerCode = String(provider?.code ?? provider?.data?.code ?? provider?.content?.code ?? provider?.data?.content?.code ?? response.status);
      const description = String(provider?.description ?? provider?.data?.description ?? provider?.content?.description ?? provider?.data?.content?.description ?? "").toUpperCase();
      const notFound = providerCode === "404" || description.includes("CONTENT_NOT_FOUND");
      const failed = response.ok && !notFound && ["failed", "failure", "error", "rejected", "cancelled", "canceled", "transaction_failed"].includes(providerStatus);
      const pins = Array.isArray(provider?.pins) ? provider.pins : Array.isArray(provider?.content?.pins) ? provider.content.pins : Array.isArray(provider?.data?.pins) ? provider.data.pins : [];
      const delivered = Number(provider?.delivered ?? provider?.content?.delivered ?? provider?.data?.delivered ?? 0);
      const allPinsValid = pins.length === Number(order.quantity) && pins.every((pin: any) => typeof pin?.pin === "string" && typeof pin?.sn === "string");
      const succeeded = response.ok && ["success", "successful", "transaction_successful"].includes(providerStatus)
        && delivered === Number(order.quantity) && allPinsValid;
      if (succeeded) {
        // The finalizer requires the canonical generation response shape and
        // all PINs. Never settle a partial or unverified delivery as successful.
        const canonical = { status: "success", delivered, pins, verification: provider, transactionID };
        const finished = await admin.rpc("sparkle_finish_recharge_pin", {
          p_user_id: user.id, p_request_id: requestId, p_status: "success",
          p_provider_response: canonical, p_error: null,
        });
        if (finished.error) return reply({ success: false, status: "unknown", request_id: requestId, error: "Supplier success was detected, but Sparkle needs support reconciliation before displaying the PINs." }, 202);
        return reply({ success: true, status: "success", request_id: requestId, pins });
      }
      if (failed) {
        const finished = await admin.rpc("sparkle_finish_recharge_pin", {
          p_user_id: user.id, p_request_id: requestId, p_status: "failed",
          p_provider_response: provider, p_error: "GSubz confirmed the order failed during status verification.",
        });
        if (finished.error) return reply({ success: false, status: "unknown", request_id: requestId, error: "GSubz reports failure, but the refund needs support reconciliation. Do not retry." }, 202);
        return reply({ success: false, status: "failed", request_id: requestId, error: "GSubz confirmed failure. Sparkle has processed the wallet refund." });
      }
      await admin.rpc("sparkle_finish_recharge_pin", {
        p_user_id: user.id, p_request_id: requestId, p_status: "unknown",
        p_provider_response: provider, p_error: notFound
          ? "GSubz could not find the transactionID during verification; order remains reserved."
          : "Provider status is not yet final; order remains reserved.",
      });
      return reply({
        success: false, status: "unknown", request_id: requestId,
        error: notFound
          ? "GSubz could not find this transaction ID. This is not proof of failure. Your funds remain reserved; do not buy again."
          : "GSubz has not confirmed a complete delivery of all requested PINs. Your funds remain reserved; do not buy again.",
      }, 202);
    } catch {
      return reply({ success: false, status: "unknown", request_id: requestId, error: "Could not verify this Recharge PIN order. Your funds remain reserved; do not buy again." }, 202);
    }
  }
  if (action !== "purchase") return reply({ success: false, status: "not_started", error: "Unsupported action." }, 400);

  // Verify the transaction PIN using the existing function.
  // Do not modify sparkle-transaction-pin.
  if (typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) {
    return reply(
      { error: "Enter your 4-digit transaction PIN." },
      400,
    );
  }

  try {
    const pinResponse = await fetch(
      `${url}/functions/v1/sparkle-transaction-pin`,
      {
        method: "POST",
        headers: {
          Authorization: auth,
          apikey: anon,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "verify",
          pin: body.pin,
        }),
      },
    );

    const pinResult = await pinResponse.json().catch(() => null);

    if (!pinResponse.ok || pinResult?.success !== true) {
      const pinError =
        typeof pinResult?.error === "string"
          ? pinResult.error
          : typeof pinResult?.message === "string"
            ? pinResult.message
            : "";

      return reply(
        {
          error:
            pinError ||
            "Could not verify your transaction PIN. Please try again.",
        },
        pinResponse.status >= 400 && pinResponse.status < 500
          ? pinResponse.status
          : 503,
      );
    }
  } catch {
    return reply(
      {
        error:
          "The transaction PIN service is temporarily unavailable. Please try again.",
      },
      503,
    );
  }

  const networks: Record<string, string> = {
    MTN: "mtn",
    AIRTEL: "airtel",
    GLO: "glo",
    "9MOBILE": "9mobile",
  };

  const network =
    typeof body.network === "string"
      ? networks[body.network.trim().toUpperCase()]
      : undefined;

  const value = body.denomination;
  const quantity = body.quantity;
  const requestId = body.request_id;

  if (
    !network ||
    ![100, 200, 400, 500].includes(value ?? 0) ||
    !Number.isInteger(quantity) ||
    (quantity ?? 0) < 1 ||
    (quantity ?? 0) > 100000 ||
    typeof requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,120}$/.test(requestId)
  ) {
    return reply({ error: "Invalid purchase details" }, 400);
  }

  const minimum = value === 500 ? 1 : 10;

  if (quantity! < minimum) {
    return reply(
      { error: `Minimum quantity is ${minimum}` },
      400,
    );
  }

  const admin = createClient(url, service, {
    auth: { persistSession: false },
  });

  const dbNetwork =
    network === "mtn"
      ? "MTN"
      : network === "airtel"
        ? "Airtel"
        : network === "glo"
          ? "Glo"
          : "9mobile";

  // Read selling prices from the database.
  const {
    data: pricing,
    error: priceError,
  } = await admin
    .from("sparkle_recharge_pin_prices")
    .select(
      "selling_price_per_pin, provider_cost_per_pin, min_quantity",
    )
    .eq("network", dbNetwork)
    .eq("denomination", value)
    .maybeSingle();

  if (
    priceError ||
    !pricing ||
    pricing.selling_price_per_pin == null ||
    pricing.provider_cost_per_pin == null
  ) {
    return reply({ error: "Pricing not configured" }, 409);
  }

  if (quantity! < pricing.min_quantity) {
    return reply(
      { error: "Quantity below configured minimum" },
      400,
    );
  }

  const amount = Number(
    (
      Number(pricing.selling_price_per_pin) * quantity!
    ).toFixed(2),
  );

  // Reserve wallet balance before requesting PINs.
  const {
    data: reservation,
    error: reserveError,
  } = await admin.rpc("sparkle_reserve_recharge_pin", {
    p_user_id: user.id,
    p_request_id: requestId,
    p_network: dbNetwork,
    p_denomination: value,
    p_quantity: quantity,
    p_amount: amount,
  });

  if (reserveError) {
    const message = String(reserveError.message || "");

    if (message.toLowerCase().includes("insufficient")) {
      return reply({ error: "Insufficient funds" }, 400);
    }

    return reply(
      { error: message || "Could not reserve order" },
      400,
    );
  }

  if (!reservation?.success) {
    const message = String(reservation?.message ?? "");

    if (message.toLowerCase().includes("insufficient")) {
      return reply({ error: "Insufficient funds" }, 400);
    }

    return reply(
      {
        error: message || "Order already exists",
        status: reservation?.status,
      },
      409,
    );
  }

  const finish = async (
    status: "success" | "failed" | "unknown",
    response: unknown,
    error?: string,
  ) => {
    const { error: finishError } = await admin.rpc(
      "sparkle_finish_recharge_pin",
      {
        p_user_id: user.id,
        p_request_id: requestId,
        p_status: status,
        p_provider_response: response,
        p_error: error ?? null,
      },
    );

    return !finishError;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65000);

  try {
    const form = new FormData();

    form.append("network", network);
    form.append("value", String(value));
    form.append("number", String(quantity));

    const response = await fetch(
      "https://api.gsubz.com/api/generate/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gsubzKey}`,
        },
        body: form,
        signal: controller.signal,
      },
    );

    const provider = (await response
      .json()
      .catch(() => null)) as Record<string, unknown> | null;

    if (!provider) {
      await finish(
        "unknown",
        null,
        "Provider response was not valid JSON",
      );

      return reply(
        {
          status: "unknown",
          message: "Check order status before retrying",
          request_id: requestId,
        },
        202,
      );
    }

    if (supplierBalanceInsufficient(provider)) {
      await notifySupplierBalanceLow("GSubz", "Recharge PIN Printing", requestId, supplierBalanceReason(provider));
      const ok = await finish("failed", provider, "GSubz supplier account has insufficient balance.");
      if (!ok) return reply({ success: false, status: "unknown", request_id: requestId,
        error: "Service unavailable. Sparkle is confirming your wallet reversal. Do not retry yet." }, 202);
      return reply({ success: false, status: "service_unavailable", request_id: requestId,
        error: "Service unavailable. Please try again later. Your Sparkle wallet has not been charged." }, 200);
    }

    if (provider.status === "failed") {
      const ok = await finish(
        "failed",
        provider,
        "Provider confirmed failure",
      );

      return reply(
        {
          error: ok
            ? "Purchase failed; refund processed"
            : "Failure received; refund needs reconciliation",
          status: "failed",
        },
        502,
      );
    }

    const pins = Array.isArray(provider.pins)
      ? provider.pins
      : [];

    const delivered = Number(provider.delivered ?? 0);

    if (
      response.ok &&
      provider.status === "success" &&
      delivered === quantity &&
      pins.length === quantity &&
      pins.every(
        (p: any) =>
          typeof p?.pin === "string" &&
          typeof p?.sn === "string",
      )
    ) {
      const ok = await finish("success", provider);

      if (!ok) {
        return reply(
          {
            error:
              "PINs issued; order status needs reconciliation",
            status: "unknown",
            request_id: requestId,
          },
          202,
        );
      }

      return reply({
        success: true,
        status: "success",
        request_id: requestId,
        pins,
      });
    }

    // Do not automatically refund an ambiguous provider result.
    await finish(
      "unknown",
      provider,
      "Provider result requires reconciliation",
    );

    return reply(
      {
        status: "unknown",
        message: "Order needs checking before retrying",
        request_id: requestId,
      },
      202,
    );
  } catch {
    // Avoid duplicate charging if the provider result is uncertain.
    await finish(
      "unknown",
      null,
      "Provider response could not be confirmed",
    );

    return reply(
      {
        status: "unknown",
        message: "Check order status before retrying",
        request_id: requestId,
      },
      202,
    );
  } finally {
    clearTimeout(timer);
  }
});
