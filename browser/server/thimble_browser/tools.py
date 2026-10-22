"""The tools of thimble browser's agents, as Python functions the agent loop (agent.py) calls. Their descriptions and
input schemas are the `## <name>` sections of prompts/tools*.md; each agent gets a fixed set (agent.AGENTS).

The core's tools are here: Read, Grep and Glob, and run_python. Each feature adds its own (features/, register), such
as the cards' card or the report's write_document, as functions fn(tools, args) -> Result.

What a tool can touch:
- Read, Grep and Glob read files under the agent's read roots (the folder and the workspace's temp folder; for the view
  builder also the view kit's docs and the worked examples), each path resolved, symlinks included, and checked to be
  inside one of them.
- run_python runs code in the sandbox (cards/sandbox.py), which reads the folder and writes only the workspace's temp
  folder (its $TMPDIR).
- draft_report drafts a report of a problem with thimble for the person to preview (issues.py); it never sends.
- A feature's tools change the workspace's own store (its cards, its report, a view's files), never the folder of
  files.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

import jsonschema

from . import canvas, chats, corpus, home, prompts

READ_LINES = 2000
LINE_CHARS = 2000
GREP_MAX = 200
GLOB_MAX = 500
RESULT_CHARS = 30_000


# tools a feature module adds (register): name -> async fn(tools, args) -> Result
EXTRA: dict[str, Callable[["Tools", dict[str, Any]], Awaitable["Result"]]] = {}
# refs a feature module resolves, by their prefix (such as `concept:`): prefix -> fn(workspace, ref) -> {ref, kind,
# excerpt, ...}, KeyError for a ref that names nothing
REF_RESOLVERS: dict[str, Callable[[str, str], dict[str, Any]]] = {}


def resolver(ref: str) -> Callable[[str, str], dict[str, Any]] | None:
    """The feature's resolver of `ref`, or None for a ref of the core's own (a card, a file)."""
    return next((fn for prefix, fn in REF_RESOLVERS.items() if ref.startswith(prefix)), None)


def register(name: str, fn: Callable[["Tools", dict[str, Any]], Awaitable["Result"]]) -> None:
    """Add a tool. Its description and schema are its `## <name>` section in prompts/tools*.md."""
    EXTRA[name] = fn


@dataclass
class Result:
    text: str
    is_error: bool = False
    cell_id: str | None = None
    extra: dict[str, Any] | None = None  # more fields for the chat's tool_result record, such as `label_card`
    images: list[Path] | None = None  # PNG pictures Claude sees with the text (agent.py sends them as image blocks)


def _ok(text: str, **kw: Any) -> Result:
    return Result(text, False, **kw)


def _err(text: str) -> Result:
    return Result(text, True)


def schema_of(name: str, slots: dict[str, str] | None = None) -> tuple[str, dict[str, Any]]:
    """(description, input schema) of a tool, from prompts/tools.md, with `slots` filled in its description."""
    body = prompts.tool_text(name, slots)
    m = re.search(r"```json\n(.*?)\n```", body, re.S)
    if not m:
        raise prompts.PromptError(f"tools.md: no schema for {name}")
    return body[: m.start()].strip(), json.loads(m.group(1))


def definitions(names: tuple[str, ...], slots: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """The tools as the Messages API takes them, in a fixed order so the request's prefix stays cacheable."""
    out = []
    for name in names:
        desc, schema = schema_of(name, slots)
        out.append({"name": name, "description": desc, "input_schema": schema, "eager_input_streaming": True})
    return out


class Tools:
    """The tools of one agent. `on_card(cell_id)` hears each card a tool made or changed."""

    def __init__(self, ws: str, chat: str, folder: Path, *, read_roots: list[Path] | None = None,
                 unsandboxed: bool = False, on_card: Callable[[str], None] | None = None,
                 view: str | None = None, allowed: tuple[str, ...] | None = None, denied: str = "") -> None:
        self.ws, self.chat, self.folder, self.unsandboxed = ws, chat, folder.resolve(), unsandboxed
        self.read_roots = [p.resolve() for p in (read_roots or [folder])]
        self.on_card = on_card or (lambda cid: None)
        self.view = view  # the slug of the view this agent builds
        self.allowed, self.denied = allowed, denied  # the tools this agent may call (None: all), and why not another
        self.session: Any = None  # the agent.Session these tools serve, which a feature's tool may read

    async def call(self, name: str, args: Any) -> Result:
        """Run tool `name` on `args`, checked against its schema first (inputs stream in, so the API does not check
        them)."""
        if self.allowed is not None and name not in self.allowed:
            return _err(self.denied or f"this agent may not call {name}")
        fn = getattr(self, f"t_{name}", None)
        if fn is None and name in EXTRA:
            extra = EXTRA[name]

            async def fn(a: dict[str, Any]) -> Result:
                return await extra(self, a)
        if fn is None:
            return _err(f"no tool {name}")
        try:
            jsonschema.validate(args, schema_of(name)[1])
        except jsonschema.ValidationError as e:
            return _err(f"INVALID_INPUT: {e.message}")
        try:
            got = await fn(args)
        except Exception as e:  # noqa: BLE001 — a tool's failure is a result Claude reads
            return _err(f"{type(e).__name__}: {e}")
        if len(got.text) > RESULT_CHARS:
            got.text = got.text[:RESULT_CHARS] + f"\n[cut at {RESULT_CHARS} characters]"
        return got

    # ---- reading

    def _path(self, p: str | None) -> Path:
        """`p` (relative to the folder, or absolute) resolved, symlinks included; ValueError outside the read roots."""
        raw = Path(p) if p and os.path.isabs(p) else self.folder / (p or ".")
        q = raw.resolve()
        if not any(q == r or r in q.parents for r in self.read_roots):
            raise ValueError(f"{p} is outside the folder; thimble browser reads only {self.folder}")
        return q

    def _rel(self, q: Path) -> str:
        for r in self.read_roots:
            if q == r or r in q.parents:
                rel = str(q.relative_to(r))
                return rel if r == self.folder else str(q)
        return str(q)

    async def t_Read(self, args: dict[str, Any]) -> Result:
        q = self._path(args.get("file_path"))
        if q.is_dir():
            return _err(f"{args.get('file_path')} is a folder: list it with Glob")
        if corpus.is_binary(q):
            return _err(f"{args.get('file_path')} is a binary file ({q.stat().st_size} bytes)")
        offset = max(1, int(args.get("offset") or 1))
        limit = max(1, min(int(args.get("limit") or READ_LINES), READ_LINES))
        lines = corpus._lines(q)
        out = []
        for n, line in enumerate(lines[offset - 1:offset - 1 + limit], offset):
            out.append(f"{n}\t{line[:LINE_CHARS]}{' [line cut]' if len(line) > LINE_CHARS else ''}")
        more = len(lines) - (offset - 1 + limit)
        if more > 0:
            out.append(f"[{more} more lines: read on with offset {offset + limit}]")
        return _ok("\n".join(out) or "(empty file)")

    def _files(self, base: Path) -> list[Path]:
        out = []
        for d, dirs, files in os.walk(base):
            dirs[:] = sorted(x for x in dirs if not x.startswith(".") and x not in corpus.SKIP_DIRS)
            for f in sorted(files):
                if not f.startswith("."):
                    out.append(Path(d) / f)
        return out

    async def t_Glob(self, args: dict[str, Any]) -> Result:
        base = self._path(args.get("path"))
        pat = str(args.get("pattern") or "**/*")
        hits = []
        for f in self._files(base):
            rel = str(f.relative_to(base))
            if fnmatch.fnmatch(rel, pat) or (pat.startswith("**/") and fnmatch.fnmatch(rel, pat[3:])):
                hits.append(self._rel(f.resolve()) if f.resolve().is_relative_to(base) else str(f))
        if not hits:
            return _ok("no files match")
        extra = f"\n[{len(hits) - GLOB_MAX} more]" if len(hits) > GLOB_MAX else ""
        return _ok("\n".join(hits[:GLOB_MAX]) + extra)

    async def t_Grep(self, args: dict[str, Any]) -> Result:
        base = self._path(args.get("path"))
        try:
            rx = re.compile(str(args["pattern"]), re.I if args.get("ignore_case") else 0)
        except re.error as e:
            return _err(f"the pattern is not a regular expression: {e}")
        glob = args.get("glob")
        files = [base] if base.is_file() else self._files(base)
        out, n_files = [], 0
        for f in files:
            rel = self._rel(f.resolve())
            if glob and not fnmatch.fnmatch(f.name, glob) and not fnmatch.fnmatch(rel, glob):
                continue
            if corpus.is_binary(f):
                continue
            hit = False
            for n, line in enumerate(corpus._lines(f), 1):
                if rx.search(line):
                    hit = True
                    if len(out) < GREP_MAX:
                        out.append(f"{rel}:{n}: {line[:400]}")
            n_files += hit
        if not out:
            return _ok("no matches")
        more = "" if len(out) < GREP_MAX else f"\n[stopped at {GREP_MAX} lines: narrow the pattern or the path]"
        return _ok("\n".join(out) + more)

    # ---- computing

    async def t_run_python(self, args: dict[str, Any]) -> Result:
        res = await canvas.run_code(self.ws, str(args.get("code") or ""), self.folder, timeout=120,
                                    unsandboxed=self.unsandboxed, tmp=home.temp_dir(self.ws))
        cell = {"id": "run", "outputs": [{**o, "_out": i} for i, o in enumerate(res.get("outputs") or [])]}
        text = canvas.outputs_text(cell, limit=RESULT_CHARS).replace("(cite a value as card:run#<column>/<row>)", "")
        return Result(text, res.get("status") != "ok")

    # ---- reporting a problem with thimble (issues.py): a draft the person previews; no tool sends

    async def t_draft_report(self, args: dict[str, Any]) -> Result:
        from . import issues  # noqa: PLC0415 — issues.py imports this module

        return await issues.draft_report(self, args)

    def maker(self) -> str:
        """Who a card or a save this agent makes is by, as the page reads it (frontend canvas/layout.cellThread): main,
        or `chat:<id>` of a thread or of a view's builder, which the card's face names and opens."""
        return "main" if self.chat in ("main", "-") else f"chat:{self.chat}"

    def opens(self, ref: str) -> str | None:
        """Why `ref` does not open, or None when it does."""
        try:
            if (fn := resolver(ref)) is not None:
                fn(self.ws, ref)
            elif ref.startswith(("card:", "cell:")):
                canvas.resolve_card_ref(self.ws, ref)
            else:
                corpus.resolve(self.folder, ref, read=lambda: chats.read_paths(self.ws, self.folder))
            return None
        except Exception as e:  # noqa: BLE001
            return str(e) or type(e).__name__
