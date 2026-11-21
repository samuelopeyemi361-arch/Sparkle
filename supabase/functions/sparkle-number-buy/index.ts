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
let fxCache: { rate: number; updatedAt: number; sourceUpdatedAt: number } | null = null;

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

function publicError(error: any, fallback = "The number service is temporarily unavailable. Please try again shortly.") {
  const code = String(error?.code || "");
  const status = Number(error?.status);
  const safeMessages: Record<string, string> = {
    INVALID_SERVER: "Choose a valid Sparkle number option.",
    INVALID_COUNTRY: "Choose a country from the live catalogue.",
    INVALID_SERVICE: "Choose a valid verification service.",
    INVALID_REQUEST: "The order reference is invalid. Please try again.",
    PRICE_UNCHECKED: "Check the current Sparkle price before purchasing.",
    INVALID_PIN: "Enter your 4-digit transaction PIN.",
    PRICE_CHANGED: "The Sparkle price changed. No money was deducted; check the current price again.",
    INSUFFICIENT_FUNDS: "Insufficient Sparkle wallet balance. Please fund your wallet and try again.",
    AUTH_REQUIRED: "Please sign in again to continue.",
    WALLET_CHECK_FAILED: "Could not verify your Sparkle wallet balance. No supplier order was sent and no money was deducted.",
    ORDER_LOOKUP_FAILED: "Could not check this order reference. No money was deducted.",
    RESERVATION_FAILED: "Sparkle could not reserve your wallet. No supplier order was sent.",
    SUPPLIER_UNAVAILABLE: "Service unavailable. Please try again later.",
    PROVIDER_BALANCE_LOW: "Service unavailable. Please try again later.",
    CONFIG_MISSING: "The number service is temporarily unavailable. Please try again shortly.",
    UPSTREAM_TIMEOUT: "The number service could not be reached. Please try again shortly.",
    FX_UNAVAILABLE: "Live pricing is temporarily unavailable. Please try again shortly.",
    PRICE_UNAVAILABLE: "Current number prices could not be verified. Please try again shortly.",
    NO_STOCK: "No number is currently available for this service and country. Try again later."
  };
  const known = Object.prototype.hasOwnProperty.call(safeMessages, code);
  const httpStatus = known
    ? (code === "AUTH_REQUIRED" ? 401
      : code === "INSUFFICIENT_FUNDS" ? 402
      : code === "PRICE_CHANGED" || code === "NO_STOCK" ? 409
      : code.startsWith("INVALID_") || code === "PRICE_UNCHECKED" ? 400
      : 503)
    : (status >= 400 && status < 600 ? status : 503);
  return reply({
    success: false,
    code: code || "NUMBER_UNAVAILABLE",
    message: known ? safeMessages[code] : fallback
  }, httpStatus);
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


/* Reuse the same verified 5SIM price, FX, rate-override and operator-selection
   pipeline as sparkle-number-catalog. Revalidate the reviewed quote before debit. */
async function usdToNgn(): Promise<number> {
  const maxSourceAgeMs = 36 * 60 * 60 * 1000;
  const usableCachedRate = () => {
    if (!fxCache) return null;
    const sourceAge = Date.now() - fxCache.sourceUpdatedAt;
    return sourceAge >= 0 && sourceAge <= maxSourceAgeMs ? fxCache.rate : null;
  };
  if (fxCache && Date.now() - fxCache.updatedAt < 60 * 60 * 1000 && usableCachedRate() !== null) {
    return fxCache.rate;
  }

  // Primary live exchange-rate source.
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(9000),
    });
    const data: any = await response.json().catch(() => null);
    const last = Number(data?.time_last_update_unix);
    const rate = Number(data?.rates?.NGN);
    const age = Math.floor(Date.now() / 1000) - last;
    if (response.ok && data?.result === "success" && Number.isFinite(rate) && rate >= 100 && rate <= 10000 &&
        Number.isFinite(last) && age >= 0 && age <= 36 * 60 * 60) {
      fxCache = { rate, updatedAt: Date.now(), sourceUpdatedAt: last * 1000 };
      return rate;
    }
  } catch {
    // Try the independent daily-updated public currency feed below.
  }

  // Independent fallback: daily USD rates; accept only a recent, plausible NGN quote.
  try {
    const response = await fetch("https://latest.currency-api.pages.dev/v1/currencies/usd.json", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(7000),
    });
    const data: any = await response.json().catch(() => null);
    const rate = Number(data?.usd?.ngn);
    const date = String(data?.date || "");
    const last = Date.parse(date + "T00:00:00Z");
    const age = Date.now() - last;
    if (response.ok && Number.isFinite(rate) && rate >= 100 && rate <= 10000 &&
        Number.isFinite(last) && age >= -24 * 60 * 60 * 1000 && age <= 36 * 60 * 60 * 1000) {
      fxCache = { rate, updatedAt: Date.now(), sourceUpdatedAt: last };
      console.warn("[sparkle-number-fx-fallback]", JSON.stringify({ source: "currency-api-daily", date }));
      return rate;
    }
  } catch {
    // A previously verified cached rate remains the final safe fallback.
  }

  const fallbackRate = usableCachedRate();
  if (fallbackRate !== null) return fallbackRate;
  throw problem("Live Naira pricing is temporarily unavailable. Please try again shortly.", 503, "FX_UNAVAILABLE");
}
type ParsedOffer={operator:string;usd:number;count:number;rate:number|null;displayRate:number|null;rateWindow?:string|null;rateWindows:Record<string,number|null>;rateSource?:"5sim"|"manual_override";manualRateExpiresAt?:string|null};
type ProviderOffer=ParsedOffer&{fx:number;providerCostNgn:number;providerBalanceUsd:number};
function parseRateField(value:any):number|null{
 if(value&&typeof value==="object")value=value.value??value.percentage??value.percent??null;
 if(value===null||value===undefined||value==="")return null;
 const normalized=typeof value==="string"?value.trim().replace(/%/g,"").replace(",","."):value;
 const n=Number(normalized);
 return Number.isFinite(n)&&n>=0&&n<=100?n:null;
}
/**
 * Compare every in-stock operator using 5SIM Statistics' 3-hour rate.
 * The 1-hour "rate" and longer statistics periods can be materially different;
 * do not mix windows in a single recommendation. A missing rate3 remains
 * unverified unless an active administrator override exists for that exact pair.
 */
const RATE_WINDOW_PRIORITY=["rate3"] as const;
function getRateWindows(operatorData:any):Record<string,number|null>{
 const windows:Record<string,number|null>={};
 for(const key of RATE_WINDOW_PRIORITY)windows[key]=parseRateField(operatorData?.[key]);
 return windows;
}
function parseDeliveryRate(raw:any):{rate:number|null;window:string|null}{
 const value=parseRateField(raw?.rate3);
 return value===null
  ?{rate:null,window:null}
  :{rate:Number(value.toFixed(2)),window:"rate3"};
}

function unwrapOfferContainer(node:any):any{
 for(let depth=0;depth<5;depth++){
  if(!node||typeof node!=="object"||Array.isArray(node))break;
  const hasOfferFields=node.cost!==undefined||node.price_usd!==undefined||node.count!==undefined||node.qty!==undefined||node.stock!==undefined;
  if(hasOfferFields)break;
  const wrapper=["data","operators","items","rows","prices"].find(key=>node[key]&&typeof node[key]==="object");
  if(!wrapper)break;
  node=node[wrapper];
 }
 return node;
}
function findCaseInsensitive(node:any,key:string):any{
 if(!node||typeof node!=="object"||Array.isArray(node))return undefined;
 if(node[key]!==undefined)return node[key];
 const match=Object.keys(node).find(k=>k.toLowerCase()===key.toLowerCase());
 return match===undefined?undefined:node[match];
}
function parseOfferRows(input:any):ParsedOffer[]{
 const node=unwrapOfferContainer(input);
 if(!node||typeof node!=="object")return [];
 const entries:Array<[string,any]>=Array.isArray(node)
  ?node.map((raw:any,index:number)=>[asText(raw?.operator??raw?.operator_code??raw?.code??raw?.name??("operator-"+index)),raw])
  :Object.entries(node);
 return entries.map(([rawOperator,source]:[string,any])=>{
  const operator=asText(rawOperator);
  const raw=unwrapOfferContainer(source);
  const usd=Number(raw?.cost??raw?.price_usd??raw?.price);
  const count=Number(raw?.count??raw?.qty??raw?.quantity??raw?.stock??raw?.Qty);
  const rateWindows=getRateWindows(raw);
  if(!/^[a-zA-Z0-9._-]{1,80}$/.test(operator)||!Number.isFinite(usd)||usd<=0||!Number.isFinite(count)||count<0)return null;
  const selectedRate=parseDeliveryRate(raw);
  const rate=selectedRate.rate;
  return {operator,usd,count,rate,displayRate:rate,rateWindow:selectedRate.window,rateWindows,rateSource:"5sim"};
 }).filter((x):x is ParsedOffer=>x!==null);
}
// Share the latest 5SIM prices payload for five seconds per Edge Function instance.
// Concurrent requests for the same service/country join one upstream request.
const pricesResponseCache = new Map<string,{data:any;expiresAt:number}>();
const pricesResponseInflight = new Map<string,Promise<any>>();
async function getCachedPricesResponse(country:string,service:string):Promise<any>{
 const key=country.toLowerCase()+":"+service.toLowerCase();
 const cached=pricesResponseCache.get(key);
 if(cached&&cached.expiresAt>Date.now())return cached.data;
 let pending=pricesResponseInflight.get(key);
 if(!pending){
  pending=(async()=>{
   const path="/guest/prices?country="+encodeURIComponent(country)+"&product="+encodeURIComponent(service);
   let response:any;
   try{response=await apiGet(path);}
   catch{
    await new Promise(resolve=>setTimeout(resolve,350));
    response=await apiGet(path);
   }
   if(!response.ok&&(response.status===429||response.status>=500)){
    await new Promise(resolve=>setTimeout(resolve,350));
    response=await apiGet(path);
   }
   if(!response.ok||!response.data||typeof response.data!=="object")
    throw problem("Current number prices could not be verified. Please try again shortly.",503,"PRICE_UNAVAILABLE");
   pricesResponseCache.set(key,{data:response.data,expiresAt:Date.now()+5000});
   return response.data;
  })().finally(()=>{pricesResponseInflight.delete(key);});
  pricesResponseInflight.set(key,pending);
 }
 return await pending;
}
async function applyManualRateOverrides(offers:ProviderOffer[],service:string,country:string,admin:any):Promise<ProviderOffer[]>{
 if(!offers.length)return offers;
 const canonicalCountry=manualRateCountry(country),now=new Date().toISOString();
 const {data,error}=await admin.from("sparkle_number_delivery_rate_overrides")
  .select("operator,rate_percent,expires_at")
  .eq("service",service.toLowerCase()).eq("country",canonicalCountry)
  .gt("expires_at",now).in("operator",offers.map(x=>x.operator));
 if(error){
  // Manual overrides are optional. A table/query issue must not hide real 5SIM operators.
  // Continue with the provider's current verified delivery-rate data.
  console.warn("[sparkle-5sim-manual-rate-lookup]",JSON.stringify({service,country:canonicalCountry,message:error.message}));
  return offers;
 }
 const overrides=new Map<string,{rate:number;expiresAt:string}>(
  (data||[]).map((row:any)=>[String(row.operator).toLowerCase(),{rate:Number(row.rate_percent),expiresAt:String(row.expires_at)}])
 );
 return offers.map(offer=>{
  const override=overrides.get(offer.operator.toLowerCase());
  if(!override||!Number.isFinite(override.rate)||override.rate<0||override.rate>100)return offer;
  const rate=Number(override.rate.toFixed(2));
  return {...offer,rate,displayRate:rate,rateWindow:"rate3",rateWindows:{...offer.rateWindows,rate3:rate},
   rateSource:"manual_override",manualRateExpiresAt:override.expiresAt};
 });
}
async function getProductOffers(country:string,service:string,admin:any):Promise<ProviderOffer[]>{
 const pc=providerCountry(country);
 if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service))throw problem("Choose a valid verification service.",400,"INVALID_SERVICE");
 const pricesData=await getCachedPricesResponse(pc,service);
 // Supplier balance is checked only during purchase, after customer wallet and PIN checks.
 const providerBalance=Number.POSITIVE_INFINITY;
 // 5SIM may wrap prices in data and return country-first or product-first maps.
 let root:any=pricesData;
 for(let depth=0;depth<3;depth++){
  if(root&&typeof root==="object"&&!Array.isArray(root)&&root.data&&typeof root.data==="object")root=root.data;
  else break;
 }
 const findKey=(node:any,key:string)=>{
  if(!node||typeof node!=="object"||Array.isArray(node))return undefined;
  if(node[key]!==undefined)return node[key];
  const match=Object.keys(node).find(k=>k.toLowerCase()===key.toLowerCase());
  return match===undefined?undefined:node[match];
 };
 const countryAliases=pc==="usa"?["usa","us"]:pc==="us"?["us","usa"]:[pc];
 let productNode:any=null;
 for(const countryKey of countryAliases){
  productNode=findKey(findKey(root,countryKey),service);
  if(productNode)break;
 }
 if(!productNode){
  const serviceNode=findKey(root,service);
  for(const countryKey of countryAliases){
   productNode=findKey(serviceNode,countryKey);
   if(productNode)break;
  }
 }
 // Some 5SIM responses wrap country/product maps inside result, payload or products.
 // Search those known wrappers as a compatibility fallback before reporting no stock.
 if(!productNode||!parseOfferRows(productNode).length){
  const queue:any[]=[root],seen=new Set<any>();
  while(queue.length&&!productNode){
   const node=queue.shift();
   if(!node||typeof node!=="object"||seen.has(node))continue;
   seen.add(node);
   for(const countryKey of countryAliases){
    const countryNode=findKey(node,countryKey);
    const candidate=findKey(countryNode,service);
    if(candidate&&parseOfferRows(candidate).length){productNode=candidate;break;}
   }
   if(productNode)break;
   const serviceNode=findKey(node,service);
   if(serviceNode){
    for(const countryKey of countryAliases){
     const candidate=findKey(serviceNode,countryKey);
     if(candidate&&parseOfferRows(candidate).length){productNode=candidate;break;}
    }
   }
   if(productNode)break;
   for(const wrapper of ["data","result","response","payload","products","prices","items","rows"]){
    const child=node[wrapper];
    if(child&&typeof child==="object"&&!seen.has(child))queue.push(child);
   }
  }
 }
 if(!productNode||typeof productNode!=="object")throw problem("This service is not currently available for the selected country.",409,"NO_STOCK");
 const parsed=parseOfferRows(productNode),rows=parsed.filter(x=>x.count>0);
 if(!rows.length)throw problem("No operator currently has this service in stock for the selected country.",409,"NO_STOCK");
 const fx=await usdToNgn();
 // Keep all in-stock offers visible; unavailable supplier balance disables purchase, not catalogue visibility.
 const rawOffers:ProviderOffer[]=rows.map(x=>({...x,fx,providerCostNgn:money(x.usd*fx*1.02),providerBalanceUsd:providerBalance}));
 const offers=await applyManualRateOverrides(rawOffers,service,country,admin);
 // Every offer in this cohort is ranked against the same 3-hour period.
 const recommendationWindow=selectRecommendationWindow(offers);
 const ratedOffers:ProviderOffer[]=offers.map(x=>{
  const value=recommendationWindow?x.rateWindows[recommendationWindow]:null;
  const rate=value===null?null:Number(value.toFixed(2));
  return {...x,rate,displayRate:rate,rateWindow:recommendationWindow};
 });
 console.info("[sparkle-5sim-rate-audit]",JSON.stringify({
  country:pc,service,rate_source:"5sim_guest_prices_rate3_with_admin_override",
  rate_policy:"fixed_3_hour_comparison_window",
  recommendation_window:recommendationWindow,
  recommendation_metric:"5SIM Statistics · 3 hours",
  fetched_at:new Date().toISOString(),
  offers:ratedOffers.map(x=>({operator:x.operator,delivery_rate:x.rate,display_rate:x.displayRate,rate_window:x.rateWindow??null,rate_source:x.rateSource??"5sim",reported_windows:x.rateWindows,count:x.count}))
 }));
 ratedOffers.sort((a,b)=>{
  const ar=a.rate??-1,br=b.rate??-1;
  if(ar!==br)return br-ar;
  return a.operator.localeCompare(b.operator);
 });
 return ratedOffers;
}
async function bestOffer(country:string,service:string,requestedOperator="smart",admin:any):Promise<ProviderOffer>{
 const offers=await getProductOffers(country,service,admin);
 if(!requestedOperator||requestedOperator==="any"||requestedOperator==="smart"){
  const recommended=recommendedOffer(offers,service,country);
  if(recommended)return recommended;
  const automatic=automaticFallbackOffer(offers);
  if(automatic)return automatic;
  throw problem("5SIM has not supplied a verified delivery rate for this service and country. Sparkle will not recommend an operator by price.",503,"RATE_UNAVAILABLE");
 }
 const chosen=offers.find(x=>x.operator.toLowerCase()===requestedOperator.toLowerCase());
 if(!chosen)throw problem("That operator is no longer available. Choose another operator and check the price again.",409,"OPERATOR_UNAVAILABLE");
 if(chosen.count<=0)throw problem("That operator is out of stock.",409,"NO_STOCK");
 if(chosen.usd>chosen.providerBalanceUsd)throw problem("This operator is temporarily unavailable. No Sparkle wallet funds were used.",503,"PROVIDER_BALANCE_LOW");
 return chosen;
}

async function getCatalogServicesForCountry(country:string):Promise<any[]>{
 const pc=providerCountry(country);
 const response=await apiGet("/guest/products/"+encodeURIComponent(pc)+"/any");
 if(!response.ok||!response.data||typeof response.data!=="object")throw problem("The live service catalogue could not be loaded. Please try again shortly.",503,"CATALOG_UNAVAILABLE");
 let root:any=response.data?.data&&typeof response.data.data==="object"?response.data.data:response.data;
 if(!Array.isArray(root)&&root&&typeof root==="object"){
  const wrapped=root.products??root.Products??root.items??root.Items;
  if(wrapped&&(Array.isArray(wrapped)||typeof wrapped==="object"))root=wrapped;
 }
 const entries:Array<[string,any]>=Array.isArray(root)
  ?root.map((item:any,index:number)=>[asText(item?.product??item?.Product??item?.code??item?.Code??item?.slug??item?.name??item?.Name??("service-"+index)),item])
  :Object.entries(root||{});
 const items:any[]=[];
 for(const [rawCode,raw] of entries){
  const code=asText(rawCode).toLowerCase();
  if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(code)||!raw||typeof raw!=="object")continue;
  const product:any=raw;
  const categoryRaw=product.Category??product.category??product.type??product.Type;
  const category=typeof categoryRaw==="string"?categoryRaw.trim().toLowerCase():"";
  if(category&&category!=="activation")continue;
  const stockRaw=product.Qty??product.qty??product.quantity??product.count??product.Count;
  const hasStock=stockRaw!==undefined&&stockRaw!==null&&stockRaw!=="";
  const stock=hasStock?Number(stockRaw):null;
  if(hasStock&&(!Number.isFinite(stock)||stock<=0))continue;
  items.push({code,name:serviceDisplayName(code),country,network:"Live availability",stock:Number.isFinite(stock)?stock:null,available_countries:[country],country_availability_loaded:true});
 }
 const unique=new Map<string,any>();
 for(const item of items)if(!unique.has(item.code))unique.set(item.code,item);
 return [...unique.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
async function getGlobalCatalogServices():Promise<any[]>{
 const response=await apiGet("/guest/products/any/any");
 if(!response.ok||!response.data||typeof response.data!=="object")throw problem("The global service list is temporarily unavailable.",503,"CATALOG_UNAVAILABLE");
 let root:any=response.data?.data&&typeof response.data.data==="object"?response.data.data:response.data;
 if(!Array.isArray(root)&&root&&typeof root==="object"){
  const wrapped=root.products??root.Products??root.items??root.Items;
  if(wrapped&&(Array.isArray(wrapped)||typeof wrapped==="object"))root=wrapped;
 }
 const entries:Array<[string,any]>=Array.isArray(root)
  ?root.map((item:any,index:number)=>[asText(item?.product??item?.Product??item?.code??item?.Code??item?.slug??item?.name??item?.Name??("service-"+index)),item])
  :Object.entries(root||{});
 const items:any[]=[];
 for(const [rawCode,raw] of entries){
  const code=asText(rawCode).toLowerCase();
  if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(code)||!raw||typeof raw!=="object")continue;
  const product:any=raw;
  const categoryRaw=product.Category??product.category??product.type??product.Type;
  const category=typeof categoryRaw==="string"?categoryRaw.trim().toLowerCase():"";
  if(category!=="activation")continue;
  const stockRaw=product.Qty??product.qty??product.quantity??product.count??product.Count;
  const hasStock=stockRaw!==undefined&&stockRaw!==null&&stockRaw!=="";
  const stock=hasStock?Number(stockRaw):null;
  if(hasStock&&(!Number.isFinite(stock)||stock<=0))continue;
  items.push({code,name:serviceDisplayName(code),network:"Live availability",stock:Number.isFinite(stock)?stock:null,available_countries:[],country_availability_loaded:false});
 }
 const unique=new Map<string,any>();
 for(const item of items)if(!unique.has(item.code))unique.set(item.code,item);
 const result=[...unique.values()].sort((a,b)=>a.name.localeCompare(b.name));
 if(!result.length)throw problem("No activation services are currently listed.",503,"CATALOG_UNAVAILABLE");
 return result;
}

async function getCountriesForService(service:string):Promise<string[]>{
 if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service))throw problem("Choose a valid verification service.",400,"INVALID_SERVICE");
 const response=await apiGet("/guest/prices?product="+encodeURIComponent(service));
 if(!response.ok||!response.data||typeof response.data!=="object")throw problem("Current country availability could not be verified. Please try again.",503,"COUNTRIES_UNAVAILABLE");
 let root:any=response.data;
 for(let depth=0;depth<3;depth++){
  if(root&&typeof root==="object"&&!Array.isArray(root)&&root.data&&typeof root.data==="object")root=root.data;
  else break;
 }
 const result=new Set<string>();
 const addCountry=(rawCode:string,node:any)=>{
  const key=asText(rawCode).toLowerCase();
  if(!/^[a-z0-9][a-z0-9-]{1,39}$/.test(key)||!node||typeof node!=="object"||Array.isArray(node))return;
  const serviceNode=findCaseInsensitive(unwrapOfferContainer(node),service);
  if(serviceNode&&parseOfferRows(serviceNode).some(offer=>offer.count>0)){
   result.add(key==="usa"?"us":key==="canada"?"ca":key);
  }
 };
 // 5SIM commonly returns country -> product -> operator. Some responses are product -> country -> operator.
 for(const [key,node] of Object.entries(root||{})){
  if(!node||typeof node!=="object"||Array.isArray(node))continue;
  addCountry(key,node);
  const nested=node as any;
  if(key.toLowerCase()===service){
   const serviceOffers=unwrapOfferContainer(nested);
   for(const [countryCode,offers] of Object.entries(serviceOffers||{})){
    if(parseOfferRows(offers).some(offer=>offer.count>0)){
     const c=countryCode.toLowerCase();
     if(/^[a-z0-9][a-z0-9-]{1,39}$/.test(c))result.add(c==="usa"?"us":c==="canada"?"ca":c);
    }
   }
  }
 }
 // Also accept country entries wrapped one level deeper by the upstream API.
 for(const [key,node] of Object.entries(root||{})){
  if(!node||typeof node!=="object"||Array.isArray(node))continue;
  const nested=(node as any).data;
  if(nested&&typeof nested==="object")addCountry(key,nested);
 }
 return [...result].sort((a,b)=>a==="us"?-1:b==="us"?1:a==="ca"?-1:b==="ca"?1:a.localeCompare(b));
}

function selectRecommendationWindow(offers:ProviderOffer[]):string|null{
 // RATE_WINDOW_PRIORITY is fixed to rate3 (3 hours) so each operator and
 // every admin override is compared using the same 5SIM Statistics period.
 const positive=(window:string)=>offers.filter(x=>x.operator.toLowerCase()!=="any"&&x.count>0&&
   x.rateWindows[window]!==null&&Number.isFinite(x.rateWindows[window])&&x.rateWindows[window]!>0&&x.rateWindows[window]!<=100).length;
 return RATE_WINDOW_PRIORITY.find(w=>positive(w)>0)??null;
}
function recommendedOffer(offers:ProviderOffer[],_service:string,_country:string):ProviderOffer|undefined{
 // Recalculate from the latest 5SIM feed after its short cache expires.
 // Every in-stock operator is compared in the same selected time window.
 const window=selectRecommendationWindow(offers);
 if(!window)return undefined;
 const rated=offers.filter(x=>x.operator.toLowerCase()!=="any"&&x.count>0&&
  x.rateWindows[window]!==null&&Number.isFinite(x.rateWindows[window])&&
  x.rateWindows[window]!>0&&x.rateWindows[window]!<=100);
 if(!rated.length)return undefined;
 // Highest verified 5SIM 3-hour rate wins; equal rates prefer lower supplier cost.
 const winner=[...rated].sort((a,b)=>b.rateWindows[window]!-a.rateWindows[window]!||
  a.usd-b.usd||a.operator.localeCompare(b.operator))[0];
 winner.rate=Number(winner.rateWindows[window]!.toFixed(2));
 winner.displayRate=winner.rate;
 winner.rateWindow=window;
 return winner;
 }
async function bestOffer(country:string,service:string,requestedOperator="smart",admin:any):Promise<ProviderOffer>{
 const offers=await getProductOffers(country,service,admin);
 if(!requestedOperator||requestedOperator==="any"||requestedOperator==="smart"){
  const recommended=recommendedOffer(offers,service,country);
  if(recommended)return recommended;
  const automatic=automaticFallbackOffer(offers);
  if(automatic)return automatic;
  throw problem("5SIM has not supplied a verified delivery rate for this service and country. Sparkle will not recommend an operator by price.",503,"RATE_UNAVAILABLE");
 }
 const chosen=offers.find(x=>x.operator.toLowerCase()===requestedOperator.toLowerCase());
 if(!chosen)throw problem("That operator is no longer available. Choose another operator and check the price again.",409,"OPERATOR_UNAVAILABLE");
 if(chosen.count<=0)throw problem("That operator is out of stock.",409,"NO_STOCK");
 if(chosen.usd>chosen.providerBalanceUsd)throw problem("This operator is temporarily unavailable. No Sparkle wallet funds were used.",503,"PROVIDER_BALANCE_LOW");
 return chosen;
}

function selectRecommendationWindow(offers:ProviderOffer[]):string|null{
 // RATE_WINDOW_PRIORITY is fixed to rate3 (3 hours) so each operator and
 // every admin override is compared using the same 5SIM Statistics period.
 const positive=(window:string)=>offers.filter(x=>x.operator.toLowerCase()!=="any"&&x.count>0&&
   x.rateWindows[window]!==null&&Number.isFinite(x.rateWindows[window])&&x.rateWindows[window]!>0&&x.rateWindows[window]!<=100).length;
 return RATE_WINDOW_PRIORITY.find(w=>positive(w)>0)??null;
}
function recommendedOffer(offers:ProviderOffer[],_service:string,_country:string):ProviderOffer|undefined{
 // Recalculate from the latest 5SIM feed after its short cache expires.
 // Every in-stock operator is compared in the same selected time window.
 const window=selectRecommendationWindow(offers);
 if(!window)return undefined;
 const rated=offers.filter(x=>x.operator.toLowerCase()!=="any"&&x.count>0&&
  x.rateWindows[window]!==null&&Number.isFinite(x.rateWindows[window])&&
  x.rateWindows[window]!>0&&x.rateWindows[window]!<=100);
 if(!rated.length)return undefined;
 // Highest verified 5SIM 3-hour rate wins; equal rates prefer lower supplier cost.
 const winner=[...rated].sort((a,b)=>b.rateWindows[window]!-a.rateWindows[window]!||
  a.usd-b.usd||a.operator.localeCompare(b.operator))[0];
 winner.rate=Number(winner.rateWindows[window]!.toFixed(2));
 winner.displayRate=winner.rate;
 winner.rateWindow=window;
 return winner;
 }
async function getQuote(country:string,service:string,serverId:string,requestedOperator="any",admin:any){
 const profile=validateRoute(serverId,country,service);
 if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service))throw problem("Choose a valid verification service.",400,"INVALID_SERVICE");
 if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(requestedOperator))throw problem("Choose a valid operator.",400,"INVALID_OPERATOR");
 const offer=await bestOffer(country,service,requestedOperator,admin);
 const sellingPrice=money(offer.providerCostNgn*(1+profile.markup/100));
 if(!Number.isFinite(sellingPrice)||sellingPrice<=0)throw problem("Current number prices could not be verified.",503,"PRICE_UNAVAILABLE");
 const chosen=requestedOperator==="any"?"any":offer.operator;
 return {code:service,name:serviceDisplayName(service),country,network:"Available network",
  operator:chosen,operator_label:operatorDisplayName(chosen==="any"?"any":offer.operator),
  selling_price_ngn:sellingPrice,server_id:"server1",server_label:"Live number catalogue",
  stock:offer.count,rate:offer.rate,delivery_rate:offer.rate,rate_available:offer.rate!==null,rate_window:offer.rateWindow??null,rate_window_label:"3-hour",rate_source:offer.rateSource??"5sim",markup_percent:profile.markup,
  provider_cost_ngn:offer.providerCostNgn,provider_cost_usd:offer.usd,
  provider_operator:offer.operator,fx_rate:offer.fx};
}

/* Read the authenticated 5SIM user profile before reserving the customer's wallet.
   5SIM documents GET /v1/user/profile as the source of the account balance. */
async function providerProfile(): Promise<{ balance: number }> {
  const response = await apiGet("/user/profile");
  if (!response.ok || !response.data || typeof response.data !== "object") {
    console.error("[sparkle-5sim-profile] profile request failed", { status: response.status });
    throw problem("Could not verify the 5SIM supplier balance. Please try again shortly.", 503, "SUPPLIER_UNAVAILABLE");
  }
  const profile = response.data?.data && typeof response.data.data === "object"
    ? response.data.data
    : response.data;
  const rawBalance = profile?.balance ?? profile?.Balance;
  const balance = Number(rawBalance);
  if (rawBalance === undefined || rawBalance === null || rawBalance === "" ||
      !Number.isFinite(balance) || balance < 0) {
    console.error("[sparkle-5sim-profile] profile balance missing or invalid", { status: response.status });
    throw problem("Could not verify the 5SIM supplier balance. Please try again shortly.", 503, "SUPPLIER_UNAVAILABLE");
  }
  return { balance };
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


/* Verify a Virtual Number PIN against the authenticated user's stored hash.
   This deliberately uses the existing PIN hash format and lockout policy locally,
   avoiding a fragile Edge-Function-to-Edge-Function HTTP call during checkout. */
async function verifyStoredTransactionPin(pin: string, stored: string): Promise<boolean> {
  const [saltHex, expected] = String(stored || "").split(":");
  if (!saltHex || !expected || !/^[0-9a-f]{32}$/i.test(saltHex)) return false;
  const saltBytes = saltHex.match(/.{2}/g);
  if (!saltBytes || saltBytes.length !== 16) return false;
  const salt = new Uint8Array(saltBytes.map((byte) => parseInt(byte, 16)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    key,
    256,
  );
  const actual = Array.from(new Uint8Array(bits))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return /^[0-9a-f]{64}$/i.test(expected) && actual === expected;
}

async function verifyNumberPurchasePin(admin: any, userId: string, pin: string): Promise<{ body: Obj; status: number }> {
  if (!/^\d{4,6}$/.test(pin)) {
    return { status: 400, body: { success: false, code: "INVALID_PIN", message: "Enter a valid 4-digit transaction PIN." } };
  }

  const { data: record, error: readError } = await admin
    .from("sparkle_transaction_pins")
    .select("pin_hash, failed_attempts, locked_until")
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    console.error("[sparkle-number-pin] security record lookup failed", { code: readError.code || "unknown" });
    return { status: 503, body: { success: false, code: "PIN_RECORD_UNAVAILABLE", message: "We couldn't access your PIN security record. Please try again." } };
  }
  if (!record) {
    return { status: 404, body: { success: false, code: "PIN_NOT_SET", message: "You haven't created a transaction PIN yet. Create one in your Profile." } };
  }

  if (record.locked_until && new Date(record.locked_until).getTime() > Date.now()) {
    const remainingMinutes = Math.max(1, Math.ceil((new Date(record.locked_until).getTime() - Date.now()) / 60000));
    const message = `Your transaction PIN is locked. Try again in about ${remainingMinutes} minute(s).`;
    return { status: 429, body: { success: false, code: "PIN_LOCKED", message } };
  }

  let valid = false;
  try {
    valid = await verifyStoredTransactionPin(pin, record.pin_hash);
  } catch (error) {
    console.error("[sparkle-number-pin] hash verification failed", { message: String((error as Error)?.message || "unknown") });
    return { status: 503, body: { success: false, code: "PIN_VERIFY_FAILED", message: "A system error occurred while checking your PIN." } };
  }

  if (!valid) {
    const attempts = Number(record.failed_attempts ?? 0) + 1;
    const locked = attempts >= 5;
    const { error: updateError } = await admin
      .from("sparkle_transaction_pins")
      .update({
        failed_attempts: locked ? 0 : attempts,
        locked_until: locked ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null,
      })
      .eq("user_id", userId);

    if (updateError) {
      console.error("[sparkle-number-pin] failed-attempt update failed", { code: updateError.code || "unknown" });
      return { status: 503, body: { success: false, code: "PIN_UPDATE_FAILED", message: "Incorrect PIN, but we couldn't update the security record. Please try again." } };
    }

    const message = locked
      ? "Incorrect transaction PIN. You have reached the maximum attempts. Your PIN is locked for 15 minutes."
      : `Incorrect transaction PIN. Please try again. ${5 - attempts} attempt(s) remaining.`;
    // Match the existing PIN endpoint: an incorrect PIN is a normal 200 response
    // so the customer sees the message and can re-enter it without creating an order.
    return { status: 200, body: { success: false, verified: false, message } };
  }

  const { error: resetError } = await admin
    .from("sparkle_transaction_pins")
    .update({ failed_attempts: 0, locked_until: null, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (resetError) {
    console.error("[sparkle-number-pin] successful-verification reset failed", { code: resetError.code || "unknown" });
    return { status: 503, body: { success: false, code: "PIN_UPDATE_FAILED", message: "We couldn't complete PIN verification. Please try again." } };
  }

  return { status: 200, body: { success: true, verified: true, message: "Transaction PIN verified successfully." } };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ success: false, message: "POST required." }, 405);
  let ctx: any;
  let walletReservationSucceeded = false;
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
    const pinVerification = await verifyNumberPurchasePin(ctx.admin, ctx.user.id, pin);
    if (pinVerification.body?.success !== true) {
      return reply(pinVerification.body, pinVerification.status);
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
    try { supplierProfile = await providerProfile(); }
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

      // The RPC response can be lost after the atomic reservation committed.
      // Check the existing request before reporting failure or allowing a retry.
      const reservationCheck = await ctx.admin.from("sparkle_sms_otp_orders")
        .select("request_id,status")
        .eq("user_id", ctx.user.id)
        .eq("request_id", requestId)
        .maybeSingle();
      if (reservationCheck.error || reservationCheck.data) {
        walletReservationSucceeded = Boolean(reservationCheck.data);
        return reply({
          success: false,
          status: "unknown",
          request_id: requestId,
          message: "Sparkle could not confirm the wallet reservation response. Check this order again before retrying; do not submit a second purchase."
        }, 202);
      }
      throw problem("Sparkle could not reserve your wallet. No supplier order was sent.", 503, "RESERVATION_FAILED");
    }
    walletReservationSucceeded = true;
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
    if (walletReservationSucceeded) {
      try {
        await finalize(ctx.admin, requestId, "unknown", { status: "unknown" },
          "An unexpected error occurred after wallet reservation; supplier outcome requires reconciliation.");
      } catch (_) {}
      return reply({
        success: false,
        status: "unknown",
        request_id: requestId,
        message: "Sparkle is confirming the supplier result for this order. Your funds remain reserved while it is checked. Do not buy again yet."
      }, 202);
    }
    return publicError(e, "The number purchase could not be completed. No supplier order was sent.");
  }
});
