
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "POST required" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const gsubzKey = Deno.env.get("GSUBZ_API_KEY");

  if (!url || !anon || !service) {
    return reply({ error: "Server not configured" }, 503);
  }
  if (!gsubzKey) return reply({ error: "Provider not configured" }, 503);

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return reply({ error: "Sign in required" }, 401);
  }

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return reply({ error: "Invalid session" }, 401);

  let body: {
    network?: string;
    denomination?: number;
    quantity?: number;
    request_id?: string;
    pin?: string;
  };

  try {
    body = await req.json();
  } catch {
    return reply({ error: "Invalid JSON" }, 400);
  }

  // Verify transaction PIN using the existing function.
  if (typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) {
    return reply({ error: "Enter your 4-digit transaction PIN" }, 400);
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
        body: JSON.stringify({ action: "verify", pin: body.pin }),
      },
    );

    const pinResult = await pinResponse.json().catch(() => null);

    if (!pinResponse.ok || pinResult?.success !== true) {
      return reply({
        error: pinResult?.message || "Transaction PIN verification failed",
      }, 401);
    }
  } catch {
    return reply({
      error: "Could not verify transaction PIN. Please try again",
    }, 503);
  }

  const networks: Record<string, string> = {
    MTN: "mtn",
    AIRTEL: "airtel",
    GLO: "glo",
    "9MOBILE": "9mobile",
  };

  const network = typeof body.network === "string"
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
    return reply({ error: `Minimum quantity is ${minimum}` }, 400);
  }

  const admin = createClient(url, service, {
    auth: { persistSession: false },
  });

  const dbNetwork = network === "mtn"
    ? "MTN"
    : network === "airtel"
    ? "Airtel"
    : network === "glo"
    ? "Glo"
    : "9mobile";

  // Prices come from Supabase, never from the browser.
  const { data: pricing, error: priceError } = await admin
    .from("sparkle_recharge_pin_prices")
    .select("selling_price_per_pin, provider_cost_per_pin, min_quantity")
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
    return reply({ error: "Quantity below configured minimum" }, 400);
  }

  const amount = Number(
    (Number(pricing.selling_price_per_pin) * quantity!).toFixed(2),
  );

  const { data: reservation, error: reserveError } = await admin.rpc(
    "sparkle_reserve_recharge_pin",
    {
      p_user_id: user.id,
      p_request_id: requestId,
      p_network: dbNetwork,
      p_denomination: value,
      p_quantity: quantity,
      p_amount: amount,
    },
  );

  if (reserveError) {
    return reply({ error: "Could not reserve order" }, 400);
  }

  if (!reservation?.success) {
    return reply({
      error: reservation?.message ?? "Order already exists",
      status: reservation?.status,
    }, 409);
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
      "https://api.gsubz.com/apiV2/generate/",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${gsubzKey}` },
        body: form,
        signal: controller.signal,
      },
    );

    const provider = await response.json().catch(() => null) as
      Record<string, unknown> | null;

    if (!provider) {
      await finish("unknown", null, "Provider response was not valid JSON");
      return reply({
        status: "unknown",
        message: "Check order status before retrying",
        request_id: requestId,
      }, 202);
    }

    if (provider.status === "failed") {
      const ok = await finish(
        "failed",
        provider,
        "Provider confirmed failure",
      );

      return reply({
        error: ok
          ? "Purchase failed; refund processed"
          : "Failure received; refund needs reconciliation",
        status: "failed",
      }, 502);
    }

    const pins = Array.isArray(provider.pins) ? provider.pins : [];
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
        return reply({
          error: "PINs issued; order status needs reconciliation",
          status: "unknown",
          request_id: requestId,
        }, 202);
      }

      return reply({
        success: true,
        status: "success",
        request_id: requestId,
        pins,
      });
    }

    await finish(
      "unknown",
      provider,
      "Provider result requires reconciliation",
    );

    return reply({
      status: "unknown",
      message: "Order needs checking before retrying",
      request_id: requestId,
    }, 202);
  } catch {
    await finish(
      "unknown",
      null,
      "Provider response could not be confirmed",
    );

    return reply({
      status: "unknown",
      message: "Check order status before retrying",
      request_id: requestId,
    }, 202);
  } finally {
    clearTimeout(timer);
  }
});
