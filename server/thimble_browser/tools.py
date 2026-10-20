"""thimble's tools for Claude: one in-process MCP server per chat session (claude_agent_sdk.create_sdk_mcp_server).
Their descriptions and input schemas are the sections of prompts/browser/tools.md.

A tool is a function of the workspace's own store: it can change cards, never the folder of files, and it runs no
command. The only code that runs is a card's, in the sandbox (canvas.run_card).
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Awaitable, Callable

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import canvas, corpus, prompts, report, views

SERVER = "thimble"
PREFIX = f"mcp__{SERVER}__"
NAMES = ("read_ref", "list_cards", "add_card", "edit_card", "delete_card", "propose_view")
WRITER_NAMES = ("read_ref", "list_cards", "add_card", "write_document")
BUILDER_NAMES = ("read_ref", "write_view_file", "view_check", "finish_view")
BUILD_ATTEMPTS = 3


def schema_of(name: str) -> tuple[str, dict[str, Any]]:
    """(description, input schema) of a tool from prompts/browser/tools.md."""
    body = prompts.tool_text(name)
    m = re.search(r"```json\n(.*?)\n```", body, re.S)
    if not m:
        raise prompts.PromptError(f"tools.md: no schema for {name}")
    return body[: m.start()].strip(), json.loads(m.group(1))


def _ok(text: str, **extra: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], **extra}


def _err(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "is_error": True}


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
    """The tools of one chat. `on_card(cell_id)` hears each card a tool made or changed, so the chat row can show it."""

    def __init__(self, ws: str, chat: str, folder: Path, *, unsandboxed: bool = False,
                 on_card: Callable[[str], None] | None = None, writer: bool = False, view: str | None = None,
                 start_view: Callable[[dict[str, Any]], Awaitable[str]] | None = None) -> None:
        self.ws, self.chat, self.folder, self.unsandboxed = ws, chat, folder, unsandboxed
        self.on_card = on_card or (lambda cid: None)
        self.writer = writer
        self.view = view  # the slug of the view this chat builds
        self.start_view = start_view

    async def read_ref(self, args: dict[str, Any]) -> dict[str, Any]:
        ref = str(args.get("ref") or "").strip().strip("[]()")
        try:
            if ref.startswith(("card:", "cell:")):
                nb, cell = canvas.find(self.ws, ref)
                got = canvas.resolve_card_ref(self.ws, ref)
                return _ok(describe(cell) + ("" if got["kind"] == "cell" else f"\n\n{got['excerpt']}"))
            got = corpus.resolve(self.folder, ref)
            return _ok(f"{got.get('path')} ({got['kind']})\n{got.get('excerpt', '')}")
        except (KeyError, FileNotFoundError, IndexError, corpus.OutsideFolder, ValueError) as e:
            return _err(f"no such place: {ref} ({e})")

    async def list_cards(self, args: dict[str, Any]) -> dict[str, Any]:
        group = str(args.get("group") or "all")
        lines = []
        for nb in canvas.notebooks(self.ws):
            if group not in ("all", nb["id"], nb.get("title")):
                continue
            lines.append(f"## {nb.get('title')} ({nb['id']})")
            for c in nb["cells"]:
                lines.append(f"card:{c['id']}  {c['kind']}  {c['title']}  |  {(c.get('takeaway') or '')[:120]}")
        return _ok("\n".join(lines) or "no cards yet")

    async def _run_and_describe(self, cell: dict[str, Any]) -> dict[str, Any]:
        if cell["kind"] in canvas.CODE_KINDS:
            cell = await canvas.run_card(self.ws, cell["id"], self.folder, unsandboxed=self.unsandboxed)
        self.on_card(cell["id"])
        text = describe(cell)
        if cell.get("status") == "error":
            text += "\n\nThe code failed. Fix it with edit_card on this card rather than adding a new one."
        elif not cell.get("takeaway"):
            text += "\n\nRead the output, then give the card its takeaway with edit_card."
        return _ok(text, cell_id=cell["id"])

    async def add_card(self, args: dict[str, Any]) -> dict[str, Any]:
        if self.writer:
            args = {**args, "group": "Report figures"}
        try:
            cell = canvas.new_card(self.ws, args, chat=self.chat)
        except ValueError as e:
            return _err(str(e))
        return await self._run_and_describe(cell)

    async def edit_card(self, args: dict[str, Any]) -> dict[str, Any]:
        try:
            before = canvas.find(self.ws, str(args.get("card") or ""))[1]
            cell = canvas.update_card(self.ws, str(args["card"]), args)
        except KeyError:
            return _err(f"no card {args.get('card')}: list_cards names them")
        except (ValueError, PermissionError) as e:
            return _err(str(e))
        rerun = cell["kind"] in canvas.CODE_KINDS and (args.get("code") is not None and args["code"] != before.get("code"))
        if rerun:
            return await self._run_and_describe(cell)
        self.on_card(cell["id"])
        return _ok(describe(cell), cell_id=cell["id"])

    async def delete_card(self, args: dict[str, Any]) -> dict[str, Any]:
        try:
            canvas.delete_card(self.ws, str(args.get("card") or ""))
        except KeyError:
            return _err(f"no card {args.get('card')}")
        except PermissionError as e:
            return _err(str(e))
        return _ok(f"deleted {args.get('card')}")

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

    async def write_document(self, args: dict[str, Any]) -> dict[str, Any]:
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

    async def propose_view(self, args: dict[str, Any]) -> dict[str, Any]:
        if self.start_view is None:
            return _err("this chat cannot start a view build")
        claims = args.get("claims") or []
        if not isinstance(claims, list) or not claims:
            return _err("a view needs `claims`: the globs of the files that hold its records")
        slug = await self.start_view({k: args.get(k) for k in ("name", "description", "task", "claims")})
        return _ok(f"Building the view {args.get('name')} (view:{slug}). It appears in the Files tab when it passes its "
                   "checks; the builder works on its own.")

    async def write_view_file(self, args: dict[str, Any]) -> dict[str, Any]:
        try:
            p = views.write_file(self.ws, str(self.view), str(args.get("name") or ""), str(args.get("text") or ""))
        except (ValueError, KeyError) as e:
            return _err(str(e))
        return _ok(f"wrote {p.name} ({p.stat().st_size} bytes)")

    async def view_check(self, args: dict[str, Any]) -> dict[str, Any]:
        got = await views.check(self.ws, str(self.view), self.folder)
        return _ok(("The checks pass.\n" if got["ok"] else "Fix these:\n") + "\n".join(f"- {x}" for x in got["lines"]))

    async def finish_view(self, args: dict[str, Any]) -> dict[str, Any]:
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

    def server(self) -> Any:
        made = []
        for name in (BUILDER_NAMES if self.view else WRITER_NAMES if self.writer else NAMES):
            desc, schema = schema_of(name)
            fn: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]] = getattr(self, name)
            made.append(tool(name, desc, schema)(fn))
        return create_sdk_mcp_server(SERVER, tools=made)
