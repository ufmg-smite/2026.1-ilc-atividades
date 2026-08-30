"""Supabase access for the local pipeline (service_role, same as export.py).

Credentials come from the environment or a .env next to this file:
    SUPABASE_URL="https://YOUR-PROJECT-REF.supabase.co"
    SUPABASE_SERVICE_ROLE_KEY="eyJ...service_role key..."

This key bypasses RLS — keep it on your machine, never in the repo.
"""
import json
import os
import urllib.parse

import requests

BUCKET = "answers"


def load_dotenv(path):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


def _check():
    if not URL or not KEY:
        raise SystemExit(
            "Faltam credenciais. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY\n"
            "no ambiente ou em pipeline/.env (veja pipeline/README.md)."
        )


def _headers(extra=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    h.update(extra or {})
    return h


def get(path):
    _check()
    r = requests.get(f"{URL}/rest/v1/{path}", headers=_headers(), timeout=60)
    r.raise_for_status()
    return r.json()


def post(path, body, prefer="return=minimal"):
    _check()
    r = requests.post(
        f"{URL}/rest/v1/{path}", headers=_headers({"Prefer": prefer}),
        data=json.dumps(body), timeout=120,
    )
    if not r.ok:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:300]}")
    return r.json() if prefer.startswith("return=representation") else None


def patch(path, body):
    _check()
    r = requests.patch(
        f"{URL}/rest/v1/{path}", headers=_headers({"Prefer": "return=minimal"}),
        data=json.dumps(body), timeout=60,
    )
    if not r.ok:
        raise RuntimeError(f"PATCH {path} -> {r.status_code}: {r.text[:300]}")


def upload(local_path, object_path, content_type="image/png"):
    """Put one file into the private bucket, overwriting if it is already there."""
    _check()
    with open(local_path, "rb") as f:
        data = f.read()
    r = requests.post(
        f"{URL}/storage/v1/object/{BUCKET}/{urllib.parse.quote(object_path)}",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}",
                 "Content-Type": content_type, "x-upsert": "true"},
        data=data, timeout=180,
    )
    if not r.ok:
        raise RuntimeError(f"upload {object_path} -> {r.status_code}: {r.text[:200]}")
    return object_path


def download(object_path, dest):
    _check()
    r = requests.get(
        f"{URL}/storage/v1/object/{BUCKET}/{urllib.parse.quote(object_path)}",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"}, timeout=180,
    )
    r.raise_for_status()
    with open(dest, "wb") as f:
        f.write(r.content)
    return dest


# ---------------------------------------------------------------- domain helpers
q = urllib.parse.quote


def rubric(run_id):
    """{question_id: {question fields..., 'criteria': [...]}} for the whole run."""
    qs = get(f"correction_questions?run_id=eq.{q(run_id)}&select=*&order=position")
    cs = get(f"correction_criteria?run_id=eq.{q(run_id)}&active=eq.true&select=*&order=question_id,position")
    out = {}
    for row in qs:
        out[row["question_id"]] = dict(row, criteria=[])
    for c in cs:
        out.setdefault(c["question_id"], {"question_id": c["question_id"], "criteria": []})
        out[c["question_id"]]["criteria"].append(c)
    return out


def ensure_run(run_id, title):
    post("correction_runs?on_conflict=id",
         [{"id": run_id, "title": title}],
         prefer="resolution=merge-duplicates,return=minimal")


def ensure_questions(run_id, questions):
    """questions: [{question_id, prompt, position}] — never clobbers a barème."""
    if not questions:
        return
    post("correction_questions?on_conflict=run_id,question_id",
         [dict(q_, run_id=run_id) for q_ in questions],
         prefer="resolution=ignore-duplicates,return=minimal")
