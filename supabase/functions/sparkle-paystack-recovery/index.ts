import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const paystackKey = Deno.env.get("PAYSTACK_SECRET_KEY");
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");

  if (!url || !serviceKey || !paystackKey || !token) {
    return reply({ error: "Missing server configuration or user session" }, 500);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || authData.user?.id !== "5e79aedb-7797-4346-b9a0-c8214e1a3be9") {
    return reply({ error: "Not authorized" }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }

  const action = body.action === "recover" ? "recover" : "inspect";
  const headers = { Authorization: `Bearer ${paystackKey}`, "Content-Type": "application/json" };

  try {
    const listUrl = "https://api.paystack.co/integration/webhooks/events?category=transactions&event_type=charge.success&limit=50";
    const listRes = await fetch(listUrl, { headers });
    const listJson = await listRes.json();
    if (!listRes.ok || !listJson.status) {
      console.error("Paystack webhook event list failed", listJson.message || listRes.status);
      return reply({ error: "Could not read Paystack webhook history", status: listRes.status, message: listJson.message || null }, 502);
    }

    const events = Array.isArray(listJson.data) ? listJson.data : [];
    const details = [];
    for (const item of events.slice(0, 25)) {
      const id = String(item._id || "");
      if (!id) continue;
      const detailRes = await fetch(`https://api.paystack.co/integration/webhooks/events/${encodeURIComponent(id)}`, { headers });
      const detailJson = await detailRes.json();
      const d = detailJson?.data || {};
      const payload = d.event_payload || {};
      const payment = payload.data || {};
      const channel = String(payment.channel || payment.authorization?.channel || "");
      details.push({
        id,
        event: d.event_name || item.event_name || payload.event || null,
        status: d.status || item.status || null,
        response_code: d.response_code ?? item.response_code ?? null,
        webhook_url: d.webhook_url || null,
        created_at: d.createdAt || item.createdAt || null,
        channel,
        reference: payment.reference || null,
        amount_kobo: Number.isFinite(Number(payment.amount)) ? Number(payment.amount) : null,
        account_last4: String(payment.authorization?.receiver_bank_account_number || payment.receiver_bank_account_number || "").slice(-4) || null,
        response_body: d.merchant_response_body ?? null,
      });
    }

    if (action === "inspect") {
      return reply({ success: true, action, count: details.length, events: details });
    }

    const accountRows = await admin.from("paystack_dedicated_accounts").select("account_number");
    if (accountRows.error) return reply({ error: "Could not read Sparkle dedicated accounts" }, 500);
    const accountNumbers = new Set((accountRows.data || []).map((x: any) => String(x.account_number || "").replace(/\s+/g, "")));

    const eligible = details.filter((e: any) =>
      ["Failed", "Pending"].includes(String(e.status)) &&
      e.event === "charge.success" &&
      e.channel === "dedicated_nuban" &&
      e.account_last4 &&
      [...accountNumbers].some(n => n.endsWith(e.account_last4))
    );

    if (eligible.length === 0) {
      return reply({ success: true, action, resent: 0, message: "No failed or pending dedicated-account events matching Sparkle accounts were found in the latest 25 events.", inspected: details.length });
    }

    const resendRes = await fetch("https://api.paystack.co/integration/webhooks/events/resend", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: eligible.map((e: any) => e.id) }),
    });
    const resendJson = await resendRes.json();
    if (!resendRes.ok || !resendJson.status) {
      console.error("Paystack webhook resend failed", resendJson.message || resendRes.status);
      return reply({ error: "Paystack did not accept webhook resend", status: resendRes.status, message: resendJson.message || null }, 502);
    }

    return reply({
      success: true,
      action,
      resent: Number(resendJson.data?.count || eligible.length),
      message: "Matching failed/pending dedicated-account events were queued for redelivery. Wallet credits remain idempotent by reference.",
      events: eligible.map((e: any) => ({ reference: e.reference, status: e.status, response_code: e.response_code, created_at: e.created_at })),
    });
  } catch (error) {
    console.error("Paystack recovery function failed", String(error));
    return reply({ error: "Paystack recovery request failed" }, 500);
  }
});