import { createClient } from "npm:@supabase/supabase-js@2";

type Obj = Record<string, any>;
const BASE = "https://5sim.net/v1";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const services: Record<string, string> = {
  whatsapp: "WhatsApp",
  google: "Google / YouTube",
  instagram: "Instagram",
  telegram: "Telegram",
};
const profileByServer: Record<string, { markup: number; label: string }> = {
  server1: { markup: 75, label: "Server 1 · USA & Canada" },
  server2: { markup: 60, label: "Server 2 · Standard Number" },
  server3: { markup: 10, label: "Server 3 · USA WhatsApp" },
};
let fxCache: { rate: number; updatedAt: number } | null = null;

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function problem(message: string, status = 503, code = "NUMBER_UNAVAILABLE"): Error & { status?: number; code?: string } {
  const e: any = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : String(v ?? "").trim();
}
function providerCountry(country: string): string {
  if (country === "us") return "usa";
  if (country === "ca") return "canada";
  throw problem("Choose a supported country.", 400, "INVALID_COUNTRY");
}
function validateRoute(serverId: string, country: string, service: string): { markup: number; label: string } {
  const profile = profileByServer[serverId];
  if (!profile) throw problem("Choose a valid number server.", 400, "INVALID_SERVER");
  if (serverId === "server2") throw problem("This number option is temporarily unavailable. Please choose another server.", 503, "SERVER_UNAVAILABLE");
  if (!services[service]) throw problem("Choose a supported verification service.", 400, "INVALID_SERVICE");
  providerCountry(country);
  if (serverId === "server1" && !["us", "ca"].includes(country)) {
    throw problem("Server 1 is available for USA and Canada only.", 400, "INVALID_COUNTRY");
  }
  if (serverId === "server3" && (country !== "us" || service !== "whatsapp")) {
    throw problem("Server 3 is available for USA WhatsApp only.", 400, "INVALID_ROUTE");
  }
  return profile;
}
function configured(): string {
  const key = Deno.env.get("FIVESIM_API_KEY");
  if (!key || !key.trim()) throw problem("The number service is temporarily unavailable. Please try again shortly.", 503, "CONFIG_MISSING");
  return key.trim();
}
async function userContext(req: Request) {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const srv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("Authorization") || "";
  if (!url || !anon || !srv || !auth.startsWith("Bearer ")) {
    throw problem("Please sign in again to continue.", 401, "AUTH_REQUIRED");
  }
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const who = await userClient.auth.getUser();
  if (who.error || !who.data.user) throw problem("Your session expired. Sign in again.", 401, "AUTH_REQUIRED");
  const admin = createClient(url, srv, { auth: { persistSession: false, autoRefreshToken: false } });
  return { url, anon, auth, user: who.data.user, admin };
}
async function apiGet(path: string): Promise<{ ok: boolean; status: number; data: any }> {
  const key = configured();
  let response: Response;
  try {
    response = await fetch(BASE + path, {
      method: "GET",
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      signal: AbortSignal.timeout(18000),
    });
  } catch {
    throw problem("The number service could not be reached. Please try again shortly.", 503, "UPSTREAM_TIMEOUT");
  }
  const raw = await response.text();
  let data: any = null;
  try { data = JSON.parse(raw); } catch { data = { message: raw }; }
  return { ok: response.ok, status: response.status, data };
}
async function usdToNgn(): Promise<number> {
  const now = Date.now();
  if (fxCache && now - fxCache.updatedAt < 60 * 60 * 1000) return fxCache.rate;
  let response: Response;
  try {
    response = await fetch("https://open.er-api.com/v6/latest/USD", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw problem("Live pricing is temporarily unavailable. Please try again shortly.", 503, "FX_UNAVAILABLE");
  }
  const data: any = await response.json().catch(() => null);
  const last = Number(data?.time_last_update_unix);
  const rate = Number(data?.rates?.NGN);
  const age = Math.floor(Date.now() / 1000) - last;
  if (!response.ok || data?.result !== "success" || !Number.isFinite(rate) || rate < 100 || rate > 10000 ||
      !Number.isFinite(last) || age < 0 || age > 36 * 60 * 60) {
    throw problem("Live pricing is temporarily unavailable. Please try again shortly.", 503, "FX_UNAVAILABLE");
  }
  fxCache = { rate, updatedAt: now };
  return rate;
}
async function bestOffer(country: string, service: string): Promise<{ operator: string; usd: number; count: number; rate: number | null; fx: number; providerCostNgn: number }> {
  const c = providerCountry(country);
  if (!services[service]) throw problem("Choose a supported verification service.", 400, "INVALID_SERVICE");
  const result = await apiGet("/guest/prices?country=" + encodeURIComponent(c) + "&product=" + encodeURIComponent(service));
  if (!result.ok || !result.data || typeof result.data !== "object") {
    throw problem("Current number prices could not be verified. Please try again shortly.", 503, "PRICE_UNAVAILABLE");
  }
  const root: any = result.data;
  const countryNode: any = root[c] || root[c.toUpperCase()] || root;
  let productNode: any = countryNode?.[service] || root?.[service] || null;
  if (productNode && typeof productNode === "object" && productNode[c] && typeof productNode[c] === "object") {
    productNode = productNode[c];
  }
  if (!productNode || typeof productNode !== "object") {
    throw problem("This number service is not currently available for the selected country.", 409, "NO_STOCK");
  }
  let rows = Object.entries(productNode).map(([operator, raw]: [string, any]) => {
    const usd = Number(raw?.cost);
    const count = Number(raw?.count);
    const rateValue = raw?.rate == null || raw?.rate === "" ? null : Number(raw.rate);
    const deliveryRate = rateValue !== null && Number.isFinite(rateValue) && rateValue >= 0 && rateValue <= 100 ? rateValue : null;
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(operator) || !Number.isFinite(usd) || usd <= 0 ||
        !Number.isFinite(count) || count <= 0) return null;
    return { operator, usd, count, rate: deliveryRate };
  }).filter((x): x is { operator: string; usd: number; count: number; rate: number | null } => x !== null);
  if (!rows.length) throw problem("No number is currently available for this service and country. Try again later.", 409, "NO_STOCK");
  // Prefer operators with stronger reported delivery rates; then use price and stock as tie-breakers.
  rows.sort((a, b) => {
    if (a.rate !== null && b.rate !== null && a.rate !== b.rate) return b.rate - a.rate;
    if (a.rate !== null && b.rate === null) return -1;
    if (a.rate === null && b.rate !== null) return 1;
    if (a.usd !== b.usd) return a.usd - b.usd;
    return b.count - a.count;
  });
  const offer = rows[0];
  const fx = await usdToNgn();
  // A small FX buffer protects Sparkle against rounding/exchange-rate movement; customer price is still rechecked before reserving funds.
  const providerCostNgn = money(offer.usd * fx * 1.02);
  if (!Number.isFinite(providerCostNgn) || providerCostNgn <= 0) {
    throw problem("Current number prices could not be verified. No wallet funds were used.", 503, "PRICE_UNAVAILABLE");
  }
  return { ...offer, fx, providerCostNgn };
}
async function getQuote(country: string, service: string, serverId: string) {
  const profile = validateRoute(serverId, country, service);
  const offer = await bestOffer(country, service);
  const sellingPrice = money(offer.providerCostNgn * (1 + profile.markup / 100));
  if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) throw problem("Current number prices could not be verified.", 503, "PRICE_UNAVAILABLE");
  return {
    code: service,
    name: services[service],
    country,
    network: "Available network",
    selling_price_ngn: sellingPrice,
    server_id: serverId,
    server_label: profile.label,
    stock: offer.count,
    rate: offer.rate,
    markup_percent: profile.markup,
    provider_cost_ngn: offer.providerCostNgn,
    provider_cost_usd: offer.usd,
    provider_operator: offer.operator,
    fx_rate: offer.fx,
  };
}
function safeServiceQuote(q: any) {
  return {
    code: q.code,
    name: q.name,
    country: q.country,
    network: "Available network",
    selling_price_ngn: q.selling_price_ngn,
    server_id: q.server_id,
    server_label: q.server_label,
    stock: q.stock,
  };
}
function publicError(error: any, fallback = "The number service is temporarily unavailable. Please try again shortly.") {
  const code = String(error?.code || "");
  const status = Number(error?.status);
  if (code === "NO_STOCK") return reply({ success: false, code, message: "No number is currently available for this service and country. Try again later." }, 409);
  if (code === "PRICE_CHANGED") return reply({ success: false, code, message: "The Sparkle price changed. No money was deducted; check the current price again." }, 409);
  if (code === "INSUFFICIENT_FUNDS") return reply({ success: false, code, message: "Insufficient Sparkle wallet balance. Please fund your wallet and try again." }, 402);
  if (code === "AUTH_REQUIRED") return reply({ success: false, code, message: "Please sign in again to continue." }, 401);
  if (code === "INVALID_SERVER" || code === "INVALID_COUNTRY" || code === "INVALID_SERVICE" || code === "INVALID_ROUTE") {
    return reply({ success: false, code, message: error.message || "Choose a valid server, country and service." }, status || 400);
  }
  if (code === "SERVER_UNAVAILABLE") return reply({ success: false, code, message: error.message }, 503);
  if (code === "CONFIG_MISSING") return reply({ success: false, code, message: fallback }, 503);
  if (code === "FX_UNAVAILABLE" || code === "PRICE_UNAVAILABLE") return reply({ success: false, code, message: fallback }, 503);
  return reply({ success: false, code: code || "NUMBER_UNAVAILABLE", message: fallback }, status >= 400 && status < 600 ? status : 503);
}
async function finalize(admin: any, requestId: string, status: "success" | "failed" | "cancelled" | "unknown", providerResponse: Obj | null, errorText: string | null) {
  return await admin.rpc("sparkle_finish_sms_otp", {
    p_request_id: requestId,
    p_status: status,
    p_provider_response: providerResponse,
    p_error: errorText,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ success: false, message: "POST required." }, 405);
  let ctx: any;
  try { ctx = await userContext(req); } catch (e) { return publicError(e, "Please sign in again to continue."); }
  const body: Obj = await req.json().catch(() => ({}));
  const requestId = asText(body.request_id);
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) return reply({ success: false, message: "The order reference is invalid." }, 400);
  const found = await ctx.admin.from("sparkle_sms_otp_orders").select("*").eq("user_id", ctx.user.id).eq("request_id", requestId).maybeSingle();
  if (found.error) return reply({ success: false, message: "Could not load this order. No refund was recorded." }, 503);
  const order = found.data;
  if (!order) return reply({ success: false, message: "Order not found." }, 404);
  const saved = order.provider_response || {};
  if (order.status === "success" || saved.sms_code) return reply({ success: false, status: "success", message: "This order already received an SMS code and can no longer be cancelled." }, 409);
  if (order.status === "cancelled") return reply({ success: true, status: "cancelled", refund_status: "processed", message: "This order is already cancelled. Check transaction history for the recorded refund." });
  if (order.status === "failed") return reply({ success: false, status: "failed", message: "This order has already failed. Check transaction history for the final refund status." }, 409);
  const id = String(order.provider_request_id || "");
  if (!/^\d{1,20}$/.test(id)) return reply({ success: false, status: "unknown", message: "Sparkle is still registering this order. Do not buy again; check again shortly." }, 202);
  try {
    const cancelled = await apiGet("/user/cancel/" + encodeURIComponent(id));
    const data = cancelled.data || {};
    const sms = Array.isArray(data.sms) ? data.sms : [];
    const gotCode = sms.some((s: Obj) => asText(s?.code).length > 0);
    if (gotCode || ["RECEIVED", "FINISHED"].includes(String(data.status || "").toUpperCase())) {
      return reply({ success: false, status: "pending", message: "The SMS has already arrived. Check the order status to retrieve it; no refund was recorded." }, 409);
    }
    if (!cancelled.ok || String(data.status || "").toUpperCase() !== "CANCELED") {
      return reply({ success: false, status: "unknown", message: "Sparkle could not confirm cancellation. No refund has been recorded yet; check the order status before trying again." }, 202);
    }
    const f = await finalize(ctx.admin, requestId, "cancelled", { status: "CANCELED", expires_at: data.expires || saved.expires_at || null }, "Number order cancellation was confirmed.");
    if (f.error || f.data?.success !== true) {
      return reply({ success: false, status: "unknown", message: "Cancellation was confirmed, but Sparkle could not finalize the refund. Do not buy again; contact support." }, 202);
    }
    return reply({ success: true, status: "cancelled", request_id: requestId, refund_status: "processed", refund_amount: Number(order.amount), message: "Cancellation confirmed. Sparkle has recorded your wallet refund." });
  } catch {
    return reply({ success: false, status: "unknown", message: "The cancellation result could not be confirmed. No refund was recorded yet; check order status before buying again." }, 202);
  }
});
