
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return Response.json(
      { error: "GET requests only" },
      { status: 405, headers: corsHeaders }
    );
  }

  const apiKey = Deno.env.get("FLEEXA_API_KEY");

  if (!apiKey) {
    return Response.json(
      { error: "Fleexa API key is missing" },
      { status: 500, headers: corsHeaders }
    );
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "countries";

  const endpoints: Record<string, string> = {
    countries: "/sms4/countries",
    apps: "/sms4/apps",
  };

  let endpoint = endpoints[action];

  if (action === "price") {
    const serviceName = url.searchParams.get("serviceName") || "";

    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(serviceName)) {
      return Response.json(
        { error: "Invalid service name" },
        { status: 400, headers: corsHeaders }
      );
    }

    endpoint =
      "/sms4/prices?serviceName=" + encodeURIComponent(serviceName);
  }

  if (!endpoint) {
    return Response.json(
      { error: "Use action=countries, apps, or price" },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    const response = await fetch(
      "https://fleexa.com.ng/developer" + endpoint,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "Fleexa API is temporarily unavailable" },
      { status: 502, headers: corsHeaders }
    );
  }
});
