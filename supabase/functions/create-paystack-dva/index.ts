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
        JSON.stringify({ error: "Not authenticated" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");

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
        JSON.stringify({ error: "Invalid session" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: existingAccount } = await supabase
      .from("paystack_dedicated_accounts")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingAccount?.account_number) {
      return new Response(
        JSON.stringify({
          success: true,
          account: existingAccount,
          message: "Dedicated account already exists",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("first_name, last_name, phone, email")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      throw new Error("Customer profile not found");
    }

    if (!profile.first_name || !profile.last_name || !profile.email) {
      throw new Error(
        "Please complete your name and email before requesting an account",
      );
    }

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
          phone: profile.phone || undefined,
        }),
      },
    );

    const customerResult = await customerResponse.json();

    if (!customerResponse.ok || !customerResult.status) {
      throw new Error(
        customerResult.message || "Unable to create Paystack customer",
      );
    }

    const customerCode = customerResult.data.customer_code;

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

    if (!dvaResponse.ok || !dvaResult.status) {
      throw new Error(
        dvaResult.message || "Unable to create dedicated account",
      );
    }

    const account = dvaResult.data;

    const { error: saveError } = await supabase
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
        `Account was created but could not be saved: ${saveError.message}`,
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        account: {
          account_name: account.account_name,
          account_number: account.account_number,
          bank_name: account.bank?.name || null,
        },
        message: "Dedicated account created successfully",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error
          ? error.message
          : "Something went wrong",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
