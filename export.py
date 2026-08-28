#!/usr/bin/env python3
"""
Export a quiz's answers (text + confirmed photos) from Supabase into ONE folder.
Same output as the admin panel's "Baixar" button — this is the offline/CLI path.

- Pure standard library (Python 3, any OS). Reads the service_role key from an
  environment variable OR a local .env file; it is never written to disk by this
  script. Deleting data still requires the Supabase dashboard (2FA) — this only READS.
- Keeps each student's LAST submission per question ("last wins"), and downloads
  only the photos that were confirmed with that submission.

Credentials — either export them, or put them in a .env file (git-ignored) next
to this script so you don't retype them:
    SUPABASE_URL="https://YOUR-PROJECT-REF.supabase.co"
    SUPABASE_SERVICE_ROLE_KEY="eyJ...service_role key..."

Usage:
    python3 export.py <quiz-id>              # -> <quiz-id>_export/  (git-ignored)
    python3 export.py <quiz-id> -o pasta     # custom output folder

Safe to run inside the repo: `*_export/` is git-ignored, and the script WARNS if
the chosen output folder is not ignored (so student data is never committed).

Output folder contents:
    respostas.csv     one row per student, one column per question (text answers)
    tempos.csv        every submission with its UTC timestamp
    para_analise.md   per question: each student's text + the filenames of their photos
    <qid>__<name>__<n>.<ext>   the photo files (flat)
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

BUCKET = "answers"


def load_dotenv(path):
    """Minimal .env loader: KEY=VALUE lines (optional quotes). Does not override
    variables already set in the real environment."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


def warn_if_not_ignored(outdir):
    """If we're inside a git repo and the output folder is NOT git-ignored, warn
    loudly — the folder holds student data and must never be committed."""
    try:
        inside = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            capture_output=True, text=True,
        )
        if inside.returncode != 0 or inside.stdout.strip() != "true":
            return  # not a git repo — nothing to guard against
        # trailing slash: `*_export/` is a directory pattern, and the folder may
        # not exist yet — the slash makes the match work either way.
        chk = subprocess.run(["git", "check-ignore", "-q", outdir.rstrip("/") + "/"], capture_output=True)
        if chk.returncode != 0:  # 0 = ignored; non-zero = NOT ignored
            print(
                f"\n  ⚠  AVISO: a pasta '{outdir}' NÃO está no .gitignore.\n"
                f"     Ela contém dados de alunos — NÃO faça commit dela.\n"
                f"     Adicione um padrão como '*_export/' ao .gitignore.\n",
                file=sys.stderr,
            )
    except FileNotFoundError:
        pass  # git not installed — skip the check


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
    ap = argparse.ArgumentParser(
        description="Exporta as respostas (texto + fotos) de um quiz do Supabase.")
    ap.add_argument("quiz_id", help="id do quiz, como aparece no painel do professor")
    ap.add_argument("-o", "--out", help="pasta de saída (padrão: <quiz-id>_export)")
    ap.add_argument("--env", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
                    help="arquivo .env com as credenciais (padrão: .env ao lado do script)")
    args = ap.parse_args()

    # Credentials: real env vars win; otherwise fall back to the .env file.
    load_dotenv(args.env)
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        sys.exit("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY "
                 "(variáveis de ambiente ou um arquivo .env).")

    quiz_id = args.quiz_id
    outdir = args.out or f"{quiz_id}_export"
    warn_if_not_ignored(outdir)

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
