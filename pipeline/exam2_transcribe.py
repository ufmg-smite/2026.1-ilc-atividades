#!/usr/bin/env python3
"""Prova 2: local transcription of the answer pages, attached to the grading page.

The local vision model (nothing leaves the machine) reads each page of
dados/pipeline/exam2/pages/ with the handwriting-only prompt of the quiz photos, in
QUESTION order (q1 for all students first, then q2, q3, q4, q5), so the question being
graded gets its transcriptions first. On the cover page only the answer box is read
(the name/matrícula strip and the statement are cropped away).

As soon as all pages of an answer are done, its text is written to
correction_items.transcription (read with "v" in correcao.html). No score, no proposal.
Gentle (tight VLM loops have crashed WSL): pause between calls, model unloaded + rest
every BATCH calls. Resumable: one JSON per page in dados/pipeline/exam2/transcr/.

    nice -n 10 /home/dap/miniconda3/bin/python3 exam2_transcribe.py
"""
import json, os, time
import requests
from PIL import Image
import llm, preprocess, supa
from transcribe_exams import TRANSCRIBE_SYSTEM, MODEL
from transcribe_quiz_photos import PROMPT, clean

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = os.path.join(ROOT, "dados", "pipeline", "exam2")
OUT = os.path.join(W, "transcr")
RUN = "dcc638-prova2"
ORDER = ["q1", "q2", "q3v2", "q3v3", "q4", "q5"]
NUM_PREDICT = 2048
PAUSE = float(os.environ.get("EXAM_PAUSE", "1.5"))     # was 3 s / 25 / 90 s; still sequential, one process
BATCH = int(os.environ.get("EXAM_BATCH", "40"))
REST = float(os.environ.get("EXAM_REST", "45"))
COVER_TOP = 780          # px of the 1400-wide page: name strip + statement of Q1 above it

def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)

def transcribe(g):
    dst = os.path.join(OUT, f"g{g:04d}.json")
    if os.path.exists(dst):
        return json.load(open(dst, encoding="utf-8"))
    src = os.path.join(W, "pages", f"g{g:04d}.webp")
    tmp = os.path.join(OUT, f"g{g:04d}.src.png")
    im = Image.open(src)
    if g % 6 == 0:
        im = im.crop((0, COVER_TOP, im.size[0], im.size[1]))
    im.save(tmp)
    prep = os.path.join(OUT, f"g{g:04d}.prep.webp")
    t0 = time.time()
    try:
        preprocess.prepare(tmp, prep)
        txt = (llm.chat(MODEL, [{"role": "system", "content": TRANSCRIBE_SYSTEM}, {"role": "user", "content": PROMPT}],
                        images=[prep], json_mode=False, think=False, num_predict=NUM_PREDICT) or "").strip()
        rec = {"text": txt, "truncated": llm.last_call_truncated()}
    except Exception as e:  # noqa: BLE001 — one bad page must not stop the run
        rec = {"text": "", "error": str(e)[:300]}
    for f in (tmp, prep):
        try:
            os.remove(f)
        except OSError:
            pass
    json.dump(rec, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log(f"  g{g:04d} ({time.time() - t0:.0f}s)")
    return rec

def main():
    os.makedirs(OUT, exist_ok=True)
    items = json.load(open(os.path.join(W, "items.json"), encoding="utf-8"))
    sent_path = os.path.join(W, "transcr_sent.json")
    sent = set(json.load(open(sent_path))) if os.path.exists(sent_path) else set()
    calls = 0
    for qid in ORDER:
        todo = [it for it in items if it["qid"] == qid]
        log(f"=== {qid}: {len(todo)} respostas")
        for it in todo:
            tag = f"{qid}|{it['key']}"
            if tag in sent:
                continue
            parts = []
            for i, g in enumerate(it["pages"]):
                fresh = not os.path.exists(os.path.join(OUT, f"g{g:04d}.json"))
                rec = transcribe(g)
                if fresh:
                    calls += 1
                    time.sleep(PAUSE)
                    if calls % BATCH == 0:
                        try:
                            requests.post(f"{llm.API_BASE}/api/generate", json={"model": MODEL, "keep_alive": 0}, timeout=60)
                        except Exception:  # noqa: BLE001
                            pass
                        log(f"  pausa de {REST}s (modelo descarregado)")
                        time.sleep(REST)
                t = clean(rec) if rec.get("text") else "[transcrição falhou]"
                if t.strip("[]. ").lower() == "em branco":
                    t = "[em branco]"
                parts.append(f"[página {g % 6 + 1}]\n{t}" if len(it["pages"]) > 1 else t)
            supa.patch(f"correction_items?run_id=eq.{RUN}&question_id=eq.{qid}&student_key=eq.{it['key']}",
                       {"transcription": "\n\n".join(parts)})
            sent.add(tag)
            json.dump(sorted(sent), open(sent_path, "w"))
        log(f"=== {qid}: concluído")
    log("DONE")

if __name__ == "__main__":
    main()
