"""thimble fix in the browser workbench: the person asks for a change to their own thimble in their own words
(`/thimble-fix <words>` in the chat, or Report a problem's File a code ticket), Claude makes it in a copy of thimble,
and when the kernel's checks pass, the chat asks the person to use it; their click puts it on and
thimble-browser starts again from it. The same records and verbs as the terminal's /thimble-fix
(plugin/engine/kernel/fixes.py), so a fix made in one is on in the other once it starts again.

The kernel holds every record and makes every change, in the terminal plugin's home ($THIMBLE_PLUGIN_HOME, else
~/.thimble), never in the browser's own home:

    fixes/fixes.jsonl   the records          fixes/live/      the checkout with the fixes that are on (branch mine)
    fixes/work/<id>/    a fix's copy          fixes/tmp/<id>/  its temp folder
    fixes/release/      the release commit, which no fix changes

This module calls it as `thimble fix VERB`, with THIMBLE_HOME set to that home, from fixes/release once it is there
(kernel_script), so that no fix can break the clicks that undo it.

    ask(c, words, page)      the person's `/thimble-fix <words>` in main's chat, as the terminal's /thimble-fix: main's
                             chat shows the message, and main reads prompts/thimble-fix.md with the words and the
                             person's fixes beside it (fixes_context), so that main decides whether the words follow up
                             on a fix. Main starts the fix with its fix_thimble tool (from_tool), `N` for a round of fix
                             N or `new` for a new fix, or first asks the person one short question. The fix takes the
                             person's words as they typed them, never main's, and only in the turn of main's that reads
                             them or the next one (words_read, main_turn_ended), as in the terminal: a later call of
                             main's own starts no fix. A fix's number alone tries a fix that failed or no longer fits
                             again (tries_again), as its Try again does; anything else alone says how to ask (EMPTY)
    request(c, words, page)  a new fix (`fix new --made-in browser`) and its fixer
    change(c, fid, words)    more words for a fix the person has (fix_thimble's `N <words>`, or a message in the fix's
                             thread): a round of that fix (`fix round`), never a new fix. A fixer that still works gets
                             the words; otherwise a new fixer works in the copy the kernel made for the round
    the fixer                a fork of main's conversation: it has the chat so far, and its first message is the
                             registry's fixer text (plugin/prompts/fixer.md), the person's words and a text copy of what
                             the page shows. It runs with main's tools and Edit and Write, in the runtime's usual
                             sandbox, which writes only its copy and its temp folder (runtime.spec_of). It runs in the
                             background, as a subagent of main in a chat of its own that the thread tree lists
                             (`fixing <name>`, or `changing <name>` for a round of a fix the person has): main's chat
                             shows it where main started it, as the card of a subagent with its steps (an `agent`
                             record whose `run` is the round), and its thread shows its whole run
    its end (settle)         the kernel commits the change, refuses a change to the way back (the fix flow, the privacy
                             scan) or a binary file, and runs the checks of the parts of thimble the change touched
                             (`fix done`), as it checks the fixes an update puts back, one fix at a time; a fix that
                             passes is ready. How it ended is a row
                             in main's chat and in the fix's thread, at the time it ended (note: a `fix` chip): a ready
                             fix asks the person there, Use it now, What changed, Later. Nothing goes on by itself
    the person's clicks      Use it now, or Use it in Your fixes (`fix apply`, with a secret made at the click as the
                             terminal's key press makes one; then the page of live's browser/ is built and the server
                             starts again from live, dev._do_restart; a page that does not build takes the fix off
                             again; once it is on, a row says so), Later (the row asks no more, the fix stays ready in
                             Your fixes), Undo (`fix undo`, then a restart), Try again (`fix redo`, a new fixer with the
                             earlier change, redo) and, on a fix that did not pass, Ask Claude, which shows what it
                             tried and puts its failure in main's composer for the person to send, once, with its change
                             and the end of its tests' output (tried_route), since main's sandbox cannot read the copy
                             (FixStrip.tsx)

What the last row of each fix says lives in the browser's home (fixes.json, by fix id), so it is still there after the
restart; the newest row of a fix shows its state now, with the clicks it takes.
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
EMPTY = "Ask for a change to thimble with /thimble-fix <what should work differently>."  # plugin/fix/fixes.ts FIX_ALONE
RESTART_BY_HAND = "restart thimble-browser to load it"
RESTART_AFTER_S = 0.3  # restart starts the server again this long after it returns, so the answer its caller gives goes out
BUSY_WAIT_S = 600.0  # how long a restart waits for main and the other agents to end their turns
LINKS = (("backend", ".venv"), ("frontend", "node_modules"))  # what the install lends a copy and live's browser/
PAGE_CHARS = 8000  # of the text copy of the page
TRIED_CHARS = 6000  # of a fix's change in Ask Claude's message (tried_route)
TAIL_CHARS = 2000  # of the end of its tests' output there
# main's turns in which fix_thimble still takes the person's /thimble-fix words: the turn that reads them, and the one
# after main's question (plugin/fix/register.ts fixAsked)
ASKED_TURNS = 2

PROMPT = "thimble-fix"  # what main reads of the person's /thimble-fix (prompts/thimble-fix.md)


@dataclass
class _Asking:
    """The person's /thimble-fix in a workspace, which main's fix_thimble may take (from_tool) once main read it."""
    words: str  # what they typed after /thimble-fix
    page: str  # the text copy of the page then
    turns: int = ASKED_TURNS  # main's turn ends, from the turn that reads the words, before they go (main_turn_ended)


_phase: dict[int, str] = {}  # fix id → fixing | testing | applying | restarting, while this server works on it
# workspace → the person's /thimble-fix that main's turn read, while main may take it (words_read, main_turn_ended)
_asked: dict[str, _Asking] = {}
# workspace → each /thimble-fix posted there that no turn of main's read yet, by the id of the event that carries it
_waiting: dict[str, dict[str, _Asking]] = {}
_since: dict[int, float] = {}  # fix id → when this server's work on it began (a new fix, a round, a redo)
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


def kernel_script() -> Path:
    """The kernel `thimble fix` runs: the release checkout's (fixes/release, which the kernel keeps at the release
    commit), so that a fix to the kernel's own modules cannot break its undo; this tree's before there is one. The
    checkout is first put back as the release commit has it (_pristine), and runs only when its launcher hands the way
    back off itself, as the plugin's launcher asks (bin/thimble: it names fixes/release/plugin): a release checkout
    from before the hand-off runs an older kernel, and this tree's kernel moves it forward."""
    release = fixes_home() / "release" / "plugin" / "engine" / "thimble.py"
    if release.is_file():
        _pristine(fixes_home() / "release")
    try:
        hands_off = "fixes/release/plugin" in (release.parents[1] / "bin" / "thimble").read_text(errors="replace")
    except OSError:
        hands_off = False
    return release if hands_off and release.is_file() else plugin_dir() / "engine" / "thimble.py"


def _pristine(checkout: Path) -> None:
    """The release checkout as the release commit (release.json's base) has it, before any of its code runs: a file
    changed in it is restored and a file added to it removed, as the plugin's launcher and the kernel's place_release
    do. Nothing when it is not a git checkout of its own, or is so already: one git call, which takes no lock, says so,
    and the checkout is left alone, so that thimble's other processes that run from it never meet it half put back.
    git runs no hook of the repository's (in a clone install, the person's own clone's), and tries again for up to 5 s
    while another git holds the checkout's index (index.lock)."""
    git = ["git", "-c", "core.hooksPath=/dev/null", "-C", str(checkout)]
    top = subprocess.run([*git, "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=False).stdout
    if not top.strip() or Path(top.strip()).resolve() != checkout.resolve():
        return
    try:
        base = str(json.loads((fixes_home() / "release.json").read_text()).get("base") or "")
    except (OSError, ValueError, AttributeError):
        base = ""
    base = base if re.fullmatch(r"[0-9a-f]{7,64}", base) else "HEAD"
    st = subprocess.run([*git, "--no-optional-locks", "status", "--porcelain=v2", "--branch", "--ignored",
                         "--untracked-files=normal"], capture_output=True, text=True, check=False)
    lines = st.stdout.splitlines()
    oid = next((x[len("# branch.oid "):] for x in lines if x.startswith("# branch.oid ")), "")
    if (st.returncode == 0 and oid and (base == "HEAD" or oid == base) and "# branch.head (detached)" in lines
            and all(x.startswith("# ") for x in lines)):
        return
    for args in (["checkout", "-q", "-f", "--detach", base], ["clean", "-q", "-ffdx"]):
        for _ in range(50):
            p = subprocess.run([*git, *args], capture_output=True, text=True, check=False)
            if p.returncode == 0 or "index.lock" not in p.stderr:
                break
            time.sleep(0.1)


def kernel(args: list[str], *, stdin: str | None = None, timeout: float = 120, env: dict[str, str] | None = None) -> Ran:
    """`thimble fix ARGS` in the plugin's home. Blocking: call it in a thread."""
    script = kernel_script()
    full = {**config.passed_environ(), "THIMBLE_HOME": str(plugin_home()), "PYTHONDONTWRITEBYTECODE": "1",
            **(env or {})}
    if config.CLI_PATH and not full.get("THIMBLE_CLAUDE"):
        full["THIMBLE_CLAUDE"] = config.CLI_PATH
    full.pop("THIMBLE_ROOT", None)
    try:
        # -B: -I ignores PYTHONDONTWRITEBYTECODE, and the release's kernel would write its bytecode into the checkout
        p = subprocess.run([sys.executable, "-I", "-B", str(script), "fix", *args], input=stdin or "", capture_output=True,
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
    """How fix `fid` ended or what came of the person's click (ready, fixed, failed, request, undone, problem): a row in
    main's chat and in the fix's thread, where it happened (a `fix` chip), and the words the newest row shows with its
    clicks until the analyst dismisses them."""
    notes = _notes()
    notes[str(fid)] = {"kind": kind, "said": said, "at": time.time(), **more}
    p = notes_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(notes, ensure_ascii=False) + "\n", "utf-8")
    tmp.replace(p)
    _row(fid, kind, said)
    _event(fid, kind)


def _row(fid: int, kind: str, said: str) -> None:
    """The row of how fix `fid` ended, in main's chat and in the fix's thread (where), at this time."""
    from . import agents  # noqa: PLC0415

    at = where(fid)
    if at is None:
        return
    rec = {"kind": "fix", "text": said, "ref": f"fix:{fid}", "status": kind}
    with contextlib.suppress(Exception):
        agents.chip(at[0], **rec)
    with contextlib.suppress(Exception):
        agents.Recorder(at[0], at[1]).record("chip", **rec)


def runs_of(c: str, chat: str) -> int:
    """How many runs the fix's chat holds: each opens with the person's words (fixer_chat), so the next run's card in
    main (its `run`) shows that run's steps alone."""
    from . import agents  # noqa: PLC0415

    return sum(1 for e in agents.read_events(agents.paths(c, chat)[1]) if e.get("type") == "user")


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
        if fid not in _phase:
            _since[fid] = time.time()
        _phase[fid] = phase
    else:
        _phase.pop(fid, None)
        _since.pop(fid, None)
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
                     # what it tried, for a fix that did not pass: the files it changed (Ask Claude's message gets
                     # the change itself, tried_route)
                     "paths": [str(f.get("path") or "") for f in files if isinstance(f, dict)][:20],
                     # it needs a change to a file no fix may change: another try without new words fails the same way
                     "blocked": bool(r.get("blocked")),
                     "workspace": conv.c if conv is not None else n.get("workspace"),
                     "agent": conv.agent_id if conv is not None else n.get("agent"),
                     # the row's timer: since this server began the work it shows (a round of a fix made long ago
                     # starts at 0), else since the fix was made
                     "created": _since.get(fid) or float(r.get("created") or 0),
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
# another try in the fix's copy, which held work no check took (the kernel's redo, same_copy; plugin/fix/fixer.ts
# beforeText)
KEPT = ("\n\nThe last try did not pass because {why}. Your copy holds the change of that try, and the changes that were "
        "made in the copy after it. Start from them.")


def first_message(rec: dict[str, Any], page: str, earlier: bool = False) -> str:
    """The fixer's first message: the registry's fixer text, the person's words (each round), where it works, what the
    try before left it, for another try (`earlier`: the kernel's redo says where, and the record why that try did not
    pass), and the page."""
    prompt = (plugin_dir() / "prompts" / "fixer.md").read_text("utf-8").strip()
    words = rec.get("words") or []
    asked = "\n".join(f"Round {i + 1}: {w}" for i, w in enumerate(words)) if len(words) > 1 else (
        words[0] if words else rec.get("title", ""))
    why = str(rec.get("error") or "its checks failed").rstrip(".")
    more = "" if not earlier else KEPT.format(why=why) if rec.get("same_copy") else EARLIER.format(
        patch=rec["earlier"], why=why) if rec.get("earlier") else ""
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
                      asked: str | None = None, announce: bool = True, tell: bool = True) -> None:
    """The fixer on a fix whose copy the kernel just made (a request, a round or a redo): a fork of main's conversation,
    in the background, in the fix's own chat (fixer_chat). `said`: the person's message as they typed it in main's
    chat, which main's chat shows before its line that the fix started; `asked`: the person's words for this round,
    which the fix's chat opens the round with; `announce` False for words typed in the fix's own thread and for Redo,
    which main's chat does not show; `tell` False when main started the fix itself (its tool's result tells it)."""
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
    # main hears of a fix it did not start at the person's next message, as the terminal's fork tells it
    # (plugin/fix/request.ts)
    if tell:
        sp.tell(runtime.MAIN, f"The person asked thimble's fixer for a change to thimble itself (“{fix_name(rec)}”); it "
                              "works in the background in a copy, and thimble shows the person the result. Nothing for "
                              "you to do.")
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
            agents.mirror(c, "agent", chat=chat, role=FIXER, title=title, by=agents.BROWSER, run=runs_of(c, chat))
    if (asked or "").strip():
        agents.Recorder(c, chat).record("user", text=str(asked).strip(), by=agents.BROWSER)
    elif had is not None:
        agents.Recorder(c, chat).record("text", delta=f"\n· Redo, in {'its' if rec.get('same_copy') else 'a new'} copy\n")
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
        # the kernel checks what the change touched, as it checks the fixes an update puts back (its _checks), with this
        # server's Python and the packages lent to the copy
        env = {"THIMBLE_PYTHON": sys.executable, "THIMBLE_FIX_READ": os.pathsep.join(map(str, lent_reads()))}
        args = ["done", str(fid), "--summary", "-", *(["--title", end["title"]] if end["title"] else []),
                *(["--request"] if end["request"] else [])]
        # the tests run for one fix at a time, and once more when they fail (the kernel's run_tests)
        r = await asyncio.to_thread(kernel, args, stdin=end["summary"] or " ", timeout=2400, env=env)
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
    """The server starts again from live's browser/ (once main and the agents end their turns), and a row of the fix
    says `said`. A fix that went on asks nothing more there, as the terminal's line goes once the fix is on: Your fixes
    has its Undo."""
    from . import dev  # noqa: PLC0415

    if not dev.supervised():
        _phase_set(fid, None)
        note(fid, kind, f"{said} · {RESTART_BY_HAND}")
        return
    _phase[fid] = "restarting"  # the fix's row keeps "Reloading thimble…" until the server is back
    note(fid, kind, said, **({"dismissed": True} if kind == "fixed" else {}))
    _phase_set(fid, "restarting")
    t0 = time.monotonic()
    while _busy() and time.monotonic() - t0 < BUSY_WAIT_S:
        await asyncio.sleep(2)
    root = target_root()
    asyncio.get_running_loop().call_later(RESTART_AFTER_S, lambda: asyncio.ensure_future(
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
                  said: str | None = None, tell: bool = True) -> dict[str, Any]:
    """A new fix in the person's words, and its fixer started. `said`: the person's message in main's chat; `tell` False
    when main asked for it (start_fixer). {fix}."""
    words = (words or "").strip()
    if not words:
        raise HTTPException(400, EMPTY)
    if why := problem():
        raise HTTPException(409, why)
    args = ["new", "--made-in", "browser", *(["--title", title] if title else [])]
    rec = _json(await asyncio.to_thread(kernel, args, stdin=words, timeout=180), "new")
    await start_fixer(c, rec, page, said=said, asked=words, tell=tell)
    return {"fix": {"id": rec["id"], "title": rec.get("title"), "state": rec.get("state")}}


CHANGEABLE = ("on", "off", "ready", "working", "failed", "redo")  # the fixes more words can change (plugin/fix/request.ts)


def head_of(words: str) -> tuple[int | None, bool, str] | None:
    """The head of the explicit form: `N` (a fix's number) or `new`, each with a mark after it or none (`2: …`, `#2 -
    …`, `new: …`), and the words after it, '' when there are none; None when the words have no head
    (plugin/fix/fixes.ts formHead)."""
    m = re.match(r"^(?:#?(\d+)|(new))(?:\s*[:.)\u2013\u2014-])?(?:\s+([\s\S]*))?$", words.strip(), re.I)
    return (int(m.group(1)) if m.group(1) else None, bool(m.group(2)), (m.group(3) or "").strip()) if m else None


def _changeable(n: int | None, recs: list[dict[str, Any]]) -> bool:
    return n is not None and any(int(r.get("id") or 0) == n and r.get("state") in CHANGEABLE for r in recs)


def form_of(words: str, recs: list[dict[str, Any]]) -> tuple[str, int | None]:
    """The words of `/thimble-fix N <words>` and fix N, when N is a fix the person has that words can change; `new
    <words>` and any other words: the words, for a new fix (plugin/fix/request.ts formOf)."""
    h = head_of(words)
    if h and h[2] and _changeable(h[0], recs):
        return h[2], h[0]
    if h and h[2] and h[1]:
        return h[2], None
    return words.strip(), None


def named_fix(asked: str, form: str, recs: list[dict[str, Any]]) -> int | None:
    """The fix the person's words change: their own `N …` (a fix of theirs that words can change), else main's form
    (`N`, with or without words after it); None for a new fix, as their own `new …` or main's `new` asks
    (plugin/fix/request.ts namedFix)."""
    mine = head_of(asked)
    if mine and mine[2] and (mine[1] or _changeable(mine[0], recs)):
        return mine[0] if not mine[1] else None
    main = head_of(form)
    return main[0] if main and _changeable(main[0], recs) else None


def round_text(rec: dict[str, Any], words: str) -> str:
    """What a fixer that still works reads of a round (plugin/fix/request.ts roundText)."""
    return f"The person adds to this fix (round {rec.get('rounds') or 2}): {words}"


async def change(c: str, fid: int, words: str, page: str = "", *, said: str | None = None,
                 announce: bool = True, tell: bool = True) -> dict[str, Any]:
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
            run = runs_of(at[0], at[1])
            agents.Recorder(at[0], at[1]).record("user", text=words, by=agents.BROWSER)
            if announce:
                agents.mirror(c, "agent", chat=at[1], role=FIXER, title=fixing_word(rec), by=agents.BROWSER, run=run)
        conv.queue.append(round_text(rec, words))
        live = True
    else:
        await start_fixer(c, rec, page, said=said, asked=words, announce=announce, tell=tell)
        live = False
    return {"fix": {"id": rec["id"], "title": rec.get("title"), "state": rec.get("state"), "round": True,
                    "change": bool(rec.get("prev")), "live": live}}


def words_of(text: str) -> str | None:
    """The words after /thimble-fix in a chat message, or None when the message is no /thimble-fix."""
    m = re.match(rf"^\s*{re.escape(COMMAND)}(?:\s+([\s\S]*))?$", text or "")
    return (m.group(1) or "").strip() if m else None


def fixes_context(recs: list[dict[str, Any]]) -> str:
    """The person's fixes as main reads them beside their /thimble-fix (prompts/thimble-fix.md's list): one line each,
    the number as the handle for fix_thimble's `N <words>`, then the name and state (plugin/fix/request.ts
    fixesContext); `(none yet)` when they have none."""
    shown = [r for r in recs if r.get("state") in CHANGEABLE][:20]

    def word(r: dict[str, Any]) -> str:
        prev = r.get("prev") or {}
        return f"on, being changed ({r.get('state')})" if prev.get("state") == "on" and r.get("state") != "on" else \
            str(r.get("state"))

    lines = []
    for r in shown:
        summary = _cut(str(r.get("summary") or ""), 160)
        lines.append(f'{r["id"]}  "{fix_name(r, 80)}" ({word(r)})' + (f": {summary}" if summary else ""))
    return "\n".join(lines) or "(none yet)"


def tries_again(rec: dict[str, Any]) -> bool:
    """Whether the fix's number alone (`/thimble-fix N`) tries it again, as its Try again does: it failed, it no longer
    fits (redo), or its new version did not fit when the person used it (a fix changed in place that waits, whose record
    says why). The kernel's line for each that does not fit names /thimble-fix N (plugin/fix/fixes.ts triesAgain)."""
    s = rec.get("state")
    return s in ("failed", "redo") or (s == "ready" and bool(rec.get("prev")) and bool(rec.get("error")))


async def ask(c: str, words: str, page: str = "") -> dict[str, Any]:
    """The person's `/thimble-fix <words>` in main's chat: the message shows there as they typed it, and main reads the
    request with their fixes beside it (prompts/thimble-fix.md), as the terminal's /thimble-fix gives Claude
    (plugin/commands/thimble-fix.md). Main starts the fix with fix_thimble in the turn that reads it or the next one
    (words_read, main_turn_ended), which takes the words and the page as they were now. Posted as main's event, so words
    typed while main works wait for its turn's end. A fix's number alone tries a fix that failed or no longer fits again
    (redo), as its Try again does; with no words otherwise, nothing says what should change. {event}, or {fix} for a try
    again."""
    from . import agents, events, prompts  # noqa: PLC0415

    words = (words or "").strip()
    if not words:
        raise HTTPException(400, EMPTY)
    head = head_of(words)
    if head is not None and not head[2]:
        if why := problem():
            raise HTTPException(409, why)
        rec = next((r for r in await asyncio.to_thread(records) if head[0] is not None and int(r.get("id") or 0) == head[0]),
                   None)
        if rec is None or not tries_again(rec):
            raise HTTPException(400, EMPTY)
        return await redo(c, int(rec["id"]))
    if why := problem():
        raise HTTPException(409, why)
    if not events.reachable(c):
        raise HTTPException(409, events.NOT_LISTENING.format(cwd=config.corpus_dir(c)))
    text = prompts.render(PROMPT, {"words": words, "fixes": fixes_context(await asyncio.to_thread(records))})
    said = f"{COMMAND} {words}"
    eid = secrets.token_hex(4)
    # the words count main's turns from the turn that reads them (words_read): a turn that runs now, and the turns of
    # messages posted before them, are not theirs
    _waiting.setdefault(c, {})[eid] = _Asking(words, page or "")
    agents.mirror(c, "user", by=agents.BROWSER, text=said, event=eid)
    try:
        out = events.post(c, events.MAIN, {"text": text}, mirror=False, line=said, event_id=eid)
    except HTTPException:
        _waiting.get(c, {}).pop(eid, None)
        raise
    return {"event": out.get("id")}


def words_read(c: str, event_id: str) -> None:
    """An event reached main's turn (session.py): when it carries the person's /thimble-fix, this turn reads their words,
    and fix_thimble may take them in it and in the next one (main_turn_ended), as the terminal's /thimble-fix counts from
    the turn its command runs in. Main reads its events in the order they were posted, so one that waited before this
    one and was not read (a turn stopped with its queue) goes with it."""
    waiting = _waiting.get(c)
    if not waiting or event_id not in waiting:
        return
    while waiting:
        eid, a = next(iter(waiting.items()))
        del waiting[eid]
        if eid == event_id:
            _asked[c] = _Asking(a.words, a.page)
            return


def main_turn_ended(c: str) -> None:
    """Main's turn ended (session.py): the person's /thimble-fix words go after ASKED_TURNS of main's turns from the turn
    that read them, as the terminal's do, so that fix_thimble called later on main's own (on the person's yes to main's
    offer, or on words typed without /thimble-fix) starts no fix from them."""
    a = _asked.get(c)
    if a is None:
        return
    a.turns -= 1
    if a.turns <= 0:
        _asked.pop(c, None)


NOT_ASKED = "a fix starts from the person's own words, which they type after /thimble-fix <what should work differently>."


async def from_tool(c: str, form: str) -> dict[str, Any]:
    """Main's fix_thimble after the person's /thimble-fix <words> here: their words, as they typed them, go to the fix,
    never main's; main's `form` names the fix they change, `N` a round of fix N (change), `new` or none a new fix
    (request), and the person's own `N …` or `new …` names it first. The page is as their /thimble-fix sent it. Main's
    chat gets the line that opens the fix's thread; main heard of it in the tool's result. With no /thimble-fix of the
    person's that main read to answer (none, one answered already, one older than ASKED_TURNS of main's turns, or one
    still waiting for main's turn), no fix starts. {fix, kind: new | round | live}."""
    if c not in _asked and _waiting.get(c):
        # the record that brought the words to main's turn may be one the mirror has not read yet: it reads it now
        from . import session  # noqa: PLC0415

        lv = session.current(c)
        if lv is not None:
            session._read_now(lv)
    a = _asked.pop(c, None)
    if a is None or not a.words:
        raise HTTPException(409, NOT_ASKED)
    if why := problem():
        raise HTTPException(409, why)
    recs = await asyncio.to_thread(records)
    target = named_fix(a.words, form or "", recs)
    said = form_of(a.words, recs)[0]
    if target is not None:
        got = await change(c, target, said, a.page, tell=False)
        return {**got, "kind": "live" if got["fix"].get("live") else "round"}
    got = await request(c, said, a.page, tell=False)
    return {**got, "kind": "new"}


def _recover_soon() -> None:
    """Once per server, on the server's loop: a fix made in the browser whose fixer this server does not run (the
    server stopped while it worked) is taken as it stands, as at its fixer's end. Called on the loop (status_route),
    since status() itself runs in a worker thread, which has no loop to start the recovery on."""
    global _recovered
    if _recovered or problem():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _recovered = True
    loop.create_task(_recover(), name="fix-recover")


async def _recover() -> None:
    for r in await asyncio.to_thread(records):
        fid = int(r["id"])
        if r.get("made_in") == "browser" and r.get("state") == "working" and fid not in _fixers and fid not in _phase:
            asyncio.get_running_loop().create_task(settle(fid, ""), name=f"fix-recover:{fid}")


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
    _recover_soon()
    return await asyncio.to_thread(status, every)


@router.post("/ws/{c}/fixes", status_code=202)
async def request_route(c: str, body: Asked, http: Request) -> dict[str, Any]:
    """/thimble-fix in the chat: the person's words and what the page shows go to main, which decides whether they
    follow up on a fix of theirs (ask). Words typed in fix N's own thread (`fix`) are a round of fix N."""
    _clicked(http)
    config.workspace_dir(c)
    if body.fix is not None:
        return await change(c, int(body.fix), body.words, body.page, announce=False)
    return await ask(c, body.words, body.page)


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


async def redo(c: str, fid: int) -> dict[str, Any]:
    """Try again on a fix that did not pass, or the person's `/thimble-fix N` alone on one (ask): a new fixer, in the
    person's words of before, in the fix's copy while that holds work no check took (a change made there in the
    terminal, after its d), else in a new copy with the earlier change (the kernel's redo). {fix}."""
    before = await asyncio.to_thread(record, fid)
    rec = _json(await asyncio.to_thread(kernel, ["redo", str(fid)], timeout=180), "redo")
    dismiss(fid)
    await start_fixer(c, {**rec, "error": before.get("error")}, earlier=True, announce=False)
    return {"fix": {"id": rec["id"], "title": rec.get("title"), "state": rec.get("state")}}


@router.post("/ws/{c}/fixes/{fid}/redo", status_code=202)
async def redo_route(c: str, fid: int, http: Request) -> dict[str, Any]:
    """Try again on a fix that did not pass (redo)."""
    _clicked(http)
    config.workspace_dir(c)
    return await redo(c, fid)


def tried(fid: int) -> dict[str, str]:
    """What fix `fid` tried, for Ask Claude's message, which main reads in a sandbox that cannot open the fix's copy:
    its change (`fix diff`), cut at a line to TRIED_CHARS, and the end of its tests' output, '' for none. The person's
    own code on their own machine, which the message shows them before they send it."""
    out = kernel(["diff", str(fid)], timeout=60)
    diff = out.out if out.ok else ""
    if len(diff) > TRIED_CHARS:
        diff = diff[: diff.rfind("\n", 0, TRIED_CHARS) + 1 or TRIED_CHARS] + "…\n"
    tail = ""
    with contextlib.suppress(HTTPException):
        tail = str(record(fid).get("tests_tail") or "").strip()
    return {"diff": diff, "tests": tail[-TAIL_CHARS:]}


@router.get("/fixes/{fid}/tried")
async def tried_route(fid: int) -> dict[str, str]:
    """Ask Claude on a fix that did not pass: its change and the end of its tests' output (tried)."""
    return await asyncio.to_thread(tried, fid)


@router.post("/fixes/{fid}/dismiss")
async def dismiss_route(fid: int, http: Request) -> dict[str, Any]:
    _clicked(http)
    await asyncio.to_thread(dismiss, fid)
    return {"ok": True}
