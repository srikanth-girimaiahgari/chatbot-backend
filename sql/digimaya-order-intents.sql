create extension if not exists pgcrypto;

create table if not exists order_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  session_id text not null,
  channel text not null default 'unknown',
  customer_name text,
  occasion text,
  contact_method text,
  contact_detail text,
  product_interest text,
  quantity integer not null default 1,
  status text not null default 'captured',
  source_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_order_intents_tenant_created_at
  on order_intents (tenant_id, created_at desc);

create index if not exists idx_order_intents_session_status
  on order_intents (session_id, status, created_at desc);
