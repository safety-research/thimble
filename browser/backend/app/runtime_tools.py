"""The built-in tools of an agent the server runs on the Messages API (runtime_api.py): the same names, inputs and limits
as the Claude Code tools 0.8's agents had, so the prompts read the same in both runtimes.

    Read Grep Glob   read files under the agent's read roots: the corpus, the workspace, thimble's own docs and worked
                     examples (the view kit), and the agent's write folders; never thimble's private files
    Write Edit       write files under the agent's write folders alone (its work folder, the workspace's agent folders)
    Bash             one shell command in Anthropic's sandbox runtime (srt, kernel_wrap.py): it reads what Read reads
                     and the system, writes only the write folders, and starts in the corpus folder
    WebSearch WebFetch  the Messages API's own server tools (web_search, web_fetch)

A tool that cannot run here (Bash without the sandbox) is left out of the agent's list (available). Nothing here
reaches past those folders: every path is resolved, symlinks included, and checked against them.
"""
from __future__ import annotations

import asyncio
import fnmatch
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

READ_LINES = 2000
LINE_CHARS = 2000
GREP_MAX = 250
GLOB_MAX = 500
RESULT_CHARS = 30_000
BASH_TIMEOUT_S = 120
BASH_TIMEOUT_MAX_S = 600
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", ".mypy_cache", ".pytest_cache"}

WEB_SEARCH = {"type": "web_search_20250305", "name": "web_search", "max_uses": 8}
WEB_FETCH = {"type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 8}
WEB_FETCH_BETA = "web-fetch-2025-09-10"
SERVER_NAMES = {"web_search": "WebSearch", "web_fetch": "WebFetch"}  # as a transcript names them

DEFS: dict[str, dict[str, Any]] = {
    "Read": {
        "description": ("Reads a file from the local filesystem. file_path is absolute, or relative to the corpus "
                        "folder. Reads up to 2000 lines from `offset` (1-based), each line numbered as `cat -n` does."),
        "input_schema": {"type": "object", "properties": {
            "file_path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}},
            "required": ["file_path"]},
    },
    "Grep": {
        "description": ("Searches file contents with a regular expression (Python syntax). Returns `path:line: text` "
                        "for each match, under `path` (default: the corpus folder), in files matching `glob`."),
        "input_schema": {"type": "object", "properties": {
            "pattern": {"type": "string"}, "path": {"type": "string"}, "glob": {"type": "string"},
            "-i": {"type": "boolean"}}, "required": ["pattern"]},
    },
    "Glob": {
        "description": "Lists the files whose path under `path` (default: the corpus folder) matches `pattern`.",
        "input_schema": {"type": "object", "properties": {
            "pattern": {"type": "string"}, "path": {"type": "string"}}, "required": ["pattern"]},
    },
    "Bash": {
        "description": ("Runs one bash command in a sandbox and returns its output. Each command starts in the corpus "
                        "folder, which it reads but cannot write; it writes only your own folders. `timeout` in "
                        "milliseconds, up to 600000 (default 120000)."),
        "input_schema": {"type": "object", "properties": {
            "command": {"type": "string"}, "timeout": {"type": "integer"}, "description": {"type": "string"}},
            "required": ["command"]},
    },
    "Write": {
        "description": "Writes a file, replacing what it held. Only your own folders can be written.",
        "input_schema": {"type": "object", "properties": {
            "file_path": {"type": "string"}, "content": {"type": "string"}}, "required": ["file_path", "content"]},
    },
    "Edit": {
        "description": ("Replaces `old_string` with `new_string` in a file, which must hold `old_string` exactly once "
                        "unless `replace_all`. Only your own folders can be edited."),
        "input_schema": {"type": "object", "properties": {
            "file_path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"},
            "replace_all": {"type": "boolean"}}, "required": ["file_path", "old_string", "new_string"]},
    },
}


# Settings' switch that lets main and its thread forks write the corpus folder (ledger.corpus_edits), by its name
EDITS_SWITCH = "Claude can edit files in this folder"
# what the built-in tools' descriptions say of the corpus folder (definitions), by Spec.corpus_edits: True and False
# for main and its thread forks, which the switch reaches, None for thimble's other agents, which never write it
CORPUS_WORDS: dict[bool | None, dict[str, str]] = {
    True: {"Bash": "which it reads and writes; it also writes your own folders",
           "Write": "The corpus folder and your own folders can be written; thimble's own files cannot.",
           "Edit": "The corpus folder and your own folders can be edited; thimble's own files cannot."},
    False: {"Bash": (f"which it reads but cannot write while the analyst's Settings switch \"{EDITS_SWITCH}\" is off; "
                     "it writes only your own folders"),
            "Write": (f"Only your own folders can be written: the corpus folder is read-only while the analyst's "
                      f"Settings switch \"{EDITS_SWITCH}\" is off, which they can turn on."),
            "Edit": (f"Only your own folders can be edited: the corpus folder is read-only while the analyst's "
                     f"Settings switch \"{EDITS_SWITCH}\" is off, which they can turn on.")},
    None: {"Bash": "which it reads but cannot write; it writes only your own folders",
           "Write": "Only your own folders can be written.",
           "Edit": "Only your own folders can be edited."},
}


@dataclass
class Box:
    """What an agent's built-in tools may touch: the folder its commands start in, the roots it reads and the folders
    it writes, and the paths it may never read."""
    cwd: Path
    workspace: Path
    read_roots: list[Path]
    write_roots: list[Path]
    private: list[Path] = field(default_factory=list)
    home: Path | None = None  # HOME and TMPDIR of its commands, inside a write root
    no_write: list[Path] = field(default_factory=list)  # never written, inside a write root or not (runtime.protected)
    corpus_edits: bool | None = None  # Spec.corpus_edits: what a refused write in the corpus tells the agent

    def _inside(self, q: Path, roots: list[Path]) -> bool:
        return any(q == r or r in q.parents for r in roots)

    def path(self, p: str | None, *, write: bool = False) -> Path:
        raw = Path(p) if p and os.path.isabs(p) else self.cwd / (p or ".")
        q = raw.resolve()
        if any(q == x or x in q.parents for x in self.private):
            raise ValueError(f"{p} is private to thimble")
        if write and self._inside(q, [x.resolve() for x in self.no_write]):
            raise ValueError(f"{p} is thimble's own file, which only thimble writes")
        roots = self.write_roots if write else [*self.read_roots, *self.write_roots]
        if not self._inside(q, [r.resolve() for r in roots]):
            what = "write" if write else "read"
            if write and self.corpus_edits is False and self._inside(q, [self.cwd.resolve()]):
                raise ValueError(f"{p} is in the corpus folder, which is read-only while the analyst's Settings switch "
                                 f"\"{EDITS_SWITCH}\" is off; they can turn it on there")
            raise ValueError(f"{p} is outside the folders this agent may {what}")
        return q


@dataclass
class Out:
    text: str
    is_error: bool = False


def _cut(text: str) -> str:
    return text if len(text) <= RESULT_CHARS else text[:RESULT_CHARS] + f"\n[cut at {RESULT_CHARS} characters]"


def _binary(p: Path) -> bool:
    try:
        with p.open("rb") as f:
            return b"\0" in f.read(4096)
    except OSError:
        return False


def _lines(p: Path) -> list[str]:
    return p.read_text("utf-8", errors="replace").splitlines()


def _files(base: Path) -> list[Path]:
    out = []
    for d, dirs, files in os.walk(base):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        out.extend(Path(d) / f for f in sorted(files))
    return out


def sandbox_reason() -> str:
    """'' when Bash can run in the sandbox here, else why not."""
    from . import config, kernel_wrap, srt  # noqa: PLC0415

    node, pkg = srt.node(), srt.package(config.REPO_ROOT)
    if pkg is None or not node:
        return srt.missing(config.REPO_ROOT, node) or "the sandbox runtime is not installed"
    return "" if kernel_wrap.srt_works(node, pkg) else "the sandbox runtime cannot run on this machine"


def available(names: tuple[str, ...] | list[str]) -> list[str]:
    """`names` without Bash where the sandbox cannot run."""
    return [n for n in names if n != "Bash" or not sandbox_reason()]


def definitions(names: list[str], corpus_edits: bool | None = None) -> list[dict[str, Any]]:
    """The Messages API's tool entries for the built-in `names`: client tools, and the server tools for the web. Bash,
    Write and Edit say what they may do in the corpus folder by `corpus_edits` (CORPUS_WORDS)."""
    out: list[dict[str, Any]] = []
    for n in names:
        if n == "WebSearch":
            out.append(dict(WEB_SEARCH))
        elif n == "WebFetch":
            out.append(dict(WEB_FETCH))
        elif n in DEFS:
            out.append({"name": n, **DEFS[n], **({"description": describe(n, corpus_edits)} if n in CORPUS_WORDS[None]
                                                  else {})})
    return out


def describe(name: str, corpus_edits: bool | None) -> str:
    """Bash's, Write's or Edit's description with what it may do in the corpus folder (CORPUS_WORDS)."""
    words = CORPUS_WORDS[corpus_edits][name]
    if name == "Bash":
        return ("Runs one bash command in a sandbox and returns its output. Each command starts in the corpus folder, "
                f"{words}. `timeout` in milliseconds, up to 600000 (default 120000).")
    if name == "Write":
        return f"Writes a file, replacing what it held. {words}"
    return ("Replaces `old_string` with `new_string` in a file, which must hold `old_string` exactly once unless "
            f"`replace_all`. {words}")


async def call(box: Box, name: str, args: dict[str, Any]) -> Out:
    try:
        fn = {"Read": _read, "Grep": _grep, "Glob": _glob, "Bash": _bash, "Write": _write, "Edit": _edit}[name]
    except KeyError:
        return Out(f"no tool {name}", True)
    try:
        got = await fn(box, args)
    except (ValueError, OSError) as e:
        return Out(f"{name} failed: {e}", True)
    got.text = _cut(got.text)
    return got


async def _read(box: Box, a: dict[str, Any]) -> Out:
    q = box.path(a.get("file_path"))
    if q.is_dir():
        return Out(f"{a.get('file_path')} is a folder: list it with Glob or Bash ls", True)
    if not q.exists():
        return Out(f"there is no file {a.get('file_path')}", True)
    if _binary(q):
        return Out(f"{a.get('file_path')} is a binary file ({q.stat().st_size} bytes)", True)
    offset = max(1, int(a.get("offset") or 1))
    limit = max(1, min(int(a.get("limit") or READ_LINES), READ_LINES))
    lines = await asyncio.to_thread(_lines, q)
    out = [f"{n:>6}\t{ln[:LINE_CHARS]}" for n, ln in enumerate(lines[offset - 1:offset - 1 + limit], offset)]
    more = len(lines) - (offset - 1 + limit)
    if more > 0:
        out.append(f"[{more} more lines: read on with offset {offset + limit}]")
    return Out("\n".join(out) or "(empty file)")


async def _glob(box: Box, a: dict[str, Any]) -> Out:
    base = box.path(a.get("path"))
    pat = str(a.get("pattern") or "**/*")

    def run() -> list[str]:
        hits = []
        for f in _files(base):
            rel = str(f.relative_to(base))
            if fnmatch.fnmatch(rel, pat) or (pat.startswith("**/") and fnmatch.fnmatch(rel, pat[3:])):
                hits.append(str(f))
        return hits

    hits = await asyncio.to_thread(run)
    if not hits:
        return Out("No files found")
    extra = f"\n[{len(hits) - GLOB_MAX} more]" if len(hits) > GLOB_MAX else ""
    return Out("\n".join(hits[:GLOB_MAX]) + extra)


async def _grep(box: Box, a: dict[str, Any]) -> Out:
    base = box.path(a.get("path"))
    try:
        rx = re.compile(str(a["pattern"]), re.I if a.get("-i") else 0)
    except re.error as e:
        return Out(f"the pattern is not a regular expression: {e}", True)
    glob = a.get("glob")

    def run() -> list[str]:
        out: list[str] = []
        for f in [base] if base.is_file() else _files(base):
            if glob and not fnmatch.fnmatch(f.name, glob) and not fnmatch.fnmatch(str(f), glob):
                continue
            if _binary(f):
                continue
            try:
                for n, line in enumerate(_lines(f), 1):
                    if rx.search(line):
                        out.append(f"{f}:{n}: {line[:400]}")
                        if len(out) >= GREP_MAX:
                            return out
            except OSError:
                continue
        return out

    out = await asyncio.to_thread(run)
    if not out:
        return Out("No matches found")
    more = "" if len(out) < GREP_MAX else f"\n[stopped at {GREP_MAX} lines: narrow the pattern or the path]"
    return Out("\n".join(out) + more)


async def _write(box: Box, a: dict[str, Any]) -> Out:
    q = box.path(a.get("file_path"), write=True)
    q.parent.mkdir(parents=True, exist_ok=True)
    text = str(a.get("content") or "")
    await asyncio.to_thread(q.write_text, text, "utf-8")
    return Out(f"wrote {q} ({len(text)} characters)")


async def _edit(box: Box, a: dict[str, Any]) -> Out:
    q = box.path(a.get("file_path"), write=True)
    if not q.is_file():
        return Out(f"there is no file {a.get('file_path')}", True)
    text = await asyncio.to_thread(q.read_text, "utf-8")
    old, new = str(a.get("old_string") or ""), str(a.get("new_string") or "")
    n = text.count(old) if old else 0
    if n == 0:
        return Out("old_string is not in the file", True)
    if n > 1 and not a.get("replace_all"):
        return Out(f"old_string is in the file {n} times: give more context, or set replace_all", True)
    await asyncio.to_thread(q.write_text, text.replace(old, new) if a.get("replace_all") else text.replace(old, new, 1),
                            "utf-8")
    return Out(f"edited {q}")


def _rules(box: Box) -> dict[str, Any]:
    """srt's filesystem rules for a command: the kernel's reads (kernel_wrap.srt_rules) and the box's read roots,
    writes to the box's write roots alone, and thimble's private files hidden."""
    from . import config, kernel_wrap, srt  # noqa: PLC0415

    pkg = srt.package(config.REPO_ROOT)
    venv = Path(sys.prefix)
    rules = kernel_wrap.srt_rules(corpus_dir=box.cwd, workspace_dir=box.workspace, venv=venv, python=sys.executable,
                                  srt_dir=pkg or config.REPO_ROOT, read=[*box.read_roots, *box.write_roots],
                                  hide=[str(p) for p in box.private], home=Path.home(), platform=sys.platform)
    fs = rules["filesystem"]
    fs["allowWrite"] = [str(p) for p in box.write_roots]
    fs["denyWrite"] = list(dict.fromkeys([*fs.get("denyWrite", []), *map(str, box.private), *map(str, box.no_write)]))
    return rules


async def _bash(box: Box, a: dict[str, Any]) -> Out:
    from . import config, kernel_wrap, srt  # noqa: PLC0415

    why = sandbox_reason()
    if why:
        return Out(f"Bash cannot run here: {why}", True)
    command = str(a.get("command") or "").strip()
    if not command:
        return Out("the command is empty", True)
    timeout = min(max(int(a.get("timeout") or BASH_TIMEOUT_S * 1000), 1000), BASH_TIMEOUT_MAX_S * 1000) / 1000
    home = box.home or box.write_roots[0]
    (home / "tmp").mkdir(parents=True, exist_ok=True)
    argv = kernel_wrap.srt_argv(["/bin/bash", "-c", command], node=str(srt.node()),
                                srt_dir=srt.package(config.REPO_ROOT) or config.REPO_ROOT, rules=_rules(box))
    env = {k: v for k in ("LANG", "LC_ALL", "TZ", "TERM", "USER", "LOGNAME") if (v := os.environ.get(k))}
    env.update(PATH=os.pathsep.join([str(Path(sys.prefix) / "bin"), os.environ.get("PATH", "/usr/bin:/bin")]),
               HOME=str(home), TMPDIR=str(home / "tmp"), npm_config_cache=str(home / ".npm-cache"))
    proc = await asyncio.create_subprocess_exec(*argv, cwd=str(box.cwd), env=env, stdin=asyncio.subprocess.DEVNULL,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                start_new_session=True)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        _kill(proc)
        return Out(f"the command ran past its {timeout:g} s and was stopped", True)
    except asyncio.CancelledError:
        _kill(proc)
        raise
    text = out.decode("utf-8", errors="replace").rstrip("\n")
    if proc.returncode:
        return Out(f"{text}\n[exit code {proc.returncode}]".strip(), True)
    return Out(text or "(no output)")


def _kill(proc: Any) -> None:
    import signal  # noqa: PLC0415

    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass


def server_blocks_to_records(content: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """A reply's content as a transcript holds it: server tool calls as tool_use blocks named as Claude Code names
    them (SERVER_NAMES), and their results apart, as tool_result blocks for the next user record. (assistant blocks,
    result blocks). Thinking blocks are left out, as the mirror reads no thinking."""
    blocks, results = [], []
    for b in content:
        t = b.get("type")
        if t == "text":
            blocks.append({"type": "text", "text": b.get("text", "")})
        elif t == "tool_use":
            blocks.append({"type": "tool_use", "id": b["id"], "name": b["name"], "input": b.get("input") or {}})
        elif t == "server_tool_use":
            blocks.append({"type": "tool_use", "id": b["id"], "name": SERVER_NAMES.get(b.get("name"), b.get("name")),
                           "input": b.get("input") or {}})
        elif t and t.endswith("_tool_result") and b.get("tool_use_id"):
            results.append({"type": "tool_result", "tool_use_id": b["tool_use_id"],
                            "content": _server_result_text(b.get("content"))})
    return blocks, results


def _server_result_text(content: Any) -> str:
    if isinstance(content, list):
        rows = []
        for r in content:
            if isinstance(r, dict) and r.get("url"):
                rows.append(f"{r.get('title') or ''} {r['url']}".strip())
        return "\n".join(rows) or json.dumps(content)[:2000]
    if isinstance(content, dict):
        if content.get("url"):
            return f"fetched {content['url']}"
        return json.dumps(content)[:2000]
    return str(content or "")


def which(name: str) -> str | None:
    return shutil.which(name)
