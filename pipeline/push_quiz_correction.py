#!/usr/bin/env python3
"""Load one quiz into the correction platform (correcao.html) with pre-corrections.

Inputs (private, under dados/relatorios/quizzes/<quiz>/):
  items.json      every student's LAST answer per question, read from the database
                  (typed text, storage paths of the photos, an earlier verdict if reused)
  barema.json     {"q1": [{"id","label","detail","points"}, ...], ...}
  veredito_*.json {"<n>": {"criteria": {"c1": true, ...}, "nota": "...", "transcricao": "..."}}

Creates/updates the correction run (id = quiz id), its questions, the barème criteria
and one correction_item per answer (photos point at the quiz's own files in the private
bucket, nothing is copied), then appends a proposal (criteria met + short note) for every
item that has no proposal yet. Grades are never written: the teacher accepts/adjusts in
correcao.html. Safe to re-run.

    /home/dap/miniconda3/bin/python3 push_quiz_correction.py --quiz ilc-atividade11
"""
import argparse, glob, json, os
from datetime import datetime
import supa

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiz", required=True)
    a = ap.parse_args()
    D = os.path.join(ROOT, "dados", "relatorios", "quizzes", a.quiz)
    items = json.load(open(f"{D}/items.json", encoding="utf-8"))
    barema = json.load(open(f"{D}/barema.json", encoding="utf-8"))
    ver = {}
    for f in sorted(glob.glob(f"{D}/veredito_*.json")):
        ver.update(json.load(open(f, encoding="utf-8")))

    quiz = supa.get(f"quizzes?id=eq.{a.quiz}&select=id,title,opened_at,questions")[0]
    when = datetime.fromisoformat(quiz["opened_at"]).strftime("%d/%m") if quiz.get("opened_at") else ""
    num = a.quiz.rsplit("atividade", 1)[-1]
    supa.post("correction_runs?on_conflict=id",
              [dict(id=a.quiz, title=f"Atividade {num} ({when})", source=a.quiz)],
              prefer="resolution=merge-duplicates,return=minimal")
    qs = quiz["questions"]
    supa.post("correction_questions?on_conflict=run_id,question_id",
              [dict(run_id=a.quiz, question_id=q["id"], prompt=q["prompt"], position=i) for i, q in enumerate(qs)],
              prefer="resolution=merge-duplicates,return=minimal")
    crit = [dict(run_id=a.quiz, question_id=qid, key=c["id"], label=c["label"], detail=c["detail"],
                 points=c["points"], position=k, active=True)
            for qid, cs in barema.items() for k, c in enumerate(cs)]
    supa.post("correction_criteria?on_conflict=run_id,question_id,key", crit,
              prefer="resolution=merge-duplicates,return=minimal")

    # items
    rows, missing = [], []
    for it in items:
        v = ver.get(str(it["n"]))
        tr = (v or {}).get("transcricao", "") or ""
        if it["typed"] and tr:
            tr = it["typed"] + "\n\n--- foto anexada ---\n" + tr
        rows.append(dict(run_id=a.quiz, question_id=it["qid"], student_key=it["key"],
                         student_name=it["name"], student_email=it["email"],
                         image_paths=it["image_paths"], typed_answer=it["typed"], transcription=tr))
        if it["prior"] is None and v is None:
            missing.append(it["n"])
    saved = []
    for i in range(0, len(rows), 200):
        saved += supa.post("correction_items?on_conflict=run_id,question_id,student_key", rows[i:i + 200],
                           prefer="return=representation,resolution=merge-duplicates")
    idmap = {(r["question_id"], r["student_key"]): r["id"] for r in saved}

    # proposals (only for items without one yet)
    have = set()
    ids = list(idmap.values())
    for i in range(0, len(ids), 150):
        have |= {p["item_id"] for p in supa.get(
            f"correction_proposals?item_id=in.({','.join(map(str, ids[i:i+150]))})&select=item_id&limit=1000")}
    props = []
    for it in items:
        iid = idmap[(it["qid"], it["key"])]
        if iid in have:
            continue
        v = ver.get(str(it["n"]))
        verdict = it["prior"] if it["prior"] is not None else (v or {}).get("criteria")
        if verdict is None:
            continue
        props.append(dict(item_id=iid, model="claude",
                          criteria={k: {"met": bool(m), "note": ""} for k, m in verdict.items()},
                          justification=(v or {}).get("nota", "") if it["prior"] is None else ""))
    for i in range(0, len(props), 200):
        supa.post("correction_proposals", props[i:i + 200])
    print(f"{a.quiz}: {len(qs)} questions, {len(crit)} criteria, {len(rows)} items, "
          f"{len(props)} new proposals; without verdict yet: {len(missing)}")

if __name__ == "__main__":
    main()
