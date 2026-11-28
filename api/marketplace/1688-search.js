const https = require("https");

function requestJson(url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: 60000
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { return reject(new Error("1688 provider returned an unreadable response")); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("1688 provider request failed with HTTP " + res.statusCode));
        }
        resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new Error("1688 provider request timed out")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const expected = process.env.MARKETPLACE_IMPORT_ADMIN_TOKEN;
  const supplied = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || !supplied || supplied !== expected) {
    return res.status(401).json({ error: "Marketplace importer is not configured for admin access yet." });
  }
  const apiKey = process.env.NEXSCOPE_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "1688 provider API key is not configured on the server yet." });
  const keyword = String((req.body && req.body.keyword) || "").trim();
  if (!keyword || keyword.length > 50) return res.status(400).json({ error: "Enter a product keyword (maximum 50 characters)." });
  try {
    const data = await requestJson("https://api.nexscope.ai/dl/productSearch", apiKey, {
      keyWord: keyword,
      searchType: 1,
      sortField: "orderCount30d"
    });
    return res.status(200).json({ data });
  } catch (error) {
    return res.status(502).json({ error: error.message || "1688 search provider is temporarily unavailable." });
  }
};