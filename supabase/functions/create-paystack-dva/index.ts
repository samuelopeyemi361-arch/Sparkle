// Sparkle — Supabase Edge Function
// Creates a dedicated Moniepoint virtual account through Topify.
// NO BVN/NIN is collected or sent.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TOPIFY_URL = "https://apipay.topify.ng";
const MONIEPOINT_CODE = "30901";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(
      { status: false, message: "POST requests only." },
      405
    );
  }

  try {
    const topifySecret = Deno.env.get("TOPIFY_SECRET_KEY");
    const businessId =
      Deno.env.get("TOPIFY_BUSINESS_ID") ||
      "TPYBIZLHBUMTIECF2";

    if (!topifySecret) {
      return json(
        {
          status: false,
          message: "TOPIFY_SECRET_KEY is not configured.",
        },
        500
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      return json(
        {
          status: false,
          message: "Supabase environment is not configured.",
        },
        500
      );
    }

    // Only logged-in Sparkle users can create a wallet account.
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return json(
        {
          status: false,
          message: "You must be logged in.",
        },
        401
      );
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
      }
    );

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return json(
        {
          status: false,
          message: "Invalid or expired login session.",
        },
        401
      );
    }

    const body = await req.json();

    // We intentionally accept NO BVN or NIN.
    const email = String(
      body.email || user.email || ""
    ).trim();

    const name = String(
      body.name || ""
    ).trim();

    const phoneNumber = String(
      body.phoneNumber || ""
    ).trim();

    if (!email || !name || !phoneNumber) {
      return json(
        {
          status: false,
          message:
            "email, name and phoneNumber are required.",
        },
        400
      );
    }

    const normalizedPhone =
      phoneNumber.replace(/\s+/g, "");

    if (!/^(\+234|234|0)\d{10}$/.test(normalizedPhone)) {
      return json(
        {
          status: false,
          message:
            "Enter a valid Nigerian phone number.",
        },
        400
      );
    }

    // IMPORTANT:
    // Only Moniepoint (30901) is requested.
    // PalmPay (20946) is NOT included.
    // Therefore BVN/NIN is NOT sent.
    const payload = {
      email: email,
      name: name,
      phoneNumber: normalizedPhone,
      bankCode: [MONIEPOINT_CODE],
      businessId: businessId,
    };

    const response = await fetch(
      `${TOPIFY_URL}/api/v1/virtual-accounts/reserve`,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${topifySecret}`,
          "Content-Type":
            "application/json",
          Accept:
            "application/json",
        },

        body: JSON.stringify(payload),
      }
    );

    const result = await response.json();

    if (!response.ok || result?.status === false) {
      return json(
        {
          status: false,
          message:
            result?.message ||
            "Topify could not create the account.",
          errors:
            result?.errors || null,
        },
        response.status || 502
      );
    }

    const accounts =
      Array.isArray(result?.data?.accounts)
        ? result.data.accounts
        : [];

    const account =
      accounts.find(
        (item: any) =>
          String(item?.provider || "")
            .toLowerCase()
            .includes("moniepoint")
      ) || accounts[0];

    return json({
      status: true,

      message:
        "Sparkle wallet account created successfully.",

      data: {
        customer_code:
          result?.data?.customer
            ?.customer_code || null,

        account_number:
          account?.account_number || null,

        account_name:
          account?.account_name || null,

        bank_name:
          account?.bank_name ||
          "Moniepoint",

        provider:
          account?.provider ||
          "moniepoint",
      },
    });

  } catch (error) {
    console.error(
      "Sparkle Topify error:",
      error
    );

    return json(
      {
        status: false,
        message:
          "Unable to create the wallet account right now.",
      },
      500
    );
  }
});

function json(
  data: unknown,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type":
          "application/json",
      },
    }
  );
}
