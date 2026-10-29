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
function validateRoute(serverId: string, country: string, service: string): { markup: number; label: string } {
  const profile = profileByServer[serverId];
  if (!profile || serverId !== "server1") throw problem("The live number catalogue is currently unavailable.", 400, "INVALID_SERVER");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service)) throw problem("Choose a valid verification service.", 400, "INVALID_SERVICE");
  providerCountry(country);
  return profile;
}
async function getProviderCountries(): Promise<any[]> {
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
  return [...unique.values()].sort((a, b) =>
    a.code === "us" ? -1 : b.code === "us" ? 1 : a.code === "ca" ? -1 : b.code === "ca" ? 1 : a.name.localeCompare(b.name)
  );
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
      providerProfileCache = { balance, expiresAt: Date.now() + 30_000 };
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
 const parsed=parseOfferRows(productNode),rows=parsed.filter(x=>x.count>0);
 if(!rows.length)throw problem("No operator currently has this service in stock for the selected country.",409,"NO_STOCK");
 const fx=await usdToNgn();
 // Keep all in-stock offers visible; unavailable supplier balance disables purchase, not catalogue visibility.
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
 const affordable=offers.filter(x=>x.usd<=x.providerBalanceUsd);
 if(!requestedOperator||requestedOperator==="any"){
  const automatic=affordable.find(x=>x.operator.toLowerCase()==="any");
  if(automatic)return automatic;
  const cheapest=[...affordable].sort((a,b)=>a.usd-b.usd||b.count-a.count)[0];
  if(cheapest)return cheapest;
  throw problem("This number option is temporarily unavailable. No Sparkle wallet funds were used.",503,"PROVIDER_BALANCE_LOW");
 }
 if(requestedOperator==="smart"){
  // Offers are ordered by delivery rate, then price and stock. Prefer a named operator
  // so the quote and eventual purchase use the exact same option.
  const best=affordable.find(x=>x.operator.toLowerCase()!=="any");
  if(best)return best;
  const automatic=affordable.find(x=>x.operator.toLowerCase()==="any");
  if(automatic)return automatic;
  throw problem("This number option is temporarily unavailable. No Sparkle wallet funds were used.",503,"PROVIDER_BALANCE_LOW");
 }
 const chosen=offers.find(x=>x.operator.toLowerCase()===requestedOperator.toLowerCase());
 if(!chosen)throw problem("That operator is no longer available. Choose another operator and check the price again.",409,"OPERATOR_UNAVAILABLE");
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
 if(!response.ok||!response.data||typeof response.data!=="object")throw problem("Current country availability could not be verified.",503,"COUNTRIES_UNAVAILABLE");
 const root:any=response.data?.data&&typeof response.data.data==="object"?response.data.data:response.data;
 const serviceNode:any=root[service]||root[service.toUpperCase()]||root;
 if(!serviceNode||typeof serviceNode!=="object"||Array.isArray(serviceNode))throw problem("No countries currently list this service.",409,"NO_STOCK");
 const catalogueCountries=await getProviderCountries();
 const result:string[]=[];
 for(const item of catalogueCountries){
  const code=asText(item?.code).toLowerCase();
  if(!code)continue;
  let providerCode:string;
  try{providerCode=providerCountry(code);}catch{continue;}
  const countryNode=serviceNode[providerCode]||serviceNode[providerCode.toUpperCase()]||serviceNode[code]||serviceNode[code.toUpperCase()];
  if(!countryNode||typeof countryNode!=="object"||Array.isArray(countryNode))continue;
  if(parseOfferRows(countryNode).some(offer=>offer.count>0))result.push(code);
 }
 return result;
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
 const operator=asText(body.operator||"any").toLowerCase();
 try{
  if(serverId!=="server1")throw problem("Use the live number catalogue.",400,"INVALID_SERVER");
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
   const offers=await getProductOffers(country,service);
   const affordable=offers.filter(x=>x.usd<=x.providerBalanceUsd);
   const automatic=affordable.find(x=>x.operator.toLowerCase()==="any")||
     [...affordable].sort((a,b)=>a.usd-b.usd||b.count-a.count)[0]||
     [...offers].sort((a,b)=>a.usd-b.usd||b.count-a.count)[0];
   const automaticRow={operator:"any",operator_label:"Automatic routing",selling_price_ngn:money(automatic.providerCostNgn*(1+profileByServer.server1.markup/100)),stock:automatic.count,rate:automatic.rate,available:automatic.usd<=automatic.providerBalanceUsd};
   const specific=offers.filter(x=>x.operator.toLowerCase()!=="any").map(x=>({
     operator:x.operator,operator_label:operatorDisplayName(x.operator),selling_price_ngn:money(x.providerCostNgn*(1+profileByServer.server1.markup/100)),stock:x.count,rate:x.rate,available:x.usd<=x.providerBalanceUsd
   }));
   return reply({success:true,data:{country,service,currency:"NGN",operators:[automaticRow,...specific]}});
  }
  if(action==="price"){
   if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(service))throw problem("Choose a valid service.",400,"INVALID_SERVICE");
   const quote=await getQuote(country,service,serverId,operator);
   return reply({success:true,data:safeServiceQuote(quote)});
  }
  throw problem("Unsupported catalogue action.",400,"INVALID_ACTION");
 }catch(e){return publicError(e);}
});
