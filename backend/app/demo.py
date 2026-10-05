"""`thimble demo`: three public datasets, each opened on an orientation run ahead of time.

    thimble demo [NAME...] [--yes] [--dir DIR] [--no-start] [--replace] [--precaches DIR]
    thimble demo --export WORKSPACE OUT [--dataset NAME] [--allow-private]      (maintainers)

The command lists the datasets (demo_data.DATASETS) with their sources and sizes, asks before each download (--yes
answers yes for all), rebuilds each dataset from its publisher's files into DIR/<name> (default ~/thimble-demo) and
checks it against the copy the orientations ran on. It then registers the folder as a corpus, installs that dataset's
pre-cached orientation as its workspace, and starts thimble in the first folder (or prints the command).

The pre-cache. A zip `<name>.thimble-demo.zip` holding `thimble-demo-precache.json` (the manifest) and `workspace/`,
the files of a workspace after its orientation: the cards (notebooks/), the labels' definitions (concepts/) and
results (labels/*.jsonl), the views (views/ and the local extension, extension/), the documents (investigations/),
the chats and the orientation's thread with its calls (chats/, calls/), the orientation's record and the files its
cards read (orient/run.json, summary.md, work/). What thimble rebuilds or keeps per machine is left out: label
indexes (*.sqlite), view caches and indexes, kernels, the scratch mirror of the corpus, telemetry, the files viewed,
sessions and permissions, undo, card-check pictures. Absolute paths are written as placeholders (PLACEHOLDERS) and
filled in on install, and the export refuses (without --allow-private) while the exporter's user name or another
absolute path remains, and runs gitleaks on the files when it is installed.

Where pre-caches live. The repository holds demos/precaches.json: per dataset, the release asset's URL, its size and
SHA-256. The zips go up as assets of a GitHub release rather than into the tree, since scripts/check_content.py keeps
.jsonl files out of the tree and a zip in the tree would carry them past that check and past gitleaks unscanned. A
dataset without an entry opens without one; --precaches DIR installs `<name>.thimble-demo.zip` files from DIR instead.
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
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import config, demo_data
from .demo_data import DATASETS, Dataset

SCHEMA = "thimble-demo-precache"
VERSION = 1
MANIFEST = "thimble-demo-precache.json"
SUFFIX = ".thimble-demo.zip"
CATALOG = config.REPO_ROOT / "demos" / "precaches.json"
DEFAULT_DIR = Path("~/thimble-demo")
PLACEHOLDERS = {"workspace": "@@THIMBLE_WORKSPACE@@", "corpus": "@@THIMBLE_CORPUS@@", "app": "@@THIMBLE_APP@@",
                "home": "@@THIMBLE_HOME@@"}
SCRUBBED_USER = "user"  # what --scrub-user writes in place of the exporter's user name

# What a pre-cache keeps, by the first part of the path in the workspace; anything else is listed as left out.
KEEP_TOP = {"notebooks", "concepts", "labels", "filters.json", "views", "extension", "extensions", "registry",
            "investigations", "chats", "calls", "orient", "canvas-history.jsonl", "settings.json", "config.json",
            "checks", "card-checks"}
REBUILT = {"scratch": "the kernels' mirror of the corpus, rebuilt", "kernels": "kernel state",
           "view-indexes": "views' indexes, rebuilt", "telemetry.jsonl": "the maintainer's browser telemetry",
           "viewed.jsonl": "the files the maintainer opened", "sessions.json": "the maintainer's Claude Code sessions",
           "bg-sessions.json": "the maintainer's background sessions", "permissions.jsonl": "permission answers",
           "undo.jsonl": "the undo history", "render-theme.json": "the browser's theme", "unheard.json": "per session"}
SKIP_PARTS = {"__pycache__", "cache", "trash", "tmp"}
SKIP_SUFFIXES = (".sqlite", ".sqlite-wal", ".sqlite-shm", ".lock", ".log", ".tmp", ".pyc", ".png")
DOT_OK = {"views", "extension"}  # where dot files are thimble's own records (views/.versions, .reviewed)
WORK_FILE_MAX = 5_000_000  # a file in orient/work larger than this is left out (cards keep their outputs)
TEXT_SUFFIXES = (".json", ".jsonl", ".md", ".txt", ".py", ".html", ".csv", ".js", ".css", ".tsv", ".yaml", ".yml")
SECRET_KEY_RE = re.compile(r"key|token|secret|password|credential", re.I)
ABS_PATH_RE = re.compile(r"(?<![\w.@])/(?:home|Users|mnt|tmp|private|var/folders|root)/[\w.@+-]+")
# zip entry names a pre-cache may hold: relative, no `..`, no backslash
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


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1000 or unit == "GB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.1f} GB"


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


def _forms(path: str) -> list[str]:
    """The ways an absolute path is written in a workspace's files: as is, JSON-escaped, and with a trailing slash."""
    esc = json.dumps(path)[1:-1]
    return list(dict.fromkeys([path, esc]))


def placeholder_pairs(workspace: Path, corpus: Path, home: Path, app: Path) -> list[tuple[str, str]]:
    """(absolute path, placeholder) for the workspace, the corpus, thimble's install and the home folder, longest path
    first, so a workspace inside the home folder is written as the workspace's placeholder."""
    pairs = []
    for key, p in (("workspace", workspace), ("corpus", corpus), ("app", app), ("home", home)):
        for form in {str(p), str(p.resolve())}:
            pairs += [(f, PLACEHOLDERS[key]) for f in _forms(form)]
    return sorted(set(pairs), key=lambda kv: -len(kv[0]))


TRUNCATED_RE = re.compile(r"/[^\s'\"`\\…]{3,}(?:…|\\u2026)")  # a path a summary cut short: `/home/a…`


def with_placeholders(text: str, pairs: list[tuple[str, str]]) -> str:
    """`text` with each path of `pairs` written as its placeholder, also where a summary cut it short (`/home/a…`)."""
    def cut(m: re.Match[str]) -> str:
        ell = "…" if m.group().endswith("…") else "\\u2026"
        head = m.group()[: -len(ell)]
        return next((new + ell for old, new in pairs if old.startswith(head) and len(head) >= 5), m.group())

    if "…" in text or "\\u2026" in text:
        text = TRUNCATED_RE.sub(cut, text)
    for old, new in pairs:
        text = text.replace(old, new)
    return text


def is_text(rel: Path, data: bytes) -> bool:
    if rel.suffix.lower() in TEXT_SUFFIXES:
        return True
    return b"\x00" not in data[:4096] and _decodes(data)


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


def findings(text: str, user: str) -> list[str]:
    """What in a file's text after the placeholders could be private: the exporter's user name, absolute paths."""
    out = []
    if user and len(user) >= 3 and re.search(rf"(?<![\w]){re.escape(user)}(?![\w])", text):
        out.append(f"the user name {user!r}")
    out += sorted({m.group() for m in ABS_PATH_RE.finditer(text)})[:5]
    return out


def chat_summary(ws: Path) -> dict[str, Any]:
    """The orientation's chat meta (model, effort), for the manifest."""
    run = _read_json(ws / "orient" / "run.json") or {}
    cid = ((run.get("chats") or {}) if isinstance(run, dict) else {}).get("orient")
    meta = _read_json(ws / "chats" / f"{cid}.meta.json") if cid else None
    return meta if isinstance(meta, dict) else {}


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
           allow_private: bool = False, scrub_user: bool = False,
           scan: Callable[[Path], list[str] | None] = gitleaks_scan) -> dict[str, Any]:
    """Write the pre-cache of workspace folder `ws`, made on corpus folder `corpus`, to the zip `out`; the manifest.
    DemoError, and nothing written, when something private remains (unless `allow_private`). `scrub_user` writes
    SCRUBBED_USER in place of the user name where it stands as a word (in `ls -l` output, say)."""
    home = home or Path.home()
    user = getpass.getuser() if user is None else user
    pairs = placeholder_pairs(ws, corpus, home, config.REPO_ROOT)
    user_re = re.compile(rf"(?<![\w]){re.escape(user)}(?![\w])") if user and len(user) >= 3 else None
    scrubbed = 0
    files: list[dict[str, Any]] = []
    left: list[dict[str, Any]] = []
    flagged: list[str] = []
    typed: list[str] = []
    with tempfile.TemporaryDirectory(prefix="thimble-demo-export-") as tmp:
        stage = Path(tmp) / "workspace"
        for p in sorted(ws.rglob("*")):
            if not p.is_file() or p.is_symlink():
                continue
            rel = p.relative_to(ws)
            size = p.stat().st_size
            why = kept(rel, size)
            if why:
                left.append({"path": rel.as_posix(), "bytes": size, "why": why})
                continue
            data = p.read_bytes()
            if rel.as_posix() == "settings.json":
                data = _settings(data)
            elif rel.as_posix() == "orient/run.json":
                data = _run_record(data)
            elif rel.as_posix() == "chats/main.jsonl":
                data, typed = main_chat(data)
            if is_text(rel, data) and _decodes(data):
                text = with_placeholders(data.decode("utf-8"), pairs)
                if scrub_user and user_re is not None:
                    text, n = user_re.subn(SCRUBBED_USER, text)
                    scrubbed += n
                flagged += [f"{rel.as_posix()}: {f}" for f in findings(text, user)]
                data = text.encode("utf-8")
            dest = stage / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            files.append({"path": rel.as_posix(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        leaks = scan(stage)
        flagged += [f"gitleaks: {x}" for x in leaks or []]
        if flagged and not allow_private:
            raise DemoError("the pre-cache would carry what may be private; nothing was written:\n  "
                            + "\n  ".join(flagged[:40]) + ("\n  …" if len(flagged) > 40 else "")
                            + "\n--scrub-user writes `user` in place of the user name; --allow-private keeps the rest")
        run = _read_json(ws / "orient" / "run.json") or {}
        meta = chat_summary(ws)
        manifest = {
            "schema": SCHEMA, "version": VERSION, "dataset": name, "created": now(),
            "thimble": {"version": _thimble_version(), "commit": _commit()},
            "orientation": {k: run.get(k) for k in ("status", "passes", "query", "effort", "ultracode", "critique",
                                                    "started", "ended") if isinstance(run, dict)}
                           | {"model": meta.get("model"), "chat_effort": meta.get("effort")},
            "counts": counts(ws),
            "corpus": corpus_files(corpus),
            "placeholders": PLACEHOLDERS,
            "files": files,
            "left_out": left,
            "gitleaks": "not installed" if leaks is None else f"{len(leaks)} findings",
            "user_name_scrubbed": scrubbed,
            "typed_in_main": typed,
            "flagged": flagged,
        }
        out.parent.mkdir(parents=True, exist_ok=True)
        part = out.with_name(out.name + ".part")
        with zipfile.ZipFile(part, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            zf.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=1))
            for f in files:
                zf.write(stage / f["path"], f"workspace/{f['path']}")
        part.replace(out)
    return manifest


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


def read_manifest(zf: zipfile.ZipFile) -> dict[str, Any]:
    try:
        m = json.loads(zf.read(MANIFEST))
    except (KeyError, ValueError) as e:
        raise DemoError(f"not a thimble demo pre-cache ({MANIFEST} missing or unreadable)") from e
    if m.get("schema") != SCHEMA or not isinstance(m.get("version"), int) or m["version"] > VERSION:
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


def install(zip_path: Path, ws: Path, corpus: Path, *, home: Path | None = None) -> dict[str, Any]:
    """Install the pre-cache `zip_path` as the workspace folder `ws` (which must not exist), its placeholders filled
    with `ws`, `corpus` and the home folder; the manifest, with `warnings` for corpus files that differ."""
    home = home or Path.home()
    values = {"workspace": str(ws), "corpus": str(corpus), "app": str(config.REPO_ROOT), "home": str(home)}
    if ws.exists():
        raise DemoError(f"{ws} exists")
    with zipfile.ZipFile(zip_path) as zf:
        manifest = read_manifest(zf)
        names = [n for n in zf.namelist() if n.startswith("workspace/") and not n.endswith("/")]
        bad = [n for n in names if not SAFE_NAME.match(n)]
        if bad:
            raise DemoError(f"the pre-cache holds unsafe paths: {bad[:3]}")
        ws.parent.mkdir(parents=True, exist_ok=True)
        tmp = ws.parent / f".{ws.name}.demo-{secrets.token_hex(4)}"
        try:
            for n in names:
                rel = n[len("workspace/"):]
                data = zf.read(n)
                if is_text(Path(rel), data) and _decodes(data):
                    text = data.decode("utf-8")
                    js = rel.endswith((".json", ".jsonl"))
                    for key, ph in PLACEHOLDERS.items():
                        if ph in text:
                            text = text.replace(ph, json.dumps(values[key])[1:-1] if js else values[key])
                    data = text.encode("utf-8")
                dest = tmp / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
            run_path = tmp / "orient" / "run.json"
            run = _read_json(run_path)
            if isinstance(run, dict):
                run["precached"] = {"dataset": manifest.get("dataset"), "created": manifest.get("created"),
                                    "installed": now(), "thimble": manifest.get("thimble")}
                run_path.write_text(json.dumps(run, ensure_ascii=False, indent=2), "utf-8")
            tmp.rename(ws)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
    manifest["warnings"] = corpus_mismatches(manifest, corpus)
    return manifest


# --------------------------------------------------------------------------- the catalog and downloads


def catalog(path: Path | None = None) -> dict[str, dict[str, Any]]:
    """demos/precaches.json's entries by dataset: {url, sha256, bytes, ...}; {} when it lists none."""
    data = _read_json(path or CATALOG)
    entries = data.get("precaches") if isinstance(data, dict) else None
    return {k: v for k, v in (entries or {}).items() if isinstance(v, dict) and v.get("url") and v.get("sha256")}


class Downloads:
    """Fetches with a cache in DIR/.downloads, so a second `thimble demo` downloads nothing again."""

    def __init__(self, root: Path, get: Callable[[str], bytes] = demo_data.http_get, say: Callable[[str], None] = print):
        self.root, self.get, self.say = root / ".downloads", get, say

    def __call__(self, url: str) -> bytes:
        p = self.root / hashlib.sha256(url.encode()).hexdigest()[:24]
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

    out = [*wrap("thimble demo: public datasets, each with an orientation already run on it, so thimble opens on its "
                 "cards, labels and views.", ""), ""]
    for i, d in enumerate(selected, 1):
        pc = cat.get(d.name)
        size = (f"Download {human(d.download_bytes)}, {human(d.disk_bytes)} on disk; "
                + (f"pre-cached orientation {human(pc.get('bytes') or 0)}." if pc else
                   "no pre-cached orientation published yet."))
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


def place_precache(ds: Dataset, folder: Path, root: Path, cat: dict[str, dict[str, Any]], local: Path | None,
                   url: str | None, env: dict[str, Any], replace: bool, fetch: Callable[[str], bytes],
                   say: Callable[[str], None]) -> str | None:
    """Install `ds`'s pre-cache as the workspace of `folder`: the workspace's name, or None when none was installed."""
    from . import cli  # noqa: PLC0415

    zip_path: Path | None = None
    if local is not None:
        zip_path = local / f"{ds.name}{SUFFIX}"
        if not zip_path.is_file():
            say(f"  no {zip_path.name} in {local}; {ds.name} opens without a pre-cached orientation")
            return None
    elif ds.name in cat:
        entry = cat[ds.name]
        data = fetch(entry["url"])
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            say(f"  the pre-cached orientation at {entry['url']} does not match demos/precaches.json; not installed")
            return None
        zip_path = root / ".downloads" / f"{ds.name}{SUFFIX}"
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        zip_path.write_bytes(data)
    else:
        say(f"  {ds.name} has no pre-cached orientation published yet; Start in thimble runs one")
        return None
    name = register(folder, url)
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
        if ws.exists():
            from . import ledger  # noqa: PLC0415

            dest = ledger.archive_path(name)
            dest.parent.mkdir(parents=True, exist_ok=True)
            ws.rename(dest)
            archived = str(dest)
        if archived:
            say(f"  the earlier workspace {name} is archived at {archived}")
    m = install(zip_path, ws, folder)
    c = m.get("counts") or {}
    say(f"  pre-cached orientation installed as workspace {name}: {c.get('cards', 0)} cards, {c.get('labels', 0)} "
        f"labels, {c.get('views', 0)} views")
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


def wrapped(say: Callable[[str], None], width: int = 110) -> Callable[[str], None]:
    """`say`, with a long line wrapped under its own indent (a command to copy is left whole)."""
    def out(line: str) -> None:
        if len(line) <= width or line.lstrip().startswith("cd "):
            say(line)
            return
        indent = line[: len(line) - len(line.lstrip())]
        for part in textwrap.wrap(line, width, subsequent_indent=indent + "  ", break_long_words=False,
                                  break_on_hyphens=False):
            say(part)

    return out


def run(args: argparse.Namespace, *, get: Callable[[str], bytes] = demo_data.http_get,
        say: Callable[[str], None] = print, start: Callable[[Path], None] = start_session,
        server: Callable[[Callable[[str], None]], tuple[str | None, dict[str, Any]]] = _server) -> int:
    say = wrapped(say)
    if args.export:
        return run_export(args, say)
    names = list(args.names or DATASETS)
    unknown = [n for n in names if n not in DATASETS]
    if unknown:
        say(f"thimble demo: no dataset {', '.join(unknown)}; the datasets are {', '.join(DATASETS)}")
        return 2
    selected = [DATASETS[n] for n in names]
    root = Path(args.dir or DEFAULT_DIR).expanduser().resolve()
    local = Path(args.precaches).expanduser().resolve() if args.precaches else None
    cat = catalog()
    for line in listing(selected, cat, root):
        say(line)
    if args.list:
        return 0
    fetch = Downloads(root, get, say)
    ready: list[tuple[Dataset, Path]] = []
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
            continue
        for w in warnings:
            say(f"  warning: {w}")
        say(f"  {ds.name}: {', '.join(ds.expected)} in {root / ds.name}"
            + (" (checked against the copy the orientation ran on)" if not warnings else ""))
        if ds.notice:
            say(f"  notice from the source: {ds.notice}")
        ready.append((ds, root / ds.name))
    if not ready:
        return 1 if selected else 0
    (root / "SOURCES.md").write_text(sources_md([d for d, _ in ready]), "utf-8")
    url, env = server(say)
    opened: list[tuple[Path, str | None]] = []
    for ds, folder in ready:
        try:
            name = place_precache(ds, folder, root, cat, local, url, env, args.replace, fetch, say)
        except (DemoError, demo_data.SourceError, OSError, zipfile.BadZipFile) as e:
            say(f"  {ds.name}: the pre-cached orientation was not installed: {e}")
            name = None
        opened.append((folder, name))
    say("")
    for folder, _ in opened:
        say(f"  cd {folder} && thimble")
    first = opened[0][0]
    if args.no_start or not sys.stdin.isatty() or not sys.stdout.isatty():
        return 0
    if _ask(f"Start thimble in {first} now? [Y/n] ", False, default=True):
        start(first)
    return 0


def run_export(args: argparse.Namespace, say: Callable[[str], None]) -> int:
    from . import cli  # noqa: PLC0415

    workspace, out = args.export
    env = cli.resolve_env()
    ws = Path(env["workspaces_dir"]) / workspace
    if not ws.is_dir():
        ws = Path(workspace).expanduser().resolve()
    if not (ws / "orient" / "run.json").is_file():
        say(f"thimble demo --export: {workspace} is no workspace with an orientation")
        return 1
    name = args.dataset or ws.name
    rec = config.read_sidecar(ws.name, Path(env["data_dir"]))
    corpus = Path(args.corpus).expanduser().resolve() if args.corpus else Path(rec["path"]) if rec else None
    if corpus is None or not corpus.is_dir():
        say(f"thimble demo --export: the corpus folder of {ws.name} is unknown; pass --corpus")
        return 1
    out_path = Path(out).expanduser().resolve()
    if out_path.is_dir() or not out_path.name.endswith(".zip"):
        out_path = out_path / f"{name}{SUFFIX}"
    try:
        m = export(ws, corpus, out_path, name=name, allow_private=args.allow_private, scrub_user=args.scrub_user)
    except DemoError as e:
        say(f"thimble demo --export: {e}")
        return 1
    size = out_path.stat().st_size
    digest = file_sha256(out_path)
    c = m["counts"]
    say(f"wrote {out_path} ({human(size)}): {c['cards']} cards, {c['labels']} labels, {c['views']} views, "
        f"{c['documents']} documents, {c['chats']} chats; {len(m['files'])} files kept, {len(m['left_out'])} left out; "
        f"gitleaks: {m['gitleaks']}")
    if m["flagged"]:
        say(f"  {len(m['flagged'])} findings kept with --allow-private; they are listed in the manifest")
    if m["typed_in_main"]:
        say(f"  main's chat keeps {len(m['typed_in_main'])} messages you typed: "
            + "; ".join(repr(t) for t in m["typed_in_main"][:5]))
    if name in DATASETS:
        mism = [f["path"] for f in m["corpus"] if DATASETS[name].expected.get(f["path"]) not in (None, f["sha256"])]
        if mism:
            say(f"  warning: the corpus differs from what `thimble demo` downloads: {', '.join(mism)}")
    say("  its entry for demos/precaches.json, once the zip is a release asset:")
    say("  " + json.dumps({name: {"url": f"https://github.com/{cli.release_repo()}/releases/download/<tag>/"
                                         f"{out_path.name}", "sha256": digest, "bytes": size}}))
    return 0


def add_parser(sub: Any) -> None:
    p = sub.add_parser("demo", help="download public datasets (collusion-wiki, rubyhack, mythos-5) and open each on a "
                                    "pre-cached orientation; asks before each download")
    p.add_argument("names", nargs="*", metavar="name", help=f"the datasets (default: all of {', '.join(DATASETS)})")
    p.add_argument("-y", "--yes", action="store_true", help="download without asking")
    p.add_argument("--dir", help=f"where the datasets go (default {DEFAULT_DIR}/<name>)")
    p.add_argument("--list", action="store_true", help="list the datasets and their sources; download nothing")
    p.add_argument("--no-start", action="store_true", help="print the command that starts thimble instead of running it")
    p.add_argument("--replace", action="store_true",
                   help="archive a workspace that holds an analysis already and install the pre-cache in its place")
    p.add_argument("--precaches", metavar="DIR", help="install <name>.thimble-demo.zip files from DIR instead of the "
                                                      "release assets demos/precaches.json names")
    p.add_argument("--export", nargs=2, metavar=("WORKSPACE", "OUT"),
                   help="maintainers: write the pre-cache of WORKSPACE (a name or a folder) to OUT (a .zip or a folder)")
    p.add_argument("--dataset", help="with --export: the dataset the pre-cache is for (default: the workspace's name)")
    p.add_argument("--corpus", help="with --export: the workspace's corpus folder, when thimble does not know it")
    p.add_argument("--scrub-user", action="store_true",
                   help="with --export: write `user` in place of your user name where it stands as a word")
    p.add_argument("--allow-private", action="store_true",
                   help="with --export: write the pre-cache even when it holds the user name or absolute paths")
    p.set_defaults(fn=lambda a: run(a))
