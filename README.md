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

## Notes

- **No secrets** are stored in this repo — access codes and API keys live only as Supabase
  secrets. **No questions or student answers** are stored here either.
- Deployment/configuration details are kept separately from this public repo.
