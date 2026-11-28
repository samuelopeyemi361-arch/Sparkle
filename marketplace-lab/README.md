# TheSparkle Marketplace — isolated 1688 importer build

This folder and API route are on the isolated branch `feature/marketplace-1688-importer`. They are not merged into `main` and do not change the live Sparkle application.

## Current scope
- Private, no-index importer workbench at `/marketplace-lab/`.
- Free public 1688 keyword search links across eight starter categories.
- Opens supplier search results directly on 1688; no paid API credits are consumed in this mode.
- API credentials stay server-side.
- Public supplier results are browsed directly on 1688. The current free mode does not scrape or save supplier listings automatically.
- Nothing is saved to the live catalogue or shown to customers.

## Provider
Initial adapter: Nexscope 1688 Product Search, POST `https://api.nexscope.ai/dl/productSearch`, Bearer API key. The provider docs specify a Simplified Chinese `keyWord` (up to 50 chars). Current published pricing shows 12 credits per product-search call and at least 10 credits per product-detail call. The provider advertises 1,000 trial credits for new accounts for 3 days; verify the current offer and balance in the provider dashboard before bulk discovery. The eight-category discovery action can use about 96 search credits, before any detail lookups.

## Required preview environment variables
- `NEXSCOPE_API_KEY`: provider key, server-only.
- `MARKETPLACE_IMPORT_ADMIN_TOKEN`: strong random secret used to protect the isolated importer endpoint.

The private preview UI asks for `MARKETPLACE_IMPORT_ADMIN_TOKEN` and sends it only to the same-origin server endpoint in an Authorization header. It is not the user's existing Sparkle admin login. Before integration, replace this temporary token gate with verified admin-session authorization from Sparkle. Never put `NEXSCOPE_API_KEY` in browser code.

## Next implementation stages
1. Add authenticated admin-session verification using the existing Sparkle admin authorization model (inspect and reuse it; do not invent roles).
2. Add a no-cost product draft editor for supplier URL, title, photos, variants, RMB price and verified packed measurements.
3. Persist supplier snapshots and editable product drafts in isolated marketplace tables with strict RLS.
4. Store supplier RMB price and applied manual RMB/NGN rate on every draft/order; customer prices display only in NGN.
5. Admin review/approval, product catalogue, and only later controlled integration into the existing Sparkle navigation.
6. Test on a preview deployment. Do not merge or deploy to production until explicitly approved.

## Important
Supplier data can be incomplete or change. Never infer weight/dimensions or a final landed cost. Shipping remains an estimate until Best Africa confirms its chargeable CBM rules and final packed measurements.
