create extension if not exists pgcrypto;

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_intent_id uuid references order_intents(id) on delete set null,
  session_id text not null,
  channel text not null default 'unknown',
  order_reference text not null default ('DM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  customer_name text,
  contact_method text,
  contact_detail text,
  product_interest text,
  quantity integer not null default 1,
  status text not null default 'draft',
  source_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_orders_order_reference
  on orders (order_reference);

create index if not exists idx_orders_tenant_created_at
  on orders (tenant_id, created_at desc);

create index if not exists idx_orders_session_status
  on orders (session_id, status, created_at desc);
