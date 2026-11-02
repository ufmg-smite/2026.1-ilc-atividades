#!/usr/bin/env python3
"""Export one quiz's answers for grading: items.json, photos, and an anonymized copy.

Writes under dados/relatorios/quizzes/<quiz>/ (private):
  items.json      every student's LAST answer per question (typed text + storage paths
                  of the photos), the input of push_quiz_correction.py; empty answers skipped
  fotos/          the answer photos, downloaded from the private bucket (q<k>__<n>_<i>.<ext>)
  anon.json       {"questions": {qid: prompt}, "answers": [{"n", "qid", "typed", "photos"}]}
                  — no names/e-mails, for analysing the answers / writing the barème

Submissions are read paginated (PostgREST caps a response at 1000 rows). Safe to re-run:
photos already downloaded are skipped.

    /home/dap/miniconda3/bin/python3 export_quiz_items.py --quiz dcc638-atividade1
"""
import argparse, json, os
import supa

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def allrows(path):
    out, off = [], 0
    while True:
        r = supa.get(f"{path}&limit=1000&offset={off}")
        out += r; off += 1000
        if len(r) < 1000:
            return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiz", required=True)
    a = ap.parse_args()
    D = os.path.join(ROOT, "dados", "relatorios", "quizzes", a.quiz)
    os.makedirs(f"{D}/fotos", exist_ok=True)

    quiz = supa.get(f"quizzes?id=eq.{a.quiz}&select=questions")[0]
    order = [q["id"] for q in quiz["questions"]]
    subs = allrows(f"submissions?quiz_id=eq.{a.quiz}&select=student_email,student_name,question_id,answer,image_ids&order=created_at,id")
    paths = {im["id"]: im["path"] for im in allrows(f"answer_images?quiz_id=eq.{a.quiz}&select=id,path&order=id")}

    last, names = {}, {}
    for s in subs:
        key = (s["student_email"] or "").strip().lower()
        if (s["student_name"] or "").strip():
            names[key] = s["student_name"].strip()
        last[(key, s["question_id"])] = s
    keys = sorted({k for k, _ in last}, key=lambda k: (names.get(k, "").lower(), k))

    items = []
    for key in keys:
        for qid in order:
            s = last.get((key, qid))
            if not s:
                continue
            typed = (s["answer"] or "").strip()
            imgs = [paths[i] for i in (s["image_ids"] or []) if i in paths]
            if not typed and not imgs:
                continue
            items.append(dict(n=len(items), key=key, name=names.get(key, ""), email=key, qid=qid,
                              typed=typed, image_paths=imgs, prior=None))

    anon = {"questions": {q["id"]: q["prompt"] for q in quiz["questions"]}, "answers": []}
    nphoto = 0
    for it in items:
        local = []
        for i, p in enumerate(it["image_paths"], 1):
            dst = f"{D}/fotos/{it['qid']}__{it['n']:04d}_{i}{os.path.splitext(p)[1] or '.webp'}"
            if not os.path.exists(dst):
                supa.download(p, dst)
            local.append(os.path.relpath(dst, D)); nphoto += 1
        anon["answers"].append(dict(n=it["n"], qid=it["qid"], typed=it["typed"], photos=local))

    json.dump(items, open(f"{D}/items.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(anon, open(f"{D}/anon.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{a.quiz}: {len(keys)} students, {len(items)} answers, {nphoto} photos")

if __name__ == "__main__":
    main()
