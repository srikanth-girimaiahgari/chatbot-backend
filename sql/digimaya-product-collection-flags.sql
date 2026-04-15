alter table products
add column if not exists is_new_arrival boolean default false,
add column if not exists is_best_seller boolean default false,
add column if not exists is_top_rated boolean default false,
add column if not exists is_on_sale boolean default false,
add column if not exists sales_count integer default 0,
add column if not exists review_rating numeric(3,2),
add column if not exists review_count integer default 0;
