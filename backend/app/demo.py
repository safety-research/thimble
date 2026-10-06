"""`thimble demo`: three public datasets, each opened on an orientation run ahead of time.

    thimble demo [NAME...] [--yes] [--dir DIR] [--attach] [--replace] [--precaches DIR]
    thimble demo --export WORKSPACE OUT [--dataset NAME] [--scrub-user] [--allow-private]      (maintainers)

The command lists the datasets (demo_data.DATASETS) with their sources and sizes, asks before each download (--yes
answers yes for all), rebuilds each dataset from its publisher's files into DIR/<name> (default ~/thimble-demo) and
checks it against the copy the orientations ran on. It then registers the folder as a corpus, installs that dataset's
pre-cached orientation as its workspace when demos/ has one (a dataset without one opens with no analysis yet, with a
line saying so), and opens the workspace in the browser without starting a Claude Code session (as `thimble up` does). It prints how to attach one: `cd <folder> && thimble` starts main on the workspace, and the
orientation's own session continues from its thread or main's message_orientation. --attach starts main directly.

The pre-cache. A folder, demos/<name>/ in the repository, of plain files a reviewer reads in a diff:
`thimble-demo-precache.json` (the manifest), `README.md` (the source's notice first, then what the folder holds),
`workspace/`, the files of a workspace after its orientation (the cards in notebooks/, the labels' definitions in
concepts/ and results in labels/*.jsonl, the views in views/ and extension/, the documents in investigations/, the chats
and the orientation's thread with its calls in chats/ and calls/, the orientation's record and the files its cards read
in orient/), and `transcripts/orient.jsonl`, the orientation's Claude Code transcript (demo_scrub.clean_transcript keeps
its conversation and drops what describes the maintainer's machine and account). What thimble rebuilds or keeps per
machine is left out of workspace/: label indexes (*.sqlite), view caches and indexes, kernels, the scratch mirror of the
corpus, telemetry, the files viewed, sessions and permissions, undo, pictures, and every file that is not text. Absolute
paths are written as placeholders (demo_scrub.PLACEHOLDERS) and filled in on install, and the export refuses (without
--allow-private) while the exporter's user name or another absolute path remains, or gitleaks finds a secret.
scripts/check_content.py allows these folders in the tree on the terms its DEMO note gives.

The transcript on install. Claude Code resumes a session from `<config>/projects/<folder>/<session>.jsonl`, the folder
named after the directory the session runs in (demo_scrub.projects_folder). The install writes the transcript there for
the new workspace's orient/work, under a new session id (so two installs never share one), with the paths filled in,
and names that id in the orientation's record and chat; a follow-up then resumes it with its whole conversation. The
writers and the critic are not resumed (a new writer gets its context in its first message), so their transcripts are
not kept.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import textwrap
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import config, demo_data
from .demo_data import DATASETS, Dataset
from .demo_scrub import (DASHED, PLACEHOLDERS, TEXT_SUFFIXES, clean_transcript, findings, projects_folder,
                         transcript_findings)

SCHEMA = "thimble-demo-precache"
VERSION = 2  # 1 was a zip (release assets); 2 is a folder with the orientation's transcript
MANIFEST = "thimble-demo-precache.json"
README = "README.md"
WORKSPACE = "workspace"
TRANSCRIPT = "transcripts/orient.jsonl"
PRECACHES = config.REPO_ROOT / "demos"  # demos/<name>/
DEFAULT_DIR = Path("~/thimble-demo")
SCRUBBED_USER = "user"  # what --scrub-user writes in place of the exporter's user name
ORIENT_FOLDER = "orient/work"  # where the orientation's session runs, in the workspace (orient_session.work_dir)

# What a pre-cache keeps, by the first part of the path in the workspace; anything else is listed as left out.
KEEP_TOP = {"notebooks", "concepts", "labels", "filters.json", "views", "extension", "extensions", "registry",
            "investigations", "chats", "calls", "orient", "canvas-history.jsonl", "settings.json", "config.json",
            "checks", "card-checks"}
REBUILT = {"scratch": "the kernels' mirror of the corpus, rebuilt", "kernels": "kernel state",
           "view-indexes": "views' indexes, rebuilt", "telemetry.jsonl": "the maintainer's browser telemetry",
           "viewed.jsonl": "the files the maintainer opened", "sessions.json": "the maintainer's Claude Code sessions",
           "bg-sessions.json": "the maintainer's background sessions", "permissions.jsonl": "permission answers",
           "undo.jsonl": "the undo history", "render-theme.json": "the browser's theme", "unheard.json": "per session",
           "views-work": "the view builds' own scratch", "critique": "the critic's digest of the transcript",
           "writers": "the writers' own scratch"}
SKIP_PARTS = {"__pycache__", "cache", "trash", "tmp"}
SKIP_SUFFIXES = (".sqlite", ".sqlite-wal", ".sqlite-shm", ".lock", ".log", ".tmp", ".pyc", ".png")
DOT_OK = {"views", "extension"}  # where dot files are thimble's own records (views/.versions, .reviewed)
WORK_FILE_MAX = 5_000_000  # a file in orient/work larger than this is left out (cards keep their outputs)
SECRET_KEY_RE = re.compile(r"key|token|secret|password|credential", re.I)
# paths a pre-cache may hold: relative, no `..`, no backslash
SAFE_NAME = re.compile(r"^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[^\\\x00]+$")


class DemoError(Exception):
    pass


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


def claude_config_dir() -> Path:
    """The config dir of the Claude Code this command's user runs: CLAUDE_CONFIG_DIR, else ~/.claude."""
    return config.config_dir_of(config.own_claude_config()).expanduser()


# --------------------------------------------------------------------------- the pre-cache: export


def kept(rel: Path, size: int) -> str | None:
    """None when a pre-cache keeps the workspace file `rel` (relative to the workspace), else why it is left out."""
    parts = rel.parts
    top = parts[0]
    if top not in KEEP_TOP:
        return REBUILT.get(top, "not known to be part of a workspace's state")
    if any(p in SKIP_PARTS for p in parts[1:]) or rel.name.endswith(SKIP_SUFFIXES):
        return "rebuilt by thimble, or per machine"
    if top not in DOT_OK and any(p.startswith(".") for p in parts):
        return "a hidden file"
    if top == "orient":
        if len(parts) == 2 and parts[1] in ("run.json", "summary.md"):
            return None
        if len(parts) >= 3 and parts[1] == "work":
            return f"over {human(WORK_FILE_MAX)}" if size > WORK_FILE_MAX else None
        return "the orientation's own scratch"
    if top == "labels" and not rel.name.endswith(".jsonl"):
        return "rebuilt by thimble"
    return None


def dashed(path: str) -> str:
    """A folder as Claude Code names its projects folder (`-home-a-…`)."""
    return projects_folder(path)


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
    return rel.suffix.lower() in TEXT_SUFFIXES and _decodes(data)


def _decodes(data: bytes) -> bool:
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def _settings(data: bytes) -> bytes:
    try:
        s = json.loads(data)
    except ValueError:
        return data
    if not isinstance(s, dict):
        return data
    return json.dumps({k: v for k, v in s.items() if not SECRET_KEY_RE.search(k)}, ensure_ascii=False,
                      indent=2).encode()


def _run_record(data: bytes) -> bytes:
    try:
        run = json.loads(data)
    except ValueError:
        return data
    if isinstance(run, dict):
        for k in ("pid", "agent_id"):
            run.pop(k, None)
    return json.dumps(run, ensure_ascii=False, indent=2).encode()


LIVE = ("running", "working", "starting", "queued", "pending")  # a chat's statuses while its session runs


def chat_meta(data: bytes) -> tuple[bytes, bool]:
    """A chat's meta with what belonged to a running process taken out (pid, server, the transcript offset its follower
    kept), and a status that says it runs written `done`, since nothing runs in an installed pre-cache (a `stopped` card
    offers a Resume that has no session to resume); and whether it said so. The export names these chats, as one may not
    have finished."""
    try:
        meta = json.loads(data)
    except ValueError:
        return data, False
    if not isinstance(meta, dict):
        return data, False
    for k in ("pid", "server", "follow"):
        meta.pop(k, None)
    live = meta.get("status") in LIVE
    if live:
        meta["status"] = "done"
    return json.dumps(meta, ensure_ascii=False, indent=1).encode(), live


def main_chat(data: bytes) -> tuple[bytes, list[str]]:
    """Main's chat without the slash commands the maintainer typed (/exit, /thimble), and the other messages they
    typed, which the export prints for a look before the pre-cache ships."""
    kept_lines, typed = [], []
    for line in data.decode("utf-8", "replace").splitlines(keepends=True):
        try:
            rec = json.loads(line)
        except ValueError:
            kept_lines.append(line)
            continue
        if isinstance(rec, dict) and rec.get("type") == "user" and not rec.get("event"):
            text = str(rec.get("text") or "")
            if text.strip().startswith("/"):
                continue
            typed.append(text[:120])
        kept_lines.append(line)
    return "".join(kept_lines).encode("utf-8"), typed


def chat_summary(ws: Path) -> dict[str, Any]:
    """The orientation's chat meta (model, effort), for the manifest."""
    path = orient_meta_path(ws)
    meta = _read_json(path) if path else None
    return meta if isinstance(meta, dict) else {}


def orient_meta_path(ws: Path) -> Path | None:
    """The meta file of the orientation's chat in workspace folder `ws`, from its record; None without one."""
    run = _read_json(ws / "orient" / "run.json") or {}
    cid = ((run.get("chats") or {}) if isinstance(run, dict) else {}).get("orient")
    return ws / "chats" / f"{cid}.meta.json" if cid and SAFE_NAME.match(str(cid)) and "/" not in str(cid) else None


def _read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


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
            "documents": len(docs), "chats": len(list((ws / "chats").glob("*.meta.json")))}


def corpus_files(corpus: Path) -> list[dict[str, Any]]:
    return [{"path": p.relative_to(corpus).as_posix(), "bytes": p.stat().st_size, "sha256": file_sha256(p)}
            for p in sorted(corpus.rglob("*")) if p.is_file() and not any(x.startswith(".") for x in
                                                                         p.relative_to(corpus).parts)]


def find_transcript(sid: str, claude_dir: Path) -> Path | None:
    """`<claude_dir>/projects/<folder>/<sid>.jsonl`, the newest when several folders hold one; None when none does."""
    if not sid or not re.fullmatch(r"[A-Za-z0-9-]{8,64}", sid):
        return None
    found = [p for p in (claude_dir / "projects").glob(f"*/{sid}.jsonl") if p.is_file()]
    return max(found, key=lambda p: p.stat().st_mtime) if found else None


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


def export(ws: Path, corpus: Path, out: Path, *, name: str, home: Path | None = None, user: str | None = None,
           allow_private: bool = False, scrub_user: bool = False, app: Path | None = None,
           claude_dir: Path | None = None, transcript: bool = True,
           scan: Callable[[Path], list[str] | None] = gitleaks_scan) -> dict[str, Any]:
    """Write the pre-cache of workspace folder `ws`, made on corpus folder `corpus`, as the folder `out` (replacing a
    pre-cache there); the manifest. The orientation's transcript is read from `claude_dir` (claude_config_dir()), and
    is required unless `transcript` is False. DemoError, and nothing written, when something private remains (unless
    `allow_private`), the transcript is missing, or `out` holds files that are not a pre-cache's. `scrub_user` writes
    SCRUBBED_USER in place of the user name where it stands as a word (in `ls -l` output, say)."""
    home = home or Path.home()
    user = getpass.getuser() if user is None else user
    if out.exists() and any(out.iterdir()) and not (out / MANIFEST).is_file():
        raise DemoError(f"{out} holds files that are not a pre-cache; choose another folder")
    pairs = placeholder_pairs(ws, corpus, home, app or config.REPO_ROOT)
    user_re = re.compile(rf"(?<![\w]){re.escape(user)}(?![\w])") if user and len(user) >= 3 else None
    scrubbed = 0
    files: list[dict[str, Any]] = []
    left: list[dict[str, Any]] = []
    flagged: list[str] = []
    typed: list[str] = []
    stopped: list[str] = []
    run = _read_json(ws / "orient" / "run.json") or {}
    sid = str(run.get("session") or "") if isinstance(run, dict) else ""

    def scrub(rel: str, text: str) -> str:
        nonlocal scrubbed
        text = with_placeholders(text, pairs)
        if scrub_user and user_re is not None:
            text, n = user_re.subn(SCRUBBED_USER, text)
            scrubbed += n
        flagged.extend(f"{rel}: {f}" for f in findings(text, user))
        return text

    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{out.name}.export-", dir=out.parent) as tmp:
        stage = Path(tmp) / "precache"
        for p in sorted(ws.rglob("*")):
            if not p.is_file() or p.is_symlink():
                continue
            rel = p.relative_to(ws)
            size = p.stat().st_size
            why = kept(rel, size)
            data = p.read_bytes() if why is None else b""
            if why is None and not is_text(rel, data):
                why = "not text"
            if why:
                left.append({"path": rel.as_posix(), "bytes": size, "why": why})
                continue
            if rel.as_posix() == "settings.json":
                data = _settings(data)
            elif rel.as_posix() == "orient/run.json":
                data = _run_record(data)
            elif rel.as_posix() == "chats/main.jsonl":
                data, typed = main_chat(data)
            elif rel.parts[0] == "chats" and rel.name.endswith(".meta.json"):
                data, live = chat_meta(data)
                if live:
                    stopped.append(rel.name[: -len(".meta.json")])
            data = scrub(f"{WORKSPACE}/{rel.as_posix()}", data.decode("utf-8")).encode("utf-8")
            dest = stage / WORKSPACE / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            files.append({"path": rel.as_posix(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        transcripts: list[dict[str, Any]] = []
        if transcript:
            found = find_transcript(sid, claude_dir or claude_config_dir())
            if found is None:
                where = (claude_dir or claude_config_dir()) / "projects"
                raise DemoError(f"the orientation's Claude Code transcript (session {sid or 'unknown'}) is not under "
                                f"{where}; pass --claude-config with the config folder its session ran with, or "
                                "--no-transcript to export without it (a follow-up then starts a new orientation)")
            data, stats = clean_transcript(found.read_bytes())
            text = scrub(TRANSCRIPT, data.decode("utf-8"))
            flagged.extend(f"{TRANSCRIPT}: {f}" for f in transcript_findings(text))
            dest = stage / TRANSCRIPT
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text, "utf-8")
            body = text.encode("utf-8")
            transcripts.append({"role": "orient", "session": sid, "folder": ORIENT_FOLDER, "path": TRANSCRIPT,
                                "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(), **stats})
        leaks = scan(stage)
        flagged += [f"gitleaks: {x}" for x in leaks or []]
        if flagged and not allow_private:
            raise DemoError("the pre-cache would carry what may be private; nothing was written:\n  "
                            + "\n  ".join(flagged[:40]) + ("\n  …" if len(flagged) > 40 else "")
                            + "\n--scrub-user writes `user` in place of the user name; --allow-private keeps the rest")
        meta = chat_summary(ws)
        manifest = {
            "schema": SCHEMA, "version": VERSION, "dataset": name, "created": now(),
            # the source's own notice travels with excerpts of it (mythos-5's asks to stay out of training corpora)
            "notice": DATASETS[name].notice if name in DATASETS else "",
            "thimble": {"version": _thimble_version(), "commit": _commit()},
            "orientation": {k: run.get(k) for k in ("status", "passes", "query", "effort", "ultracode", "critique",
                                                    "started", "ended") if isinstance(run, dict)}
                           | {"model": meta.get("model"), "chat_effort": meta.get("effort")},
            "counts": counts(ws),
            "corpus": corpus_files(corpus),
            "placeholders": PLACEHOLDERS,
            "transcripts": transcripts,
            "files": files,
            "left_out": left,
            "gitleaks": "not installed" if leaks is None else f"{len(leaks)} findings",
            "user_name_scrubbed": scrubbed,
            "typed_in_main": typed,
            "marked_done": stopped,
            "flagged": flagged,
        }
        (stage / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", "utf-8")
        (stage / README).write_text(readme(manifest), "utf-8")
        old = Path(tmp) / "old"
        if out.exists():
            out.rename(old)
        stage.rename(out)
    return manifest


def made_with(o: dict[str, Any]) -> str:
    """The orientation's model and effort in a few words: `claude-opus-5-5, Ultracode, no prompt`."""
    return ", ".join(x for x in (str(o.get("model") or "").replace("[1m]", ""),
                                 "Ultracode" if o.get("ultracode") else str(o.get("effort") or ""),
                                 "no prompt" if not o.get("query") else "") if x)


def readme(m: dict[str, Any]) -> str:
    """The pre-cache folder's README.md: the source's notice first, then what the folder holds and how it was made."""
    c, o, t = m.get("counts") or {}, m.get("orientation") or {}, m.get("thimble") or {}
    lines = []
    if m.get("notice"):
        lines += [f"> Notice from the source: {m['notice']}", ""]
    lines += [f"# {m['dataset']}: pre-cached orientation", "",
              f"`thimble demo {m['dataset']}` installs this folder as the workspace of the dataset it downloads, so "
              "thimble opens on the orientation's cards, labels, views and documents, and a message to the orientation "
              "continues its Claude Code session.", "",
              f"- Made {str(m.get('created') or '')[:10]} with thimble {t.get('version') or '?'} "
              f"({t.get('commit') or '?'}): {made_with(o)}; outputs {', '.join(o.get('passes') or []) or 'none'}"
              f"{', critique on' if o.get('critique') else ''}.",
              f"- It holds {c.get('cards', 0)} cards, {c.get('labels', 0)} labels, {c.get('views', 0)} views, "
              f"{c.get('documents', 0)} documents and {c.get('chats', 0)} chats.",
              f"- `{WORKSPACE}/`: {len(m.get('files') or [])} files of the workspace. `{MANIFEST}` lists each with its "
              f"SHA-256, and the {len(m.get('left_out') or [])} files left out with the reason for each."]
    for tr in m.get("transcripts") or []:
        dropped = sum((tr.get("dropped") or {}).values())
        lines.append(f"- `{tr['path']}`: the orientation's Claude Code transcript, {tr.get('kept', 0)} records. The "
                     f"export dropped {dropped} records that describe the maintainer's machine and account (the "
                     "manifest counts them by kind).")
    if not m.get("transcripts"):
        lines.append("- No transcript: a message to the orientation starts a new one.")
    lines += ["- Absolute paths are written as " + ", ".join(f"`{v}`" for v in PLACEHOLDERS.values())
              + " (and as `@@THIMBLE_DASHED_…@@` where Claude Code spells them with dashes), filled in on install.", "",
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
    if m.get("schema") != SCHEMA or not isinstance(m.get("version"), int) or not 2 <= m["version"] <= VERSION:
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


def install(src: Path, ws: Path, corpus: Path, *, home: Path | None = None,
            claude_dir: Path | None = None) -> dict[str, Any]:
    """Install the pre-cache folder `src` as the workspace folder `ws` (which must not exist), its placeholders filled
    with `ws`, `corpus` and the home folder, and its transcripts where Claude Code in `claude_dir`
    (claude_config_dir()) resumes them, each under a new session id; the manifest, with `warnings` for corpus files
    that differ and a transcript that could not be placed, and `transcripts` naming where each went."""
    home = home or Path.home()
    claude_dir = claude_dir or claude_config_dir()
    values = {"workspace": str(ws), "corpus": str(corpus), "app": str(config.REPO_ROOT),
              "thimble_home": str(thimble_home()), "home": str(home)}
    if ws.exists():
        raise DemoError(f"{ws} exists")
    manifest = read_manifest(src)
    names = [str(f.get("path") or "") for f in manifest.get("files") or [] if isinstance(f, dict)]
    trs = [t for t in manifest.get("transcripts") or [] if isinstance(t, dict)]
    bad = [n for n in [*names, *(str(t.get("path") or "") for t in trs), *(str(t.get("folder") or "") for t in trs)]
           if not n or not SAFE_NAME.match(n)]
    if bad:
        raise DemoError(f"the pre-cache holds unsafe paths: {bad[:3]}")
    sids = {str(t["session"]): str(uuid.uuid4()) for t in trs if t.get("session")}
    warnings: list[str] = []

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

    ws.parent.mkdir(parents=True, exist_ok=True)
    tmp = ws.parent / f".{ws.name}.demo-{secrets.token_hex(4)}"
    placed: list[Path] = []
    try:
        for rel in names:
            p = src / WORKSPACE / rel
            if not p.is_file():
                raise DemoError(f"the pre-cache lacks {WORKSPACE}/{rel}, which its manifest lists")
            data = p.read_bytes()
            if is_text(Path(rel), data):
                data = fill(rel, data.decode("utf-8")).encode("utf-8")
            dest = tmp / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        (tmp / ORIENT_FOLDER).mkdir(parents=True, exist_ok=True)
        follow: dict[str, Any] = {}
        installed = []
        for t in trs:
            p, sid = src / str(t["path"]), sids.get(str(t.get("session") or ""))
            if not sid or not p.is_file():
                warnings.append(f"the transcript {t.get('path')} is missing; a message to the orientation starts a "
                                "new one")
                continue
            # Claude Code names the folder after the session's working directory as the system reports it, with
            # symlinks resolved
            cwd = ws.parent.resolve() / ws.name / str(t.get("folder") or ORIENT_FOLDER)
            folder = claude_dir / "projects" / projects_folder(str(cwd))
            dest = folder / f"{sid}.jsonl"
            body = fill(str(t["path"]), p.read_text("utf-8")).encode("utf-8")
            try:
                folder.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(body)
            except OSError as e:
                warnings.append(f"the orientation's transcript could not be written to {dest} ({e}); a message to the "
                                "orientation starts a new one")
                continue
            placed.append(dest)
            installed.append({"role": t.get("role"), "session": sid, "path": str(dest)})
            if t.get("role") == "orient":
                follow = {"offset": len(body), "session": sid}
        run_path = tmp / "orient" / "run.json"
        run = _read_json(run_path)
        if isinstance(run, dict):
            run["precached"] = {"dataset": manifest.get("dataset"), "created": manifest.get("created"),
                                "installed": now(), "thimble": manifest.get("thimble")}
            run_path.write_text(json.dumps(run, ensure_ascii=False, indent=2), "utf-8")
        meta_path = orient_meta_path(tmp)
        meta = _read_json(meta_path) if meta_path else None
        if follow and isinstance(meta, dict):  # the follower of a follow-up reads the transcript from its end
            meta["follow"] = follow
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
        tmp.rename(ws)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        for p in placed:
            p.unlink(missing_ok=True)
        raise
    manifest["warnings"] = corpus_mismatches(manifest, corpus) + warnings
    manifest["installed_transcripts"] = installed
    return manifest


# --------------------------------------------------------------------------- the pre-caches and downloads


def precaches(folder: Path) -> dict[str, dict[str, Any]]:
    """The pre-caches in `folder` (demos/ by default), by dataset: {path, bytes, made_with}."""
    out = {}
    for name in DATASETS:
        p = folder / name
        try:
            m = read_manifest(p)
        except DemoError:
            continue
        size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
        out[name] = {"path": p, "bytes": size, "made_with": made_with(m.get("orientation") or {}),
                     "transcript": bool(m.get("transcripts"))}
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


def write_dataset(ds: Dataset, folder: Path, fetch: Callable[[str], bytes]) -> list[str]:
    """Build `ds` into `folder`: its warnings. A folder that holds exactly the expected files is left as it is."""
    if folder.is_dir() and all((folder / f).is_file() and file_sha256(folder / f) == h for f, h in ds.expected.items()):
        return []
    others = [p.name for p in folder.iterdir() if p.name not in ds.expected] if folder.is_dir() else []
    if others:
        raise DemoError(f"{folder} holds other files ({', '.join(sorted(others)[:3])}); choose another --dir")
    built = ds.build(fetch)
    folder.mkdir(parents=True, exist_ok=True)
    for fname, data in built.files.items():
        part = folder / f".{fname}.part"
        part.write_bytes(data)
        part.replace(folder / fname)
    return built.warnings


def sources_md(selected: list[Dataset]) -> str:
    lines = ["# thimble demo datasets", "",
             "Each folder here was rebuilt by `thimble demo` from its publisher's files. The transforms are adapted "
             "from MessageBoardAuditBench (https://github.com/hamzah2304/messageboardauditbench, MIT license).", ""]
    for d in selected:
        lines += [f"## {d.name}: {d.title}", "", d.about, "", f"- Source: {', '.join(d.sources[:2])}"
                  + (f" and {len(d.sources) - 2} more pages" if len(d.sources) > 2 else ""),
                  f"- What the build changes: {d.transforms}", f"- Terms: {d.licence}"]
        if d.notice:
            lines.append(f"- Notice from the source: {d.notice}")
        lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- the command


def listing(selected: list[Dataset], cat: dict[str, dict[str, Any]], root: Path, width: int = 100) -> list[str]:
    def wrap(text: str, indent: str = "     ") -> list[str]:
        return textwrap.wrap(text, width, initial_indent=indent, subsequent_indent=indent)

    lead = ("thimble demo: public datasets to try thimble on. One with a pre-cached orientation opens on that "
            "orientation's cards, labels and views; on the others, Start in the page runs one."
            if any(d.name in cat for d in selected) else
            "thimble demo: public datasets to try thimble on. None has a pre-cached orientation here, so each opens "
            "with no analysis yet, and Start in the page runs the orientation.")
    out = [*wrap(lead, ""), ""]
    for i, d in enumerate(selected, 1):
        pc = cat.get(d.name)
        size = (f"Download {human(d.download_bytes)}, {human(d.disk_bytes)} on disk; "
                + (f"pre-cached orientation {human(pc.get('bytes') or 0)}"
                   + (f" ({pc['made_with']})." if pc.get("made_with") else ".") if pc else
                   "no pre-cached orientation yet."))
        out += [f"  {i}. {d.name}: {d.title}", *wrap(d.about), *wrap(f"Source: {d.source}"), *wrap(size), ""]
    out += wrap(f"Each goes into {root}/<name>. Nothing is downloaded without a yes.", "")
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
        say(f"  the thimble server did not start ({cli.start_failure(url) or 'see ' + str(cli.log_path())})")
    return (url if up else None), env


def register(folder: Path, url: str | None) -> str:
    """The workspace name of `folder`, registered as a corpus of its own (as a session's /thimble registers it)."""
    from . import cli  # noqa: PLC0415

    if url:
        status, body = cli._request("POST", f"{url}/api/corpora/register", {"path": str(folder), "exact": True})
        if status in (200, 201) and isinstance(body, dict) and body.get("name"):
            return str(body["name"])
        raise DemoError(f"the server did not register {folder}: {status} {str(body)[:200]}")
    return str(config.register_corpus(folder, exact=True)["name"])


def place_precache(ds: Dataset, folder: Path, cat: dict[str, dict[str, Any]], url: str | None, env: dict[str, Any],
                   replace: bool, say: Callable[[str], None]) -> str:
    """Register `folder` and install `ds`'s pre-cache as its workspace when there is one and the workspace holds no
    analysis yet (or `replace`, which archives it first): the workspace's name."""
    from . import cli  # noqa: PLC0415

    name = register(folder, url)
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
    say(f"  pre-cached orientation installed as workspace {name}: {c.get('cards', 0)} cards, {c.get('labels', 0)} "
        f"labels, {c.get('views', 0)} views" + ("; its session can be continued" if m["installed_transcripts"] else ""))
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


def page_url(name: str) -> str:
    """The workspace's page, with the key that lets it answer permission requests when it goes to a terminal."""
    from . import cli  # noqa: PLC0415

    return cli.ui_url(name, key=sys.stdout.isatty())


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


def attach_lines(opened: list[tuple[Dataset, Path, str | None]], precached: bool = True) -> list[str]:
    """How to attach a Claude Code session to each opened workspace, and to continue its orientation when one was
    pre-cached."""
    out = ["", "No Claude Code session is attached. To attach one (main, which you chat with in the page), run in a "
           "terminal:"]
    for ds, folder, _ in opened:
        out.append(f"  cd {folder} && thimble" + (f"    # {ds.name}" if len(opened) > 1 else ""))
    if precached:
        out.append("To continue a pre-cached orientation, type in its thread (Orientation) in the page, or ask main to "
                   "message the orientation: its Claude Code session resumes with everything it read and did. While "
                   "it runs, `claude agents` lists it as `thimble:orient · <name>` and `claude attach <id>` opens it in "
                   "a terminal.")
    out.append("`thimble demo --attach` starts main directly.")
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
        show: Callable[[str], bool] = open_page) -> int:
    say = wrapped(say)
    if args.export:
        return run_export(args, say)
    names = list(args.names or DATASETS)
    unknown = [n for n in names if n not in DATASETS]
    if unknown:
        say(f"thimble demo: no dataset {', '.join(unknown)}; the datasets are {', '.join(DATASETS)}")
        return 2
    selected = [DATASETS[n] for n in names]
    root = given(args.dir) if args.dir else DEFAULT_DIR.expanduser().resolve()
    cat = precaches(given(args.precaches) if args.precaches else PRECACHES)
    for line in listing(selected, cat, root):
        say(line)
    if args.list:
        return 0
    fetch = Downloads(root, get)
    ready: list[tuple[Dataset, Path]] = []
    failed = 0
    for ds in selected:
        answer = _ask(f"Download {ds.name} ({human(ds.download_bytes)}) into {root / ds.name}? [y/N] ", args.yes)
        if answer is None:
            say("thimble demo: no terminal to ask on; run `thimble demo --yes` (or name the datasets) to download")
            return 1
        if not answer:
            say(f"  {ds.name}: skipped")
            continue
        say(f"  {ds.name}: downloading from {', '.join(sorted({u.split('/')[2] for u in ds.sources}))} …")
        try:
            warnings = write_dataset(ds, root / ds.name, fetch)
        except (demo_data.SourceError, DemoError) as e:
            say(f"  {ds.name}: not built: {e}")
            failed += 1
            continue
        for w in warnings:
            say(f"  warning: {w}")
        say(f"  {ds.name}: {', '.join(ds.expected)} in {root / ds.name}"
            + (" (checked against the copy the orientation ran on)" if not warnings else ""))
        if ds.notice:
            say(f"  notice from the source: {ds.notice}")
        ready.append((ds, root / ds.name))
    if not ready:
        return 1 if failed else 0
    (root / "SOURCES.md").write_text(sources_md([d for d, _ in ready]), "utf-8")
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
    if args.attach and sys.stdin.isatty() and sys.stdout.isatty():
        pick = pick_folder([f for _, f, _ in opened])
        if pick is not None:
            start(pick)
            return 0
    elif args.attach:
        say("  --attach needs a terminal to start Claude Code in; the workspace is open without it")
    say("")
    pages = [(ds, page_url(name)) for ds, _, name in opened if name and url]
    for ds, page in pages:
        say(f"  {ds.name} is open at {page}" if len(pages) > 1 else f"  Open at {page}")
    if pages and show(pages[0][1]):
        say(f"  (opened {pages[0][0].name} in your browser)")
    if not url:
        say("  the server is not running, so nothing is open; `thimble` in a folder below starts it")
    for line in attach_lines(opened, any(ds.name in cat for ds, _, _ in opened)):
        say(line)
    return 0


def pick_folder(folders: list[Path]) -> Path | None:
    """The folder the analyst chose to start thimble in, the first on Enter; None for a no."""
    if len(folders) == 1:
        return folders[0]
    try:
        answer = input(f"Start thimble in which? [1-{len(folders)}, Enter for 1, n for none] ").strip().lower()
    except EOFError:
        return None
    if not answer:
        return folders[0]
    return folders[int(answer) - 1] if answer.isdigit() and 1 <= int(answer) <= len(folders) else None


def run_export(args: argparse.Namespace, say: Callable[[str], None]) -> int:
    from . import cli  # noqa: PLC0415

    workspace, out = args.export
    env = cli.resolve_env()
    ws = Path(env["workspaces_dir"]) / workspace
    if not ws.is_dir():
        ws = given(workspace)
    run_rec = _read_json(ws / "orient" / "run.json")
    if not isinstance(run_rec, dict):
        say(f"thimble demo --export: {workspace} is no workspace with an orientation")
        return 1
    if run_rec.get("status") != "done" or run_rec.get("queue"):
        say(f"thimble demo --export: the orientation of {ws.name} is {run_rec.get('status')}"
            + (" with follow-ups waiting" if run_rec.get("queue") else "") + "; export it once it is done")
        return 1
    name = args.dataset or ws.name
    rec = config.read_sidecar(ws.name, Path(env["data_dir"]))
    corpus = given(args.corpus) if args.corpus else Path(rec["path"]) if rec else None
    if corpus is None or not corpus.is_dir():
        say(f"thimble demo --export: the corpus folder of {ws.name} is unknown; pass --corpus")
        return 1
    out_path = given(out)
    if not (out_path / MANIFEST).is_file() and out_path.name != name:
        out_path = out_path / name
    try:
        m = export(ws, corpus, out_path, name=name, allow_private=args.allow_private, scrub_user=args.scrub_user,
                   app=given(args.app) if args.app else None,
                   claude_dir=given(args.claude_config) if args.claude_config else None,
                   transcript=not args.no_transcript)
    except DemoError as e:
        say(f"thimble demo --export: {e}")
        return 1
    size = sum(f.stat().st_size for f in out_path.rglob("*") if f.is_file())
    c = m["counts"]
    say(f"wrote {out_path} ({human(size)}): {c['cards']} cards, {c['labels']} labels, {c['views']} views, "
        f"{c['documents']} documents, {c['chats']} chats; {len(m['files'])} files kept, {len(m['left_out'])} left out; "
        f"gitleaks: {m['gitleaks']}")
    for t in m["transcripts"]:
        say(f"  the orientation's transcript: {t['kept']} records kept, {sum(t['dropped'].values())} dropped "
            f"({', '.join(f'{k} {n}' for k, n in t['dropped'].items())})")
    if m["flagged"]:
        say(f"  {len(m['flagged'])} findings kept with --allow-private; they are listed in the manifest")
    if m["marked_done"]:
        say(f"  {len(m['marked_done'])} chats said they were running and are written done: "
            + ", ".join(m["marked_done"]) + "; export again once they end if they still run")
    if m["typed_in_main"]:
        say(f"  main's chat keeps {len(m['typed_in_main'])} messages you typed: "
            + "; ".join(repr(t) for t in m["typed_in_main"][:5]))
    if name in DATASETS:
        mism = [f["path"] for f in m["corpus"] if DATASETS[name].expected.get(f["path"]) not in (None, f["sha256"])]
        if mism:
            say(f"  warning: the corpus differs from what `thimble demo` downloads: {', '.join(mism)}")
    say("  read it before you commit it (demos/README.md), then `python3 scripts/check_content.py` checks it")
    return 0


def add_parser(sub: Any) -> None:
    p = sub.add_parser("demo", help="download public datasets (collusion-wiki, rubyhack, mythos-5) and open each on a "
                                    "pre-cached orientation; asks before each download")
    p.add_argument("names", nargs="*", metavar="name", help=f"the datasets (default: all of {', '.join(DATASETS)})")
    p.add_argument("-y", "--yes", action="store_true", help="download without asking")
    p.add_argument("--dir", help=f"where the datasets go (default {DEFAULT_DIR}/<name>)")
    p.add_argument("--list", action="store_true", help="list the datasets and their sources; download nothing")
    p.add_argument("--attach", action="store_true",
                   help="start a Claude Code session (thimble) on the workspace instead of only opening it")
    p.add_argument("--replace", action="store_true",
                   help="archive a workspace that holds an analysis already and install the pre-cache in its place")
    p.add_argument("--precaches", metavar="DIR",
                   help="install the pre-caches in DIR/<name> instead of the repository's demos/<name>")
    p.add_argument("--export", nargs=2, metavar=("WORKSPACE", "OUT"),
                   help="maintainers: write the pre-cache of WORKSPACE (a name or a folder) as the folder "
                        "OUT/<dataset>")
    p.add_argument("--dataset", help="with --export: the dataset the pre-cache is for (default: the workspace's name)")
    p.add_argument("--corpus", help="with --export: the workspace's corpus folder, when thimble does not know it")
    p.add_argument("--app", help="with --export: the thimble install the orientation ran in, when it is not this one")
    p.add_argument("--claude-config", metavar="DIR",
                   help="with --export: the Claude Code config folder the orientation ran with (default "
                        "CLAUDE_CONFIG_DIR, else ~/.claude)")
    p.add_argument("--no-transcript", action="store_true",
                   help="with --export: leave out the orientation's transcript (a follow-up then starts a new one)")
    p.add_argument("--scrub-user", action="store_true",
                   help="with --export: write `user` in place of your user name where it stands as a word")
    p.add_argument("--allow-private", action="store_true",
                   help="with --export: write the pre-cache even when it holds the user name or absolute paths")
    p.set_defaults(fn=lambda a: run(a))
