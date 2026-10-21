"""Report a problem with thimble: the chat agent drafts an issue, the person previews the exact text and sends it.

The agent writes the issue text with the tool draft_report (what happened, expected, a reproduction on made-up data).
The server adds thimble's version and settings, runs the privacy scan (privacy.py, the kernel's own file) over every
byte, puts a placeholder in place of each hit, and tells the page, which opens the preview. Only the person's click
sends: the routes that keep a hit, edit the text or send need the ask id, which only the page reads (GET current) and
the agent never sees. The agent has no tool that sends.

Sending runs the program THIMBLE_GH names (default `gh`): one issue on thimble's repository, under the person's own
GitHub login. Save as file gives the page one Markdown file to download. thimble browser does not fix thimble's code
itself: a fix is made from the terminal plugin for now.

The files, as the terminal's `thimble fix` keeps them (kind report), under the browser's home:
    fixes/<slug>/fix.json         {slug, title, kind: report, status: drafted|sent|saved, created, workspace, url?}
    fixes/<slug>/draft.md         the agent's text before the scan (stays on this machine)
    fixes/<slug>/share/issue.md   the exact issue text, title on line 1 as "# ...", after the scan's removals
    fixes/<slug>/share/scan.json  the hits: [{id, kind, found, replacement, where, kept}]
    fixes/<slug>/share/ask.json   {id, created} while the preview waits for the person

    GET  /api/ws/{c}/issues/current             the draft the person has not answered yet, with its ask id, or null
    PUT  /api/ws/{c}/issues/{slug}              {text, ask}: the person's edit; the scan runs again
    POST /api/ws/{c}/issues/{slug}/keep         {hit, keep, ask}: keep a removed hit, or remove it again
    POST /api/ws/{c}/issues/{slug}/send         {answer: send|file|cancel, ask}: send as an issue, save as a file, or
                                                close the preview
"""
from __future__ import annotations

import csv
import getpass
import json
import os
import platform
import re
import secrets
import socket
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from fastapi import Body, HTTPException

from . import __version__, home, privacy, settings
from .hub import hub
from .tools import Result

REPO = "safety-research/thimble"
SOURCE_ROOT = Path(__file__).resolve().parents[2]  # browser/: the words of thimble's own source pass the scan
GH_TIMEOUT_S = 60
SAMPLE_FILES = 60
SAMPLE_LINES = 20
VALUE_MAX = 80
MIN_TERM = 3
WALK_MAX = 5000
SOURCE_EXT = {".py", ".ts", ".tsx", ".js", ".mjs", ".md", ".json", ".css", ".sh", ".toml", ".html"}
SKIP_DIRS = {"node_modules", "dist", ".git", "__pycache__", ".venv", "fixtures", "samples", "tests", "test"}
_WORD = re.compile(r"[A-Za-z0-9_.-]+")


def gh() -> str:
    return os.environ.get("THIMBLE_GH") or "gh"


def fixes_dir() -> Path:
    d = home.root() / "fixes"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _slug(title: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40].strip("-") or "report"
    return f"{base}-{secrets.token_hex(2)}"


# ---- what the session read: field names and string values of the folder's records, for the scan

def _record_terms(folder: Path) -> tuple[set[str], set[str]]:
    """Field names and short string values from the first records of the folder's CSV, JSON Lines and JSON files."""
    fields: set[str] = set()
    values: set[str] = set()

    def take(obj: Any, depth: int = 0) -> None:
        if depth > 3:
            return
        if isinstance(obj, dict):
            for k, v in obj.items():
                fields.add(str(k))
                take(v, depth + 1)
        elif isinstance(obj, list):
            for v in obj[:SAMPLE_LINES]:
                take(v, depth + 1)
        elif isinstance(obj, str) and 3 <= len(obj) <= VALUE_MAX:
            values.add(obj)

    n = 0
    for d, dirs, files in os.walk(folder):
        dirs[:] = sorted(x for x in dirs if not x.startswith(".") and x != "thimble")
        for f in sorted(files):
            p = Path(d) / f
            if n >= SAMPLE_FILES:
                return fields, values
            try:
                if p.suffix.lower() in (".csv", ".tsv"):
                    n += 1
                    with p.open(newline="", errors="ignore") as fh:
                        rows = csv.reader(fh, delimiter="\t" if p.suffix.lower() == ".tsv" else ",")
                        for i, row in enumerate(rows):
                            if i > SAMPLE_LINES:
                                break
                            (fields if i == 0 else values).update(c for c in row if 3 <= len(c) <= VALUE_MAX)
                elif p.suffix.lower() == ".jsonl":
                    n += 1
                    with p.open(errors="ignore") as fh:
                        for i, line in enumerate(fh):
                            if i >= SAMPLE_LINES:
                                break
                            try:
                                take(json.loads(line))
                            except ValueError:
                                pass
                elif p.suffix.lower() == ".json" and p.stat().st_size < 2_000_000:
                    n += 1
                    take(json.loads(p.read_text(errors="ignore")))
            except (OSError, ValueError):
                continue
    return fields, values


@lru_cache(maxsize=4)
def source_words(root: str) -> frozenset[str]:
    """Every word of thimble's own source under `root`, lowercased: a session term among them does not count."""
    out: set[str] = set()
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.startswith(".")]
        for f in files:
            if Path(f).suffix not in SOURCE_EXT:
                continue
            try:
                text = (Path(d) / f).read_text(errors="ignore")
            except OSError:
                continue
            for w in _WORD.findall(text):
                out.add(w.lower())
                out.update(p.lower() for p in re.split(r"[._-]", w) if p)
    return frozenset(out)


def known(terms: list[str]) -> set[str]:
    """The scan's `known`: the terms that are words of thimble's own source, so "card" and "rows" pass."""
    words = source_words(str(SOURCE_ROOT))
    return {t for t in terms if t.lower() in words}


def _git(key: str) -> str:
    try:
        return subprocess.run(["git", "config", "--get", key], capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def session_terms(folder: Path | str | None, fields: Iterable[str] = (), values: Iterable[str] = ()) -> dict[str, list[str]]:
    """The terms of this person and session, by kind, built locally: user, host, git identity, the data folder's path
    and the names under it, and the field names and string values the caller passes. A term of one or two letters, or a
    number, would match all over the text, so it is left out."""
    terms: dict[str, set[str]] = {k: set() for k in ("name", "host", "git", "path", "folder", "file", "field", "value")}
    try:
        terms["name"].add(getpass.getuser())
    except (OSError, KeyError):
        pass
    terms["name"].add(Path.home().name)
    terms["path"].add(str(Path.home()))
    host = socket.gethostname()
    terms["host"].update({host, host.split(".")[0]})
    terms["git"].update(x for x in (_git("user.name"), _git("user.email")) if x)
    if folder:
        root = Path(folder)
        terms["path"].update({str(root), str(root.resolve())})
        terms["folder"].add(root.name)
        n = 0
        for d, dirs, files in os.walk(root):
            dirs[:] = sorted(x for x in dirs if not x.startswith(".") and x != "thimble")
            for x in dirs:
                terms["folder"].add(x)
            for f in files:
                terms["file"].add(f)
                if len(Path(f).stem) >= 4:
                    terms["file"].add(Path(f).stem)
            n += len(dirs) + len(files)
            if n > WALK_MAX:
                break
    terms["field"].update(str(x) for x in fields)
    terms["value"].update(str(x) for x in values)
    return {k: sorted(x for x in v if len(x) >= MIN_TERM and not x.isdigit()) for k, v in terms.items() if v}


def _terms(ws: str) -> dict[str, list[str]]:
    try:
        folder = home.corpus_of(ws)
    except KeyError:
        return session_terms(None)
    fields, values = _record_terms(folder)
    return session_terms(folder, fields, values)


# ---- the draft

def version_section() -> str:
    s = settings.read()
    from . import features  # noqa: PLC0415

    feats = " · ".join(f"{f['name']} {'on' if f['on'] else 'off'}" for f in features.listing())
    return (f"## thimble\nthimble browser {__version__} · {platform.system() or 'unknown OS'}\n"
            f"Settings: model {s['model']} · effort {s['effort']} · {feats}")


def footer(removed: int) -> str:
    return (f"Written with Claude in thimble; a privacy scan removed {removed} "
            f"detail{'' if removed == 1 else 's'} before the tester's review.")


def _dir(slug: str) -> Path:
    if not re.fullmatch(r"[a-z0-9-]{1,60}", slug):
        raise HTTPException(404, f"no report {slug!r}")
    d = fixes_dir() / slug
    if not (d / "fix.json").is_file():
        raise HTTPException(404, f"no report {slug!r}")
    return d


def _render(d: Path) -> str:
    """Write share/issue.md from the draft and the hits as they stand; the text."""
    hits = home.read_json(d / "share" / "scan.json", []) or []
    text = privacy.redact((d / "draft.md").read_text(), hits)
    removed = sum(1 for h in hits if not h.get("kept"))
    out = f"{text.rstrip()}\n\n{footer(removed)}\n"
    (d / "share" / "issue.md").write_text(out)
    return out


def _rescan(d: Path, ws: str) -> list[dict[str, Any]]:
    text = (d / "draft.md").read_text()
    # a path inside thimble's own tree becomes its path in the repository
    hits, _notes = privacy.scan({"issue": text}, _terms(ws), known=known,
                                repo_paths=[(str(SOURCE_ROOT.parent) + os.sep, "")])
    home.write_json(d / "share" / "scan.json", hits)
    _render(d)
    return hits


def make_draft(ws: str, title: str, body: str) -> tuple[str, int]:
    """A new report drafted from the agent's title and body: scanned, with an ask waiting. (slug, details removed)."""
    title = " ".join(title.split()) or "A problem in thimble"
    slug = _slug(title)
    d = fixes_dir() / slug
    (d / "share").mkdir(parents=True)
    (d / "draft.md").write_text(f"# {title}\n\n{body.strip()}\n\n{version_section()}\n")
    home.write_json(d / "fix.json", {"slug": slug, "title": title, "kind": "report", "status": "drafted",
                                     "created": home.now(), "workspace": ws})
    hits = _rescan(d, ws)
    home.write_json(d / "share" / "ask.json", {"id": secrets.token_urlsafe(16), "created": home.now()})
    hub.publish(ws, {"type": "issue", "slug": slug})
    return slug, len(hits)


def current(ws: str) -> dict[str, Any] | None:
    """The newest report of this workspace that waits for the person, as the preview reads it."""
    best: tuple[str, Path] | None = None
    for d in fixes_dir().iterdir():
        meta = home.read_json(d / "fix.json", {}) or {}
        if meta.get("workspace") == ws and meta.get("status") == "drafted" and (d / "share" / "ask.json").is_file():
            if best is None or meta.get("created", "") > best[0]:
                best = (meta.get("created", ""), d)
    return view(best[1]) if best else None


def view(d: Path) -> dict[str, Any]:
    meta = home.read_json(d / "fix.json", {}) or {}
    ask = home.read_json(d / "share" / "ask.json", {}) or {}
    hits = home.read_json(d / "share" / "scan.json", []) or []
    return {"slug": meta.get("slug"), "title": meta.get("title"), "status": meta.get("status"),
            "text": (d / "share" / "issue.md").read_text(), "draft": (d / "draft.md").read_text(),
            "hits": [{**h, "keepable": privacy.keepable(h)} for h in hits], "ask": ask.get("id"), "repo": REPO,
            "url": meta.get("url")}


def _check_ask(d: Path, ask: Any) -> None:
    want = (home.read_json(d / "share" / "ask.json", {}) or {}).get("id")
    if not want or not isinstance(ask, str) or not secrets.compare_digest(want, ask):
        raise HTTPException(403, "only the person's own click in the preview answers it")


def login() -> str | None:
    """The person's GitHub login through THIMBLE_GH, or None when gh is missing or not signed in."""
    try:
        p = subprocess.run([gh(), "api", "user", "--jq", ".login"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    name = p.stdout.strip()
    return name if p.returncode == 0 and re.fullmatch(r"[A-Za-z0-9-]{1,39}", name) else None


def send_issue(d: Path) -> str:
    """Open the issue on thimble's repository with THIMBLE_GH, the body read from share/issue.md; its URL."""
    text = (d / "share" / "issue.md").read_text()
    first, _, body = text.partition("\n")
    title = first.lstrip("# ").strip()
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(body.lstrip("\n"))
        body_file = f.name
    try:
        p = subprocess.run([gh(), "issue", "create", "--repo", REPO, "--title", title, "--body-file", body_file],
                           capture_output=True, text=True, timeout=GH_TIMEOUT_S)
    except FileNotFoundError:
        raise HTTPException(409, "gh is not installed: install GitHub's gh and run `gh auth login`, or Save as file") from None
    except subprocess.SubprocessError as e:
        raise HTTPException(409, f"gh did not finish: {e}. Try again, or Save as file") from None
    finally:
        os.unlink(body_file)
    if p.returncode != 0:
        why = (p.stderr or p.stdout).strip().splitlines()[-1:] or ["no message"]
        raise HTTPException(409, f"gh could not open the issue: {why[0]}. Run `gh auth login`, or Save as file")
    m = re.search(r"https://\S+", p.stdout)
    return m.group(0) if m else p.stdout.strip()


# ---- the agent's tool

async def draft_report(t: Any, args: dict[str, Any]) -> Result:
    slug, n = make_draft(t.ws, str(args.get("title") or ""), str(args.get("body") or ""))
    removed = "1 detail was removed" if n == 1 else f"{n} details were removed"
    return Result(f"The person is reviewing the draft in a preview; {removed} by the privacy scan. "
                  "Nothing is sent until they choose to send it.")



# ---- the routes

def register(ctx: Any) -> None:
    app = ctx.app

    @app.get("/api/ws/{c}/issues/current")
    def issue_current(c: str) -> Any:
        ctx.ws_of(c)
        got = current(c)
        if got is not None:
            got["login"] = login()
        return got

    @app.put("/api/ws/{c}/issues/{slug}")
    def issue_edit(c: str, slug: str, body: dict = Body(...)) -> dict[str, Any]:
        ctx.ws_of(c)
        d = _dir(slug)
        _check_ask(d, body.get("ask"))
        text = str(body.get("text") or "")
        first = text.lstrip().splitlines()[0] if text.strip() else ""
        if not first.startswith("# "):
            raise HTTPException(400, 'the text starts with its title as "# ..."')
        foot = re.compile(r"\n*Written with Claude in thimble; a privacy scan removed \d+ details? before the tester's review\.\s*$")
        (d / "draft.md").write_text(foot.sub("\n", text).rstrip() + "\n")
        meta = home.read_json(d / "fix.json", {})
        home.write_json(d / "fix.json", {**meta, "title": first[2:].strip()})
        _rescan(d, c)
        return {**view(d), "login": None}

    @app.post("/api/ws/{c}/issues/{slug}/keep")
    def issue_keep(c: str, slug: str, body: dict = Body(...)) -> dict[str, Any]:
        ctx.ws_of(c)
        d = _dir(slug)
        _check_ask(d, body.get("ask"))
        hits = home.read_json(d / "share" / "scan.json", []) or []
        hit = next((h for h in hits if h.get("id") == body.get("hit")), None)
        if hit is None:
            raise HTTPException(404, f"no scan hit {body.get('hit')!r}")
        if not privacy.keepable(hit):
            raise HTTPException(400, "a key or a token is never sent: edit the text instead")
        hit["kept"] = bool(body.get("keep", True))
        home.write_json(d / "share" / "scan.json", hits)
        _render(d)
        return view(d)

    @app.post("/api/ws/{c}/issues/{slug}/send")
    def issue_send(c: str, slug: str, body: dict = Body(...)) -> dict[str, Any]:
        ctx.ws_of(c)
        d = _dir(slug)
        _check_ask(d, body.get("ask"))
        answer = body.get("answer")
        meta = home.read_json(d / "fix.json", {}) or {}
        if answer == "send":
            url = send_issue(d)
            meta.update(status="sent", url=url)
        elif answer == "file":
            md = (d / "share" / "issue.md").read_text()
            meta.update(status="saved")
            (d / "share" / "ask.json").unlink(missing_ok=True)
            home.write_json(d / "fix.json", meta)
            return {"status": "saved", "markdown": md, "filename": f"thimble-report-{slug}.md"}
        elif answer == "cancel":
            (d / "share" / "ask.json").unlink(missing_ok=True)
            return {"status": meta.get("status")}
        else:
            raise HTTPException(400, "answer is send, file or cancel")
        (d / "share" / "ask.json").unlink(missing_ok=True)
        home.write_json(d / "fix.json", meta)
        return {"status": meta["status"], "url": meta.get("url")}
