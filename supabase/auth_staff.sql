-- ===================================================================
-- Staff allowlist for Supabase Auth (Google login).
-- Only emails listed here may perform admin/monitor actions in the
-- Edge Function; `role` decides capabilities (teacher = full,
-- monitor = read-only / anonymized later).
--
-- Signing in with Google only proves WHO someone is; this table is the
-- gate that decides WHAT they can do. A valid Google login whose email
-- is not here gets "sem acesso".
-- ===================================================================

create table if not exists staff (
  email    text primary key,          -- store lowercase
  role     text not null check (role in ('teacher','monitor')),
  name     text,
  added_at timestamptz not null default now()
);

-- RLS on, NO policies: the table is reachable only via service_role
-- (the Edge Function) and the Supabase dashboard (2FA). The public anon
-- key and any logged-in user CANNOT read or modify it.
alter table staff enable row level security;

-- -------------------------------------------------------------------
-- Seed the roster (edit the emails/roles, keep them lowercase, then run).
-- Use whichever email each person will actually sign in with (the Google
-- account behind personal Gmail or ufmg.br-if-Workspace).
-- -------------------------------------------------------------------
-- insert into staff (email, role, name) values
--   ('you@gmail.com',      'teacher', 'Seu Nome'),
--   ('codocente@ufmg.br',  'teacher', 'Co-docente'),
--   ('monitor1@gmail.com', 'monitor', 'Monitor 1'),
--   ('monitor2@gmail.com', 'monitor', 'Monitor 2'),
--   ('monitor3@gmail.com', 'monitor', 'Monitor 3'),
--   ('monitor4@gmail.com', 'monitor', 'Monitor 4')
-- on conflict (email) do update set role = excluded.role, name = excluded.name;

-- To revoke someone instantly:  delete from staff where email = 'x@y.com';
