
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const str = (v: unknown) => String(v ?? "").trim();

const statusOf = (d: any) =>
  str(d?.status ?? d?.data?.status ?? d?.content?.status).toLowerCase();

const successStatus = (s: string) =>
  ["successful", "success", "completed"].includes(s);

const failureStatus = (s: string) =>
  ["failed", "failure", "error", "rejected", "cancelled"].includes(s);

async function checkStoredPin(
  pin: string,
  stored: string,
): Promise<boolean> {
  const [saltHex, expected] = stored.split(":");

  if (!saltHex || !expected || !/^[0-9a-f]+$/i.test(saltHex)) {
    return false;
  }

  const salt = new Uint8Array(
    (saltHex.match(/.{2}/g) || []).map((v) => parseInt(v, 16)),
  );

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 310000,
      hash: "SHA-256",
    },
    key,
    256,
  );

  const actual = Array.from(new Uint8Array(bits))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");

  return actual === expected;
}

const providers = new Set([
  "aba-electric",
  "abuja-electric",
  "benin-electric",
  "eko-electric",
  "enugu-electric",
  "ibadan-electric",
  "ikeja-electric",
  "jos-electric",
  "kaduna-electric",
  "kano-electric",
  "portharcourt-electric",
  "yola-electric",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reply({ success: false, error: "POST required" }, 405);
  }

  const auth = req.headers.get("Authorization");

  if (!auth?.startsWith("Bearer ")) {
    return reply({ success: false, error: "Sign in required" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const gsubzKey = Deno.env.get("GSUBZ_API_KEY");

  if (!url || !anonKey || !serviceKey || !gsubzKey) {
    return reply({
      success: false,
      error: "Secure electricity service is not configured.",
    }, 500);
  }

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();

  if (authError || !user) {
    return reply({
      success: false,
      error: "Invalid session. Sign in again.",
    }, 401);
  }

  let body: Record<string, unknown>;

  try {
    body = await req.json();
  } catch {
    return reply({ success: false, error: "Invalid JSON." }, 400);
  }

  const action = str(body.action).toLowerCase();

  const serviceID = str(body.serviceID || body.provider)
    .toLowerCase()
    .replace(/_/g, "-");

  const meter = str(body.customerID || body.meter || body.billersCode);
  const phone = str(body.phone);

  const type = str(
    body.type ||
      body.variation_code ||
      body.variationCode ||
      body.planValue ||
      body.plan,
  ).toLowerCase();

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  async function callGsubz(
    path: string,
    fields: Record<string, string>,
  ) {
    const form = new FormData();
    form.append("api", gsubzKey!);

    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }

    const response = await fetch("https://api.gsubz.com" + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gsubzKey}`,
        Accept: "application/json",
      },
      body: form,
      signal: AbortSignal.timeout(55000),
    });

    const raw = await response.text();
    let data: any;

    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw: raw.slice(0, 1000) };
    }

    return { response, data };
  }

  async function walletAction(
    actionName: string,
    reference: string,
    amount: number,
    pPhone: string,
    metadata: Record<string, unknown> = {},
  ) {
    return await admin.rpc("sparkle_airtime_wallet_action", {
      p_user_id: user!.id,
      p_action: actionName,
      p_reference: reference,
      p_amount: amount,
      p_service: "Electricity",
      p_phone: pPhone,
      p_metadata: metadata,
    });
  }

  // STEP 1: Verify the electricity meter.
  if (action === "verify") {
    if (
      !providers.has(serviceID) ||
      !meter ||
      !["prepaid", "postpaid"].includes(type)
    ) {
      return reply({
        success: false,
        status: "not_started",
        error:
          "Choose a valid electricity provider, meter number, and Prepaid/Postpaid type.",
      }, 400);
    }

    try {
      const { response, data } = await callGsubz(
        "/api/verify-customer/",
        {
          serviceID,
          billersCode: meter,
          type,
        },
      );

      const providerStatus = statusOf(data);
      const content =
        data?.content ?? data?.data?.content ?? data?.data ?? data;

      const customerName = str(
        content?.customerName ??
          content?.customer_name ??
          content?.Customer_Name ??
          content?.name,
      );

      if (
        !response.ok ||
        !successStatus(providerStatus) ||
        !customerName
      ) {
        const detail = str(
          data?.api_response ||
            data?.description ||
            data?.message ||
            data?.error,
        );

        return reply({
          success: false,
          status: "verification_failed",
          error:
            detail ||
            "Meter verification failed. Check the number and provider.",
          providerStatus: providerStatus || "unknown",
        }, 422);
      }

      return reply({
        success: true,
        status: "verified",
        provider: serviceID,
        meter,
        type,
        customerName,
        address: str(content?.address ?? content?.Address),
        meterType:
          str(content?.meterType ?? content?.meter_type) ||
          type.toUpperCase(),
      });
    } catch {
      return reply({
        success: false,
        status: "verification_failed",
        error:
          "Could not verify this meter right now. No money has been deducted.",
      }, 502);
    }
  }

  // STEP 2: Check or reconcile a previous transaction.
  if (action === "check") {
    const reference = str(body.reference);

    if (!/^SPK-EL-[a-f0-9-]{20,}$/i.test(reference)) {
      return reply({
        success: false,
        status: "not_started",
        error: "Invalid transaction reference.",
      }, 400);
    }

    const { data: tx, error: txError } = await admin
      .from("wallet_transactions")
      .select("user_id,amount,service,status,metadata,reference")
      .eq("reference", reference)
      .maybeSingle();

    if (
      txError ||
      !tx ||
      tx.user_id !== user.id ||
      tx.service !== "Electricity"
    ) {
      return reply({
        success: false,
        status: "not_found",
        error: "Electricity transaction not found.",
      }, 404);
    }

    if (tx.status === "successful") {
      return reply({
        success: true,
        status: "successful",
        reference,
        details: tx.metadata || {},
      });
    }

    if (["refunded", "failed"].includes(tx.status)) {
      return reply({
        success: false,
        status: "refunded",
        reference,
        error: "This electricity transaction was already refunded.",
      });
    }

    try {
      const { response, data } = await callGsubz("/api/verify/", {
        requestID: reference,
      });

      const s = statusOf(data);

      if (response.ok && successStatus(s)) {
        const fin = await walletAction(
          "success",
          reference,
          Number(tx.amount),
          str(tx.metadata?.phone),
          { provider_response: data, stage: "completed" },
        );

        if (fin.error || !fin.data?.success) {
          return reply({
            success: false,
            status: "pending",
            reference,
            error:
              "Provider confirmed success, but Sparkle needs to reconcile the wallet record.",
          }, 202);
        }

        return reply({
          success: true,
          status: "successful",
          reference,
          details: {
            ...(tx.metadata || {}),
            provider_response: data,
          },
        });
      }

      if (response.ok && failureStatus(s)) {
        const ref = await walletAction(
          "failure",
          reference,
          Number(tx.amount),
          str(tx.metadata?.phone),
          { provider_response: data, stage: "refunded" },
        );

        if (ref.error || !ref.data?.success) {
          return reply({
            success: false,
            status: "pending",
            reference,
            error:
              "Provider rejected the order; automatic refund needs reconciliation.",
          }, 202);
        }

        return reply({
          success: false,
          status: "refunded",
          reference,
          error:
            "The electricity transaction failed and your wallet was refunded.",
        });
      }

      await walletAction(
        "pending",
        reference,
        Number(tx.amount),
        str(tx.metadata?.phone),
        { provider_check: data, stage: "provider_pending" },
      );

      return reply({
        success: false,
        status: "pending",
        reference,
        error:
          "The provider has not confirmed this order yet. Funds remain reserved; do not retry it.",
      }, 202);
    } catch {
      return reply({
        success: false,
        status: "pending",
        reference,
        error:
          "Could not check the provider yet. Funds remain reserved; do not retry it.",
      }, 202);
    }
  }

  // STEP 3: Process a purchase after the customer reviews and enters PIN.
  if (action !== "purchase") {
    return reply({
      success: false,
      error: "Unsupported action.",
    }, 400);
  }

  const amount = Number(body.amount);

  if (
    !providers.has(serviceID) ||
    !meter ||
    !/^0\d{10}$/.test(phone) ||
    !["prepaid", "postpaid"].includes(type) ||
    !Number.isSafeInteger(amount) ||
    amount < 1000 ||
    amount > 1000000
  ) {
    return reply({
      success: false,
      status: "not_started",
      error:
        "Complete all electricity details. Total payment must be between ₦1,000 and ₦1,000,000.",
    }, 400);
  }

  const pin = str(body.pin);

  // Supports Sparkle's existing 4–6 digit PIN format.
  if (!/^\d{4,6}$/.test(pin)) {
    return reply({
      success: false,
      status: "not_started",
      error: "Enter your 4–6 digit transaction PIN.",
    }, 400);
  }

  const {
    data: pinRecord,
    error: pinReadError,
  } = await admin
    .from("sparkle_transaction_pins")
    .select("pin_hash,failed_attempts,locked_until")
    .eq("user_id", user.id)
    .maybeSingle();

  if (pinReadError) {
    return reply({
      success: false,
      status: "not_started",
      error: "Could not verify transaction PIN.",
    }, 500);
  }

  if (!pinRecord) {
    return reply({
      success: false,
      status: "not_started",
      error: "Set your transaction PIN first.",
    }, 403);
  }

  if (
    pinRecord.locked_until &&
    new Date(pinRecord.locked_until).getTime() > Date.now()
  ) {
    return reply({
      success: false,
      status: "not_started",
      error: "Too many PIN attempts. Try again later.",
    }, 429);
  }

  const validPin = await checkStoredPin(pin, pinRecord.pin_hash);

  if (!validPin) {
    const attempts = Number(pinRecord.failed_attempts || 0) + 1;

    await admin
      .from("sparkle_transaction_pins")
      .update({
        failed_attempts: attempts >= 5 ? 0 : attempts,
        locked_until:
          attempts >= 5
            ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
            : null,
      })
      .eq("user_id", user.id);

    return reply({
      success: false,
      status: "not_started",
      error: "Incorrect transaction PIN.",
    }, 401);
  }

  await admin
    .from("sparkle_transaction_pins")
    .update({
      failed_attempts: 0,
      locked_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);

  // Customer pays the total amount; 90% is electricity value.
  const electricityValue = Math.floor(amount * 0.9);
  const sparkleProfit = amount - electricityValue;
  const reference = "SPK-EL-" + crypto.randomUUID();

  // Verify the meter again before reserving wallet funds.
  let verification: any;

  try {
    verification = await callGsubz("/api/verify-customer/", {
      serviceID,
      billersCode: meter,
      type,
    });
  } catch {
    return reply({
      success: false,
      status: "not_started",
      error: "Could not verify the meter. No purchase was sent.",
    }, 502);
  }

  const vd = verification.data;
  const verifyContent =
    vd?.content ?? vd?.data?.content ?? vd?.data ?? vd;

  const customerName = str(
    verifyContent?.customerName ??
      verifyContent?.customer_name ??
      verifyContent?.Customer_Name ??
      verifyContent?.name,
  );

  if (
    !verification.response.ok ||
    !successStatus(statusOf(vd)) ||
    !customerName
  ) {
    return reply({
      success: false,
      status: "not_started",
      error:
        str(vd?.api_response || vd?.description || vd?.message) ||
        "Meter verification failed. No money has been deducted.",
    }, 422);
  }

  const metadata = {
    provider: serviceID,
    meter,
    type,
    electricity_value: electricityValue,
    sparkle_profit: sparkleProfit,
    customer_name: customerName,
    address: verifyContent?.address || "",
    phone,
    currency: "NGN",
  };

  // Reserve wallet funds before sending the provider order.
  const reserve = await walletAction(
    "reserve",
    reference,
    amount,
    phone,
    metadata,
  );

  if (reserve.error) {
    return reply({
      success: false,
      status: "not_started",
      error: "Wallet reservation failed; no electricity order was sent.",
    }, 500);
  }

  if (!reserve.data?.success) {
    if (/insufficient/i.test(str(reserve.data?.error))) {
      return reply({
        success: false,
        status: "not_started",
        error:
          "Insufficient funds. Please fund your wallet to continue.",
      }, 402);
    }

    return reply({
      success: false,
      status: "not_started",
      error: str(reserve.data?.error) || "Wallet reservation failed.",
    }, 400);
  }

  if (reserve.data?.duplicate) {
    return reply({
      success: false,
      status: reserve.data.status,
      reference,
      error:
        "This reference already exists. Check your transaction history before retrying.",
    }, 409);
  }

  let providerResult: { response: Response; data: any };

  try {
    providerResult = await callGsubz("/api/pay/", {
      serviceID,
      phone,
      customerID: meter,
      amount: String(electricityValue),
      variation_code: type,
      requestID: reference,
    });
  } catch {
    await walletAction(
      "pending",
      reference,
      amount,
      phone,
      { ...metadata, provider_timeout: true, stage: "provider_pending" },
    );

    return reply({
      success: false,
      status: "pending",
      reference,
      error:
        "Provider response is uncertain. Funds remain reserved while the order is checked. Do not retry this purchase yet.",
    }, 202);
  }

  const pd = providerResult.data;
  const ps = statusOf(pd);

  if (providerResult.response.ok && successStatus(ps)) {
    const fin = await walletAction(
      "success",
      reference,
      amount,
      phone,
      { ...metadata, provider_response: pd, stage: "completed" },
    );

    if (fin.error || !fin.data?.success) {
      return reply({
        success: false,
        status: "pending",
        reference,
        error:
          "Provider reported success but Sparkle needs to reconcile the transaction. Do not retry.",
      }, 202);
    }

    return reply({
      success: true,
      status: "successful",
      reference,
      provider: serviceID,
      meter,
      type,
      phone,
      amount,
      electricityValue,
      sparkleProfit,
      customerName,
      providerResponse: pd,
    });
  }

  if (failureStatus(ps)) {
    const refund = await walletAction(
      "failure",
      reference,
      amount,
      phone,
      { ...metadata, provider_response: pd, stage: "refunded" },
    );

    if (refund.error || !refund.data?.success) {
      return reply({
        success: false,
        status: "pending",
        reference,
        error:
          "Provider rejected the order, but the automatic refund needs reconciliation. Do not retry yet.",
      }, 202);
    }

    return reply({
      success: false,
      status: "refunded",
      reference,
      error: "Electricity purchase failed. Your wallet has been refunded.",
      providerResponse: pd,
    });
  }

  await walletAction(
    "pending",
    reference,
    amount,
    phone,
    { ...metadata, provider_response: pd, stage: "provider_pending" },
  );

  return reply({
    success: false,
    status: "pending",
    reference,
    error:
      "The provider has not confirmed the electricity order. Funds remain reserved; do not retry it.",
    providerResponse: pd,
  }, 202);
});
