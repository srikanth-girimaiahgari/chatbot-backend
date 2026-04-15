alter table orders
add column if not exists shopify_order_id text,
add column if not exists shopify_order_number text,
add column if not exists confirmed_at timestamptz;

create unique index if not exists idx_orders_shopify_order_id
on orders (shopify_order_id)
where shopify_order_id is not null;

alter table shopify_carts
add column if not exists shopify_order_id text,
add column if not exists checkout_completed_at timestamptz,
add column if not exists paid_at timestamptz;
