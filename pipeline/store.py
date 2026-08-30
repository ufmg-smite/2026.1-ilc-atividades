"""Local work database.

The batch runs overnight over ~1000 images; it must survive a crash, a reboot,
or a model swap without redoing finished work. Every pass writes its result
here and skips rows it has already done, so re-running any command is safe.
"""
import json
import sqlite3

SCHEMA = """
create table if not exists items (
  id            integer primary key autoincrement,
  run_id        text not null,
  question_id   text not null,
  student_key   text not null,
  student_name  text not null default '',
  student_email text not null default '',
  images        text not null default '[]',   -- source paths on this machine
  prepared      text not null default '[]',   -- preprocessed paths
  typed_answer  text not null default '',
  transcription text,
  legible       integer,
  cluster_key   text,
  criteria      text,                          -- json verdicts from the grading pass
  justification text,
  model_transc  text,
  model_grade   text,
  pushed        integer not null default 0,
  unique (run_id, question_id, student_key)
);
"""


class Store:
    def __init__(self, path="work.db"):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.db.commit()

    def upsert_item(self, **kw):
        kw.setdefault("images", "[]")
        cols = ", ".join(kw)
        marks = ", ".join("?" for _ in kw)
        self.db.execute(
            f"insert or ignore into items ({cols}) values ({marks})", list(kw.values())
        )
        self.db.commit()

    def pending(self, run_id, column, question_id=None):
        q = f"select * from items where run_id=? and {column} is null"
        args = [run_id]
        if question_id:
            q += " and question_id=?"
            args.append(question_id)
        return self.db.execute(q + " order by question_id, student_name", args).fetchall()

    def all(self, run_id, question_id=None):
        q = "select * from items where run_id=?"
        args = [run_id]
        if question_id:
            q += " and question_id=?"
            args.append(question_id)
        return self.db.execute(q + " order by question_id, student_name", args).fetchall()

    def update(self, item_id, **kw):
        sets = ", ".join(f"{k}=?" for k in kw)
        self.db.execute(f"update items set {sets} where id=?", [*kw.values(), item_id])
        self.db.commit()

    def counts(self, run_id):
        rows = self.db.execute(
            """select question_id,
                      count(*) total,
                      sum(transcription is not null) transcribed,
                      sum(criteria is not null) graded,
                      sum(pushed) pushed
               from items where run_id=? group by question_id order by question_id""",
            [run_id],
        ).fetchall()
        return [dict(r) for r in rows]


def jload(s, default=None):
    try:
        return json.loads(s) if s else (default if default is not None else [])
    except (TypeError, json.JSONDecodeError):
        return default if default is not None else []
