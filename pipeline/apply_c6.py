#!/usr/bin/env python3
"""Add criterion c6 ("Justificativa clara", 2 pts) to a quiz's correction run.

The teacher's change (2026-10-21): every question gets c6 = "Deixou claro o que está
demonstrando e justificou cada passo"; c1–c5 are rescaled to 8 points (barema.json
already holds the new points; barema_v1.json the old ones). c1–c5 verdicts are NOT
re-evaluated.

  1. correction_criteria: new points for c1–c5, c6 added.
  2. undecided items: a new proposal = latest proposal's c1–c5 + c6 from c6.json.
  3. items the teacher already graded: a new override recording the same decision
     with c6 added — false if the teacher had removed points by manual adjustment
     (the teacher's rule), true otherwise — and the score recomputed on the new
     barème. Same grader, note "[barema atualizado: c6]". Append-only: the
     original decision stays in the history.

    /home/dap/miniconda3/bin/python3 apply_c6.py --quiz ilc-atividade11
"""
import argparse, json, os
import supa

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def chunks(xs, n=150):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiz", required=True)
    a = ap.parse_args()
    run = a.quiz
    D = os.path.join(ROOT, "dados", "relatorios", "quizzes", run)
    new = json.load(open(f"{D}/barema.json", encoding="utf-8"))
    old = json.load(open(f"{D}/barema_v1.json", encoding="utf-8"))
    c6 = json.load(open(f"{D}/c6.json", encoding="utf-8")) if os.path.exists(f"{D}/c6.json") else {}
    items = json.load(open(f"{D}/items.json", encoding="utf-8"))
    n_of = {(it["qid"], it["key"]): str(it["n"]) for it in items}
    newpts = {q: {c["id"]: c["points"] for c in cs} for q, cs in new.items()}
    oldpts = {q: {c["id"]: c["points"] for c in cs} for q, cs in old.items()}

    # 1. criteria
    supa.post("correction_criteria?on_conflict=run_id,question_id,key",
              [dict(run_id=run, question_id=q, key=c["id"], label=c["label"], detail=c["detail"],
                    points=c["points"], position=k, active=True) for q, cs in new.items() for k, c in enumerate(cs)],
              prefer="resolution=merge-duplicates,return=minimal")

    db_items = supa.get(f"correction_items?run_id=eq.{run}&select=id,question_id,student_key&limit=5000")
    ids = [i["id"] for i in db_items]
    props, decs = {}, {}
    for ch in chunks(ids):
        lst = ",".join(map(str, ch))
        for p in supa.get(f"correction_proposals?item_id=in.({lst})&select=item_id,criteria,justification,created_at&order=created_at&limit=5000"):
            props[p["item_id"]] = p
        for e in supa.get(f"correction_events?item_id=in.({lst})&kind=in.(accept,override,reopen)"
                          f"&select=item_id,kind,score,criteria,justification,actor_email,actor_role,created_at&order=created_at&limit=5000"):
            if e["kind"] == "reopen":
                decs.pop(e["item_id"], None)
            else:
                decs[e["item_id"]] = e

    new_props, new_events, missing = [], [], 0
    for it in db_items:
        q, iid = it["question_id"], it["id"]
        if iid in decs:                                   # 3. teacher's decision
            e = decs[iid]
            crit = {k: dict(v) for k, v in (e["criteria"] or {}).items()}
            if "c6" in crit:
                continue                                  # already converted
            old_sum = sum(oldpts[q].get(k, 0) for k, v in crit.items() if v.get("met"))
            crit["c6"] = {"met": not (float(e["score"]) < old_sum - 1e-9)}
            score = sum(newpts[q][k] for k, v in crit.items() if v.get("met") and k in newpts[q])
            new_events.append(dict(item_id=iid, kind="override", score=score, criteria=crit,
                                   rubric=newpts[q], justification=((e.get("justification") or "") +
                                   " [barema atualizado: c6]").strip(),
                                   actor_email=e["actor_email"], actor_role=e.get("actor_role") or ""))
            continue
        p = props.get(iid)                                 # 2. undecided: new proposal
        if p is None or "c6" in (p["criteria"] or {}):
            continue
        v = c6.get(n_of.get((q, it["student_key"]), ""))
        if v is None:
            missing += 1
            continue
        crit = dict(p["criteria"]); crit["c6"] = {"met": bool(v["c6"]), "note": ""}
        note = (p.get("justification") or "").strip()
        if not v["c6"] and v.get("nota"):
            note = (note + " · c6: " + v["nota"]).strip(" ·")
        new_props.append(dict(item_id=iid, model="claude", criteria=crit, justification=note))

    for ch in chunks(new_props, 200):
        supa.post("correction_proposals", ch)
    for ch in chunks(new_events, 200):
        supa.post("correction_events", ch)
    print(f"{run}: criteria updated; {len(new_props)} proposals with c6; "
          f"{len(new_events)} teacher decisions converted; without c6 verdict: {missing}")

if __name__ == "__main__":
    main()
