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

    // Paystack requires a phone number, full name and email for a DVA.
    // Keep an existing saved DVA available even if an older profile lacks phone.
    if (!phone) {
      return new Response(JSON.stringify({
        success: false,
        stage: "customer_details",
        error: "Add your phone number in Profile before creating your dedicated funding account.",
      }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Reuse a Paystack customer created by an earlier attempt. This matters
    // when customer creation succeeded but Wema account assignment returned 400.
    const authorization = `Bearer ${PAYSTACK_SECRET_KEY}`;
    const lookupPaystackCustomer = async () => {
      try {
        const lookupRes = await fetch(
          `https://api.paystack.co/customer/${encodeURIComponent(email)}`,
          { method: "GET", headers: { Authorization: authorization }, signal: AbortSignal.timeout(15000) },
        );
        const lookup = await lookupRes.json().catch(() => null);
        if (lookupRes.ok && lookup?.status === true && lookup?.data?.customer_code) {
          return lookup.data;
        }
      } catch (lookupError) {
        console.error("[create-paystack-dva] customer lookup failed", {
          message: lookupError instanceof Error ? lookupError.message.slice(0, 160) : "Lookup failed",
        });
      }
      return null;
    };

    let customerData = await lookupPaystackCustomer();
    if (!customerData) {
      const customerRes = await fetch("https://api.paystack.co/customer", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          first_name: firstName,
          last_name: lastName,
          phone,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const customer = await customerRes.json().catch(() => null);

      if (customerRes.ok && customer?.status === true && customer?.data?.customer_code) {
        customerData = customer.data;
      } else {
        // A concurrent/previous request may have created the customer just
        // before Paystack returned a duplicate-customer response.
        customerData = await lookupPaystackCustomer();
        if (!customerData) {
          const providerMessage = String(customer?.message || "Paystack could not create this customer.").slice(0, 280);
          console.error("[create-paystack-dva] Paystack customer creation failed", {
            stage: "customer_creation",
            status: customerRes.status,
            message: providerMessage,
          });
          return new Response(JSON.stringify({
            success: false,
            stage: "customer_creation",
            paystack_status: customerRes.status,
            paystack_error: providerMessage,
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    const customerCode = customerData.customer_code;
    if (!customerCode) {
      return new Response(JSON.stringify({
        success: false,
        stage: "customer_lookup",
        error: "Paystack did not return a customer reference. Please retry from Fund Wallet.",
      }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // A previous DVA request may have succeeded even when Sparkle did not
    // save its response. Recover the dedicated account from the customer.
    let accountData = customerData.dedicated_account?.account_number
      && customerData.dedicated_account?.active !== false
      && customerData.dedicated_account?.assigned !== false
      ? customerData.dedicated_account
      : null;

    if (!accountData) {
      const accountRes = await fetch("https://api.paystack.co/dedicated_account", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customer: customerCode,
          preferred_bank: "wema-bank",
          phone,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const account = await accountRes.json().catch(() => null);

      if (accountRes.ok && account?.status === true && account?.data?.account_number) {
        accountData = account.data;
      } else {
        // Fetch once after a failed assignment: Paystack may have assigned the
        // DVA but returned an error/duplicate response to this retry.
        const refreshedCustomer = await lookupPaystackCustomer();
        accountData = refreshedCustomer?.dedicated_account?.account_number
          && refreshedCustomer?.dedicated_account?.active !== false
          && refreshedCustomer?.dedicated_account?.assigned !== false
          ? refreshedCustomer.dedicated_account
          : null;
        if (!accountData) {
          const providerMessage = String(account?.message || "Paystack could not assign a Wema funding account.").slice(0, 280);
          console.error("[create-paystack-dva] Paystack DVA assignment failed", {
            stage: "dedicated_account_creation",
            status: accountRes.status,
            message: providerMessage,
          });
          return new Response(JSON.stringify({
            success: false,
            stage: "dedicated_account_creation",
            paystack_status: accountRes.status,
            paystack_error: providerMessage,
            customer_code: customerCode,
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    const data = accountData;

    /*
     * SAVE ACCOUNT TO SPARKLE
     */
    const { error: saveError } =
      await adminClient
        .from("paystack_dedicated_accounts")
        .upsert({
          user_id: user.id,
          account_number: data.account_number,
          account_name: data.account_name,
          bank_name: data.bank?.name || "Wema Bank",
          customer_code: customerCode,
        }, { onConflict: "user_id" });

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
