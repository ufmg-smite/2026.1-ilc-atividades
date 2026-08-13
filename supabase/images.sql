-- ============================================================
--  Photo answers: a PRIVATE Storage bucket + an index table.
--  Run once in Supabase -> SQL Editor -> New query -> Run.
--
--  Students (esp. phone-only) can attach compressed photos of
--  handwritten work. Images are compressed in the browser
--  (resized + grayscale + WebP), uploaded THROUGH the Edge
--  Function (service_role), and stored in a private bucket.
--  The browser never gets a Storage key; the teacher views via
--  short-lived signed URLs and can purge a quiz's images anytime.
-- ============================================================

-- Private bucket (public = false). Only the service_role key (the function)
-- reads/writes it; teachers view through signed URLs. You can also create this
-- from the dashboard: Storage -> New bucket -> name "answers" -> Private.
insert into storage.buckets (id, name, public)
values ('answers', 'answers', false)
on conflict (id) do nothing;

-- Index of uploaded images (the bytes live in Storage; this row points at them).
create table if not exists answer_images (
  id            bigint generated always as identity primary key,
  quiz_id       text        not null,
  question_id   text        not null,
  student_name  text        not null,
  student_email text        not null,
  path          text        not null,   -- object path inside the bucket
  created_at    timestamptz not null default now()
);

create index if not exists answer_images_quiz_idx
  on answer_images (quiz_id, question_id, created_at);

-- Same lockdown as everything else: only the server-side service_role key.
alter table answer_images enable row level security;
-- storage.objects already has RLS enabled by default; the function uses the
-- service_role key (which bypasses RLS), so no bucket policies are needed.
