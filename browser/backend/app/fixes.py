"""thimble fix in the browser workbench: the person asks for a change to their own thimble in their own words
(`/thimble-fix <words>` in the chat, Report a problem's File a code ticket, or main's file_dev_ticket), Claude makes it in
a copy of thimble, and when the kernel's checks pass, the fix is on and thimble-browser starts again from it. The same
records and verbs as the terminal's /thimble-fix (plugin/engine/kernel/fixes.py), so a fix made in one is on in the
other once it starts again.

The kernel holds every record and makes every change, in the terminal plugin's home ($THIMBLE_PLUGIN_HOME, else
~/.thimble), never in the browser's own home:

    fixes/fixes.jsonl   the records          fixes/live/      the checkout with the fixes that are on (branch mine)
    fixes/work/<id>/    a fix's copy          fixes/tmp/<id>/  its temp folder

This module calls it as `thimble fix VERB`, with THIMBLE_HOME set to that home.

    request(c, words, page)  a new fix (`fix new --made-in browser`) and its fixer
    the fixer                a fork of main's conversation: it has the chat so far, and its first message is the
                             registry's fixer text (plugin/prompts/fixer.md), the person's words and a text copy of what
                             the page shows. It runs with main's tools and Edit and Write, in the runtime's usual
                             sandbox, which writes only its copy and its temp folder (runtime.spec_of)
    its end (settle)         the kernel commits the change, refuses a safety file or a binary file, and runs the tests
                             of what the change touched (`fix done`); a fix that passes goes on (`fix apply`, with a
                             secret made here as the terminal's key press makes one), the page of live's browser/ is
                             built, and the server starts again from live (dev._do_restart). A page that does not build
                             takes the fix off again (`fix undo`)
    the person's clicks      Undo (`fix undo`, then a restart), Redo (`fix redo`, a new fixer with the earlier change)
                             and Dismiss, on the one row above the composer that says how each fix went (FixStrip.tsx)

What each row says lives in the browser's home (fixes.json, by fix id), so the row is still there after the restart.
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
    """The analyst's click, or a check that passed, for `fix apply`: a secret held only here, its sha256 in
    asks/<id>.json, which the kernel checks and uses once (the terminal's key press, plugin/fix/fixes.ts pressKey)."""
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
    """What fix `fid`'s row says now (fixed, failed, request, undone, problem), until the analyst dismisses it."""
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


def status() -> dict[str, Any]:
    """Each fix the row can show: the ones this server works on (their phase), and the ones whose end is not
    dismissed yet. Newest first."""
    _recover_soon()
    why = problem()
    notes = _notes()
    rows = []
    for r in ([] if why else records()):
        fid = int(r["id"])
        n = notes.get(str(fid)) or {}
        phase = _phase.get(fid)
        if not phase and (not n or n.get("dismissed")):
            continue
        conv = _fixers.get(fid)
        rows.append({"id": fid, "title": r.get("title") or "", "state": r.get("state"), "phase": phase,
                     "kind": n.get("kind") if not phase else None, "said": n.get("said") if not phase else None,
                     "tests": r.get("tests"), "error": r.get("error"), "words": (r.get("words") or [""])[-1],
                     "workspace": conv.c if conv is not None else n.get("workspace"),
                     "agent": conv.agent_id if conv is not None else n.get("agent"),
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
                    (have / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    exclude = fixes_home() / "live" / ".git" / "info" / "exclude"
    with contextlib.suppress(OSError):
        lines = exclude.read_text().splitlines() if exclude.is_file() else []
        want_lines = [f"browser/{p}/{n}" for p, n in LINKS]
        if any(w not in lines for w in want_lines):
            exclude.parent.mkdir(parents=True, exist_ok=True)
            exclude.write_text("\n".join([*lines, *[w for w in want_lines if w not in lines]]) + "\n")


def lent_reads() -> list[Path]:
    """The real folders of what lend() links, which the fixer and the tests read."""
    return [Path(os.path.realpath(config.REPO_ROOT / p / n)) for p, n in LINKS if (config.REPO_ROOT / p / n).exists()]


def fixer_roots(fid: int) -> tuple[Path, list[Path], list[Path]]:
    """The fixer's working folder, what it reads beside main's reads, and what it writes (runtime.spec_of)."""
    work = fixes_home() / "work" / str(fid)
    tmp = fixes_home() / "tmp" / str(fid)
    git_dir = fixes_home() / "live" / ".git"
    return work, [git_dir, *lent_reads()], [work, tmp]


async def start_fixer(c: str, rec: dict[str, Any], page: str = "", *, earlier: bool = False) -> None:
    """The fixer on a fix whose copy the kernel just made (a request or a redo): a fork of main's conversation."""
    from . import runtime  # noqa: PLC0415

    fid = int(rec["id"])
    if rec.get("work"):
        await asyncio.to_thread(lend, Path(rec["work"]) / "browser")
    text = await asyncio.to_thread(first_message, rec, page, earlier)
    sp = runtime.ensure(c)
    agent_id = runtime._agent_id()
    conv = runtime.Conv(sp, agent_id, "fork", agent_id=agent_id, agent_type=runtime.FORK_TYPE, role=FIXER,
                        values={"fix": fid}, base=runtime.MAIN,
                        transcript=runtime.Transcript(sp.sub_path(agent_id), sp.sid, agent_id))
    sp.convs[agent_id] = conv
    conv.transcript.write_meta({"agentType": runtime.FORK_TYPE, "isFork": True,  # type: ignore[union-attr]
                                "description": f"fix {fid}: {rec.get('title') or ''}".strip()})
    conv.queue.append(text)
    _fixers[fid] = conv
    _phase_set(fid, "fixing")
    conv.task = runtime._spawn_task(_run_fixer(conv, fid), f"fixer:{c}:{agent_id}")


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
    """The fixer ended: the kernel's checks, then the fix goes on and the server starts again from it, or the row says
    why not."""
    _fixers.pop(fid, None)
    _phase_set(fid, "testing")
    try:
        rec = await asyncio.to_thread(record, fid)
        if rec.get("state") != "working":
            _phase_set(fid, None)
            return
        if why := await asyncio.to_thread(srt_ready):
            _phase_set(fid, None)
            note(fid, "problem", f"Fix {fid} could not be checked: {why}")
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
    title = str(done.get("title") or f"fix {fid}")
    state = str(done.get("state") or "")
    if not r.ok:
        _phase_set(fid, None)
        note(fid, "problem", f"Fix {fid} could not be checked: {r.err or 'thimble fix done gave nothing'}")
    elif state == "request":
        _phase_set(fid, None)
        note(fid, "request", f"Saved as a request with no code: {title}")
    elif state != "ready":
        _phase_set(fid, None)
        note(fid, "failed", f"Fix {fid} did not pass: {title} · {done.get('error') or 'its tests failed'}")
    else:
        await apply(fid, title, str(done.get("tests") or ""))


async def apply(fid: int, title: str, tests: str) -> None:
    """A fix whose checks passed goes on; live's page is built; the server starts again from live."""
    _phase_set(fid, "applying")
    secret = press(fid)
    r = await asyncio.to_thread(kernel, ["apply", str(fid), "--ask", "-"], stdin=secret, timeout=300)
    if not r.ok:
        _phase_set(fid, None)
        note(fid, "failed", f"Fix {fid} did not go on: {title} · {r.err or 'thimble fix apply gave nothing'}")
        return
    why = await asyncio.to_thread(prepare, target_root())
    if why:
        await asyncio.to_thread(kernel, ["undo", str(fid)], timeout=300)
        _phase_set(fid, None)
        note(fid, "failed", f"Fix {fid} did not pass: {title} · {why}; it is off again")
        return
    said = f"thimble fixed: {title}" + (" · tests pass" if tests == "passed" else "")
    await restart(fid, said, "fixed", f"fix {fid}: {title}")


async def restart(fid: int, said: str, kind: str, why: str) -> None:
    """The server starts again from live's browser/ (once main and the agents end their turns), and the row says
    `said` after it."""
    from . import dev  # noqa: PLC0415

    if not dev.supervised():
        _phase_set(fid, None)
        note(fid, kind, f"{said} · {RESTART_BY_HAND}")
        return
    note(fid, kind, said)
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


async def request(c: str, words: str, page: str = "", *, title: str | None = None) -> dict[str, Any]:
    """A new fix in the person's words, and its fixer started. {fix}."""
    words = (words or "").strip()
    if not words:
        raise HTTPException(400, EMPTY)
    if why := problem():
        raise HTTPException(409, why)
    args = ["new", "--made-in", "browser", *(["--title", title] if title else [])]
    rec = _json(await asyncio.to_thread(kernel, args, stdin=words, timeout=180), "new")
    await start_fixer(c, rec, page)
    return {"fix": {"id": rec["id"], "title": rec.get("title"), "state": rec.get("state")}}


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


def _clicked(http: Request) -> None:
    """The analyst's click alone: the server's token, which Claude's tools hold, is not enough."""
    from . import subagents  # noqa: PLC0415

    subagents.analyst_only(http)


@router.get("/fixes")
async def status_route() -> dict[str, Any]:
    return await asyncio.to_thread(status)


@router.post("/ws/{c}/fixes", status_code=202)
async def request_route(c: str, body: Asked, http: Request) -> dict[str, Any]:
    """/thimble-fix in the chat: the person's words and what the page shows."""
    _clicked(http)
    config.workspace_dir(c)
    return await request(c, body.words, body.page)


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
    await start_fixer(c, {**rec, "error": before.get("error")}, earlier=True)
    return {"fix": {"id": rec["id"], "title": rec.get("title"), "state": rec.get("state")}}


@router.post("/fixes/{fid}/dismiss")
async def dismiss_route(fid: int, http: Request) -> dict[str, Any]:
    _clicked(http)
    await asyncio.to_thread(dismiss, fid)
    return {"ok": True}
