#!/usr/bin/env python3
"""Transcribe quiz answer photos with the local vision model (nothing leaves the machine).

Reads dados/relatorios/quizzes/<quiz>/anon.json (written by export_quiz_items.py) and, for
every answer with photos, preprocesses each photo (preprocess.py) and transcribes it with
the same handwriting-only prompt as transcribe_exams.py. Writes

    dados/relatorios/quizzes/<quiz>/transcricao_local.json   {"<n>": "text", ...}

with the pages of one answer joined in order (a truncated page is cut where the model started
looping, see clean()). Resumable: one cache JSON per photo under
transcricao_local/, so an interrupted run only repeats the photo in flight.

    /home/dap/miniconda3/bin/python3 transcribe_quiz_photos.py dcc638-atividade2 ilc-atividade7 ...
"""
import json, os, re, sys, time
import requests
import llm, preprocess
from transcribe_exams import TRANSCRIBE_SYSTEM, MODEL

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Run GENTLY: a tight loop of VLM calls has crashed WSL twice (after ~130 and ~250 calls).
# Pause between calls, and every BATCH photos unload the model and rest.
NUM_PREDICT = int(os.environ.get("QUIZ_NUM_PREDICT", "2048"))
PAUSE = float(os.environ.get("QUIZ_PAUSE", "3"))
BATCH = int(os.environ.get("QUIZ_BATCH", "25"))
REST = float(os.environ.get("QUIZ_REST", "90"))
_calls = 0

def unload_and_rest():
    try:
        requests.post(f"{llm.API_BASE}/api/generate", json={"model": MODEL, "keep_alive": 0}, timeout=60)
    except Exception:  # noqa: BLE001
        pass
    log(f"  pausa de {REST:.0f}s (modelo descarregado)")
    time.sleep(REST)

PROMPT = """Transcreva APENAS o que o ALUNO escreveu À MÃO nesta foto (resposta a um exercício de lógica/matemática).

REGRAS:
- Transcreva o que está escrito, mesmo que ERRADO. Não corrija, não complete,
  não resolva o exercício.
- Símbolos matemáticos em UNICODE (∀ ∃ ¬ ∧ ∨ → ↔ ≡ ∈ ∉ ⊆ ∪ ∩ ≥ ≤ ≠ ℕ ℤ), nunca LaTeX nem cifrões.
- Mantenha a estrutura: itens a), b), c), uma linha por linha escrita.
- Texto riscado pelo aluno: ignore.
- Trecho ilegível: escreva [ilegível] no lugar. NUNCA repita um símbolo ou uma
  linha para preencher espaço.
- Responda APENAS com a transcrição, em texto puro — sem JSON, sem comentários.
- Se não houver NADA manuscrito, responda exatamente: [em branco]"""

LOOP_NOTE = "[transcrição interrompida: o modelo entrou em repetição — ver a foto]"

def clean(rec):
    """Cut a truncated transcription where the model started looping (the cache keeps the raw text)."""
    txt = rec.get("text", "")
    if not rec.get("truncated"):
        return txt
    txt = re.sub(r"(.{2,200}?)\1{3,}", r"\1", txt, flags=re.S)   # a phrase repeated in a row
    out, seen = [], {}
    for line in txt.splitlines():
        k = re.sub(r"^\(?\d+\)\s*", "", line.strip())             # ignore the model's own numbering
        if k:
            seen[k] = seen.get(k, 0) + 1
            if seen[k] > 2:                                   # a line already seen twice: loop
                break
        out.append(line)
    return "\n".join(out).rstrip() + "\n" + LOOP_NOTE

def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)

def run(quiz):
    D = os.path.join(ROOT, "dados", "relatorios", "quizzes", quiz)
    anon = json.load(open(f"{D}/anon.json", encoding="utf-8"))
    todo = [a for a in anon["answers"] if a["photos"]]
    cache = f"{D}/transcricao_local"; os.makedirs(cache, exist_ok=True)
    out = {}
    log(f"=== {quiz}: {sum(len(a['photos']) for a in todo)} fotos em {len(todo)} respostas")
    for k, a in enumerate(todo, 1):
        pages = []
        for p in a["photos"]:
            base = os.path.splitext(os.path.basename(p))[0]
            cj = f"{cache}/{base}.json"
            if not os.path.exists(cj):
                t0 = time.time()
                try:
                    prep = f"{cache}/{base}.prep.webp"
                    preprocess.prepare(f"{D}/{p}", prep)
                    txt = (llm.chat(MODEL, [{"role": "system", "content": TRANSCRIBE_SYSTEM},
                                            {"role": "user", "content": PROMPT}],
                                    images=[prep], json_mode=False, think=False,
                                    num_predict=NUM_PREDICT) or "").strip()
                    rec = {"text": txt, "truncated": llm.last_call_truncated()}
                except Exception as e:  # noqa: BLE001 — one bad photo must not stop the batch
                    rec = {"text": "", "error": str(e)[:300]}
                json.dump(rec, open(cj, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
                log(f"  {quiz} {k}/{len(todo)} {base} ({time.time()-t0:.0f}s)")
                global _calls
                _calls += 1
                time.sleep(PAUSE)
                if _calls % BATCH == 0:
                    unload_and_rest()
            pages.append(clean(json.load(open(cj, encoding="utf-8"))))
        txt = "\n\n".join(t for t in pages if t and t.strip("[]. ").lower() != "em branco")
        out[str(a["n"])] = txt
        json.dump(out, open(f"{D}/transcricao_local.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log(f"=== {quiz}: concluído ({len(out)} respostas)")

if __name__ == "__main__":
    for q in sys.argv[1:]:
        run(q)
