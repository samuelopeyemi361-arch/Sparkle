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

const AIRTIME_SERVICES = [
  "mtn",
  "airtel",
  "glo",
  "etisalat",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders,
  });
}

function normalizeNetwork(value: unknown): string {
  const network = String(value || "")
    .trim()
    .toLowerCase();

  const networks: Record<string, string> = {
    mtn: "mtn",
    airtel: "airtel",
    glo: "glo",
    "9mobile": "etisalat",
    etisalat: "etisalat",
    t2: "etisalat",
  };

  return networks[network] || network;
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", {
        headers: corsHeaders,
      });
    }

    const url = new URL(req.url);

    /*
     * GET PLANS
     *
     * Supports:
     * ?service=mtn_sme
     * ?action=plans&service=mtn_sme
     */
    if (req.method === "GET") {
      const action =
        url.searchParams.get("action") || "plans";

      if (action === "services") {
        return json({
          success: true,
          services: [
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
            {
              serviceID: "mtn_fibrex",
              network: "MTN",
              type: "Fibre X",
            },
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
              serviceID: "etisalat_data",
              network: "9mobile",
              type: "Data",
            },
          ],
        });
      }

      const service =
        url.searchParams.get("service") ||
        url.searchParams.get("serviceID") ||
        "";

      if (!service) {
        return json(
          {
            success: false,
            error: "Missing service",
          },
          400,
        );
      }

      const providerResponse = await fetch(
        `${GSUBZ_BASE}/api/plans/?service=${encodeURIComponent(service)}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        },
      );

      const data = await providerResponse.json();

      return json(
        {
          success: providerResponse.ok,
          service,
          data,
        },
        providerResponse.status,
      );
    }

    /*
     * POST REQUESTS
     */
    if (req.method === "POST") {
      const apiKey =
        Deno.env.get("GSUBZ_API_KEY");

      if (!apiKey) {
        return json(
          {
            success: false,
            error: "GSUBZ_API_KEY is missing",
          },
          500,
        );
      }

      let body: Record<string, unknown>;

      try {
        body = await req.json();
      } catch {
        return json(
          {
            success: false,
            error: "Invalid JSON request body",
          },
          400,
        );
      }

      /*
       * BALANCE
       */
      const action = String(
        body.action || "",
      ).toLowerCase();

      if (action === "balance") {
        const form = new FormData();
        form.append("api", apiKey);

        const providerResponse = await fetch(
          `${GSUBZ_BASE}/api/balance/`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: form,
          },
        );

        const data =
          await providerResponse.json();

        return json(
          {
            success: providerResponse.ok,
            data,
          },
          providerResponse.status,
        );
      }

      /*
       * ACCEPT DIFFERENT FIELD NAMES
       * FROM THE EXISTING SPARKLE FRONTEND.
       */
      let serviceID = String(
        body.serviceID ||
        body.service ||
        "",
      ).trim();

      const network = normalizeNetwork(
        body.network ||
        body.provider ||
        body.operator ||
        serviceID,
      );

      /*
       * If Sparkle sends:
       * network = MTN
       * instead of serviceID = mtn
       */
      if (
        !serviceID ||
        !AIRTIME_SERVICES.includes(serviceID)
      ) {
        if (AIRTIME_SERVICES.includes(network)) {
          serviceID = network;
        }
      }

      const phone = String(
        body.phone ||
        body.phoneNumber ||
        body.mobile ||
        "",
      ).trim();

      const amount = String(
        body.amount ||
        body.price ||
        "",
      ).trim();

      const plan = String(
        body.plan ||
        body.planValue ||
        body.value ||
        body.variation_code ||
        "",
      ).trim();

      const requestID = String(
        body.requestID ||
        body.requestId ||
        body.reference ||
        "",
      ).trim();

      /*
       * AIRTIME
       */
      if (AIRTIME_SERVICES.includes(serviceID)) {
        if (!phone || !amount) {
          return json(
            {
              success: false,
              error: "Missing airtime fields",
              message:
                "Airtime requires phone and amount.",
            },
            400,
          );
        }

        const numericAmount =
          Number(amount);

        if (
          !Number.isFinite(numericAmount) ||
          numericAmount < 100
        ) {
          return json(
            {
              success: false,
              error: "Invalid airtime amount",
              message:
                "Airtime amount must be at least ₦100.",
            },
            400,
          );
        }

        const form = new FormData();

        form.append(
          "serviceID",
          serviceID,
        );

        form.append(
          "api",
          apiKey,
        );

        form.append(
          "amount",
          amount,
        );

        form.append(
          "phone",
          phone,
        );

        if (requestID) {
          form.append(
            "requestID",
            requestID,
          );
        }

        const providerResponse =
          await fetch(
            `${GSUBZ_BASE}/api/pay/`,
            {
              method: "POST",
              headers: {
                Authorization:
                  `Bearer ${apiKey}`,
              },
              body: form,
            },
          );

        const data =
          await providerResponse.json();

        return json(
          {
            success: providerResponse.ok,
            type: "airtime",
            serviceID,
            data,
          },
          providerResponse.status,
        );
      }

      /*
       * DATA
       */
      if (DATA_SERVICES.includes(serviceID)) {
        if (!phone || !plan) {
          return json(
            {
              success: false,
              error: "Missing data fields",
              message:
                "Data requires phone and plan.",
            },
            400,
          );
        }

        const form = new FormData();

        form.append(
          "serviceID",
          serviceID,
        );

        form.append(
          "plan",
          plan,
        );

        form.append(
          "api",
          apiKey,
        );

        /*
         * GSUBZ requires amount to be
         * an empty string for data.
         */
        form.append(
          "amount",
          "",
        );

        form.append(
          "phone",
          phone,
        );

        if (requestID) {
          form.append(
            "requestID",
            requestID,
          );
        }

        const providerResponse =
          await fetch(
            `${GSUBZ_BASE}/api/pay/`,
            {
              method: "POST",
              headers: {
                Authorization:
                  `Bearer ${apiKey}`,
              },
              body: form,
            },
          );

        const data =
          await providerResponse.json();

        return json(
          {
            success: providerResponse.ok,
            type: "data",
            serviceID,
            data,
          },
          providerResponse.status,
        );
      }

      /*
       * UNKNOWN SERVICE
       */
      return json(
        {
          success: false,
          error: "Unsupported service",
          serviceID,
          network,
          supportedAirtime:
            AIRTIME_SERVICES,
          supportedData:
            DATA_SERVICES,
        },
        400,
      );
    }

    return json(
      {
        success: false,
        error: "Method not allowed",
      },
      405,
    );
  } catch (error) {
    return json(
      {
        success: false,
        error: "Internal server error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
      500,
    );
  }
});
