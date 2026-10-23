"""thimble fix share ID: a fix as a public GitHub issue that the person checks and submits themselves.

The draft is a title, what was wrong and how it was fixed, in plain words, with the thimble version and the mode. It is
Claude's text when the plugin or the browser gives one (`--draft -`, the JSON fix-draft.md asks for), else the one given
before for this fix, else the fix's own record: the person's words and what the fixer said the fix does. The privacy
scan (privacy.py, as `thimble fix draft` runs it) takes the names and values of the person's folder and machine out of
the draft first.

The command prints GitHub's new-issue link with the title and the text in it; `--open` opens the link in the person's
browser too. On GitHub's page the person reads the text, pastes a screenshot if they want and presses Submit. thimble
sends nothing at any point.

Under $THIMBLE_HOME/fixes/share/<id>/:

    share.json   what was shared: the title and text after the scan, the issue's link, what the scan took out
    given.json   the draft before the scan, which a later share of the same fix starts from; never shown or sent

THIMBLE_OPEN (a command, or `none`) replaces the command that opens the link, for tests.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

from . import fixes as FX
from . import privacy as P
from .store import Store

# GitHub takes a new-issue link of about 8,000 characters; thimble keeps its links under this
URL_MAX = 7000
STATES = ("on", "off", "ready", "redo", "request", "saved", "sent", "released", "failed")

# what the scan took out, in the person's words: (one, many)
KIND_WORDS = {
    "file": ("file name", "file names"), "folder": ("folder name", "folder names"), "path": ("path", "paths"),
    "name": ("name", "names"), "git": ("git name", "git names"), "host": ("machine name", "machine names"),
    "email": ("email address", "email addresses"), "token": ("key or token", "keys or tokens"),
    "key": ("key or token", "keys or tokens"), "generic": ("key or token", "keys or tokens"),
    "field": ("field name", "field names"), "value": ("value from your data", "values from your data"),
}


def share_dir(fid: int) -> Path:
    return FX.home() / "share" / str(fid)


def took_words(hits: list[dict[str, Any]]) -> str:
    """What the scan took out, as the shell and the page say it: `took 1 file name and 2 paths out of the text`."""
    kinds: dict[str, set[str]] = {}
    for h in hits:
        if not h.get("kept"):
            kinds.setdefault(KIND_WORDS.get(h["kind"], ("detail", "details"))[0], set()).add(h["found"])
    if not kinds:
        return "found nothing of yours to take out"
    many = {one: m for one, m in KIND_WORDS.values()}
    parts = [f"{len(v)} {one if len(v) == 1 else many.get(one, one + 's')}" for one, v in kinds.items()]
    return f"took {FX._and(parts)} out of the text"


def issue_url(title: str, body: str, repo: str) -> tuple[str, bool]:
    """GitHub's new-issue page with the title and the text in its link, under URL_MAX characters: (link, shortened).
    A text that does not fit is cut, and ends in `…`."""
    base = f"https://github.com/{repo}/issues/new"

    def url(b: str) -> str:
        return f"{base}?{urlencode({'title': title, 'body': b}, quote_via=quote)}"

    if len(url(body)) <= URL_MAX:
        return url(body), False
    lo, hi = 0, len(body)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if len(url(body[:mid].rstrip() + "…")) <= URL_MAX:
            lo = mid
        else:
            hi = mid - 1
    return url(body[:lo].rstrip() + "…"), True


def _given(rec: dict[str, Any], given: dict[str, Any] | None) -> tuple[dict[str, str], str]:
    """The draft before the scan, and where it came from: claude (given now), earlier (given for an earlier share), or
    record (the person's words and what the fixer said)."""
    d = share_dir(rec["id"])
    src = "claude"
    if not given:
        given = FX.read_json(d / "given.json")
        src = "earlier"
    if isinstance(given, dict) and str(given.get("title") or "").strip():
        if src == "claude":
            FX.write_json(d / "given.json", {k: str(given.get(k) or "") for k in ("title", "wrong", "fixed")})
        return {k: " ".join(str(given.get(k) or "").split()) for k in ("title", "wrong", "fixed")}, src
    words = " ".join(" ".join(str(w).split()) for w in rec.get("words") or [])
    return {"title": str(rec.get("title") or ""), "wrong": words, "fixed": " ".join(str(rec.get("summary") or "").split())}, "record"


def _body(rec: dict[str, Any], d: dict[str, str]) -> str:
    """The issue's text, in GitHub Markdown."""
    request = rec.get("state") == "request" or not rec.get("commit")
    rel = FX.release()
    version = rel.get("version") or str(rel.get("base") or "")[:7] or "?"
    fixed = d["fixed"] or ("(no change: Claude could not do it in code)" if request else "(say how it works now)")
    return (f"### What was wrong\n\n{d['wrong'] or '(say what you saw)'}\n\n"
            f"### {'What it needs' if request else 'How it was fixed'}\n\n{fixed}\n\n"
            f"<sub>thimble {version} · {rec.get('made_in') or 'terminal'} · "
            f"{'asked through' if request else 'fixed by'} <code>thimble fix</code></sub>\n")


def _scan(text: str, st: Store | None) -> tuple[list[dict[str, Any]], str]:
    """The privacy scan of the draft, as `thimble fix draft` scans the words: every name from the person's folder goes,
    even one that thimble's repository has. (hits, the text with them taken out)"""
    base = FX.release().get("base") or "HEAD"
    have_live = (FX.live_dir() / ".git").exists()
    paths = FX._repo_paths(base, "") if have_live else set()
    held, keep = FX._protect({"issue": text}, paths)
    known = FX._known(base) if have_live else None
    found = FX.session_terms(st)
    terms = FX._widen(found, held["issue"], known, set())
    repo_paths = [(str(FX.live_dir()) + os.sep, ""), (str(FX.PLUGIN) + os.sep, "plugin/")]
    hits, _notes = P.scan(held, terms, known, repo_paths, allow=[base])
    out = FX._unprotect(P.apply(held, hits), keep)["issue"]
    return hits, out


def opener() -> list[str] | None:
    """The command that opens a link in the person's browser, or None on a machine with no browser to show (a remote
    one, reached over ssh)."""
    o = os.environ.get("THIMBLE_OPEN")
    if o:
        return None if o == "none" else [o]
    if sys.platform == "darwin":
        return ["open"] if shutil.which("open") else None
    if sys.platform.startswith("win"):
        return ["cmd", "/c", "start", ""]
    if shutil.which("xdg-open") and (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return ["xdg-open"]
    return None


def open_link(url: str) -> bool:
    cmd = opener()
    if not cmd:
        return False
    try:
        subprocess.Popen([*cmd, url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return False
    return True


def _store_of(rec: dict[str, Any]) -> Store | None:
    """The folder whose names the scan takes out, in a shell: the one the fix was asked in, else the folder the shell
    stands in (not the home folder or /, whose every file the scan would list)."""
    here = Path.cwd()
    root = rec.get("root") if rec.get("root") and Path(rec["root"]).is_dir() else None
    if not root and here not in (Path.home(), Path("/")):
        root = str(here)
    try:
        return Store(root) if root else None
    except Exception:  # noqa: BLE001 - a folder thimble cannot read: the machine's names are still taken out
        return None


def share(fid: int | str, given: dict[str, Any] | None = None, st: Store | None = None, open_it: bool = False) -> dict[str, Any]:
    """The share draft through the scan, and GitHub's new-issue link with it, opened when open_it. Nothing is sent."""
    rec = FX.get(fid)
    if rec.get("state") not in STATES:
        raise FX.FixError(f"fix {rec['id']} is {rec.get('state')}: there is nothing to share yet")
    if st is None:
        st = _store_of(rec)
    d, src = _given(rec, given)
    title = FX.short(d["title"] or rec["title"], 72)
    hits, text = _scan(f"{title}\n{_body(rec, d)}", st)
    title, _, body = text.partition("\n")
    url, shortened = issue_url(title.strip(), body, FX.upstream())
    out_dir = share_dir(rec["id"])
    out_dir.mkdir(parents=True, exist_ok=True)
    took = took_words(hits)
    marks = sorted({h["replacement"] for h in hits if h["replacement"].startswith("‹")})
    data = {"id": rec["id"], "title": title.strip(), "body": body, "url": url, "shortened": shortened, "took": took,
            "marks": marks, "repo": FX.upstream(), "max": URL_MAX, "text": src}
    FX.write_json(out_dir / "share.json", data)
    opened = open_link(url) if open_it else False
    return {**data, "opened": opened, "removed": len({h["found"] for h in hits})}


def lines(r: dict[str, Any]) -> list[str]:
    """What `thimble fix share ID` prints."""
    out = [f"Share fix {r['id']}: {r['title']}", f"  ✓ privacy check: {r['took']}"]
    if r.get("shortened"):
        out.append("  · the text is longer than a GitHub link holds, so the link has the first part of it")
    if r["opened"]:
        out.append("  ✓ opened the link in your browser")
    out.append("Open this link to post it as a GitHub issue. Read the text there, paste a screenshot if you want, and "
               "press Submit; nothing is sent until you do.")
    out += ["", r["url"]]
    return out


def cmd(a) -> int:
    """thimble fix share ID [--json] [--open] [--draft -]: see cli.py FIX_HELP."""
    from .cli import out_json, stdin_text  # noqa: PLC0415

    try:
        given = None
        if a.draft == "-":
            raw = stdin_text(5.0)
            try:
                given = json.loads(raw) if raw.strip() else None
            except ValueError:
                raise FX.FixError("--draft - reads one JSON object: {\"title\", \"wrong\", \"fixed\"}")
        root = os.environ.get("THIMBLE_ROOT")
        st = Store(root, session=os.environ.get("THIMBLE_CONVERSATION")) if root else None
        r = share(a.id, given if isinstance(given, dict) else None, st, open_it=a.open)
    except FX.FixError as e:
        print(f"thimble fix share: {e}", file=sys.stderr)
        return 1
    if a.json:
        out_json(r)
    else:
        print("\n".join(lines(r)))
    return 0

