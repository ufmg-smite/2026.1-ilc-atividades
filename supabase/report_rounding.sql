-- How the report grade is rounded, per exam/activity (supabase/functions/relatorios).
-- 'round' (default): nearest integer — every run published so far.
-- 'ceil': rounded up — the official grade sheet's rule (Prova 2: base 12, ⌈pts/12·100⌉).
-- Safe to run before or after deploying the function (it reads report_runs with select=*).
alter table report_runs add column if not exists grade_rounding text not null default 'round'
  check (grade_rounding in ('round', 'ceil'));
