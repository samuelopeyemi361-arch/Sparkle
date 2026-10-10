
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async () => {
  const apiKey = Deno.env.get("FLEEXA_API_KEY");

  if (!apiKey) {
    return Response.json(
      { error: "FLEEXA_API_KEY secret missing" },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(
      "https://fleexa.com.ng/developer/sms4/apps",
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Accept": "application/json"
        }
      }
    );

    const result = await response.text();

    return new Response(result, {
      status: response.status,
      headers: { "Content-Type": "application/json" }
    });
  } catch {
    return Response.json(
      { error: "Could not reach Fleexa API" },
      { status: 502 }
    );
  }
});
