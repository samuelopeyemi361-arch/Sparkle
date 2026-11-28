# TheSparkle Marketplace — isolated 1688 catalogue build

This work remains on `feature/marketplace-1688-importer`. It is not merged into production and does not change the live Sparkle VTU app.

## Database and backup
- Marketplace data now lives in its own PostgreSQL schema, `marketplace`, inside **Project Hub** (`qndwsxfvjyolfpkrgvul`).
- Internal admin credentials live in the separate, non-exposed `marketplace_private` schema.
- Before adding the marketplace, a private snapshot was created in `project_hub_backup_20261128`.
- The snapshot captured all 20 existing `public` and `app_private` application tables, their column definitions, RLS-enabled flags and row data.
- The backup is inside the same Supabase project, not an off-site dump. Supabase Free does not provide downloadable daily database backups; periodically export an off-site copy.
- No Project Hub wallet, ledger, Luna, Alpha, auth or transaction rules were modified.

## Catalogue
- Primary supplier source: 1688. Manual product publishing remains optional.
- Live tables: `marketplace.products`, `marketplace.categories`, `marketplace.store_settings`.
- Product prices are shown in NGN; each product stores its supplier RMB cost and applied exchange-rate snapshot.
- The admin-controlled RMB/NGN rate is not prefilled with a made-up value.
- Product images can be served from the public `marketplace-products` Storage bucket (5 MB per image; JPEG, PNG or WebP). Anonymous upload is disabled.
- Public product reads are restricted to published catalogue rows. Drafts, admin settings and writes require the independent marketplace admin token.
- The public preview/catalogue does not require customer login.

## Preview and product links
- Branch: `feature/marketplace-1688-importer`
- Preview lab: `/marketplace-lab/`
- Each published product receives a stable slug-based share link: `/marketplace-lab/product.html?slug=<slug>`.
- The connected catalogue API was smoke-tested successfully (HTTP 200; currently no published products).
- Database policy smoke test: a valid marketplace admin token passed the draft-write check; a request without the token was denied. The temporary draft test was rolled back.
- The API reads/writes the dedicated `marketplace` schema. Preview-only Vercel variables are used; production environment and branch are unchanged.

## 1688 importer limitation
- No real product listings are fabricated or scraped.
- Automatic import still requires authorised 1688 Open Platform product-search/detail access, or a free/approved compliant feed.
- No paid API/provider has been enabled. The importer must handle paging, variants, source IDs, image URLs, supplier price/stock refresh and unavailable listings.
- Once a permitted source is available, imported rows enter the same catalogue as optional manually added products.

## Business rules retained
- Customer preorder model: the owner places the 1688 order after the customer submits and pays.
- Sea freight only; freight is estimated until packed dimensions and a current Best Africa Logistics quote are available.
- Product cost, sea freight, customs/clearance and local delivery remain separate line items.
- Up to 5 distinct products per checkout, with per-product quantities.
- Product payments and shipping balances must remain separate stages.
- No marketplace checkout integration with the Project Hub central wallet, Sparkle VTU wallet or Paystack has been added.
- Keep Project Hub and Sparkle production deployments separate from this marketplace preview.

## Security and deployment
- Marketplace writes are protected by a separate token checked both by the API route and database RLS.
- The Project Hub service-role key is not exposed to the browser or committed to the repository. Preview currently uses the scoped anon key plus the independent admin-token check.
- Do not merge this branch or deploy it to production without explicit approval.
- Do not pay for an API, subscription, credits or scraping service without explicit approval.
