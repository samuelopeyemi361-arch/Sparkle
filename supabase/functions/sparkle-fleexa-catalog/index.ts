
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: corsHeaders }
    );
  }

  const apiKey = Deno.env.get("FLEEXA_API_KEY");

  if (!apiKey) {
    return Response.json(
      { error: "FLEEXA_API_KEY secret missing" },
      { status: 500, headers: corsHeaders }
    );
  }

  let action = "countries";
  let serviceName = "";

  if (req.method === "GET") {
    const url = new URL(req.url);
    action = url.searchParams.get("action") || "countries";
    serviceName = url.searchParams.get("serviceName") || "";
  } else {
    try {
      const body = await req.json();
      action = body.action || "countries";
      serviceName = body.serviceName || "";
    } catch {
      return Response.json(
        { error: "Invalid JSON request body" },
        { status: 400, headers: corsHeaders }
      );
    }
  }

  let endpoint: string;

  if (action === "countries") {
    endpoint = "/sms4/countries";
  } else if (action === "apps") {
    endpoint = "/sms4/apps";
  } else if (action === "price") {
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(serviceName)) {
      return Response.json(
        { error: "Invalid serviceName" },
        { status: 400, headers: corsHeaders }
      );
    }

    endpoint =
      "/sms4/prices?serviceName=" + encodeURIComponent(serviceName);
  } else {
    return Response.json(
      { error: "Action must be countries, apps, or price" },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    const response = await fetch(
      "https://fleexa.com.ng/developer" + endpoint,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    const result = await response.text();

    return new Response(result, {
      status: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "Could not reach Fleexa API" },
      { status: 502, headers: corsHeaders }
    );
  }
});
