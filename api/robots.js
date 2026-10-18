module.exports = function handler(req, res) {
  const body = "User-agent: *\nAllow: /\nSitemap: https://thesparkle.com.ng/sitemap.xml\n";
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).send(body);
};
