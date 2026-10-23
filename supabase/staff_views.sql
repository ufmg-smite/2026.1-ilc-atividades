-- Staff views of student reports (admin page → relatorios "staffReport").
-- Who (staff Google e-mail) looked at whose report (matrícula), and when.
-- Separate from report_access (students' own visits). Read with the dashboard.
create table if not exists staff_report_views (
  id          bigint generated always as identity primary key,
  staff_email text not null,
  matricula   text not null,
  at          timestamptz not null default now()
);
create index if not exists staff_report_views_at_idx on staff_report_views (at);
alter table staff_report_views enable row level security;

-- Explicit grant (Supabase stops auto-granting new public tables on 2026-10-30).
-- ONLY to service_role (the Edge Functions); never to anon/authenticated.
grant select, insert on staff_report_views to service_role;
