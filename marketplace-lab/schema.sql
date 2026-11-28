-- TheSparkle Marketplace uses its own schema inside Project Hub.
-- This reference mirrors the live catalogue migration. Provision the admin-token
-- hash separately; never commit a raw token or password hash to source control.

create schema if not exists marketplace;
create schema if not exists marketplace_private;

alter role authenticator set pgrst.db_schemas = 'public,graphql_public,marketplace';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';

revoke all on schema marketplace from public;
grant usage on schema marketplace to anon, authenticated, service_role;
revoke all on schema marketplace_private from public, anon, authenticated, service_role;
grant usage on schema marketplace_private to anon, authenticated;

create table if not exists marketplace_private.admin_credentials (
  id smallint primary key default 1 check (id = 1),
  token_hash text not null,
  created_at timestamptz not null default now()
);
alter table marketplace_private.admin_credentials enable row level security;

create or replace function marketplace_private.is_admin_request()
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  request_headers jsonb;
  presented_token text;
  stored_hash text;
begin
  begin
    request_headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  exception when others then
    request_headers := '{}'::jsonb;
  end;
  presented_token := request_headers ->> 'x-marketplace-admin-token';
  select token_hash into stored_hash
  from marketplace_private.admin_credentials where id = 1;
  return presented_token is not null and stored_hash is not null
    and extensions.crypt(presented_token, stored_hash) = stored_hash;
end;
$$;
revoke all on function marketplace_private.is_admin_request() from public;
grant execute on function marketplace_private.is_admin_request() to anon, authenticated;

create table if not exists marketplace.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  source text not null default '1688' check (source in ('1688','manual')),
  supplier_url text,
  supplier_offer_id text,
  title text not null,
  image_url text,
  gallery_urls jsonb not null default '[]'::jsonb check (jsonb_typeof(gallery_urls) = 'array'),
  description text,
  category text,
  variants jsonb not null default '[]'::jsonb check (jsonb_typeof(variants) = 'array'),
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
create index if not exists marketplace_products_status_category_idx on marketplace.products(status, category);
create index if not exists marketplace_products_updated_idx on marketplace.products(updated_at desc);
alter table marketplace.products enable row level security;
grant select, insert, update on marketplace.products to anon, authenticated;
drop policy if exists "Marketplace products visible when published or to admin" on marketplace.products;
create policy "Marketplace products visible when published or to admin"
  on marketplace.products for select to anon, authenticated
  using (status = 'published' or marketplace_private.is_admin_request());
drop policy if exists "Marketplace admin can add products" on marketplace.products;
create policy "Marketplace admin can add products"
  on marketplace.products for insert to anon, authenticated
  with check (marketplace_private.is_admin_request());
drop policy if exists "Marketplace admin can update products" on marketplace.products;
create policy "Marketplace admin can update products"
  on marketplace.products for update to anon, authenticated
  using (marketplace_private.is_admin_request())
  with check (marketplace_private.is_admin_request());

create table if not exists marketplace.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  parent_id uuid references marketplace.categories(id) on delete set null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketplace_categories_parent_sort_idx on marketplace.categories(parent_id, sort_order);
alter table marketplace.categories enable row level security;
grant select, insert, update on marketplace.categories to anon, authenticated;
drop policy if exists "Active marketplace categories are public" on marketplace.categories;
create policy "Active marketplace categories are public"
  on marketplace.categories for select to anon, authenticated
  using (is_active or marketplace_private.is_admin_request());

create table if not exists marketplace.store_settings (
  id smallint primary key default 1 check (id = 1),
  exchange_rate_ngn_per_rmb numeric(14,4) check (exchange_rate_ngn_per_rmb > 0),
  updated_at timestamptz not null default now()
);
alter table marketplace.store_settings enable row level security;
grant select, insert, update on marketplace.store_settings to anon, authenticated;
drop policy if exists "Marketplace admin reads settings" on marketplace.store_settings;
create policy "Marketplace admin reads settings"
  on marketplace.store_settings for select to anon, authenticated
  using (marketplace_private.is_admin_request());

-- Public image delivery only. No anonymous uploads are allowed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('marketplace-products','marketplace-products',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "Public can view marketplace product images" on storage.objects;
create policy "Public can view marketplace product images"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'marketplace-products');
