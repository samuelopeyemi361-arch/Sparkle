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
  const action = asText(body.action || "services");
  const country = asText(body.country || "us").toLowerCase();
  const serverId = asText(body.serverId || body.server_id || "server1").toLowerCase();
  const service = asText(body.serviceName || body.service || "").toLowerCase();
  try {
    if (!profileByServer[serverId]) throw problem("Choose a valid number server.", 400, "INVALID_SERVER");
    if (serverId === "server2") throw problem("This number option is temporarily unavailable. Please choose another server.", 503, "SERVER_UNAVAILABLE");
    if (action === "countries") {
      const countries = serverId === "server3"
        ? [{ code: "us", name: "United States", dial: "+1", flag: "🇺🇸" }]
        : [{ code: "us", name: "United States", dial: "+1", flag: "🇺🇸" }, { code: "ca", name: "Canada", dial: "+1", flag: "🇨🇦" }];
      return reply({ success: true, data: { countries } });
    }
    if (!["services", "price", "server-prices"].includes(action)) throw problem("Unsupported catalogue action.", 400, "INVALID_ACTION");
    providerCountry(country);
    if (action === "services") {
      if (serverId === "server1" && !["us", "ca"].includes(country)) throw problem("Server 1 is available for USA and Canada only.", 400, "INVALID_COUNTRY");
      if (serverId === "server3" && country !== "us") throw problem("Server 3 is available for USA WhatsApp only.", 400, "INVALID_ROUTE");
      const products = serverId === "server3" ? ["whatsapp"] : Object.keys(services);
      const results = await Promise.all(products.map(async (code) => {
        try {
          const q = await getQuote(country, code, serverId);
          return safeServiceQuote(q);
        } catch (e: any) {
          if (e?.code === "NO_STOCK") return null;
          throw e;
        }
      }));
      const available = results.filter(Boolean);
      return reply({ success: true, data: { country, country_name: country === "us" ? "United States" : "Canada", currency: "NGN", server_id: serverId, server_label: profileByServer[serverId].label, services: available } });
    }
    if (!/^[a-z0-9_-]{1,80}$/.test(service)) throw problem("Choose a valid service.", 400, "INVALID_SERVICE");
    if (action === "price") {
      const q = await getQuote(country, service, serverId);
      return reply({ success: true, data: safeServiceQuote(q) });
    }
    const priceItems: any[] = [];
    for (const target of ["server1", "server2", "server3"]) {
      if (target === "server2" || (target === "server1" && !["us", "ca"].includes(country)) ||
          (target === "server3" && (country !== "us" || service !== "whatsapp"))) {
        priceItems.push({ server_id: target, server_label: profileByServer[target].label, selling_price_ngn: null });
        continue;
      }
      try {
        const q = await getQuote(country, service, target);
        priceItems.push({ server_id: target, server_label: profileByServer[target].label, selling_price_ngn: q.selling_price_ngn });
      } catch (e: any) {
        if (e?.code === "NO_STOCK") priceItems.push({ server_id: target, server_label: profileByServer[target].label, selling_price_ngn: null });
        else throw e;
      }
    }
    return reply({ success: true, data: { code: service, name: services[service], country, prices: priceItems } });
  } catch (e) {
    return publicError(e);
  }
});
