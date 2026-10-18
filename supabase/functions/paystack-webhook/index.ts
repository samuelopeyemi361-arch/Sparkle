import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-paystack-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

async function verifySignature(body: string, signature: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(expected, signature.trim().toLowerCase());
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  try {
    const body = await req.text();
    const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackSecret) {
      console.error("PAYSTACK_SECRET_KEY is not configured");
      return reply({ error: "Webhook is not configured" }, 500);
    }

    const signature = req.headers.get("x-paystack-signature");
    if (!signature) return reply({ error: "Missing signature" }, 401);
    if (!await verifySignature(body, signature, paystackSecret)) {
      return reply({ error: "Invalid signature" }, 401);
    }

    let event: any;
    try {
      event = JSON.parse(body);
    } catch {
      return reply({ error: "Invalid JSON body" }, 400);
    }

    if (event?.event !== "charge.success") {
      return reply({ received: true, ignored: true });
    }

    const payment = event?.data;
    const reference = String(payment?.reference || "").trim();
    const amountKobo = Number(payment?.amount);
    const currency = String(payment?.currency || "").toUpperCase();
    const channel = String(payment?.channel || payment?.authorization?.channel || "");

    if (!reference || !Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
      return reply({ error: "Invalid payment data" }, 400);
    }
    if (currency !== "NGN") {
      return reply({ received: true, ignored: true, reason: "Unsupported currency" });
    }
    if (channel !== "dedicated_nuban") {
      return reply({ received: true, ignored: true, reason: "Not a dedicated-account transfer" });
    }

    const accountNumber = String(
      payment?.authorization?.receiver_bank_account_number ||
      payment?.receiver_bank_account_number ||
      "",
    ).replace(/\s+/g, "");
    if (!accountNumber) {
      console.error("Dedicated-account event has no receiver account number", reference);
      return reply({ error: "Dedicated account could not be identified" }, 500);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Supabase service configuration is missing");
      return reply({ error: "Wallet funding service is not configured" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: account, error: accountError } = await supabase
      .from("paystack_dedicated_accounts")
      .select("user_id")
      .eq("account_number", accountNumber)
      .maybeSingle();

    if (accountError) {
      console.error("Could not read dedicated-account mapping", accountError);
      return reply({ error: "Could not identify wallet owner" }, 500);
    }
    if (!account?.user_id) {
      console.error("No Sparkle user mapped to dedicated account", accountNumber.slice(-4));
      return reply({ error: "Wallet owner was not found" }, 500);
    }

    const grossAmount = amountKobo / 100;
    const metadata = {
      paystack_event: event.event,
      payment_channel: channel,
      currency,
      paid_at: payment?.paid_at || null,
      source: "paystack_webhook",
      paystack_status: payment?.status || null,
    };

    const { data: outcome, error: creditError } = await supabase.rpc(
      "process_paystack_wallet_funding",
      {
        p_user_id: account.user_id,
        p_reference: reference,
        p_gross_amount: grossAmount,
        p_metadata: metadata,
      },
    );

    if (creditError) {
      console.error("Atomic wallet funding RPC failed", reference, creditError);
      return reply({ error: "Wallet funding could not be completed; please retry" }, 500);
    }
    if (!outcome || typeof outcome !== "object") {
      console.error("Wallet funding RPC returned unexpected result", reference);
      return reply({ error: "Unexpected wallet funding response" }, 500);
    }
    if ((outcome as any).conflict) {
      console.error("Wallet funding reference conflict requires review", reference);
      return reply({ received: true, success: false, conflict: true, status: "reference_conflict" });
    }

    return reply({
      received: true,
      success: true,
      duplicate: Boolean((outcome as any).duplicate),
      status: (outcome as any).status || "processed",
      gross_amount: (outcome as any).gross_amount ?? grossAmount,
      fee_percent: (outcome as any).fee_percent ?? null,
      fee_amount: (outcome as any).fee_amount ?? null,
      net_amount: (outcome as any).net_amount ?? null,
      message: (outcome as any).duplicate
        ? "Payment was already processed; no second wallet credit was made."
        : "Wallet funded successfully.",
    });
  } catch (error) {
    console.error("Paystack webhook processing failed", error);
    return reply({ error: "Webhook processing failed" }, 500);
  }
});
