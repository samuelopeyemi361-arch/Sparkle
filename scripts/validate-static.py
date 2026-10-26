#!/usr/bin/env python3
"""Static validation for Sparkle's single-file frontend."""
from html.parser import HTMLParser
from pathlib import Path
import json
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "index.html"

class Scripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.current = None
        self.items = []
    def handle_starttag(self, tag, attrs):
        if tag.lower() != "script":
            return
        attrs = dict(attrs)
        if attrs.get("src"):
            self.current = None
            return
        kind = (attrs.get("type") or "").lower().strip()
        if kind in {"application/ld+json", "application/json", "importmap", "speculationrules"}:
            self.current = None
            return
        self.current = {"kind": kind, "text": ""}
        self.items.append(self.current)
    def handle_data(self, data):
        if self.current is not None:
            self.current["text"] += data
    def handle_endtag(self, tag):
        if tag.lower() == "script":
            self.current = None

def main():
    html = HTML.read_text(encoding="utf-8")
    parser = Scripts()
    parser.feed(html)
    checked = 0
    for index, item in enumerate(parser.items, 1):
        code = item["text"].strip()
        if not code:
            continue
        suffix = ".mjs" if item["kind"] == "module" else ".js"
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=suffix) as temp:
            temp.write(code)
            temp.flush()
            result = subprocess.run(["node", "--check", temp.name], text=True, capture_output=True)
        if result.returncode:
            raise SystemExit(f"Inline script {index} failed syntax check:\n{result.stderr}")
        checked += 1
    with (ROOT / "vercel.json").open(encoding="utf-8") as f:
        json.load(f)
    ET.parse(ROOT / "sitemap.xml")
    for required in ("robots.txt", "favicon.svg"):
        if not (ROOT / required).is_file():
            raise SystemExit(f"Required public asset missing: {required}")

    # Guard the most important Sparkle production invariants against regressions.
    checks = {
        "compact welcome modal": 'id="sparkle-login-welcome-modal"' in html,
        "WhatsApp channel action": 'id="sparkle-login-welcome-channel"' in html,
        "welcome close action": 'id="sparkle-login-welcome-later"' in html,
        "welcome group invitation removed": 'id="sparkle-login-welcome-group"' not in html and "GROUP_INVITE_REQUEST_URL" not in html,
        "Sparkle-branded receipt provider": '<span>Provider</span><strong>TheSparkle.com.ng</strong>' in html,
        "receipt plan label": 'isDataReceipt?"Plan Purchased"' in html,
        "no service-role key in browser code": "SUPABASE_SERVICE_ROLE_KEY" not in html and "SERVICE_ROLE_KEY" not in html,
        "canonical production domain": 'https://thesparkle.com.ng/' in html,
    }
    for label, passed in checks.items():
        if not passed:
            raise SystemExit(f"Regression check failed: {label}")

    sitemap_root = ET.parse(ROOT / "sitemap.xml").getroot()
    sitemap_ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    sitemap_urls = [node.text or "" for node in sitemap_root.findall("sm:url/sm:loc", sitemap_ns)]
    if not sitemap_urls:
        raise SystemExit("sitemap.xml must contain at least one URL")
    if any(not url.startswith("https://thesparkle.com.ng/") for url in sitemap_urls):
        raise SystemExit("sitemap.xml contains a URL outside the canonical production domain")

    webhook = ROOT / "supabase/functions/paystack-webhook/index.ts"
    if not webhook.is_file():
        raise SystemExit("Paystack webhook source is missing")
    webhook_source = webhook.read_text(encoding="utf-8")
    for marker in ("x-paystack-signature", "constantTimeEqual", "PAYSTACK_SECRET_KEY"):
        if marker not in webhook_source:
            raise SystemExit(f"Paystack webhook security check failed: missing {marker}")

    print(f"PASS: {checked} inline JavaScript blocks, production invariants, Paystack webhook guardrails, sitemap.xml ({len(sitemap_urls)} URLs), vercel.json, robots.txt, favicon.svg")

if __name__ == "__main__":
    main()
