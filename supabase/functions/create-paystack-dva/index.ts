import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY");

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
      return new Response(
        JSON.stringify({
          success: false,
          error: "PAYSTACK_SECRET_KEY is not configured",
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

    const body = await req.json();

    const email = String(body.email || "").trim();
    const name = String(body.name || "").trim();
    const phone = String(body.phone || "").trim();
    const preferredBank = String(
      body.preferred_bank || "wema-bank",
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

    const parts = name.split(/\s+/);
    const firstName = parts.shift() || "Sparkle";
    const lastName = parts.join(" ") || firstName;

    // 1. Create Paystack customer
    const customerResponse = await fetch(
      "https://api.paystack.co/customer",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          first_name: firstName,
          last_name: lastName,
          phone: phone || undefined,
        }),
      },
    );

    const customerData = await customerResponse.json();

    if (!customerResponse.ok || !customerData.status) {
      return new Response(
        JSON.stringify({
          success: false,
          stage: "customer",
          error:
            customerData.message || "Unable to create Paystack customer",
        }),
        {
          status: customerResponse.status || 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const customerCode = customerData.data.customer_code;

    // 2. Create dedicated virtual account
    const accountResponse = await fetch(
      "https://api.paystack.co/dedicated_account",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customer: customerCode,
          preferred_bank: preferredBank,
        }),
      },
    );

    const accountData = await accountResponse.json();

    if (!accountResponse.ok || !accountData.status) {
      return new Response(
        JSON.stringify({
          success: false,
          stage: "dedicated_account",
          error:
            accountData.message ||
            "Paystack could not create the dedicated account",
          customer_code: customerCode,
        }),
        {
          status: accountResponse.status || 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const account = accountData.data;

    return new Response(
      JSON.stringify({
        success: true,
        customer_code: customerCode,
        account_name: account.account_name,
        account_number: account.account_number,
        bank_name: account.bank?.name || "",
        bank_slug: account.bank?.slug || preferredBank,
        currency: account.currency || "NGN",
        message: "Dedicated virtual account created successfully",
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
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error
          ? error.message
          : "Unexpected server error",
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
