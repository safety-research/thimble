"""thimble file issue ID: a fix as a public GitHub issue that the person checks and submits themselves.

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

thimble file pr ID: the same text as a pull request on the public repository, with the fix's code, from the person's
own GitHub account through the gh command. It says first that this is public, shows the title, the text, the files
and the privacy check, and asks y/N (--yes skips the question, for scripts). The scan takes the person's details out of
the title and the text; a detail of theirs in the code cannot be taken out without changing the code, so it refuses
and names each one. It forks the repository when the person cannot push to it, makes one commit with the fix's change
on the release commit in a temporary repository under $THIMBLE_HOME/fixes/pr/ (removed after), pushes it as the
branch thimble-fix/<id>-<slug>, opens the pull request against main, and keeps its link on the fix's record and in
share/<id>/pr.json. THIMBLE_GH, THIMBLE_GIT and THIMBLE_FIX_PUSH_URL (fixes.py) replace gh, the git that pushes, and
where it pushes ({owner}, {login}, {name}), for tests.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
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
            f"thimble {version} · {rec.get('made_in') or 'terminal'} · "
            f"{'asked through' if request else 'fixed by'} `thimble fix`\n")


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
    """What `thimble file issue ID` prints."""
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
    """thimble file issue ID [--json] [--open] [--draft -]: see cli.py FILE_HELP."""
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
        print(f"thimble file issue: {e}", file=sys.stderr)
        return 1
    if a.json:
        out_json(r)
    else:
        print("\n".join(lines(r)))
    return 0



# ------------------------------------------------------------------ thimble file pr ID: a pull request with the code

PR_STATES = ("on", "ready")
PUSH_ROLES = ("ADMIN", "MAINTAIN", "WRITE")  # gh repo view's viewerPermission that may push a branch
PR_WARNING = ("This posts fix {id}'s code change publicly: as a pull request on the public repository {repo}, from your "
              "GitHub account{who}. Anyone can read the code and the text.")


def _gh_ready() -> dict[str, Any]:
    """The person's GitHub account through gh: {login, id}, or a one-line way to get there."""
    if not shutil.which(FX.gh()):
        raise FX.FixError("this needs gh, GitHub's command line tool: install it (https://cli.github.com), then run "
                          "gh auth login")
    if FX.run([FX.gh(), "auth", "status"], check=False).returncode != 0:
        raise FX.FixError("gh is not signed in to GitHub: run gh auth login, then try again")
    p = FX.run([FX.gh(), "api", "user"], check=False)
    try:
        user = json.loads(p.stdout) if p.returncode == 0 else {}
    except ValueError:
        user = {}
    if not user.get("login") or not user.get("id"):
        raise FX.FixError("gh gave no GitHub account: run gh auth login, then try again")
    return {"login": str(user["login"]), "id": user["id"]}


def slug(title: str, n: int = 40) -> str:
    """A branch's short name from the title: plain letters and digits, the scan's placeholders left out."""
    s = re.sub(r"[^a-z0-9]+", "-", re.sub(r"‹[^›]*›", " ", title).lower()).strip("-")
    return s[:n].rstrip("-") or "fix"


def _code_of(rec: dict[str, Any]) -> str:
    """The fix's own change: its commit against the commit before it, in live."""
    c = rec["commit"]
    return FX.run(["git", "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", f"{c}^", c],
                  cwd=FX.live_dir()).stdout


def _where(diff: str, found: str, kind: str) -> list[str]:
    """Where a detail stands in the code: `file, line N` (or `lines N and M`) for each file whose added lines hold it."""
    at: dict[str, list[str]] = {}
    path, line = "", 0
    for ln in diff.splitlines():
        if ln.startswith("+++ "):
            path = ln[6:] if ln.startswith("+++ b/") else ln[4:]
            continue
        m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", ln)
        if m:
            line = int(m.group(1))
            continue
        if ln.startswith("+"):
            if next(iter(P._finds(ln[1:], found, kind)), None):
                at.setdefault(path, []).append(str(line))
            line += 1
        elif ln.startswith(" "):
            line += 1
    return [f"{p}, line{'s' if len(ns) > 1 else ''} {FX._and(ns)}" for p, ns in at.items()]


def _scan_code(diff: str, st: Store | None) -> list[dict[str, Any]]:
    """The scan of the code as `thimble fix draft` scans a diff: the person's details in the lines the fix adds, and in
    the names of the files it adds. Each hit with where it is ({kind, found, where: [...]}). Nothing is replaced: a
    change to code is no longer the fix the person tested."""
    base = FX.release().get("base") or "HEAD"
    held, _keep = FX._protect({"diff": diff}, FX._repo_paths(base, diff))
    base_files = FX._base_files(base)
    known = FX._known(base)
    terms = FX._widen(FX.session_terms(st), held["diff"], known, base_files)
    repo_paths = [(str(FX.live_dir()) + os.sep, ""), (str(FX.PLUGIN) + os.sep, "plugin/")]
    hits, _notes = P.scan(held, terms, known, repo_paths, allow=[base])
    out = [{"kind": h["kind"], "found": h["found"], "where": _where(diff, h["found"], h["kind"]) or ["the code"]}
           for h in hits]
    added = sorted(set(re.findall(r"^\+\+\+ b/(\S+)$", diff, re.M)) - base_files)
    if added:
        named, _ = P.scan({"diff": "\n".join(added)}, {k: v for k, v in terms.items() if k != "path"}, known,
                          use_gitleaks=False)
        for h in named:
            out.append({"kind": h["kind"], "found": h["found"],
                        "where": [f"the name of the new file {a}" for a in added if h["found"] in a]})
    return sorted(out, key=lambda h: -len(h["found"]))  # a path before a name inside it


def _shown(h: dict[str, Any]) -> str:
    """A hit as the refusal names it: a key or a token only by its first characters."""
    f = h["found"]
    return f[:4] + "…" if h["kind"] in P.NEVER_KEPT else f


def _pr_ready(fid: int | str) -> dict[str, Any]:
    """The fix's record when it has a change to open a pull request with, else the plain reason why not."""
    rec = FX.get(fid)
    n = rec["id"]
    if rec.get("pr"):
        raise FX.FixError(f"fix {n} has a pull request already: {rec['pr']}")
    if rec.get("state") not in PR_STATES:
        raise FX.FixError(f"fix {n} is {FX.state_word(rec)}: only a fix that is on or ready has a change to open a "
                          "pull request with")
    if not rec.get("commit"):
        raise FX.FixError(f"fix {n} has no code change; thimble file issue {n} posts it as a GitHub issue")
    return rec


def pr_preview(fid: int | str, st: Store | None = None) -> dict[str, Any]:
    """What `thimble file pr ID` would send, through the scan: the title and the text (the scan's placeholders in them),
    the files with their counts, the branch, and the details of the person's that the code holds. Nothing is sent."""
    rec = _pr_ready(fid)
    n = rec["id"]
    if st is None:
        st = _store_of(rec)
    rel = FX.release()
    base = rel.get("base") or rec.get("base") or ""
    version = rel.get("version") or base[:7] or "?"
    diff = _code_of(rec)
    if not diff.strip():
        raise FX.FixError(f"fix {n} changes nothing in the code; thimble file issue {n} posts it as a GitHub issue")
    if re.search(r"^Binary files ", diff, re.M):
        raise FX.FixError(f"fix {n} changes a binary file; a pull request from thimble holds text changes only")
    d, _src = _given(rec, None)
    title = FX.short(d["title"] or rec["title"], 72)
    body = (_body(rec, d) + f"\nOpened with `thimble file pr`, on thimble {version} "
            f"(`{base[:7]}`).\n")
    hits, text = _scan(f"{title}\n{body}", st)
    title, _, body = text.partition("\n")
    title = title.strip()
    files = FX._numstat(FX.live_dir(), f"{rec['commit']}^", rec["commit"])
    return {"id": n, "title": title, "body": body.lstrip("\n"), "took": took_words(hits), "files": files,
            "code": _scan_code(diff, st), "diff": diff, "base": base, "version": version, "repo": FX.upstream(),
            "branch": f"thimble-fix/{n}-{slug(title)}"}


def _commit(r: dict[str, Any], user: dict[str, Any], tmp: Path) -> str:
    """One commit with the fix's change on the release commit, authored by the person's GitHub noreply address, in a
    repository of its own under tmp that borrows live's objects. live, and the person's own clones, are not changed."""
    live = FX.live_dir()
    objects = Path(FX.git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=live)) / "objects"
    repo = tmp / "repo"
    FX.git("init", "-q", str(repo), cwd=tmp)
    (repo / ".git" / "objects" / "info" / "alternates").write_text(str(objects) + "\n")
    noreply = f"{user['id']}+{user['login']}@users.noreply.github.com"
    env = {**os.environ, "GIT_AUTHOR_NAME": user["login"], "GIT_AUTHOR_EMAIL": noreply,
           "GIT_COMMITTER_NAME": user["login"], "GIT_COMMITTER_EMAIL": noreply}
    (tmp / "fix.patch").write_text(r["diff"])
    FX.git("read-tree", r["base"], cwd=repo, env=env)
    if FX.run(["git", "apply", "--cached", str(tmp / "fix.patch")], cwd=repo, env=env, check=False).returncode != 0:
        raise FX.FixError(f"fix {r['id']}'s change does not apply to thimble {r['version']} alone: it builds on another "
                          "of your fixes. Ask /thimble-fix to make it work on the release by itself")
    tree = FX.git("write-tree", cwd=repo, env=env)
    msg = f"{r['title']}\n\nOpened with thimble file pr, on thimble {r['version']} ({r['base'][:7]}).\n"
    return FX.run(["git", *FX.THIMBLE_ID, "commit-tree", tree, "-p", r["base"], "-m", msg], cwd=repo, env=env).stdout.strip()


def open_pr(r: dict[str, Any], user: dict[str, Any]) -> str:
    """The pull request itself: a fork when the person cannot push to the repository, the branch pushed, gh pr create
    against main. Its link, also on the fix's record."""
    repo = r["repo"]
    owner, name = repo.split("/", 1)
    perm = FX.run([FX.gh(), "repo", "view", repo, "--json", "viewerPermission", "-q", ".viewerPermission"],
                  check=False).stdout.strip()
    forked = perm not in PUSH_ROLES
    if forked:
        FX.run([FX.gh(), "repo", "fork", repo, "--clone=false"])
        owner = user["login"]
    url = (os.environ.get("THIMBLE_FIX_PUSH_URL") or "https://github.com/{owner}/{name}.git").format(
        owner=owner, login=user["login"], name=name)
    (FX.home() / "pr").mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f"{r['id']}-", dir=FX.home() / "pr"))
    try:
        sha = _commit(r, user, tmp)
        push = [FX.push_git(), "-c", "credential.helper=", "-c",
                f"credential.https://github.com.helper=!{FX.gh()} auth git-credential",
                "push", url, f"{sha}:refs/heads/{r['branch']}"]
        for i in range(5):  # a fork GitHub has just made can take a few seconds to take a push
            p = FX.run(push, cwd=tmp / "repo", check=False)
            if p.returncode == 0 or not forked or i == 4:
                break
            time.sleep(3)
        if p.returncode != 0:
            # git's last line only says that it failed; the lines that say why (remote:, !, fatal:, error:) go too
            err = [x.strip() for x in (p.stderr or p.stdout).strip().splitlines() if x.strip()]
            why = [x for x in err if x.startswith(("remote:", "!", "fatal:", "error:")) and "failed to push some refs" not in x]
            raise FX.FixError("git push failed: " + ("\n  ".join(why[-8:] or err[-1:]) or "no message"))
        (tmp / "body.md").write_text(r["body"])
        head = f"{owner}:{r['branch']}" if forked else r["branch"]
        out = FX.run([FX.gh(), "pr", "create", "--repo", repo, "--base", "main", "--head", head, "--title", r["title"],
                      "--body-file", str(tmp / "body.md")]).stdout.strip().splitlines()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    link = next((x for x in reversed(out) if x.startswith("http")), out[-1] if out else "")
    rec = FX.get(r["id"])
    rec.update(pr=link, pr_at=time.time())
    FX.put(rec)
    FX.write_json(share_dir(r["id"]) / "pr.json", {k: r[k] for k in ("title", "body", "branch", "base", "version",
                                                                       "repo", "files")} | {"url": link, "fork": forked})
    return link


def pr_lines(r: dict[str, Any], user: dict[str, Any], c: FX.Paint | None = None) -> list[str]:
    """What `thimble file pr ID` shows before it asks: the warning, then what would go."""
    c = c or FX.Paint(False)
    import textwrap  # noqa: PLC0415

    width = min(shutil.get_terminal_size((100, 24)).columns, 100)
    warn = PR_WARNING.format(id=r["id"], repo=r["repo"], who=f" ({user['login']})")
    out = [c("bold", x) for x in textwrap.wrap(warn, width, break_on_hyphens=False)]
    fw = max(len(f["path"]) for f in r["files"])
    files = [f"{f['path']:<{fw}}  {c('green', '+' + str(f['add'] if f['add'] is not None else '?'))} "
             f"−{f['del'] if f['del'] is not None else '?'}" for f in r["files"]]
    out += ["", f"  {c('dim', 'Title ')}   {r['title']}",
            f"  {c('dim', 'Branch')}   {r['branch']}, on thimble {r['version']} ({r['base'][:7]})",
            f"  {c('dim', 'Files ')}   {files[0]}", *[f"           {x}" for x in files[1:]], "", f"  {c('dim', 'Body')}"]
    for x in r["body"].rstrip().splitlines():
        out += [f"    {y}" for y in textwrap.wrap(x, width - 4, break_on_hyphens=False)] or [""]
    out.append("")
    took = r["took"] if r["took"].startswith("took ") else "nothing of yours in the text"
    if r["code"]:
        k = len(r["code"])
        out += textwrap.wrap(f"{c('bold', '✗ privacy check:')} {took}, but the code holds {k} detail{'' if k == 1 else 's'} "
                             "of yours, which thimble cannot take out of code:", width - 2,
                             initial_indent="  ", subsequent_indent="  ", break_on_hyphens=False)
        for h in r["code"]:
            out.append(f"      {KIND_WORDS.get(h['kind'], ('detail',))[0]} {_shown(h)!r} in {FX._and(h['where'])}")
    else:
        out.append(f"  {c('green', '✓')} privacy check: {took}; nothing of yours in the code")
    return out


def pr_ask(question: str) -> str | None:
    """The person's answer in their own terminal, or None with no terminal to ask in."""
    if not (sys.stdin and sys.stdin.isatty()):
        return None
    try:
        return input(question)
    except EOFError:
        return None


def pr_cmd(a) -> int:
    """thimble file pr ID [--yes]: see cli.py FILE_HELP."""
    c = FX.Paint()
    try:
        if FX.in_claude_code():
            raise FX.FixError(FX.SHELL_ONLY.format(what=f"thimble file pr {a.id or 'N'}").replace(
                "it changes the thimble this session runs", "it posts your code publicly, so only you run it"))
        if not a.id:
            raise FX.FixError("say which fix: thimble file pr N (thimble fix list shows them)")
        _pr_ready(a.id)
        user = _gh_ready()
        root = os.environ.get("THIMBLE_ROOT")
        st = Store(root, session=os.environ.get("THIMBLE_CONVERSATION")) if root else None
        r = pr_preview(a.id, st)
        print("\n".join(pr_lines(r, user, c)))
        if r["code"]:
            n = r["id"]
            print(f"\nNothing was sent. You can turn fix {n} off ({c('cmd', f'thimble fix off {n}')}),\nor ask "
                  f"/thimble-fix to change it: {c('cmd', f'/thimble-fix {n} take my details out of the code')}")
            return 1
        if not a.yes:
            ans = pr_ask(f"\nOpen this pull request on {r['repo']}? [y/N] ")
            if ans is None:
                raise FX.FixError("it asks y/N in your own terminal; add --yes to open it without the question")
            if ans.strip().lower() not in ("y", "yes"):
                print("Nothing was sent.")
                return 0
        link = open_pr(r, user)
    except FX.FixError as e:
        print(f"thimble file pr: {e}", file=sys.stderr)
        return 1
    print(f"{c('green', '✓')} Opened the pull request: {link}")
    return 0
