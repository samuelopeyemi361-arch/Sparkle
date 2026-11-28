const crypto = require("crypto");
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function slugify(value) {
  return String(value || "").normalize("NFKD").toLowerCase()
    .replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 70);
}
function config() {
  const url = process.env.MARKETPLACE_SUPABASE_URL || process.env.SUPABASE_URL;
  // Prefer a service-role key when configured. Preview can also use its anon key:
  // product writes are protected by the database's separate admin-token RLS check.
  const key = process.env.MARKETPLACE_SUPABASE_SERVICE_ROLE_KEY || process.env.MARKETPLACE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Marketplace database is not configured on this preview.");
  return { url: url.replace(/\\/$/, ""), key };
}
async function db(path, method, body, adminToken) {
  const c = config();
  const headers = {
    apikey: c.key,
    Authorization: "Bearer " + c.key,
    "Content-Type": "application/json",
    "Accept-Profile": "marketplace",
    "Content-Profile": "marketplace",
    Prefer: method === "POST" ? "resolution=merge-duplicates,return=representation" : "return=representation"
  };
  if (adminToken) headers["x-marketplace-admin-token"] = adminToken;
  const response = await fetch(c.url + "/rest/v1/" + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Marketplace database request failed (" + response.status + ").");
  return text ? JSON.parse(text) : null;
}
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.method === "GET") {
    const slug = String(req.query && req.query.slug || "").trim();
    try {
      const fields = "select=slug,title,image_url,gallery_urls,description,category,variants,product_price_ngn,currency,updated_at&status=eq.published";
      if (!slug) {
        const rows = await db("products?" + fields + "&order=updated_at.desc&limit=60", "GET");
        return res.status(200).json({ products: rows || [] });
      }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return res.status(400).json({ error: "A valid product link is required." });
      const rows = await db("products?" + fields + "&slug=eq." + encodeURIComponent(slug) + "&limit=1", "GET");
      if (!rows || !rows.length) return res.status(404).json({ error: "This product is unavailable or its link has changed." });
      return res.status(200).json({ product: rows[0] });
    } catch (error) { return res.status(503).json({ error: error.message }); }
  }
  if (req.method === "POST") {
    const expected = process.env.MARKETPLACE_CATALOG_ADMIN_TOKEN;
    const supplied = String(req.headers.authorization || "").replace(/^Bearer\\s+/i, "");
    if (!expected || !safeEqual(supplied, expected)) return res.status(401).json({ error: "Admin access required." });
    const p = req.body || {};
    const title = String(p.title || "").trim();
    const rmb = Number(p.supplier_price_rmb), rate = Number(p.exchange_rate_ngn_per_rmb);
    const status = ["draft", "published", "archived"].includes(p.status) ? p.status : "draft";
    if (!title || title.length > 240 || !(rmb >= 0) || !(rate > 0) || !Number.isFinite(rmb) || !Number.isFinite(rate))
      return res.status(400).json({ error: "Title, valid RMB price and positive admin exchange rate are required." });
    const slug = slugify(p.slug || title) + "-" + String(p.supplier_offer_id || crypto.randomBytes(3).toString("hex")).replace(/[^a-zA-Z0-9]/g, "").slice(-8).toLowerCase();
    const row = {
      slug, source: p.source === "manual" ? "manual" : "1688",
      supplier_url: p.supplier_url || null, supplier_offer_id: p.supplier_offer_id || null,
      title, image_url: p.image_url || null,
      gallery_urls: Array.isArray(p.gallery_urls) ? p.gallery_urls.slice(0, 12) : [],
      description: p.description || null, category: p.category || null,
      variants: Array.isArray(p.variants) ? p.variants : [],
      supplier_price_rmb: rmb, exchange_rate_ngn_per_rmb: rate,
      product_price_ngn: Math.round(rmb * rate * 100) / 100,
      status, source_checked_at: p.source_checked_at || null,
      last_supplier_sync_at: p.last_supplier_sync_at || null
    };
    try {
      const rows = await db("products?on_conflict=slug", "POST", row, expected);
      return res.status(201).json({ product: rows && rows[0], share_path: "/marketplace-lab/product.html?slug=" + encodeURIComponent(slug) });
    } catch (error) { return res.status(503).json({ error: error.message }); }
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed." });
};
