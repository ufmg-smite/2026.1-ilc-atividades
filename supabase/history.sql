-- ============================================================
--  Append-only history for quiz CONTENT + soft-delete flag.
--  Run once in Supabase -> SQL Editor -> New query -> Run.
--
--  Why: editing a quiz used to overwrite its questions, and there
--  was no delete at all. Now every edit snapshots the previous
--  version into quiz_history (nothing is lost, mistakes are
--  recoverable), and "delete" becomes an `archived` flag (soft
--  delete — hidden from the list, but never truly removed).
--  Student ANSWERS were already append-only; this brings the quiz
--  QUESTIONS in line with that.
-- ============================================================

-- Soft-delete flag on quizzes (archived quizzes are hidden, not deleted).
alter table quizzes
  add column if not exists archived boolean not null default false;

-- Previous versions of each quiz's content, one row per edit.
create table if not exists quiz_history (
  id          bigint generated always as identity primary key,
  quiz_id     text        not null,
  title       text,
  description text,
  questions   jsonb,
  saved_at    timestamptz not null default now()
);

create index if not exists quiz_history_quiz_idx on quiz_history (quiz_id, saved_at);

-- Same lockdown as everything else: only the server-side service_role key.
alter table quiz_history enable row level security;
