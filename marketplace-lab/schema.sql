-- TheSparkle Marketplace only. This schema is deliberately separate from VTU wallets,
-- Paystack deposits, service orders, refunds and transaction tables.
create table if not exists public.marketplace_products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  source text not null default '1688' check (source in ('1688','manual')),
  supplier_url text,
  supplier_offer_id text,
  title text not null,
  image_url text,
  gallery_urls jsonb not null default '[]'::jsonb,
  description text,
  category text,
  variants jsonb not null default '[]'::jsonb,
  supplier_price_rmb numeric(14,2) not null check (supplier_price_rmb >= 0),
  exchange_rate_ngn_per_rmb numeric(14,4) not null check (exchange_rate_ngn_per_rmb > 0),
  product_price_ngn numeric(14,2) not null check (product_price_ngn >= 0),
  currency text not null default 'NGN' check (currency = 'NGN'),
  status text not null default 'draft' check (status in ('draft','published','archived')),
  source_checked_at timestamptz,
  last_supplier_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketplace_products_status_category_idx
  on public.marketplace_products(status, category);
create index if not exists marketplace_products_updated_idx
  on public.marketplace_products(updated_at desc);
alter table public.marketplace_products enable row level security;
revoke all on public.marketplace_products from anon, authenticated;
grant select on public.marketplace_products to anon, authenticated;
drop policy if exists "Public can view published marketplace products" on public.marketplace_products;
create policy "Public can view published marketplace products"
  on public.marketplace_products for select to anon, authenticated
  using (status = 'published');
