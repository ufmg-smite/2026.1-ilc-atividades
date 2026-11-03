#!/usr/bin/env python3
"""Push Prova 2 to the grading page (correcao.html): run, 5 questions, one item per
(student, question) with its page images. NO proposals: grading starts blank.

Both versions (2 and 3) have the same questions, so the questions are shared.
Images go to answers/correcao/dcc638-prova2/<qid>/<student-slug>-<k>.webp.
Resumable: items already sent (pushed.json) are skipped.

    /home/dap/miniconda3/bin/python3 exam2_push.py
"""
import csv, json, os
import supa

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = os.path.join(ROOT, "dados", "pipeline", "exam2")
RUN, TITLE, DATE = "dcc638-prova2", "DCC638 — Prova 2 (2026.2)", "2026-10-31T12:00:00+00:00"
QUESTIONS = [   # statements are printed on the scans; 3(b) differs between versions 2 and 3
    ("q1", "1. (3 pontos) Erro numa demonstração (quadrados perfeitos) — pp. 1–2"),
    ("q2", "2. (4 pontos) f(x) = (x+1)/(x−1): bijeção e f∘f — p. 3"),
    ("q3", "3. (4 pontos) Conjuntos (o item b muda com a versão) — p. 4"),
    ("q4", "4. (4 pontos) Congruência módulo p, item (a) — p. 5"),
    ("q5", "4(b). Desafio (2 pontos extras) — p. 6"),
]

def main():
    items = json.load(open(os.path.join(W, "items.json")))
    emails = {r["matricula"]: r["email"].strip().lower()
              for r in csv.DictReader(open(os.path.join(ROOT, "dados", "relatorios", "acesso", "codigos_relatorio.csv"),
                                           encoding="utf-8")) if r.get("email")}
    supa.post("correction_runs?on_conflict=id", [dict(id=RUN, title=TITLE, created_at=DATE)],
              prefer="resolution=merge-duplicates,return=minimal")
    supa.post("correction_questions?on_conflict=run_id,question_id",
              [dict(run_id=RUN, question_id=q, prompt=p, position=i) for i, (q, p) in enumerate(QUESTIONS)],
              prefer="resolution=merge-duplicates,return=minimal")
    done_path = os.path.join(W, "pushed.json")
    done = set(json.load(open(done_path))) if os.path.exists(done_path) else set()
    todo = [it for it in items if f"{it['qid']}|{it['key']}" not in done]
    print(f"{RUN}: {len(todo)} items to send ({len(done)} already sent)", flush=True)
    for i, it in enumerate(todo, 1):
        paths = []
        for k, img in enumerate(it["images"], 1):
            obj = f"correcao/{RUN}/{it['qid']}/{it['key']}-{k}.webp"
            supa.upload(os.path.join(W, img), obj, content_type="image/webp")
            paths.append(obj)
        supa.post("correction_items?on_conflict=run_id,question_id,student_key",
                  [dict(run_id=RUN, question_id=it["qid"], student_key=it["key"], student_name=it["name"].title(),
                        student_email=emails.get(it["matricula"], ""), image_paths=paths, typed_answer="",
                        transcription="")],
                  prefer="resolution=merge-duplicates,return=minimal")
        done.add(f"{it['qid']}|{it['key']}")
        if i % 25 == 0 or i == len(todo):
            json.dump(sorted(done), open(done_path, "w"))
            print(f"  {i}/{len(todo)}", flush=True)
    print(f"done: {len(done)} items in {RUN}")

if __name__ == "__main__":
    main()
