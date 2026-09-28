"""The swarm map (prompts/swarm.md): one JSON file of a multi-agent corpus's agents, threads, significant actions and
the typed links between actions, written by a Claude Code session of its own and checked against the corpus.

    python -m app.swarm run CORPUS OUT [--work DIR] [--request TEXT] [--model M] [--fallback-model M] [--rounds N]
    python3 backend/app/swarm.py check CORPUS OUT
    python3 backend/app/swarm.py detect CORPUS

`detect` says whether a corpus shows the structure the map is for (detect()), exiting 1 when it does not.

`check` needs only the standard library, so the session runs it as a script. It prints each error, then each warning,
one per line, and exits 1 when there is an error. It confirms that
  - the file has the shape prompts/swarm.md shows, with LINK_TYPES as the link types;
  - each ref is `<path>#L<n>` inside CORPUS and names an existing line, and each quote is in that line, compared with
    whitespace collapsed against the raw line and against its decoded string values;
  - each action's record holds its agent's username and its thread's id (or each `/` part of the id) as whole values
    (whole words in a line that is not JSON), a datetime at the same instant as the action's time, and a quote absent
    from its `before` record;
  - every action's agent and thread are listed, and every listed agent and thread has an action;
  - action ids are 1..n, their known times never decrease, and a link runs from a later action to an earlier one;
  - each name in an agent's `signs_as` is in a record its actions or evidence cite.
A count of agents, threads or actions outside SCALE is a warning.

`run` renders prompts/swarm.md and runs `claude -p` with it appended to the system prompt, in the work folder, with the
corpus added and Bash sandboxed (settings()). The session writes the map in the work folder, under OUT's name, and it
is copied to OUT when the run ends. When the session ends the check runs, and a failing file is sent back
with `--resume` and tools.md's `## swarm-check-failed`, up to `rounds` times. A session that stops because the API is
at capacity is resumed with `## session-retry` after capacity_waits(); one whose response a safety classifier stopped
(`stop_reason: refusal`) is resumed once on the fallback model with `## session-model-fallback`. Each session's stream
goes to `<work>/session-<k>.jsonl`, and a line per session to `<OUT stem>.runs.jsonl` beside OUT.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import sys
import time
import unicodedata
import uuid
from array import array
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LINK_TYPES = ("reply", "related", "support", "contradicts")
SCALE = {"agents": (10, 15), "threads": (3, 5), "actions": (10, 20)}
ACTION_CHARS = 80
REASON_CHARS = 160
GOAL_CHARS = 120
QUOTE_CHARS = (3, 300)
REF_RE = re.compile(r"^(?P<path>[^#]+)#L(?P<line>[1-9]\d*)$")
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
_WS_RE = re.compile(r"\s+")

MODEL = "claude-opus-5-5"
FALLBACK_MODEL = "claude-opus-4-8"
ROUNDS = 2
TOOLS = ("Bash", "Read", "Grep", "Glob", "Write", "Edit", "Agent", "Task")
DISALLOWED = ("WebFetch", "WebSearch")
CAPACITY_BASE_S = 30.0
CAPACITY_MAX_S = 300.0
CAPACITY_BUDGET_S = 3600.0
SESSION_TIMEOUT_S = 3 * 3600.0
_ENV_DROP = ("CLAUDECODE", "CLAUDE_CODE_", "ANTHROPIC_API_KEY", "THIMBLE_")


class _Lines:
    """Line access to the corpus's files by 1-based number, each file indexed by byte offset on first use."""

    def __init__(self, corpus: Path):
        self.corpus = corpus.resolve()
        self._index: dict[Path, array] = {}

    def path(self, rel: str) -> Path | None:
        p = (self.corpus / rel).resolve()
        if rel.startswith("/") or not p.is_relative_to(self.corpus) or not p.is_file():
            return None
        return p

    def line(self, p: Path, n: int) -> str | None:
        offsets = self._index.get(p)
        if offsets is None:
            offsets = array("q", [0])
            with p.open("rb") as f:
                for raw in f:
                    offsets.append(offsets[-1] + len(raw))
            self._index[p] = offsets
        if n < 1 or n >= len(offsets):
            return None
        with p.open("rb") as f:
            f.seek(offsets[n - 1])
            return f.read(offsets[n] - offsets[n - 1]).decode("utf-8", "replace").rstrip("\r\n")


def _norm(text: str) -> str:
    return _WS_RE.sub(" ", unicodedata.normalize("NFC", text)).strip()


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in _strings(v)]
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return [str(value)]
    return []


class _Record:
    """One cited line: its raw text, its decoded string values and the instants its datetime values name."""

    def __init__(self, raw: str):
        self.raw = raw
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        values = _strings(parsed) if parsed is not None else []
        self.json = parsed is not None
        self.values = {_norm(v) for v in values}
        self.text = _norm(raw + "\n" + "\n".join(values))
        self.instants = {t for t in (_instant(v) for v in values) if t is not None}

    def has(self, needle: str) -> bool:
        return _norm(needle) in self.text

    def names(self, name: str) -> bool:
        """Whether `name` occurs as a whole word, so `Bob` does not match `Bobby`."""
        return re.search(r"(?<![\w-])" + re.escape(_norm(name)) + r"(?![\w-])", self.text) is not None

    def is_value(self, name: str) -> bool:
        """Whether `name` is a whole value of the record, as an author or a page field holds it; for a line that is not
        JSON, whether it occurs as a whole word."""
        return _norm(name) in self.values if self.json else self.names(name)


def _instant(value: Any) -> datetime | None:
    if not isinstance(value, str) or not _ISO_RE.match(value.strip()):
        return None
    try:
        t = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).replace(microsecond=0)


class _Checker:
    def __init__(self, corpus: Path):
        self.lines = _Lines(corpus)
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self._records: dict[str, _Record | None] = {}

    def err(self, where: str, text: str) -> None:
        self.errors.append(f"{where}: {text}")

    def record(self, where: str, ref: Any) -> _Record | None:
        """The record a ref names, or None after an error saying why."""
        if not isinstance(ref, str) or not (m := REF_RE.match(ref.strip())):
            self.err(where, f"ref {ref!r} is not <path>#L<n>")
            return None
        ref = ref.strip()
        if ref not in self._records:
            p = self.lines.path(m["path"])
            raw = self.lines.line(p, int(m["line"])) if p else None
            self._records[ref] = _Record(raw) if raw is not None else None
            if p is None:
                self.err(where, f"ref {ref}: no file {m['path']!r} in the corpus")
            elif raw is None:
                self.err(where, f"ref {ref}: the file has no line {m['line']}")
        return self._records[ref]

    def quote(self, where: str, ref: Any, quote: Any) -> _Record | None:
        rec = self.record(where, ref)
        if not isinstance(quote, str) or not QUOTE_CHARS[0] <= len(_norm(quote)) <= QUOTE_CHARS[1]:
            self.err(where, f"quote must be text of {QUOTE_CHARS[0]} to {QUOTE_CHARS[1]} characters")
        elif rec is not None and not rec.has(quote):
            self.err(where, f"quote {_short(quote)!r} is not in {ref}")
        return rec

    def evidence(self, where: str, items: Any) -> list[_Record]:
        if not isinstance(items, list) or not items:
            self.err(where, "evidence must be a non-empty list of {ref, quote}")
            return []
        out = []
        for i, e in enumerate(items):
            if not isinstance(e, dict):
                self.err(f"{where} evidence[{i}]", "must be {ref, quote}")
                continue
            if (rec := self.quote(f"{where} evidence[{i}]", e.get("ref"), e.get("quote"))) is not None:
                out.append(rec)
        return out


def _short(text: str, n: int = 60) -> str:
    t = _norm(text)
    return t if len(t) <= n else t[: n - 1] + "…"


def _text(c: _Checker, where: str, value: Any, most: int) -> None:
    if not isinstance(value, str) or not value.strip():
        c.err(where, "must be non-empty text")
    elif len(value) > most:
        c.err(where, f"is {len(value)} characters, more than {most}")


def check(corpus: Path, doc: Any) -> tuple[list[str], list[str]]:
    """(errors, warnings) of a swarm map against the corpus folder it cites, as the module note lists them."""
    c = _Checker(corpus)
    if not isinstance(doc, dict):
        return ["the file must hold one JSON object"], []
    lists = {}
    for key in ("agents", "threads", "actions", "links"):
        v = doc.get(key)
        if not isinstance(v, list) or any(not isinstance(x, dict) for x in v):
            c.err(key, "must be a list of objects")
            v = []
        lists[key] = v
    _text(c, "title", doc.get("title"), 200)

    agents: dict[str, dict] = {}
    cited: dict[str, list[_Record]] = {}
    for i, a in enumerate(lists["agents"]):
        name = a.get("username")
        where = f"agents[{i}] {name!r}"
        if not isinstance(name, str) or not name.strip():
            c.err(where, "username must be non-empty text")
            continue
        if name in agents:
            c.err(where, "username is listed twice")
        agents[name] = a
        _text(c, f"{where} goal", a.get("goal"), GOAL_CHARS)
        cited.setdefault(name, []).extend(c.evidence(where, a.get("evidence")))
        signs = a.get("signs_as", [])
        if not isinstance(signs, list) or any(not isinstance(s, str) or not s.strip() for s in signs):
            c.err(where, "signs_as must be a list of names")

    threads: dict[str, dict] = {}
    for i, t in enumerate(lists["threads"]):
        tag, tid = t.get("tag"), t.get("id")
        where = f"threads[{i}] {tag!r}"
        if not isinstance(tag, str) or not tag.strip() or not isinstance(tid, str) or not tid.strip():
            c.err(where, "tag and id must be non-empty text")
            continue
        if tag in threads:
            c.err(where, "tag is listed twice")
        threads[tag] = t
        rec = c.record(where, t.get("ref"))
        if rec is not None and not _names_thread(rec, tid):
            c.err(where, f"its record {t.get('ref')} does not name the thread {tid!r}")

    actions: dict[int, dict] = {}
    times: list[tuple[int, datetime]] = []
    for i, a in enumerate(lists["actions"]):
        aid = a.get("id")
        where = f"actions[{i}] #{aid}"
        if not isinstance(aid, int) or isinstance(aid, bool):
            c.err(where, "id must be an integer")
            continue
        if aid in actions:
            c.err(where, "id is used twice")
        actions[aid] = a
        _text(c, f"{where} action", a.get("action"), ACTION_CHARS)
        rec = c.quote(where, a.get("ref"), a.get("quote"))
        agent, tag = a.get("agent"), a.get("thread")
        if not isinstance(agent, str) or agent not in agents:
            c.err(where, f"agent {agent!r} is not in agents")
        elif rec is not None:
            cited[agent].append(rec)
            if not rec.is_value(agent):
                c.err(where, f"its record {a.get('ref')} does not name the agent {agent!r}")
        if not isinstance(tag, str) or tag not in threads:
            c.err(where, f"thread {tag!r} is not in threads")
        elif rec is not None and not _names_thread(rec, threads[tag]["id"]):
            c.err(where, f"its record {a.get('ref')} does not name the thread {threads[tag]['id']!r}")
        if "time" not in a:
            c.err(where, "time is missing (null when the record has none)")
        elif (when := a["time"]) is not None:
            t = _instant(when)
            if t is None:
                c.err(where, f"time {when!r} is not an ISO datetime")
            else:
                times.append((aid, t))
                if rec is not None and t not in rec.instants:
                    c.err(where, f"time {when} is not a time of its record {a.get('ref')}")
        if "before" in a:
            prev = c.record(f"{where} before", a.get("before"))
            if prev is not None and isinstance(a.get("quote"), str) and prev.has(a["quote"]):
                c.err(where, f"quote {_short(a['quote'])!r} is already in the save before, {a.get('before')}, so this "
                             "save did not add it")
    if actions and sorted(actions) != list(range(1, len(actions) + 1)):
        c.err("actions", f"ids must run 1..{len(actions)} (have {sorted(actions)})")
    times.sort()
    for (a1, t1), (a2, t2) in zip(times, times[1:]):
        if t2 < t1:
            c.err("actions", f"#{a2} ({t2:%Y-%m-%dT%H:%M:%SZ}) is earlier than #{a1} ({t1:%Y-%m-%dT%H:%M:%SZ}); ids "
                             "follow event order")
    for name in agents:
        if not any(a.get("agent") == name for a in actions.values()):
            c.err(f"agents {name!r}", "has no action")
    for tag in threads:
        if not any(a.get("thread") == tag for a in actions.values()):
            c.err(f"threads {tag!r}", "has no action")
    for name, a in agents.items():
        for s in a.get("signs_as", []) if isinstance(a.get("signs_as"), list) else []:
            if isinstance(s, str) and not any(r.names(s) for r in cited.get(name, [])):
                c.err(f"agents {name!r}", f"signs_as {s!r} is in none of the records its actions and evidence cite")

    seen: set[str] = set()
    for i, ln in enumerate(lists["links"]):
        src, dst, kind = ln.get("from"), ln.get("to"), ln.get("type")
        where = f"links[{i}] {src}→{dst}"
        if not isinstance(src, int) or not isinstance(dst, int) or src not in actions or dst not in actions:
            c.err(where, "from and to must be action ids")
        elif not src > dst:
            c.err(where, "a link runs from a later action to an earlier one (from > to)")
        if not isinstance(kind, str) or kind not in LINK_TYPES:
            c.err(where, f"type {kind!r} is not one of {', '.join(LINK_TYPES)}")
        key = json.dumps([src, dst, kind])
        if key in seen:
            c.err(where, "is listed twice")
        seen.add(key)
        _text(c, f"{where} reason", ln.get("reason"), REASON_CHARS)
        c.evidence(where, ln.get("evidence"))

    for key, (lo, hi) in SCALE.items():
        n = len(agents if key == "agents" else threads if key == "threads" else actions)
        if not lo <= n <= hi:
            c.warnings.append(f"{key}: {n}, outside {lo} to {hi}")
    return c.errors, c.warnings


def _names_thread(rec: _Record, tid: str) -> bool:
    """Whether the record holds the thread's id as a whole value, or each `/` part of it as one (a record that keeps
    `dse/Start` as `wiki: dse` and `page: Start`)."""
    parts = [p for p in tid.split("/") if p]
    return rec.is_value(tid) or (len(parts) > 1 and all(rec.is_value(p) for p in parts))


def check_file(corpus: Path, out: Path) -> tuple[list[str], list[str]]:
    try:
        doc = json.loads(out.read_text("utf-8"))
    except FileNotFoundError:
        return [f"{out} does not exist"], []
    except ValueError as e:
        return [f"{out} is not JSON: {e}"], []
    return check(corpus, doc)


ACTOR_FIELD_RE = re.compile(r"^(user|username|label|author|agent|sender|actor|from|login|account|speaker|by|creator)"
                            r"(_?(id|name))?$", re.I)
PLACE_FIELD_RE = re.compile(r"^(page|channel|thread|issue|room|topic|conversation|discussion|document|pr)"
                            r"(_?(id|key))?$", re.I)
DETECT_FILES = 40
DETECT_RECORDS = 50_000
DETECT_MIN = {"actors": 5, "places": 2, "addressing": 0.05}
_WORD_RE = re.compile(r"[\w-]+")


def detect(corpus: Path) -> dict[str, Any]:
    """Whether the corpus shows multi-agent structure, from its JSON Lines files alone and without a model: a file whose
    records carry an actor field and a place field (ACTOR_FIELD_RE, PLACE_FIELD_RE, top-level), with at least
    DETECT_MIN actors, DETECT_MIN places that three or more actors act on, and DETECT_MIN's share of the records in
    shared places naming another actor of the same place as a whole word. The shallowest DETECT_FILES files are read.
    Returns `swarm` and the best file's counts."""
    best: dict[str, Any] = {"swarm": False}
    for path in sorted(corpus.rglob("*.jsonl"), key=lambda p: (len(p.parts), p))[:DETECT_FILES]:
        rows = []
        with path.open(encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= DETECT_RECORDS:
                    break
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict):
                    rows.append(r)
        keys = {k for r in rows[:200] for k in r}
        actor = next((k for k in sorted(keys) if ACTOR_FIELD_RE.match(k)), None)
        place = next((k for k in sorted(keys) if PLACE_FIELD_RE.match(k)), None)
        if not actor or not place:
            continue
        by_place: dict[str, set[str]] = {}
        for r in rows:
            a, pl = r.get(actor), r.get(place)
            if a not in (None, "") and pl not in (None, ""):
                by_place.setdefault(str(pl), set()).add(str(a))
        actors = set().union(*by_place.values()) if by_place else set()
        shared = {pl for pl, who in by_place.items() if len(who) >= 2}
        in_shared = addressing = 0
        for r in rows:
            pl, a = str(r.get(place)), str(r.get(actor))
            if pl not in shared:
                continue
            in_shared += 1
            words = {w for k, v in r.items() if k not in (actor, place)
                     for s in _strings(v) for w in _WORD_RE.findall(s)}
            addressing += bool(words & (by_place[pl] - {a}))
        found = {"file": str(path.relative_to(corpus)), "actor_field": actor, "place_field": place,
                 "actors": len(actors), "places": sum(len(who) >= 3 for who in by_place.values()),
                 "addressing": round(addressing / in_shared, 3) if in_shared else 0.0}
        found["swarm"] = all(found[k] >= v for k, v in DETECT_MIN.items())
        if (found["swarm"], found["addressing"]) > (best["swarm"], best.get("addressing", -1)):
            best = found
    return best


def settings(work: Path, corpus: Path) -> dict[str, Any]:
    """The session's --settings: Bash sandboxed with writes only in the work folder, and no edit inside the corpus."""
    return {
        "permissions": {"defaultMode": "default", "allow": list(TOOLS),
                        "deny": [f"Edit(/{corpus}/**)", f"Write(/{corpus}/**)", *DISALLOWED]},
        "sandbox": {"enabled": True, "autoAllowBashIfSandboxed": True, "allowUnsandboxedCommands": False},
    }


def capacity_waits(base_s: float = CAPACITY_BASE_S, budget_s: float = CAPACITY_BUDGET_S):
    """Waits between capacity retries: doubling from base_s up to CAPACITY_MAX_S, each ±20% jitter, until the budget
    is spent."""
    spent, k = 0.0, 0
    while spent < budget_s:
        w = min(base_s * 2**k, CAPACITY_MAX_S) * random.uniform(0.8, 1.2)
        spent += w
        k += 1
        yield w


def _env() -> dict[str, str]:
    """This process's environment without the variables of a parent Claude Code session, an API key or thimble's own,
    so the session authenticates through CLAUDE_CONFIG_DIR's settings."""
    return {k: v for k, v in os.environ.items() if not k.startswith(_ENV_DROP)}


def _session(argv: list[str], message: str, work: Path, log_path: Path) -> dict[str, Any]:
    """Run one `claude -p` process; its last result line, with `refused` set when a response stopped for refusal."""
    result: dict[str, Any] = {}
    refused = False
    with log_path.open("a", encoding="utf-8") as log, subprocess.Popen(
            [*argv, message], cwd=work, env=_env(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True) as proc:
        start = time.monotonic()
        assert proc.stdout is not None
        for line in proc.stdout:
            log.write(line)
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "result":
                result = ev
            elif ev.get("type") == "assistant" and (ev.get("message") or {}).get("stop_reason") == "refusal":
                refused = True
            if time.monotonic() - start > SESSION_TIMEOUT_S:
                proc.kill()
                result = {"is_error": True, "result": "session timed out"}
                break
        stderr = proc.stderr.read() if proc.stderr else ""
    if not result:
        result = {"is_error": True, "result": stderr.strip()[-2000:] or f"exit {proc.returncode}"}
    result["refused"] = refused or result.get("stop_reason") == "refusal"
    return result


def _app():
    if __package__:
        from . import prompts, retry
    else:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from app import prompts, retry  # type: ignore[no-redef]
    return prompts, retry


def run(corpus: Path, out: Path, work: Path, request: str = "", model: str = MODEL,
        fallback_model: str = FALLBACK_MODEL, rounds: int = ROUNDS) -> tuple[list[str], list[str]]:
    """Make the swarm map of `corpus` at `out` with a session in `work`, as the module note says; the last check's
    (errors, warnings)."""
    prompts, retry = _app()
    corpus, out, work = corpus.resolve(), out.resolve(), work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    draft = work / out.name
    check_cmd = f"python3 {Path(__file__).resolve()} check {corpus} {draft}"
    system = prompts.render("swarm", {"corpus": str(corpus), "workfolder": str(work), "out": str(draft),
                                      "request": request.strip() or "None.", "check": check_cmd})
    settings_path = work / "settings.json"
    settings_path.write_text(json.dumps(settings(work, corpus), indent=2), "utf-8")
    runs_path = out.with_name(out.stem + ".runs.jsonl")

    def msg(name: str, **values: str) -> str:
        return prompts.section("tools", name).strip().format(**values)

    sid, resume, message = str(uuid.uuid4()), False, msg("swarm-start", corpus=str(corpus), out=str(draft))
    waits = capacity_waits()
    fixes, k, fell_back = 0, 0, False
    errors: list[str] = []
    warnings: list[str] = []
    while True:
        k += 1
        argv = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--model", model,
                "--append-system-prompt", system, "--add-dir", str(corpus), "--settings", str(settings_path),
                "--permission-mode", "default", "--allowedTools", *TOOLS, "--disallowedTools", *DISALLOWED,
                "--resume" if resume else "--session-id", sid, "--"]
        res = _session(argv, message, work, work / f"session-{k}.jsonl")
        text = str(res.get("result") or "")
        with runs_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"k": k, "model": model, "session": sid, "is_error": res.get("is_error"),
                                "refused": res["refused"], "cost_usd": res.get("total_cost_usd"),
                                "duration_ms": res.get("duration_ms"), "turns": res.get("num_turns"),
                                "usage": res.get("usage"), "result": text[:500]}) + "\n")
        if res["refused"] and not fell_back:
            print(f"swarm: a safety classifier stopped {model}; resuming on {fallback_model}", file=sys.stderr)
            message = msg("session-model-fallback", model=model, fallback=fallback_model, stopped="")
            model, resume, fell_back = fallback_model, True, True
            continue
        if res.get("is_error") and retry.transient_class(res.get("api_error_status"), text) in (
                "overloaded", "rate_limited", "server_error", "connection"):
            wait = next(waits, None)
            if wait is None:
                return [f"the API stayed at capacity: {text[:300]}"], []
            print(f"swarm: capacity ({text[:120]}); retrying in {wait:.0f}s", file=sys.stderr)
            time.sleep(wait)
            message, resume = msg("session-retry"), True
            continue
        errors, warnings = check_file(corpus, draft)
        if not errors or fixes >= rounds:
            if draft.is_file():
                out.write_bytes(draft.read_bytes())
            return errors, warnings
        fixes += 1
        message = msg("swarm-check-failed", out=str(draft), errors="\n".join(f"- {e}" for e in errors))
        resume = True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="swarm", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    dt = sub.add_parser("detect", help="say whether a corpus shows multi-agent structure")
    dt.add_argument("corpus", type=Path)
    ck = sub.add_parser("check", help="check a swarm map against its corpus")
    ck.add_argument("corpus", type=Path)
    ck.add_argument("out", type=Path)
    rn = sub.add_parser("run", help="make a swarm map with a Claude Code session")
    rn.add_argument("corpus", type=Path)
    rn.add_argument("out", type=Path)
    rn.add_argument("--work", type=Path, help="the session's work folder (default: <OUT stem>-work beside OUT)")
    rn.add_argument("--request", default="")
    rn.add_argument("--model", default=MODEL)
    rn.add_argument("--fallback-model", default=FALLBACK_MODEL)
    rn.add_argument("--rounds", type=int, default=ROUNDS, help="times a failing check is sent back")
    a = ap.parse_args(argv)
    if a.cmd == "detect":
        found = detect(a.corpus)
        print(json.dumps(found))
        return 0 if found["swarm"] else 1
    if a.cmd == "check":
        errors, warnings = check_file(a.corpus, a.out)
    else:
        work = a.work or a.out.with_name(a.out.stem + "-work")
        errors, warnings = run(a.corpus, a.out, work, a.request, a.model, a.fallback_model, a.rounds)
    for e in errors:
        print(f"error: {e}")
    for w in warnings:
        print(f"warning: {w}")
    if not errors:
        print("ok" + (f" ({len(warnings)} warnings)" if warnings else ""))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
