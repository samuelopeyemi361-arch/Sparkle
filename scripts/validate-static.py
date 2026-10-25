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
    print(f"PASS: {checked} inline JavaScript blocks, vercel.json, sitemap.xml, robots.txt, favicon.svg")

if __name__ == "__main__":
    main()
