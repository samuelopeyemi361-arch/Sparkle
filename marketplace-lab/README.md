# TheSparkle Marketplace — isolated 1688 catalogue build

This work remains on `feature/marketplace-1688-importer`. It is not merged into production and does not change the live Sparkle VTU app.

## Product sourcing decision
- Automatic 1688 catalogue discovery/import is the primary product source.
- Manual product upload is optional and is intended only for exceptions or products not present in the automatic feed.
- Customers should eventually browse one unified marketplace catalogue; automatic and manually added products must not appear as separate stores.
- 1688 is the sole initial supplier marketplace.

## Current preview
- Private, no-index preview at `/marketplace-lab/`.
- The interface now presents automatic 1688 catalogue ingestion as the primary path and manual product drafts as an optional admin workflow.
- The automatic feed is explicitly marked **not connected**. No product listings are fabricated, scraped or shown as live 1688 data.
- Optional manual drafts are still stored in this browser's local storage only. They are not shared, server-backed, protected by the Sparkle admin session or published to customers.
- Naira conversion preview uses the manually entered RMB/NGN rate. Freight, customs and local delivery are excluded.

## What is still required for real automatic importing
1. Obtain permitted 1688 Open Platform access for the appropriate cross-border product search/detail APIs, or approve a third-party provider and its cost.
2. Keep API credentials server-side; never put secrets in browser JavaScript.
3. Build a server-side scheduled importer with category discovery, pagination, product-detail/SKU retrieval, deduplication, stock/price refresh and unavailable-product handling.
4. Store imported catalogue data in isolated marketplace tables. Reuse the existing admin authorization only after inspecting its implementation; do not weaken or alter Sparkle auth.
5. Use the admin-controlled RMB→NGN rate for customer-facing prices. Store original RMB price and the applied exchange-rate snapshot with each order; rate changes apply only to new orders.
6. Add product review/approval and customer catalogue only after the ingestion source has been verified.

## Business rules
- Customer preorder model: customer submits/pays for an order, then the owner purchases the item on 1688. This is not automatic supplier procurement.
- Sea freight only for the initial plan.
- Customer-facing amounts are in NGN. Supplier RMB prices and applied rate are retained internally.
- Checkout is limited to 5 distinct products, with quantities per product.
- Freight, customs/clearance and Nigerian local delivery must be itemised separately. Freight remains an estimate until packed measurements and a current Best Africa Logistics quote are available.
- Do not connect marketplace checkout to the existing Sparkle wallet or Paystack flows without explicit approval.
- Preserve all existing VTU wallet, funding, authentication, PIN, supplier purchase, refund and transaction-history functionality.

## Safety and deployment
- Do not merge this branch or deploy marketplace features to production without explicit approval.
- Do not pay for an API, subscription, credits or scraping service without explicit approval.
- Do not scrape around 1688 access controls or represent public search links as a product API.


## Shareable product links and catalogue groundwork
- Added an isolated \`marketplace_products\` schema script in \`marketplace-lab/schema.sql\`; it does not touch VTU tables.
- Added \`api/marketplace/product.js\`: public read-only catalogue/product lookup and token-protected admin publishing/upsert. Public reads return published products only.
- Added \`marketplace-lab/product.html\`: a dedicated product page with a native share action and stable unique slug URL.
- Added a published catalogue panel to the private lab. Each published product can be opened and shared with another customer.
- Required server-only environment variables: \`MARKETPLACE_SUPABASE_URL\`, \`MARKETPLACE_SUPABASE_SERVICE_ROLE_KEY\`, and \`MARKETPLACE_CATALOG_ADMIN_TOKEN\`. Never expose the service-role key or admin token in browser code.
- The schema script must be reviewed and applied to a separate marketplace database or isolated development branch before the catalogue API can work. It has not been applied to the live VTU database.
- This does not solve the 1688 source-access blocker. No real products will appear until an authorised free/approved feed is available and imported. No paid provider has been enabled.
