#!/usr/bin/env python3
"""Prova 2: page order of the scans + read version, name and matrícula on each cover.

The scans are dados/exams/exam_2/p1.pdf … p11.pdf, ~10 booklets each, in alphabetical
order. p1.pdf is in reading order; p2–p11 were scanned backwards (whole file reversed).
Every booklet has exactly 6 pages (checked: covers every 6 pages, printed page numbers
1–6 in order), so booklet k = global pages 6k … 6k+5 of the reordered sequence.

For each cover, the header strip (Versão, Estudante, Matrícula) is read by the LOCAL
vision model, gently (pause between calls, model unloaded + rest every BATCH calls:
tight VLM loops have crashed WSL). Resumable: one JSON per booklet in OUT.

    nice -n 10 /home/dap/miniconda3/bin/python3 exam2_covers.py
"""
import json, os, re, subprocess, sys, time
import requests
import llm

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCANS = os.path.join(ROOT, "dados", "exams", "exam_2")
OUT = os.path.join(ROOT, "dados", "pipeline", "exam2", "covers")
MODEL = "qwen3-vl:4b-instruct"
PAUSE, BATCH, REST = 3, 25, 90
PAGES_PER_BOOKLET = 6

def pages():
    """Global reading order: [(pdf path, 1-based page in that pdf)]."""
    out = []
    for i in range(1, 12):
        f = os.path.join(SCANS, f"p{i}.pdf")
        n = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", f], capture_output=True, text=True).stdout).group(1))
        order = range(1, n + 1) if i == 1 else range(n, 0, -1)
        out += [(f, p) for p in order]
    return out

PROMPT = ("Esta é a parte de cima da folha de rosto de uma prova. Leia:\n"
          "- a versão impressa ('VERSÃO N', no canto superior direito);\n"
          "- o nome manuscrito no campo 'Estudante';\n"
          "- os dígitos manuscritos no campo 'Matrícula' (normalmente 10).\n"
          'Responda APENAS em JSON: {"versao": <número>, "nome": "<nome>", "matricula": "<dígitos ou vazio>"}')

def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)

def main():
    os.makedirs(OUT, exist_ok=True)
    P = pages()
    assert len(P) % PAGES_PER_BOOKLET == 0, len(P)
    json.dump(P, open(os.path.join(os.path.dirname(OUT), "pages.json"), "w"))
    calls = 0
    for k in range(len(P) // PAGES_PER_BOOKLET):
        dst = os.path.join(OUT, f"b{k:03d}.json")
        if os.path.exists(dst):
            continue
        f, p = P[k * PAGES_PER_BOOKLET]
        crop = os.path.join(OUT, f"b{k:03d}")
        subprocess.run(["pdftoppm", "-r", "150", "-gray", "-f", str(p), "-l", str(p), "-x", "0", "-y", "120",
                        "-W", "1240", "-H", "230", "-singlefile", "-png", f, crop], check=True)
        try:
            txt = llm.chat(MODEL, [{"role": "user", "content": PROMPT}], images=[crop + ".png"],
                           json_mode=False, think=False, num_predict=120, temperature=0) or ""
        except Exception as e:  # noqa: BLE001
            txt = f"ERR {e}"
        m = re.search(r"\{.*\}", txt, re.S)
        try:
            rec = json.loads(m.group(0)) if m else {}
        except Exception:  # noqa: BLE001
            rec = {}
        rec.update(booklet=k, pdf=os.path.basename(f), page=p, raw=txt.strip()[:300])
        json.dump(rec, open(dst, "w"), ensure_ascii=False, indent=1)
        log(f"b{k:03d} {rec.get('versao')} | {rec.get('nome')} | {rec.get('matricula')}")
        calls += 1
        time.sleep(PAUSE)
        if calls % BATCH == 0:
            try:
                requests.post(f"{llm.API_BASE}/api/generate", json={"model": MODEL, "keep_alive": 0}, timeout=60)
            except Exception:  # noqa: BLE001
                pass
            log(f"  pausa {REST}s (modelo descarregado)")
            time.sleep(REST)
    log("DONE")

if __name__ == "__main__":
    main()
