"""`thimble demo`: public datasets, each opened on an orientation run ahead of time where demos/ has one.

    thimble demo [NAME...] [--yes] [--dir DIR] [--attach | --no-attach] [--replace] [--precaches DIR] [--list]
    thimble demo --export WORKSPACE OUT [--outputs-only] [--dataset NAME] [--corpus DIR] [--claude-config DIR]
        [--view SLUG] [--scrub-user] [--allow-private]
    thimble demo --examples [--refresh]

The command lists the datasets (demo_data.DATASETS) with their sources, credits and sizes, asks before each download
(--yes answers yes for all), rebuilds each dataset from its publisher's files into DIR/<name> (default ~/thimble-demo)
and checks it against the copy the orientations ran on. thimble redistributes none of the data: each dataset comes from
its publisher, and DIR/SOURCES.md says from where. It then registers the folder as the workspace demo-<name> (names,
below), installs that dataset's pre-cache as its workspace when demos/ (or --precaches DIR) has one (a dataset without
one opens with no analysis yet, with a line saying so), and prints and opens one URL without a Claude Code session:
thimble's start page, which lists every dataset downloaded (start_page.py), one run's or an earlier one's, by the
dataset's name. --examples opens the worked examples of custom views on the same server instead (demo_examples.py), and
the same start page.

Names. Each dataset's workspace is demo-<name> (workspace_name), so it never takes the name of a folder of the analyst's
own called <name>, nor gets a -2 beside one. A workspace an earlier `thimble demo` registered under another name (what
the start page calls a demo workspace of the dataset, start_page.demo_dataset, such as collusion-wiki-2) is renamed
demo-<name> on the next run, with its cards, labels, views, documents, chats and archives (settle_name): the server
stops what it runs for it and moves it (POST /api/ws/{c}/rename, ledger.move_workspace), or, with no server, the move is
made on the disk. A tab or a bookmark on the old name opens the new one (the registration's `renamed_from`). While a
Claude Code session holds it open, or when the move fails, it keeps its name, and a line says how to rename or remove
it; when Claude Code sessions ran in its folder (a full pre-cache's), which could not continue after a move, it stays
where it is, unregistered, the folder registers as demo-<name>, and a line says how to remove the old one (`thimble
purge`).

Attaching. The demo is static: it opens the start page and starts no Claude Code session. --attach starts one (`thimble`
in the dataset's folder), after `claude auth status` says a login is configured (when it says none, it says how to log
in). Without it, and unless a full pre-cache's session was kept, it prints for each dataset what the orientation's card
in the browser says of a frozen demo session (FROZEN_LINE) and the command, `cd <folder> && thimble`, and nothing else
(attach_lines); with it, or a kept session, how to attach later, and that `thimble -c` there continues the last session.
A session attached to a pre-cached workspace starts fresh, with the canvas and the report as its context (precached.py).

The export writes one of two formats, a folder with `thimble-demo-precache.json` (the manifest), `README.md` (the
source's notice first, then what the folder holds) and `workspace/`; absolute paths are written as placeholders
(demo_scrub.PLACEHOLDERS) and filled in on install. It ends with an inventory of what it wrote (inventory_lines).

The full export (the default, version FULL_VERSION). Everything of the workspace but what thimble rebuilds or what
belongs to this machine's processes and sessions (full_kept; the hooks' `trusted` folder among them): the cards, documents, labels with every row (rationales and the
texts each label marked), views with their earlier versions, every chat and every call with its whole output, the
orientation's and the agents' work files; and in `transcripts/` the Claude Code transcripts of the sessions thimble
ran inside the workspace (the orientation, its critic, the writers, view builds: session_transcripts), each cleaned of
what Claude Code told the model about the exporter's machine and account (demo_scrub.clean_transcript). It refuses
nothing for its content: the inventory says how much of the dataset's text it holds, what may be private (the user
name, other absolute paths, gitleaks' findings) and what it left out. Install places each transcript where Claude Code
resumes it, under a new session id, so the orientation, the writers and the view builds continue from a message.

The outputs alone (--outputs-only, version VERSION): what demos/<name>/ in the repository holds, plain files a reviewer
reads in a diff: the orientation's outputs by their paths in the workspace (demo_scrub.workspace_kind): the cards with
their outputs, the documents, the labels' definitions and their values by record ref (no record text), the views' code
and manifests, the orientation's record and its thread's meta, and the calls the report or a card cites, each cut to
an excerpt (cited_calls). No Claude Code transcript, no conversation, no work file and no data a view or a label index
derived from the records: views rebuild their indexes from the download when first opened. The export refuses, naming
each file, when a file it would write shares a stretch of demo_verbatim.LONG characters or more with the corpus (no
flag lets it through), and, unless --allow-private, while the exporter's user name or another absolute path remains or
gitleaks finds a secret. scripts/check_content.py allows these folders in the tree on the terms its DEMO note gives,
and no folder of another version.

Install fills in the placeholders, writes the workspace but a `trusted` folder an older export kept, ends the
orientation's thread with the coverage line the manifest keeps (coverage_line), and marks it pre-cached (MARKER, and
`precached` in the orientation's record and its thread's meta): the orientation's thread then says it ran in advance
and offers to attach a fresh session. From the outputs alone a follow-up to it is refused, since its session was not kept; from a full
export the mark says `kept` and a follow-up resumes the installed session.

The view it opens on. Either export takes `--view SLUG`, one of the workspace's views, and the manifest's `view` keeps
it; install copies it to the mark's `view` when the pre-cache holds that view (opening_view). The start page's row of
the dataset then opens the workspace on that view, as an example's row opens on its own (start_page.rows), and so does
a first open of the workspace in a browser with no `?ref=` (frontend Shell), rather than on the File browser.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from . import config, demo_data, demo_verbatim
from .subagent_files import DIR as TRUSTED
from .demo_data import DATASETS, Dataset
from .demo_scrub import (CALL_CUT_NOTE, CALL_KEPT, CALL_LINE_CHARS, CALL_LINES, DASHED, LABEL_DROPPED, PLACEHOLDERS,
                         TEXT_SUFFIXES, clean_transcript, findings, projects_folder, shape_findings, workspace_kind)

SCHEMA = "thimble-demo-precache"
# 1 was a zip (release assets); 2 a folder with the orientation's transcript, which install reads as a full export
VERSION = 3  # the outputs alone (--outputs-only): what demos/ holds
FULL_VERSION = 4  # the full export (module note)
FULL_VERSIONS = (2, FULL_VERSION)
MANIFEST = "thimble-demo-precache.json"
README = "README.md"
WORKSPACE = "workspace"
TRANSCRIPTS = "transcripts"  # in a full export: transcripts/<session>.jsonl and its folder transcripts/<session>/
MARKER = "precached.json"  # in an installed workspace: what was installed, from where, and the sessions given it
PRECACHES = config.REPO_ROOT / "demos"  # demos/<name>/
DEFAULT_DIR = Path("$THIMBLE_HOME/demo")  # for the help text; default_dir() is the folder
DEMO_PREFIX = "demo-"  # of each dataset's workspace name (workspace_name)


def default_dir() -> Path:
    """Where the datasets go unless --dir says: demo/ in thimble's own folder (THIMBLE_HOME, ~/.thimble)."""
    return (Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser() / "demo").resolve()
SCRUBBED_USER = "user"  # what --scrub-user writes in place of the exporter's user name
COVERAGE_CHIP = "coverage"  # the chip kind of the coverage line at the end of the orientation's thread (orient_session)
LOGIN_HINT = "`claude auth login`, or run `claude` and type /login"

# What the export keeps of the orientation's record and of its thread's meta; the rest belonged to its session.
RUN_KEYS = ("status", "passes", "query", "effort", "critique", "ultracode", "requested", "started", "ended", "groups",
            "chats", "error", "run", "report_asked", "revised_cards")
META_KEYS = ("id", "kind", "role", "title", "created_at", "parent", "agent_type", "effort", "model", "mode_agent",
             "ultracode", "critique", "brief", "anchor", "anchor_text", "group", "result", "ts_end")
# what a chat's meta keeps of the process that ran it, and of the background session an earlier version ran it as,
# whose short id names a session of the maintainer's machine: install takes these out of every chat's meta, so no
# follow-up or server start runs `claude stop` on that id (agent_session)
PROCESS_FIELDS = ("pid", "server", "follow", "background", "bg")
# a call a card or the report cites; LABEL_DROPPED and how much of a cited call's output is kept (CALL_LINES,
# CALL_KEPT, CALL_LINE_CHARS) are demo_scrub's, which check_content checks again
CALL_REF_RE = re.compile(r"call:([A-Za-z0-9_-]{1,64})/(\d+)(?:#L(\d+)(?:-L(\d+))?)?")
# Why each other part of a workspace is left out, by the first part of its path.
# the workspace's folder of the files thimble's hooks trust (subagent_files): this machine's Claude Code session ids, its
# agent records and the launcher's record, which no export holds and no install places, since another machine's would
# name sessions and agents it never ran and the hooks would trust them
TRUSTED_WHY = "this machine's Claude Code sessions and thimble's agent records"
LEFT_OUT = {
    "chats": "a conversation: its tool results quote the corpus",
    "calls": "calls no card or document cites",
    "orient": "the orientation's work files",
    "canvas-history.jsonl": "the cards' edit history",
    "card-checks": "the card checks' screenshots and earlier card states",
    "views-work": "the view builds' scratch",
    "view-indexes": "views' indexes of the corpus, rebuilt from the download",
    "scratch": "the kernels' mirror of the corpus",
    "kernels": "kernel state",
    "telemetry.jsonl": "the maintainer's browser telemetry",
    "viewed.jsonl": "the files the maintainer opened",
    "sessions.json": "the maintainer's Claude Code sessions",
    "bg-sessions.json": "an earlier version's background sessions",
    "bg": "the agent tray's instructions",
    "permissions.jsonl": "permission answers",
    "undo.jsonl": "the undo history",
    "render-theme.json": "the browser's theme",
    "unheard.json": "per session",
    "held-events.json": "per session",
    "critique": "the critic's digest of the transcript",
    "writers": "the writers' own scratch",
    "settings.json": "the maintainer's settings",
    "config.json": "the maintainer's settings",
    "registry": "rebuilt by thimble",
    "filters.json": "the canvas's filter",
    "extensions": "the maintainer's extensions",
    "views": "the views' earlier versions and the excerpts their keys cite, rebuilt",
    TRUSTED: TRUSTED_WHY,
}
# paths a pre-cache may hold: relative, no `..`, no backslash
SAFE_NAME = re.compile(r"^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[^\\\x00]+$")


class DemoError(Exception):
    pass


def opening_view(ws: Path, slug: Any) -> str | None:
    """`slug` when workspace folder `ws` holds that view (extension/views/<slug>/view.json), else None: the view a
    pre-cache names for its workspace to open on (module note)."""
    from . import views  # noqa: PLC0415 — the views' module is the server's, loaded only here

    slug = str(slug or "")
    if not views.SLUG_RE.match(slug):
        return None
    return slug if (ws / views.LOCAL_SUBDIR / views.VIEWS_SUBDIR / slug / views.VIEW_JSON).is_file() else None


def check_view(ws: Path, slug: str | None) -> None:
    """DemoError when an export is asked to open on view `slug` and workspace folder `ws` has no such view."""
    if slug is None or opening_view(ws, slug):
        return
    from . import views  # noqa: PLC0415

    root = ws / views.LOCAL_SUBDIR / views.VIEWS_SUBDIR
    have = sorted(d.parent.name for d in root.glob(f"*/{views.VIEW_JSON}")) if root.is_dir() else []
    raise DemoError(f"{ws.name} has no view {slug}; its views: {', '.join(have) or 'none'}")


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def file_sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def given(path: str) -> Path:
    """A path the analyst typed, relative to the folder they ran `thimble` in (plugin/bin/thimble runs the CLI in
    backend/ and names their folder in THIMBLE_CALLER_CWD)."""
    return (Path(os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd()) / Path(path).expanduser()).resolve()


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1000 or unit == "GB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.1f} GB"


def _read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _dump(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, indent=1).encode("utf-8")


# --------------------------------------------------------------------------- the pre-cache: export


def orient_chat(run: Any) -> str:
    """The orientation's chat id in its record, '' when it names none or an unsafe one."""
    cid = str(((run.get("chats") or {}) if isinstance(run, dict) else {}).get("orient") or "")
    return cid if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", cid) else ""


def kept(rel: Path, chat: str) -> str | None:
    """None when a pre-cache keeps the workspace file `rel` (relative to the workspace), else why it is left out.
    `chat` is the orientation's chat, whose meta is kept and whose log is written empty. Calls are kept by
    cited_calls."""
    s, top = rel.as_posix(), rel.parts[0]
    if chat and s in (f"chats/{chat}.meta.json", f"chats/{chat}.jsonl"):
        return None
    if top == "calls":
        return LEFT_OUT["calls"]
    if workspace_kind(s):
        return None if top != "chats" else LEFT_OUT["chats"]
    if any(p.startswith(".") for p in rel.parts):
        return "a hidden file"
    if top == "extension":
        return "a view's cache or data, rebuilt from the download"
    if top == "notebooks":
        return "the canvas's trash or cache" if {"trash", "cache", "tmp"} & set(rel.parts) else "not text"
    if top == "labels":
        return "the label's index, rebuilt from its values"
    if s == "views/key-refs.json":
        return "the excerpts of the records the views' keys cite, rebuilt"
    return LEFT_OUT.get(top, "not one of the orientation's outputs")


def dashed(path: str) -> str:
    """A folder as Claude Code names its projects folder (`-home-a-…`): every character but a letter or a digit as
    `-` (a path that long is cut short there, which no placeholder needs)."""
    return re.sub(r"[^A-Za-z0-9]", lambda m: "--" if ord(m.group()) > 0xFFFF else "-", path)


def thimble_home() -> Path:
    """thimble's home folder ($THIMBLE_HOME, else ~/.thimble)."""
    return config.default_data_dir().parent


def placeholder_pairs(workspace: Path, corpus: Path, home: Path, app: Path,
                      own: Path | None = None) -> list[tuple[str, str]]:
    """(absolute path, placeholder) for the workspace, the corpus, thimble's install, thimble's home (`own`) and the
    home folder, as written and JSON-escaped, and as Claude Code's projects folder names them (`-home-a-…`), longest
    first, so a workspace inside the home folder is written as the workspace's placeholder."""
    pairs = []
    for key, p in (("workspace", workspace), ("corpus", corpus), ("app", app), ("thimble_home", own or thimble_home()),
                   ("home", home)):
        for form in {str(p), str(p.resolve())}:
            pairs += [(form, PLACEHOLDERS[key]), (json.dumps(form)[1:-1], PLACEHOLDERS[key]),
                      (dashed(form), DASHED[key])]
    return sorted(set(pairs), key=lambda kv: -len(kv[0]))


# a path cut short: by a summary's ellipsis, or where a logged tool input ends (the string's closing quote)
TRUNCATED_RE = re.compile(r"/[^\s'\"`\\…]{3,}(?=…|\\u2026|\\?\")")


def with_placeholders(text: str, pairs: list[tuple[str, str]]) -> str:
    """`text` with each path of `pairs` written as its placeholder, also where it was cut short (`/home/a…`), which
    is written as the placeholder and an ellipsis."""
    def cut(m: re.Match[str]) -> str:
        head = m.group()
        if head.count("/") < 2 or len(head) < 5:
            return head
        ell = "" if m.string.startswith(("…", "\\u2026"), m.end()) else "…"  # the cut keeps its own ellipsis
        return next((new + ell for old, new in pairs if old.startswith("/") and old.startswith(head) and old != head),
                    head)

    text = TRUNCATED_RE.sub(cut, text)
    for old, new in pairs:
        text = text.replace(old, new)
    return text


def is_text(rel: Path, data: bytes) -> bool:
    """Whether a file is text a pre-cache keeps: one of TEXT_SUFFIXES, in UTF-8."""
    if rel.suffix.lower() not in TEXT_SUFFIXES:
        return False
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def run_record(data: bytes) -> bytes:
    """The orientation's record with RUN_KEYS alone: done, with no session and nothing queued."""
    run = json.loads(data)
    out = {k: run[k] for k in RUN_KEYS if k in run}
    out.update(status="done", queue=[], followups=[])
    return _dump(out)


def orient_meta(data: bytes) -> bytes:
    """The orientation thread's meta with META_KEYS alone, done: what its session was (id, process, transcript offset,
    permissions, its folder) is left out."""
    meta = json.loads(data)
    out = {k: meta[k] for k in META_KEYS if k in meta}
    out["status"] = "done"
    return _dump(out)


def label_rows(data: bytes) -> bytes:
    """A label's values by record ref: each row without LABEL_DROPPED."""
    lines = []
    for line in data.decode("utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            for k in LABEL_DROPPED:
                row.pop(k, None)
            lines.append(json.dumps(row, ensure_ascii=False))
    return ("\n".join(lines) + "\n").encode("utf-8") if lines else b""


def citations(texts: Iterable[str]) -> dict[tuple[str, int], list[tuple[int, int]] | None]:
    """The calls cited in `texts`, by (chat, n): the line ranges cited, or None when a citation names the whole call."""
    out: dict[tuple[str, int], list[tuple[int, int]] | None] = {}
    for text in texts:
        for m in CALL_REF_RE.finditer(text):
            key = (m.group(1), int(m.group(2)))
            if m.group(3) is None:
                out[key] = None
                continue
            a = int(m.group(3))
            b = int(m.group(4) or a)
            if key not in out:
                out[key] = []
            if out[key] is not None:
                out[key].append((min(a, b), max(a, b)))
    return out


def call_excerpt(result: Any, ranges: list[tuple[int, int]] | None) -> tuple[Any, bool]:
    """A cited call's output as the pre-cache keeps it: its first CALL_LINES lines unless only lines are cited, and
    the lines cited (`ranges`) in place, at most CALL_KEPT lines in all, every other line left empty so that the cited
    numbers still hold, each line cut to CALL_LINE_CHARS; and whether anything was cut. An output that is not text is
    kept as its JSON text, cut the same way."""
    if result is None:
        return result, False
    if not isinstance(result, str):
        result = json.dumps(result, ensure_ascii=False, indent=1)
    lines = result.split("\n")
    keep, kept_n = [], 0
    for i, ln in enumerate(lines, 1):
        k = kept_n < CALL_KEPT and ((ranges is None and i <= CALL_LINES) or any(a <= i <= b for a, b in ranges or ()))
        kept_n += bool(k and ln)
        keep.append(k)
    out = [(ln[:CALL_LINE_CHARS] if k else "") for ln, k in zip(lines, keep)]
    while out and not out[-1]:
        out.pop()
    cut = out != lines
    return ("\n".join(out) + ("\n" + CALL_CUT_NOTE if cut else "")), cut


def cited_calls(ws: Path, texts: Iterable[str]) -> tuple[dict[str, bytes], list[dict[str, Any]]]:
    """The calls the texts cite, from the workspace's call logs: {calls/<chat>.jsonl: the rows of the cited calls,
    their outputs cut by call_excerpt}, and one entry per cited call for the manifest (chat, n, lines, cut, found)."""
    wanted = citations(texts)
    by_chat: dict[str, dict[int, list[tuple[int, int]] | None]] = {}
    for (chat, n), ranges in wanted.items():
        by_chat.setdefault(chat, {})[n] = ranges
    files: dict[str, bytes] = {}
    listed: list[dict[str, Any]] = []
    for chat, ns in sorted(by_chat.items()):
        path = ws / "calls" / f"{chat}.jsonl"
        rows: list[dict[str, Any]] = []
        found: set[int] = set()
        cut: set[int] = set()
        try:
            text = path.read_text("utf-8")
        except OSError:
            text = ""
        for line in text.splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict) or row.get("n") not in ns:
                continue
            n = int(row["n"])
            if "result" in row:
                row["result"], was_cut = call_excerpt(row["result"], ns[n])
                if was_cut:
                    cut.add(n)
            if "input" in row:
                found.add(n)
            rows.append(row)
        if rows:
            files[f"calls/{chat}.jsonl"] = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows).encode()
        listed += [{"chat": chat, "n": n, "lines": [list(r) for r in ns[n]] if ns[n] else None, "cut": n in cut,
                    "found": n in found} for n in sorted(ns)]
    return files, listed


def coverage_line(run: Any) -> str | None:
    """The first run's coverage line in the orientation's record (orient_session._keep_coverage), None when it has
    none. The pre-cache keeps it in the manifest's `orientation`, and install puts it back at the end of the
    orientation's thread, whose log the pre-cache writes empty."""
    line = run.get("coverage") if isinstance(run, dict) else None
    return line.strip() if isinstance(line, str) and line.strip() else None


def chat_summary(ws: Path, chat: str) -> dict[str, Any]:
    """The orientation's chat meta (model, effort), for the manifest."""
    meta = _read_json(ws / "chats" / f"{chat}.meta.json") if chat else None
    return meta if isinstance(meta, dict) else {}


def counts(ws: Path) -> dict[str, int]:
    cards = 0
    for p in (ws / "notebooks").glob("*.json"):
        nb = _read_json(p)
        if isinstance(nb, dict):
            cards += len([c for c in nb.get("cells") or [] if isinstance(c, dict)])
    views = [p for p in (ws / "extension" / "views").glob("*/view.json")] if (ws / "extension").is_dir() else []
    docs = [p for p in (ws / "investigations" / "main").glob("*.json")
            if p.name != "investigation.json" and not p.name.endswith(".frame.json")]
    return {"cards": cards, "labels": len(list((ws / "concepts").glob("*.json"))), "views": len(views),
            "documents": len(docs)}


def corpus_files(corpus: Path) -> list[dict[str, Any]]:
    return [{"path": p.relative_to(corpus).as_posix(), "bytes": p.stat().st_size, "sha256": file_sha256(p)}
            for p in sorted(corpus.rglob("*")) if p.is_file() and not any(x.startswith(".") for x in
                                                                         p.relative_to(corpus).parts)]


def gitleaks_scan(root: Path) -> list[str] | None:
    """gitleaks over the staged files: one line per finding; None when gitleaks is not installed."""
    exe = shutil.which("gitleaks")
    if not exe:
        return None
    report = root.parent / f"{root.name}.gitleaks.json"
    try:
        subprocess.run([exe, "dir", str(root), "--no-banner", "--redact", "--report-format", "json", "--report-path",
                        str(report), "--exit-code", "0", "--log-level", "error"], capture_output=True, timeout=600)
        found = json.loads(report.read_text() or "[]") if report.is_file() else []
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        return [f"gitleaks failed: {e}"]
    finally:
        report.unlink(missing_ok=True)
    return [f"{Path(f.get('File', '')).relative_to(root) if Path(f.get('File', '')).is_relative_to(root) else f.get('File')}"
            f":{f.get('StartLine')}: {f.get('RuleID')}" for f in found]


def verbatim_check(staged: dict[str, str], corpus: demo_verbatim.Corpus,
                   long: int = demo_verbatim.LONG) -> tuple[list[str], list[dict[str, Any]]]:
    """The files of `staged` (path -> text) that share a stretch of `long` characters or more with the corpus, one line
    each naming the file; and for each file that shares any stretch, its longest and the characters all of them hold
    (for the manifest), longest first."""
    refused, longest = [], []
    for rel, text in staged.items():
        found = demo_verbatim.scan(corpus, rel, text, long)
        if found.longest:
            longest.append({"path": rel, "chars": found.longest, "shared": found.shared})
        if found.long_runs:
            refused.append(f"{rel}: {found.long_runs} stretch{'es' if found.long_runs > 1 else ''} of {long}+ "
                           f"characters copied from the corpus, the longest {found.longest} "
                           f"(it starts {found.sample[:60]!r})")
    return refused, sorted(longest, key=lambda f: -f["chars"])


def export_outputs(ws: Path, corpus: Path, out: Path, *, name: str, home: Path | None = None, user: str | None = None,
                   allow_private: bool = False, scrub_user: bool = False, app: Path | None = None,
                   scan: Callable[[Path], list[str] | None] = gitleaks_scan, long: int = demo_verbatim.LONG,
                   index: demo_verbatim.Corpus | None = None, view: str | None = None) -> dict[str, Any]:
    """Write the outputs-only pre-cache (version VERSION) of workspace folder `ws`, made on corpus folder `corpus`, as
    the folder `out` (replacing an export there); the manifest. DemoError, and nothing written, when a file would share
    a stretch of `long` characters or more with the corpus (`index`, else built from `corpus`), when something private
    remains (unless `allow_private`), when `out` holds files that are not a pre-cache's, or when `view` (the view the
    workspace opens on: the manifest's `view`) is none of the workspace's. `scrub_user` writes SCRUBBED_USER in place of
    the user name where it stands as a word (in `ls -l` output, say)."""
    check_view(ws, view)
    home = home or Path.home()
    user = getpass.getuser() if user is None else user
    if out.exists() and any(out.iterdir()) and not (out / MANIFEST).is_file():
        raise DemoError(f"{out} holds files that are not a pre-cache; choose another folder")
    pairs = placeholder_pairs(ws, corpus, home, app or config.REPO_ROOT)
    user_re = re.compile(rf"(?<![\w]){re.escape(user)}(?![\w])") if user and len(user) >= 3 else None
    scrubbed = 0
    left: list[dict[str, Any]] = []
    flagged: list[str] = []
    run = _read_json(ws / "orient" / "run.json")
    if not isinstance(run, dict):
        raise DemoError(f"{ws} has no orientation record (orient/run.json)")
    chat = orient_chat(run)

    def scrub(rel: str, text: str) -> str:
        nonlocal scrubbed
        text = with_placeholders(text, pairs)
        if scrub_user and user_re is not None:
            text, n = user_re.subn(SCRUBBED_USER, text)
            scrubbed += n
        flagged.extend(f"{WORKSPACE}/{rel}: {f}" for f in findings(text, user))
        return text

    staged: dict[str, str] = {}  # path in the workspace -> text, as it will be written
    for p in sorted(ws.rglob("*")):
        if not p.is_file() or p.is_symlink():
            continue
        rel = p.relative_to(ws)
        s = rel.as_posix()
        why = kept(rel, chat)
        data = p.read_bytes() if why is None else b""
        if why is None and not is_text(rel, data):
            why = "not text"
        if why:
            left.append({"path": s, "bytes": p.stat().st_size, "why": why})
            continue
        try:
            if s == "orient/run.json":
                data = run_record(data)
            elif s == f"chats/{chat}.meta.json":
                data = orient_meta(data)
            elif s == f"chats/{chat}.jsonl":
                data = b""  # the thread's log: its tool results quote the corpus
            elif rel.parts[0] == "labels":
                data = label_rows(data)
        except ValueError as e:
            raise DemoError(f"{s} is not readable JSON: {e}") from e
        staged[s] = data.decode("utf-8")
    if chat and f"chats/{chat}.meta.json" in staged:
        staged.setdefault(f"chats/{chat}.jsonl", "")
    calls, cited = cited_calls(ws, staged.values())
    for s, data in calls.items():
        staged[s] = data.decode("utf-8")
    left = [f for f in left if f["path"] not in calls]
    staged = {s: scrub(s, text) for s, text in sorted(staged.items())}
    refused, longest = verbatim_check(staged, index or demo_verbatim.Corpus(corpus), long)
    # what check_content checks again in the tree (demo_scrub.shape_findings): no flag lets it through
    shape = {"orientation": {"chat": chat}, "cited_calls": cited}
    misshapen = [f"{s}: {f}" for s, text in staged.items() for f in shape_findings(s, text, shape)]
    # staged outside the checkout, so a file refused below, or one gitleaks reads, is never written there, not even
    # when the export is killed before it cleans up
    with tempfile.TemporaryDirectory(prefix="thimble-demo-export-") as tmp:
        stage = Path(tmp) / "precache"
        files: list[dict[str, Any]] = []
        for s, text in staged.items():
            body = text.encode("utf-8")
            dest = stage / WORKSPACE / s
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
            files.append({"path": s, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
        leaks = scan(stage)
        flagged += [f"gitleaks: {x}" for x in leaks or []]
        meta = chat_summary(ws, chat)
        manifest = {
            "schema": SCHEMA, "version": VERSION, "format": "outputs-only", "dataset": name,
            **({"view": view} if view else {}), "created": now(),
            # the source's own notice travels with excerpts of it (mythos-5's asks to stay out of training corpora)
            "notice": DATASETS[name].notice if name in DATASETS else "",
            "credit": DATASETS[name].credit if name in DATASETS else "",
            "thimble": {"version": _thimble_version(), "commit": _commit()},
            "orientation": {k: run.get(k) for k in ("status", "passes", "query", "effort", "ultracode", "critique",
                                                    "started", "ended")}
                           | {"model": meta.get("model"), "chat_effort": meta.get("effort"), "chat": chat,
                              "coverage": coverage_line(run)},
            "counts": counts(ws),
            "corpus": corpus_files(corpus),
            "placeholders": PLACEHOLDERS,
            "files": files,
            "cited_calls": cited,
            "verbatim": {"long": long, "window": demo_verbatim.WINDOW, "stride": demo_verbatim.STRIDE,
                         "longest": longest[:20]},
            "left_out": left,
            "gitleaks": "not installed" if leaks is None else f"{len(leaks)} findings",
            "user_name_scrubbed": scrubbed,
            "flagged": [],
        }
        # the manifest carries the orientation's request and the paths of the files left out: scrubbed and checked
        # as the workspace's files are (check_content checks it without its `flagged`)
        text = with_placeholders(json.dumps(manifest, ensure_ascii=False), pairs)
        if scrub_user and user_re is not None:
            text, n = user_re.subn(SCRUBBED_USER, text)
            scrubbed += n
        manifest = json.loads(text)
        flagged += [f"{MANIFEST}: {f}" for f in findings(text, user)]
        manifest.update(user_name_scrubbed=scrubbed, flagged=flagged)
        problems = []
        if refused:
            problems.append(f"{len(refused)} file{'s' if len(refused) > 1 else ''} would copy long stretches of the "
                            f"corpus ({long} characters or more; demos/README.md), which a pre-cache may not "
                            "redistribute:\n  " + "\n  ".join(refused))
        if misshapen:
            problems.append("files not in the shape the export writes, which check_content would refuse:\n  "
                            + "\n  ".join(misshapen))
        if flagged and not allow_private:
            problems.append("the pre-cache would carry what may be private:\n  " + "\n  ".join(flagged[:40])
                            + ("\n  …" if len(flagged) > 40 else "")
                            + "\n--scrub-user writes `user` in place of the user name; --allow-private keeps the rest")
        if problems:
            raise DemoError("nothing was written: " + "\n".join(problems))
        (stage / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", "utf-8")
        (stage / README).write_text(readme(manifest), "utf-8")
        out.parent.mkdir(parents=True, exist_ok=True)
        new = out.parent / f".{out.name}.new-{secrets.token_hex(4)}"
        try:
            shutil.copytree(stage, new)
        except BaseException:
            shutil.rmtree(new, ignore_errors=True)
            raise
        _swap_in(new, out)
    return manifest


def _swap_in(new: Path, out: Path) -> None:
    """Put the folder `new` (beside `out`) in place of `out`, which an earlier export may hold; `new` is removed when
    that fails."""
    old = out.parent / f".{out.name}.old-{secrets.token_hex(4)}"
    try:
        if out.exists():
            out.rename(old)
        new.rename(out)
    except BaseException:
        shutil.rmtree(new, ignore_errors=True)
        if old.exists() and not out.exists():
            old.rename(out)
        raise
    shutil.rmtree(old, ignore_errors=True)


# --------------------------------------------------------------------------- the full export


# What a full export leaves out, by the first part of the path in the workspace: what thimble rebuilds, or what belongs
# to this machine and the processes that ran there.
FULL_LEFT_OUT = {
    TRUSTED: TRUSTED_WHY,
    "scratch": "the kernels' mirror of the corpus, rebuilt",
    "kernels": "kernel state",
    "view-indexes": "views' indexes of the corpus, rebuilt",
    "sessions.json": "this machine's Claude Code sessions",
    "bg-sessions.json": "an earlier version's background sessions",
    "bg": "the agent tray's instructions, written again",
    "held-events.json": "per session",
    "unheard.json": "per session",
    "telemetry.jsonl": "the browser's telemetry",
}
FULL_SKIPPED_PARTS = {"__pycache__": "compiled Python", "cache": "a cache, rebuilt", "tmp": "a temporary file",
                      ".claude": "Claude Code's settings for one session, written again when it starts"}
FULL_SKIPPED_SUFFIXES = (".sqlite", ".sqlite-wal", ".sqlite-shm", ".lock", ".pyc")
SECRET_KEY_RE = re.compile(r"key|token|secret|password|credential", re.I)
# what install takes out of a chat's meta in a full export: the process that ran it, and the session attached to main
FULL_META_DROPPED = (*PROCESS_FIELDS, "attached")
LIVE = ("running", "working", "starting", "queued", "pending")  # a chat's statuses while its session runs
# the files of a transcript's folder (tool outputs Claude Code saved, subagents, workflows) read as text
TRANSCRIPT_TEXT = (".jsonl", ".json", ".txt", ".md", ".js", ".mjs", ".py", ".html", ".css", ".csv", ".log")
# the role of a session thimble ran in the workspace, by the first part of its folder there
SESSION_ROLES = {"orient": "orientation", "critique": "critic", "writers": "writer", "views-work": "view build"}
# what the inventory counts apart, by the first part of a path in the workspace
OUTPUT_KINDS = {"notebooks": "cards", "investigations": "documents", "concepts": "labels", "labels": "labels",
                "extension": "views", "views": "views", "chats": "chats", "calls": "calls", "orient": "work files",
                "critique": "work files", "writers": "work files", "views-work": "work files",
                "card-checks": "card checks"}


def full_kept(rel: Path) -> str | None:
    """None when a full export keeps the workspace file `rel` (relative to the workspace), else why it is left out."""
    top = rel.parts[0]
    if top in FULL_LEFT_OUT:
        return FULL_LEFT_OUT[top]
    for part in rel.parts[:-1]:
        if part in FULL_SKIPPED_PARTS:
            return FULL_SKIPPED_PARTS[part]
    if rel.name.endswith(FULL_SKIPPED_SUFFIXES):
        return "an index or lock thimble rebuilds"
    return None


def kind_of(path: str) -> str:
    """What the inventory counts a path of a full export under: `transcripts`, or OUTPUT_KINDS of its workspace path."""
    if path.startswith(f"{TRANSCRIPTS}/"):
        return "transcripts"
    return OUTPUT_KINDS.get(path.removeprefix(f"{WORKSPACE}/").split("/", 1)[0], "other")


def secrets_out(data: bytes) -> bytes:
    """A settings file without the keys that name a secret."""
    try:
        obj = json.loads(data)
    except ValueError:
        return data
    if not isinstance(obj, dict):
        return data
    return _dump({k: v for k, v in obj.items() if not SECRET_KEY_RE.search(k)})


def chat_meta(data: bytes) -> tuple[bytes, bool]:
    """A chat's meta without FULL_META_DROPPED, and a status that says it runs written `done`, since nothing runs in an
    installed export (a `stopped` card offers a Resume with no run to resume); and whether it said so."""
    try:
        meta = json.loads(data)
    except ValueError:
        return data, False
    if not isinstance(meta, dict):
        return data, False
    for k in FULL_META_DROPPED:
        meta.pop(k, None)
    live = meta.get("status") in LIVE
    if live:
        meta["status"] = "done"
    return _dump(meta), live


def main_chat(data: bytes) -> tuple[bytes, list[str]]:
    """Main's chat without the slash commands typed in it (/exit, /thimble), and the other messages typed, for the
    inventory."""
    kept_lines, typed = [], []
    for line in data.decode("utf-8", "replace").split("\n"):
        try:
            rec = json.loads(line) if line.strip() else None
        except ValueError:
            rec = None
        if isinstance(rec, dict) and rec.get("type") == "user" and not rec.get("event"):
            text = str(rec.get("text") or "")
            if text.strip().startswith("/"):
                continue
            typed.append(text[:120])
        kept_lines.append(line)
    return "\n".join(kept_lines).encode("utf-8"), typed


def claude_config_dir() -> Path:
    """The config folder of the Claude Code this command's user runs: CLAUDE_CONFIG_DIR, else ~/.claude."""
    return config.config_dir_of(config.own_claude_config()).expanduser()


def _transcript_cwd(path: Path) -> str:
    """The folder the session of transcript `path` ran in, from the first record that names one; '' when none does."""
    try:
        with path.open("rb") as f:
            for i, line in enumerate(f):
                if i >= 2000:
                    break
                if b'"cwd"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict) and isinstance(rec.get("cwd"), str):
                    return rec["cwd"]
    except OSError:
        pass
    return ""


def session_transcripts(ws: Path, claude_dir: Path) -> list[tuple[str, Path, str]]:
    """The Claude Code transcripts of the sessions that ran in workspace folder `ws` or a folder inside it (thimble's
    agents: the orientation in orient/work, its critic, the writers, view builds), as (session id, the transcript, its
    folder relative to `ws`), by folder and session. Main ran in the corpus's folder, so its session is not one."""
    roots = sorted({str(ws), str(ws.resolve())})
    prefixes = {projects_folder(r)[:200] for r in roots}
    out = []
    try:
        folders = [d for d in (claude_dir / "projects").iterdir() if d.is_dir() and d.name.startswith(tuple(prefixes))]
    except OSError:
        return []
    for d in folders:
        for t in sorted(d.glob("*.jsonl")):
            cwd = _transcript_cwd(t)
            for r in roots:
                if cwd == r or cwd.startswith(r + "/"):
                    out.append((t.stem, t, cwd[len(r):].strip("/")))
                    break
    return sorted(out, key=lambda x: (x[2], x[0]))


def session_role(folder: str) -> str:
    return SESSION_ROLES.get(folder.split("/", 1)[0], "other")


# the role a chat of thimble's agents (route subagent) names its transcript by, by the chat's role; a view's reviewer has
# the builder's chat role and `review` set (SUBAGENT_REVIEW)
SUBAGENT_ROLES = {"orient": "orientation", "writer": "writer", "step": "critic", "dev": "view build",
                  "check": "report check"}
SUBAGENT_REVIEW = "view review"


def _main_folders(claude_dir: Path, sid: str) -> list[Path]:
    """The folders beside main's transcript `<sid>.jsonl` under Claude Code's projects where its subagents' transcripts
    are, `<sid>/subagents`."""
    try:
        return [p.parent / sid / "subagents" for p in (claude_dir / "projects").glob(f"*/{sid}.jsonl")]
    except OSError:
        return []


def subagent_transcripts(ws: Path, claude_dir: Path) -> list[tuple[str, list[Path], str]]:
    """The transcripts of thimble's agents that ran as subagents of main in workspace folder `ws` (a chat with `route:
    subagent` and an agent id), as (agent id, its files in order, its role), each followed by its descendants' (found
    by `parentAgentId` in their meta json, role `other`). An agent's records live under main's session folder,
    `<main sid>/subagents/agent-<id>.jsonl`, and after /clear or /resume they go on in the new session's folder (U1),
    so an agent can have one file per session it ran under, oldest first."""
    out: list[tuple[str, list[Path], str]] = []
    seen: set[str] = set()
    for meta_path in sorted((ws / "chats").glob("*.meta.json")) if (ws / "chats").is_dir() else []:
        meta = _read_json(meta_path)
        if not isinstance(meta, dict) or meta.get("route") != "subagent" or not meta.get("agent_id"):
            continue
        agent = str(meta["agent_id"])
        if agent in seen or meta.get("role") not in SUBAGENT_ROLES:
            continue
        seen.add(agent)
        sessions = [str(x) for x in (meta.get("sessions") or [meta.get("session")]) if x]
        folders = [f for sid in dict.fromkeys(sessions) for f in _main_folders(claude_dir, sid)]
        own = [f / f"agent-{agent}.jsonl" for f in folders if (f / f"agent-{agent}.jsonl").is_file()]
        if not own:
            continue
        out.append((agent, own, SUBAGENT_REVIEW if meta.get("review") else SUBAGENT_ROLES[str(meta["role"])]))
        mine, metas = {agent}, {}
        for f in folders:
            for mp in sorted(f.glob("agent-*.meta.json")):
                aid = mp.name[len("agent-"):-len(".meta.json")]
                m = _read_json(mp)
                if aid not in mine and isinstance(m, dict):
                    metas.setdefault(aid, (m, []))[1].append(mp.with_name(f"agent-{aid}.jsonl"))
        grew = True
        while grew:
            grew = False
            for aid, (m, paths) in metas.items():
                if aid not in mine and str(m.get("parentAgentId") or "") in mine:
                    mine.add(aid)
                    grew = True
        for aid, (_m, paths) in metas.items():
            if aid in mine and aid not in seen:
                seen.add(aid)
                files = [p for p in paths if p.is_file()]
                if files:
                    out.append((aid, files, "other"))
    return out


def export_full(ws: Path, corpus: Path, out: Path, *, name: str, home: Path | None = None, user: str | None = None,
                scrub_user: bool = False, app: Path | None = None, claude_dir: Path | None = None,
                scan: Callable[[Path], list[str] | None] = gitleaks_scan,
                index: demo_verbatim.Corpus | None = None, view: str | None = None) -> dict[str, Any]:
    """Write the full export (version FULL_VERSION, module note) of workspace folder `ws`, made on corpus folder
    `corpus`, as the folder `out` (replacing an export there), with the transcripts of its sessions from `claude_dir`
    (claude_config_dir()); the manifest, whose `inventory` says what it holds. It refuses nothing for its content;
    DemoError only when `out` holds files that are not an export's, or when `view` (the view the workspace opens on)
    is none of the workspace's. `scrub_user` writes SCRUBBED_USER in place of the user name where it stands as a
    word."""
    check_view(ws, view)
    home = home or Path.home()
    user = getpass.getuser() if user is None else user
    claude_dir = claude_dir or claude_config_dir()
    if out.exists() and any(out.iterdir()) and not (out / MANIFEST).is_file():
        raise DemoError(f"{out} holds files that are not an export; choose another folder")
    run = _read_json(ws / "orient" / "run.json")
    run = run if isinstance(run, dict) else {}
    chat = orient_chat(run)
    pairs = placeholder_pairs(ws, corpus, home, app or config.REPO_ROOT)
    user_re = re.compile(rf"(?<![\w]){re.escape(user)}(?![\w])") if user and len(user) >= 3 else None
    corpus_index = index or demo_verbatim.Corpus(corpus)
    state: dict[str, Any] = {"scrubbed": 0, "user_files": 0, "paths": set(), "flagged": [], "text": 0}
    shared: dict[str, dict[str, int]] = {}  # kind -> {chars, longest, files, long_files}
    longest: list[dict[str, Any]] = []
    sizes: dict[str, int] = {}
    files_n: dict[str, int] = {}
    left: list[dict[str, Any]] = []
    typed: list[str] = []
    stopped: list[str] = []
    tally = {"chats": 0, "chat_records": 0, "calls": 0, "call_logs": 0, "label_rows": 0, "rationales": 0, "spans": 0}

    def scrub(path: str, text: str) -> str:
        text = with_placeholders(text, pairs)
        if scrub_user and user_re is not None:
            text, n = user_re.subn(SCRUBBED_USER, text)
            state["scrubbed"] += n
        found = findings(text, user)
        if found:
            state["flagged"].extend(f"{path}: {f}" for f in found)
            state["user_files"] += any(f.startswith("the user name") for f in found)
            state["paths"].update(f for f in found if not f.startswith("the user name"))
        return text

    def measure(path: str, text: str) -> None:
        state["text"] += len(text)
        got = demo_verbatim.scan(corpus_index, path, text)
        if not got.shared:
            return
        k = shared.setdefault(kind_of(path), {"chars": 0, "longest": 0, "files": 0, "long_files": 0})
        k["chars"] += got.shared
        k["longest"] = max(k["longest"], got.longest)
        k["files"] += 1
        k["long_files"] += bool(got.long_runs)
        longest.append({"path": path, "chars": got.longest, "shared": got.shared})

    def write(stage: Path, path: str, body: bytes) -> dict[str, Any]:
        dest = stage / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
        k = kind_of(path)
        sizes[k] = sizes.get(k, 0) + len(body)
        files_n[k] = files_n.get(k, 0) + 1
        return {"path": path.split("/", 1)[1] if path.startswith(f"{WORKSPACE}/") else path, "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest()}

    def tally_file(rel: Path, text: str) -> None:
        top = rel.parts[0]
        if top == "chats" and rel.name.endswith(".meta.json"):
            tally["chats"] += 1
        elif top == "chats" and rel.name.endswith(".jsonl"):
            tally["chat_records"] += sum(1 for x in text.split("\n") if x.strip())
        elif top in ("calls", "labels") and rel.name.endswith(".jsonl"):
            rows = [r for r in (_json_line(x) for x in text.split("\n")) if isinstance(r, dict)]
            if top == "calls":
                tally["call_logs"] += 1
                tally["calls"] += sum(1 for r in rows if "result" in r)
            else:
                rows = [r for r in rows if "ref" in r]
                tally["label_rows"] += len(rows)
                tally["rationales"] += sum(1 for r in rows if r.get("rationale"))
                tally["spans"] += sum(1 for r in rows if r.get("spans"))

    out.parent.mkdir(parents=True, exist_ok=True)
    stage = out.parent / f".{out.name}.new-{secrets.token_hex(4)}"
    try:
        files: list[dict[str, Any]] = []
        for p in sorted(ws.rglob("*")):
            if not p.is_file() or p.is_symlink():
                continue
            rel = p.relative_to(ws)
            s = rel.as_posix()
            why = full_kept(rel)
            if why:
                left.append({"path": s, "bytes": p.stat().st_size, "why": why})
                continue
            data = p.read_bytes()
            if s in ("settings.json", "config.json"):
                data = secrets_out(data)
            elif s == "orient/run.json":
                data = _without(data, ("pid", "agent_id"))
            elif s == "chats/main.jsonl":
                data, typed = main_chat(data)
            elif rel.parts[0] == "chats" and rel.name.endswith(".meta.json"):
                data, live = chat_meta(data)
                if live:
                    stopped.append(rel.name[: -len(".meta.json")])
            path = f"{WORKSPACE}/{s}"
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                files.append(write(stage, path, data))  # a picture, a parquet file: kept as it is
                continue
            text = scrub(path, text)
            tally_file(rel, text)
            measure(path, text)
            files.append(write(stage, path, text.encode("utf-8")))
        transcripts: list[dict[str, Any]] = []
        for sid, found, folder in session_transcripts(ws, claude_dir):
            path = f"{TRANSCRIPTS}/{sid}.jsonl"
            data, stats = clean_transcript(found.read_bytes())
            text = scrub(path, data.decode("utf-8"))
            measure(path, text)
            entry = {"session": sid, "role": session_role(folder), "folder": folder, "path": path,
                     **{k: v for k, v in write(stage, path, text.encode("utf-8")).items() if k != "path"}, **stats,
                     "files": []}
            side = found.parent / sid  # what Claude Code keeps beside the transcript: tool outputs, subagents
            for q in sorted(side.rglob("*")) if side.is_dir() else []:
                if not q.is_file() or q.is_symlink():
                    continue
                qpath = f"{TRANSCRIPTS}/{sid}/{q.relative_to(side).as_posix()}"
                body = q.read_bytes()
                if q.suffix.lower() == ".jsonl":
                    body, more = clean_transcript(body)
                    for k, n in more["dropped"].items():
                        entry["dropped"][k] = entry["dropped"].get(k, 0) + n
                if q.suffix.lower() in TRANSCRIPT_TEXT:
                    try:
                        qtext = scrub(qpath, body.decode("utf-8"))
                        measure(qpath, qtext)
                        body = qtext.encode("utf-8")
                    except UnicodeDecodeError:
                        pass
                entry["files"].append(write(stage, qpath, body))
            transcripts.append(entry)
        for agent, parts, role in subagent_transcripts(ws, claude_dir):
            path = f"{TRANSCRIPTS}/agent-{agent}.jsonl"
            body, stats = b"", {"kept": 0, "dropped": {}, "unreadable": 0}
            for part in parts:  # one file per session it ran under, in order (U1)
                data, more = clean_transcript(part.read_bytes())
                body += data
                stats["kept"] += int(more.get("kept") or 0)
                stats["unreadable"] += int(more.get("unreadable") or 0)
                for k, n in (more.get("dropped") or {}).items():
                    stats["dropped"][k] = stats["dropped"].get(k, 0) + n
            text = scrub(path, body.decode("utf-8"))
            measure(path, text)
            transcripts.append({"agent": agent, "session": "", "role": role, "folder": "", "path": path,
                                **{k: v for k, v in write(stage, path, text.encode("utf-8")).items() if k != "path"},
                                **stats, "files": []})
        leaks = scan(stage)
        meta = chat_summary(ws, chat)
        dropped = sum(n for t in transcripts for n in t["dropped"].values())
        manifest: dict[str, Any] = {
            "schema": SCHEMA, "version": FULL_VERSION, "format": "full", "dataset": name,
            **({"view": view} if view else {}), "created": now(),
            "notice": DATASETS[name].notice if name in DATASETS else "",
            "credit": DATASETS[name].credit if name in DATASETS else "",
            "thimble": {"version": _thimble_version(), "commit": _commit()},
            "orientation": {k: run.get(k) for k in ("status", "passes", "query", "effort", "ultracode", "critique",
                                                    "started", "ended")}
                           | {"model": meta.get("model"), "chat_effort": meta.get("effort"), "chat": chat},
            "counts": counts(ws),
            "corpus": corpus_files(corpus),
            "placeholders": PLACEHOLDERS,
            "files": files,
            "transcripts": transcripts,
            "inventory": {
                "bytes": dict(sorted(sizes.items())), "files": dict(sorted(files_n.items())), **tally,
                "typed_in_main": len(typed), "marked_done": stopped,
                "sessions": {r: n for r in dict.fromkeys((*SESSION_ROLES.values(), *SUBAGENT_ROLES.values(),
                                                          SUBAGENT_REVIEW, "other"))
                             if (n := sum(1 for t in transcripts if t["role"] == r))},
                "transcript_records": sum(int(t.get("kept") or 0) for t in transcripts),
                "dropped_records": dropped,
                "left_out_bytes": sum(int(f["bytes"]) for f in left),
                "user_name_files": state["user_files"],
                "paths": sorted(state["paths"])[:10],
                "gitleaks": None if leaks is None else leaks[:20],
            },
            "verbatim": {"window": demo_verbatim.WINDOW, "stride": demo_verbatim.STRIDE, "long": demo_verbatim.LONG,
                         "text": state["text"], "shared": sum(k["chars"] for k in shared.values()),
                         "by_kind": dict(sorted(shared.items())),
                         "longest": sorted(longest, key=lambda f: -f["chars"])[:20]},
            "left_out": left,
            "gitleaks": "not installed" if leaks is None else f"{len(leaks)} findings",
            "user_name_scrubbed": state["scrubbed"],
            "flagged": state["flagged"][:200],
        }
        (stage / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", "utf-8")
        (stage / README).write_text(readme(manifest), "utf-8")
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    _swap_in(stage, out)
    return manifest


def _json_line(line: str) -> Any:
    try:
        return json.loads(line) if line.strip() else None
    except ValueError:
        return None


def _share(n: int, of: int) -> str:
    return f"{100 * n / of:.0f}%" if of else "0%"


def characters(n: int) -> str:
    """A count of characters in a few words: `840 characters`, `52 thousand characters`, `4.1 million characters`."""
    if n < 10_000:
        return f"{n:,} characters"
    return f"{n / 1000:.0f} thousand characters" if n < 1_000_000 else f"{n / 1_000_000:.1f} million characters"


def inventory_lines(m: dict[str, Any], folder: Path, size: int) -> list[str]:
    """What an export wrote, in plain lines: its size, each kind of thing it holds with its size, how much of the
    dataset's text it holds, what may be private, and what it left out."""
    c, v = m.get("counts") or {}, m.get("verbatim") or {}
    full = m.get("version") in FULL_VERSIONS
    out = [f"wrote {folder} ({human(size)}), " + ("a full export: everything the workspace holds but what thimble "
                                                   "rebuilds" if full else "the orientation's outputs alone")]
    rows: list[tuple[str, str]] = []
    if full:
        inv = m.get("inventory") or {}
        b = inv.get("bytes") or {}
        sessions = inv.get("sessions") or {}
        trs = m.get("transcripts") or []
        rows.append(("transcripts", (f"{plural(len(trs), 'Claude Code session')} ("
                                     + ", ".join(f"{plural(n, r)}" for r, n in sessions.items()) + "), "
                                     f"{inv.get('transcript_records', 0):,} records, {human(b.get('transcripts', 0))}; "
                                     f"{inv.get('dropped_records', 0):,} records Claude Code added about your machine "
                                     "and account (CLAUDE.md files, email, organization, skills, environment, system "
                                     "prompt) left out")
                     if trs else "none: no Claude Code transcript of a session in the workspace was found"))
        typed = int(inv.get("typed_in_main") or 0)
        rows.append(("chats", f"{plural(inv.get('chats', 0), 'thread')} with every message, "
                              f"{inv.get('chat_records', 0):,} records, {human(b.get('chats', 0))}; main's chat keeps "
                              + (f"{plural(typed, 'message')} you typed" if typed else "no message you typed")))
        rows.append(("call outputs", f"{inv.get('calls', 0):,} calls with their whole outputs, in "
                                     f"{plural(inv.get('call_logs', 0), 'log')}, {human(b.get('calls', 0))}"))
        rows.append(("labels", f"{plural(c.get('labels', 0), 'label')}, {inv.get('label_rows', 0):,} rows, "
                               f"{inv.get('rationales', 0):,} with the labeler's rationale and "
                               f"{inv.get('spans', 0):,} with the texts it marked, {human(b.get('labels', 0))}"))
        rows.append(("outputs", f"{plural(c.get('cards', 0), 'card')}, {plural(c.get('documents', 0), 'document')}, "
                                f"{plural(c.get('views', 0), 'view')}, "
                                f"{human(b.get('cards', 0) + b.get('documents', 0) + b.get('views', 0))}"))
        rows.append(("work files", f"the orientation's and the agents' folders, {human(b.get('work files', 0))}"
                                   + (f"; card checks {human(b['card checks'])}" if b.get("card checks") else "")))
        by = v.get("by_kind") or {}
        top = sorted(by.items(), key=lambda kv: -kv[1]["chars"])[:3]
        rows.append(("dataset text", (f"about {characters(int(v.get('shared', 0)))} copied from the dataset "
                                      f"({_share(int(v.get('shared', 0)), int(v.get('text') or 0))} of the export's "
                                      "text), most in " + ", ".join(f"{k} ({characters(x['chars'])})" for k, x in top)
                                      + f"; the longest stretch {(v.get('longest') or [{}])[0].get('chars', 0):,} "
                                      "characters") if v.get("shared") else "none found"))
        private = []
        if inv.get("user_name_files"):
            private.append(f"your user name in {plural(inv['user_name_files'], 'file')} (--scrub-user replaces it)")
        if inv.get("paths"):
            private.append("absolute paths such as " + ", ".join(inv["paths"][:3]))
        leaks = inv.get("gitleaks")
        private.append("gitleaks not installed" if leaks is None else
                       f"gitleaks: {plural(len(leaks), 'finding')}" + (f" ({'; '.join(leaks[:3])})" if leaks else ""))
        rows.append(("may be private", "; ".join(private)))
        if inv.get("marked_done"):
            rows.append(("still running", f"{plural(len(inv['marked_done']), 'chat')} said it ran and is written done: "
                                          + ", ".join(inv["marked_done"][:5])))
    else:
        longest = (v.get("longest") or [{"chars": 0}])[0]
        rows.append(("outputs", f"{plural(c.get('cards', 0), 'card')}, {plural(c.get('labels', 0), 'label')} (values "
                                "by record ref with the labeler's rationale, no texts marked), "
                                f"{plural(c.get('views', 0), 'view')} (code alone), "
                                f"{plural(c.get('documents', 0), 'document')}"))
        rows.append(("call outputs",
                     f"{plural(len(m.get('cited_calls') or []), 'cited call')}, each cut to an excerpt"))
        rows.append(("transcripts", "none; no conversation either"))
        rows.append(("dataset text", f"the longest stretch shared with the dataset {longest.get('chars', 0):,} "
                                     f"characters (refused from {v.get('long', '?')})"))
        flagged = len(m.get("flagged") or [])
        rows.append(("may be private", (f"{plural(flagged, 'finding')} kept with --allow-private (the manifest's "
                                        "`flagged` lists them)" if flagged else "no user name or absolute path")
                                       + f"; gitleaks: {m.get('gitleaks')}"))
    left = m.get("left_out") or []
    reasons: dict[str, int] = {}
    for f in left:
        reasons[str(f.get("why"))] = reasons.get(str(f.get("why")), 0) + 1
    common = "; ".join(r for r, _ in sorted(reasons.items(), key=lambda kv: -kv[1])[:3])
    rows.append(("left out", f"{plural(len(left), 'file')}, {human(sum(int(f.get('bytes') or 0) for f in left))}"
                             + (f": {common}" if common else "") + " (the manifest lists each)"))
    width = max(len(k) for k, _ in rows)
    for k, text in rows:  # wrapped under the column of values
        out += textwrap.wrap(text, 108, initial_indent=f"  {k.ljust(width)}  ", subsequent_indent=" " * (width + 4),
                             break_long_words=False, break_on_hyphens=False)
    return out


def made_with(o: dict[str, Any]) -> str:
    """The orientation's model and effort in a few words: `claude-opus-5-5, Ultracode, no prompt`."""
    return ", ".join(x for x in (str(o.get("model") or "").replace("[1m]", ""),
                                 "Ultracode" if o.get("ultracode") else str(o.get("effort") or ""),
                                 "no prompt" if not o.get("query") else "") if x)


def _sure(v: dict[str, Any]) -> Any:
    """The length from which the export finds every shared stretch (demo_verbatim module note), '?' when unknown."""
    try:
        return int(v["long"]) + 2 * (int(v["stride"]) - 1)
    except (KeyError, TypeError, ValueError):
        return "?"


def readme_full(m: dict[str, Any]) -> str:
    """A full export's README.md: the source's notice first, then what the folder holds (inventory_lines), and that it
    holds the dataset's text."""
    o, t = m.get("orientation") or {}, m.get("thimble") or {}
    lines = []
    if m.get("notice"):
        lines += [f"> Notice from the source: {m['notice']}", ""]
    lines += [f"# {m['dataset']}: full export", "",
              "`thimble demo --export` wrote this folder from a thimble workspace: everything it holds but what "
              "thimble rebuilds, with the Claude Code transcripts of the sessions thimble ran in it. `thimble demo "
              f"{m['dataset']} --precaches <the folder above this one>` installs it, and a message in the "
              "orientation's thread continues the orientation's session.", "",
              "It holds the dataset's own text, which the transcripts and the call outputs quote: share it only where "
              "you may share the dataset.", ""]
    if m.get("credit"):
        lines += [f"The data: {m['credit']}", ""]
    size = sum(int(f.get("bytes") or 0) for f in m.get("files") or []) + sum(
        int(x.get("bytes") or 0) + sum(int(f.get("bytes") or 0) for f in x.get("files") or [])
        for x in m.get("transcripts") or [])
    lines += [f"Made {str(m.get('created') or '')[:10]} with thimble {t.get('version') or '?'} "
              f"({t.get('commit') or '?'}): {made_with(o)}; outputs {', '.join(o.get('passes') or []) or 'none'}"
              f"{', critique on' if o.get('critique') else ''}.", "", "```",
              *inventory_lines(m, Path(str(m["dataset"])), size), "```", "",
              "Absolute paths are written as " + ", ".join(f"`{x}`" for x in PLACEHOLDERS.values())
              + " (and as `@@THIMBLE_DASHED_…@@` where a path is spelled with dashes), filled in on install.", ""]
    return "\n".join(lines)


def opens_on(m: dict[str, Any]) -> str:
    """The view a manifest names for its workspace to open on, as the README names it: `Name (`slug`)`, by the name the
    manifest's `views` gives it, else the slug alone."""
    slug = str(m.get("view") or "")
    name = next((str(x.get("name")) for x in m.get("views") or [] if isinstance(x, dict) and x.get("slug") == slug
                 and x.get("name")), "")
    return f"{name} (`{slug}`)" if name else f"`{slug}`"


def readme(m: dict[str, Any]) -> str:
    """The pre-cache folder's README.md: the source's notice first, then what the folder holds and how it was made."""
    if m.get("version") in FULL_VERSIONS:
        return readme_full(m)
    c, o, t = m.get("counts") or {}, m.get("orientation") or {}, m.get("thimble") or {}
    v = m.get("verbatim") or {}
    lines = []
    if m.get("notice"):
        lines += [f"> Notice from the source: {m['notice']}", ""]
    lines += [f"# {m['dataset']}: pre-cached orientation", "",
              f"`thimble demo {m['dataset']}` downloads the dataset from its publisher and installs this folder as its "
              "workspace, so thimble opens on the orientation's cards, labels, views and documents."
              + (f" The workspace opens on its view {opens_on(m)}." if m.get("view") else "")
              + " The orientation's Claude Code session is not here: a session the analyst attaches starts fresh, with "
              "the canvas and the report as its context.", ""]
    if m.get("credit"):
        lines += [f"The data: {m['credit']}", ""]
    longest = (v.get("longest") or [{}])[0]
    lines += [f"- Made {str(m.get('created') or '')[:10]} with thimble {t.get('version') or '?'} "
              f"({t.get('commit') or '?'}): {made_with(o)}; outputs {', '.join(o.get('passes') or []) or 'none'}"
              f"{', critique on' if o.get('critique') else ''}.",
              f"- It holds {plural(c.get('cards', 0), 'card')}, {plural(c.get('labels', 0), 'label')}, "
              f"{plural(c.get('views', 0), 'view')} and {plural(c.get('documents', 0), 'document')}, and "
              f"{plural(len(m.get('cited_calls') or []), 'call')} the report or a card cites, each cut to an excerpt.",
              f"- `{WORKSPACE}/`: {len(m.get('files') or [])} files of the workspace. `{MANIFEST}` lists each with its "
              f"SHA-256, and the {len(m.get('left_out') or [])} files left out with the reason for each.",
              f"- The export measured no stretch of {v.get('long', '?')} characters or more that a file shares with the "
              f"dataset (it finds every stretch of {_sure(v)} or more); the longest it measured is "
              f"{longest.get('chars', 0)} characters" + (f" (`{longest['path']}`)." if longest.get("path") else "."),
              *([f"- The orientation's coverage line, which install puts at the end of its thread: {o['coverage']}"]
                if o.get("coverage") else []),
              *([f"- The views are reviewed versions put in place of the orientation's own after the export "
                 "(scripts/sync_demo_views.sh), each stamped with the digest of its files so it shows at once: "
                 + ", ".join(f"{x.get('name')} (`{x.get('slug')}`, from `{x.get('from')}`)" for x in m["views"]) + "."]
                if m.get("views") else []),
              "- Absolute paths are written as " + ", ".join(f"`{x}`" for x in PLACEHOLDERS.values())
              + " (and as `@@THIMBLE_DASHED_…@@` where a path is spelled with dashes), filled in on install.", "",
              "demos/README.md says how a pre-cache is made and checked.", ""]
    return "\n".join(lines)


def _thimble_version() -> str:
    try:
        text = (config.REPO_ROOT / "backend" / "pyproject.toml").read_text("utf-8")
        m = re.search(r'^version = "([^"]+)"', text, re.M)
        return m.group(1) if m else ""
    except OSError:
        return ""


def _commit() -> str:
    rel = _read_json(config.REPO_ROOT / "RELEASE.json")
    if isinstance(rel, dict) and rel.get("commit"):
        return str(rel["commit"])
    try:
        return subprocess.run(["git", "-C", str(config.REPO_ROOT), "rev-parse", "--short", "HEAD"], capture_output=True,
                              text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


# --------------------------------------------------------------------------- the pre-cache: install


def read_manifest(src: Path) -> dict[str, Any]:
    m = _read_json(src / MANIFEST)
    if not isinstance(m, dict):
        raise DemoError(f"{src} is not a thimble demo pre-cache ({MANIFEST} missing or unreadable)")
    if m.get("schema") != SCHEMA or m.get("version") not in (VERSION, *FULL_VERSIONS):
        raise DemoError(f"a pre-cache of another format ({m.get('schema')} v{m.get('version')}); "
                        "`thimble update` brings a thimble that reads it")
    return m


def corpus_mismatches(manifest: dict[str, Any], corpus: Path) -> list[str]:
    out = []
    for f in manifest.get("corpus") or []:
        p = corpus / f["path"]
        if not p.is_file():
            out.append(f"{f['path']} is missing")
        elif file_sha256(p) != f["sha256"]:
            out.append(f"{f['path']} differs from the file the orientation read")
    return out


def holds_work(ws: Path) -> bool:
    """Whether a workspace folder holds an analysis: cards, labels, documents or chats with records."""
    if any((ws / "notebooks").glob("*.json")) or any((ws / "concepts").glob("*.json")):
        return True
    if any(p.stat().st_size for p in (ws / "chats").glob("*.jsonl")):
        return True
    return any(p.name != "investigation.json" for p in (ws / "investigations" / "main").glob("*.json"))


CHAT_META_RE = re.compile(r"^chats/[^/]+\.meta\.json$")


def _without(data: bytes, keys: "tuple[str, ...]") -> bytes:
    """A JSON object's bytes without `keys`; `data` itself when it is no object or has none of them."""
    try:
        obj = json.loads(data)
    except ValueError:
        return data
    if not isinstance(obj, dict) or not any(k in obj for k in keys):
        return data
    return json.dumps({k: v for k, v in obj.items() if k not in keys}, ensure_ascii=False, indent=1).encode()


def install(src: Path, ws: Path, corpus: Path, *, home: Path | None = None,
            claude_dir: Path | None = None) -> dict[str, Any]:
    """Install the export folder `src` as the workspace folder `ws` (which must not exist), its placeholders filled with
    `ws`, `corpus` and the home folder, and marked pre-cached (MARKER, and `precached` in the orientation's record and
    its thread's meta); the manifest, with `warnings` for corpus files that differ and transcripts that could not be
    placed. A full export's transcripts go where Claude Code in `claude_dir` (claude_config_dir()) resumes them, each
    under a new session id that the workspace's files name in place of the old one (`installed_transcripts`); when the
    orientation's is among them the mark says `kept`, and its record keeps its session, so a follow-up resumes it. The
    mark's `view` is the manifest's when the pre-cache holds that view (opening_view), else None."""
    home = home or Path.home()
    values = {"workspace": str(ws), "corpus": str(corpus), "app": str(config.REPO_ROOT),
              "thimble_home": str(thimble_home()), "home": str(home)}
    if ws.exists():
        raise DemoError(f"{ws} exists")
    manifest = read_manifest(src)
    full = manifest.get("version") in FULL_VERSIONS
    names = [str(f.get("path") or "") for f in manifest.get("files") or [] if isinstance(f, dict)]
    trs = [t for t in manifest.get("transcripts") or [] if isinstance(t, dict)] if full else []
    names = [n for n in names if n.split("/", 1)[0] != TRUSTED]  # an export made while it was kept (TRUSTED_WHY)
    bad = [n for n in names if not n or not SAFE_NAME.match(n) or not (full or workspace_kind(n))]
    for t in trs:
        paths = [str(t.get("path") or ""), *(str(f.get("path") or "") for f in t.get("files") or []
                                             if isinstance(f, dict))]
        bad += [n for n in paths if not SAFE_NAME.match(n) or not n.startswith(f"{TRANSCRIPTS}/")]
        if t.get("folder") and not SAFE_NAME.match(str(t["folder"])):
            bad.append(str(t["folder"]))
    if bad:
        raise DemoError(f"the pre-cache holds paths it may not: {bad[:3]}")
    sids = {str(t["session"]): str(uuid.uuid4()) for t in trs
            if re.fullmatch(r"[A-Za-z0-9-]{8,64}", str(t.get("session") or ""))}
    claude_dir = claude_dir or claude_config_dir()

    def fill(rel: str, text: str) -> str:
        js = rel.endswith((".json", ".jsonl"))
        for key, ph in PLACEHOLDERS.items():
            if ph in text:
                text = text.replace(ph, json.dumps(values[key])[1:-1] if js else values[key])
            if DASHED[key] in text:
                text = text.replace(DASHED[key], dashed(values[key]))
        for old, new in sids.items():
            text = text.replace(old, new)
        return text

    def filled(rel: str, data: bytes) -> bytes:
        try:
            return fill(rel, data.decode("utf-8")).encode("utf-8")
        except UnicodeDecodeError:
            return data  # a picture, a parquet file

    ws.parent.mkdir(parents=True, exist_ok=True)
    tmp = ws.parent / f".{ws.name}.demo-{secrets.token_hex(4)}"
    placed: list[Path] = []
    warnings: list[str] = []
    installed: list[dict[str, Any]] = []
    try:
        for rel in names:
            p = src / WORKSPACE / rel
            if not p.is_file():
                raise DemoError(f"the pre-cache lacks {WORKSPACE}/{rel}, which its manifest lists")
            data = filled(rel, p.read_bytes())
            if CHAT_META_RE.match(rel):  # an export made while these were kept
                data = _without(data, FULL_META_DROPPED)
            dest = tmp / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        for t in trs:
            if t.get("agent"):  # a subagent of the session that ran it, which no new session continues (precached.py)
                continue
            p, old = src / str(t["path"]), str(t.get("session") or "")
            sid, folder = sids.get(old), str(t.get("folder") or "")
            if not sid or not p.is_file():
                warnings.append(f"the transcript {t.get('path')} is missing, so its session cannot continue")
                continue
            (tmp / folder).mkdir(parents=True, exist_ok=True)
            # Claude Code names the folder after the session's working directory as the system reports it, with
            # symlinks resolved
            cwd = ws.parent.resolve() / ws.name / folder if folder else ws.parent.resolve() / ws.name
            proj = claude_dir / "projects" / projects_folder(str(cwd))
            dest = proj / f"{sid}.jsonl"
            try:
                proj.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(filled(str(t["path"]), p.read_bytes()))
                placed.append(dest)
                side = f"{TRANSCRIPTS}/{old}/"
                for f in t.get("files") or []:
                    fp = str(f.get("path") or "") if isinstance(f, dict) else ""
                    q = src / fp
                    if not fp.startswith(side) or not q.is_file():
                        continue
                    d = proj / sid / fp[len(side):]
                    d.parent.mkdir(parents=True, exist_ok=True)
                    d.write_bytes(filled(fp, q.read_bytes()))
                    placed.append(d)
            except OSError as e:
                warnings.append(f"the transcript of {t.get('role') or 'a session'} could not be written to {dest} "
                                f"({e}), so it cannot continue")
                continue
            installed.append({"role": t.get("role"), "folder": folder, "session": sid, "path": str(dest)})
        run = _read_json(tmp / "orient" / "run.json")
        chat = orient_chat(run)
        kept = bool(isinstance(run, dict) and run.get("session")
                    and any(i["session"] == run["session"] for i in installed))
        o = manifest.get("orientation") or {}
        opens = opening_view(tmp, manifest.get("view"))
        if manifest.get("view") and not opens:
            warnings.append(f"the pre-cache opens on the view {manifest['view']}, which it does not hold, so the "
                            "workspace opens on Files")
        mark = {"dataset": manifest.get("dataset"), "created": manifest.get("created"), "installed": now(),
                "thimble": manifest.get("thimble"), "folder": str(corpus), "orientation": chat or None,
                "ran": o.get("ended") or o.get("started"), "model": o.get("model"),
                "format": "full" if full else "outputs-only", "kept": kept, "view": opens}
        (tmp / MARKER).write_text(json.dumps(mark, ensure_ascii=False, indent=1), "utf-8")
        if isinstance(run, dict):
            if not kept:
                run.pop("session", None)
            run["precached"] = mark
            (tmp / "orient" / "run.json").write_text(json.dumps(run, ensure_ascii=False, indent=2), "utf-8")
        meta_path = tmp / "chats" / f"{chat}.meta.json"
        meta = _read_json(meta_path) if chat else None
        if isinstance(meta, dict):
            if not kept:
                meta.pop("session", None)
            meta.update(status="done", precached=mark)
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
            log = tmp / "chats" / f"{chat}.jsonl"
            log.touch()
            line = coverage_line(o) if not full else None
            if line and not log.stat().st_size:  # the note a live run ends its thread with (orient_session)
                log.write_text(json.dumps({"type": "chip", "ts": o.get("ended") or now(), "kind": COVERAGE_CHIP,
                                           "text": line}, ensure_ascii=False) + "\n", "utf-8")
        from . import views  # noqa: PLC0415 — the views' module is the server's, loaded only here

        views.keep_installed(tmp)  # the pre-cache leaves out the views' kept versions, which readers need (read_built)
        tmp.rename(ws)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        for q in placed:
            q.unlink(missing_ok=True)
        raise
    manifest["warnings"] = corpus_mismatches(manifest, corpus) + warnings
    manifest["installed_transcripts"] = installed
    return manifest


# --------------------------------------------------------------------------- the pre-caches and downloads


def precaches(folder: Path) -> dict[str, dict[str, Any]]:
    """The pre-caches in `folder` (demos/ by default), by dataset: {path, bytes, made_with, full}."""
    out = {}
    for name in DATASETS:
        p = folder / name
        try:
            m = read_manifest(p)
        except DemoError:
            continue
        size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
        out[name] = {"path": p, "bytes": size, "made_with": made_with(m.get("orientation") or {}),
                     "full": m.get("version") in FULL_VERSIONS}
    return out


class Downloads:
    """Fetches with a cache in DIR/.downloads, so a second `thimble demo` downloads nothing again."""

    def __init__(self, root: Path, get: Callable[[str], bytes] = demo_data.http_get):
        self.root, self.get = root / ".downloads", get

    def path(self, url: str) -> Path:
        return self.root / hashlib.sha256(url.encode()).hexdigest()[:24]

    def __call__(self, url: str) -> bytes:
        p = self.path(url)
        if p.is_file():
            return p.read_bytes()
        try:
            data = self.get(url)
        except OSError as e:
            raise demo_data.SourceError(f"could not download {url}: {e}") from e
        self.root.mkdir(parents=True, exist_ok=True)
        part = p.with_name(p.name + ".part")
        part.write_bytes(data)
        part.replace(p)
        return data


def complete(ds: Dataset, folder: Path) -> bool:
    """Whether `folder` holds every file of `ds` as the demo pins it."""
    return folder.is_dir() and all((folder / f).is_file() and file_sha256(folder / f) == h for f, h in ds.expected.items())


def write_dataset(ds: Dataset, folder: Path, fetch: Callable[[str], bytes]) -> list[str]:
    """Build `ds` into `folder`, its files by their paths (which may name subfolders) and its empty folders; its
    warnings. A folder that holds exactly the expected files is left as it is; one that holds anything else stops."""
    if complete(ds, folder):
        for d in ds.folders:
            (folder / d).mkdir(parents=True, exist_ok=True)
        return []
    tops = {f.split("/", 1)[0] for f in ds.expected} | {d.split("/", 1)[0] for d in ds.folders}
    others = [p.name for p in folder.iterdir() if p.name not in tops and not p.name.startswith(".")] \
        if folder.is_dir() else []
    if others:
        raise DemoError(f"{folder} holds other files ({', '.join(sorted(others)[:3])}); choose another --dir")
    built = ds.build(fetch)
    folder.mkdir(parents=True, exist_ok=True)
    for fname, data in built.files.items():
        dest = folder / fname
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(f".{dest.name}.part")
        part.write_bytes(data)
        part.replace(dest)
    for d in ds.folders:
        (folder / d).mkdir(parents=True, exist_ok=True)
    return built.warnings


def sources_md(selected: list[Dataset]) -> str:
    lines = ["# thimble demo datasets", "",
             "thimble redistributes none of these datasets: `thimble demo` downloaded each folder here from its "
             "publisher and rebuilt it as described below. The collusion-wiki and mythos-5 transforms are adapted from "
             "MessageBoardAuditBench (https://github.com/hamzah2304/messageboardauditbench, MIT license).", ""]
    for d in selected:
        lines += [f"## {d.name}: {d.title}", "", d.about, ""]
        if d.credit:
            lines += [d.credit, ""]
        lines += [f"- Downloaded from: {', '.join(d.sources[:2])}"
                  + (f" and {len(d.sources) - 2} more pages" if len(d.sources) > 2 else ""),
                  f"- What the build changes: {d.transforms}", f"- Terms: {d.licence}"]
        if d.caution:
            lines.append(f"- Before you start: {d.caution}")
        if d.notice:
            lines.append(f"- Notice from the source: {d.notice}")
        lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- the command


def listing(selected: list[Dataset], cat: dict[str, dict[str, Any]], root: Path, width: int = 100) -> list[str]:
    """The datasets, one short block each: name, one sentence, where it comes from and where it goes."""
    def home(p: Path) -> str:
        try:
            return "~/" + str(p.relative_to(Path.home()))
        except ValueError:
            return str(p)
    pad = max(len(d.name) for d in selected) + 2
    out = ["thimble demo downloads these datasets from their sources, asking before each:", ""]
    for d in selected:
        out.append(f"  {d.name.ljust(pad)}{d.blurb or d.title}")
        out.append(f"  {' ' * pad}{d.url or d.source} → {home(root / d.name)}")
    out.append("")
    return out


def _ask(question: str, yes: bool, default: bool = False) -> bool | None:
    """True for a yes (or `yes` given), False for anything else, `default` for an empty answer; None without a
    terminal to ask on."""
    if yes:
        return True
    if not sys.stdin.isatty():
        return None
    try:
        answer = input(question).strip().lower()
    except EOFError:
        return False
    return default if not answer else answer in ("y", "yes")


def _server(say: Callable[[str], None]) -> tuple[str | None, dict[str, Any]]:
    """The running server's URL (started when it is not up) and the folders it uses; (None, env) without a server."""
    from . import cli  # noqa: PLC0415

    cli.ensure_home()
    env = cli.resolve_env()
    url = cli.api_url()
    if cli.refuse_foreign(url):
        return None, env
    try:
        up = cli.ensure_running(cli.WAIT_S)
    except TimeoutError:
        up = cli.healthy(url)
    if not up:
        why = cli.start_failure(url)
        say(f"  no thimble server answers: {why}" if why else f"  the thimble server did not start (see {cli.log_path()})")
    return (url if up else None), env


def register(folder: Path, url: str | None, name: str | None = None) -> str:
    """The workspace name of `folder`, registered as a corpus of its own (as a session's /thimble registers it): a new
    registration takes `name` when given (the next free one when another folder holds it), else the folder's name; a
    folder registered already keeps its name."""
    from . import cli  # noqa: PLC0415

    if url:
        body_ = {"path": str(folder), "exact": True, **({"name": name} if name else {})}
        status, body = cli._request("POST", f"{url}/api/corpora/register", body_)
        if status in (200, 201) and isinstance(body, dict) and body.get("name"):
            return str(body["name"])
        raise DemoError(f"the server did not register {folder}: {status} {str(body)[:200]}")
    return str(config.register_corpus(folder, exact=True, name=name)["name"])


def workspace_name(dataset: str) -> str:
    """The workspace a dataset's folder registers as: demo-<dataset> (DEMO_PREFIX), never the name of a folder of the
    analyst's own that shares the dataset's name, as `thimble demo --examples` names example-<name>."""
    return f"{DEMO_PREFIX}{dataset}"


def registered_as(folder: Path, data_dir: Path) -> str | None:
    """The name the registry `data_dir` holds `folder` itself under (as config.sidecar_match finds it), None when no
    registration names that folder."""
    p = folder.resolve()
    recs = []
    for sidecar in sorted(data_dir.glob(f"*{config.SIDECAR_SUFFIX}")):
        rec = config.read_sidecar(sidecar.name[: -len(config.SIDECAR_SUFFIX)], data_dir)
        if rec is not None:
            recs.append(rec)
    found = config.sidecar_match(p, recs)
    return str(found[0]["name"]) if found is not None and found[1] == p else None


def bound_sessions(ws: Path, claude_dir: Path) -> list[Path]:
    """Claude Code's folders of the sessions that ran in the workspace folder `ws` or a folder in it (a projects folder is
    named after the folder its sessions ran in: projects_folder), such as a full pre-cache's (install) or an earlier
    thimble's agents': a session continues only from the folder it ran in, so a move of `ws` would end them."""
    base = projects_folder(str(ws.resolve()))
    try:
        found = list((claude_dir / "projects").iterdir())
    except OSError:
        return []
    return sorted(p for p in found if p.is_dir() and (p.name == base or p.name.startswith(base + "-")))


def held_open(url: str | None, name: str, ws: Path) -> bool:
    """Whether a Claude Code session holds the workspace open: one whose shim subscribed on the server (GET
    /api/events/sessions, as `thimble purge` counts them), or a terminal-mode session that still runs
    (local.live_terminal)."""
    from . import cli, local  # noqa: PLC0415

    if local.live_terminal(ws):
        return True
    if not url:
        return False
    status, body = cli._request("GET", f"{url}/api/events/sessions")
    got = body.get("workspaces") if status == 200 and isinstance(body, dict) else None
    return bool(isinstance(got, dict) and got.get(name))


def settle_name(ds: Dataset, folder: Path, url: str | None, env: dict[str, Any], say: Callable[[str], None]) -> None:
    """Before `folder` registers: a workspace an earlier `thimble demo` registered under another name (module note,
    names), renamed demo-<dataset> with all it holds, through the server (POST /api/ws/{c}/rename) or, with no server,
    on the disk (ledger.move_workspace), and a line saying so. Left as it is while a session holds it open or when the
    rename fails, with a line naming it and how to remove it; when Claude Code sessions ran in its folder, its
    registration alone goes, so the folder registers as demo-<dataset>, and the line says how to remove the old
    workspace. The analyst's own workspace of the folder, and one whose demo-<dataset> another folder holds, keep their
    names."""
    import urllib.parse  # noqa: PLC0415

    from . import cli, ledger, start_page  # noqa: PLC0415

    data, root = Path(env["data_dir"]), Path(env["workspaces_dir"])
    want = workspace_name(ds.name)
    old = registered_as(folder, data)
    if old is None or old == want:
        return
    ws = root / old
    mark = _read_json(ws / MARKER)
    if start_page.demo_dataset(folder.resolve(), mark if isinstance(mark, dict) else None, default_dir()) != ds.name:
        return
    if (data / f"{want}{config.SIDECAR_SUFFIX}").exists() or (data / want / "manifest.json").is_file() \
            or (root / want).exists():
        return
    if held_open(url, old, ws):
        say(f"  the demo workspace {old} keeps its name, since a Claude Code session has it open: quit that session and "
            f"run `thimble demo` again to rename it {want} (`thimble purge {old}` removes it)")
        return
    if bound_sessions(ws, claude_config_dir()):
        (data / f"{old}{config.SIDECAR_SUFFIX}").unlink(missing_ok=True)
        say(f"  the earlier demo workspace {old} stays as it was in {ws}, since Claude Code sessions ran in that folder "
            f"and could not continue after a move; the dataset opens as {want}, and `thimble purge {old}` removes {old}")
        return
    why, had = "", ws.is_dir()
    if url:
        status, body = cli._request("POST", f"{url}/api/ws/{urllib.parse.quote(old)}/rename", {"to": want},
                                    timeout=cli.ARCHIVE_TIMEOUT_S)
        if status != 200:
            detail = body.get("detail") if isinstance(body, dict) else body
            why = f"the server answered {status or 'nothing'}" + (f": {str(detail)[:200]}" if detail else "")
    else:
        try:
            ledger.move_workspace(old, want, workspaces=root)
        except (ValueError, OSError) as e:
            why = str(e)
    if why:
        say(f"  the demo workspace {old} keeps its name, since it could not be renamed {want} ({why}); "
            f"`thimble purge {old}` removes it, and the next `thimble demo` opens the dataset as {want}")
        return
    say(f"  the demo workspace {old} is now {want}" + (", with its cards, labels, views, documents and chats" if had else ""))


def place_precache(ds: Dataset, folder: Path, cat: dict[str, dict[str, Any]], url: str | None, env: dict[str, Any],
                   replace: bool, say: Callable[[str], None]) -> str:
    """Register `folder` and install `ds`'s pre-cache as its workspace when there is one and the workspace holds no
    analysis yet (or `replace`, which archives it first): the workspace's name."""
    from . import cli  # noqa: PLC0415

    settle_name(ds, folder, url, env, say)
    name = register(folder, url, workspace_name(ds.name))
    pc = cat.get(ds.name)
    if pc is None:
        say(f"  {ds.name} opens without a pre-cached orientation; Start in the page runs one")
        return name
    ws = Path(env["workspaces_dir"]) / name
    if ws.exists():
        if holds_work(ws) and not replace:
            say(f"  workspace {name} holds an analysis already; it stays (--replace archives it and installs the "
                "pre-cache)")
            return name
        archived = None
        if url:
            ok, archived = cli.archive_workspace(url, name)
            if not ok:
                raise DemoError(f"workspace {name} could not be archived; see {cli.log_path()}")
        if ws.exists():  # no server to archive it: moved where /thimble fresh moves a workspace
            from . import ledger  # noqa: PLC0415

            dest = ws.parent / ledger.ARCHIVE_DIR / f"{name}-{datetime.now().strftime(ledger.ARCHIVE_TIME)}"
            while dest.exists():
                dest = dest.with_name(dest.name + "-2")
            dest.parent.mkdir(parents=True, exist_ok=True)
            ws.rename(dest)
            archived = str(dest)
        if archived:
            say(f"  the earlier workspace {name} is archived at {archived}")
    m = install(Path(pc["path"]), ws, folder)
    c = m.get("counts") or {}
    trs = m.get("installed_transcripts") or []
    say(f"  pre-cached orientation installed as workspace {name}: {plural(c.get('cards', 0), 'card')}, "
        f"{plural(c.get('labels', 0), 'label')}, {plural(c.get('views', 0), 'view')}, "
        f"{plural(c.get('documents', 0), 'document')}"
        + (f"; {plural(len(trs), 'session')} of its agents can continue" if trs else ""))
    for w in m["warnings"]:
        say(f"  warning: {w}")
    return name


def start_session(folder: Path) -> None:
    """Replace this process with `thimble` in `folder`, as when the analyst runs it there."""
    launcher = config.REPO_ROOT / "plugin" / "bin" / "thimble"
    env = {k: v for k, v in os.environ.items() if k not in ("THIMBLE_CALLER_CWD", "THIMBLE_PLUGIN_ROOT")}
    env["PWD"] = str(folder)
    os.chdir(folder)
    os.execve(str(launcher), [str(launcher)], env)


def start_url(key: bool | None = None) -> str:
    """thimble's start page (the page with no workspace in its URL, which lists every workspace: start_page.py), with
    the key that lets it answer permission requests: when it goes to a terminal, unless `key` says."""
    from . import cli  # noqa: PLC0415

    return cli.ui_url(None, key=sys.stdout.isatty() if key is None else key)


def open_page(url: str) -> bool:
    """Open `url` in the analyst's browser where there is a desktop to show it; whether it was asked to."""
    if not sys.stdout.isatty():
        return False
    desktop = sys.platform == "darwin" or os.name == "nt" or os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    if not desktop:
        return False  # a terminal browser would take over the terminal
    try:
        return webbrowser.open(url)
    except webbrowser.Error:
        return False


def claude_login(auth: Callable[[], dict[str, Any] | None]) -> tuple[bool | None, str]:
    """(whether Claude Code has a login configured, None when that is unknown; the line saying why no session can be
    attached, '' when one can)."""
    if not config.CLI_PATH:
        return False, ("Claude Code (`claude`) is not on PATH, so no session can be attached: install it "
                       "(https://docs.anthropic.com/en/docs/claude-code), then attach with the command below.")
    status = auth()
    if status is not None and status.get("loggedIn") is False:
        return False, (f"Claude Code is not logged in (`claude auth status`), so no session is attached. Log in "
                       f"({LOGIN_HINT}), then attach with the command below.")
    return (None if status is None else True), ""


def attach_choice(args: argparse.Namespace, folders: list[Path], say: Callable[[str], None],
                  auth: Callable[[], dict[str, Any] | None]) -> tuple[Path | None, bool]:
    """The folder to attach a session in now, or None: the demo is static unless --attach asks for a session (module
    note). And whether it said why Claude Code cannot attach one."""
    if not folders or not args.attach:
        return None, False
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        if args.attach:
            say("  --attach needs a terminal to start Claude Code in; the workspace is open without it")
        return None, False
    logged_in, why = claude_login(auth)
    if logged_in is False:
        say(f"  {why}")
        return None, True
    return pick_folder(folders), False


FROZEN_LINE = "To start a live session from scratch with this dataset, run"  # as the browser's card says it (Precached.tsx)


def shell_folder(folder: Path) -> str:
    """`folder` as a shell takes it after `cd`: the home folder as ~, the rest quoted only where a shell would split it or
    expand it (as the browser writes it, SessionGone.tsx shellFolder)."""
    home = Path.home()
    if folder == home:
        return "~"
    if folder.is_relative_to(home):
        return "~/" + shlex.quote(str(folder.relative_to(home)))
    return shlex.quote(str(folder))


def attach_lines(opened: list[tuple[Dataset, Path, str | None]], precached: bool, attaching: Path | None,
                 login_said: bool = False, kept: bool = False) -> list[str]:
    """How to start a session on each opened workspace. With no session attaching and no session kept, the frozen demo's
    one sentence and command for each dataset, as the orientation's card in the browser gives them (FROZEN_LINE), and
    nothing else. Otherwise how to attach a Claude Code session to each later, and to continue it, and how to log in
    unless `login_said`. `kept`: a pre-cache was a full export, whose orientation's session came with it."""
    out = [""]
    if attaching is None and not kept:
        for ds, folder, _ in opened:
            out.append(FROZEN_LINE)
            out.append(f"  cd {shell_folder(folder)} && thimble" + (f"    # {ds.name}" if len(opened) > 1 else ""))
        return out
    if attaching is None:
        out.append("No Claude Code session is attached. To attach one (main, which you chat with in the page), run in "
                   "a terminal:")
    else:
        out.append(f"Attaching a Claude Code session in {attaching}. To attach one again later, run in a terminal:")
    for ds, folder, _ in opened:
        out.append(f"  cd {folder} && thimble" + (f"    # {ds.name}" if len(opened) > 1 else ""))
    out.append("`thimble -c` in that folder continues the last session there.")
    if precached and kept:
        out.append("The pre-cached orientation ran in advance and its Claude Code session came with it: a message in "
                   "its thread continues it. A session you attach starts fresh, with the orientation's cards and report "
                   "as its context.")
    elif precached:
        out.append("The pre-cached orientation ran in advance and its session is not included: a session you attach "
                   "starts fresh, with the orientation's cards and report as its context.")
    if not login_said:
        out.append(f"A session needs Claude Code logged in ({LOGIN_HINT}).")
    return out


def wrapped(say: Callable[[str], None], width: int = 110) -> Callable[[str], None]:
    """`say`, with a long line wrapped under its own indent (a command, a URL or JSON to copy is left whole)."""
    def out(text: str) -> None:
        for line in text.split("\n"):
            if len(line) <= width or line.lstrip().startswith(("cd ", "{")) or "http" in line:
                say(line)
                continue
            indent = line[: len(line) - len(line.lstrip())]
            for part in textwrap.wrap(line, width, subsequent_indent=indent + "  ", break_long_words=False,
                                      break_on_hyphens=False):
                say(part)

    return out


def run(args: argparse.Namespace, *, get: Callable[[str], bytes] = demo_data.http_get,
        say: Callable[[str], None] = print, start: Callable[[Path], None] = start_session,
        server: Callable[[Callable[[str], None]], tuple[str | None, dict[str, Any]]] = _server,
        show: Callable[[str], bool] = open_page,
        auth: Callable[[], dict[str, Any] | None] = config.auth_status) -> int:
    say = wrapped(say)
    if getattr(args, "examples", False):
        from . import demo_examples  # noqa: PLC0415

        return demo_examples.run(args, say, server, show=show)
    if args.export:
        return run_export(args, say)
    names = list(args.names or DATASETS)
    unknown = [n for n in names if n not in DATASETS]
    if unknown:
        say(f"thimble demo: no dataset {', '.join(unknown)}; the datasets are {', '.join(DATASETS)}")
        return 2
    selected = [DATASETS[n] for n in names]
    root = given(args.dir) if args.dir else default_dir()
    cat = precaches(given(args.precaches) if args.precaches else PRECACHES)
    for line in listing(selected, cat, root):
        say(line)
    if args.list:
        return 0
    fetch = Downloads(root, get)
    ready: list[tuple[Dataset, Path]] = []
    failed = 0
    for ds in selected:
        here = complete(ds, root / ds.name)  # nothing to download
        answer = True if here else _ask(f"Download {ds.name} ({human(ds.download_bytes)})? [y/N] ", args.yes)
        if answer is None:
            say("thimble demo: no terminal to ask on; run `thimble demo --yes` (with the names of the datasets you "
                "want) to download")
            return 1
        if not answer:
            say(f"  {ds.name}: skipped")
            continue
        if not here:
            say(f"  {ds.name}: downloading from {', '.join(sorted({u.split('/')[2] for u in ds.sources}))} …")
        try:
            warnings = write_dataset(ds, root / ds.name, fetch)
        except (demo_data.SourceError, DemoError) as e:
            say(f"  {ds.name}: not built: {e}")
            failed += 1
            continue
        for w in warnings:
            say(f"  warning: {w}")
        files = list(ds.expected)
        say(f"  {ds.name}: " + (", ".join(files) if len(files) <= 4 else f"{len(files)} files")
            + f" in {root / ds.name}" + (" (each file checked against the copy the demo pins)" if not warnings else ""))
        if ds.notice:
            say(f"  notice from the source: {ds.notice}")
        ready.append((ds, root / ds.name))
    if not ready:
        return 1 if failed else 0
    # every dataset in the folder, this run's and an earlier run's
    built = {d.name for d, _ in ready}
    (root / "SOURCES.md").write_text(sources_md([d for d in DATASETS.values() if d.name in built
                                                 or (root / d.name).is_dir()]), "utf-8")
    url, env = server(say)
    opened: list[tuple[Dataset, Path, str | None]] = []
    for ds, folder in ready:
        try:
            name: str | None = place_precache(ds, folder, cat, url, env, args.replace, say)
        except (DemoError, OSError) as e:
            say(f"  {ds.name}: " + ("the pre-cached orientation was not installed" if ds.name in cat else
                                     "not registered in thimble") + f": {e}")
            name = None
        opened.append((ds, folder, name))
    say("")
    # one URL whatever the run opened: the start page, which lists every dataset downloaded (start_page.py)
    if url and any(name for _, _, name in opened):
        page = start_url()
        say(f"  Open at {page}")
        if show(page):
            say("  (opened in your browser)")
    if not url:
        say("  no server answers, so nothing is open; `thimble` in a folder below starts it")
    pick, login_said = attach_choice(args, [f for _, f, _ in opened], say, auth)
    for line in attach_lines(opened, any(ds.name in cat for ds, _, _ in opened), pick, login_said,
                             kept=any(cat[ds.name].get("full") for ds, _, name in opened if name and ds.name in cat)):
        say(line)
    if pick is not None:
        start(pick)
    return 0


def pick_folder(folders: list[Path]) -> Path | None:
    """The folder the analyst chose to start thimble in, the first on Enter; None for a no."""
    if len(folders) == 1:
        return folders[0]
    try:
        answer = input(f"Attach in which? [1-{len(folders)}, Enter for 1, n for none] ").strip().lower()
    except EOFError:
        return None
    if not answer:
        return folders[0]
    return folders[int(answer) - 1] if answer.isdigit() and 1 <= int(answer) <= len(folders) else None


def dataset_of(ws: Path) -> str:
    """The name a workspace is exported under unless --dataset says: the dataset its pre-cache's mark names, else its
    name without demo- when that is a dataset's (workspace_name), else its name."""
    mark = _read_json(ws / MARKER)
    if isinstance(mark, dict) and str(mark.get("dataset") or "") in DATASETS:
        return str(mark["dataset"])
    bare = ws.name.removeprefix(DEMO_PREFIX)
    return bare if bare != ws.name and bare in DATASETS else ws.name


def run_export(args: argparse.Namespace, say: Callable[[str], None]) -> int:
    from . import cli  # noqa: PLC0415

    workspace, out = args.export
    outputs_only = bool(getattr(args, "outputs_only", False))
    env = cli.resolve_env()
    ws = Path(env["workspaces_dir"]) / workspace
    if not ws.is_dir():
        ws = given(workspace)
    run_rec = _read_json(ws / "orient" / "run.json")
    if not isinstance(run_rec, dict):
        say(f"thimble demo --export: {workspace} is no workspace with an orientation")
        return 1
    # the outputs alone are the finished orientation's; a full export takes the workspace as it stands once nothing runs
    busy = run_rec.get("status") != "done" if outputs_only else run_rec.get("status") in ("requested", "running")
    if busy or run_rec.get("queue"):
        say(f"thimble demo --export: the orientation of {ws.name} is {run_rec.get('status')}"
            + (" with follow-ups waiting" if run_rec.get("queue") else "") + "; export it once it is done")
        return 1
    name = args.dataset or dataset_of(ws)
    rec = config.read_sidecar(ws.name, Path(env["data_dir"]))
    corpus = given(args.corpus) if args.corpus else Path(rec["path"]) if rec else None
    if corpus is None or not corpus.is_dir():
        say(f"thimble demo --export: the corpus folder of {ws.name} is unknown; pass --corpus")
        return 1
    out_path = given(out)
    if not (out_path / MANIFEST).is_file() and out_path.name != name:
        out_path = out_path / name
    app = given(args.app) if args.app else None
    if not outputs_only:
        say(f"thimble demo --export: writing everything in workspace {ws.name}, with the transcripts of its sessions, "
            f"to {out_path} (--outputs-only writes the outputs alone, for demos/) …")
    try:
        if outputs_only:
            m = export_outputs(ws, corpus, out_path, name=name, allow_private=args.allow_private,
                               scrub_user=args.scrub_user, app=app, view=getattr(args, "view", None))
        else:
            m = export_full(ws, corpus, out_path, name=name, scrub_user=args.scrub_user, app=app,
                            claude_dir=given(args.claude_config) if getattr(args, "claude_config", None) else None,
                            view=getattr(args, "view", None))
    except DemoError as e:
        say(f"thimble demo --export: {e}")
        return 1
    size = sum(f.stat().st_size for f in out_path.rglob("*") if f.is_file())
    missing = [f"call:{x['chat']}/{x['n']}" for x in m.get("cited_calls") or [] if not x["found"]]
    if missing:
        say(f"  {len(missing)} cited calls are not in the workspace's call logs: {', '.join(missing[:5])}")
    if name in DATASETS:
        mism = [f["path"] for f in m["corpus"] if DATASETS[name].expected.get(f["path"]) not in (None, f["sha256"])]
        if mism:
            say(f"  warning: the corpus differs from what `thimble demo` downloads: {', '.join(mism[:5])}")
    if outputs_only:
        say("  read it before you commit it (demos/README.md), then `python3 scripts/check_content.py` checks it")
    elif out_path.resolve().is_relative_to(PRECACHES.resolve()):
        say("  demos/ in the repository takes the outputs alone (--outputs-only); scripts/check_content.py refuses "
            "a full export there")
    for line in inventory_lines(m, out_path, size):
        say(line)
    return 0


def add_parser(sub: Any) -> None:
    p = sub.add_parser("demo", help=f"download public datasets ({', '.join(DATASETS)}) from their publishers and open "
                                    "each on a pre-cached orientation; asks before each download")
    p.add_argument("names", nargs="*", metavar="name", help=f"the datasets (default: all of {', '.join(DATASETS)})")
    p.add_argument("-y", "--yes", action="store_true", help="download without asking")
    p.add_argument("--dir", help=f"where the datasets go (default {DEFAULT_DIR}/<name>)")
    p.add_argument("--list", action="store_true", help="list the datasets and their sources; download nothing")
    attach = p.add_mutually_exclusive_group()
    attach.add_argument("--attach", action="store_true",
                        help="also start a Claude Code session (thimble) in the dataset's folder")
    attach.add_argument("--no-attach", action="store_true", help=argparse.SUPPRESS)  # the default; kept for scripts
    p.add_argument("--replace", action="store_true",
                   help="archive a workspace that holds an analysis already and install the pre-cache in its place")
    p.add_argument("--precaches", metavar="DIR",
                   help="install the pre-caches in DIR/<name> instead of the repository's demos/<name>")
    p.add_argument("--export", nargs=2, metavar=("WORKSPACE", "OUT"),
                   help="write everything in WORKSPACE (a name or a folder), with the transcripts of its sessions, as "
                        "the folder OUT/<dataset>, and list what it holds; `thimble demo --precaches OUT` installs it")
    p.add_argument("--outputs-only", action="store_true",
                   help="with --export: the orientation's outputs alone, checked against the dataset's text: the "
                        "pre-caches demos/ holds")
    p.add_argument("--dataset", help="with --export: the dataset the export is for (default: the workspace's name)")
    p.add_argument("--corpus", help="with --export: the workspace's corpus folder, when thimble does not know it")
    p.add_argument("--app", help="with --export: the thimble install the orientation ran in, when it is not this one")
    p.add_argument("--view", metavar="SLUG",
                   help="with --export: the view the workspace opens on when `thimble demo` installs it (default: Files)")
    p.add_argument("--claude-config", metavar="DIR",
                   help="with --export: the Claude Code config folder the workspace's sessions ran with (default "
                        "CLAUDE_CONFIG_DIR, else ~/.claude)")
    p.add_argument("--scrub-user", action="store_true",
                   help="with --export: write `user` in place of your user name where it stands as a word")
    p.add_argument("--examples", action="store_true",
                   help="for development and review: open each worked example of custom views (plugin/viewers) as the "
                        "workspace example-<name> on its sample, with its view built and its sample labels on, and open "
                        "the start page that lists them")
    p.add_argument("--refresh", action="store_true",
                   help="with --examples: copy each example's sample and view again and redefine its labels, so edits "
                        "in plugin/viewers show")
    p.add_argument("--allow-private", action="store_true",
                   help="with --export --outputs-only: write the pre-cache even when it holds the user name or "
                        "absolute paths (never one that copies long stretches of the corpus)")
    p.set_defaults(fn=lambda a: run(a))
