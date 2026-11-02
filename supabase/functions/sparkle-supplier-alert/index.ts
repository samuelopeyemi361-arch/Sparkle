import { createClient } from "npm:@supabase/supabase-js@2";

const json = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers:{"Content-Type":"application/json"}});
const clean = (v:unknown,max=500) => String(v??"").replace(/[\\r\\n\\t]+/g," ").trim().slice(0,max);
const esc = (v:string) => v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));

Deno.serve(async (req:Request) => {
 if(req.method!=="POST") return json({success:false},405);
 const url=Deno.env.get("SUPABASE_URL")||"", serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 if(!url||!serviceKey) return json({success:false,error:"Supplier alert is not configured."},500);
 const body=await req.json().catch(()=>null);
 if(!body||typeof body!=="object") return json({success:false},400);
 const admin=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});

 if(body.action==="test"){
  const auth=req.headers.get("Authorization")||"", token=auth.startsWith("Bearer ")?auth.slice(7):"";
  if(!token||token===serviceKey) return json({success:false,error:"Sign in as an administrator to test email."},401);
  const {data,error}=await admin.auth.getUser(token);
  if(error||!data.user) return json({success:false,error:"Admin session is invalid."},401);
  const {data:profile,error:profileError}=await admin.from("profiles").select("email,role").eq("id",data.user.id).maybeSingle();
  if(profileError||profile?.role!=="admin"||!profile.email) return json({success:false,error:"Only an administrator can test alerts."},403);
  const result = await sendEmail([clean(profile.email,254)],"Sparkle supplier alert — Test email","<h2>Sparkle email test successful</h2><p>Supplier alert email delivery is connected. No wallet or supplier balance was changed.</p>");
  return json(result, result.status);
 }

 if(req.headers.get("Authorization")!==`Bearer ${serviceKey}`) return json({success:false},401);
 const supplier=clean(body.supplier,40), service=clean(body.service,100), reference=clean(body.reference,120), reason=clean(body.reason,500);
 if(!supplier||!service||!reason) return json({success:false,error:"Missing supplier alert details."},400);

 const dedupeKey=reference
  ? `${supplier.toLowerCase()}:${service.toLowerCase()}:${reference.toLowerCase()}`
  : `${supplier.toLowerCase()}:${service.toLowerCase()}:${Math.floor(Date.now()/60000)}`;
 let eventId="";
 const {data:inserted,error:insertError}=await admin.from("supplier_balance_alert_events").insert({
  dedupe_key:dedupeKey,supplier,service,order_reference:reference||null,reason,email_status:"sending"
 }).select("id").maybeSingle();
 if(insertError?.code==="23505"){
  const {data:existing,error}=await admin.from("supplier_balance_alert_events").select("id,email_status").eq("dedupe_key",dedupeKey).maybeSingle();
  if(error||!existing) return json({success:false,error:"Could not load the existing alert."},500);
  if(existing.email_status==="sent") return json({success:true,emailSent:true,deduplicated:true});
  eventId=existing.id;
  await admin.from("supplier_balance_alert_events").update({email_status:"sending",email_error:null,reason}).eq("id",eventId);
 }else if(insertError||!inserted?.id){
  console.error("[sparkle-supplier-alert] insert failed",insertError?.message||"unknown");
  return json({success:false,error:"Could not record supplier alert."},500);
 }else eventId=inserted.id;

 const {data:admins,error:adminError}=await admin.from("profiles").select("email").eq("role","admin").not("email","is",null);
 const recipients=[...new Set((admins||[]).map((x:any)=>clean(x.email,254).toLowerCase()).filter((x:string)=>/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(x)))];
 if(adminError||!recipients.length){
  await admin.from("supplier_balance_alert_events").update({email_status:"needs_admin_email",email_error:adminError?.message||"No admin email configured."}).eq("id",eventId);
  return json({success:false,logged:true,emailSent:false,reason:"admin_email_missing"},503);
 }
 const html=`<div style="font-family:Arial,sans-serif;color:#172033"><h2>Sparkle supplier balance alert</h2><p>A supplier returned an insufficient-balance response while processing a customer purchase.</p><table><tr><td>Supplier</td><td>${esc(supplier)}</td></tr><tr><td>Service</td><td>${esc(service)}</td></tr><tr><td>Reference</td><td>${esc(reference||"Not available")}</td></tr><tr><td>Supplier response</td><td>${esc(reason)}</td></tr><tr><td>Detected at</td><td>${new Date().toISOString()}</td></tr></table><p>Please fund the supplier account. This alert is private to Sparkle administrators.</p></div>`;
 const sent=await sendEmail(recipients,`Sparkle supplier balance alert — ${service}`,html);
 await admin.from("supplier_balance_alert_events").update({
  admin_email:recipients.join(","),email_status:sent.success?"sent":"send_failed",
  email_error:sent.success?null:clean(sent.error,300),notified_at:sent.success?new Date().toISOString():null
 }).eq("id",eventId);
 return json({success:sent.success,logged:true,emailSent:sent.success,reason:sent.error||undefined},sent.status);
});

async function sendEmail(to:string[],subject:string,html:string){
 const apiKey=Deno.env.get("RESEND_API_KEY"),from=Deno.env.get("SUPPLIER_ALERT_FROM_EMAIL");
 if(!apiKey||!from) return {success:false,error:"Email sender configuration is missing.",status:503};
 try{
  const response=await fetch("https://api.resend.com/emails",{
   method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
   body:JSON.stringify({from,to,subject,html}),signal:AbortSignal.timeout(15000)
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok) return {success:false,error:clean((result as any)?.message||response.statusText,300),status:502};
  return {success:true,status:200};
 }catch(e){return {success:false,error:clean(e instanceof Error?e.message:"Email delivery failed.",300),status:502};}
}
