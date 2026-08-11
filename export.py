#!/usr/bin/env python3
"""
Export quiz answers from Supabase into ONE spreadsheet file.

- One row per student (identified by email), one column per question,
  plus name, email, and how many questions they answered.
- Keeps only each student's LAST version per question ("last wins").
- No timestamps (they weren't informative).
- Pure standard library: runs on any Python 3, Windows / macOS / Linux,
  nothing to `pip install`. The service_role key is read from an
  environment variable so it is NEVER written into the repo.

Usage (macOS / Linux):
    export SUPABASE_URL="https://YOUR-PROJECT-REF.supabase.co"
    export SUPABASE_SERVICE_ROLE_KEY="eyJ...service_role key..."
    python3 export.py <quiz-id>

Usage (Windows PowerShell):
    $env:SUPABASE_URL="https://YOUR-PROJECT-REF.supabase.co"
    $env:SUPABASE_SERVICE_ROLE_KEY="eyJ...service_role key..."
    python export.py <quiz-id>

The single argument is the quiz_id to export (its id as shown in the admin panel).
Output: <quiz_id>.csv  (open in Excel / Google Sheets, or hand to an LLM).
"""

import csv
import json
import os
import re
import sys
import urllib.parse
import urllib.request

def qsort_key(qid):
    """Natural sort so q2 comes before q10."""
    m = re.search(r"(\d+)$", qid)
    return (re.sub(r"\d+$", "", qid), int(m.group(1)) if m else 0, qid)

def main():
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables first.")

    if len(sys.argv) < 2:
        sys.exit("Uso: python3 export.py <quiz-id>   (o id do quiz, como aparece no painel do professor)")
    quiz_id = sys.argv[1]

    query = urllib.parse.urlencode({
        "quiz_id": f"eq.{quiz_id}",
        "select": "student_name,student_email,question_id,answer,created_at",
        "order": "created_at",  # oldest -> newest, so the last seen is the latest
    })
    req = urllib.request.Request(f"{base}/rest/v1/submissions?{query}", headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
    })
    with urllib.request.urlopen(req) as resp:
        rows = json.loads(resp.read().decode("utf-8"))

    if not rows:
        print(f"No submissions found for quiz_id='{quiz_id}'.")
        return

    students = {}   # id -> {"name":..., "email":...}
    latest = {}     # (id, question_id) -> answer
    questions = set()
    for r in rows:  # ordered oldest -> newest
        email = (r.get("student_email") or "").strip()
        name = (r.get("student_name") or "").strip()
        sid = email.lower() if email else name.lower()   # email is the stable identity
        students[sid] = {"name": name, "email": email}   # keep most recent name/email
        qid = r["question_id"]
        questions.add(qid)
        latest[(sid, qid)] = r["answer"]

    qcols = sorted(questions, key=qsort_key)
    out_path = f"{quiz_id}.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["student_name", "student_email"] + qcols + ["answered"])
        for sid in sorted(students, key=lambda s: (students[s]["name"].lower(), s)):
            info = students[sid]
            answers = [latest.get((sid, q), "") for q in qcols]
            answered = sum(1 for a in answers if a.strip())
            w.writerow([info["name"], info["email"]] + answers + [answered])

    print(f"Wrote {out_path}  ({len(students)} students, {len(qcols)} questions).")

if __name__ == "__main__":
    main()
