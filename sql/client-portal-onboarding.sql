alter table tenants
add column if not exists owner_name text,
add column if not exists owner_email text,
add column if not exists password_hash text,
add column if not exists timezone text,
add column if not exists business_category text,
add column if not exists instagram_username text,
add column if not exists facebook_page_name text,
add column if not exists instagram_connection_status text default 'not_started',
add column if not exists connect_instagram_requested boolean default false,
add column if not exists connect_instagram_notes text,
add column if not exists onboarding_status text default 'signup_pending',
add column if not exists admin_connection_confirmed boolean default false,
add column if not exists client_connection_confirmed boolean default false,
add column if not exists activation_status text default 'setup_incomplete',
add column if not exists preferred_contact_method text default 'email',
add column if not exists lead_contact_email text,
add column if not exists lead_contact_phone text,
add column if not exists response_window_start text,
add column if not exists response_window_end text,
add column if not exists off_hours_reply text,
add column if not exists client_dashboard_token text;

create unique index if not exists tenants_owner_email_unique
on tenants (owner_email)
where owner_email is not null;

create unique index if not exists tenants_client_dashboard_token_unique
on tenants (client_dashboard_token)
where client_dashboard_token is not null;
