import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-paystack-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function verifySignature(
  body: string,
  signature: string,
  secret: string,
) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(body),
  );

  const expected = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return expected === signature;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const body = await req.text();

    const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");

    if (!paystackSecret) {
      throw new Error("PAYSTACK_SECRET_KEY is not configured");
    }

    const signature = req.headers.get("x-paystack-signature");

    if (!signature) {
      return new Response("Missing signature", {
        status: 401,
        headers: corsHeaders,
      });
    }

    const validSignature = await verifySignature(
      body,
      signature,
      paystackSecret,
    );

    if (!validSignature) {
      return new Response("Invalid signature", {
        status: 401,
        headers: corsHeaders,
      });
    }

    const event = JSON.parse(body);

    if (event.event !== "charge.success") {
      return new Response(
        JSON.stringify({
          received: true,
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const data = event.data;

    const reference = data.reference;
    const amount = Number(data.amount) / 100;

    if (!reference || amount <= 0) {
      throw new Error("Invalid payment data");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    
    // IMPORTANT:
    // This matches the secret name you created in Supabase.
    const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY");

    if (!supabaseUrl) {
      throw new Error("SUPABASE_URL is not configured");
    }

    if (!serviceRoleKey) {
      throw new Error("SERVICE_ROLE_KEY is not configured");
    }

    const supabase = createClient(
      supabaseUrl,
      serviceRoleKey,
    );

    // Prevent duplicate processing
    const { data: existingTransaction, error: existingError } =
      await supabase
        .from("wallet_transaction")
        .select("id")
        .eq("reference", reference)
        .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existingTransaction) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Transaction already processed",
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Get the Paystack dedicated account that received the money
    const accountNumber =
      data.authorization?.receiver_bank_account_number;

    if (!accountNumber) {
      throw new Error("Dedicated account number not found");
    }

    const { data: dedicatedAccount, error: accountError } =
      await supabase
        .from("paystack_dedicated_accounts")
        .select("user_id")
        .eq("account_number", accountNumber)
        .maybeSingle();

    if (accountError) {
      throw accountError;
    }

    if (!dedicatedAccount) {
      throw new Error(
        "Sparkle user for this account was not found",
      );
    }

    const userId = dedicatedAccount.user_id;

    // Get user's wallet
    const { data: wallet, error: walletError } =
      await supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", userId)
        .single();

    if (walletError || !wallet) {
      throw new Error("Wallet not found");
    }

    const currentBalance = Number(wallet.balance);
    const newBalance = currentBalance + amount;

    // Credit wallet
    const { error: updateError } =
      await supabase
        .from("wallets")
        .update({
          balance: newBalance,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);

    if (updateError) {
      throw updateError;
    }

    // Record transaction
    const { error: transactionError } =
      await supabase
        .from("wallet_transaction")
        .insert({
          user_id: userId,
          type: "deposit",
          amount: amount,
          service: "Paystack Wallet Funding",
          reference: reference,
          status: "success",
          metadata: {
            paystack_event: event.event,
            payment_channel: data.channel,
            currency: data.currency,
            paid_at: data.paid_at,
          },
        });

    if (transactionError) {
      throw transactionError;
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Wallet funded successfully",
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error(error);

    return new Response(
      JSON.stringify({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Webhook processing failed",
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
