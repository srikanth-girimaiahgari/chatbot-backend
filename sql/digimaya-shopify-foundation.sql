create extension if not exists pgcrypto;

alter table tenants
add column if not exists shopify_store_domain text,
add column if not exists shopify_storefront_access_token text,
add column if not exists shopify_admin_access_token text,
add column if not exists shopify_connection_status text default 'not_connected',
add column if not exists shopify_webhook_status text default 'not_configured',
add column if not exists shopify_connected_at timestamptz,
add column if not exists shopify_last_sync_at timestamptz,
add column if not exists shopify_default_location_gid text;

create unique index if not exists tenants_shopify_store_domain_unique
on tenants (shopify_store_domain)
where shopify_store_domain is not null;

alter table products
add column if not exists shopify_product_gid text,
add column if not exists shopify_variant_gid text,
add column if not exists shopify_inventory_item_gid text,
add column if not exists shopify_synced_at timestamptz;

create index if not exists idx_products_tenant_shopify_variant_gid
on products (tenant_id, shopify_variant_gid)
where shopify_variant_gid is not null;

create table if not exists shopify_carts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  session_id text,
  channel text not null default 'instagram',
  shopify_cart_gid text,
  shopify_checkout_url text,
  currency_code text,
  subtotal_amount numeric,
  total_amount numeric,
  status text not null default 'draft',
  last_error text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_shopify_carts_shopify_cart_gid
on shopify_carts (shopify_cart_gid)
where shopify_cart_gid is not null;

create index if not exists idx_shopify_carts_tenant_created_at
on shopify_carts (tenant_id, created_at desc);

create index if not exists idx_shopify_carts_order_id
on shopify_carts (order_id);

create table if not exists shopify_cart_items (
  id uuid primary key default gen_random_uuid(),
  shopify_cart_id uuid not null references shopify_carts(id) on delete cascade,
  order_item_id uuid references order_items(id) on delete set null,
  product_id bigint references products(id) on delete set null,
  product_name text,
  shopify_variant_gid text,
  shopify_line_gid text,
  quantity integer not null default 1,
  unit_price numeric,
  line_total numeric,
  currency_code text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_shopify_cart_items_cart_id
on shopify_cart_items (shopify_cart_id);

create index if not exists idx_shopify_cart_items_order_item_id
on shopify_cart_items (order_item_id);

create table if not exists shopify_webhook_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete set null,
  topic text not null,
  shopify_store_domain text not null,
  webhook_event_id text,
  hmac_verified boolean not null default false,
  payload jsonb not null,
  status text not null default 'received',
  processing_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create unique index if not exists idx_shopify_webhook_events_event_id
on shopify_webhook_events (webhook_event_id)
where webhook_event_id is not null;

create index if not exists idx_shopify_webhook_events_store_topic
on shopify_webhook_events (shopify_store_domain, topic, created_at desc);
