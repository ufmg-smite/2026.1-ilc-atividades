-- ============================================================
--  Correction app — database schema
--  Run once in Supabase -> SQL Editor -> New query -> Run.
--
--  A separate, self-contained set of `correction_*` tables. It shares only
--  the `staff` allowlist (who may grade) and the `answers` Storage bucket
--  (where the scans live) with the quiz platform; it never reads quiz tables
--  directly. The one bridge is the `importFromQuiz` action in the Edge
--  Function, so this whole feature can be lifted into its own project later
--  by rewriting that single import step.
--
--  Same lockdown as the rest of the platform: RLS ON, no policies. Only the
--  service_role key (Edge Function + local pipeline) can touch these tables.
-- ============================================================

-- ------------------------------------------------------------
--  A "run" is one correction campaign: an exam or an activity.
-- ------------------------------------------------------------
create table if not exists correction_runs (
  id           text primary key,          -- e.g. 'dcc638-prova1'
  title        text not null,
  source       text,                      -- quiz id it was imported from, if any
  scale_total  numeric,                   -- optional: normalise the final grade to this
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  created_by   text
);

alter table correction_runs enable row level security;

-- ------------------------------------------------------------
--  Questions of a run: the statement plus the reference answer the grading
--  model is told to compare against. `position` fixes the display order.
-- ------------------------------------------------------------
create table if not exists correction_questions (
  run_id      text    not null references correction_runs (id) on delete cascade,
  question_id text    not null,
  prompt      text    not null default '',
  reference   text    not null default '',   -- gabarito / expected answer
  guidance    text    not null default '',   -- free-text notes for the grader model
  position    int     not null default 0,
  primary key (run_id, question_id)
);

alter table correction_questions enable row level security;

-- ------------------------------------------------------------
--  The barème. One row per criterion; `points` is what an edit changes.
--
--  The grading model NEVER outputs a score — it only says which criteria are
--  satisfied. Points live here, so re-weighting the barème is a recomputation
--  (instant, no model call) rather than a re-grade. Criteria are keyed by a
--  stable slug so a proposal can be re-scored after the points move.
--
--  Adding a NEW criterion mid-correction does not disturb already-graded
--  answers: a human score, once committed, is authoritative and frozen (see
--  correction_events). New criteria only affect answers not yet reviewed.
-- ------------------------------------------------------------
create table if not exists correction_criteria (
  id          bigint generated always as identity primary key,
  run_id      text    not null,
  question_id text    not null,
  key         text    not null,            -- stable slug, e.g. 'elimina_implicacoes'
  label       text    not null,            -- shown in the review UI
  detail      text    not null default '', -- what exactly earns it (goes in the prompt)
  points      numeric not null default 1,
  position    int     not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  foreign key (run_id, question_id)
    references correction_questions (run_id, question_id) on delete cascade,
  unique (run_id, question_id, key)
);

create index if not exists correction_criteria_q_idx
  on correction_criteria (run_id, question_id, position);

alter table correction_criteria enable row level security;

-- ------------------------------------------------------------
--  One row per (student, question) — the unit of review.
--
--  `transcription` is what the local VLM read from the scans; the reviewer can
--  fix it, which flips `transcription_edited` and triggers a re-grade of that
--  one answer. `image_paths` points into the private Storage bucket; the
--  browser only ever sees short-lived signed URLs.
-- ------------------------------------------------------------
create table if not exists correction_items (
  id                   bigint generated always as identity primary key,
  run_id               text not null references correction_runs (id) on delete cascade,
  question_id          text not null,
  student_key          text not null,          -- lowercase email, or a slug if none
  student_name         text not null default '',
  student_email        text not null default '',
  image_paths          jsonb not null default '[]'::jsonb,
  typed_answer         text not null default '',  -- when the student typed instead of writing
  transcription        text not null default '',
  transcription_edited boolean not null default false,
  cluster_key          text,                   -- equal answers sort together
  created_at           timestamptz not null default now(),
  unique (run_id, question_id, student_key)
);

create index if not exists correction_items_q_idx
  on correction_items (run_id, question_id, cluster_key, student_name);

alter table correction_items enable row level security;

-- ------------------------------------------------------------
--  Model proposals — append-only. The newest row for an item is the one shown.
--
--  `criteria` is {criterion_key: {met: bool, note: text}}. No score: the score
--  is derived by joining these verdicts against correction_criteria.points.
-- ------------------------------------------------------------
create table if not exists correction_proposals (
  id            bigint generated always as identity primary key,
  item_id       bigint not null references correction_items (id) on delete cascade,
  criteria      jsonb  not null default '{}'::jsonb,
  justification text   not null default '',
  model         text   not null default '',
  source        text   not null default 'batch',  -- 'batch' | 'regrade'
  created_at    timestamptz not null default now()
);

create index if not exists correction_proposals_item_idx
  on correction_proposals (item_id, created_at desc);

alter table correction_proposals enable row level security;

-- ------------------------------------------------------------
--  Human decisions — append-only. THE audit log.
--
--  This is the table that answers "why did this student get this grade?", and
--  the one that carries `actor_email` so a student can be sent to whoever
--  actually made the call. Nothing here is ever updated or deleted: changing
--  your mind appends a new row, and the latest row for an item wins.
--
--  `score` is stored as a NUMBER, not recomputed from criteria. A human
--  decision is authoritative and frozen: later barème edits re-price answers
--  that are still pending, and leave reviewed ones exactly as they were.
-- ------------------------------------------------------------
create table if not exists correction_events (
  id            bigint generated always as identity primary key,
  item_id       bigint not null references correction_items (id) on delete cascade,
  kind          text   not null check (kind in ('accept','override','reopen','transcription')),
  score         numeric,                        -- null for 'reopen'/'transcription'
  justification text   not null default '',
  criteria      jsonb  not null default '{}'::jsonb,  -- verdicts as committed
  rubric        jsonb  not null default '{}'::jsonb,  -- {key: points} at commit time
  actor_email   text   not null,
  actor_role    text   not null default '',
  created_at    timestamptz not null default now()
);

create index if not exists correction_events_item_idx
  on correction_events (item_id, created_at desc);

alter table correction_events enable row level security;

-- ------------------------------------------------------------
--  Convenience view for the CSV export and for the local pipeline: the current
--  state of every answer, with the grader who decided it.
--  (Pending answers have a null score here — the Edge Function prices those
--  live from the latest proposal, since their price moves with the barème.)
-- ------------------------------------------------------------
create or replace view correction_current as
select
  i.id            as item_id,
  i.run_id,
  i.question_id,
  i.student_key,
  i.student_name,
  i.student_email,
  i.transcription,
  i.transcription_edited,
  i.cluster_key,
  e.score,
  e.justification,
  e.kind,
  e.actor_email   as graded_by,
  e.created_at    as graded_at
from correction_items i
left join lateral (
  select * from correction_events ev
  where ev.item_id = i.id and ev.kind in ('accept','override')
  order by ev.created_at desc
  limit 1
) e on true;

-- A view does NOT inherit the RLS of its tables: by default it runs as its
-- owner, which would hand the public anon key everything the view selects.
-- security_invoker makes it run as the caller instead, so the "RLS on, no
-- policies" lockdown of the tables below applies here too. The explicit revoke
-- is the belt to that suspenders — only service_role reads this.
alter view correction_current set (security_invoker = on);
revoke all on correction_current from anon, authenticated;
