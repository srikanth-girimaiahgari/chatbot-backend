alter table orders
add column if not exists product_id bigint references products(id) on delete set null,
add column if not exists currency_code text,
add column if not exists unit_price numeric,
add column if not exists total_amount numeric,
add column if not exists payment_status text default 'not_started',
add column if not exists payment_link_url text,
add column if not exists payment_link_id text;
