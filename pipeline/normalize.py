"""Canonical form of an answer, used to group identical answers together.

Grouping is deliberately conservative: it only ever merges answers that are
the SAME STRING once notation is normalised. It does not decide that two
different formulas are equivalent — that is the reviewer's job. A false merge
would silently propagate a wrong grade; a missed merge just costs a keystroke.
"""
import hashlib
import re
import unicodedata

# The same operator written six ways by six students (and by the transcriber).
SYNONYMS = [
    (r"\\lnot|\\neg|¬|~", "NOT"),
    (r"\\land|\\wedge|∧|&", "AND"),
    (r"\\lor|\\vee|∨", "OR"),
    (r"\\rightarrow|\\to|\\supset|→|⇒|->", "IMP"),
    (r"\\leftrightarrow|\\iff|↔|⇔|<->", "IFF"),
    (r"\\equiv|≡|==", "EQV"),
    (r"\\forall|∀", "ALL"),
    (r"\\exists|∃", "EX"),
    (r"\\neq|≠", "NEQ"),
    (r"\\geq|≥|>=", "GEQ"),
    (r"\\leq|≤|<=", "LEQ"),
    (r"\\top|\\mathrm\{V\}|\bV\b|\bT\b", "TRUE"),
    (r"\\bot|\\mathrm\{F\}|\bF\b", "FALSE"),
]


def canonical(text):
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", text)
    s = s.replace("$", " ")
    for pattern, token in SYNONYMS:
        s = re.sub(pattern, f" {token} ", s)
    s = re.sub(r"\\[a-zA-Z]+", " ", s)          # leftover LaTeX commands
    s = re.sub(r"\\[,;:!]", " ", s)             # LaTeX spacing
    s = s.lower()
    s = re.sub(r"[^a-z0-9()]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def cluster_key(text):
    """None for empty answers: blanks should not all collapse into one group
    whose grade then propagates."""
    c = canonical(text)
    if len(c) < 3:
        return None
    return hashlib.sha1(c.encode()).hexdigest()[:16]


def slugify(name):
    """Reproduces the slug used by export.py in the photo filenames, so a
    folder of images can be matched back to the roster."""
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9]", "-", s)
    return re.sub(r"-+", "-", s).strip("-")
