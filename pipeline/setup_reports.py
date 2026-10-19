#!/usr/bin/env python3
"""Fill the "Minhas correções" tables (supabase/student_reports.sql).

Subcommands (run supabase/student_reports.sql first):

  access      hash the PRIVATE local codes (dados/relatorios/acesso/codigos_relatorio.csv,
              generated offline with `secrets`) into student_access — salted
              PBKDF2-SHA256, 100000 iterations; the code itself is never sent or printed.
              Must match the check in supabase/functions/relatorios/index.ts.
  run         report_runs + report_questions for one correction run: title, nota_base,
              question number per version (from the booklet page order), titles, and the
              gabaritos in dados/relatorios/gabaritos/<run>.json (+ uploads their assets).
              Never touches `published` once the run exists.
  link        report_students: matrícula -> graded booklet (correction_items.student_key),
              from the human-verified name mapping (dados/attendence_list/notas_prova1.csv).
  test        two staff test accounts (preview: they see unpublished runs), linked to two
              real booklets; their codes are written to dados/relatorios/acesso/teste.csv.
  publish     set report_runs.published (--off to hide again).

    /home/dap/miniconda3/bin/python3 setup_reports.py access
    /home/dap/miniconda3/bin/python3 setup_reports.py run --run dcc638-prova1 --title "Prova 1" --base 25
"""
import argparse, csv, hashlib, json, os, re, secrets
from collections import Counter, defaultdict
import supa

HERE = os.path.dirname(os.path.abspath(__file__))
DADOS = os.path.join(os.path.dirname(HERE), "dados")
ACCESS_CSV = os.path.join(DADOS, "relatorios", "acesso", "codigos_relatorio.csv")
TEST_CSV = os.path.join(DADOS, "relatorios", "acesso", "teste.csv")
ITER = 100000
ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
TYPE_TITLE = {"contra_modelo": "Contra-modelo", "consistencia": "Consistência de especificação",
              "formalizacao": "Formalização e equivalência", "resolucao": "Resolução (dedução natural)"}
# graded under a cancelled matrícula; the active one (with the e-mail) is used
MATRICULA_FIX = {"2025037834": "2026302850"}   # Lun Felix Pinto

def norm_code(c):
    return re.sub(r"[^A-Z0-9]", "", c.upper())

def access_row(matricula, nome, code, preview=False):
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", norm_code(code).encode(), bytes.fromhex(salt), ITER).hex()
    return dict(matricula=re.sub(r"\D", "", matricula), nome=nome.strip(), code_salt=salt,
                code_hash=h, iterations=ITER, active=True, preview=preview)

def upsert(table, rows, key):
    for i in range(0, len(rows), 200):
        supa.post(f"{table}?on_conflict={key}", rows[i:i + 200], prefer="resolution=merge-duplicates,return=minimal")

def cmd_access(a):
    rows = [access_row(r["matricula"], r["nome"], r["codigo_relatorio"]) for r in csv.DictReader(open(ACCESS_CSV, encoding="utf-8"))]
    upsert("student_access", rows, "matricula")
    print(f"student_access: {len(rows)} students upserted (codes not shown)")

def booklet_order(run):
    """question_id -> number in its version's booklet, by majority of page order."""
    cl = json.load(open(os.path.join(DADOS, "pipeline", "exam_transcriptions", "clusters.json"), encoding="utf-8"))
    by_student = defaultdict(list)
    for r in cl:
        by_student[(r["versao"], r["slug"])].append((min(r["pages"]), r["question"]))
    votes = defaultdict(Counter)
    for (v, _), qs in by_student.items():
        for n, (_, q) in enumerate(sorted(qs), 1):
            votes[f"v{v}_{q}"][n] += 1
    return {qid: c.most_common(1)[0][0] for qid, c in votes.items()}

def cmd_run(a):
    existing = supa.get(f"report_runs?run_id=eq.{a.run}&select=run_id")
    if not existing:
        supa.post("report_runs", [dict(run_id=a.run, title=a.title, nota_base=a.base, published=False)])
    else:
        supa.patch(f"report_runs?run_id=eq.{a.run}", dict(title=a.title, nota_base=a.base))
    qids = [q["question_id"] for q in supa.get(f"correction_questions?run_id=eq.{a.run}&select=question_id")]
    order = booklet_order(a.run)
    gpath = os.path.join(DADOS, "relatorios", "gabaritos", f"{a.run}.json")
    gab = json.load(open(gpath, encoding="utf-8")) if os.path.exists(gpath) else {}
    gab = {k: v for k, v in gab.items() if not k.startswith("_")}   # "_note" etc. are comments
    rows = []
    for qid in qids:
        t = qid.split("_", 1)[1]
        rows.append(dict(run_id=a.run, question_id=qid, numero=order.get(qid, 0),
                         titulo=TYPE_TITLE.get(t, t), gabarito_html=gab.get(qid) or None))
    upsert("report_questions", rows, "run_id,question_id")
    # assets referenced by the gabaritos (looked up next to the gabarito file)
    for path in sorted({m for g in gab.values() if isinstance(g, str) for m in re.findall(r"\{\{asset:([^}]+)\}\}", g)}):
        local = os.path.join(DADOS, "relatorios", "gabaritos", "assets", os.path.basename(path))
        supa.upload(local, path, "image/svg+xml" if path.endswith(".svg") else "image/png")
        print("asset uploaded:", path)
    print(f"report_runs: {a.run} ({'existing, published flag untouched' if existing else 'created, NOT published'})")
    print("report_questions:", sorted((r["question_id"], r["numero"], bool(r["gabarito_html"])) for r in rows))

def cmd_link(a):
    by_name = {r["nome"]: MATRICULA_FIX.get(r["matricula"], r["matricula"])
               for r in csv.DictReader(open(os.path.join(DADOS, "attendence_list", "notas_prova1.csv"), encoding="utf-8"))}
    items = supa.get(f"correction_items?run_id=eq.{a.run}&select=student_key,student_name&limit=5000")
    keys = {}
    for it in items:
        keys.setdefault(it["student_name"], set()).add(it["student_key"])
    rows, problems = [], []
    for name, ks in keys.items():
        if len(ks) != 1 or name not in by_name:
            problems.append((name, sorted(ks)))
            continue
        rows.append(dict(run_id=a.run, matricula=by_name[name], student_key=next(iter(ks))))
    if problems:
        raise SystemExit(f"not linked (fix first): {problems}")
    if len({r['matricula'] for r in rows}) != len(rows):
        raise SystemExit("two booklets map to the same matrícula — aborting")
    upsert("report_students", rows, "run_id,matricula")
    no_code = {r["matricula"] for r in rows} - {r["matricula"] for r in csv.DictReader(open(ACCESS_CSV, encoding="utf-8"))}
    print(f"report_students: {len(rows)} booklets linked; without an access code: {sorted(no_code) or 'none'}")

def cmd_test(a):
    tests = [("0000000001", "TESTE MEDIA", "henrique-ventura-vieira-prado"),
             ("0000000002", "TESTE NOTA BAIXA", "gabriel-alves-silva")]
    out = []
    for mat, nome, key in tests:
        code = "".join(secrets.choice(ALPH) for _ in range(10)); code = code[:5] + "-" + code[5:]
        upsert("student_access", [access_row(mat, nome, code, preview=True)], "matricula")
        upsert("report_students", [dict(run_id=a.run, matricula=mat, student_key=key)], "run_id,matricula")
        out.append(dict(matricula=mat, nome=nome, booklet=key, codigo=code))
    os.makedirs(os.path.dirname(TEST_CSV), exist_ok=True)
    with open(TEST_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0])); w.writeheader(); w.writerows(out)
    os.chmod(TEST_CSV, 0o600)
    for o in out:
        print(f"test account {o['matricula']} -> {o['booklet']}  code {o['codigo']}")

def cmd_publish(a):
    supa.patch(f"report_runs?run_id=eq.{a.run}", dict(published=not a.off))
    print(f"{a.run}: published = {not a.off}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("access")
    for name in ("run", "link", "test", "publish"):
        s = sub.add_parser(name)
        s.add_argument("--run", default="dcc638-prova1")
        if name == "run":
            s.add_argument("--title", default="Prova 1")
            s.add_argument("--base", type=float, default=25)
        if name == "publish":
            s.add_argument("--off", action="store_true")
    a = ap.parse_args()
    {"access": cmd_access, "run": cmd_run, "link": cmd_link, "test": cmd_test, "publish": cmd_publish}[a.cmd](a)
