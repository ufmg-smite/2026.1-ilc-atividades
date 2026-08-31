"""Talk to a local model server.

Default transport is ollama's NATIVE /api/chat, not the OpenAI-compatible
/v1/chat/completions, for one measured reason: only the native endpoint exposes
`think`. On this hardware that switch is the difference between 0.4 s and 23 s
per grading call — a thinking model spends thousands of tokens reasoning before
it answers, and on a 471-answer batch that is the difference between one night
and three. The OpenAI path is kept for llama-server users
(PIPELINE_API_STYLE=openai), which has no thinking to disable anyway.

The two passes run SEQUENTIALLY on purpose: with 6.9 GiB of usable VRAM you
cannot hold a vision model and a reasoning model at once, and you do not need
to. Transcribe everything, unload, then grade everything.
"""
import base64
import json
import os
import time

import requests

API_BASE = os.environ.get("PIPELINE_API_BASE", "http://localhost:11434").rstrip("/")
API_STYLE = os.environ.get("PIPELINE_API_STYLE", "ollama")   # "ollama" | "openai"
NUM_CTX = int(os.environ.get("PIPELINE_NUM_CTX", "8192"))
TIMEOUT = int(os.environ.get("PIPELINE_TIMEOUT", "600"))

_MIME = {".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg",
         ".jpeg": "image/jpeg", ".gif": "image/gif"}


def _b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def _data_url(path):
    mime = _MIME.get(os.path.splitext(path)[1].lower(), "image/png")
    return f"data:{mime};base64," + _b64(path)


# Metadata of the most recent call. The pipeline is strictly sequential, so a
# module-level slot is enough and keeps chat()'s signature clean.
_META = {"done_reason": None, "eval_count": None}


def last_call_truncated():
    """True when the last call stopped at the token cap instead of finishing —
    the tell for a model stuck in a repetition loop."""
    return _META.get("done_reason") == "length"


class Truncated(RuntimeError):
    """The model hit the context limit before finishing.

    Raised loudly because the failure is otherwise silent: ollama returns HTTP
    200 with an EMPTY content string, which looks exactly like a blank answer
    from a student.
    """


def _ollama(model, messages, images, json_mode, temperature, think, num_predict):
    msgs = [dict(m) for m in messages]
    if images:
        msgs[-1]["images"] = [_b64(p) for p in images]
    body = {
        "model": model, "messages": msgs, "stream": False, "think": think,
        "options": {"temperature": temperature, "num_ctx": NUM_CTX,
                    "num_predict": num_predict},
    }
    if json_mode:
        body["format"] = "json"
    r = requests.post(f"{API_BASE}/api/chat", json=body, timeout=TIMEOUT)
    r.raise_for_status()
    d = r.json()
    content = (d.get("message") or {}).get("content") or ""
    _META["done_reason"] = d.get("done_reason")
    _META["eval_count"] = d.get("eval_count")
    if d.get("done_reason") == "length" and not content.strip():
        raise Truncated(
            f"{model} estourou o limite de geração ({d.get('eval_count')} tokens) sem "
            "responder. Num modelo de visão, use a variante -instruct (a 'thinking' "
            "gasta o orçamento raciocinando). Num modelo de texto com raciocínio "
            "ligado, aumente num_predict, ou PIPELINE_NUM_CTX se o prompt for longo."
        )
    return content


def _openai(model, messages, images, json_mode, temperature):
    _META["done_reason"] = None
    msgs = [dict(m) for m in messages]
    if images:
        last = msgs[-1]
        content = [{"type": "text", "text": last["content"]}]
        for p in images:
            content.append({"type": "image_url", "image_url": {"url": _data_url(p)}})
        last["content"] = content
    body = {"model": model, "messages": msgs, "temperature": temperature, "stream": False}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    r = requests.post(f"{API_BASE}/v1/chat/completions", json=body, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def chat(model, messages, images=None, json_mode=True, retries=3,
         temperature=0.1, think=False, num_predict=1024):
    """One chat completion. `images` attaches file paths to the last user turn."""
    last_err = None
    for attempt in range(retries):
        try:
            if API_STYLE == "ollama":
                return _ollama(model, messages, images, json_mode, temperature,
                               think, num_predict)
            return _openai(model, messages, images, json_mode, temperature)
        except Truncated:
            raise                                   # retrying changes nothing
        except Exception as e:                      # noqa: BLE001 - retry the rest
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"LLM falhou após {retries} tentativas: {last_err}")


def chat_json(model, messages, images=None, **kw):
    """Same, but parse the JSON out — tolerating a model that wraps it in prose
    or a ```json fence, which small models do often enough to matter."""
    raw = chat(model, messages, images=images, **kw)
    if not raw.strip():
        raise ValueError("modelo devolveu resposta vazia")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError(f"resposta não-JSON do modelo: {raw[:300]}")
