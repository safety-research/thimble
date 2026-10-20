"""The tools of thimble browser's agents, as Python functions the agent loop (agent.py) calls. Their descriptions and
input schemas are the `## <name>` sections of prompts/browser/tools.md; each agent gets a fixed set (agent.AGENTS).

What a tool can touch:
- Read, Grep and Glob read files under the agent's read roots (the folder; for the view builder also the view kit's
  docs and the worked examples), each path resolved, symlinks included, and checked to be inside one of them.
- run_python runs code in the sandbox (cards/sandbox.py), as a card's code does.
- The card tools, write_document and write_view_file change the workspace's own store, never the folder of files.
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

from . import canvas, corpus, prompts, report, views
from .cards import sandbox

BUILD_ATTEMPTS = 3
READ_LINES = 2000
LINE_CHARS = 2000
GREP_MAX = 200
GLOB_MAX = 500
RESULT_CHARS = 30_000


@dataclass
class Result:
    text: str
    is_error: bool = False
    cell_id: str | None = None


def _ok(text: str, **kw: Any) -> Result:
    return Result(text, False, **kw)


def _err(text: str) -> Result:
    return Result(text, True)


def schema_of(name: str) -> tuple[str, dict[str, Any]]:
    """(description, input schema) of a tool, from prompts/browser/tools.md."""
    body = prompts.tool_text(name)
    m = re.search(r"```json\n(.*?)\n```", body, re.S)
    if not m:
        raise prompts.PromptError(f"tools.md: no schema for {name}")
    return body[: m.start()].strip(), json.loads(m.group(1))


def definitions(names: tuple[str, ...]) -> list[dict[str, Any]]:
    """The tools as the Messages API takes them, in a fixed order so the request's prefix stays cacheable."""
    out = []
    for name in names:
        desc, schema = schema_of(name)
        out.append({"name": name, "description": desc, "input_schema": schema, "eager_input_streaming": True})
    return out


def describe(cell: dict[str, Any]) -> str:
    head = f"card:{cell['id']} ({cell['kind']}) {cell['title']}"
    if cell.get("takeaway"):
        head += f"\ntakeaway: {cell['takeaway']}"
    if cell["kind"] in canvas.CODE_KINDS:
        head += f"\nstatus: {cell.get('status')}\n\n{canvas.outputs_text(cell)}"
    elif cell["kind"] == "note":
        head += f"\n{cell.get('text', '')}"
    elif cell["kind"] == "example":
        head += "\nrefs: " + json.dumps(cell.get("payload", {}).get("refs", []), ensure_ascii=False)
    return head


class Tools:
    """The tools of one agent. `on_card(cell_id)` hears each card a tool made or changed."""

    def __init__(self, ws: str, chat: str, folder: Path, *, read_roots: list[Path] | None = None,
                 unsandboxed: bool = False, on_card: Callable[[str], None] | None = None, writer: bool = False,
                 view: str | None = None, start_view: Callable[[dict[str, Any]], Awaitable[str]] | None = None) -> None:
        self.ws, self.chat, self.folder, self.unsandboxed = ws, chat, folder.resolve(), unsandboxed
        self.read_roots = [p.resolve() for p in (read_roots or [folder])]
        self.on_card = on_card or (lambda cid: None)
        self.writer = writer
        self.view = view  # the slug of the view this agent builds
        self.start_view = start_view

    async def call(self, name: str, args: Any) -> Result:
        """Run tool `name` on `args`, checked against its schema first (inputs stream in, so the API does not check
        them)."""
        fn = getattr(self, f"t_{name}", None)
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
        res = await sandbox.run_code(str(args.get("code") or ""), self.folder, timeout=120,
                                     unsandboxed=self.unsandboxed)
        cell = {"id": "run", "outputs": [{**o, "_out": i} for i, o in enumerate(res.get("outputs") or [])]}
        text = canvas.outputs_text(cell, limit=RESULT_CHARS).replace("(cite a value as card:run#<column>/<row>)", "")
        return Result(text, res.get("status") != "ok")

    # ---- cards

    async def t_read_ref(self, args: dict[str, Any]) -> Result:
        ref = str(args.get("ref") or "").strip().strip("[]()")
        try:
            if ref.startswith(("card:", "cell:")):
                _, cell = canvas.find(self.ws, ref)
                got = canvas.resolve_card_ref(self.ws, ref)
                return _ok(describe(cell) + ("" if got["kind"] == "cell" else f"\n\n{got['excerpt']}"))
            got = corpus.resolve(self.folder, ref)
            return _ok(f"{got.get('path')} ({got['kind']})\n{got.get('excerpt', '')}")
        except (KeyError, FileNotFoundError, IndexError, corpus.OutsideFolder, ValueError) as e:
            return _err(f"no such place: {ref} ({e})")

    async def t_list_cards(self, args: dict[str, Any]) -> Result:
        group = str(args.get("group") or "all")
        lines = []
        for nb in canvas.notebooks(self.ws):
            if group not in ("all", nb["id"], nb.get("title")):
                continue
            lines.append(f"## {nb.get('title')} ({nb['id']})")
            for c in nb["cells"]:
                lines.append(f"card:{c['id']}  {c['kind']}  {c['title']}  |  {(c.get('takeaway') or '')[:120]}")
        return _ok("\n".join(lines) or "no cards yet")

    async def _run_and_describe(self, cell: dict[str, Any]) -> Result:
        if cell["kind"] in canvas.CODE_KINDS:
            cell = await canvas.run_card(self.ws, cell["id"], self.folder, unsandboxed=self.unsandboxed)
        self.on_card(cell["id"])
        text = describe(cell)
        if cell.get("status") == "error":
            text += "\n\nThe code failed. Fix it with edit_card on this card rather than adding a new one."
        elif not cell.get("takeaway"):
            text += "\n\nRead the output, then give the card its takeaway with edit_card."
        return _ok(text, cell_id=cell["id"])

    async def t_add_card(self, args: dict[str, Any]) -> Result:
        if self.writer:
            args = {**args, "group": "Report figures"}
        try:
            cell = canvas.new_card(self.ws, args, chat=self.chat)
        except ValueError as e:
            return _err(str(e))
        return await self._run_and_describe(cell)

    async def t_edit_card(self, args: dict[str, Any]) -> Result:
        try:
            before = canvas.find(self.ws, str(args.get("card") or ""))[1]
            cell = canvas.update_card(self.ws, str(args["card"]), args)
        except KeyError:
            return _err(f"no card {args.get('card')}: list_cards names them")
        except (ValueError, PermissionError) as e:
            return _err(str(e))
        if cell["kind"] in canvas.CODE_KINDS and args.get("code") is not None and args["code"] != before.get("code"):
            return await self._run_and_describe(cell)
        self.on_card(cell["id"])
        return _ok(describe(cell), cell_id=cell["id"])

    async def t_delete_card(self, args: dict[str, Any]) -> Result:
        try:
            canvas.delete_card(self.ws, str(args.get("card") or ""))
        except KeyError:
            return _err(f"no card {args.get('card')}")
        except PermissionError as e:
            return _err(str(e))
        return _ok(f"deleted {args.get('card')}")

    # ---- the report

    def _opens(self, ref: str) -> str | None:
        """Why `ref` does not open, or None when it does."""
        try:
            if ref.startswith(("card:", "cell:")):
                canvas.resolve_card_ref(self.ws, ref)
            else:
                corpus.resolve(self.folder, ref)
            return None
        except Exception as e:  # noqa: BLE001
            return str(e) or type(e).__name__

    async def t_write_document(self, args: dict[str, Any]) -> Result:
        text = str(args.get("text") or "").strip()
        if not text.startswith("# "):
            return _err("the report starts with its `# ` title")
        doc = report.save(self.ws, text, by=f"chat:{self.chat}")
        refs = [r for sec in doc["sections"] for p in sec["paragraphs"] for s in p["sentences"] for r in s["refs"]]
        figs = [f for sec in doc["sections"] for f in sec.get("figures", [])]
        broken = [(r, why) for r in dict.fromkeys(refs) if (why := self._opens(r))]
        broken += [(f"card:{f['cell']}", why) for f in figs if (why := self._opens(f"card:{f['cell']}"))]
        lines = [f"Saved the report: {len(doc['sections'])} sections, {len(figs)} figures, {len(refs)} citations."]
        if broken:
            lines.append("These citations do not open; fix each and save again:")
            lines += [f"- {r}: {why}" for r, why in broken]
        return _ok("\n".join(lines))

    # ---- views: main proposes one, the builder writes and checks it

    async def t_propose_view(self, args: dict[str, Any]) -> Result:
        if self.start_view is None:
            return _err("this agent cannot start a view build")
        slug = await self.start_view({k: args.get(k) for k in ("name", "description", "task", "claims")})
        return _ok(f"Building the view {args.get('name')} (view:{slug}). It appears in the Files tab when it passes its "
                   "checks; the builder works on its own.")

    async def t_write_view_file(self, args: dict[str, Any]) -> Result:
        try:
            p = views.write_file(self.ws, str(self.view), str(args.get("name") or ""), str(args.get("text") or ""))
        except (ValueError, KeyError) as e:
            return _err(str(e))
        return _ok(f"wrote {p.name} ({p.stat().st_size} bytes)")

    async def t_view_check(self, args: dict[str, Any]) -> Result:
        got = await views.check(self.ws, str(self.view), self.folder)
        return _ok(("The checks pass.\n" if got["ok"] else "Fix these:\n") + "\n".join(f"- {x}" for x in got["lines"]))

    async def t_finish_view(self, args: dict[str, Any]) -> Result:
        row = next((r for r in views.proposals(self.ws) if r.get("slug") == self.view), {})
        attempts = int(row.get("attempts") or 0) + 1
        got = await views.check(self.ws, str(self.view), self.folder)
        if got["ok"]:
            views.mark_built(self.ws, str(self.view))
            return _ok("The view passed its checks and is in the analyst's Files tab. End with your one-line message.")
        views.set_proposal(self.ws, str(self.view), attempts=attempts,
                           status="failed" if attempts >= BUILD_ATTEMPTS else "building")
        left = BUILD_ATTEMPTS - attempts
        lines = "\n".join(f"- {x}" for x in got["lines"])
        if left <= 0:
            return _err(f"The checks failed on the last attempt, so the build has failed:\n{lines}\nEnd with one line "
                        "saying what failed.")
        return _err(f"The checks failed ({left} attempts left). Fix these, then call finish_view again:\n{lines}")
