create extension if not exists pgcrypto;

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id bigint references products(id) on delete set null,
  product_name text not null,
  quantity integer not null default 1,
  unit_price numeric,
  line_total numeric,
  created_at timestamptz not null default now()
);

create index if not exists idx_order_items_order_id
  on order_items (order_id);
