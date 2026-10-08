"""Turns of main's that end on a thimble call, without closing words.

Claude Code asks the model for a visible reply whenever a turn ends without text, unless the environment variable ENV
names a tool the turn called; it matches any tool's name, not only an MCP tool's. The launcher sets ENV to Agent,
SendMessage, TaskStop and every thimble tool whose result the browser shows (names), and main's prompt then ends such a
turn without text. With these three names Claude Code stopped nudging main after a start, a follow-up or a stop of one
of thimble's subagents (0 nudges in 15 such turns, against 38 in 97 calls without them). Where Claude Code does not read ENV, main's
prompt keeps the other ending: the end token (session.END_TOKEN), which no chat shows. The prompt's two endings are
one line each of main.md (ENDINGS); main_prompt keeps the one that applies.

Whether a `claude` executable reads ENV is decided once per executable (its path, size and modification time) and kept
in $THIMBLE_HOME/CACHE: it reads it when ENV's name is in the file (supported). The mirror refutes that when Claude
Code still asks for a reply after a turn whose last call ENV names (refute); the next launch then uses the end token.
"""
from __future__ import annotations

import json
import logging
import mmap
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping

log = logging.getLogger("thimble.terminal_tools")

ENV = "CLAUDE_CODE_TERMINAL_MCP_TOOLS"
BIN_ENV = "THIMBLE_CLAUDE_BIN"  # the `claude` executable to use instead of the one on PATH (cli.claude_code_version)
BUILTIN = ("Agent", "SendMessage", "TaskStop")  # main starts, continues and stops thimble's subagents with these
# thimble tools whose result the model reads rather than the browser shows, so a turn that ends on one still needs words
READS = ("read_ref", "list_cards", "screenshot", "list_agents", "wait_session")
CACHE = "terminal-tools.json"
# main.md's two endings of a turn with nothing for the analyst, by a phrase only that line holds: with ENV read, and
# without it
ENDINGS = {True: "needs no closing words", False: "which thimble never shows"}
# the meta prompt Claude Code adds when a turn ended without text
NUDGE = "[Your previous response had no visible output"


def tool_name(name: str) -> str:
    """A thimble tool's name as the analyst's session sees it, from the plugin's server."""
    from . import orientation, tools  # noqa: PLC0415 — both import more than the launcher's other values need

    return f"mcp__plugin_{orientation.PLUGIN}_{tools.SERVER_NAME}__{name}"


def names() -> list[str]:
    """The tools ENV names: BUILTIN and every thimble tool but READS."""
    from . import tools  # noqa: PLC0415

    return [*BUILTIN, *(tool_name(n) for n in tools.REGISTRY if n not in READS)]


def _listed(environ: Mapping[str, str]) -> list[str]:
    return [t.strip() for t in str(environ.get(ENV) or "").split(",") if t.strip()]


def value(environ: Mapping[str, str] | None = None) -> str:
    """ENV for a launch: the entries the analyst's environment already holds, then names() not among them."""
    env = os.environ if environ is None else environ
    return ",".join(dict.fromkeys([*_listed(env), *names()]))


def executable(environ: Mapping[str, str] | None = None) -> Path | None:
    """The `claude` executable a session started from `environ` runs: BIN_ENV, else `claude` on its PATH, with links
    resolved; None when there is none."""
    env = os.environ if environ is None else environ
    exe = env.get(BIN_ENV) or shutil.which("claude", path=env.get("PATH"))
    if not exe:
        return None
    try:
        path = Path(exe).resolve()
    except OSError:
        return None
    return path if path.is_file() else None


def _cache_path() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser() / CACHE


def _key(path: Path) -> str | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return f"{path}:{st.st_size}:{st.st_mtime_ns}"


def _cache() -> dict:
    try:
        d = json.loads(_cache_path().read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def _save(d: dict) -> None:
    path = _cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(d, indent=1), "utf-8")
        tmp.replace(path)
    except OSError as e:
        log.info("the cache %s was not written (%s)", path, e)


def _reads(path: Path) -> bool:
    """Whether ENV's name is in the file at `path`."""
    needle = ENV.encode()
    try:
        with path.open("rb") as f:
            with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as m:
                return m.find(needle) >= 0
    except (OSError, ValueError):
        return False


def supported(path: Path | None) -> bool:
    """Whether the `claude` executable at `path` reads ENV and no session has refuted it (module note)."""
    key = _key(path) if path is not None else None
    if key is None or path is None:
        return False
    d = _cache()
    rec = d.get(key)
    if isinstance(rec, dict) and isinstance(rec.get("reads"), bool):
        return rec["reads"] and not rec.get("refuted")
    reads = _reads(path)
    d[key] = {"reads": reads}
    _save(d)
    return reads


def refute(path: Path | None) -> bool:
    """Record that the executable at `path` asked for a reply after a turn that ended on a tool ENV names: it does not
    act on ENV, so later launches use the end token. True when that was news."""
    key = _key(path) if path is not None else None
    if key is None:
        return False
    d = _cache()
    rec = d.get(key) if isinstance(d.get(key), dict) else {}
    if rec.get("refuted"):
        return False
    d[key] = {**rec, "reads": bool(rec.get("reads", True)), "refuted": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    _save(d)
    log.warning("%s does not act on %s: main's next launch ends its turns with the end token", path, ENV)
    return True


def on(environ: Mapping[str, str] | None = None) -> bool:
    """Whether a session started from `environ` ends a turn on a thimble call without text: ENV names thimble's card
    tool, and the session's executable reads ENV."""
    env = os.environ if environ is None else environ
    return tool_name("add_card") in _listed(env) and supported(executable(env))


def launch_value(environ: Mapping[str, str] | None = None) -> str:
    """ENV as the launcher exports it (value), or '' when the `claude` it starts does not read ENV."""
    env = os.environ if environ is None else environ
    return value(env) if supported(executable(env)) else ""


def main_prompt(text: str, terminal: bool) -> str:
    """Main's rendered prompt with the one ending of ENDINGS that applies: without closing words when `terminal`, else
    with the end token."""
    from . import prompts  # noqa: PLC0415

    return prompts.without(text, [], [ENDINGS[not terminal]])


def nudged(environ: Mapping[str, str] | None, last_tool: str | None) -> bool:
    """Whether Claude Code's request for a reply after a turn whose last call was `last_tool` refutes ENV for the
    session whose environment is `environ`: ENV named that tool. Refutes it when so (refute)."""
    if not environ or not last_tool or last_tool not in _listed(environ):
        return False
    refute(executable(environ))
    return True


def line(environ: Mapping[str, str] | None = None) -> str:
    """`thimble doctor`'s line: how main ends a turn that has nothing for the analyst, and why."""
    exe = executable(environ)
    if exe is None:
        return "with the end token (no `claude` on PATH)"
    if supported(exe):
        return f"on the call, without closing words ({exe.name} reads {ENV})"
    rec = _cache().get(_key(exe) or "")
    why = "a session showed it does not act on it" if isinstance(rec, dict) and rec.get("refuted") else "it does not read it"
    return f"with the end token ({exe.name}: {why})"
