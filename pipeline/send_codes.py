#!/usr/bin/env python3
"""E-mail each student their personal "Minhas correções" access code.

Reads the PRIVATE mapping dados/relatorios/acesso/codigos_relatorio.csv and sends
one plain-text e-mail per student through Gmail (SMTP + App Password from .env:
GMAIL_USER, GMAIL_APP_PASSWORD). Codes are never printed.

    send_codes.py --dry-run            write every e-mail to dados/relatorios/emails/ (sends nothing)
    send_codes.py --test-to ADDRESS    send ONE e-mail to ADDRESS, built from the staff test
                                       account 0000000001 (a working test code, no student's)
    send_codes.py --send               send to everyone not yet in the log (resumable)
    send_codes.py --send --only M1 M2  (re)send to these matrículas only

Every real send is appended to dados/relatorios/acesso/envios.csv; a matrícula already
logged as "ok" is skipped, so an interrupted run can simply be started again.
"""
import argparse, csv, os, smtplib, ssl, sys, time
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
import supa  # loads .env

HERE = os.path.dirname(os.path.abspath(__file__))
DADOS = os.path.join(os.path.dirname(HERE), "dados", "relatorios")
CODES = os.path.join(DADOS, "acesso", "codigos_relatorio.csv")
TESTS = os.path.join(DADOS, "acesso", "teste.csv")
LOG = os.path.join(DADOS, "acesso", "envios.csv")
OUTDIR = os.path.join(DADOS, "emails")
PAUSE = 4  # seconds between e-mails (~150 e-mails ≈ 10 minutes; well under Gmail's limits)

SUBJECT = "ILC 2026/2 — seu código de acesso às correções"
BODY = """Olá, {primeiro},

A correção da Prova 1 está disponível na página das atividades práticas:
https://ufmg-smite.github.io/2026.1-ilc-atividades/

Clique em "Minhas correções (provas)" e informe:

Matrícula: {matricula}
Código de acesso: {codigo}

O código é pessoal, não o compartilhe. Ele também vai servir para as próximas correções.

Abraço,
David Perera
DCC 638 — Introdução à Lógica Computacional
"""

# the official roster has no accents; restore them on the first names that need one
ACCENTS = {"Andre": "André", "Antonio": "Antônio", "Italo": "Ítalo", "Joao": "João", "Jose": "José",
           "Julia": "Júlia", "Leticia": "Letícia", "Vitoria": "Vitória"}

def first_name(nome):
    w = nome.strip().split()
    f = w[0].capitalize() if w else ""
    return ACCENTS.get(f, f)

def build(sender, to, nome, matricula, codigo):
    m = EmailMessage()
    m["From"] = formataddr(("David Perera", sender))
    m["To"] = to
    m["Subject"] = SUBJECT
    m["Message-ID"] = make_msgid(domain=sender.split("@")[-1])
    m.set_content(BODY.format(primeiro=first_name(nome), matricula=matricula, codigo=codigo))
    return m

def logged_ok():
    if not os.path.exists(LOG):
        return set()
    return {r["matricula"] for r in csv.DictReader(open(LOG, encoding="utf-8")) if r["status"] == "ok"}

def log(row):
    new = not os.path.exists(LOG)
    with open(LOG, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["quando", "matricula", "nome", "email", "status"])
        if new:
            w.writeheader()
        w.writerow(row)
    os.chmod(LOG, 0o600)

def smtp():
    user, pw = os.environ.get("GMAIL_USER", ""), os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
    if not user or not pw:
        sys.exit("GMAIL_USER / GMAIL_APP_PASSWORD missing in .env")
    s = smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=60)
    s.login(user, pw)
    return user, s

def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--test-to")
    g.add_argument("--send", action="store_true")
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    rows = list(csv.DictReader(open(CODES, encoding="utf-8")))

    if a.dry_run:
        sender = os.environ.get("GMAIL_USER", "remetente@gmail.com")
        os.makedirs(OUTDIR, exist_ok=True); os.chmod(OUTDIR, 0o700)
        for r in rows:
            m = build(sender, r["email"], r["nome"], r["matricula"], r["codigo_relatorio"])
            with open(os.path.join(OUTDIR, f"{r['matricula']}.eml"), "wb") as f:
                f.write(bytes(m))
        no_email = [r["nome"] for r in rows if not r["email"].strip()]
        print(f"dry run: {len(rows)} e-mails written to {OUTDIR} (nothing sent); without address: {no_email or 'none'}")
        return

    if a.test_to:
        t = next(r for r in csv.DictReader(open(TESTS, encoding="utf-8")) if r["matricula"] == "0000000001")
        user, s = smtp()
        s.send_message(build(user, a.test_to, "David", t["matricula"], t["codigo"]))
        s.quit()
        print(f"test e-mail sent to {a.test_to} (test account 0000000001)")
        return

    # --send
    done = logged_ok()
    todo = [r for r in rows if r["email"].strip() and r["matricula"] not in done
            and (not a.only or r["matricula"] in a.only)]
    print(f"{len(todo)} to send ({len(done)} already sent)")
    user, s = smtp()
    for i, r in enumerate(todo, 1):
        for attempt in (1, 2):
            try:
                s.send_message(build(user, r["email"], r["nome"], r["matricula"], r["codigo_relatorio"]))
                status = "ok"
                break
            except (smtplib.SMTPServerDisconnected, smtplib.SMTPSenderRefused, OSError) as e:
                status = f"erro: {type(e).__name__}"
                try:
                    user, s = smtp()       # reconnect once
                except Exception:
                    pass
            except smtplib.SMTPRecipientsRefused:
                status = "erro: destinatário recusado"
                break
        log(dict(quando=datetime.now().isoformat(timespec="seconds"), matricula=r["matricula"],
                 nome=r["nome"], email=r["email"], status=status))
        print(f"[{i}/{len(todo)}] {r['nome']}: {status}", flush=True)
        time.sleep(PAUSE)
    try:
        s.quit()
    except Exception:
        pass

if __name__ == "__main__":
    main()
