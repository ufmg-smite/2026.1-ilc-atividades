-- ============================================================
--  "Entrega em aula" (in-class commitment) — schema additions
--  Run once in the Supabase SQL editor (safe to re-run: all IF NOT EXISTS).
--
--  Model:
--   • quizzes.in_class_minutes : the in-class window M (minutes). NULL/absent =
--     feature off (ordinary single-phase quiz). Set it (e.g. 30), with
--     0 < M < duration_minutes, to turn the two-phase mode on for that quiz.
--   • lock_choices  : which question each student picked as the "questão da aula"
--     (append-only; the latest row per student wins). No row = use the default
--     (first question they answered). Picking only decides WHICH question locks
--     at M — never when.
--   • lock_overrides: teacher reopens, append-only, latest row per (student,kind)
--     wins. kind='access' re-grants phase-2 access after a missed gate;
--     kind='question' un-freezes the committed question. Independent switches.
--
--  Like the rest of the app these tables are append-only (full history kept) and
--  reached only through the service-role Edge Function; RLS stays deny-all.
-- ============================================================

alter table quizzes add column if not exists in_class_minutes integer;

create table if not exists lock_choices (
  id            bigint generated always as identity primary key,
  quiz_id       text        not null,
  student_email text        not null,
  question_id   text        not null,
  created_at    timestamptz not null default now()
);
create index if not exists lock_choices_lookup
  on lock_choices (quiz_id, student_email, created_at desc);

create table if not exists lock_overrides (
  id            bigint generated always as identity primary key,
  quiz_id       text        not null,
  student_email text        not null,          -- stored lowercased
  kind          text        not null,          -- 'access' | 'question'
  granted       boolean     not null default true,
  actor_email   text,
  created_at    timestamptz not null default now()
);
create index if not exists lock_overrides_lookup
  on lock_overrides (quiz_id, student_email, created_at desc);

-- Keep RLS on and deny-all (same posture as submissions / correction_*).
alter table lock_choices   enable row level security;
alter table lock_overrides enable row level security;
