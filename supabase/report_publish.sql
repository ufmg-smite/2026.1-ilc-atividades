-- ============================================================
--  Publishing student reports from the grading page (correcao.html).
--  Run once in the Supabase SQL editor (safe to re-run: IF NOT EXISTS).
--
--  student_emails: the e-mail a student used in the quizzes -> matrícula. The
--  `correction` function uses it to link every graded answer to the student's
--  report when someone publishes a run; staff add missing ones from the page.
--  report_runs gains who published/hid it last, and when.
--  RLS on, NO policies: only the service-role Edge Functions read or write.
-- ============================================================

create table if not exists student_emails (
  email     text primary key,           -- lower-case, as stored in correction_items.student_key
  matricula text not null
);
create index if not exists student_emails_mat_idx on student_emails (matricula);
alter table student_emails enable row level security;
grant select, insert, update, delete on student_emails to service_role;

alter table report_runs add column if not exists published_by text;
alter table report_runs add column if not exists published_at timestamptz;
