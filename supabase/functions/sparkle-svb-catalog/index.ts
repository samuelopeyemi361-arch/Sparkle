import { createClient } from "npm:@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const BASE = "https://softviralboost.com.ng/api/v2";
type Obj = Record<string, any>;
const reply = (data: unknown, status=200) => new Response(JSON.stringify(data), {status, headers:{...cors,"Content-Type":"application/json","Cache-Control":"no-store"}});
async function providerFetch(path:string, apiKey:string, init:RequestInit={}) {
  return await fetch(BASE+path,{...init,headers:{Authorization:"Bearer "+apiKey,Accept:"application/json",...(init.headers||{})},signal:init.signal||AbortSignal.timeout(20000)});
}
function errorText(_data:any, fallback:string) { return fallback; }

Deno.serve(async(req)=>{
 if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
 if(req.method!=="GET" && req.method!=="POST") return reply({success:false,error:"GET or POST required."},405);
 const key=Deno.env.get("SOFTVIRALBOOST_API_KEY");
 if(!key) return reply({success:false,error:"SMS OTP catalogue is temporarily unavailable."},503);
 let action="services",country="us",serviceName="";
 try {
  if(req.method==="GET"){const u=new URL(req.url);action=u.searchParams.get("action")||"services";country=u.searchParams.get("country")||"us";serviceName=u.searchParams.get("serviceName")||"";}
  else {const b=await req.json();action=String(b.action||"services");country=String(b.country||"us");serviceName=String(b.serviceName||"");}
 } catch { return reply({success:false,error:"Invalid request body."},400); }
 country=country.toLowerCase();
 if(!/^[a-z]{2,3}$/.test(country)) return reply({success:false,error:"Invalid country code."},400);
 if(action!=="countries" && action!=="services" && action!=="price") return reply({success:false,error:"Action must be countries, services, or price."},400);
 if(action==="price" && !/^[a-zA-Z0-9_-]{1,80}$/.test(serviceName)) return reply({success:false,error:"Invalid service name."},400);
 const path=action==="countries"?"/countries":"/services?country="+encodeURIComponent(country);
 try {
  const res=await providerFetch(path,key,{method:"GET"});
  const rawBody=await res.text(); let data:any=null; try{data=JSON.parse(rawBody)}catch{}
  if(!res.ok || !data || data.status==="error" || data.success===false)
   return reply({success:false,error:"The number catalogue is temporarily unavailable. Please try again shortly."},res.status>=400&&res.status<500?res.status:502);
  if(action==="countries"){
   const rawCountries=Array.isArray(data.countries)?data.countries:Array.isArray(data.data?.countries)?data.data.countries:Array.isArray(data.data)?data.data:[];
   const countries=rawCountries.map((c:Obj)=>{
    const code=String(c.code||c.country_code||"").trim().toLowerCase();
    const name=String(c.name||c.country_name||code).trim();
    if(!code||!name)return null;
    return {code,name,dial:String(c.dial||""),flag:String(c.flag||""),network:String(c.network||"Global Carrier Hub")};
   }).filter(Boolean);
   return reply({success:true,data:{countries}});
  }
  const rawServices=Array.isArray(data.services)?data.services:Array.isArray(data.data?.services)?data.data.services:[];
  const countryName=String(data.country_name||data.countryName||country.toUpperCase());
  const network=String(data.network||"Provider default route");
  const mapService=(s:Obj)=>{
   const code=String(s.code||s.service||s.serviceName||"").trim();
   const name=String(s.name||s.service_name||s.serviceName||code).trim();
   const cost=Number(s.cost);
   if(!code||!name||!Number.isFinite(cost)||cost<=0)return null;
   const rawStock=Number(s.stock??s.available??s.quantity??0);
   return {code,name,country:String(s.country||country),network:String(s.network||network),stock:Number.isFinite(rawStock)?Math.max(0,rawStock):0,selling_price_ngn:Math.round((cost*1.75+Number.EPSILON)*100)/100};
  };
  if(action==="price"){
   const found=rawServices.find((s:Obj)=>String(s.code||s.service||s.serviceName||"").toLowerCase()===serviceName.toLowerCase());
   if(!found)return reply({success:false,error:"This service is not available for the selected country."},404);
   const safe=mapService(found);
   if(!safe)return reply({success:false,error:"Sparkle could not verify the current selling price. Please try again later."},502);
   return reply({success:true,data:safe});
  }
  const services=rawServices.map((s:Obj)=>mapService(s)).filter(Boolean);
  return reply({success:true,data:{country,country_name:countryName,network,currency:"NGN",services}});
 } catch {
  return reply({success:false,error:"Could not reach the number service. No Sparkle wallet funds were used."},502);
 }
});