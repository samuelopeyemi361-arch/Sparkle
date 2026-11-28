# TheSparkle Marketplace — isolated 1688 importer build

This folder and API route are on the isolated branch `feature/marketplace-1688-importer`. They are not merged into `main` and do not change the live Sparkle application.

## Current scope
- Private, no-index importer workbench at `/marketplace-lab/`.
- Search endpoint proxy at `/api/marketplace/1688-search`.
- API credentials stay server-side.
- Search results can be inspected and selected as draft candidates in the browser.
- Nothing is saved to the live catalogue or shown to customers.

## Provider
Initial adapter: Nexscope 1688 Product Search, POST `https://api.nexscope.ai/dl/productSearch`, Bearer API key. The provider docs specify a Simplified Chinese `keyWord` (up to 50 chars). API usage consumes provider credits.

## Required preview environment variables
- `NEXSCOPE_API_KEY`: provider key, server-only.
- `MARKETPLACE_IMPORT_ADMIN_TOKEN`: strong random secret used to protect the isolated importer endpoint.

The current UI does not send the admin token. Before enabling the endpoint, add a secure admin-session handoff from the existing Sparkle admin system in a later integration step. Do not place either secret in browser code.

## Next implementation stages
1. Add authenticated admin-session verification using the existing Sparkle admin authorization model (inspect and reuse it; do not invent roles).
2. Add product-detail lookup by offer ID, including SKU/variant, stock, logistics, package weight and dimensions where the supplier/provider returns them.
3. Persist supplier snapshots and editable product drafts in isolated marketplace tables with strict RLS.
4. Store supplier RMB price and applied manual RMB/NGN rate on every draft/order; customer prices display only in NGN.
5. Admin review/approval, product catalogue, and only later controlled integration into the existing Sparkle navigation.
6. Test on a preview deployment. Do not merge or deploy to production until explicitly approved.

## Important
Supplier data can be incomplete or change. Never infer weight/dimensions or a final landed cost. Shipping remains an estimate until Best Africa confirms its chargeable CBM rules and final packed measurements.
