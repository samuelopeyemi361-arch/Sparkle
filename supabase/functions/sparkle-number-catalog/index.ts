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
  if(virtual)return "Virtual "+virtual[1];
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
function manualRateCountry(country: string): string {
  const value = asText(country).toLowerCase().replace(/[_\s]+/g, "-");
  if (["us","usa","united-states"].includes(value)) return "us";
  if (["ca","canada"].includes(value)) return "ca";
  if (["de","germany"].includes(value)) return "de";
  return value;
}
function validateRoute(serverId: string, country: string, service: string): { markup: number; label: string } {
  const profile = profileByServer[serverId];
  if (!profile || serverId !== "server1") throw problem("The live number catalogue is currently unavailable.", 400, "INVALID_SERVER");
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
let providerProfileCache: { balance: number; expiresAt: number } | null = null;
let providerProfilePromise: Promise<{ balance: number }> | null = null;

// Validate the authenticated provider account before showing live quotes.
async function providerProfile(): Promise<{ balance: number }> {
  if (providerProfileCache && providerProfileCache.expiresAt > Date.now()) {
    return { balance: providerProfileCache.balance };
  }
  if (!providerProfilePromise) {
    providerProfilePromise = (async () => {
      const result = await apiGet("/user/profile");
      const id = Number(result.data?.id);
      const balance = Number(result.data?.balance);
      if (!result.ok || !result.data || !Number.isFinite(id) || id <= 0 ||
          !Number.isFinite(balance) || balance < 0) {
        if (result.status === 401 || result.status === 403) {
          throw problem("The number service connection is not verified. Please check the configured 5SIM key.", 503, "PROVIDER_AUTH_FAILED");
        }
        throw problem("Sparkle could not verify the number service account. No wallet funds were used.", 503, "PROVIDER_AUTH_FAILED");
      }
      providerProfileCache = { balance, expiresAt: Date.now() + 5_000 };
      return { balance };
    })().finally(() => { providerProfilePromise = null; });
  }
  return await providerProfilePromise;
}

async function usdToNgn(): Promise<number> {
  const now = Date.now();
  const maxSourceAgeMs = 36 * 60 * 60 * 1000;
  const usableCachedRate = () => {
    if (!fxCache) return null;
    const sourceAge = now - fxCache.sourceUpdatedAt;
    return sourceAge >= 0 && sourceAge <= maxSourceAgeMs ? fxCache.rate : null;
  };
  if (fxCache && now - fxCache.updatedAt < 60 * 60 * 1000 && usableCachedRate() !== null) {
    return fxCache.rate;
  }
  let response: Response;
  try {
    response = await fetch("https://open.er-api.com/v6/latest/USD", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    // Reuse only a previously verified exchange rate, and never one older than 36 hours.
    const fallbackRate = usableCachedRate();
    if (fallbackRate !== null) return fallbackRate;
    throw problem("Live Naira pricing is temporarily unavailable. Please try again shortly.", 503, "FX_UNAVAILABLE");
  }
  const data: any = await response.json().catch(() => null);
  const last = Number(data?.time_last_update_unix);
  const rate = Number(data?.rates?.NGN);
  const age = Math.floor(Date.now() / 1000) - last;
  if (!response.ok || data?.result !== "success" || !Number.isFinite(rate) || rate < 100 || rate > 10000 ||
      !Number.isFinite(last) || age < 0 || age > 36 * 60 * 60) {
    const fallbackRate = usableCachedRate();
    if (fallbackRate !== null) return fallbackRate;
    throw problem("Live Naira pricing is temporarily unavailable. Please try again shortly.", 503, "FX_UNAVAILABLE");
  }
  fxCache = { rate, updatedAt: now, sourceUpdatedAt: last * 1000 };
  return rate;
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

function parseOfferRows(node:any):ParsedOffer[]{
 if(!node||typeof node!=="object"||Array.isArray(node))return [];
 return Object.entries(node).map(([operator,raw]:[string,any])=>{
  const usd=Number(raw?.cost),count=Number(raw?.count);
  const rateWindows=getRateWindows(raw);
  if(!/^[a-zA-Z0-9._-]{1,80}$/.test(operator)||!Number.isFinite(usd)||usd<=0||!Number.isFinite(count)||count<0)return null;
  const selectedRate=parseDeliveryRate(raw);
  const rate=selectedRate.rate;
  const displayRate=rate;
  return {operator,usd,count,rate,displayRate,rateWindow:selectedRate.window,rateWindows,rateSource:"5sim"};
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
   const response=await apiGet("/guest/prices?country="+encodeURIComponent(country)+"&product="+encodeURIComponent(service));
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
  console.error("[sparkle-5sim-manual-rate-lookup]",JSON.stringify({service,country:canonicalCountry,message:error.message}));
  throw problem("Sparkle could not verify its manual delivery-rate settings. Please refresh and try again.",503,"RATE_OVERRIDE_UNAVAILABLE");
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
 const [balanceResult,pricesData]=await Promise.all([
  providerProfile().catch(()=>null),getCachedPricesResponse(pc,service)
 ]);
 const providerBalance=balanceResult?.balance??0;
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
 if(productNode&&typeof productNode==="object"&&!Array.isArray(productNode)&&Object.keys(productNode).length===1){
  const nested=findKey(productNode,pc);
  if(nested&&typeof nested==="object")productNode=nested;
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
  const serviceNode=node[service]??node[service.toUpperCase()]??node[service.toLowerCase()];
  if(serviceNode&&typeof serviceNode==="object"&&!Array.isArray(serviceNode)&&parseOfferRows(serviceNode).some(offer=>offer.count>0)){
   result.add(key==="usa"?"us":key==="canada"?"ca":key);
  }
 };
 // 5SIM commonly returns country -> product -> operator. Some responses are product -> country -> operator.
 for(const [key,node] of Object.entries(root||{})){
  if(!node||typeof node!=="object"||Array.isArray(node))continue;
  addCountry(key,node);
  const nested=node as any;
  if(key.toLowerCase()===service||key.toLowerCase()===service.toLowerCase()){
   for(const [countryCode,offers] of Object.entries(nested)){
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
 const winner=[...rated].sort((a,b)=>b.rateWindows[window]!-a.rateWindows[window]!||a.operator.localeCompare(b.operator))[0];
 winner.rate=Number(winner.rateWindows[window]!.toFixed(2));
 winner.displayRate=winner.rate;
 winner.rateWindow=window;
 return winner;
 }

async function getDisplayQuote(country:string,service:string,serverId:string,requestedOperator="any",admin:any){
 const profile=validateRoute(serverId,country,service);
 if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service))throw problem("Choose a valid service.",400,"INVALID_SERVICE");
 if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(requestedOperator))throw problem("Choose a valid operator.",400,"INVALID_OPERATOR");
 const offers=await getProductOffers(country,service,admin);
 const smartRequest=requestedOperator==="smart"||requestedOperator==="any";
 const offer=smartRequest
   ?recommendedOffer(offers,service,country)
   :offers.find(x=>x.operator.toLowerCase()===requestedOperator.toLowerCase());
 if(!offer&&smartRequest)throw problem("5SIM has not supplied a verified delivery rate for this service and country. Sparkle will not recommend an operator by price.",503,"RATE_UNAVAILABLE");
 if(!offer||offer.count<=0)throw problem("That operator is no longer available. Choose another operator and check the price again.",409,"OPERATOR_UNAVAILABLE");
 // Catalogue quotes are independent of transient supplier-profile checks. The purchase function rechecks supplier balance before any wallet reservation or supplier order.
 const sellingPrice=money(offer.providerCostNgn*(1+profile.markup/100));
 if(!Number.isFinite(sellingPrice)||sellingPrice<=0)throw problem("Current number prices could not be verified. Please try again later.",503,"PRICE_UNAVAILABLE");
 const chosen=offer.operator;
 return {code:service,name:serviceDisplayName(service),country,network:"Available network",
  operator:chosen,operator_label:operatorDisplayName(chosen==="any"?"any":offer.operator),recommendation_label:requestedOperator==="smart"&&offer.rate!==null&&offer.rate>0?"Recommended · Highest delivery rate":null,
  selling_price_ngn:sellingPrice,server_id:"server1",server_label:"Live number catalogue",
  stock:offer.count,rate:offer.rate,delivery_rate:offer.rate,rate_available:offer.rate!==null,rate_window:offer.rateWindow??null,rate_window_label:"3-hour",rate_source:offer.rateSource??"5sim",markup_percent:profile.markup,
  provider_cost_ngn:offer.providerCostNgn,provider_cost_usd:offer.usd,
  provider_operator:offer.operator,fx_rate:offer.fx};
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
function safeServiceQuote(q:any){
 return {code:q.code,name:q.name,country:q.country,network:q.network||"Available network",
  operator:q.operator,operator_label:q.operator_label,selling_price_ngn:q.selling_price_ngn,
  rate:q.rate??null,delivery_rate:q.rate??null,rate_available:q.rate!==null,
  rate_window:q.rate_window??null,rate_window_label:q.rate_window_label??"3-hour",rate_source:q.rate_source??"5sim",
  server_id:"server1",stock:q.stock};
}

function publicError(error: any, fallback = "The number service is temporarily unavailable. Please try again shortly.") {
  const code = String(error?.code || "");
  const status = Number(error?.status);
  if (code === "RATE_UNAVAILABLE") return reply({ success: false, code, message: error.message }, 503);
  if (code === "NO_STOCK") return reply({ success: false, code, message: "No number is currently available for this service and country. Try again later." }, 409);
  if (code === "PRICE_CHANGED") return reply({ success: false, code, message: "The Sparkle price changed. No money was deducted; check the current price again." }, 409);
  if (code === "INSUFFICIENT_FUNDS") return reply({ success: false, code, message: "Insufficient Sparkle wallet balance. Please fund your wallet and try again." }, 402);
  if (code === "AUTH_REQUIRED") return reply({ success: false, code, message: "Please sign in again to continue." }, 401);
  if (code === "INVALID_SERVER" || code === "INVALID_COUNTRY" || code === "INVALID_SERVICE" || code === "INVALID_ROUTE") {
    return reply({ success: false, code, message: error.message || "Choose a valid server, country and service." }, status || 400);
  }
  if (code === "SERVER_UNAVAILABLE") return reply({ success: false, code, message: error.message }, 503);
  if (code === "CONFIG_MISSING") return reply({ success: false, code, message: "The number service is temporarily unavailable. Please try again shortly." }, 503);
  if (code === "PROVIDER_AUTH_FAILED") return reply({ success: false, code, message: "The number service is not ready yet. Please try again later." }, 503);
  if (code === "PROVIDER_BALANCE_LOW") return reply({ success: false, code, message: "This number option is temporarily unavailable. Please try another option later." }, 503);
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

Deno.serve(async (req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
 if(req.method!=="POST")return reply({success:false,message:"POST required."},405);
 let ctx:any;
 try{ctx=await userContext(req);}catch(e){return publicError(e,"Please sign in again to continue.");}
 const body:Obj=await req.json().catch(()=>({}));
 const action=asText(body.action||"services");
 const country=asText(body.country||"us").toLowerCase();
 const serverId=asText(body.serverId||body.server_id||"server1").toLowerCase();
 const service=asText(body.serviceName||body.service||"").toLowerCase();
 const operator=asText(body.operator||"smart").toLowerCase()==="any"?"smart":asText(body.operator||"smart").toLowerCase();
 try{
  if(serverId!=="server1")throw problem("Use the live number catalogue.",400,"INVALID_SERVER");
  if(action.startsWith("manual-rate-")){
   const {data:profile,error:profileError}=await ctx.admin.from("profiles").select("role").eq("id",ctx.user.id).maybeSingle();
   if(profileError||profile?.role!=="admin")throw problem("Admin access required.",403,"ADMIN_REQUIRED");
   if(action==="manual-rate-list"){
    let q=ctx.admin.from("sparkle_number_delivery_rate_overrides").select("*").order("updated_at",{ascending:false});
    if(body.service)q=q.eq("service",asText(body.service).toLowerCase());
    if(body.country)q=q.eq("country",asText(body.country).toLowerCase());
    const {data,error}=await q;
    if(error)throw problem("Could not load manual delivery rates.",500,"RATE_OVERRIDE_ERROR");
    return reply({success:true,data:{overrides:data||[]}});
   }
   if(action==="manual-rate-save"){
    const s=asText(body.service).toLowerCase(),c=asText(body.country).toLowerCase(),o=asText(body.operator).toLowerCase();
    const rate=Number(body.rate_percent),expiry=asText(body.expires_at);
    if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(s)||!/^[a-z0-9][a-z0-9-]{1,39}$/.test(c)||!/^[a-z0-9._-]{1,80}$/.test(o)||!Number.isFinite(rate)||rate<0||rate>100||!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.now())throw problem("Enter a valid service, country, operator, rate from 0 to 100, and future expiry.",400,"INVALID_OVERRIDE");
    const row={service:s,country:c,operator:o,rate_percent:rate,expires_at:new Date(expiry).toISOString(),note:asText(body.note)||null,created_by:ctx.user.id,updated_at:new Date().toISOString()};
    const {data,error}=await ctx.admin.from("sparkle_number_delivery_rate_overrides").upsert(row,{onConflict:"service,country,operator"}).select("*").single();
    if(error)throw problem("Could not save this manual delivery rate.",500,"RATE_OVERRIDE_ERROR");
    await ctx.admin.from("sparkle_admin_audit_logs").insert({actor_user_id:ctx.user.id,action:"number_delivery_rate_override_saved",details:{service:s,country:c,operator:o,rate_percent:rate,expires_at:row.expires_at}});
    return reply({success:true,data:{override:data}});
   }
   if(action==="manual-rate-delete"){
    const id=asText(body.id);
    if(!/^[0-9a-f-]{36}$/i.test(id))throw problem("Choose a valid override.",400,"INVALID_OVERRIDE");
    const {error}=await ctx.admin.from("sparkle_number_delivery_rate_overrides").delete().eq("id",id);
    if(error)throw problem("Could not delete this manual delivery rate.",500,"RATE_OVERRIDE_ERROR");
    await ctx.admin.from("sparkle_admin_audit_logs").insert({actor_user_id:ctx.user.id,action:"number_delivery_rate_override_deleted",details:{id}});
    return reply({success:true});
   }
  }
  if(action==="countries"){
   const countries=await getProviderCountries();
   return reply({success:true,data:{countries}});
  }
  providerCountry(country);
  if(action==="services"){
   let services:any[];
   try{services=await getGlobalCatalogServices();}
   catch{services=await getCatalogServicesForCountry(country);}
   if(!services.length)services=await getCatalogServicesForCountry(country);
   return reply({success:true,data:{country,country_name:country==="us"?"United States":country==="ca"?"Canada":country,currency:"NGN",services}});
  }
  if(action==="service-countries"){
   const available_countries=await getCountriesForService(service);
   return reply({success:true,data:{service,available_countries}});
  }
  if(action==="operators"){
   if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service))throw problem("Choose a valid service first.",400,"INVALID_SERVICE");
   const offers=await getProductOffers(country,service,admin);
   const recommended=recommendedOffer(offers,service,country);
   const recommendationWindow=selectRecommendationWindow(offers);
   const specific=offers.filter(x=>x.operator.toLowerCase()!=="any").map(x=>{
     const available=x.count>0;
     const isRecommended=!!recommended&&x.operator===recommended.operator;
     // Display all operators using the same live comparison window.
      const displayRate=recommendationWindow?x.rateWindows[recommendationWindow]:null;
      const displayWindow=recommendationWindow;
     return {operator:x.operator,operator_label:operatorDisplayName(x.operator),selling_price_ngn:money(x.providerCostNgn*(1+profileByServer.server1.markup/100)),stock:x.count,in_stock:x.count>0,available,rate:displayRate,delivery_rate:displayRate,rate_available:displayRate!==null,rate_window:displayWindow??null,rate_window_label:"3-hour",rate_source:x.rateSource??"5sim",rate_windows:x.rateWindows,recommended:isRecommended,recommendation_label:isRecommended?"Recommended · Highest 5SIM 3-hour rate":null,unavailable_reason:available?null:(x.count<=0?"No stock":"Supplier USD balance is too low to fulfil this option")};
   });
   return reply({success:true,data:{country,service,currency:"NGN",recommended_operator:recommended?.operator||null,default_operator:recommended?.operator||null,operators:[...specific.filter(x=>x.recommended),...specific.filter(x=>!x.recommended)]}});
  }
  if(action==="price"){
   if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service))throw problem("Choose a valid service.",400,"INVALID_SERVICE");
   const quote=await getDisplayQuote(country,service,serverId,operator,ctx.admin);
   return reply({success:true,data:safeServiceQuote(quote)});
  }
  throw problem("Unsupported catalogue action.",400,"INVALID_ACTION");
 }catch(e){return publicError(e);}
});
