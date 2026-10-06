import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GSUBZ_BASE = "https://api.gsubz.com";

const SERVICES = [
  "airtel_gifting",
  "airtel_sme",
  "etisalat_data",
  "glo_data",
  "glo_sme",
  "mtn_fibrex",
  "mtn_gifting",
  "mtn_sme",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders,
  });
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    const url = new URL(req.url);

    /*
     * Accept:
     * ?service=mtn_sme
     * ?action=plans&service=mtn_sme
     */
    const service =
      url.searchParams.get("service") ||
      url.searchParams.get("serviceID") ||
      "";

    const action = url.searchParams.get("action") || "";

    /*
     * Return supported services
     */
    if (action === "services") {
      return response({
        success: true,
        services: [
          {
            serviceID: "airtel_gifting",
            network: "Airtel",
            type: "Gifting",
          },
          {
            serviceID: "airtel_sme",
            network: "Airtel",
            type: "SME",
          },
          {
            serviceID: "etisalat_data",
            network: "9mobile",
            type: "Data",
          },
          {
            serviceID: "glo_data",
            network: "Glo",
            type: "Corporate Gifting",
          },
          {
            serviceID: "glo_sme",
            network: "Glo",
            type: "SME",
          },
          {
            serviceID: "mtn_fibrex",
            network: "MTN",
            type: "Fibre X",
          },
          {
            serviceID: "mtn_gifting",
            network: "MTN",
            type: "Gifting",
          },
          {
            serviceID: "mtn_sme",
            network: "MTN",
            type: "SME",
          },
        ],
      });
    }

    /*
     * GET DATA PLANS
     *
     * Works with both:
     * /gsubz?service=mtn_sme
     *
     * and:
     * /gsubz?action=plans&service=mtn_sme
     */
    if (req.method === "GET") {
      if (!service) {
        return response(
          {
            success: false,
            error: "Missing service",
            message: "A data service is required.",
          },
          400
        );
      }

      if (!SERVICES.includes(service)) {
        return response(
          {
            success: false,
            error: "Invalid service",
            service,
          },
          400
        );
      }

      const providerResponse = await fetch(
        `${GSUBZ_BASE}/api/plans/?service=${encodeURIComponent(service)}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        }
      );

      const data = await providerResponse.json();

      return response(
        {
          success: providerResponse.ok,
          service,
          data,
        },
        providerResponse.status
      );
    }

    /*
     * BALANCE
     */
    if (req.method === "POST" && action === "balance") {
      const apiKey = Deno.env.get("GSUBZ_API_KEY");

      if (!apiKey) {
        return response(
          {
            success: false,
            error: "GSUBZ_API_KEY is missing",
          },
          500
        );
      }

      const formData = new FormData();
      formData.append("api", apiKey);

      const providerResponse = await fetch(
        `${GSUBZ_BASE}/api/balance/`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: formData,
        }
      );

      const data = await providerResponse.json();

      return response(
        {
          success: providerResponse.ok,
          data,
        },
        providerResponse.status
      );
    }

    /*
     * DATA PURCHASE
     */
    if (req.method === "POST") {
      const apiKey = Deno.env.get("GSUBZ_API_KEY");

      if (!apiKey) {
        return response(
          {
            success: false,
            error: "GSUBZ_API_KEY is missing",
          },
          500
        );
      }

      const body = await req.json();

      const serviceID = String(
        body.serviceID || body.service || ""
      ).trim();

      const plan = String(body.plan || "").trim();
      const phone = String(
        body.phone || body.phoneNumber || ""
      ).trim();

      if (!serviceID || !plan || !phone) {
        return response(
          {
            success: false,
            error: "Missing required fields",
            required: ["serviceID", "plan", "phone"],
          },
          400
        );
      }

      if (!SERVICES.includes(serviceID)) {
        return response(
          {
            success: false,
            error: "Invalid service",
          },
          400
        );
      }

      const formData = new FormData();

      formData.append("serviceID", serviceID);
      formData.append("plan", plan);
      formData.append("phone", phone);
      formData.append("api", apiKey);

      if (body.requestID) {
        formData.append(
          "requestID",
          String(body.requestID)
        );
      }

      const providerResponse = await fetch(
        `${GSUBZ_BASE}/api/pay/`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: formData,
        }
      );

      const data = await providerResponse.json();

      return response(
        {
          success: providerResponse.ok,
          data,
        },
        providerResponse.status
      );
    }

    return response(
      {
        success: false,
        error: "Unsupported request",
      },
      400
    );
  } catch (error) {
    return response(
      {
        success: false,
        error: "Internal server error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
      500
    );
  }
});
