-- ============================================================
--  "Minhas correções": who opened their correction, and when.
--  Run once in the Supabase SQL editor (safe to re-run: IF NOT EXISTS).
--
--  The `relatorios` Edge Function appends one row per successful access
--  (staff test accounts excluded). Only the matrícula and the time are kept —
--  no IP, no device. Append-only; RLS on, NO policies, like every other table.
-- ============================================================

create table if not exists report_access (
  id         bigint generated always as identity primary key,
  matricula  text not null,
  at         timestamptz not null default now()
);
create index if not exists report_access_mat_idx on report_access (matricula, at);
alter table report_access enable row level security;

-- Explicit grant (Supabase stops auto-granting new public tables on 2026-10-30).
-- ONLY to service_role (the Edge Functions); never to anon/authenticated — the
-- public key in the pages must not reach these tables (RLS stays deny-all too).
grant select, insert on report_access to service_role;
