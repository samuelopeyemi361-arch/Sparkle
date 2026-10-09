
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async () => {
  const apiKey = Deno.env.get("FLEEXA_API_KEY");

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "FLEEXA_API_KEY secret missing" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const response = await fetch(
      "https://fleexa.com.ng/developer/balance",
      {
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
    return new Response(
      JSON.stringify({ error: "Could not reach Fleexa API" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
});
