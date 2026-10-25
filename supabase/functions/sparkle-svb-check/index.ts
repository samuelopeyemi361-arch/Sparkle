import { createClient } from "npm:@supabase/supabase-js@2";

const BASE = "https://softviralboost.com.ng/api/v2";
const C = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const out = (x: unknown, s = 200) => new Response(JSON.stringify(x), {
  status: s, headers: { ...C, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

async function ctx(req: Request) {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("Authorization");
  if (!url || !anon || !key || !auth?.startsWith("Bearer ")) throw Error("Please sign in.");
  const u = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const r = await u.auth.getUser();
  if (r.error || !r.data.user) throw Error("Session expired.");
  return { user: r.data.user, admin: createClient(url, key, { auth: { persistSession: false } }) };
}

async function api(path: string) {
  const key = Deno.env.get("SOFTVIRALBOOST_API_KEY");
  if (!key) throw Error("SOFTVIRALBOOST_API_KEY secret missing.");
  const r = await fetch(BASE + path, {
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    signal: AbortSignal.timeout(20000)
  });
  return { r, d: await r.json().catch(() => null) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: C });
  if (req.method !== "POST") return out({ success: false, message: "POST required." }, 405);

  let c: any;
  try { c = await ctx(req); }
  catch (e) { return out({ success: false, message: e instanceof Error ? e.message : "Sign in required." }, 401); }

  const b = await req.json().catch(() => ({}));
  const id = String(b.request_id || "").trim();
  if (!id) return out({ success: false, message: "Order reference required." }, 400);

  const { data: o, error } = await c.admin.from("sparkle_sms_otp_orders").select("*")
    .eq("user_id", c.user.id).eq("request_id", id).maybeSingle();
  if (error) return out({ success: false, message: "Could not load order." }, 500);
  if (!o) return out({ success: false, message: "Order not found." }, 404);

  if (o.status === "success") return out({
    success: true, status: "success", request_id: id, phone_number: o.phone_number,
    sms_code: o.provider_response?.sms_code || null, message: "SMS code already received."
  });
  if (["failed", "cancelled", "expired"].includes(String(o.status).toLowerCase())) return out({
    success: false, status: o.status, request_id: id, refund_status: "processed",
    message: "Order is no longer active. Any eligible refund has already been recorded."
  });
  if (!o.provider_request_id) return out({
    success: false, status: "unknown", request_id: id,
    message: "Supplier order ID is not available yet. Do not buy again; contact support if this persists."
  }, 202);

  try {
    const x = await api("/order/" + encodeURIComponent(String(o.provider_request_id)) + "/poll");
    const d = x.d || {};
    const sms = String(d.sms_status || d.order_status || d.status_text || "").trim().toUpperCase();
    const code = String(d.sms_code || "");
    const phone = String(d.phone_number || o.phone_number || "");

    // Only terminal supplier statuses trigger an automatic wallet refund.
    // The database finalizer is idempotent, so repeat polling cannot refund twice.
    const terminal = new Map<string, string>([
      ["CANCELLED", "cancelled"], ["CANCELED", "cancelled"],
      ["FAILED", "failed"], ["FAILURE", "failed"],
      ["EXPIRED", "expired"], ["TIMEOUT", "expired"],
      ["REFUNDED", "cancelled"]
    ]);
    const finalStatus = terminal.get(sms);
    if (finalStatus) {
      const f = await c.admin.rpc("sparkle_finish_sms_otp", {
        p_request_id: id,
        p_status: finalStatus === "expired" ? "cancelled" : finalStatus,
        p_provider_response: d,
        p_error: "Supplier terminal status confirmed: " + sms
      });
      if (f.error || !f.data?.success) return out({
        success: false, status: "unknown", request_id: id,
        message: "Supplier reported " + sms + ", but Sparkle could not finalize the refund yet. Do not buy again; contact support."
      }, 202);
      await c.admin.from("sparkle_sms_otp_orders").update({
        provider_response: d, phone_number: phone, updated_at: new Date().toISOString()
      }).eq("user_id", c.user.id).eq("request_id", id);
      return out({
        success: false, status: finalStatus, request_id: id, phone_number: phone,
        refund_status: "processed", refund_amount: Number(o.amount),
        message: "Supplier confirmed " + sms.toLowerCase() + ". Sparkle has automatically recorded your wallet refund."
      });
    }

    if (!x.r.ok || d.status !== "success") {
      // Preserve the supplier response for diagnostics, but never refund an ambiguous response.
      await c.admin.from("sparkle_sms_otp_orders").update({
        provider_response: d, updated_at: new Date().toISOString()
      }).eq("user_id", c.user.id).eq("request_id", id);
      return out({
        success: false, status: "pending", request_id: id,
        message: String(d.message || "Supplier could not confirm the order status. Sparkle will not refund until the supplier confirms cancellation, failure, or expiry.")
      }, 202);
    }

    if (sms === "RECEIVED" && code) {
      const f = await c.admin.rpc("sparkle_finish_sms_otp", {
        p_request_id: id, p_status: "success", p_provider_response: d, p_error: null
      });
      if (f.error || !f.data?.success) return out({
        success: false, status: "unknown", request_id: id,
        message: "SMS received, but Sparkle could not finalize the order. Do not buy again; contact support."
      }, 202);
      await c.admin.from("sparkle_sms_otp_orders").update({
        provider_request_id: String(d.order_id || o.provider_request_id),
        phone_number: phone, provider_response: d, updated_at: new Date().toISOString()
      }).eq("user_id", c.user.id).eq("request_id", id);
      return out({
        success: true, status: "success", request_id: id, phone_number: phone,
        sms_code: code, sms_text: String(d.sms_text || ""), message: "SMS code received."
      });
    }

    await c.admin.from("sparkle_sms_otp_orders").update({
      provider_response: d, phone_number: phone, updated_at: new Date().toISOString()
    }).eq("user_id", c.user.id).eq("request_id", id);
    return out({
      success: true, status: String(d.sms_status || "pending").toLowerCase(),
      request_id: id, phone_number: phone, message: "No SMS code yet. Check again shortly."
    });
  } catch {
    return out({
      success: false, status: "pending", request_id: id,
      message: "Supplier could not be reached. Order remains unresolved; check again shortly."
    }, 202);
  }
});