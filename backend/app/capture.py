"""Prompt capture: THIMBLE_PROMPT_CAPTURE=<dir> writes each model call the server sends as text of its own (the check
for a view proposal, a fork of main's conversation), as it is sent, to one file, so its prompt can be reviewed with its
templates filled. The card check's `thimble:call` subagent of main is in main's transcript folder instead.

Off by default. Set, each call becomes `<dir>/<utc stamp>-<seq>-<caller>.md` with a header (caller, model, effort and
path), then its sections (## Prompt, ## Answer, ## Status). Callers name themselves with `scope(name)` (a contextvar).
Writes are small synchronous appends; the switch is a debugging aid, not for a served deployment.
"""
from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

log = logging.getLogger("thimble.capture")

ENV = "THIMBLE_PROMPT_CAPTURE"

_seq = 0
_seq_lock = threading.Lock()
_caller: contextvars.ContextVar[str | None] = contextvars.ContextVar("thimble_capture_caller", default=None)
# the prompt files loaded in this context since the last capture began: ((name, (file, include, ...)), ...) — a tuple, so
# a child task's copy never shares a list with its parent (prompts.load records; begin() takes and clears)
_prompt_files: contextvars.ContextVar[tuple] = contextvars.ContextVar("thimble_capture_prompt_files", default=())
_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")


def directory() -> Path | None:
    """The capture directory, or None when the switch is off (THIMBLE_PROMPT_CAPTURE unset or blank; read per call)."""
    raw = os.environ.get(ENV, "").strip()
    return Path(raw).expanduser() if raw else None


def enabled() -> bool:
    return directory() is not None


# --------------------------------------------------------------------------- who is calling


@contextmanager
def scope(name: str | None, *, keep: bool = False) -> Iterator[None]:
    """Name the calls made inside the block (`caller()` reads it). `keep=True` leaves an outer scope in place — a
    module that is sometimes called from a named task and sometimes on its own names itself only when nobody did."""
    if keep and _caller.get() is not None:
        yield
        return
    token = _caller.set(name)
    try:
        yield
    finally:
        _caller.reset(token)


def reset() -> None:
    """Clear the scope — and the prompt files noted — for the current context (jobs.py, at the start of each job: a job
    task is created inside the enqueuing code's context and would otherwise carry both)."""
    _caller.set(None)
    _prompt_files.set(())


def prompt_used(name: str, files: list[str] | tuple[str, ...]) -> None:
    """prompts.load's note that `name` (a prompt file, relative to prompts/) was read in this context, with every file
    it includes (prompts.files): the next capture that begins here lists them as the files that composed the call. Nothing
    is kept when the switch is off."""
    if not enabled():
        return
    entry = (str(name), tuple(str(f) for f in files))
    cur = _prompt_files.get()
    if entry not in cur:
        _prompt_files.set((*cur, entry))


def take_prompt_files() -> tuple:
    """The prompt files noted in this context, cleared."""
    cur = _prompt_files.get()
    _prompt_files.set(())
    return cur


def prompt_files_line(entries: tuple) -> str:
    """One header line's worth: `main.md (includes shared.md); labels.md`."""
    parts = []
    for name, files in entries:
        inc = [f for f in files if f != name and f != f"{name}.md"]
        parts.append(f"{name}" + (f" (includes {', '.join(inc)})" if inc else ""))
    return "; ".join(parts)


def current() -> str | None:
    return _caller.get()


# --------------------------------------------------------------------------- rendering helpers


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%f")[:-3] + "Z"


def _slug(name: str) -> str:
    s = _SLUG_RE.sub("-", name.strip()).strip("-").lower()
    return (s or "call")[:60]


def _jsonable(v: Any) -> Any:
    """`v` as something json.dumps takes: dataclasses, pydantic models, paths, sets and unknown objects reduced."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set, frozenset)):
        return [_jsonable(x) for x in v]
    if isinstance(v, Path):
        return str(v)
    if hasattr(v, "model_dump"):
        try:
            return _jsonable(v.model_dump(exclude_none=True, by_alias=True))
        except Exception:  # noqa: BLE001
            pass
    if hasattr(v, "__dataclass_fields__"):
        return {k: _jsonable(getattr(v, k)) for k in v.__dataclass_fields__}
    return repr(v)


def _json(v: Any) -> str:
    return json.dumps(_jsonable(v), ensure_ascii=False, indent=2, sort_keys=False)


def fence(body: str, lang: str = "") -> str:
    """A fenced block that survives fences inside the body (the fence grows past the longest run of backticks)."""
    longest = max((len(m.group(0)) for m in re.finditer(r"`+", body)), default=0)
    ticks = "`" * max(3, longest + 1)
    return f"{ticks}{lang}\n{body}\n{ticks}"


# --------------------------------------------------------------------------- one call's file


class Call:
    """One capture file, appended to as the call proceeds. `on` is False for the no-op instance every entry point
    returns when the switch is off: every method returns at once, so callers never branch."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.on = path is not None
        self.t0 = time.monotonic()

    def _append(self, text: str) -> None:
        if not self.on or self.path is None:
            return
        try:
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(text)
        except OSError as e:
            log.warning("capture: could not append to %s: %s", self.path, e)
            self.on = False

    def section(self, title: str, body: str = "") -> None:
        self._append(f"\n## {title}\n\n{body.rstrip()}\n" if body else f"\n## {title}\n")

    def sub(self, title: str, body: str = "") -> None:
        self._append(f"\n### {title}\n\n{body.rstrip()}\n" if body else f"\n### {title}\n")

    def fenced(self, title: str, obj: Any, lang: str = "json", *, sub: bool = False) -> None:
        body = obj if isinstance(obj, str) else _json(obj)
        (self.sub if sub else self.section)(title, fence(body, lang))

    def text(self, title: str, body: str, *, sub: bool = False) -> None:
        """Free text (a prompt, a message, an answer) in a `text` fence: verbatim, and a `##` line inside it can never
        read as one of this file's own headings (the page's parser is fence-aware)."""
        (self.sub if sub else self.section)(title, fence(body, "text"))

    def note(self, text: str) -> None:
        self._append(f"\n_{text}_\n")

    def finish(self, status: str, detail: str = "", **extra: Any) -> None:
        if not self.on:
            return
        fields = {"status": status, "detail": detail, "duration_s": round(time.monotonic() - self.t0, 2), **extra}
        body = "\n".join(f"- {k}: {v}" for k, v in fields.items() if v not in (None, ""))
        self.section("Status", body)


NULL = Call(None)


def begin(name: str, *, model: str | None = None, effort: str | None = None, path: str = "", note: str = "",
          **fields: Any) -> Call:
    """Open a call's file (NULL when the switch is off): the header names the caller, model, effort and path,
    and says what is exact about the file. `fields` are more header lines (workspace, chat id, …)."""
    d = directory()
    if d is None:
        return NULL
    global _seq
    with _seq_lock:
        _seq += 1
        seq = _seq
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log.warning("capture: cannot create %s: %s", d, e)
        return NULL
    p = d / f"{_stamp()}-{seq:04d}-{_slug(name)}.md"
    cap = Call(p)
    paths = {
        "message": "message — text the server hands a terminal Claude Code session (browser event, inbox or the next prompt's status block); exact.",
        "note": "note — rendered outside a live call.",
    }
    head = [f"# {name}", "", f"- caller: {name}", f"- when: {datetime.now(timezone.utc).isoformat(timespec='seconds')}"]
    if model:
        head.append(f"- model: {model}")
    if effort:
        head.append(f"- effort: {effort}")
    for k, v in fields.items():
        if v not in (None, ""):
            head.append(f"- {k}: {v}")
    used = take_prompt_files()
    if used:
        head.append(f"- prompt_files: {prompt_files_line(used)}")
    if path:
        head.append(f"- path: {paths.get(path, path)}")
    if note:
        head.append(f"- note: {note}")
    cap._append("\n".join(head) + "\n")
    log.info("capture: %s -> %s", name, p.name)
    return cap
