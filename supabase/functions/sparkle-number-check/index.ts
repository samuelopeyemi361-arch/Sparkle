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
function providerCountry(country: string): string {
  const value = asText(country).toLowerCase();
  if (value === "us" || value === "usa") return "usa";
  if (value === "ca" || value === "canada") return "canada";
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(value)) {
    throw problem("Choose a country from the live catalogue.", 400, "INVALID_COUNTRY");
  }
  return value;
}
function validateRoute(serverId: string, country: string, service: string): { markup: number; label: string } {
  const profile=profileByServer[serverId];
  if(!profile)throw problem("Use the live number catalogue.",400,"INVALID_SERVER");
  if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service))throw problem("Choose a valid verification service.",400,"INVALID_SERVICE");
  providerCountry(country);
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
type ParsedOffer={operator:string;usd:number;count:number;rate:number|null};
type ProviderOffer=ParsedOffer&{fx:number;providerCostNgn:number;providerBalanceUsd:number};
function parseOfferRows(node:any):ParsedOffer[]{
 if(!node||typeof node!=="object"||Array.isArray(node))return [];
 return Object.entries(node).map(([operator,raw]:[string,any])=>{
  const usd=Number(raw?.cost),count=Number(raw?.count);
  const rv=raw?.rate==null||raw?.rate===""?null:Number(raw.rate);
  const rate=rv!==null&&Number.isFinite(rv)&&rv>=0&&rv<=100?rv:null;
  if(!/^[a-zA-Z0-9._-]{1,80}$/.test(operator)||!Number.isFinite(usd)||usd<=0||!Number.isFinite(count)||count<0)return null;
  return {operator,usd,count,rate};
 }).filter((x):x is ParsedOffer=>x!==null);
}
async function getProductOffers(country:string,service:string):Promise<ProviderOffer[]>{
 const pc=providerCountry(country);
 if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service))throw problem("Choose a valid verification service.",400,"INVALID_SERVICE");
 const account=await providerProfile();
 const response=await apiGet("/guest/prices?country="+encodeURIComponent(pc)+"&product="+encodeURIComponent(service));
 if(!response.ok||!response.data||typeof response.data!=="object")throw problem("Current number prices could not be verified. Please try again shortly.",503,"PRICE_UNAVAILABLE");
 const root:any=response.data,countryNode:any=root[pc]||root[pc.toUpperCase()]||root;
 let productNode:any=countryNode?.[service]||root?.[service]||null;
 if(productNode&&typeof productNode==="object"&&productNode[pc]&&typeof productNode[pc]==="object")productNode=productNode[pc];
 if(!productNode||typeof productNode!=="object")throw problem("This service is not currently available for the selected country.",409,"NO_STOCK");
 const parsed=parseOfferRows(productNode),rows=parsed.filter(x=>x.count>0&&x.usd<=account.balance);
 if(!rows.length){
  if(parsed.some(x=>x.count>0))throw problem("This service is temporarily unavailable. Please try another option later.",503,"PROVIDER_BALANCE_LOW");
  throw problem("No operator currently has this service in stock for the selected country.",409,"NO_STOCK");
 }
 const fx=await usdToNgn();
 const offers:ProviderOffer[]=rows.map(x=>({...x,fx,providerCostNgn:money(x.usd*fx*1.02),providerBalanceUsd:account.balance}));
 offers.sort((a,b)=>{
  if(a.rate!==null&&b.rate!==null&&a.rate!==b.rate)return b.rate-a.rate;
  if(a.rate!==null&&b.rate===null)return -1;
  if(a.rate===null&&b.rate!==null)return 1;
  if(a.usd!==b.usd)return a.usd-b.usd;
  return b.count-a.count;
 });
 return offers;
}
async function bestOffer(country:string,service:string,requestedOperator="any"):Promise<ProviderOffer>{
 const offers=await getProductOffers(country,service);
 const chosen=requestedOperator&&requestedOperator!=="any"?offers.filter(x=>x.operator.toLowerCase()===requestedOperator.toLowerCase()):offers;
 if(!chosen.length)throw problem("That operator is no longer available. Choose another operator and check its current price.",409,"OPERATOR_UNAVAILABLE");
 return chosen[0];
}
async function getCatalogServices(country:string):Promise<any[]>{
 const pc=providerCountry(country),account=await providerProfile();
 const response=await apiGet("/guest/prices?country="+encodeURIComponent(pc));
 if(!response.ok||!response.data||typeof response.data!=="object")throw problem("The live service catalogue could not be loaded. Please try again shortly.",503,"CATALOG_UNAVAILABLE");
 const root:any=response.data,countryNode:any=root[pc]||root[pc.toUpperCase()]||root,fx=await usdToNgn();
 const items:any[]=[];
 for(const [code,rawNode] of Object.entries(countryNode||{})){
  if(!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(code))continue;
  let node:any=rawNode;
  if(node&&typeof node==="object"&&node[pc]&&typeof node[pc]==="object")node=node[pc];
  const offers=parseOfferRows(node).filter(x=>x.count>0&&x.usd<=account.balance);
  if(!offers.length)continue;
  const prices=offers.map(x=>money(money(x.usd*fx*1.02)*1.75));
  items.push({code,name:serviceDisplayName(code),country,network:"Multiple operators",stock:offers.reduce((n,x)=>n+x.count,0),selling_price_ngn:Math.min(...prices)});
 }
 return items.sort((a,b)=>a.name.localeCompare(b.name));
}
async function getQuote(country:string,service:string,serverId:string,requestedOperator="any"){
 const profile=validateRoute(serverId,country,service);
 if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service))throw problem("Choose a valid verification service.",400,"INVALID_SERVICE");
 if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(requestedOperator))throw problem("Choose a valid operator.",400,"INVALID_OPERATOR");
 const offer=await bestOffer(country,service,requestedOperator);
 const sellingPrice=money(offer.providerCostNgn*(1+profile.markup/100));
 if(!Number.isFinite(sellingPrice)||sellingPrice<=0)throw problem("Current number prices could not be verified.",503,"PRICE_UNAVAILABLE");
 const chosen=requestedOperator==="any"?"any":offer.operator;
 return {code:service,name:serviceDisplayName(service),country,network:"Available network",
  operator:chosen,operator_label:operatorDisplayName(chosen==="any"?"any":offer.operator),
  selling_price_ngn:sellingPrice,server_id:"server1",server_label:"Live number catalogue",
  stock:offer.count,rate:offer.rate,markup_percent:profile.markup,
  provider_cost_ngn:offer.providerCostNgn,provider_cost_usd:offer.usd,
  provider_operator:offer.operator,fx_rate:offer.fx};
}
function safeServiceQuote(q:any){
 return {code:q.code,name:q.name,country:q.country,network:q.network||"Available network",
  operator:q.operator,operator_label:q.operator_label,selling_price_ngn:q.selling_price_ngn,
  server_id:"server1",stock:q.stock,rate:q.rate};
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
  if (found.error) return reply({ success: false, status: "unknown", request_id: requestId, message: "Could not load this order. Please check again shortly." }, 503);
  const order = found.data;
  if (!order) return reply({ success: false, message: "Order not found." }, 404);
  const storedResponse = order.provider_response || {};
  if (order.status === "success") return reply({ success: true, status: "success", request_id: requestId, phone_number: order.phone_number, sms_code: storedResponse.sms_code || null, sms_text: storedResponse.sms_text || "", message: "SMS code received." });
  if (["failed", "cancelled"].includes(String(order.status).toLowerCase())) {
    return reply({ success: false, status: order.status, request_id: requestId, refund_status: "processed", message: "This order is no longer active. Check your Sparkle transaction history for the final refund status." });
  }
  const id = String(order.provider_request_id || "");
  if (!/^\d{1,20}$/.test(id)) return reply({ success: false, status: "unknown", request_id: requestId, message: "The order is still being registered. Do not buy again; check again shortly." }, 202);
  try {
    const result = await apiGet("/user/check/" + encodeURIComponent(id));
    const data = result.data || {};
    if (!result.ok || !data || typeof data !== "object") {
      return reply({ success: false, status: "pending", request_id: requestId, phone_number: order.phone_number, message: "Sparkle could not confirm an update yet. Your order remains under review; check again shortly." }, 202);
    }
    const status = String(data.status || "").toUpperCase();
    const sms = Array.isArray(data.sms) ? data.sms : [];
    const message = sms.find((s: Obj) => asText(s?.code).length > 0) || null;
    const smsCode = message ? asText(message.code) : "";
    const smsText = message ? asText(message.text) : "";
    const phone = String(data.phone || order.phone_number || "");
    if (smsCode) {
      // Finishing a received activation is best effort; the verified code is still recorded by Sparkle.
      try { await apiGet("/user/finish/" + encodeURIComponent(id)); } catch {}
      const sanitized = { status: status || "RECEIVED", price_usd: storedResponse.price_usd ?? null, expires_at: data.expires || storedResponse.expires_at || null, sms_code: smsCode, sms_text: smsText };
      const f = await finalize(ctx.admin, requestId, "success", sanitized, null);
      if (f.error || f.data?.success !== true) {
        return reply({ success: false, status: "unknown", request_id: requestId, phone_number: phone, message: "The SMS arrived, but Sparkle could not finalize the order yet. Do not buy again; contact support." }, 202);
      }
      await ctx.admin.from("sparkle_sms_otp_orders").update({ phone_number: phone, provider_response: sanitized, updated_at: new Date().toISOString() }).eq("user_id", ctx.user.id).eq("request_id", requestId);
      return reply({ success: true, status: "success", request_id: requestId, phone_number: phone, sms_code: smsCode, sms_text: smsText, message: "SMS code received." });
    }
    if (["CANCELED", "CANCELLED", "TIMEOUT"].includes(status)) {
      const f = await finalize(ctx.admin, requestId, "cancelled", { status, expires_at: data.expires || storedResponse.expires_at || null }, "The number order ended without an SMS code.");
      if (f.error || f.data?.success !== true) {
        return reply({ success: false, status: "unknown", request_id: requestId, phone_number: phone, message: "The order ended, but Sparkle could not confirm the refund yet. Do not buy again; contact support." }, 202);
      }
      return reply({ success: false, status: "cancelled", request_id: requestId, phone_number: phone, refund_status: "processed", refund_amount: Number(order.amount), message: "The order did not deliver an SMS code. Sparkle has recorded your wallet refund." });
    }
    const safeStatus = status === "RECEIVED" || status === "FINISHED" ? "pending" : (status === "PENDING" ? "pending" : "unknown");
    return reply({ success: true, status: safeStatus, request_id: requestId, phone_number: phone, message: "No SMS code yet. Check again shortly." }, safeStatus === "unknown" ? 202 : 200);
  } catch {
    return reply({ success: false, status: "pending", request_id: requestId, message: "The order status could not be reached. Funds remain reserved while Sparkle checks the result; do not buy again." }, 202);
  }
});
