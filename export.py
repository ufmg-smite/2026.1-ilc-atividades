#!/usr/bin/env python3
"""
Export a quiz's answers (text + confirmed photos) from Supabase into ONE folder
that is easy to drag into a Claude chat and ask for feedback.

- Pure standard library (Python 3, any OS). Reads the service_role key from an
  environment variable; it is never written to disk. Deleting data still requires
  the Supabase dashboard (2FA) — this script only READS.
- Keeps each student's LAST submission per question ("last wins"), and downloads
  only the photos that were confirmed with that submission.

Usage (macOS / Linux):
    export SUPABASE_URL="https://YOUR-PROJECT-REF.supabase.co"
    export SUPABASE_SERVICE_ROLE_KEY="eyJ...service_role key..."
    python3 export.py <quiz-id>

Usage (Windows PowerShell):
    $env:SUPABASE_URL="https://YOUR-PROJECT-REF.supabase.co"
    $env:SUPABASE_SERVICE_ROLE_KEY="eyJ...service_role key..."
    python export.py <quiz-id>

Output folder: <quiz-id>_export/
    respostas.csv      one row per student, one column per question (text answers)
    para_analise.md    per question: each student's text + the filenames of their photos
    <qid>__<name>__<n>.webp   the photo files (flat, so you can select-all and attach)
"""

import csv
import json
import os
import re
import sys
import urllib.parse
import urllib.request

BUCKET = "answers"

def qsort_key(qid):
    m = re.search(r"(\d+)$", qid)
    return (re.sub(r"\d+$", "", qid), int(m.group(1)) if m else 0, qid)

def san(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-") or "aluno"

def api_get(base, key, path):
    req = urllib.request.Request(f"{base}{path}", headers={
        "apikey": key, "Authorization": f"Bearer {key}",
    })
    with urllib.request.urlopen(req) as r:
        return r.read()

def main():
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables first.")
    if len(sys.argv) < 2:
        sys.exit("Uso: python3 export.py <quiz-id>   (o id do quiz, como aparece no painel do professor)")
    quiz_id = sys.argv[1]

    # 1. submissions — keep the latest per (student, question)
    q = urllib.parse.urlencode({
        "quiz_id": f"eq.{quiz_id}",
        "select": "student_name,student_email,question_id,answer,image_ids,created_at",
        "order": "created_at",
    })
    subs = json.loads(api_get(base, key, f"/rest/v1/submissions?{q}"))
    if not subs:
        print(f"No submissions for quiz_id='{quiz_id}'.")
        return

    latest = {}     # (email, question_id) -> row
    students = {}   # email -> name
    for r in subs:  # oldest -> newest, so the last one wins
        email = (r.get("student_email") or "").strip().lower()
        students[email] = (r.get("student_name") or "").strip() or students.get(email, "")
        latest[(email, r["question_id"])] = r

    questions = sorted({qid for (_, qid) in latest}, key=qsort_key)

    # 2. map image id -> storage path
    iq = urllib.parse.urlencode({"quiz_id": f"eq.{quiz_id}", "select": "id,path"})
    imgs = json.loads(api_get(base, key, f"/rest/v1/answer_images?{iq}"))
    id2path = {row["id"]: row["path"] for row in imgs}

    outdir = f"{quiz_id}_export"
    os.makedirs(outdir, exist_ok=True)

    # 3. text answers as a wide CSV
    with open(os.path.join(outdir, "respostas.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["student_name", "student_email"] + questions + ["answered"])
        for email in sorted(students, key=lambda e: (students[e].lower(), e)):
            cells = [(latest.get((email, qid), {}).get("answer", "") or "") for qid in questions]
            answered = sum(1 for c in cells if c.strip())
            w.writerow([students[email], email] + cells + [answered])

    # 3b. timing log — EVERY submission with its timestamp, so you can see when
    # students answered (during class vs. later in the day) and how much they resent.
    with open(os.path.join(outdir, "tempos.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["student_name", "student_email", "question_id", "created_at_utc"])
        for r in subs:  # already ordered oldest -> newest
            w.writerow([r.get("student_name", ""), r.get("student_email", ""),
                        r["question_id"], r.get("created_at", "")])

    # 4. download the confirmed photos + build the markdown for analysis
    md = [f"# {quiz_id} — respostas\n"]
    total_imgs = 0
    for qid in questions:
        md.append(f"\n## {qid}\n")
        rows = sorted(
            [(e, r) for (e, qq), r in latest.items() if qq == qid],
            key=lambda t: students[t[0]].lower(),
        )
        for email, r in rows:
            name = students[email]
            ans = (r.get("answer") or "").strip()
            md.append(f"\n**{name}**\n{ans if ans else '(sem texto)'}\n")
            files = []
            for n, iid in enumerate(r.get("image_ids") or [], 1):
                path = id2path.get(iid)
                if not path:
                    continue
                ext = os.path.splitext(path)[1] or ".webp"
                fname = f"{qid}__{san(name)}__{n}{ext}"
                try:
                    data = api_get(base, key, f"/storage/v1/object/{BUCKET}/{path}")
                    with open(os.path.join(outdir, fname), "wb") as imgf:
                        imgf.write(data)
                    files.append(fname)
                    total_imgs += 1
                except Exception as ex:
                    md.append(f"- (falha ao baixar imagem: {ex})\n")
            if files:
                md.append("Fotos: " + ", ".join(f"`{x}`" for x in files) + "\n")

    with open(os.path.join(outdir, "para_analise.md"), "w", encoding="utf-8") as f:
        f.write("".join(md))

    print(f"Wrote {outdir}/  ({len(students)} students, {len(questions)} questions, {total_imgs} photos).")

if __name__ == "__main__":
    main()
