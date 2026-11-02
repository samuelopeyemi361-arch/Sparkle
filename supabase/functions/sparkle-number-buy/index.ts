import { createClient } from "npm:@supabase/supabase-js@2";

type Obj = Record<string, any>;
const BASE = "https://5sim.net/v1";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const serviceLabels: Record<string, string> = {
  whatsapp:"WhatsApp", google:"Google / YouTube", instagram:"Instagram / Threads",
  facebook:"Facebook", telegram:"Telegram", openai:"OpenAI / ChatGPT", amazon:"Amazon",
  microsoft:"Microsoft", tiktok:"TikTok", twitter:"X / Twitter", discord:"Discord",
  snapchat:"Snapchat", uber:"Uber", tinder:"Tinder", yahoo:"Yahoo", outlook:"Outlook",
  airbnb:"Airbnb", binance:"Binance", steam:"Steam", wechat:"WeChat", line:"LINE",
  viber:"Viber", signal:"Signal", other:"Other"
};
function serviceDisplayName(code: string): string {
  const key=asText(code).toLowerCase();
  if(serviceLabels[key])return serviceLabels[key];
  return key.replace(/[_-]+/g," ").replace(/\b[a-z]/g,ch=>ch.toUpperCase());
}
function operatorDisplayName(code: string): string {
  const key=asText(code).toLowerCase();
  if(key==="any")return "Automatic · price capped";
  const virtual=key.match(/^virtual[-_ ]?(\d+)$/);
  if(virtual)return "Virtual network "+virtual[1];
  return key.replace(/[_-]+/g," ").replace(/\b[a-z]/g,ch=>ch.toUpperCase());
}
const profileByServer: Record<string,{markup:number;label:string}> = {
  // Internal compatibility for the existing atomic wallet-reservation routine.
  // Customers see one live catalogue, not supplier server choices.
  server1:{markup:75,label:"Live number catalogue"}
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
const PROVIDER_SUCCESS_STATES = new Set(["FINISHED", "SUCCESS", "SUCCESSFUL", "COMPLETED"]);
const PROVIDER_FAILURE_STATES = new Set(["CANCELED", "CANCELLED", "TIMEOUT", "FAILED", "FAILURE", "REJECTED", "BANNED", "EXPIRED"]);
function providerSucceeded(value: unknown): boolean {
  return PROVIDER_SUCCESS_STATES.has(asText(value).toUpperCase());
}
function providerFailed(value: unknown): boolean {
  return PROVIDER_FAILURE_STATES.has(asText(value).toUpperCase());
}
function providerFailureAppStatus(value: unknown): "failed" | "cancelled" {
  return ["CANCELED", "CANCELLED", "TIMEOUT", "EXPIRED"].includes(asText(value).toUpperCase()) ? "cancelled" : "failed";
}
function extractSms(payload: any): { code: string; text: string; hasMessage: boolean } {
  const rows = Array.isArray(payload?.sms) ? payload.sms : [];
  for (const row of rows) {
    const text = asText(row?.text);
    let code = asText(row?.code);
    if (!code && text) {
      const labelled = new RegExp("\\b(?:code|otp|verification(?:\\s+code)?|pin)\\b[^A-Z0-9]{0,12}([A-Z0-9]{4,10})", "i").exec(text);
      if (labelled) code = labelled[1];
    }
    if (code || text) return { code, text, hasMessage: true };
  }
  return { code: "", text: "", hasMessage: false };
}
function providerCountry(country: string): string {
  const value = asText(country).toLowerCase();
  if (value === "us" || value === "usa") return "usa";
  if (value === "ca" || value === "canada") return "canada";
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(value)) {
    throw problem("Choose a country from the live catalogue.", 400, "INVALID_COUNTRY");
  }
  return value;
}
function manualRateCountry(country: string): string {
  const value = asText(country).toLowerCase().replace(/[_\s]+/g, "-");
  if (["us","usa","united-states"].includes(value)) return "us";
  if (["ca","canada"].includes(value)) return "ca";
  if (["de","germany"].includes(value)) return "de";
  return value;
}
function validateRoute(serverId: string, country: string, service: string): { markup: number; label: string } {
  const profile = profileByServer[serverId];
  if (!profile || serverId !== "server1") throw problem("Choose a valid Sparkle number option.", 400, "INVALID_SERVER");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service)) throw problem("Choose a valid verification service.", 400, "INVALID_SERVICE");
  providerCountry(country);
  return profile;
}
let providerCountriesCache: { items: any[]; expiresAt: number } | null = null;
async function getProviderCountries(): Promise<any[]> {
  if (providerCountriesCache && providerCountriesCache.expiresAt > Date.now()) return providerCountriesCache.items;
  const response = await apiGet("/guest/countries");
  if (!response.ok || !response.data || typeof response.data !== "object") throw problem("The live country list could not be loaded. Please try again shortly.", 503, "COUNTRIES_UNAVAILABLE");
  const raw = response.data?.data && typeof response.data.data === "object" ? response.data.data : response.data;
  const rows = Object.entries(raw).map(([slug, value]: [string, any]) => {
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug) || !value || typeof value !== "object") return null;
    const iso = Object.keys(value.iso || {}).find((x) => /^[a-z]{2}$/i.test(x)) || "";
    return {
      code: slug === "usa" ? "us" : slug === "canada" ? "ca" : slug,
      name: String(value.text_en || slug.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, ch => ch.toUpperCase())),
      iso_code: iso.toLowerCase(),
      dial: Object.keys(value.prefix || {})[0] || "",
    };
  }).filter(Boolean);
  const unique = new Map<string, any>();
  for (const item of rows as any[]) if (!unique.has(item.code)) unique.set(item.code, item);
  const items = [...unique.values()].sort((a, b) =>
    a.code === "us" ? -1 : b.code === "us" ? 1 : a.code === "ca" ? -1 : b.code === "ca" ? 1 : a.name.localeCompare(b.name)
  );
  providerCountriesCache = { items, expiresAt: Date.now() + 10 * 60 * 1000 };
  return items;
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


function supplierBalanceInsufficient(data: any): boolean {
  const code = String(data?.code ?? data?.statusCode ?? data?.data?.code ?? data?.data?.statusCode
    ?? data?.content?.code ?? data?.data?.content?.code ?? "").trim().toUpperCase();
  const status = String(data?.status ?? data?.data?.status ?? data?.content?.status
    ?? data?.data?.content?.status ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  const details = [
    data?.description, data?.message, data?.api_response, data?.error, data?.detail,
    data?.data?.description, data?.data?.message, data?.data?.api_response,
    data?.content?.description, data?.content?.message, data?.data?.content?.description
  ].map(x => String(x ?? "")).join(" ").toUpperCase();
  return code === "INSUFFICIENT_BALANCE" || status === "INSUFFICIENT_BALANCE"
    || /INSUFFICIENT[_\s-]*(?:SUPPLIER[_\s-]*)?(?:WALLET[_\s-]*)?BALANCE|BALANCE[_\s-]*(?:IS[_\s-]*)?(?:INSUFFICIENT|TOO[_\s-]*LOW)|NOT[_\s-]*ENOUGH[_\s-]*BALANCE|LOW[_\s-]*BALANCE/.test(details)
    || (code === "402" && /BALANCE/.test(details));
}
async function notifySupplierBalanceLow(supplier: string, service: string, reference: string, reason: string) {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !serviceKey) {
    console.error("[sparkle-supplier-alert] missing internal credentials", { supplier, service, reference });
    return false;
  }
  try {
    const response = await fetch(url + "/functions/v1/sparkle-supplier-alert", {
      method: "POST",
      headers: { Authorization: "Bearer " + serviceKey, apikey: serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ supplier, service, reference, reason }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.emailSent !== true) {
      console.error("[sparkle-supplier-alert] dispatch not confirmed", { supplier, service, reference, status: response.status, reason: String(result?.reason || result?.error || "email_not_confirmed").slice(0, 180) });
      return false;
    }
    return true;
  } catch (error) {
    console.error("[sparkle-supplier-alert] dispatch failed", { supplier, service, reference, error: error instanceof Error ? error.message.slice(0, 180) : "unknown" });
    return false;
  }
}
function supplierBalanceReason(data: any): string {
  return String(data?.description ?? data?.message ?? data?.api_response ?? data?.error
    ?? data?.data?.description ?? data?.data?.message ?? "Supplier account has insufficient balance.")
    .replace(/[\r\n\t]+/g, " ").trim().slice(0, 450);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ success: false, message: "POST required." }, 405);
  let ctx: any;
  try { ctx = await userContext(req); } catch (e) { return publicError(e, "Please sign in again to continue."); }
  const body: Obj = await req.json().catch(() => ({}));
  const service = asText(body.service).toLowerCase();
  const country = asText(body.country || "us").toLowerCase();
  const serverId = asText(body.server_id || body.serverId || "server1").toLowerCase();
  const rawOperator = asText(body.operator || "smart").toLowerCase();
  const operator = rawOperator === "any" ? "smart" : rawOperator;
  const requestId = asText(body.request_id);
  const pin = asText(body.pin);
  const quotedPrice = Number(body.quoted_selling_price_ngn);
  try {
    const profile = validateRoute(serverId, country, service);
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) throw problem("The order reference is invalid. Please try again.", 400, "INVALID_REQUEST");
    if (!Number.isFinite(quotedPrice) || quotedPrice <= 0) throw problem("Check the current Sparkle price before purchasing.", 400, "PRICE_UNCHECKED");
    if (!/^\d{4}$/.test(pin)) throw problem("Enter your 4-digit transaction PIN.", 400, "INVALID_PIN");
    const existing = await ctx.admin.from("sparkle_sms_otp_orders").select("request_id,status").eq("user_id", ctx.user.id).eq("request_id", requestId).maybeSingle();
    if (existing.error) throw problem("Could not check this order reference. No money was deducted.", 503, "ORDER_LOOKUP_FAILED");
    if (existing.data) return reply({ success: false, status: existing.data.status, request_id: requestId, message: "This order reference already exists. Check its status instead of buying again." }, 409);
    // Price and availability reads are safe to perform while the PIN is being
    // checked. No wallet reservation or 5SIM purchase starts until PIN succeeds.
    const quotePromise = getQuote(country, service, serverId, operator, ctx.admin)
      .then((quote:any)=>({quote,error:null as any}))
      .catch((error:any)=>({quote:null,error}));
    const pinResponse = await fetch(ctx.url + "/functions/v1/sparkle-transaction-pin", {
      method: "POST",
      headers: { Authorization: ctx.auth, apikey: ctx.anon, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", pin }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    const pinData = pinResponse ? await pinResponse.json().catch(() => null) : null;
    if (!pinResponse || !pinResponse.ok || pinData?.success !== true) {
      return reply({ success: false, message: String(pinData?.message || "Transaction PIN verification failed. No money was deducted.") }, pinResponse && pinResponse.status >= 400 && pinResponse.status < 500 ? pinResponse.status : 503);
    }
    const quoteResult = await quotePromise;
    if (quoteResult.error) throw quoteResult.error;
    const quote = quoteResult.quote;
    if (Math.abs(quotedPrice - quote.selling_price_ngn) > 0.02) {
      throw problem("The Sparkle price changed. No money was deducted; check the current price again.", 409, "PRICE_CHANGED");
    }
    const wallet = await ctx.admin.from("wallets").select("balance").eq("user_id", ctx.user.id).maybeSingle();
    if (wallet.error) throw problem("Could not verify your Sparkle wallet balance. No supplier order was sent and no money was deducted.", 503, "WALLET_CHECK_FAILED");
    const balance = Number(wallet.data?.balance);
    if (!Number.isFinite(balance) || balance + 0.0001 < quote.selling_price_ngn) {
      throw problem("Insufficient Sparkle wallet balance. Please fund your wallet and try again.", 402, "INSUFFICIENT_FUNDS");
    }
    // Supplier funding is checked only after the customer has reviewed the
    // price, passed the PIN check, and had their wallet balance confirmed.
    // This keeps 5SIM balance shortages from hiding catalogue options.
    let supplierProfile: { balance: number };
    try { supplierProfile = await providerProfile(true); }
    catch { throw problem("Service unavailable. Please try again later.", 503, "SUPPLIER_UNAVAILABLE"); }
    if (supplierProfile.balance + 0.000001 < quote.provider_cost_usd) {
      await notifySupplierBalanceLow("5SIM", serviceDisplayName(service), requestId,
        "5SIM USD balance " + supplierProfile.balance.toFixed(4) + " is below required purchase cost " + quote.provider_cost_usd.toFixed(4) + " USD.");
      return reply({ success: false, status: "service_unavailable", code: "PROVIDER_BALANCE_LOW", request_id: requestId,
        message: "Service unavailable. Please try again later. Your Sparkle wallet has not been charged." }, 200);
    }
    const reservation = await ctx.admin.rpc("sparkle_reserve_sms_otp_server", {
      p_user_id: ctx.user.id,
      p_request_id: requestId,
      p_service_name: quote.name,
      p_country: country,
      p_provider_cost: quote.provider_cost_ngn,
      p_server_id: serverId,
      p_markup_percent: profile.markup,
    });
    if (reservation.error || reservation.data?.success !== true) {
      const msg = String(reservation.data?.message || reservation.error?.message || "");
      if (/insufficient|not enough|wallet balance/i.test(msg)) throw problem("Insufficient Sparkle wallet balance. Please fund your wallet and try again.", 402, "INSUFFICIENT_FUNDS");
      throw problem("Sparkle could not reserve your wallet. No supplier order was sent.", 503, "RESERVATION_FAILED");
    }
    // 5SIM enforces maxPrice only for operator=any. Named operators use the
    // freshly rechecked operator quote, since 5SIM ignores maxPrice for named operators.
    const encodedCountry=encodeURIComponent(providerCountry(country));
    const encodedService=encodeURIComponent(service);
    const encodedOperator=encodeURIComponent(quote.operator);
    const orderPath=quote.operator==="any"
      ? "/user/buy/activation/"+encodedCountry+"/any/"+encodedService+"?maxPrice="+encodeURIComponent(Number(quote.provider_cost_usd).toFixed(2))
      : "/user/buy/activation/"+encodedCountry+"/"+encodedOperator+"/"+encodedService;
    let placed: { ok: boolean; status: number; data: any };
    try {
      placed = await apiGet(orderPath);
    } catch {
      await finalize(ctx.admin, requestId, "unknown", { status: "unknown" }, "Supplier response timed out; outcome requires reconciliation.");
      return reply({ success: false, status: "unknown", request_id: requestId, message: "Sparkle is still confirming your number order. Do not buy again; check the order status shortly." }, 202);
    }
    let data = placed.data || {};
    if (supplierBalanceInsufficient(data)) {
      await notifySupplierBalanceLow("5SIM", serviceDisplayName(service), requestId, supplierBalanceReason(data));
      const released = await finalize(ctx.admin, requestId, "failed", data, "5SIM supplier account has insufficient balance.");
      if (released.error || released.data?.success !== true) {
        return reply({ success: false, status: "unknown", request_id: requestId,
          message: "Service unavailable. Sparkle is confirming your wallet reversal. Do not retry yet." }, 202);
      }
      return reply({ success: false, status: "service_unavailable", request_id: requestId,
        message: "Service unavailable. Please try again later. Your Sparkle wallet has not been charged." }, 200);
    }
    const providerId = String(data.id ?? "");
    let phone = String(data.phone ?? "");
    const accepted = placed.ok && /^\d{1,20}$/.test(providerId) && phone.length >= 5;
    if (accepted) {
      const actualUsd = Number(data.price);
      const actualProviderCost = Number.isFinite(actualUsd) && actualUsd > 0
        ? money(actualUsd * quote.fx_rate * 1.02)
        : quote.provider_cost_ngn;
      let smsDetails = extractSms(data);
      let providerStatus = String(data.status || "PENDING").toUpperCase();
      if (!smsDetails.code && (providerStatus === "RECEIVED" || providerSucceeded(providerStatus))) {
        try {
          const history = await apiGet("/user/orders?category=activation&limit=100&offset=0&order=id&reverse=true");
          const rows = Array.isArray(history.data?.Data) ? history.data.Data : [];
          const historical = rows.find((row: Obj) => String(row?.id ?? "") === providerId);
          if (history.ok && historical) {
            data = historical;
            providerStatus = String(data.status || providerStatus).toUpperCase();
            smsDetails = extractSms(data);
            phone = String(data.phone || phone);
          }
        } catch {
          // History is a recovery path only; retain the original supplier response on error.
        }
      }
      const sanitized = { status: providerStatus, operator: String(data.operator || quote.provider_operator || quote.operator), price_usd: Number.isFinite(actualUsd) ? actualUsd : quote.provider_cost_usd, expires_at: data.expires || null, sms_code: smsDetails.code || null, sms_text: smsDetails.text || null };
      const update = await ctx.admin.from("sparkle_sms_otp_orders").update({
        provider_request_id: providerId,
        phone_number: phone,
        provider_cost: actualProviderCost,
        provider_response: sanitized,
        updated_at: new Date().toISOString(),
      }).eq("user_id", ctx.user.id).eq("request_id", requestId);
      if (update.error) {
        return reply({ success: false, status: "unknown", request_id: requestId, phone_number: phone, message: "Sparkle received your order but could not finish saving it. Do not buy again; contact support." }, 202);
      }
      if (providerFailed(providerStatus)) {
        const appStatus = providerFailureAppStatus(providerStatus);
        const completed = await finalize(ctx.admin, requestId, appStatus, sanitized, "The number provider confirmed a terminal unsuccessful order: " + providerStatus);
        const refunded = !completed.error && completed.data?.success === true;
        return reply({
          success: false,
          status: refunded ? appStatus : "unknown",
          refunded,
          request_id: requestId,
          message: refunded
            ? "The number order was not completed. Sparkle has recorded your full wallet refund."
            : "The supplier ended the order, but Sparkle could not confirm the refund. Do not buy again; contact support."
        }, refunded ? 502 : 202);
      }
      if (smsDetails.code) {
        let finished = providerSucceeded(providerStatus);
        if (!finished) {
          try {
            const finish = await apiGet("/user/finish/" + encodeURIComponent(providerId));
            const finishStatus = String(finish.data?.status || "").toUpperCase();
            if (finish.ok && providerSucceeded(finishStatus)) {
              data = finish.data;
              providerStatus = finishStatus;
              finished = true;
              const finalSms = extractSms(data);
              if (finalSms.code) smsDetails = finalSms;
            }
          } catch {
            // Do not settle the Sparkle debit until the supplier's final state is confirmed.
          }
        }
        if (!finished) {
          try {
            const refreshed = await apiGet("/user/check/" + encodeURIComponent(providerId));
            if (refreshed.ok && refreshed.data && typeof refreshed.data === "object") {
              data = refreshed.data;
              providerStatus = String(data.status || providerStatus).toUpperCase();
              const refreshedSms = extractSms(data);
              if (refreshedSms.code) smsDetails = refreshedSms;
              finished = providerSucceeded(providerStatus);
            }
          } catch {
            // Leave the customer's debit pending when the supplier result is uncertain.
          }
        }
        if (providerFailed(providerStatus)) {
          const appStatus = providerFailureAppStatus(providerStatus);
          const completed = await finalize(ctx.admin, requestId, appStatus, { ...sanitized, status: providerStatus }, "The number provider confirmed a terminal unsuccessful order: " + providerStatus);
          const refunded = !completed.error && completed.data?.success === true;
          return reply({ success: false, status: refunded ? appStatus : "unknown", refunded, request_id: requestId, message: refunded ? "The number order was not completed. Sparkle has recorded your full wallet refund." : "The supplier ended the order, but Sparkle could not confirm the refund. Do not buy again; contact support." }, refunded ? 502 : 202);
        }
        if (!finished || !smsDetails.code) {
          const waiting = { ...sanitized, status: providerStatus || "RECEIVED", sms_code: smsDetails.code || null, sms_text: smsDetails.text || null, expires_at: data.expires || sanitized.expires_at || null };
          await ctx.admin.from("sparkle_sms_otp_orders").update({ provider_response: waiting, phone_number: phone, updated_at: new Date().toISOString() }).eq("user_id", ctx.user.id).eq("request_id", requestId);
          return reply({ success: true, status: "pending", request_id: requestId, order_id: providerId, phone_number: phone, message: finished ? "The supplier completed the order, but Sparkle is still recovering the SMS content. Your payment is being held safely while we retrieve it." : "The SMS is available. Sparkle is waiting for the supplier's final completion confirmation. Do not buy again." }, 202);
        }
        sanitized.status = providerStatus;
        sanitized.sms_code = smsDetails.code;
        sanitized.sms_text = smsDetails.text || null;
        const saved = await ctx.admin.from("sparkle_sms_otp_orders").update({ provider_response: sanitized, phone_number: phone, updated_at: new Date().toISOString() }).eq("user_id", ctx.user.id).eq("request_id", requestId);
        if (saved.error) {
          return reply({ success: false, status: "unknown", request_id: requestId, order_id: providerId, phone_number: phone, message: "The supplier completed the order, but Sparkle could not save the final SMS record. Do not buy again; contact support." }, 202);
        }
        const completed = await finalize(ctx.admin, requestId, "success", sanitized, null);
        if (completed.error || completed.data?.success !== true) {
          return reply({ success: false, status: "unknown", request_id: requestId, order_id: providerId, phone_number: phone, message: "The number service completed the order, but Sparkle could not finalize the wallet record. Do not buy again; contact support." }, 202);
        }
        return reply({ success: true, status: "success", request_id: requestId, order_id: providerId, phone_number: phone, sms_code: smsDetails.code, sms_text: smsDetails.text, service: quote.name, country, selling_price_ngn: quote.selling_price_ngn, currency: "NGN", message: "Number purchased and SMS received." });
      }
      if (providerSucceeded(providerStatus)) {
        const finalResponse = { ...sanitized, status: providerStatus, sms_code: null, sms_text: smsDetails.text || null };
        const saved = await ctx.admin.from("sparkle_sms_otp_orders").update({ provider_response: finalResponse, phone_number: phone, updated_at: new Date().toISOString() }).eq("user_id", ctx.user.id).eq("request_id", requestId);
        if (saved.error) return reply({ success: false, status: "unknown", request_id: requestId, order_id: providerId, phone_number: phone, message: "The supplier completed the order, but Sparkle could not save its final result. Do not buy again; contact support." }, 202);
        const completed = await finalize(ctx.admin, requestId, "success", finalResponse, null);
        if (completed.error || completed.data?.success !== true) return reply({ success: false, status: "unknown", request_id: requestId, order_id: providerId, phone_number: phone, message: "The supplier completed the order, but Sparkle could not finalize the wallet record. Do not buy again; contact support." }, 202);
        return reply({ success: true, status: "success", request_id: requestId, order_id: providerId, phone_number: phone, sms_code: null, sms_text: smsDetails.text || "", message: "The supplier confirmed this number purchase. Sparkle is retrieving the SMS details." });
      }
      return reply({ success: true, status: "pending", request_id: requestId, order_id: providerId, phone_number: phone, service: quote.name, country, network: "Available network", selling_price_ngn: quote.selling_price_ngn, server_id: serverId, server_label: profile.label, currency: "NGN", message: smsDetails.hasMessage ? "The SMS arrived but its code could not be read yet. Refresh the order to retrieve it." : "Number purchased. Check again shortly for the SMS code." });
    }
    const providerErrorText = String(
      typeof data === "string" ? data : (data?.message || data?.error || data?.detail || data?.description || "")
    ).trim();
    // 5SIM documents some explicit rejections (notably "no free phones") as HTTP 200.
    // Treat only known, explicit no-order responses as safe failures; ambiguous outcomes remain reserved.
    const supplierExplicitRejection =
      providerFailed(data?.status) ||
      /\b(no free phones|no numbers available|not enough user balance|not enough rating|bad country|bad operator|no product|server offline|select country|select operator|unauthorized|invalid token|forbidden|max price exceeded)\b/i.test(providerErrorText);
    const explicitReject = providerFailed(data?.status) || (!providerId && (
      (!placed.ok && placed.status >= 400 && placed.status < 500) || supplierExplicitRejection
    ));
    if (explicitReject) {
      const safeProviderMessage = providerErrorText
        ? providerErrorText.slice(0, 180)
        : "Supplier explicitly rejected the number order.";
      const f = await finalize(ctx.admin, requestId, "failed", { status: "REJECTED", reason: safeProviderMessage }, "The number provider explicitly rejected the order before issuing a number.");
      const refunded = !f.error && f.data?.success === true;
      return reply({ success: false, status: refunded ? "failed" : "unknown", refunded, request_id: requestId, message: refunded ? "The order was not completed. Sparkle has recorded your wallet refund." : "The order was not completed, but its refund needs support review. Do not buy again." }, refunded ? 502 : 202);
    }
    await finalize(ctx.admin, requestId, "unknown", { status: "unknown" }, "The supplier response was not a confirmed order or rejection.");
    return reply({ success: false, status: "unknown", request_id: requestId, message: "Sparkle could not confirm the number order. Funds remain reserved while the outcome is checked. Do not buy again yet." }, 202);
  } catch (e: any) {
    return publicError(e, "The number purchase could not be completed. No supplier order was sent unless Sparkle explicitly reports an order is being checked.");
  }
});
