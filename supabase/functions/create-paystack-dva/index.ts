import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Not authenticated",
        }),
        {
          status: 401,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("Supabase configuration is missing");
    }

    if (!paystackSecret) {
      throw new Error("PAYSTACK_SECRET_KEY is not configured");
    }

    const supabase = createClient(
      supabaseUrl,
      supabaseAnonKey,
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
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid session",
        }),
        {
          status: 401,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Check whether this user already has a DVA
    const { data: existingAccount, error: existingError } =
      await supabase
        .from("paystack_dedicated_accounts")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

    if (existingError) {
      throw new Error(
        `Could not check existing account: ${existingError.message}`,
      );
    }

    if (existingAccount?.account_number) {
      return new Response(
        JSON.stringify({
          success: true,
          account: existingAccount,
          message: "Dedicated account already exists",
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

    // Get Sparkle user's profile
    const { data: profile, error: profileError } =
      await supabase
        .from("profiles")
        .select("first_name, last_name, phone, email")
        .eq("id", user.id)
        .single();

    if (profileError || !profile) {
      throw new Error(
        `Customer profile not found: ${
          profileError?.message || "No profile record"
        }`,
      );
    }

    if (
      !profile.first_name ||
      !profile.last_name ||
      !profile.email ||
      !profile.phone
    ) {
      throw new Error(
        "Please complete your first name, last name, phone number and email before requesting a funding account.",
      );
    }

    // ---------------------------------------------------------
    // STEP 1: Create Paystack customer
    // ---------------------------------------------------------

    const customerResponse = await fetch(
      "https://api.paystack.co/customer",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paystackSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: profile.email,
          first_name: profile.first_name,
          last_name: profile.last_name,
          phone: profile.phone,
        }),
      },
    );

    const customerResult = await customerResponse.json();

    if (!customerResponse.ok || !customerResult.status) {
      console.error("PAYSTACK CUSTOMER ERROR:", customerResult);

      throw new Error(
        `Paystack customer error: ${
          customerResult.message || "Unable to create customer"
        }`,
      );
    }

    const customerCode = customerResult.data.customer_code;

    // ---------------------------------------------------------
    // STEP 2: Create Dedicated Virtual Account
    // ---------------------------------------------------------

    const dvaResponse = await fetch(
      "https://api.paystack.co/dedicated_account",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paystackSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customer: customerCode,
          preferred_bank: "wema-bank",
        }),
      },
    );

    const dvaResult = await dvaResponse.json();

    console.log("PAYSTACK DVA RESPONSE:", dvaResult);

    if (!dvaResponse.ok || !dvaResult.status) {
      throw new Error(
        `Paystack DVA error: ${
          dvaResult.message || "Unable to create dedicated account"
        }`,
      );
    }

    const account = dvaResult.data;

    if (!account?.account_number) {
      throw new Error(
        `Paystack did not return an account number. Response: ${JSON.stringify(
          dvaResult,
        )}`,
      );
    }

    // ---------------------------------------------------------
    // STEP 3: Save DVA in Sparkle
    // ---------------------------------------------------------

    const { error: saveError } =
      await supabase
        .from("paystack_dedicated_accounts")
        .insert({
          user_id: user.id,
          customer_code: customerCode,
          account_name: account.account_name,
          account_number: account.account_number,
          bank_name: account.bank?.name || null,
          bank_slug: account.bank?.slug || null,
        });

    if (saveError) {
      throw new Error(
        `Paystack created the account, but Sparkle could not save it: ${saveError.message}`,
      );
    }

    // ---------------------------------------------------------
    // SUCCESS
    // ---------------------------------------------------------

    return new Response(
      JSON.stringify({
        success: true,
        account: {
          account_name: account.account_name,
          account_number: account.account_number,
          bank_name: account.bank?.name || null,
          bank_slug: account.bank?.slug || null,
        },
        message: "Dedicated funding account created successfully",
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
    console.error("CREATE DVA ERROR:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Something went wrong while creating the funding account",
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
