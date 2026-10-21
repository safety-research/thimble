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


def kernel_fixes() -> Path:
    """Where the kernel keeps the fixes that change thimble's code (fixcopy.py), as the terminal's `thimble fix`."""
    from .kernel_fix import fix  # noqa: PLC0415

    return fix.fixes_home()


def _is_kernel(d: Path) -> bool:
    return d.parent == kernel_fixes()


def _dir(slug: str) -> Path:
    if not re.fullmatch(r"[a-z0-9-]{1,80}", slug):
        raise HTTPException(404, f"no report {slug!r}")
    for d in (kernel_fixes() / slug, fixes_dir() / slug):
        if (d / "fix.json").is_file():
            return d
    raise HTTPException(404, f"no report {slug!r}")


class _NoFeed:
    """The kernel's change feed, which the browser does not read: its page hears of a draft on the hub instead."""

    def emit(self, ev: dict[str, Any]) -> None:
        pass


def draft_fix(ws: str, slug: str, title: str, body: str) -> tuple[str, int]:
    """The draft of a fix the agent made in a copy (fixcopy.py), built by the kernel: the issue, and when the copy has
    a change, the pull request's text and its diff, all scanned with this session's terms. (slug, details removed)."""
    from .kernel_fix import fix  # noqa: PLC0415

    fx = fix.load(slug)
    fx["workspace"] = ws
    fix.save(fx)
    title = " ".join(title.split()) or fx["title"]
    r = fix.draft(slug, None, None, text=f"# {title}\n\n{body.strip()}\n", terms=_terms(ws))
    hub.publish(ws, {"type": "issue", "slug": slug})
    return slug, r["removed"]


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
    best: tuple[float, Path] | None = None
    kd = kernel_fixes()
    for d in [*fixes_dir().iterdir(), *(kd.iterdir() if kd.is_dir() else [])]:
        meta = home.read_json(d / "fix.json", {}) or {}
        if meta.get("workspace") == ws and meta.get("status") == "drafted" and (d / "share" / "ask.json").is_file():
            when = _when(meta.get("created"))
            if best is None or when > best[0]:
                best = (when, d)
    return view(best[1]) if best else None


def _when(v: Any) -> float:
    """A fix's `created`: the kernel's is seconds, the browser's own an ISO time."""
    if isinstance(v, (int, float)):
        return float(v)
    try:
        from datetime import datetime  # noqa: PLC0415

        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def diff_files(diff: str) -> list[dict[str, Any]]:
    """The files a unified diff changes, each with its lines added and removed. Pure."""
    out: list[dict[str, Any]] = []
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.*) b/(.*)$", line)
            out.append({"path": m.group(2) if m else line[11:], "added": 0, "removed": 0})
        elif out and line.startswith("+") and not line.startswith("+++"):
            out[-1]["added"] += 1
        elif out and line.startswith("-") and not line.startswith("---"):
            out[-1]["removed"] += 1
    return out


def view(d: Path) -> dict[str, Any]:
    meta = home.read_json(d / "fix.json", {}) or {}
    ask = home.read_json(d / "share" / "ask.json", {}) or {}
    hits = home.read_json(d / "share" / "scan.json", []) or []
    out = {"slug": meta.get("slug"), "title": meta.get("title"), "status": meta.get("status"),
           "text": (d / "share" / "issue.md").read_text(),
           "draft": (d / "draft.md").read_text() if (d / "draft.md").is_file() else "",
           "hits": [{**h, "keepable": privacy.keepable(h) and (not _is_kernel(d) or not h.get("kept"))} for h in hits],
           "ask": ask.get("id"), "repo": meta.get("repo") or REPO, "url": meta.get("url") or meta.get("issue_url"),
           "kind": "change" if (d / "share" / "pr.md").is_file() else "request"}
    if (d / "share" / "pr.md").is_file():
        diff = (d / "share" / "diff.patch").read_text() if (d / "share" / "diff.patch").is_file() else ""
        out.update(pr=(d / "share" / "pr.md").read_text(), diff=diff, files=diff_files(diff))
    return out


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
    if args.get("slug"):
        slug, n = draft_fix(t.ws, str(args["slug"]), str(args.get("title") or ""), str(args.get("body") or ""))
    else:
        slug, n = make_draft(t.ws, str(args.get("title") or ""), str(args.get("body") or ""))
    removed = "1 detail was removed" if n == 1 else f"{n} details were removed"
    return Result(f"The person is reviewing the draft in a preview; {removed} by the privacy scan. "
                  "Nothing is sent until they choose to send it.")



def _send_fix(d: Path, slug: str, answer: Any, ask: Any) -> dict[str, Any]:
    """The person's answer to a fix's preview, through the kernel: send (a draft pull request and an issue, or an
    issue alone for a request), file (one Markdown file, nothing sent) or cancel."""
    from .kernel_fix import fix  # noqa: PLC0415

    if answer not in ("send", "file", "cancel"):
        raise HTTPException(400, "answer is send, file or cancel")
    try:
        fix.send(slug, answer, ask)
    except fix.FixError as e:
        raise HTTPException(409, f"{e}. Try again, or Save as file") from None
    meta = fix.load(slug)
    if meta.get("workspace"):
        hub.publish(meta["workspace"], {"type": "fix", "slug": slug, "status": meta.get("status")})
    if answer == "file":
        p = Path(meta.get("file") or "")
        return {"status": "saved", "markdown": p.read_text() if p.is_file() else "", "filename": p.name or f"thimble-{slug}.md",
                "path": str(p)}
    return {"status": meta.get("status"), "url": meta.get("issue_url"), "pr_url": meta.get("pr_url")}


def fixes_of(ws: str) -> dict[str, Any]:
    """This workspace's fixes of thimble's code as the page's fix line reads them, and the one turned on."""
    from .kernel_fix import fix  # noqa: PLC0415

    out = []
    for slug in fix.all_slugs():
        try:
            fx = fix.load(slug)
        except fix.FixError:
            continue
        if fx.get("workspace") == ws:
            out.append({k: fx.get(k) for k in ("slug", "title", "status", "created", "pr_url", "issue_url")})
    out.sort(key=lambda f: _when(f.get("created")))
    return {"fixes": out, "active": fix.active_slug()}


# ---- the routes

def register(ctx: Any) -> None:
    app = ctx.app

    @app.get("/api/ws/{c}/fixes")
    def fixes_list(c: str) -> Any:
        ctx.ws_of(c)
        return fixes_of(c)

    @app.post("/api/ws/{c}/fixes/{slug}/use")
    def fixes_use(c: str, slug: str) -> Any:
        from .kernel_fix import fix  # noqa: PLC0415

        ctx.ws_of(c)
        try:
            said = fix.use(slug)
        except fix.FixError as e:
            raise HTTPException(409, str(e)) from None
        hub.publish(c, {"type": "fix", "slug": slug, "status": fix.load(slug).get("status")})
        return {**fixes_of(c), "said": said}

    @app.post("/api/ws/{c}/fixes/undo")
    def fixes_undo(c: str) -> Any:
        from .kernel_fix import fix  # noqa: PLC0415

        ctx.ws_of(c)
        try:
            said = fix.undo()
        except fix.FixError as e:
            raise HTTPException(409, str(e)) from None
        hub.publish(c, {"type": "fix", "slug": "", "status": "undone"})
        return {**fixes_of(c), "said": said}

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
        if _is_kernel(d):
            from .kernel_fix import fix  # noqa: PLC0415

            # the kernel's footer goes, and the pull request's text comes back as the draft's "## Change"
            issue = re.split(r"\n---\nthimble ", text, maxsplit=1)[0].rstrip()
            pr = (d / "share" / "pr.md").read_text() if (d / "share" / "pr.md").is_file() else ""
            try:
                fix.draft(slug, None, None, text=f"{issue}\n\n{pr}", terms=_terms(c))
            except fix.FixError as e:
                raise HTTPException(400, str(e)) from None
            return {**view(d), "login": None}
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
        if _is_kernel(d):
            from .kernel_fix import fix  # noqa: PLC0415

            if not body.get("keep", True):
                raise HTTPException(400, "a kept detail of a fix stays kept: edit the text to take it out")
            try:
                fix.keep(slug, str(hit["id"]), body.get("ask"), _NoFeed())
            except fix.FixError as e:
                raise HTTPException(400, str(e)) from None
            return view(d)
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
        if _is_kernel(d):
            return _send_fix(d, slug, answer, body.get("ask"))
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
