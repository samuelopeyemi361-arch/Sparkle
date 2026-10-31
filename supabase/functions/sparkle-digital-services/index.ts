import { createClient } from "npm:@supabase/supabase-js@2";

const BASE = "https://api.gsubz.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
}
function str(v: unknown) { return String(v ?? "").trim(); }
function money2(v: number) { return Math.ceil((v + Number.EPSILON) * 100) / 100; }
function markup(which: "social" | "sms") {
  // Sparkle owner-approved social-media markup: exactly 25% per plan.
  // Keep Bulk SMS pricing configuration unchanged.
  if (which === "social") return 25;
  const raw = Number(Deno.env.get("SPARKLE_BULK_SMS_MARKUP_PERCENT") ?? "30");
  return Number.isFinite(raw) && raw >= 0 && raw <= 300 ? raw : 30;
}
function reserveBufferPercent() {
  const n = Number(Deno.env.get("SPARKLE_DIGITAL_RESERVE_BUFFER_PERCENT") ?? "20");
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 20;
}
function statusOf(d: any) {
  return str(d?.status ?? d?.data?.status ?? d?.content?.status ?? d?.data?.content?.status ?? d?.transaction_status)
    .toLowerCase().replace(/[\s-]+/g, "_");
}
function isSuccess(s: string) { return ["successful", "success", "completed", "complete"].includes(s); }
function isFailure(s: string) { return ["failed", "failure", "error", "rejected", "cancelled", "canceled"].includes(s); }
function socialOrderOf(d: any) {
  return d?.order ?? d?.content?.order ?? d?.data?.order ?? d?.data?.content?.order ?? d?.result?.order ?? null;
}
function socialOrderStatus(order: any) {
  return str(order?.status).toLowerCase().replace(/[\s-]+/g, "_");
}
function socialOrderProgress(order: any, quantity = 0) {
  if (!order || typeof order !== "object") return null;
  const numeric = (value: unknown) => {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  return {
    status: str(order.status) || "Processing",
    start_count: numeric(order.start_count ?? order.startCount),
    remains: numeric(order.remains),
    quantity: Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null
  };
}
function socialPaymentSuccess(status: string) {
  return isSuccess(status) || ["transaction_successful", "transaction_success"].includes(status);
}
function socialPaymentFailure(status: string) {
  return isFailure(status) || ["transaction_failed", "transaction_failure", "transaction_refunded"].includes(status);
}
function socialOrderHasNoDelivery(order: any, quantity: number) {
  const status = socialOrderStatus(order);
  const terminalFailure = ["failed", "failure", "error", "rejected", "cancelled", "canceled", "refunded"].includes(status);
  const remains = Number(order?.remains);
  // A full refund is safe only when the supplier confirms the entire requested
  // quantity remains undelivered. Partial or ambiguous failures need review.
  return terminalFailure
    && Number.isSafeInteger(quantity) && quantity > 0
    && Number.isFinite(remains) && remains >= quantity;
}
function numericPrice(v: unknown): number {
  if (typeof v === "number") return v;
  if (v === null || v === undefined || String(v).trim() === "") return NaN;
  const cleaned = String(v).replace(/[,₦$\\s]/g, "").replace(/[^0-9.+-]/g, "");
  return cleaned ? Number(cleaned) : NaN;
}
function arrayFromPlanContainer(node: any): any[] {
  if (Array.isArray(node)) return node;
  if (node && typeof node === "object") {
    return Object.entries(node).map(([key, value]) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? { _planKey: key, ...value }
        : { _planKey: key, value: key, displayName: String(value ?? key) });
  }
  return [];
}
function extractPlans(data: any): any[] {
  if (!data || typeof data !== "object") return [];
  const seen = new Set<any>();
  function visit(node: any, depth: number): any[] {
    if (!node || depth > 6 || typeof node !== "object" || seen.has(node)) return [];
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.some((item: any) => item && typeof item === "object" && (item.value != null || item.plan != null || item.api_price != null || item.apiPrice != null || item.displayName != null || item.name != null))) return node;
      for (const item of node) { const found = visit(item, depth + 1); if (found.length) return found; }
      return node;
    }
    for (const key of ["plans", "Plans", "data", "result", "results", "content", "items", "services", "socials", "response"]) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const child = node[key];
      if (key.toLowerCase() === "plans") {
        const arr = arrayFromPlanContainer(child);
        if (arr.length) return arr;
      }
      const found = visit(child, depth + 1);
      if (found.length) return found;
    }
    for (const [key, child] of Object.entries(node)) {
      if (["plans", "Plans", "data", "result", "results", "content", "items", "services", "socials", "response"].includes(key)) continue;
      const found = visit(child, depth + 1);
      if (found.length) return found;
    }
    return [];
  }
  return visit(data, 0);
}
function planCode(p: any) { return str(p?.value ?? p?.plan ?? p?.id ?? p?.code ?? p?.serviceID ?? p?.serviceId ?? p?.variation_code ?? p?.plan_id ?? p?.planId ?? p?._planKey); }
function planName(p: any) { return str(p?.displayName ?? p?.display_name ?? p?.name ?? p?.label ?? p?.title ?? p?.package_name ?? p?.packageName ?? p?.plan_name ?? p?.planName ?? p?.serviceName ?? p?.product_name ?? p?.productName ?? p?.description ?? planCode(p)); }
function parseDiscountPercent(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().replace(/,/g, "").replace(/%/g, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const pct = Number(cleaned);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
}
function catalogueDiscount(data: any): unknown {
  const queue: any[] = [data], seen = new Set<any>();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || Array.isArray(node) || seen.has(node)) continue;
    seen.add(node);
    if (node.discount !== null && node.discount !== undefined) return node.discount;
    for (const key of ["data", "result", "results", "content", "response", "payload"]) {
      if (node[key] && typeof node[key] === "object") queue.push(node[key]);
    }
  }
  return null;
}
function apiPriceFromCandidate(candidate: any, depth = 0): number {
  if (depth > 5 || candidate === null || candidate === undefined) return NaN;
  if (typeof candidate !== "object") {
    const n = numericPrice(candidate);
    return Number.isFinite(n) && n > 0 ? n : NaN;
  }
  for (const key of ["ngn", "naira", "value", "amount", "price", "rate", "cost", "per1000", "per_1000", "per_thousand", "perThousand"]) {
    if (Object.prototype.hasOwnProperty.call(candidate, key)) {
      const n = apiPriceFromCandidate(candidate[key], depth + 1);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return NaN;
}
function planRate(p: any, defaultDiscount?: unknown) {
  const explicitApiKeys = new Set([
    "apiprice", "apipriceperthousand", "apipriceperunit", "apipriceper1000", "apiprice1k", "apipricengn", "apipriceng",
    "apirate", "apirateperthousand", "apirateperunit", "apirateper1000", "apirate1k",
    "apicost", "apicostngn", "apiamount", "apiamountngn", "costapi", "priceapi", "rateapi", "amountapi",
    "supplierprice", "supplierpriceperthousand", "suppliercost", "supplierrate", "supplieramount",
    "providerprice", "providerpriceperthousand", "providercost", "providerrate", "provideramount",
    "wholesaleprice", "wholesalecost", "wholesalerate", "wholesaleamount", "priceperthousandapi", "costpriceapi"
  ]);
  const genericApiContextKeys = new Set(["price", "rate", "cost", "amount", "value"]);
  const apiContextNames = new Set(["api", "apipricing", "apicost", "supplier", "supplierpricing", "provider", "providerpricing", "wholesale", "wholesalepricing"]);
  const explicitCandidates: any[] = [];
  const contextualCandidates: any[] = [];
  const seen = new Set<any>();
  function walk(node: any, depth: number, inApiContext: boolean) {
    if (!node || typeof node !== "object" || depth > 7 || seen.has(node)) return;
    seen.add(node);
    const entries = Array.isArray(node) ? node.map((value, index) => [String(index), value] as [string, any]) : Object.entries(node);
    for (const [rawKey, candidate] of entries) {
      const key = String(rawKey).toLowerCase().replace(/[^a-z0-9]/g, "");
      const explicitName = explicitApiKeys.has(key)
        || /^(api|supplier|provider|wholesale)(price|cost|rate|amount)(ngn|naira|perthousand|per1000|perunit|1k)?$/.test(key)
        || /^(price|cost|rate|amount)(api|supplier|provider|wholesale)(ngn|naira|perthousand|per1000|perunit|1k)?$/.test(key);
      if (explicitName) explicitCandidates.push(candidate);
      else if (inApiContext && genericApiContextKeys.has(key)) contextualCandidates.push(candidate);
      if (candidate && typeof candidate === "object") walk(candidate, depth + 1, inApiContext || apiContextNames.has(key));
    }
  }
  walk(p, 0, false);
  for (const candidate of [...explicitCandidates, ...contextualCandidates]) {
    const rate = apiPriceFromCandidate(candidate);
    if (Number.isFinite(rate) && rate > 0) return rate;
  }
  // Only derive a supplier rate from a list price when an actual discount is supplied.
  const records = [p, p?.pricing, p?.prices, p?.costs].filter((x) => x && typeof x === "object" && !Array.isArray(x));
  for (const record of records) {
    const regular = numericPrice(record?.price ?? record?.normal_price ?? record?.normalPrice ?? record?.list_price ?? record?.listPrice);
    const discount = parseDiscountPercent(record?.discount ?? record?.api_discount ?? record?.apiDiscount ?? p?.discount ?? p?.api_discount ?? p?.apiDiscount ?? defaultDiscount);
    if (Number.isFinite(regular) && regular > 0 && discount !== null) {
      const apiRate = regular * (1 - discount / 100);
      if (Number.isFinite(apiRate) && apiRate > 0) return money2(apiRate);
    }
  }
  return NaN;
}
function normaliseSocialPlan(p: any, defaultDiscount?: unknown) {
  if (!p || typeof p !== "object") return null;
  const value = planCode(p), name = planName(p);
  const explicitApiRate = planRate(p, defaultDiscount);
  // Current catalogue exposes api_price separately from the normal display price.
  // Only use the API price (or an explicit supplier discount derived by planRate).
  // Never treat the public normal price as Sparkle's supplier cost.
  const rate = Number.isFinite(explicitApiRate) && explicitApiRate > 0 ? explicitApiRate : NaN;
  if (!value || !name) return null;
  const minRaw = Number(p?.min ?? p?.minimum ?? p?.min_quantity ?? p?.minQuantity ?? p?.min_order ?? p?.minOrder ?? 1);
  const maxRaw = Number(p?.max ?? p?.maximum ?? p?.max_quantity ?? p?.maxQuantity ?? p?.max_order ?? p?.maxOrder ?? 1000000);
  return {
    value, displayName: name,
    apiPricePerThousand: Number.isFinite(rate) && rate > 0 ? rate : null,
    priceAvailable: Number.isFinite(rate) && rate > 0,
    priceSource: Number.isFinite(explicitApiRate) && explicitApiRate > 0 ? "verified_api_price" : null,
    min: Number.isSafeInteger(minRaw) && minRaw > 0 ? minRaw : 1,
    max: Number.isSafeInteger(maxRaw) && maxRaw >= 1 ? Math.min(maxRaw, 1000000) : 1000000,
    category: str(p?.category ?? p?.platform ?? p?.service ?? p?.network ?? ""),
    description: str(p?.description ?? p?.details ?? p?.type ?? "")
  };
}
async function fetchSocialPlans() {
  const response = await fetch(`${BASE}/api/plans/?service=socials`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const rawText = await response.text();
  let data: any = null;
  try { data = JSON.parse(rawText); } catch {}
  if (!response.ok || !data) throw new Error(`Sparkle's social-media catalogue is temporarily unavailable (HTTP ${response.status}). Please refresh in a moment. No purchase has been made.`);
  const rawPlans = extractPlans(data);
  const defaultDiscount = catalogueDiscount(data);
  const plans = rawPlans.map((p: any) => normaliseSocialPlan(p, defaultDiscount)).filter((p: any) => p !== null);
  // Temporary structured diagnostic: records public supplier catalogue fields only, never API keys or wallet data.
  console.log("[sparkle-social-price-diagnostic]", JSON.stringify({
    rootKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 24) : [],
    rawPlanCount: rawPlans.length,
    parsedPlanCount: plans.length,
    pricedPlanCount: plans.filter((p: any) => p.priceAvailable).length,
    catalogueDiscount: defaultDiscount ?? null,
    sample: rawPlans.slice(0, 5).map((p: any) => ({
      fields: p && typeof p === "object" ? Object.keys(p).slice(0, 30) : [],
      value: p?.value ?? p?.plan ?? p?.id ?? p?.code ?? p?._planKey ?? null,
      name: p?.displayName ?? p?.display_name ?? p?.name ?? p?.label ?? p?.title ?? null,
      price: p?.price ?? p?.normal_price ?? p?.list_price ?? null,
      api_price: p?.api_price ?? p?.apiPrice ?? p?.api_price_per_thousand ?? p?.apiPricePerThousand ?? null,
      discount: p?.discount ?? p?.api_discount ?? p?.apiDiscount ?? null,
      pricingKeys: p?.pricing && typeof p.pricing === "object" ? Object.keys(p.pricing).slice(0, 12) : []
    }))
  }));
  if (!plans.length) {
    const keys = data && typeof data === "object" ? Object.keys(data).slice(0, 10).join(", ") : typeof data;
    throw new Error(`Sparkle received an unsupported social catalogue response (HTTP ${response.status}; fields: ${keys || "none"}). Please refresh later. No purchase has been made.`);
  }
  return plans;
}
function planQuote(plan: any, quantity: number) {
  if (!plan?.priceAvailable || !Number.isFinite(Number(plan.apiPricePerThousand)) || Number(plan.apiPricePerThousand) <= 0) {
    throw new Error("A verified live price is not available for this plan. Checkout remains disabled.");
  }
  const supplierEstimate = money2(plan.apiPricePerThousand * quantity / 1000);
  const estimate = Math.max(0.01, money2(supplierEstimate * (1 + markup("social") / 100)));
  const reserve = money2(estimate * (1 + reserveBufferPercent() / 100));
  return { supplierEstimate, estimatedRetail: estimate, maximumReserve: reserve, retailRatePerThousand: money2(plan.apiPricePerThousand * (1 + markup("social") / 100)) };
}
function validateSocialTargetLink(link: string, planName: string): string | null {
  let u: URL; try { u = new URL(link); } catch { return "Enter a valid profile or post URL."; }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return "Enter a public HTTPS profile or post link.";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "localhost" || host.endsWith(".local") || !host.includes(".")) return "Use a public profile or post link.";
  const n = planName.toLowerCase();
  const groups: Array<{ pattern: RegExp; domains: string[]; label: string }> = [
    { pattern: /instagram|\big\b|insta/, domains: ["instagram.com"], label: "Instagram" },
    { pattern: /tiktok|tik tok/, domains: ["tiktok.com"], label: "TikTok" },
    { pattern: /facebook|\bfb\b/, domains: ["facebook.com", "fb.watch"], label: "Facebook" },
    { pattern: /youtube|\byt\b|shorts/, domains: ["youtube.com", "youtu.be"], label: "YouTube" },
    { pattern: /telegram|\btg\b/, domains: ["t.me", "telegram.me"], label: "Telegram" },
    { pattern: /twitter|\bx\b/, domains: ["x.com", "twitter.com"], label: "X" }];
  const group = groups.find(g => g.pattern.test(n));
  if (group && !group.domains.some(d => host === d || host.endsWith(`.${d}`))) return `This plan expects a ${group.label} link. Check the target URL and try again.`;
  return null;
}
function normaliseNigerianNumber(raw: string): string | null {
  const n = raw.replace(/[\s().-]/g, "");
  if (/^0\d{10}$/.test(n)) return n;
  if (/^\+?234\d{10}$/.test(n)) return "0" + n.replace(/^\+?234/, "");
  return null;
}
function gsmUnits(message: string) {
  const normalised = message.replace(/₦/g, "N");
  const basic = /^[A-Za-z0-9@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/u;
  const extended = new Set(["^", "{", "}", "\\", "[", "~", "]", "|", "€"]);
  const chars = [...normalised];
  const unicode = !basic.test(normalised) && !chars.every((c) => basic.test(c) || extended.has(c));
  if (unicode) { const units = normalised.length; return { unicode: true, units, pages: units <= 70 ? 1 : Math.ceil(units / 67) }; }
  const units = chars.reduce((sum, c) => sum + (extended.has(c) ? 2 : 1), 0);
  return { unicode: false, units, pages: units <= 160 ? 1 : Math.ceil(units / 153) };
}
function bulkSmsQuote(body: Record<string, unknown>) {
  const sender = str(body.sender ?? body.from), message = str(body.message ?? body.msg), rawTo = str(body.recipients ?? body.to);
  if (!/^[A-Za-z]{3,11}$/.test(sender)) throw new Error("Sender ID must contain 3–11 letters only, with no spaces, numbers or symbols.");
  if (!message) throw new Error("Enter the SMS message you want to send.");
  if (message.length > 905) throw new Error("Messages must be 905 characters or fewer.");
  const rawNumbers = rawTo.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  const valid = rawNumbers.map(normaliseNigerianNumber).filter((x): x is string => !!x);
  const unique = [...new Set(valid)];
  if (!unique.length) throw new Error("Add at least one valid Nigerian phone number.");
  if (unique.length > 5000) throw new Error("Bulk SMS supports a maximum of 5,000 unique Nigerian numbers per send.");
  const segment = gsmUnits(message);
  const pageRateRaw = Number(Deno.env.get("GSUBZ_BULK_SMS_API_PAGE_RATE") ?? "5");
  const pageRate = Number.isFinite(pageRateRaw) && pageRateRaw > 0 && pageRateRaw <= 1000 ? pageRateRaw : 5;
  const supplierEstimate = money2(unique.length * segment.pages * pageRate);
  const estimatedRetail = Math.max(0.01, money2(supplierEstimate * (1 + markup("sms") / 100)));
  const maximumReserve = money2(estimatedRetail * (1 + reserveBufferPercent() / 100));
  return { sender, message, recipients: unique, recipientCount: unique.length, skippedCount: rawNumbers.length - unique.length,
    pagesPerRecipient: segment.pages, messageUnits: segment.units, usesUnicode: segment.unicode,
    supplierEstimate, estimatedRetail, maximumReserve, retailPerPagePerRecipient: money2(pageRate * (1 + markup("sms") / 100)) };
}
function retailFromSupplier(actualCost: number, quotedRetail: number, reservedAmount: number, which: "social" | "sms") {
  const safeActual = Number.isFinite(actualCost) && actualCost >= 0 ? actualCost : 0;
  const factor = 1 + markup(which) / 100;
  const calculated = money2((safeActual > 0 ? safeActual : quotedRetail / factor) * factor);
  return Math.min(reservedAmount, Math.max(0, calculated));
}
async function callPinVerifier(url: string, anonKey: string, authorization: string, pin: string) {
  const r = await fetch(`${url}/functions/v1/sparkle-transaction-pin`, { method: "POST",
    headers: { Authorization: authorization, apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "verify", pin }), signal: AbortSignal.timeout(15000) });
  const d: any = await r.json().catch(() => null); return { ok: r.ok && d?.success === true, data: d };
}
async function providerPost(path: string, key: string, entries: Record<string, string>) {
  const form = new FormData(); for (const [k, v] of Object.entries(entries)) form.append(k, v);
  const response = await fetch(`${BASE}${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    body: form, signal: AbortSignal.timeout(60000) });
  const data = await response.json().catch(() => null); return { response, data };
}
function makeRef(userId: string, raw: unknown) {
  const token = str(raw).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 70) || crypto.randomUUID().replace(/-/g, "");
  return { clientRequestId: token, reference: `SPKDIG-${userId.slice(0, 8)}-${token}`.slice(0, 100) };
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // Read-only diagnostic for the public GSubz catalogue; POST purchases remain session-authenticated below.
  if (req.method === "GET") {
    const u = new URL(req.url);
    if (u.searchParams.get("action") !== "social_catalogue_diagnostic") return reply({ success: false, error: "Read-only GET endpoint." }, 405);
    try {
      const upstream = await fetch(`${BASE}/api/plans/?service=socials`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      const rawText = await upstream.text();
      let payload: any = null; try { payload = JSON.parse(rawText); } catch {}
      const rawPlans = payload ? extractPlans(payload) : [];
      const fields = (x: any) => x && typeof x === "object" ? Object.keys(x).slice(0, 24) : [];
      const sample = rawPlans.slice(0, 5).map((p: any) => ({
        fields: fields(p), value: p?.value ?? p?.plan ?? p?.id ?? p?.code ?? p?.serviceID ?? p?._planKey ?? null,
        name: p?.displayName ?? p?.display_name ?? p?.name ?? p?.label ?? p?.title ?? null,
        hasApiPrice: p?.api_price != null || p?.apiPrice != null || p?.api_price_per_thousand != null || p?.apiPricePerThousand != null || p?.api_cost != null || p?.apiCost != null,
        hasDisplayPrice: p?.price != null
      }));
      const defaultDiscount = catalogueDiscount(payload);
      const normalised = rawPlans.map((p: any) => normaliseSocialPlan(p, defaultDiscount)).filter((p: any) => p !== null);
      return reply({ success: true, upstreamStatus: upstream.status, contentType: upstream.headers.get("content-type"),
        rootType: Array.isArray(payload) ? "array" : typeof payload, rootFields: fields(payload), rawTextIsJson: payload !== null,
        rawPlanCount: rawPlans.length, parsedPlanCount: normalised.length,
        pricedPlanCount: normalised.filter((p: any) => p.priceAvailable).length, sample });
    } catch {
      return reply({ success: false, error: "Could not reach the public GSubz plan catalogue right now." }, 502);
    }
  }
  if (req.method !== "POST") return reply({ success: false, error: "POST required" }, 405);
  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return reply({ success: false, error: "Sign in to Sparkle to continue." }, 401);
  const url = Deno.env.get("SUPABASE_URL"), anonKey = Deno.env.get("SUPABASE_ANON_KEY"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey) return reply({ success: false, error: "Sparkle digital-services authentication is not configured." }, 503);
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  const user = authData?.user;
  if (authError || !user) return reply({ success: false, error: "Your Sparkle session has expired. Sign in again." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ success: false, error: "Invalid request body." }, 400); }
  const action = str(body.action).toLowerCase();
  try {
    if (action === "social_plans") {
      const plans = await fetchSocialPlans();
      return reply({ success: true, plans: plans.map(p => ({ ...p, retailRatePerThousand: p.priceAvailable ? money2(Number(p.apiPricePerThousand) * (1 + markup("social") / 100)) : null })), currency: "NGN" });
    }
    if (action === "social_quote") {
      const plans = await fetchSocialPlans(), code = str(body.plan), quantity = Number(body.quantity), plan = plans.find(p => p.value === code);
      if (!plan) return reply({ success: false, error: "That social-media plan is no longer available. Refresh the catalogue." }, 409);
      if (!plan.priceAvailable) return reply({ success: false, error: "A verified current price is not available for this plan. No money has been reserved. Please refresh the catalogue later." }, 409);
      if (!Number.isSafeInteger(quantity) || quantity < plan.min || quantity > plan.max) return reply({ success: false, error: `Quantity must be a whole number between ${plan.min.toLocaleString("en-NG")} and ${plan.max.toLocaleString("en-NG")}.`, min: plan.min, max: plan.max }, 400);
      return reply({ success: true, ...planQuote(plan, quantity), quantity, plan: plan.value, planName: plan.displayName, min: plan.min, max: plan.max, currency: "NGN" });
    }
    if (action === "sms_quote") {
      try { const q = bulkSmsQuote(body); const { recipients: _recipients, ...publicQuote } = q;
        return reply({ success: true, ...publicQuote, currency: "NGN", providerPolicy: "The provider checks message content and sender eligibility before charging. Some bank/payment names, international brands, OTP/verification wording, bank-alert style messages and long digit sequences may be rejected." });
      } catch (e) { return reply({ success: false, error: e instanceof Error ? e.message : "Invalid bulk SMS request." }, 400); }
    }
    if (action === "check_order") {
      if (!serviceKey) return reply({ success: false, error: "Secure order-status checking is not configured." }, 503);
      const reference = str(body.reference);
      if (!/^SPKDIG-[A-Za-z0-9_-]{8,100}$/.test(reference)) return reply({ success: false, error: "Enter a valid Sparkle order reference." }, 400);
      const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
      const { data: tx, error: txError } = await admin.from("wallet_transactions").select("user_id,reference,amount,service,status,metadata").eq("reference", reference).eq("user_id", user.id).maybeSingle();
      if (txError || !tx) return reply({ success: false, error: "Order not found in your Sparkle account." }, 404);
      const meta: any = tx.metadata || {};
      const isSocial = meta.digitalKind === "social" && tx.service === "Social Media Market";
      if (["refunded", "failed"].includes(str(tx.status).toLowerCase())) return reply({ success: true, status: tx.status, reference, amount: Number(tx.amount), message: "This order has already been resolved." });
      if (str(tx.status).toLowerCase() === "successful" && !isSocial) return reply({ success: true, status: tx.status, reference, amount: Number(tx.amount), message: "Your order is complete." });
      const gsubzKey = Deno.env.get("GSUBZ_API_KEY");
      if (!gsubzKey) return reply({ success: false, status: "pending", reference, error: "Order status is temporarily unavailable. Your Sparkle order record remains safe; please check again shortly." }, 503);
      const providerRequestId = str(meta.providerRequestID);
      if (!providerRequestId) return reply({ success: false, status: "pending", reference, error: "The order reference is saved but its status reference is missing. Please contact Sparkle support before placing another order." }, 202);
      // GSubz verification accepts one lookup key at a time. Sparkle always saves
      // the unique requestID with the purchase, so use that canonical reference.
      const verifyFields: Record<string, string> = { api: gsubzKey, requestID: providerRequestId };
      const checked = await providerPost("/api/verify/", gsubzKey, verifyFields);
      const provider = checked.data, pStatus = statusOf(provider);
      const providerSuccess = isSocial ? socialPaymentSuccess(pStatus) : isSuccess(pStatus);
      const providerFailure = isSocial ? socialPaymentFailure(pStatus) : isFailure(pStatus);

      let order: any = null, orderStatus = "", progress: any = null;
      if (isSocial) {
        order = socialOrderOf(provider);
        orderStatus = socialOrderStatus(order);
        progress = socialOrderProgress(order, Number(meta.quantity || 0));

        if (checked.response.ok && order && socialOrderHasNoDelivery(order, Number(meta.quantity || 0))) {
          const refund = await admin.rpc("sparkle_social_refund_order", {
            p_user_id: user.id,
            p_reference: reference,
            p_provider_order: order,
            p_reason: "Supplier status confirmed that the social order was not delivered"
          });
          if (refund.error || refund.data?.success !== true) {
            const partial = refund.data?.status === "partial_or_unconfirmed";
            return reply({ success: false, status: partial ? "partial" : "pending", reference,
              orderProgress: progress,
              error: refund.data?.error || "The supplier confirmed an issue, but Sparkle could not safely complete the refund. Support reconciliation is required." }, 202);
          }
          return reply({ success: true, status: "refunded", reference, amount: Number(refund.data.amount || tx.amount),
            message: "The supplier confirmed that this order was not delivered. The full Sparkle wallet refund has been processed." });
        }

        {
          const updatedMetadata = {
            ...meta,
            provider_verification: provider,
            ...(progress ? { socialOrderProgress: progress } : {}),
            lastSocialStatusCheckAt: new Date().toISOString()
          };
          const saved = await admin.from("wallet_transactions").update({ metadata: updatedMetadata })
            .eq("reference", reference).eq("user_id", user.id).eq("service", "Social Media Market");
          if (saved.error) console.error("[sparkle-social-status-save]", saved.error.message);
        }

        if (order && ["partial", "partially_completed", "partially_complete", "cancelled", "canceled", "failed", "failure", "error", "rejected", "refunded"].includes(orderStatus)) {
          if (str(tx.status).toLowerCase() === "pending" && checked.response.ok && providerSuccess) {
            const actualCost = Number(provider?.amountPaid ?? provider?.amount ?? meta.quotedSupplierCost);
            const finalAmount = retailFromSupplier(actualCost, Number(meta.quotedRetail || tx.amount), Number(meta.reservedAmount || tx.amount), "social");
            const settled = await admin.rpc("sparkle_digital_wallet_action", {
              p_user_id: user.id, p_action: "success", p_reference: reference,
              p_amount: finalAmount, p_service: tx.service,
              p_metadata: { status_checked: true, provider_verification: provider, socialOrderProgress: progress,
                actual_supplier_cost: Number.isFinite(actualCost) ? actualCost : null, final_customer_charge: finalAmount }
            });
            if (settled.error || settled.data?.success !== true) return reply({ success: false, status: "pending", reference, orderProgress: progress,
              error: "The supplier reports partial delivery, but Sparkle could not settle the confirmed supplier charge. The order needs reconciliation." }, 202);
          }
          return reply({ success: false, status: "partial", reference, amount: Number(tx.amount), orderProgress: progress,
            message: ["cancelled", "canceled"].includes(orderStatus)
              ? "The supplier reports a cancellation or failure but has not confirmed that the full quantity was undelivered. No automatic full refund was issued. This order needs review."
              : "The supplier reports partial delivery or an unresolved failure. Sparkle has not issued an unsafe full refund. This order needs review." }, 202);
        }

        const socialTransactionFailure = providerFailure;
        if (str(tx.status).toLowerCase() === "successful" && checked.response.ok && socialTransactionFailure && !order) {
          const refund = await admin.rpc("sparkle_social_refund_order", {
            p_user_id: user.id, p_reference: reference,
            p_provider_order: { status: "failed" },
            p_reason: "Supplier verification confirmed the social transaction failed"
          });
          if (refund.error || refund.data?.success !== true) return reply({ success: false, status: "pending", reference,
            error: refund.data?.error || "The supplier confirmed failure, but Sparkle needs to reconcile the wallet refund." }, 202);
          return reply({ success: true, status: "refunded", reference, amount: Number(refund.data.amount || tx.amount),
            message: "The supplier confirmed failure. Your full Sparkle wallet refund has been processed." });
        }

        if (str(tx.status).toLowerCase() === "successful") {
          const deliveryStatus = progress?.status || "Progress unavailable";
          return reply({ success: true, status: "successful", reference, amount: Number(tx.amount), orderProgress: progress,
            deliveryStatus,
            message: progress
              ? `Order accepted. Delivery status: ${progress.status}.${progress.remains != null ? ` Remaining: ${Number(progress.remains).toLocaleString("en-NG")}.` : ""}${progress.start_count != null ? ` Starting count: ${Number(progress.start_count).toLocaleString("en-NG")}.` : ""}`
              : "The order payment was accepted. Delivery progress is not available right now; check again shortly." });
        }
      }

      if (checked.response.ok && providerSuccess) {
        const which = meta.digitalKind === "social" ? "social" : "sms";
        if (which === "sms" && provider?.amountPaid == null && provider?.amount == null) return reply({ success: false, status: "pending", reference, error: "The supplier confirmed the SMS status but did not return the final amount paid. Sparkle is keeping the reservation safe until the exact charge can be reconciled. Do not resend this campaign." }, 202);
        const actualCost = Number(provider?.amountPaid ?? provider?.amount ?? meta.quotedSupplierCost);
        const finalAmount = retailFromSupplier(actualCost, Number(meta.quotedRetail || tx.amount), Number(meta.reservedAmount || tx.amount), which);
        const result = await admin.rpc("sparkle_digital_wallet_action", { p_user_id: user.id, p_action: "success", p_reference: reference, p_amount: finalAmount, p_service: tx.service,
          p_metadata: { status_checked: true, provider_verification: provider, actual_supplier_cost: Number.isFinite(actualCost) ? actualCost : null,
            final_customer_charge: finalAmount, ...(isSocial && progress ? { socialOrderProgress: progress } : {}) } });
        if (result.error || result.data?.success !== true) return reply({ success: false, status: "pending", reference, error: "Supplier reports completion, but wallet settlement needs reconciliation. Do not retry." }, 202);
        if (isSocial && progress && ["partial", "partially_completed", "partially_complete"].includes(orderStatus)) {
          return reply({ success: true, status: "partial", reference, amount: finalAmount, orderProgress: progress,
            message: "The supplier reports partial delivery. Sparkle has recorded the supplier update; this order needs review." });
        }
        return reply({ success: true, status: "successful", reference, amount: finalAmount,
          ...(isSocial && progress ? { orderProgress: progress, deliveryStatus: progress.status } : {}),
          message: isSocial ? "The order has been accepted. Sparkle has updated its delivery status." : "Supplier confirmed the order. Your final Sparkle charge has been settled." });
      }
      const confirmedFailure = isSocial
        ? checked.response.ok && (providerFailure || (Number(provider?.code) >= 400 && pStatus !== "" && !providerSuccess))
        : (providerFailure || (Number(provider?.code) >= 400 && pStatus !== "" && !providerSuccess));
      if (confirmedFailure) {
        if (isSocial) {
          const refund = await admin.rpc("sparkle_social_refund_order", {
            p_user_id: user.id, p_reference: reference,
            p_provider_order: order || { status: "failed", source: "transaction" },
            p_reason: "Supplier transaction verification confirmed failure"
          });
          if (refund.error || refund.data?.success !== true) return reply({ success: false, status: "pending", reference, error: refund.data?.error || "The supplier confirmed a failure, but Sparkle is reconciling the wallet refund. Do not retry yet." }, 202);
          return reply({ success: true, status: "refunded", reference, amount: Number(refund.data.amount || tx.amount),
            message: "The supplier confirmed failure. Your full Sparkle wallet refund has been processed." });
        }
        const result = await admin.rpc("sparkle_digital_wallet_action", { p_user_id: user.id, p_action: "failure", p_reference: reference, p_amount: Number(tx.amount), p_service: tx.service,
          p_metadata: { status_checked: true, provider_verification: provider, reason: "Provider confirmed failure" } });
        if (result.error || result.data?.success !== true) return reply({ success: false, status: "pending", reference, error: "Provider reports failure, but the refund needs reconciliation. Do not reorder yet." }, 202);
        return reply({ success: false, status: "refunded", reference, message: "The provider confirmed failure. Your Sparkle wallet has been refunded." });
      }
      await admin.rpc("sparkle_digital_wallet_action", { p_user_id: user.id, p_action: "pending", p_reference: reference, p_amount: Number(tx.amount), p_service: tx.service,
        p_metadata: { status_checked: true, provider_verification: provider } });
      return reply({ success: false, status: "pending", reference, error: "The supplier still has not confirmed the order. Funds remain reserved; check again shortly. Do not place a duplicate order." }, 202);
    }
    if (!["send_bulk_sms", "buy_social"].includes(action)) return reply({ success: false, error: "Unsupported digital-service action." }, 400);
    if (!serviceKey) return reply({ success: false, error: "Secure wallet settlement is not configured." }, 503);
    const gsubzKey = Deno.env.get("GSUBZ_API_KEY");
    if (!gsubzKey) return reply({ success: false, error: "Supplier connection is not configured. No money has been taken." }, 503);
    const pin = str(body.pin);
    if (!/^\d{4}$/.test(pin)) return reply({ success: false, error: "Enter your 4-digit transaction PIN." }, 400);
    const pinCheck = await callPinVerifier(url, anonKey, authorization, pin);
    if (!pinCheck.ok) return reply({ success: false, error: str(pinCheck.data?.error ?? pinCheck.data?.message) || "Transaction PIN verification failed. No purchase was sent." }, 400);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    let service = "", providerPath = "", providerFields: Record<string, string> = {}, supplierEstimate = 0, quotedRetail = 0, maximumReserve = 0, metadata: Record<string, unknown> = {}, providerRequestId = "";
    if (action === "buy_social") {
      const planCodeValue = str(body.plan), quantity = Number(body.quantity), link = str(body.link), plans = await fetchSocialPlans(), plan = plans.find(p => p.value === planCodeValue);
      if (!plan) return reply({ success: false, error: "That social-media plan is no longer available. Refresh the catalogue and review the new price." }, 409);
      if (!plan.priceAvailable) return reply({ success: false, error: "A verified live price is not available for this plan. No money was reserved. Please refresh later." }, 409);
      const linkError = validateSocialTargetLink(link, plan.displayName); if (linkError) return reply({ success: false, error: linkError }, 400);
      const requestUrl = new URL(link);
      if (!Number.isSafeInteger(quantity) || quantity < plan.min || quantity > plan.max) return reply({ success: false, error: `Quantity must be between ${plan.min} and ${plan.max}.` }, 400);
      const quote = planQuote(plan, quantity), expected = Number(body.expectedTotal);
      if (!Number.isFinite(expected) || Math.abs(expected - quote.estimatedRetail) > 0.02) return reply({ success: false, error: "The current plan price changed. Please review the updated price before buying." }, 409);
      const ref = makeRef(user.id, body.requestID); providerRequestId = ref.reference; providerPath = "/api/pay/";
      providerFields = { serviceID: "socials", plan: plan.value, api: gsubzKey, amount: "", link: requestUrl.toString(), quantity: String(quantity), requestID: providerRequestId };
      supplierEstimate = quote.supplierEstimate; quotedRetail = quote.estimatedRetail; maximumReserve = quote.maximumReserve;
      service = "Social Media Market";
      metadata = { digitalKind: "social", provider: "GSubz", providerRequestID: providerRequestId, clientRequestID: ref.clientRequestId, plan: plan.value, planName: plan.displayName, quantity, link: requestUrl.toString(), quotedSupplierCost: supplierEstimate, quotedRetail, reservedAmount: maximumReserve, markupPercent: markup("social"), currency: "NGN",
        socialAutoTrack: true, socialTrackingTerminal: false, socialTrackingState: "scheduled",
        socialTrackingAttempts: 0, socialTrackingStartedAt: new Date().toISOString(), socialNextCheckAt: new Date().toISOString() };
    } else {
      let q: ReturnType<typeof bulkSmsQuote>; try { q = bulkSmsQuote(body); } catch (e) { return reply({ success: false, error: e instanceof Error ? e.message : "Invalid bulk SMS request." }, 400); }
      const expected = Number(body.expectedTotal); if (!Number.isFinite(expected) || Math.abs(expected - q.estimatedRetail) > 0.02) return reply({ success: false, error: "The SMS quote changed. Calculate the current price and review the message again." }, 409);
      const ref = makeRef(user.id, body.requestID); providerRequestId = ref.reference; providerPath = "/api/sms/";
      providerFields = { api: gsubzKey, from: q.sender, to: q.recipients.join(","), msg: q.message, requestID: providerRequestId };
      supplierEstimate = q.supplierEstimate; quotedRetail = q.estimatedRetail; maximumReserve = q.maximumReserve; service = "Bulk SMS";
      metadata = { digitalKind: "sms", provider: "GSubz", providerRequestID: providerRequestId, clientRequestID: ref.clientRequestId, sender: q.sender, recipientCount: q.recipientCount, pagesPerRecipient: q.pagesPerRecipient, messageLength: q.message.length, usesUnicode: q.usesUnicode, quotedSupplierCost: supplierEstimate, quotedRetail, reservedAmount: maximumReserve, markupPercent: markup("sms"), currency: "NGN" };
    }
    if (!Number.isFinite(maximumReserve) || maximumReserve < 0.01 || maximumReserve > 1000000) return reply({ success: false, error: "The calculated total is outside Sparkle's safe purchase limits." }, 400);
    const reserve = await admin.rpc("sparkle_digital_wallet_action", { p_user_id: user.id, p_action: "reserve", p_reference: providerRequestId, p_amount: maximumReserve, p_service: service, p_metadata: { ...metadata, stage: "reserved" } });
    if (reserve.error) return reply({ success: false, error: "Wallet reservation failed. No supplier order was sent." }, 500);
    if (!reserve.data?.success) return reply({ success: false, status: reserve.data?.status || "not_started", error: reserve.data?.error || "Insufficient Sparkle wallet balance." }, /insufficient/i.test(str(reserve.data?.error)) ? 402 : 409);
    if (reserve.data?.duplicate) return reply({ success: false, status: reserve.data.status || "pending", reference: providerRequestId, error: "This order reference has already been used. Check order status before trying again." }, 409);
    let providerResult: any, httpOk = false;
    try { const result = await providerPost(providerPath, gsubzKey, providerFields); providerResult = result.data; httpOk = result.response.ok; }
    catch { await admin.rpc("sparkle_digital_wallet_action", { p_user_id: user.id, p_action: "pending", p_reference: providerRequestId, p_amount: maximumReserve, p_service: service, p_metadata: { provider_timeout: true } });
      return reply({ success: false, status: "pending", reference: providerRequestId, error: "The supplier did not confirm in time. Your funds remain reserved while Sparkle checks the order. Do not buy it again yet." }, 202); }
    // Verify the same SMS request before resolving a GSubz gateway error.
    // A 502 alone is inconclusive: never refund or retry until status is known.
    if (action === "send_bulk_sms" && Number(providerResult?.code) === 502
      && str(providerResult?.description).toUpperCase() === "GATEWAY_ERROR") {
      let verified: any = null;
      try {
        const check = await providerPost("/api/verify/", gsubzKey, { api: gsubzKey, requestID: providerRequestId });
        verified = check.data;
        const verifiedStatus = statusOf(verified);
        const verifiedCode = Number(verified?.code ?? 0);
        if (check.response.ok && isSuccess(verifiedStatus)) {
          // Keep the provider's verified result for normal wallet settlement below.
          providerResult = { ...verified, sent: verified?.sent ?? verified?.recipients ?? Number(metadata?.recipientCount ?? 1) };
          httpOk = true;
          metadata = { ...metadata, gatewayErrorVerifiedBeforeSettlement: true };
        } else if (isFailure(verifiedStatus) && verifiedCode !== 502) {
          // Provider has explicitly confirmed failure; use that response for the refund path.
          providerResult = verified;
          httpOk = check.response.ok;
        } else {
          await admin.rpc("sparkle_digital_wallet_action", {
            p_user_id: user.id, p_action: "pending", p_reference: providerRequestId,
            p_amount: maximumReserve, p_service: service,
            p_metadata: { provider_response: providerResult, status_check_response: verified,
              gatewayErrorStatusUnconfirmed: true, stage: "provider_pending" }
          });
          return reply({ success: false, status: "pending", reference: providerRequestId,
            error: "GSubz's gateway error is not yet resolved. Your funds remain reserved while Sparkle checks the original order. Do not resend this campaign yet." }, 202);
        }
      } catch {
        await admin.rpc("sparkle_digital_wallet_action", {
          p_user_id: user.id, p_action: "pending", p_reference: providerRequestId,
          p_amount: maximumReserve, p_service: service,
          p_metadata: { provider_response: providerResult, gatewayStatusCheckFailed: true, stage: "provider_pending" }
        });
        return reply({ success: false, status: "pending", reference: providerRequestId,
          error: "Sparkle could not verify the original GSubz order. Your funds remain reserved for safety. Do not resend this campaign yet." }, 202);
      }
    }
    // A failed/ambiguous initial Social Market response is not enough to refund.
    // Verify the exact original requestID first; never pass transactionID together with it.
    if (action === "buy_social" && (
      socialPaymentFailure(statusOf(providerResult))
      || (!httpOk && Number(providerResult?.code) >= 400)
    )) {
      let verification: any = null;
      try {
        verification = await providerPost("/api/verify/", gsubzKey, { api: gsubzKey, requestID: providerRequestId });
      } catch {
        await admin.rpc("sparkle_digital_wallet_action", {
          p_user_id: user.id, p_action: "pending", p_reference: providerRequestId,
          p_amount: maximumReserve, p_service: service,
          p_metadata: { provider_response: providerResult, socialVerificationUnavailable: true, stage: "provider_pending" }
        });
        return reply({ success: false, status: "pending", reference: providerRequestId,
          error: "Sparkle could not verify the supplier response yet. Your funds remain reserved while the original order is checked. Do not place a duplicate order." }, 202);
      }
      const verified = verification.data;
      const verifiedStatus = statusOf(verified);
      const verifiedOrder = socialOrderOf(verified);
      const verifiedQuantity = Number(metadata.quantity || 0);
      if (!verification.response.ok) {
        await admin.rpc("sparkle_digital_wallet_action", {
          p_user_id: user.id, p_action: "pending", p_reference: providerRequestId,
          p_amount: maximumReserve, p_service: service,
          p_metadata: { provider_response: providerResult, socialVerificationResponse: verified, socialVerificationHttpStatus: verification.response.status, stage: "provider_pending" }
        });
        return reply({ success: false, status: "pending", reference: providerRequestId,
          error: "The supplier has not returned a verified final status. Your funds remain reserved while Sparkle checks the original order. Do not retry yet." }, 202);
      }
      if (verifiedOrder && socialOrderHasNoDelivery(verifiedOrder, verifiedQuantity)) {
        const refund = await admin.rpc("sparkle_social_refund_order", {
          p_user_id: user.id, p_reference: providerRequestId,
          p_provider_order: verifiedOrder,
          p_reason: "Initial supplier rejection was verified by the original requestID and full undelivered quantity"
        });
        if (refund.error || refund.data?.success !== true) {
          await admin.rpc("sparkle_digital_wallet_action", {
            p_user_id: user.id, p_action: "pending", p_reference: providerRequestId,
            p_amount: maximumReserve, p_service: service,
            p_metadata: { provider_response: providerResult, socialVerificationResponse: verified, socialRefundProofNeedsReconciliation: true, stage: "provider_pending" }
          });
          return reply({ success: false, status: "pending", reference: providerRequestId,
            error: refund.data?.error || "The supplier failure is verified, but Sparkle is reconciling the refund. Do not reorder yet." }, 202);
        }
        return reply({ success: false, status: "refunded", reference: providerRequestId,
          message: "The supplier confirmed that the full order was not delivered. Your Sparkle wallet has been refunded." });
      }
      if (socialPaymentFailure(verifiedStatus) && !verifiedOrder) {
        const refund = await admin.rpc("sparkle_social_refund_order", {
          p_user_id: user.id, p_reference: providerRequestId,
          p_provider_order: { status: "failed", source: "transaction", verificationStatus: verifiedStatus },
          p_reason: "Initial supplier rejection was confirmed as a failed transaction using the original requestID"
        });
        if (refund.error || refund.data?.success !== true) {
          await admin.rpc("sparkle_digital_wallet_action", {
            p_user_id: user.id, p_action: "pending", p_reference: providerRequestId,
            p_amount: maximumReserve, p_service: service,
            p_metadata: { provider_response: providerResult, socialVerificationResponse: verified, socialRefundProofNeedsReconciliation: true, stage: "provider_pending" }
          });
          return reply({ success: false, status: "pending", reference: providerRequestId,
            error: refund.data?.error || "The supplier confirmed a transaction failure, but Sparkle is reconciling the refund. Do not reorder yet." }, 202);
        }
        return reply({ success: false, status: "refunded", reference: providerRequestId,
          message: "The supplier confirmed that the transaction failed. Your Sparkle wallet has been refunded." });
      }
      if (socialPaymentSuccess(verifiedStatus)) {
        providerResult = verified;
        httpOk = true;
        metadata = { ...metadata, socialPaymentStatusVerified: true };
      } else {
        await admin.rpc("sparkle_digital_wallet_action", {
          p_user_id: user.id, p_action: "pending", p_reference: providerRequestId,
          p_amount: maximumReserve, p_service: service,
          p_metadata: { provider_response: providerResult, socialVerificationResponse: verified, stage: "provider_pending" }
        });
        return reply({ success: false, status: "pending", reference: providerRequestId,
          error: "The supplier response is still inconclusive. Your funds remain reserved while Sparkle checks the original order. Do not place a duplicate order." }, 202);
      }
    }
    const supplierStatus = statusOf(providerResult), smsSent = action === "send_bulk_sms" ? Number(providerResult?.sent ?? providerResult?.recipients ?? 0) : 1;
    const socialOrder = action === "buy_social" ? socialOrderOf(providerResult) : null;
    const socialProgress = action === "buy_social" ? socialOrderProgress(socialOrder, Number(metadata.quantity || 0)) : null;
    const providerAccepted = action === "buy_social" ? socialPaymentSuccess(supplierStatus) : isSuccess(supplierStatus);
    const isDelivered = httpOk && providerAccepted && smsSent > 0;
    if (isDelivered) {
      const actualCost = Number(providerResult?.amountPaid ?? providerResult?.amount ?? supplierEstimate);
      const finalAmount = retailFromSupplier(actualCost, quotedRetail, maximumReserve, action === "buy_social" ? "social" : "sms");
      const final = await admin.rpc("sparkle_digital_wallet_action", { p_user_id: user.id, p_action: "success", p_reference: providerRequestId, p_amount: finalAmount, p_service: service,
        p_metadata: { provider_response: providerResult, actual_supplier_cost: Number.isFinite(actualCost) ? actualCost : supplierEstimate, final_customer_charge: finalAmount, stage: "completed",
          ...(action === "buy_social" ? { provider_transaction_id: providerResult?.transactionID ?? providerResult?.content?.transactionID ?? null,
            ...(socialProgress ? { socialOrderProgress: socialProgress } : {}) } : {}) } });
      if (final.error || final.data?.success !== true) return reply({ success: false, status: "pending", reference: providerRequestId, error: "Sparkle received the supplier response, but wallet settlement needs reconciliation. Do not retry." }, 202);
      return reply({ success: true, status: "successful", reference: providerRequestId, service, amount: finalAmount, reservedAmount: maximumReserve, refundDifference: money2(maximumReserve - finalAmount),
        ...(action === "buy_social" ? { orderProgress: socialProgress, deliveryStatus: socialProgress?.status || "Processing" } : {}),
        provider: action === "send_bulk_sms" ? { sent: providerResult?.sent, failed: providerResult?.failed, skipped: providerResult?.skipped, recipients: providerResult?.recipients, pages: providerResult?.pages, api_response: providerResult?.api_response, transactionID: providerResult?.transactionID, requestID: providerResult?.requestID } : undefined,
        message: action === "send_bulk_sms" ? "Bulk SMS was processed. Any unused reservation has been returned to your Sparkle wallet."
          : "Your social-media order has been accepted. Delivery progress can be checked from the order status panel." });
    }
    const providerRejected = action === "buy_social" ? socialPaymentFailure(supplierStatus) : isFailure(supplierStatus);
    if (providerRejected || (!httpOk && Number(providerResult?.code) >= 400 && supplierStatus !== "")) {
      const fail = action === "buy_social"
        ? await admin.rpc("sparkle_digital_wallet_action", { p_user_id: user.id, p_action: "failure", p_reference: providerRequestId, p_amount: maximumReserve, p_service: service, p_metadata: { provider_response: providerResult, stage: "refunded" } })
        : await admin.rpc("sparkle_digital_wallet_action", { p_user_id: user.id, p_action: "failure", p_reference: providerRequestId, p_amount: maximumReserve, p_service: service, p_metadata: { provider_response: providerResult, stage: "refunded" } });
      if (fail.error || fail.data?.success !== true) return reply({ success: false, status: "pending", reference: providerRequestId, error: "The provider rejected the order, but Sparkle is reconciling your refund. Do not retry yet." }, 202);
      return reply({ success: false, status: "refunded", reference: providerRequestId, message: str(providerResult?.api_response ?? providerResult?.description ?? providerResult?.message) || "The provider did not accept this order. Your Sparkle wallet has been refunded.", provider: { code: providerResult?.code, description: providerResult?.description, issues: providerResult?.issues } });
    }
    await admin.rpc("sparkle_digital_wallet_action", { p_user_id: user.id, p_action: "pending", p_reference: providerRequestId, p_amount: maximumReserve, p_service: service, p_metadata: { provider_response: providerResult, stage: "provider_pending" } });
    return reply({ success: false, status: "pending", reference: providerRequestId, error: "The supplier has not confirmed the order yet. Funds remain reserved while Sparkle checks it. Do not place a duplicate order." }, 202);
  } catch (error) { return reply({ success: false, error: error instanceof Error ? error.message : "Unexpected digital-services error." }, 500); }
});