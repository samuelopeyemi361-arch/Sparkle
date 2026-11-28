# TheSparkle Marketplace — isolated 1688 importer build

This feature is developed only on `feature/marketplace-1688-importer`. It is not merged into the production branch and does not change the live Sparkle customer app.

## Current preview features
- Private, no-index workbench at `/marketplace-lab/`.
- Free public 1688 keyword search links and starter categories.
- Product draft editor for supplier URL, title, photo URL, description, category, supplier, variants, RMB price, manual RMB/NGN rate, MOQ, verified weight/dimensions and admin notes.
- Naira conversion preview uses RMB price × manually entered exchange rate. It is a product-only estimate; freight, customs and local delivery are excluded.
- Drafts can be edited, deleted, exported to JSON and imported from JSON.

## Important limitations
- Free discovery opens 1688 in a separate browser tab. It does not scrape, auto-import, or automatically display 1688 listings in this workbench.
- Drafts currently save in browser local storage on the current device only. They are not yet shared, server-backed, or protected by the existing Sparkle admin session. Export JSON backups before clearing browser data or changing devices.
- Do not enter confidential customer information here.
- Supplier price, stock, MOQ, variants, weight and dimensions must be checked against the supplier. Never guess packed weight or dimensions.
- The Naira rate is manually entered for this draft preview. A central admin-managed rate and immutable order snapshot are not implemented yet.
- No customer catalogue, checkout, payment, Sparkle wallet, Paystack, authentication, refunds, or live transaction logic is connected.

## Next stages
1. Inspect the existing Sparkle admin authorization model and reuse it for marketplace access; do not invent new roles or weaken auth.
2. Move drafts and the manual exchange rate into isolated marketplace database tables with strict admin-only access and row-level security.
3. Add product review/approval, customer catalogue, order records and sea-freight cost calculation only after verified Best Africa rates and packed measurements.
4. Test the complete module on preview. Do not merge, connect to live customer flows, or deploy to production until explicitly approved.

## Business rules
- 1688 is the sole initial supplier marketplace.
- Customer preorder model; user places the supplier order after customer payment.
- Sea freight only for the initial plan.
- Customer-facing amounts are in NGN. Original RMB supplier price and applied rate must be retained internally.
- Do not connect marketplace payments to the existing Sparkle wallet without explicit approval.
- Keep all marketplace data and logic isolated from existing VTU services.
