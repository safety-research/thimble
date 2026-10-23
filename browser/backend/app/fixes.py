"""thimble fix in the browser workbench: the person asks for a change to their own thimble in their own words
(`/thimble-fix <words>` in the chat, Report a problem's File a code ticket, or main's file_dev_ticket), Claude makes it in
a copy of thimble, and when the kernel's checks pass, a notice asks the person to use it; their click puts it on and
thimble-browser starts again from it. The same records and verbs as the terminal's /thimble-fix
(plugin/engine/kernel/fixes.py), so a fix made in one is on in the other once it starts again.

The kernel holds every record and makes every change, in the terminal plugin's home ($THIMBLE_PLUGIN_HOME, else
~/.thimble), never in the browser's own home:

    fixes/fixes.jsonl   the records          fixes/live/      the checkout with the fixes that are on (branch mine)
    fixes/work/<id>/    a fix's copy          fixes/tmp/<id>/  its temp folder

This module calls it as `thimble fix VERB`, with THIMBLE_HOME set to that home.

    request(c, words, page)  a new fix (`fix new --made-in browser`) and its fixer
    change(c, fid, words)    more words for a fix the person has (`/thimble-fix N <words>`, or a message in the fix's
                             thread): a round of that fix (`fix round`), never a new fix. A fixer that still works gets
                             the words; otherwise a new fixer works in the copy the kernel made for the round
    the fixer                a fork of main's conversation: it has the chat so far, and its first message is the
                             registry's fixer text (plugin/prompts/fixer.md), the person's words and a text copy of what
                             the page shows. It runs with main's tools and Edit and Write, in the runtime's usual
                             sandbox, which writes only its copy and its temp folder (runtime.spec_of). It runs in the
                             background, in a chat of its own that the thread tree lists (`fixing <name>`, or
                             `changing <name>` for a round of a fix the person has): its steps show there, and main's
                             chat shows the person's message and one line that the fix started there
    its end (settle)         the kernel commits the change, refuses a safety file or a binary file, and runs the tests
                             of what the change touched (`fix done`); a fix that passes is ready, and one notice at the
                             top of the chat asks the person: Use it now, What changed, Later. Nothing goes on by itself
    the person's clicks      Use it now, or Use it in Your fixes (`fix apply`, with a secret made at the click as the
                             terminal's key press makes one; then the page of live's browser/ is built and the server
                             starts again from live, dev._do_restart; a page that does not build takes the fix off
                             again; once it is on, the notice goes and main's chat keeps one line that says so), Later (the notice goes, the fix stays ready in Your fixes), Undo (`fix undo`, then
                             a restart), Redo (`fix redo`, a new fixer with the earlier change) and Dismiss
                             (FixStrip.tsx)

What each notice says lives in the browser's home (fixes.json, by fix id), so it is still there after the restart.
THIMBLE_FIXES=off turns fixes off on this server (the code tickets then take their entry points again).
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import config

log = logging.getLogger("thimble.fixes")
router = APIRouter()

COMMAND = "/thimble-fix"
FIXER = "fixer"  # the role of the fixer's conversation (runtime.spec_of)
PLUGIN_HOME_ENV = "THIMBLE_PLUGIN_HOME"
OFF_ENV = "THIMBLE_FIXES"
OFF_LINE = "thimble's fixes are off on this server (THIMBLE_FIXES=off)"
NO_SOURCE = "thimble's fixes need the terminal plugin's code beside the browser (plugin/), as a git clone has it"
EMPTY = "say what should work differently: /thimble-fix make the card's title say how many rows it shows"
RESTART_BY_HAND = "restart thimble-browser to load it"
BUSY_WAIT_S = 600.0  # how long a restart waits for main and the other agents to end their turns
LINKS = (("backend", ".venv"), ("frontend", "node_modules"))  # what the install lends a copy and live's browser/
PAGE_CHARS = 8000  # of the text copy of the page

_phase: dict[int, str] = {}  # fix id → fixing | testing | applying | restarting, while this server works on it
_fixers: dict[int, Any] = {}  # fix id → its fixer's conversation (runtime.Conv)
_where: dict[int, tuple[str, str]] = {}  # fix id → (workspace, chat) of its fixer's chat (fixer_chat)
_recovered = False


@dataclass
class Ran:
    ok: bool
    out: str
    err: str


# ------------------------------------------------------------------ places


def plugin_home() -> Path:
    return Path(os.environ.get(PLUGIN_HOME_ENV) or Path.home() / ".thimble")


def fixes_home() -> Path:
    return plugin_home() / "fixes"


def plugin_dir() -> Path:
    """The terminal plugin of the tree this server runs from (the repository's plugin/, beside browser/)."""
    return config.REPO_ROOT.parent / "plugin"


def live_root() -> Path:
    return fixes_home() / "live" / "browser"


def problem() -> str:
    """Why fixes cannot be made here, '' when they can."""
    if os.environ.get(OFF_ENV, "").strip().lower() in ("off", "0", "no", "false"):
        return OFF_LINE
    if not (plugin_dir() / "engine" / "thimble.py").is_file():
        return NO_SOURCE
    return ""


def notes_path() -> Path:
    from . import cli  # noqa: PLC0415

    return cli.home().expanduser() / "fixes.json"


def _cut(text: str, n: int) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def fix_name(rec: dict[str, Any], n: int = 60) -> str:
    """A fix as the person reads it: its title, else `fix <id>` (plugin/fix/fixes.ts fixName)."""
    return _cut(str(rec.get("title") or "") or f"fix {rec.get('id')}", n)


def fixing_word(rec: dict[str, Any]) -> str:
    """The fixer's chat in the thread tree: `fixing <name>` for a new fix, `changing <name>` for a round of a fix the
    person has (plugin/fix/fixes.ts fixingWord)."""
    return f"{'changing' if rec.get('prev') else 'fixing'} {fix_name(rec, 40)}"


# ------------------------------------------------------------------ the kernel


def kernel(args: list[str], *, stdin: str | None = None, timeout: float = 120, env: dict[str, str] | None = None) -> Ran:
    """`thimble fix ARGS` in the plugin's home. Blocking: call it in a thread."""
    script = plugin_dir() / "engine" / "thimble.py"
    full = {**config.passed_environ(), "THIMBLE_HOME": str(plugin_home()), "PYTHONDONTWRITEBYTECODE": "1",
            **(env or {})}
    if config.CLI_PATH and not full.get("THIMBLE_CLAUDE"):
        full["THIMBLE_CLAUDE"] = config.CLI_PATH
    full.pop("THIMBLE_ROOT", None)
    try:
        p = subprocess.run([sys.executable, "-I", str(script), "fix", *args], input=stdin or "", capture_output=True,
                           text=True, timeout=timeout, env=full, cwd=str(Path.home()))
    except subprocess.TimeoutExpired:
        return Ran(False, "", f"thimble fix {args[0] if args else ''} took longer than {int(timeout)} s")
    except OSError as e:
        return Ran(False, "", f"thimble fix could not run: {e}")
    lines = (p.stderr or "").strip().splitlines()
    err = re.sub(r"^thimble fix \w+: ", "", lines[-1]) if lines else ""
    return Ran(p.returncode == 0, p.stdout, err)


def _json(r: Ran, what: str) -> dict[str, Any]:
    if not r.ok:
        raise HTTPException(409, r.err or f"thimble fix {what} gave nothing")
    try:
        got = json.loads(r.out)
    except ValueError:
        raise HTTPException(500, f"thimble fix {what} gave no JSON") from None
    return got if isinstance(got, dict) else {}


def record(fid: int) -> dict[str, Any]:
    return _json(kernel(["show", str(fid), "--json"], timeout=30), "show")


def records() -> list[dict[str, Any]]:
    r = kernel(["list", "--json"], timeout=30)
    with contextlib.suppress(ValueError):
        return list((json.loads(r.out) if r.ok else {}).get("fixes") or [])
    return []


def press(fid: int) -> str:
    """The analyst's click for `fix apply` (Use it now, or Use it in Your fixes): a secret held only here, its sha256 in
    asks/<id>.json, which the kernel checks and uses once (the terminal's key press, plugin/fix/fixes.ts pressKey).
    Only the click routes call it."""
    secret = secrets.token_hex(32)
    p = fixes_home() / "asks" / f"{int(fid)}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"key": hashlib.sha256(secret.encode()).hexdigest()}) + "\n")
    tmp.replace(p)
    return secret


# ------------------------------------------------------------------ what the row above the composer says


def _notes() -> dict[str, dict[str, Any]]:
    try:
        got = json.loads(notes_path().read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def note(fid: int, kind: str, said: str, **more: Any) -> None:
    """What fix `fid`'s notice says now (ready, fixed, failed, request, undone, problem), until the analyst dismisses
    it."""
    notes = _notes()
    notes[str(fid)] = {"kind": kind, "said": said, "at": time.time(), **more}
    p = notes_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(notes, ensure_ascii=False) + "\n", "utf-8")
    tmp.replace(p)
    _event(fid, kind)


def dismiss(fid: int) -> None:
    notes = _notes()
    if str(fid) in notes:
        notes[str(fid)]["dismissed"] = True
        notes_path().write_text(json.dumps(notes, ensure_ascii=False) + "\n", "utf-8")
    _event(fid, "dismissed")


def _event(fid: int, state: str) -> None:
    """The pages' `fix` event, in every workspace: a fix is the person's, not a folder's."""
    from . import dev  # noqa: PLC0415

    with contextlib.suppress(Exception):
        dev._emit_all({"type": "fix", "id": int(fid), "state": state})


def _phase_set(fid: int, phase: str | None) -> None:
    if phase:
        _phase[fid] = phase
    else:
        _phase.pop(fid, None)
    _event(fid, phase or "idle")


def status(every: bool = False) -> dict[str, Any]:
    """Each fix the page can show: the ones this server works on (their phase), and the ones whose end is not
    dismissed yet. A ready notice shows only while the fix is still ready (the terminal can apply it too). `every`:
    every fix but the removed ones, for Your fixes. Newest first."""
    _recover_soon()
    why = problem()
    notes = _notes()
    rows = []
    for r in ([] if why else records()):
        fid = int(r["id"])
        n = notes.get(str(fid)) or {}
        if n.get("kind") == "ready" and r.get("state") != "ready":
            n = {}
        phase = _phase.get(fid)
        if r.get("state") == "removed" or (not every and not phase and (not n or n.get("dismissed"))):
            continue
        shown = bool(n) and not n.get("dismissed") and not phase
        conv = _fixers.get(fid)
        files = r.get("files") or []
        rows.append({"id": fid, "title": r.get("title") or "", "state": r.get("state"), "phase": phase,
                     "kind": n.get("kind") if shown else None, "said": n.get("said") if shown else None,
                     "tests": r.get("tests"), "error": r.get("error"), "words": (r.get("words") or [""])[-1],
                     "summary": r.get("summary") or "", "files": len(files), "change": bool(r.get("prev")),
                     "workspace": conv.c if conv is not None else n.get("workspace"),
                     "agent": conv.agent_id if conv is not None else n.get("agent"),
                     "created": float(r.get("created") or 0),
                     "at": max(float(r.get("updated") or 0), float(n.get("at") or 0))})
    rows.sort(key=lambda x: -x["at"])
    return {"problem": why, "fixes": rows}


# ------------------------------------------------------------------ the fixer


FIRST = """{prompt}

---

The person asked for this change to their thimble (fix {id}):

{asked}

They asked in thimble's browser workbench, whose code is browser/ in your copy. The conversation above is theirs, so
words such as "this" or "this card" can name something in it. They can also name something on the page: what the page
showed when they asked is below.

Your working folder is the copy: {work}. Its browser/backend/.venv and browser/frontend/node_modules are links to the
installed packages, so the browser's tests run there: `cd browser/frontend && npx vitest run FILE` for the page,
`cd browser/backend && .venv/bin/python -m pytest tests_public/FILE` for the server.{earlier}

<page>
{page}
</page>"""
EARLIER = ("\n\nAn earlier change for this request, which did not pass, is in {patch}; start from it when it helps. "
           "It did not pass because {why}.")


def first_message(rec: dict[str, Any], page: str, earlier: bool = False) -> str:
    """The fixer's first message: the registry's fixer text, the person's words (each round), where it works, and the
    page."""
    prompt = (plugin_dir() / "prompts" / "fixer.md").read_text("utf-8").strip()
    words = rec.get("words") or []
    asked = "\n".join(f"Round {i + 1}: {w}" for i, w in enumerate(words)) if len(words) > 1 else (
        words[0] if words else rec.get("title", ""))
    patch = fixes_home() / "tmp" / str(rec["id"]) / "earlier.patch"
    more = EARLIER.format(patch=patch, why=str(rec.get("error") or "its checks failed").rstrip(".")) if (
        earlier and patch.is_file()) else ""
    return FIRST.format(prompt=prompt, id=rec["id"], asked=asked, work=rec.get("work"), earlier=more,
                        page=(page or "(nothing)").strip()[:PAGE_CHARS])


def lend(root: Path, src: Path | None = None) -> None:
    """The install's Python packages and page packages linked into `root` (a copy's or live's browser/), where they are
    missing, and kept out of git (live's info/exclude, which every copy shares)."""
    src = src or config.REPO_ROOT
    for part, name in LINKS:
        have, want = root / part / name, src / part / name
        if have.exists() or have.is_symlink() or not want.exists():
            continue
        real = Path(os.path.realpath(want))
        with contextlib.suppress(OSError):
            if name != "node_modules":
                have.symlink_to(real, target_is_directory=True)
                continue
            # a folder of links, one per package: the page's tools write their temp files in it (.vite, .vite-temp),
            # and the installed packages stay as they are
            have.mkdir()
            for entry in real.iterdir():
                if not entry.name.startswith(".vite"):
                    (have / entry.name).symlink_to(os.path.realpath(entry), target_is_directory=entry.is_dir())
    exclude = fixes_home() / "live" / ".git" / "info" / "exclude"
    with contextlib.suppress(OSError):
        lines = exclude.read_text().splitlines() if exclude.is_file() else []
        want_lines = [f"browser/{p}/{n}" for p, n in LINKS]
        if any(w not in lines for w in want_lines):
            exclude.parent.mkdir(parents=True, exist_ok=True)
            exclude.write_text("\n".join([*lines, *[w for w in want_lines if w not in lines]]) + "\n")


def _packages(p: Path) -> Path:
    """The real folder of installed packages that `p` stands for: its target when it is a link, or, for a folder of
    links (what lend() makes, also in live's browser/, which the server runs from once a fix went on), the folder its
    links point into."""
    if p.is_symlink() or not p.is_dir():
        return Path(os.path.realpath(p))
    for entry in p.iterdir():
        if entry.is_symlink():
            return Path(os.path.realpath(entry)).parent
    return p


def lent_reads() -> list[Path]:
    """The real folders of what lend() links, which the fixer and the tests read."""
    return [_packages(config.REPO_ROOT / p / n) for p, n in LINKS if (config.REPO_ROOT / p / n).exists()]


def fixer_roots(fid: int) -> tuple[Path, list[Path], list[Path]]:
    """The fixer's working folder, what it reads beside main's reads, and what it writes (runtime.spec_of)."""
    work = fixes_home() / "work" / str(fid)
    tmp = fixes_home() / "tmp" / str(fid)
    git_dir = fixes_home() / "live" / ".git"
    return work, [git_dir, *lent_reads()], [work, tmp]


async def start_fixer(c: str, rec: dict[str, Any], page: str = "", *, earlier: bool = False, said: str | None = None,
                      asked: str | None = None, announce: bool = True) -> None:
    """The fixer on a fix whose copy the kernel just made (a request, a round or a redo): a fork of main's conversation,
    in the background, in the fix's own chat (fixer_chat). `said`: the person's message as they typed it in main's
    chat, which main's chat shows before its line that the fix started; `asked`: the person's words for this round,
    which the fix's chat opens the round with; `announce` False for words typed in the fix's own thread and for Redo,
    which main's chat does not show."""
    from . import agents, runtime, session  # noqa: PLC0415

    fid = int(rec["id"])
    if rec.get("work"):
        await asyncio.to_thread(lend, Path(rec["work"]) / "browser")
    text = await asyncio.to_thread(first_message, rec, page, earlier)
    sp = runtime.ensure(c)
    agent_id = runtime._agent_id()
    if said:
        agents.mirror(c, "user", by=agents.BROWSER, text=said)
    chat = fixer_chat(c, rec, agent_id, sp.sid, asked=asked, announce=announce)
    session.follow(c, agent_id, chat, FIXER)
    conv = runtime.Conv(sp, agent_id, "fork", agent_id=agent_id, agent_type=runtime.FORK_TYPE, role=FIXER,
                        values={"fix": fid}, base=runtime.MAIN,
                        transcript=runtime.Transcript(sp.sub_path(agent_id), sp.sid, agent_id))
    sp.convs[agent_id] = conv
    conv.transcript.write_meta({"agentType": runtime.FORK_TYPE, "isFork": True,  # type: ignore[union-attr]
                                "description": fixing_word(rec)})
    conv.queue.append(text)
    _fixers[fid] = conv
    _phase_set(fid, "fixing")
    # main hears of it at the person's next message, as the terminal's fork tells it (plugin/fix/request.ts)
    sp.tell(runtime.MAIN, f"The person asked thimble's fixer for a change to thimble itself (“{fix_name(rec)}”); it works "
                          "in the background in a copy, and thimble shows the person the result. Nothing for you to do.")
    conv.task = runtime._spawn_task(_run_fixer(conv, fid), f"fixer:{c}:{agent_id}")


def fixer_chat(c: str, rec: dict[str, Any], agent_id: str, sid: str, *, asked: str | None = None,
               announce: bool = True) -> str:
    """The fix's chat, which the thread tree lists as `fixing <name>` (or `changing <name>`): made at the fix's first
    fixer, and run again by each later one (a round, a redo), so a fix keeps one chat. Each run opens with the person's
    words (`asked`), else a line that it starts again; `announce`: main's chat gets the line that the fix started there
    (an `agent` record)."""
    from . import agents  # noqa: PLC0415

    fid, title = int(rec["id"]), fixing_word(rec)
    had = next((m for m in agents.list_chats(c) if m.get("role") == FIXER and m.get("fix") == fid), None)
    if had is None:
        chat = str(agents.new_agent(c, FIXER, title, by=agents.BROWSER, announce=announce, agent_id=agent_id, fix=fid,
                                    session=sid)["id"])
    else:
        chat = str(had["id"])
        agents.update_agent(c, chat, title=title, status="running", ts_end=None, result=None, agent_id=agent_id,
                            session=sid)
        if announce:
            agents.mirror(c, "agent", chat=chat, role=FIXER, title=title, by=agents.BROWSER)
    if (asked or "").strip():
        agents.Recorder(c, chat).record("user", text=str(asked).strip(), by=agents.BROWSER)
    elif had is not None:
        agents.Recorder(c, chat).record("text", delta="\n· Redo, in a new copy\n")
    _where[fid] = (c, chat)
    return chat


def where(fid: int) -> tuple[str, str] | None:
    """The workspace and chat of fix `fid`'s fixer: this server's, else the chat a fixer of an earlier server made."""
    from . import agents  # noqa: PLC0415

    if fid in _where:
        return _where[fid]
    with contextlib.suppress(OSError):
        for d in sorted(config.WORKSPACES_DIR.iterdir()):
            with contextlib.suppress(Exception):
                m = next((m for m in agents.list_chats(d.name) if m.get("role") == FIXER and m.get("fix") == fid), None)
                if m is not None:
                    _where[fid] = (d.name, str(m["id"]))
                    return _where[fid]
    return None


async def _run_fixer(conv: Any, fid: int) -> None:
    from . import runtime  # noqa: PLC0415

    try:
        await runtime._agent_loop(conv)
    except asyncio.CancelledError:
        _phase.pop(fid, None)  # the server stops: the next one takes the copy as it stands (_recover)
        raise
    await settle(fid, conv.last_text)


def end_of(answer: str) -> dict[str, Any]:
    """What the fixer's last message says: its title, what it does, or that it is a request with no code
    (plugin/fix/fixer.ts endOf)."""
    text = str(answer or "")
    title = re.search(r"^\s*\**title\**\s*:\s*(.+)$", text, re.I | re.M)
    req = re.search(r"^\s*\**request\**\s*:\s*([\s\S]+)$", text, re.I | re.M)
    does = re.search(r"^\s*\**what it does\**\s*:\s*([\s\S]+)$", text, re.I | re.M)
    said = req or does
    return {"title": (title.group(1).replace("*", "").strip() if title else "")[:60],
            "summary": re.sub(r"\s+", " ", said.group(1).strip() if said else "")[:1200],
            "request": req is not None and does is None}


def changed(work: Path, base: str) -> list[str]:
    """The paths the copy changed since `base`, new files among them."""
    p = subprocess.run(["git", "-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"],
                       cwd=work, capture_output=True, text=True)
    q = subprocess.run(["git", "-c", "core.quotePath=false", "diff", "--name-only", base], cwd=work, capture_output=True,
                       text=True)
    out = {ln[3:].split(" -> ")[-1] for ln in p.stdout.splitlines() if len(ln) > 3}
    out |= {ln for ln in q.stdout.splitlines() if ln}
    return sorted(out)


def tests_for(paths: list[str]) -> str:
    """The tests of what a change touched, as one shell command the kernel runs in its sandbox, in the copy
    (THIMBLE_FIX_TESTS): the page's type check and the unit tests of what changed, the server's tests, and the
    terminal plugin's quick tests."""
    parts = []
    if any(p.startswith("browser/frontend/") for p in paths):
        parts.append("(cd browser/frontend && node_modules/.bin/tsc -b && node_modules/.bin/vitest run --changed HEAD~1"
                     " --passWithNoTests)")
    if any(p.startswith("browser/backend/") or p.startswith("browser/prompts/") for p in paths):
        parts.append("(cd browser/backend && THIMBLE_SKIP_KEY=1 .venv/bin/python -m pytest -q -x -p no:cacheprovider "
                     "tests_public)")
    if any(p.startswith("plugin/") for p in paths):
        quick = '"$THIMBLE_PYTHON" -m pytest plugin -q -x -p no:cacheprovider'
        parts.append(f"claude plugin test plugin && {quick}" if config.CLI_PATH else quick)
    return " && ".join(parts) or "true"


def srt_ready() -> str:
    """The kernel runs a fix's tests in its sandbox runtime, in the plugin's home: installed there when it is missing
    (plugin/sandbox/setup.mjs, as a terminal session's start installs it). '' when it is there, else why not."""
    sandbox = plugin_dir() / "sandbox"
    try:
        pin = json.loads((sandbox / "package.json").read_text())["dependencies"]["@anthropic-ai/sandbox-runtime"]
    except (OSError, ValueError, KeyError):
        pin = ""
    if (plugin_home() / "srt" / pin / "node_modules").is_dir():
        return ""
    node = shutil.which("node")
    if not node or not (sandbox / "setup.mjs").is_file():
        return "the sandbox runtime the tests run in is not installed (node or plugin/sandbox/setup.mjs is missing)"
    plugin_home().mkdir(parents=True, exist_ok=True)
    try:
        p = subprocess.run([node, str(sandbox / "setup.mjs"), "--home", str(plugin_home()), "--json"], capture_output=True,
                           text=True, timeout=600, env={**config.passed_environ(), "THIMBLE_HOME": str(plugin_home())},
                           cwd=str(plugin_home()))
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"the sandbox runtime the tests run in could not be installed: {e}"
    try:
        got = json.loads(p.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        got = {}
    if (plugin_home() / "srt" / pin / "node_modules").is_dir():
        return ""
    return f"the sandbox runtime the tests run in does not work here: {got.get('why') or p.stderr.strip()[-200:] or 'no reason given'}"


async def settle(fid: int, answer: str) -> None:
    """The fixer ended: the kernel's checks, then one notice: the fix is ready and asks the person, or why not. The fix
    does not go on by itself: only the person's click (Use it now) applies it."""
    _fixers.pop(fid, None)
    _phase_set(fid, "testing")
    name = f"fix {fid}"
    try:
        rec = await asyncio.to_thread(record, fid)
        name = fix_name(rec)
        if rec.get("state") != "working":
            _phase_set(fid, None)
            return
        if why := await asyncio.to_thread(srt_ready):
            _phase_set(fid, None)
            note(fid, "problem", f"“{name}” could not be checked: {why}")
            return
        end = end_of(answer)
        work = Path(rec.get("work") or "")
        paths = await asyncio.to_thread(changed, work, str(rec.get("base") or "HEAD")) if work.is_dir() else []
        env = {"THIMBLE_FIX_TESTS": tests_for(paths), "THIMBLE_PYTHON": sys.executable,
               "THIMBLE_FIX_READ": os.pathsep.join(map(str, lent_reads()))}
        args = ["done", str(fid), "--summary", "-", *(["--title", end["title"]] if end["title"] else []),
                *(["--request"] if end["request"] else [])]
        r = await asyncio.to_thread(kernel, args, stdin=end["summary"] or " ", timeout=660, env=env)
        done = json.loads(r.out) if r.ok else {}
    except Exception as e:  # noqa: BLE001 — the end is told either way
        r, done = Ran(False, "", str(e)), {}
    title = fix_name(done) if done.get("title") else name
    state = str(done.get("state") or "")
    if not r.ok:
        _phase_set(fid, None)
        note(fid, "problem", f"“{name}” could not be checked: {r.err or 'thimble fix done gave nothing'}")
    elif state == "request":
        _phase_set(fid, None)
        note(fid, "request", f"Saved as a request with no code: {title}")
    elif state != "ready":
        _phase_set(fid, None)
        note(fid, "failed", f"“{title}” did not pass: {done.get('error') or 'its tests failed'}")
    else:
        _phase_set(fid, None)
        tests = str(done.get("tests") or "")
        note(fid, "ready", f"thimble fixed: {title}" + (" · tests pass" if tests == "passed" else ""))


async def apply(fid: int) -> None:
    """The person's click on a ready fix (Use it now, or Use it in Your fixes): the secret of this click to
    `fix apply`, then live's page is built and the server starts again from live. Raises when the kernel refuses."""
    _phase_set(fid, "applying")
    try:
        secret = await asyncio.to_thread(press, fid)
        r = await asyncio.to_thread(kernel, ["apply", str(fid), "--ask", "-"], stdin=secret, timeout=300)
    except Exception:
        _phase_set(fid, None)
        raise
    if not r.ok:
        _phase_set(fid, None)
        raise HTTPException(409, r.err or "thimble fix apply gave nothing")
    title = fix_name({"id": fid, **(json.loads(r.out) if r.out.strip().startswith("{") else {})})
    runtime_task(_go_on(fid, title), f"fix-apply:{fid}")


async def _go_on(fid: int, title: str) -> None:
    why = await asyncio.to_thread(prepare, target_root())
    if why:
        await asyncio.to_thread(kernel, ["undo", str(fid)], timeout=300)
        _phase_set(fid, None)
        note(fid, "failed", f"“{title}” did not go on: {why}; it is off again")
        return
    await restart(fid, f"“{title}” is on", "fixed", f"fix {fid}: {title}")


def runtime_task(coro: Any, name: str) -> None:
    from . import runtime  # noqa: PLC0415

    runtime._spawn_task(coro, name)


async def restart(fid: int, said: str, kind: str, why: str) -> None:
    """The server starts again from live's browser/ (once main and the agents end their turns), and the row says
    `said` after it. A fix that went on has no row after it, as the terminal's line goes once the fix is on: main's
    chat keeps one line that says so."""
    from . import agents, dev  # noqa: PLC0415

    if not dev.supervised():
        _phase_set(fid, None)
        note(fid, kind, f"{said} · {RESTART_BY_HAND}")
        return
    _phase[fid] = "restarting"  # the notice keeps "Reloading thimble…" until the server is back
    on = kind == "fixed"
    note(fid, kind, said, **({"dismissed": True} if on else {}))
    if on and (at := await asyncio.to_thread(where, fid)):
        with contextlib.suppress(Exception):
            agents.mirror(at[0], "text", delta=f"\n· thimble starts again with your fix: {said}\n")
    _phase_set(fid, "restarting")
    t0 = time.monotonic()
    while _busy() and time.monotonic() - t0 < BUSY_WAIT_S:
        await asyncio.sleep(2)
    root = target_root()
    asyncio.get_running_loop().call_later(0.3, lambda: asyncio.ensure_future(
        dev._do_restart(why, cwd=root / "backend")))


def _busy() -> bool:
    """Whether main or another agent of this server is in a turn (the fixer whose end restarts it is not)."""
    from . import runtime  # noqa: PLC0415

    me = asyncio.current_task()
    with contextlib.suppress(Exception):
        for sp in runtime.spaces():
            if sp.main.running or any(c.running and c.task is not me for c in sp.convs.values()):
                return True
    return False


# ------------------------------------------------------------------ where the server runs from


def target_root() -> Path:
    """The browser/ the server starts from: live's once the person has fixes (it is the release while every fix is
    off), else this one."""
    live = live_root()
    return live if (live / "backend" / "app" / "main.py").is_file() else config.REPO_ROOT


def prepare(root: Path) -> str:
    """`root` ready to run: the packages lent, and its page built when its sources are newer than the build. '' when
    ready, else why not."""
    if root.resolve() != config.REPO_ROOT.resolve():
        lend(root)
    fe = root / "frontend"
    built = fe / "dist" / "index.html"
    if built.is_file():
        stamp = built.stat().st_mtime
        newer = any(p.stat().st_mtime > stamp for d in (fe / "src",) for p in d.rglob("*") if p.is_file())
        if not newer and (fe / "index.html").stat().st_mtime <= stamp:
            return ""
    npm = shutil.which("npm")
    if not npm:
        return "the page was not built: npm is not on the PATH"
    try:
        p = subprocess.run([npm, "--prefix", str(fe), "run", "build"], capture_output=True, text=True, timeout=900,
                           env={**os.environ, "npm_config_update_notifier": "false"})
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"the page was not built: {e}"
    if p.returncode != 0:
        tail = [ln for ln in (p.stdout + "\n" + p.stderr).strip().splitlines() if ln.strip()]
        err = next((ln for ln in tail if "error" in ln.lower()), tail[-1] if tail else "no message")
        return f"the page did not build: {err.strip()[:300]}"
    return ""


# ------------------------------------------------------------------ requests


async def request(c: str, words: str, page: str = "", *, title: str | None = None,
                  said: str | None = None) -> dict[str, Any]:
    """A new fix in the person's words, and its fixer started. `said`: the person's message in main's chat. {fix}."""
    words = (words or "").strip()
    if not words:
        raise HTTPException(400, EMPTY)
    if why := problem():
        raise HTTPException(409, why)
    args = ["new", "--made-in", "browser", *(["--title", title] if title else [])]
    rec = _json(await asyncio.to_thread(kernel, args, stdin=words, timeout=180), "new")
    await start_fixer(c, rec, page, said=said, asked=words)
    return {"fix": {"id": rec["id"], "title": rec.get("title"), "state": rec.get("state")}}


CHANGEABLE = ("on", "off", "ready", "working", "failed", "redo")  # the fixes more words can change (plugin/fix/request.ts)


def form_of(words: str, recs: list[dict[str, Any]]) -> tuple[str, int | None]:
    """The words of `/thimble-fix N <words>` and fix N, when N is a fix the person has that words can change; `new
    <words>` and any other words: the words, for a new fix (plugin/fix/request.ts formOf)."""
    n = re.match(r"^#?(\d+)\s+([\s\S]+)$", words)
    if n and any(int(r.get("id") or 0) == int(n.group(1)) and r.get("state") in CHANGEABLE for r in recs):
        return n.group(2).strip(), int(n.group(1))
    fresh = re.match(r"^new\s+([\s\S]+)$", words, re.I)
    return (fresh.group(1).strip() if fresh else words), None


def round_text(rec: dict[str, Any], words: str) -> str:
    """What a fixer that still works reads of a round (plugin/fix/request.ts roundText)."""
    return f"The person adds to this fix (round {rec.get('rounds') or 2}): {words}"


async def change(c: str, fid: int, words: str, page: str = "", *, said: str | None = None,
                 announce: bool = True) -> dict[str, Any]:
    """More words for fix `fid`: a round of that fix (`fix round`), never a new fix. A fixer that still works on it gets
    them; otherwise a new fixer works in the copy the kernel made for the round, which holds the fix's change (one
    that is on stays as it is until the person's Use it now). {fix}."""
    from . import agents  # noqa: PLC0415

    words = (words or "").strip()
    if not words:
        raise HTTPException(400, EMPTY)
    if why := problem():
        raise HTTPException(409, why)
    if _phase.get(fid) in ("testing", "applying", "restarting"):
        raise HTTPException(409, f"thimble is {'checking' if _phase[fid] == 'testing' else 'putting on'} this fix; "
                                 "say it again once its notice shows")
    rec = _json(await asyncio.to_thread(kernel, ["round", str(fid)], stdin=words, timeout=180), "round")
    conv = _fixers.get(fid)
    if conv is not None and conv.running:
        at = _where.get(fid)
        if said:
            agents.mirror(c, "user", by=agents.BROWSER, text=said)
        if at is not None:
            agents.Recorder(at[0], at[1]).record("user", text=words, by=agents.BROWSER)
            if announce:
                agents.mirror(c, "agent", chat=at[1], role=FIXER, title=fixing_word(rec), by=agents.BROWSER)
        conv.queue.append(round_text(rec, words))
    else:
        await start_fixer(c, rec, page, said=said, asked=words, announce=announce)
    return {"fix": {"id": rec["id"], "title": rec.get("title"), "state": rec.get("state"), "round": True}}


def words_of(text: str) -> str | None:
    """The words after /thimble-fix in a chat message, or None when the message is no /thimble-fix."""
    m = re.match(rf"^\s*{re.escape(COMMAND)}(?:\s+([\s\S]*))?$", text or "")
    return (m.group(1) or "").strip() if m else None


def _recover_soon() -> None:
    """Once per server: a fix made in the browser whose fixer this server does not run (the server stopped while it
    worked) is taken as it stands, as at its fixer's end."""
    global _recovered
    if _recovered or problem():
        return
    _recovered = True
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    for r in records():
        fid = int(r["id"])
        if r.get("made_in") == "browser" and r.get("state") == "working" and fid not in _fixers and fid not in _phase:
            loop.create_task(settle(fid, ""), name=f"fix-recover:{fid}")


# ------------------------------------------------------------------ routes


class Asked(BaseModel):
    words: str
    page: str = ""
    fix: int | None = None  # words typed in the fix's own thread: a round of it


def _clicked(http: Request) -> None:
    """The analyst's click alone: the server's token, which Claude's tools hold, is not enough."""
    from . import subagents  # noqa: PLC0415

    subagents.analyst_only(http)


@router.get("/fixes")
async def status_route(every: bool = False) -> dict[str, Any]:
    return await asyncio.to_thread(status, every)


@router.post("/ws/{c}/fixes", status_code=202)
async def request_route(c: str, body: Asked, http: Request) -> dict[str, Any]:
    """/thimble-fix in the chat: the person's words and what the page shows. `/thimble-fix N <words>` is a round of fix
    N, as a message in fix N's own thread is (`fix`); any other words are a new fix."""
    _clicked(http)
    config.workspace_dir(c)
    if body.fix is not None:
        return await change(c, int(body.fix), body.words, body.page, announce=False)
    said = f"{COMMAND} {(body.words or '').strip()}"
    words, target = form_of((body.words or "").strip(), await asyncio.to_thread(records) if not problem() else [])
    if target is not None:
        return await change(c, target, words, body.page, said=said)
    return await request(c, words, body.page, said=said)


@router.post("/fixes/{fid}/apply", status_code=202)
async def apply_route(fid: int, http: Request) -> dict[str, Any]:
    """Use it now on the notice, or Use it in Your fixes: the person's click puts the fix on, and the server starts
    again with it."""
    _clicked(http)
    await apply(fid)
    return {"restart": True}


@router.post("/fixes/{fid}/undo")
async def undo_route(fid: int, http: Request) -> dict[str, Any]:
    """Undo on the row: the fix goes off, and the server starts again without it."""
    _clicked(http)
    rec = _json(await asyncio.to_thread(kernel, ["undo", str(fid)], timeout=300), "undo")
    title = str(rec.get("title") or f"fix {fid}")
    why = await asyncio.to_thread(prepare, target_root())
    if why:
        note(fid, "problem", f"thimble fix undone: {title}, but {why}")
        return {"restart": False}
    await restart(fid, f"thimble fix undone: {title}", "undone", f"undo of fix {fid}")
    return {"restart": True}


@router.post("/ws/{c}/fixes/{fid}/redo", status_code=202)
async def redo_route(c: str, fid: int, http: Request) -> dict[str, Any]:
    """Redo on a fix that did not pass: a new copy, and a new fixer with the earlier change."""
    _clicked(http)
    config.workspace_dir(c)
    before = await asyncio.to_thread(record, fid)
    rec = _json(await asyncio.to_thread(kernel, ["redo", str(fid)], timeout=180), "redo")
    dismiss(fid)
    await start_fixer(c, {**rec, "error": before.get("error")}, earlier=True, announce=False)
    return {"fix": {"id": rec["id"], "title": rec.get("title"), "state": rec.get("state")}}


@router.post("/fixes/{fid}/dismiss")
async def dismiss_route(fid: int, http: Request) -> dict[str, Any]:
    _clicked(http)
    await asyncio.to_thread(dismiss, fid)
    return {"ok": True}
