-- Migration: add the student_email column to an EXISTING submissions table.
-- Run once in Supabase -> SQL Editor -> New query -> Run.
-- (New installs don't need this — schema.sql already includes the column.)

alter table submissions
  add column if not exists student_email text;
