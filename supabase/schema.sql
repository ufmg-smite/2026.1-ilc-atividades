-- ============================================================
--  Quiz platform — database schema
--  Run this once in Supabase → SQL Editor → New query → Run.
-- ============================================================

create table if not exists submissions (
  id            bigint generated always as identity primary key,
  quiz_id       text        not null,
  student_name  text        not null,
  student_email text        not null,
  question_id   text        not null,
  answer        text        not null,
  created_at    timestamptz not null default now()
);

-- Helpful index for exports/analysis (fetch one quiz quickly).
create index if not exists submissions_quiz_idx on submissions (quiz_id, created_at);

-- ------------------------------------------------------------
--  SECURITY: turn on Row-Level Security and add NO policies.
--  With RLS on and no policy, the public/anon key can neither
--  read nor write this table. Only the server-side service_role
--  key (used inside the Edge Function and by the export script)
--  bypasses RLS. That is the whole safety model:
--    - browser  -> can't touch the table directly
--    - function -> writes with service_role (server-side secret)
--    - export   -> reads with service_role (on your laptop)
-- ------------------------------------------------------------
alter table submissions enable row level security;
