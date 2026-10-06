import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GSUBZ_BASE = "https://api.gsubz.com";

const DATA_SERVICES = [
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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders,
  });
}

function getService(url: URL) {
  return url.searchParams.get("service")?.trim() || "";
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "plans";

    /*
     * GET /gsubz?action=services
     * Returns all supported Sparkle data services.
     */
    if (req.method === "GET" && action === "services") {
      return json({
        success: true,
        services: [
          {
            serviceID: "airtel_gifting",
            network: "Airtel",
            type: "Gifting",
            name: "Airtel Gifting Data",
          },
          {
            serviceID: "airtel_sme",
            network: "Airtel",
            type: "SME",
            name: "Airtel SME Data",
          },
          {
            serviceID: "etisalat_data",
            network: "9mobile",
            type: "Data",
            name: "9mobile / T2 Data",
          },
          {
            serviceID: "glo_data",
            network: "Glo",
            type: "Corporate Gifting",
            name: "Glo Corporate Gifting Data",
          },
          {
            serviceID: "glo_sme",
            network: "Glo",
            type: "SME",
            name: "Glo SME Data",
          },
          {
            serviceID: "mtn_fibrex",
            network: "MTN",
            type: "Fibre X",
            name: "MTN Fibre X (WiFi)",
          },
          {
            serviceID: "mtn_gifting",
            network: "MTN",
            type: "Gifting",
            name: "MTN Gifting Data",
          },
          {
            serviceID: "mtn_sme",
            network: "MTN",
            type: "SME",
            name: "MTN SME Data",
          },
        ],
      });
    }

    /*
     * GET /gsubz?action=plans&service=mtn_sme
     *
     * GSUBZ plans are public, so the API key is NOT exposed here.
     */
    if (req.method === "GET" && action === "plans") {
      const service = getService(url);

      if (!service) {
        return json(
          {
            success: false,
            error: "Missing service",
            message: "Please provide a service ID.",
          },
          400
        );
      }

      if (!DATA_SERVICES.includes(service)) {
        return json(
          {
            success: false,
            error: "Invalid service",
            message: "This service is not supported by Sparkle.",
          },
          400
        );
      }

      const response = await fetch(
        `${GSUBZ_BASE}/api/plans/?service=${encodeURIComponent(service)}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        }
      );

      const result = await response.json();

      if (!response.ok) {
        return json(
          {
            success: false,
            error: "GSUBZ plan request failed",
            providerStatus: response.status,
            providerResponse: result,
          },
          response.status
        );
      }

      return json({
        success: true,
        service,
        data: result,
      });
    }

    /*
     * POST /gsubz?action=balance
     *
     * Your GSUBZ API key stays inside Supabase.
     */
    if (req.method === "POST" && action === "balance") {
      const apiKey = Deno.env.get("GSUBZ_API_KEY");

      if (!apiKey) {
        return json(
          {
            success: false,
            error: "GSUBZ_API_KEY is missing",
          },
          500
        );
      }

      const formData = new FormData();
      formData.append("api", apiKey);

      const response = await fetch(`${GSUBZ_BASE}/api/balance/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      const result = await response.json();

      return json(
        {
          success: response.ok,
          data: result,
        },
        response.status
      );
    }

    /*
     * POST /gsubz?action=buy-data
     *
     * This is ready for the Sparkle Data purchase flow.
     */
    if (req.method === "POST" && action === "buy-data") {
      const apiKey = Deno.env.get("GSUBZ_API_KEY");

      if (!apiKey) {
        return json(
          {
            success: false,
            error: "GSUBZ_API_KEY is missing",
          },
          500
        );
      }

      const body = await req.json();

      const serviceID = String(body.serviceID || "").trim();
      const plan = String(body.plan || "").trim();
      const phone = String(body.phone || "").trim();
      const requestID = String(body.requestID || "").trim();

      if (!serviceID || !plan || !phone) {
        return json(
          {
            success: false,
            error: "Missing required fields",
            message: "serviceID, plan and phone are required.",
          },
          400
        );
      }

      if (!DATA_SERVICES.includes(serviceID)) {
        return json(
          {
            success: false,
            error: "Invalid data service",
          },
          400
        );
      }

      const formData = new FormData();

      formData.append("serviceID", serviceID);
      formData.append("plan", plan);
      formData.append("api", apiKey);
      formData.append("amount", "");
      formData.append("phone", phone);

      if (requestID) {
        formData.append("requestID", requestID);
      }

      const response = await fetch(`${GSUBZ_BASE}/api/pay/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      const result = await response.json();

      return json(
        {
          success: response.ok,
          data: result,
        },
        response.status
      );
    }

    return json(
      {
        success: false,
        error: "Invalid request",
        message:
          "Use action=services, action=plans, action=balance or action=buy-data.",
      },
      400
    );
  } catch (error) {
    return json(
      {
        success: false,
        error: "Server error",
        message:
          error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});
