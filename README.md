# ILC — Atividades práticas

A lightweight web platform for short, timed **in-class activities** for the ILC course:
students answer open questions (with math-notation support and a live preview), and their
answers are collected for discussion and quick analysis afterwards.

## For students

Open the activity page, enter your **name + e-mail**, then
answer each question and click **Enviar**. You can revise and resend until the time runs out —
the last version counts.

> **Activity page:**  https://ufmg-smite.github.io/2026.1-ilc-atividades/

## How it works

- **Front-end (this repo):** two static pages served by GitHub Pages — `index.html` (students)
  and `admin.html` (teacher panel). No build step.
- **Back-end:** [Supabase](https://supabase.com) — a Postgres database plus a single Edge
  Function that stores answers and enforces the time window (using server time).
- **Questions live in the database**, created and edited from the admin panel — **not in this
  repo**, so they aren't visible before class.
- **Analysis (optional):** the admin panel can produce an anonymized summary of the most common
  mistakes per question via an LLM. Only anonymous answers are sent; no names or e-mails leave
  the backend.

## Repository contents

| Path | What it is |
|---|---|
| `index.html` | The student activity page |
| `admin.html` | Teacher control panel — open/close activities, author questions, run analysis |
| `supabase/` | Database schema and the Edge Function (`functions/submit`) |
| `export.py` | Download an activity's answers to a CSV (run locally, standard-library Python) |
| `correcao.html` | Grading page — review one question across all students, keyboard-driven |
| `supabase/correction.sql` | Schema for the correction app (`correction_*` tables) |
| `supabase/functions/correction/` | Edge Function serving the grading queue and the audit log |
| `pipeline/` | Local pipeline: preprocess, transcribe and pre-grade the scans offline |

## Notes

- **No secrets** are stored in this repo — access codes and API keys live only as Supabase
  secrets. **No questions or student answers** are stored here either.
- Deployment/configuration details are kept separately from this public repo.

## Correcting handwritten work

`correcao.html` is a second, separate staff page for grading scanned answers. It
shares only the `staff` allowlist and the private Storage bucket with the quiz
platform — everything else lives in its own `correction_*` tables and its own
Edge Function, so it can be lifted into a project of its own later.

How the work is split:

- **On the teacher's machine** (`pipeline/`, see its README): scans are cleaned
  up, transcribed and pre-graded by local models. No image is sent anywhere.
- **In the browser**: each answer is reviewed next to its scan, with a proposed
  score and a justification already written. One key accepts it.
- **Interactively**: fixing a transcription or re-weighting the barème asks
  Gemini for a fresh proposal — anonymised text only, the same rule the analysis
  feature already follows.

Two design points worth knowing before reading the code:

- **The grading model never outputs a score.** It reports which barème criteria
  an answer satisfies; the points live in `correction_criteria`. Re-weighting the
  barème is therefore arithmetic, not inference — instant, free, and applied to
  every answer still pending.
- **A human decision is final.** Once someone commits a score it is stored as a
  number and never recomputed, so later barème edits can never quietly rewrite a
  grade that was already reviewed. `correction_events` is append-only and records
  who decided what, which is what answers "why did I get this grade?" — and who
  the student should be sent to.

Setup: run `supabase/correction.sql` once, deploy the `correction` function, and
add the graders to `staff` (`auth_staff.sql`).
