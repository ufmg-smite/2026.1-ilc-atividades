#!/usr/bin/env python3
"""Local correction pipeline — the offline half of the correction app.

Nothing here talks to a paid API and no image ever leaves this machine: the
scans are preprocessed, transcribed and graded locally, and only the resulting
TEXT (transcription, criteria verdicts, justification) plus the cleaned-up
image is pushed to Supabase for review in correcao.html.

Typical run, start to finish:

    python3 run.py import-dir ../dados/exports/dcc638-atividade3_export --run dcc638-atv3
    python3 run.py preprocess  --run dcc638-atv3
    python3 run.py transcribe  --run dcc638-atv3 --model qwen3-vl:8b
    python3 run.py cluster     --run dcc638-atv3
    # define the barème once in correcao.html (key b), then:
    python3 run.py grade       --run dcc638-atv3 --model qwen3:8b
    python3 run.py push        --run dcc638-atv3

Every command is resumable: results land in work.db and finished rows are
skipped, so a crash, a reboot or a model swap costs only the item in flight.
The two model passes are separate commands because they should not be resident
at the same time — 8 GB of VRAM holds one of them well, or both of them badly.
"""
import argparse
import csv
import json
import os
import re
import sys
import time

import llm
import normalize
import preprocess
import prompts
import store
import supa

HERE = os.path.dirname(os.path.abspath(__file__))
# All course and student data lives in one git-ignored folder at the repo root
# (dados/exports, dados/correcoes, dados/pipeline) rather than beside the code
# it happens to be produced by. The code of the two apps stays separate; the
# data does not need to be.
WORK = os.path.join(os.path.dirname(HERE), "dados", "pipeline")
FNAME_RE = re.compile(r"^(?P<q>q[0-9a-z-]+)__(?P<slug>.+?)__(?P<n>\d+)\.(?P<ext>\w+)$")


def workdir(run_id, *parts):
    d = os.path.join(WORK, run_id, *parts)
    os.makedirs(d, exist_ok=True)
    return d


def db(run_id):
    os.makedirs(os.path.join(WORK, run_id), exist_ok=True)
    return store.Store(os.path.join(WORK, run_id, "work.db"))


def log(msg):
    print(msg, flush=True)


# ------------------------------------------------------------------ import
def cmd_import_dir(a):
    """Read a folder produced by export.py: q<N>__<slug>__<n>.<ext> + respostas.csv."""
    src = os.path.abspath(a.directory)
    if not os.path.isdir(src):
        raise SystemExit(f"pasta não encontrada: {src}")
    s = db(a.run)

    # roster + typed answers, when the export carried them
    roster, typed = {}, {}
    csv_path = os.path.join(src, "respostas.csv")
    if os.path.exists(csv_path):
        with open(csv_path, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                name = (row.get("student_name") or "").strip()
                if not name:
                    continue
                slug = normalize.slugify(name)
                roster[slug] = (name, (row.get("student_email") or "").strip().lower())
                for k, v in row.items():
                    if re.fullmatch(r"q\d+", k or "") and (v or "").strip():
                        typed[(slug, k)] = v

    found = {}
    for fn in sorted(os.listdir(src)):
        m = FNAME_RE.match(fn)
        if not m:
            continue
        key = (m["q"], m["slug"])
        found.setdefault(key, []).append(os.path.join(src, fn))

    # a student who typed an answer but attached no photo still needs a row
    for (slug, qid) in typed:
        found.setdefault((qid, slug), [])

    n = 0
    for (qid, slug), imgs in sorted(found.items()):
        name, email = roster.get(slug, (slug.replace("-", " ").title(), ""))
        s.upsert_item(
            run_id=a.run, question_id=qid, student_key=slug,
            student_name=name, student_email=email,
            images=json.dumps(sorted(imgs)),
            typed_answer=typed.get((slug, qid), ""),
        )
        n += 1
    log(f"{n} respostas importadas de {os.path.basename(src)}")

    qids = sorted({q for q, _ in found})
    if getattr(a, "push_questions", False):
        supa.ensure_run(a.run, a.title or a.run)
        supa.ensure_questions(a.run, [
            {"question_id": q, "prompt": "", "position": i} for i, q in enumerate(qids)
        ])
        log(f"run '{a.run}' criado no Supabase com {len(qids)} questões (defina o barema em correcao.html)")


def cmd_import_quiz(a):
    """Pull an activity straight from Supabase, downloading its photos locally."""
    s = db(a.run)
    quiz = supa.get(f"quizzes?id=eq.{supa.q(a.quiz)}&select=*")
    if not quiz:
        raise SystemExit(f"quiz não encontrado: {a.quiz}")
    quiz = quiz[0]
    subs = supa.get(
        f"submissions?quiz_id=eq.{supa.q(a.quiz)}"
        "&select=student_name,student_email,question_id,answer,image_ids,created_at&order=created_at"
    )
    imgs = supa.get(f"answer_images?quiz_id=eq.{supa.q(a.quiz)}&select=id,path")
    path_by_id = {str(r["id"]): r["path"] for r in imgs}

    latest = {}
    for sub in subs:
        key = (sub.get("student_email") or sub.get("student_name") or "anon").lower().strip()
        latest[(key, sub["question_id"])] = sub

    raw = workdir(a.run, "raw")
    n = 0
    for (key, qid), sub in sorted(latest.items()):
        local = []
        for iid in (sub.get("image_ids") or []):
            p = path_by_id.get(str(iid))
            if not p:
                continue
            dest = os.path.join(raw, f"{qid}__{normalize.slugify(key)}__{len(local) + 1}{os.path.splitext(p)[1] or '.webp'}")
            if not os.path.exists(dest):
                supa.download(p, dest)
            local.append(dest)
        s.upsert_item(
            run_id=a.run, question_id=qid, student_key=key,
            student_name=sub.get("student_name") or "", student_email=sub.get("student_email") or "",
            images=json.dumps(local), typed_answer=sub.get("answer") or "",
        )
        n += 1
    log(f"{n} respostas importadas do quiz {a.quiz}")

    supa.ensure_run(a.run, a.title or quiz["title"])
    supa.ensure_questions(a.run, [
        {"question_id": q["id"], "prompt": q.get("prompt") or "", "position": i}
        for i, q in enumerate(quiz.get("questions") or [])
    ])


# ------------------------------------------------------------------ preprocess
def rotations(run_id):
    """dados/pipeline/<run>/rotations.json: {"q1__ana-luiza__1": 180, ...}

    Manual, on purpose. A small VLM cannot tell you a page is upside down — it
    reports orientation 0 and then transcribes the rotated glyphs literally
    (an inverted `p` becomes `d`, `q` becomes `b`), which reads as a plausible
    wrong answer rather than as an error. Guessing is worse than a short list,
    and with flatbed scans this file stays empty.
    """
    f = os.path.join(WORK, run_id, "rotations.json")
    try:
        with open(f, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def cmd_preprocess(a):
    s = db(a.run)
    out = workdir(a.run, "prepared")
    rot = rotations(a.run)
    if rot:
        log(f"{len(rot)} imagens com rotação manual em rotations.json")
    rows = [r for r in s.all(a.run, a.question)
            if a.force or not store.jload(r["prepared"])]
    log(f"preparando {len(rows)} respostas…")
    for i, r in enumerate(rows, 1):
        prepared = []
        for k, src in enumerate(store.jload(r["images"]), 1):
            stem = f"{r['question_id']}__{r['student_key']}__{k}"
            dst = os.path.join(out, stem + ".webp")
            try:
                preprocess.prepare(src, dst, rotate=int(rot.get(stem, 0)))
                prepared.append(dst)
            except Exception as e:                      # noqa: BLE001
                log(f"  ! {os.path.basename(src)}: {e}")
        s.update(r["id"], prepared=json.dumps(prepared))
        if i % 20 == 0:
            log(f"  {i}/{len(rows)}")
    log("preprocessamento concluído")


# ------------------------------------------------------------------ transcribe
def cmd_transcribe(a):
    s = db(a.run)
    if a.retry_empty:
        n = s.db.execute(
            # `transcription is not null` matters: without it this also matches
            # rows never processed, and the reported count is meaningless.
            "update items set transcription=null where run_id=? and images!='[]' "
            "and transcription is not null and trim(transcription)=''", [a.run]).rowcount
        s.db.commit()
        log(f"{n} transcrições vazias marcadas para nova tentativa")
    rows = s.pending(a.run, "transcription", a.question)
    log(f"transcrevendo {len(rows)} respostas com {a.model}…")
    t0 = time.time()
    for i, r in enumerate(rows, 1):
        prepared = store.jload(r["prepared"])
        if not prepared:
            # nothing handwritten: the typed answer IS the transcription
            s.update(r["id"], transcription=r["typed_answer"] or "", legible=1,
                     model_transc="(digitada)")
            continue

        texts, legible = [], True
        for path in prepared:
            try:
                out = _transcribe_one(a.model, path, a.run, r, prepared.index(path) + 1)
            except Exception as e:                      # noqa: BLE001
                log(f"  ! {r['student_key']} {r['question_id']}: {e}")
                out = {"transcription": "", "legible": False}
            texts.append(out.get("transcription") or "")
            legible = legible and bool(out.get("legible", True))

        # Only what is written on the page. A student who also typed part of the
        # answer into the platform is graded here on the handwriting alone —
        # mixing the two would credit criteria that the scan does not evidence,
        # and the scan is the thing this pipeline exists to grade.
        s.update(r["id"], transcription="\n\n".join(t for t in texts if t).strip(),
                 legible=int(legible), model_transc=a.model)
        if i % 10 == 0:
            rate = (time.time() - t0) / i
            log(f"  {i}/{len(rows)}  (~{rate:.1f}s cada, faltam ~{rate * (len(rows) - i) / 60:.0f} min)")
    log("transcrição concluída")


def _transcribe_one(model, path, run_id, row, idx):
    """Read one prepared image.

    No orientation handling here on purpose. Scans come off the scanner upright,
    and a small VLM cannot detect rotation anyway — it reports orientation 0 and
    transcribes the rotated glyphs literally. For the rare crooked photo, record
    the angle once in dados/pipeline/<run>/rotations.json (see `run.py rotate`)
    and it is applied at preprocess time.
    """
    msgs = [{"role": "system", "content": prompts.TRANSCRIBE_SYSTEM},
            {"role": "user", "content": prompts.TRANSCRIBE_USER}]
    try:
        out = llm.chat_json(model, msgs, images=[path])
        return {"transcription": (out.get("transcription") or "").strip(),
                "legible": bool(out.get("legible", True))}
    except Exception as e:                          # noqa: BLE001
        # An unreadable page yields an empty transcription flagged illegible, so
        # it sorts to the front of the review queue instead of looking blank.
        log(f"    ({os.path.basename(path)}: {type(e).__name__}"
            f"{', truncado' if llm.last_call_truncated() else ''})")
        return {"transcription": "", "legible": False}


# ------------------------------------------------------------------ cluster
def cmd_cluster(a):
    s = db(a.run)
    rows = s.all(a.run, a.question)
    groups = {}
    for r in rows:
        key = normalize.cluster_key(r["transcription"] or r["typed_answer"])
        s.update(r["id"], cluster_key=key)
        if key:
            groups.setdefault((r["question_id"], key), []).append(r["student_key"])
    dupes = {k: v for k, v in groups.items() if len(v) > 1}
    log(f"{len(rows)} respostas, {len(groups)} respostas distintas, "
        f"{len(dupes)} grupos com repetição")
    for (qid, _), members in sorted(dupes.items(), key=lambda kv: -len(kv[1]))[:10]:
        log(f"  {qid}: {len(members)} respostas idênticas")


# ------------------------------------------------------------------ grade
def cmd_grade(a):
    s = db(a.run)
    rub = supa.rubric(a.run)
    rows = s.pending(a.run, "criteria", a.question)
    if a.only_images:
        # Typed answers are already perfect text — grading them exercises the
        # model but not the pipeline. When testing, spend the GPU on the scans.
        rows = [r for r in rows if store.jload(r["images"])]
    todo = []
    skipped = set()
    for r in rows:
        q = rub.get(r["question_id"])
        if not q or not q.get("criteria"):
            skipped.add(r["question_id"])
            continue
        todo.append(r)
    for qid in sorted(skipped):
        log(f"  ! {qid} sem barema definido — pulando (defina em correcao.html, tecla b)")
    log(f"avaliando {len(todo)} respostas com {a.model}…")

    t0 = time.time()
    for i, r in enumerate(todo, 1):
        q = rub[r["question_id"]]
        answer = r["transcription"] or r["typed_answer"] or ""
        prompt = prompts.grading_prompt(q, q["criteria"], answer)
        try:
            out = llm.chat_json(a.model, [{"role": "user", "content": prompt}],
                                think=not a.no_think,
                                num_predict=4096 if not a.no_think else 1024)
        except Exception as e:                          # noqa: BLE001
            log(f"  ! {r['student_key']} {r['question_id']}: {e}")
            continue
        verdicts = out.get("criteria") or {}
        clean = {c["key"]: {"met": bool(verdicts.get(c["key"], {}).get("met")),
                            "note": str(verdicts.get(c["key"], {}).get("note") or "")[:400]}
                 for c in q["criteria"]}
        s.update(r["id"], criteria=json.dumps(clean, ensure_ascii=False),
                 justification=(out.get("justification") or "")[:2000], model_grade=a.model)
        if i % 10 == 0:
            rate = (time.time() - t0) / i
            log(f"  {i}/{len(todo)}  (~{rate:.1f}s cada, faltam ~{rate * (len(todo) - i) / 60:.0f} min)")
    log("avaliação concluída")


# ------------------------------------------------------------------ push
def cmd_push(a):
    s = db(a.run)
    rows = [r for r in s.all(a.run, a.question) if a.force or not r["pushed"]]
    if a.only_images:
        rows = [r for r in rows if store.jload(r["images"])]
    if a.proposals_only:
        # After a grading pass the items are already up; only the new proposals
        # need to go. correction_proposals is append-only and the newest row
        # wins, so re-sending one is a new proposal, not a duplicate to clean up.
        rows = [r for r in s.all(a.run, a.question) if r["criteria"]]
        if a.only_images:
            rows = [r for r in rows if store.jload(r["images"])]
    log(f"enviando {len(rows)} respostas para o Supabase…")

    for i, r in enumerate(rows, 1):
        paths = []
        for k, local in enumerate([] if a.proposals_only else store.jload(r["prepared"]), 1):
            obj = f"correcao/{a.run}/{r['question_id']}/{r['student_key']}-{k}.webp"
            supa.upload(local, obj, content_type="image/webp")
            paths.append(obj)

        if a.proposals_only:
            # item and images are already up; the text may have changed though
            supa.patch(
                f"correction_items?run_id=eq.{supa.q(a.run)}"
                f"&question_id=eq.{supa.q(r['question_id'])}"
                f"&student_key=eq.{supa.q(r['student_key'])}",
                {"transcription": r["transcription"] or "",
                 "cluster_key": r["cluster_key"]},
            )
        else:
            supa.post(
            "correction_items?on_conflict=run_id,question_id,student_key",
            [{
                "run_id": a.run, "question_id": r["question_id"], "student_key": r["student_key"],
                "student_name": r["student_name"], "student_email": r["student_email"],
                "image_paths": paths, "typed_answer": r["typed_answer"] or "",
                "transcription": r["transcription"] or "", "cluster_key": r["cluster_key"],
            }],
            prefer="resolution=merge-duplicates,return=minimal",
            )

        if r["criteria"]:
            item = supa.get(
                f"correction_items?run_id=eq.{supa.q(a.run)}"
                f"&question_id=eq.{supa.q(r['question_id'])}"
                f"&student_key=eq.{supa.q(r['student_key'])}&select=id"
            )
            if item:
                supa.post("correction_proposals", [{
                    "item_id": item[0]["id"],
                    "criteria": json.loads(r["criteria"]),
                    "justification": r["justification"] or "",
                    "model": r["model_grade"] or "", "source": "batch",
                }])
        s.update(r["id"], pushed=1)
        if i % 20 == 0:
            log(f"  {i}/{len(rows)}")
    log("envio concluído — abra correcao.html para corrigir")


# ------------------------------------------------------------------ status
def cmd_rotate(a):
    """Record a rotation for one image and re-prepare it immediately."""
    table = rotations(a.run)
    table[a.image] = a.degrees
    path = os.path.join(WORK, a.run, "rotations.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(table, fh, indent=2, sort_keys=True)

    s = db(a.run)
    qid, student = a.image.split("__")[0], a.image.split("__")[1]
    idx = int(a.image.split("__")[2]) if len(a.image.split("__")) > 2 else 1
    rows = [r for r in s.all(a.run, qid) if r["student_key"] == student]
    if not rows:
        raise SystemExit(f"não encontrei {a.image}")
    r = rows[0]
    src = store.jload(r["images"])[idx - 1]
    dst = os.path.join(workdir(a.run, "prepared"), a.image + ".webp")
    preprocess.prepare(src, dst, rotate=a.degrees)
    # force a re-read on the next transcribe pass
    s.update(r["id"], transcription=None, criteria=None, pushed=0)
    log(f"{a.image} girada {a.degrees}° e marcada para nova transcrição")


def cmd_status(a):
    s = db(a.run)
    print(f"{'questão':<10}{'total':>7}{'transcritas':>13}{'avaliadas':>11}{'enviadas':>10}")
    for c in s.counts(a.run):
        print(f"{c['question_id']:<10}{c['total']:>7}{c['transcribed'] or 0:>13}"
              f"{c['graded'] or 0:>11}{c['pushed'] or 0:>10}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, *, run=True, question=False):
        p = sub.add_parser(name)
        p.set_defaults(func=fn)
        if run:
            p.add_argument("--run", required=True, help="id da correção, ex.: dcc638-atv3")
        if question:
            p.add_argument("--question", help="limitar a uma questão, ex.: q1")
        return p

    p = add("import-dir", cmd_import_dir)
    p.add_argument("directory")
    p.add_argument("--title", help="título da correção no Supabase")
    p.add_argument("--push-questions", action="store_true",
                   help="também criar a run e as questões no Supabase (exige credenciais)")

    p = add("import-quiz", cmd_import_quiz)
    p.add_argument("quiz", help="id do quiz no Supabase")
    p.add_argument("--title")

    p = add("preprocess", cmd_preprocess, question=True)
    p.add_argument("--force", action="store_true", help="refazer imagens já preparadas")

    p = add("rotate", cmd_rotate)
    p.add_argument("--image", required=True, help="ex.: q1__ana-luiza__1")
    p.add_argument("--degrees", type=int, required=True, choices=[90, 180, 270])

    p = add("transcribe", cmd_transcribe, question=True)
    p.add_argument("--model", required=True, help="modelo de visão, ex.: qwen3-vl:4b-instruct")
    p.add_argument("--retry-empty", action="store_true",
                   help="tentar de novo as que saíram vazias (falha, não resposta em branco)")

    add("cluster", cmd_cluster, question=True)

    p = add("grade", cmd_grade, question=True)
    p.add_argument("--model", required=True, help="modelo de texto, ex.: qwen3:8b")
    p.add_argument("--only-images", action="store_true",
                   help="avaliar só as respostas manuscritas (ignora as digitadas)")
    p.add_argument("--no-think", action="store_true",
                   help="desligar o raciocínio do modelo: ~4x mais rápido e "
                        "mediblemente pior (ver pipeline/README.md)")

    p = add("push", cmd_push, question=True)
    p.add_argument("--force", action="store_true", help="reenviar mesmo o que já foi enviado")
    p.add_argument("--proposals-only", action="store_true",
                   help="enviar só as propostas do modelo (itens e imagens já estão lá)")
    p.add_argument("--only-images", action="store_true",
                   help="enviar só as respostas manuscritas (ignora as digitadas)")
    add("status", cmd_status)

    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    sys.exit(main())
