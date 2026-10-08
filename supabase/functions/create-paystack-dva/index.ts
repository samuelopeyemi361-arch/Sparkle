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
      throw new Error("PAYSTACK_SECRET_KEY is missing");
    }

    const body = await req.json();

    const email = String(body.email || "").trim();
    const name = String(body.name || "").trim();
    const phone = String(body.phone || "").trim();

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

    const names = name.split(/\s+/);
    const firstName = names.shift() || "Sparkle";
    const lastName = names.join(" ") || "User";

    // Create Paystack customer
    const customerRes = await fetch(
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
          paystack_error: customer.message || customer,
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

    const customerCode = customer.data.customer_code;

    // Request dedicated account
    const accountRes = await fetch(
      "https://api.paystack.co/dedicated_account",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
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
          paystack_error: account.message || account,
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

    return new Response(
      JSON.stringify({
        success: true,
        account_number: data.account_number,
        account_name: data.account_name,
        bank_name: data.bank?.name || "Wema Bank",
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
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error
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
