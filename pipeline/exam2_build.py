#!/usr/bin/env python3
"""Prova 2: enhanced, compressed pages → per-student answers + one PDF with everything.

Inputs (dados/pipeline/exam2/, written by exam2_covers.py and checked by hand):
  pages.json     global reading order [(pdf, page)], 6 pages per booklet
  mapping.json   booklet → student (roster name, matrícula, turma, version)

Each page is rendered at 150 dpi in grayscale and enhanced for faint handwriting:
the paper is flattened to white (division by a blurred background estimate) and the
ink is stretched with a gamma < 1, so thin strokes get darker without breaking.
Two compressed copies are kept (resumable, one file per page in pages/):
  g####.webp   1100 px wide, WebP q30     → the per-question images (grading page)
  g####.jp2    JPEG 2000 at ~1/50 rate    → the single PDF

Outputs:
  items.json                one entry per (student, question), with its page images
  dados/exams/exam_2/prova2_todas.pdf   all booklets in scan order, one bookmark per student

Questions by booklet page: q1 = pp. 1–2, q2 = p. 3, q3 = p. 4, q4 = p. 5, q5 (desafio) = p. 6.

    nice -n 10 /home/dap/miniconda3/bin/python3 exam2_build.py
"""
import json, os, re, subprocess, tempfile, unicodedata
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = os.path.join(ROOT, "dados", "pipeline", "exam2")
PAGES = os.path.join(W, "pages")
PDF_OUT = os.path.join(ROOT, "dados", "exams", "exam_2", "prova2_todas.pdf")
QPAGES = {"q1": [0, 1], "q2": [2], "q3": [3], "q4": [4], "q5": [5]}
WIDTH, WEBP_Q, JP2_RATE = 1100, 30, 50

def enhance(im):
    a = np.asarray(im, dtype=float)
    bg = np.asarray(im.filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.GaussianBlur(20)), dtype=float) + 1
    ink = 1 - np.clip(a / bg, 0, 1)
    e = 1 - np.clip((ink - 0.01) / (0.30 - 0.01), 0, 1) ** 0.6
    return Image.fromarray((e * 255).astype("uint8"))

def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")

def main():
    os.makedirs(PAGES, exist_ok=True)
    pages = json.load(open(os.path.join(W, "pages.json")))
    tmp = tempfile.mkdtemp()
    for g, (pdf, p) in enumerate(pages):
        webp, jp2 = os.path.join(PAGES, f"g{g:04d}.webp"), os.path.join(PAGES, f"g{g:04d}.jp2")
        if os.path.exists(webp) and os.path.exists(jp2):
            continue
        raw = os.path.join(tmp, "r")
        subprocess.run(["pdftoppm", "-r", "150", "-gray", "-f", str(p), "-l", str(p), "-singlefile", pdf, raw], check=True)
        e = enhance(Image.open(raw + ".pgm"))
        e = e.resize((WIDTH, round(e.size[1] * WIDTH / e.size[0])), Image.LANCZOS)
        e.save(webp, quality=WEBP_Q, method=6)
        e.save(jp2, quality_mode="rates", quality_layers=[JP2_RATE], irreversible=True)
        if g % 60 == 0:
            print(f"page {g + 1}/{len(pages)}", flush=True)

    mapping = json.load(open(os.path.join(W, "mapping.json")))
    items = []
    for m in mapping:
        base = m["booklet"] * 6
        for qid, rel in QPAGES.items():
            items.append(dict(n=len(items), booklet=m["booklet"], name=m["nome"], matricula=m["matricula"],
                              turma=m["turma"], versao=m["versao"], key=slug(m["nome"]), qid=qid,
                              pages=[base + r for r in rel],
                              images=[os.path.relpath(os.path.join(PAGES, f"g{base + r:04d}.webp"), W) for r in rel]))
    json.dump(items, open(os.path.join(W, "items.json"), "w"), ensure_ascii=False, indent=1)

    import img2pdf, pypdf
    a4 = (img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297))
    raw_pdf = PDF_OUT + ".tmp"
    with open(raw_pdf, "wb") as f:
        f.write(img2pdf.convert([os.path.join(PAGES, f"g{g:04d}.jp2") for g in range(len(pages))],
                                layout_fun=img2pdf.get_layout_fun(a4)))
    r, w = pypdf.PdfReader(raw_pdf), pypdf.PdfWriter()
    w.append(r)
    for m in mapping:                                   # one bookmark per student
        w.add_outline_item(f"{m['nome'].title()} (v{m['versao']})", m["booklet"] * 6)
    with open(PDF_OUT, "wb") as f:
        w.write(f)
    os.remove(raw_pdf)
    print(f"items: {len(items)}; PDF: {PDF_OUT} ({os.path.getsize(PDF_OUT) // 1024 // 1024} MB, {len(pages)} pages)")

if __name__ == "__main__":
    main()
