const https = require("https");

function postJson(url, key, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: target.hostname, path: target.pathname + target.search, method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 60000
    }, response => {
      let raw = ""; response.setEncoding("utf8");
      response.on("data", chunk => raw += chunk);
      response.on("end", () => {
        let json; try { json = JSON.parse(raw); } catch (_) { return reject(new Error("Product detail provider returned unreadable data")); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error("Product detail provider HTTP " + response.statusCode));
        resolve(json);
      });
    });
    req.on("timeout", () => req.destroy(new Error("Product detail request timed out")));
    req.on("error", reject); req.write(payload); req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const expected = process.env.MARKETPLACE_IMPORT_ADMIN_TOKEN;
  const supplied = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || !supplied || supplied !== expected) return res.status(401).json({ error: "Marketplace importer is not configured for admin access yet." });
  const apiKey = process.env.NEXSCOPE_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "1688 provider API key is not configured on the server yet." });
  const offerId = String((req.body && req.body.offerId) || "").trim();
  if (!/^\d{5,20}$/.test(offerId)) return res.status(400).json({ error: "A valid 1688 offer ID is required." });
  try {
    const data = await postJson("https://api.nexscope.ai/alibaba1688/productDetail", apiKey, { offerId, country: "NG", currency: "CNY" });
    return res.status(200).json({ data });
  } catch (error) {
    return res.status(502).json({ error: error.message || "1688 product detail lookup failed." });
  }
};
