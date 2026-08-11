-- ============================================================
--  Rate-limiting support table.
--  Run once in Supabase -> SQL Editor -> New query -> Run.
--  Stores short-lived "attempt" events (admin logins, submissions)
--  so the function can throttle abuse. Rows are pruned automatically
--  by the function; you can also TRUNCATE it anytime, it's disposable.
-- ============================================================

create table if not exists rate_limit (
  id         bigint generated always as identity primary key,
  bucket     text        not null,   -- e.g. 'admin:1.2.3.4' or 'sub:1.2.3.4'
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_bucket_idx on rate_limit (bucket, created_at);

-- Same lockdown as the rest: only the server-side service_role key touches it.
alter table rate_limit enable row level security;
