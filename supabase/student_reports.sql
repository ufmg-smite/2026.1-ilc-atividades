-- ============================================================
--  "Minhas correções": students see their own corrected exams (later also
--  activities) in the browser, on the hidden page correcoes.html, served by the
--  separate Edge Function `relatorios` (independent of the quiz's `submit`).
--  Run once in the Supabase SQL editor (safe to re-run: IF NOT EXISTS).
--
--  Nothing here copies grades or scans: the function reads the existing
--  correction_* tables and signs the scans already in the `answers` bucket.
--  These tables only add (1) who the student is, (2) which graded booklet is
--  theirs, (3) per-exam publication settings and gabaritos.
--
--  Like the rest of the app: RLS on, NO policies — only the service-role
--  Edge Function (and the dashboard) can read or write these tables.
-- ============================================================

-- (1) Personal access codes. The code itself is never stored: only a salted
-- PBKDF2-SHA256 hash. preview=true marks staff test accounts, which also see
-- exams that are not published yet.
create table if not exists student_access (
  matricula   text primary key,               -- digits only
  nome        text not null,
  code_salt   text not null,                  -- hex, 16 random bytes
  code_hash   text not null,                  -- hex PBKDF2-SHA256(code, salt, iterations)
  iterations  integer not null default 100000,
  active      boolean not null default true,  -- false = code revoked
  preview     boolean not null default false, -- staff test account
  created_at  timestamptz not null default now()
);
alter table student_access enable row level security;

-- (2) Which graded booklet (correction_items.student_key) belongs to which
-- matrícula, per correction run.
create table if not exists report_students (
  run_id      text not null,
  matricula   text not null,
  student_key text not null,
  primary key (run_id, matricula)
);
create index if not exists report_students_mat_idx on report_students (matricula);
alter table report_students enable row level security;

-- (3) Per-exam settings. Students see a run only once published = true.
-- nota_base: the grade shown is min(100, points / nota_base * 100).
create table if not exists report_runs (
  run_id      text primary key,
  title       text not null,
  nota_base   numeric not null,
  published   boolean not null default false,
  created_at  timestamptz not null default now()
);
alter table report_runs enable row level security;

-- Per question: its number in that version's booklet, a title, and the
-- gabarito (staff-authored HTML; the page sanitizes it; "{{asset:path}}"
-- is replaced by a signed URL to answers/<path>).
create table if not exists report_questions (
  run_id        text not null,
  question_id   text not null,
  numero        integer not null,
  titulo        text not null,
  gabarito_html text,
  updated_at    timestamptz not null default now(),
  primary key (run_id, question_id)
);
alter table report_questions enable row level security;

-- Explicit grant (Supabase stops auto-granting new public tables on 2026-10-30).
-- ONLY to service_role (the Edge Functions); never to anon/authenticated — the
-- public key in the pages must not reach these tables (RLS stays deny-all too).
grant select, insert, update, delete on student_access   to service_role;
grant select, insert, update, delete on report_students  to service_role;
grant select, insert, update, delete on report_runs      to service_role;
grant select, insert, update, delete on report_questions to service_role;
