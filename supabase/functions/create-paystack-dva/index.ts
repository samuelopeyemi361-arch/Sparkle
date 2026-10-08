import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!PAYSTACK_SECRET_KEY) {
      throw new Error("PAYSTACK_SECRET_KEY is missing");
    }

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      throw new Error("Supabase configuration is missing");
    }

    // Identify the logged-in Sparkle user
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      throw new Error("Authorization header is missing");
    }

    const userClient = createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY || "",
      {
        global: {
          headers: {
            Authorization: authHeader,
          },
        },
      },
    );

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Unable to identify Sparkle user");
    }

    // Admin client — bypasses RLS
    const adminClient = createClient(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
    );

    let body: Record<string, unknown> = {};

    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const email = String(
      body.email || user.email || "",
    ).trim();

    const name = String(
      body.name ||
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      user.email?.split("@")[0] ||
      "Sparkle User",
    ).trim();

    const phone = String(
      body.phone ||
      user.phone ||
      user.user_metadata?.phone ||
      "",
    ).trim();

    if (!email || !name) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Email and name are required",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    /*
     * FIRST:
     * Check whether Sparkle already saved a dedicated account
     * for this user.
     */
    const { data: existingAccount, error: existingError } =
      await adminClient
        .from("paystack_dedicated_accounts")
        .select(
          "account_number, account_name, bank_name, customer_code",
        )
        .eq("user_id", user.id)
        .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    // If the account already exists, return it.
    if (existingAccount?.account_number) {
      return new Response(
        JSON.stringify({
          success: true,

          // Top-level fields for Sparkle website
          account_number: existingAccount.account_number,
          account_name:
            existingAccount.account_name || name,
          bank_name:
            existingAccount.bank_name || "Wema Bank",

          // Also return account object
          account: {
            account_number:
              existingAccount.account_number,
            account_name:
              existingAccount.account_name || name,
            bank_name:
              existingAccount.bank_name || "Wema Bank",
          },

          customer_code:
            existingAccount.customer_code || null,
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

    /*
     * CREATE PAYSTACK CUSTOMER
     */
    const names = name.split(/\s+/);

    const firstName =
      names.shift() || "Sparkle";

    const lastName =
      names.join(" ") || "User";

    const customerRes = await fetch(
      "https://api.paystack.co/customer",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          first_name: firstName,
          last_name: lastName,
          ...(phone ? { phone } : {}),
        }),
      },
    );

    const customer = await customerRes.json();

    if (!customerRes.ok || !customer.status) {
      return new Response(
        JSON.stringify({
          success: false,
          stage: "customer_creation",
          paystack_status: customerRes.status,
          paystack_error:
            customer.message || customer,
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const customerCode =
      customer.data.customer_code;

    /*
     * CREATE WEMA DEDICATED ACCOUNT
     */
    const accountRes = await fetch(
      "https://api.paystack.co/dedicated_account",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customer: customerCode,
          preferred_bank: "wema-bank",
        }),
      },
    );

    const account = await accountRes.json();

    if (!accountRes.ok || !account.status) {
      return new Response(
        JSON.stringify({
          success: false,
          stage: "dedicated_account_creation",
          paystack_status: accountRes.status,
          paystack_error:
            account.message || account,
          customer_code: customerCode,
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const data = account.data;

    /*
     * SAVE ACCOUNT TO SPARKLE
     */
    const { error: saveError } =
      await adminClient
        .from("paystack_dedicated_accounts")
        .insert({
          user_id: user.id,
          account_number: data.account_number,
          account_name: data.account_name,
          bank_name:
            data.bank?.name || "Wema Bank",
          customer_code: customerCode,
        });

    if (saveError) {
      throw saveError;
    }

    /*
     * RETURN ACCOUNT
     *
     * Both top-level fields and account object are
     * returned so the current Sparkle website can
     * display the account.
     */
    return new Response(
      JSON.stringify({
        success: true,

        account_number: data.account_number,
        account_name: data.account_name,
        bank_name:
          data.bank?.name || "Wema Bank",

        account: {
          account_number: data.account_number,
          account_name: data.account_name,
          bank_name:
            data.bank?.name || "Wema Bank",
        },

        customer_code: customerCode,
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
            : String(error),
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
