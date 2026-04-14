alter table tenants
add column if not exists shopify_webhook_secret text,
add column if not exists shopify_last_webhook_at timestamptz;
