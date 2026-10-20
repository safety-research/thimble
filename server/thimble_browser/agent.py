"""The Claude sessions behind the chats. Each chat (main, or a thread) has one Claude Code process, which the server
starts through the Claude Agent SDK the first time the person writes in it, and keeps for the next messages.

Signing in. The process is the person's own Claude Code (`claude` on PATH), so it uses the sign-in Claude Code
already has: the person's Claude subscription or whatever their Claude Code is set up with. The server reads no key
and no token, and passes its own environment to the process unchanged.

What the session can do is fixed here and nowhere else:
- built-in tools: Read, Grep and Glob, and only inside the folder (can_use);
- thimble's tools (tools.py), which change only the workspace's cards;
- nothing else: no Bash, no file edits, no web, no subagents. Claude Code's own customizations (the person's
  CLAUDE.md, hooks, plugins, MCP servers, skills) are not loaded (`setting_sources=[]`, `--safe-mode`,
  `strict_mcp_config`), so nothing of the person's setup runs in it, and nothing asks the person for a permission.

Every record the session makes goes into the chat's log (chats.py), and the page reads it from there.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, HookMatcher, PermissionResultAllow,
                              PermissionResultDeny, ResultMessage, StreamEvent, TextBlock, ToolResultBlock,
                              ToolUseBlock, UserMessage)

from . import chats, explain, home, prompts, report, views
from .tools import PREFIX, Tools

log = logging.getLogger("thimble_browser.agent")

READ_TOOLS = ("Read", "Grep", "Glob")
NOTIFY_S = 0.25  # the page hears a chat change at most this often while a reply streams


def claude_path() -> str | None:
    """The person's Claude Code: $THIMBLE_BROWSER_CLAUDE, else `claude` on PATH, else the SDK's own copy (None)."""
    return os.environ.get("THIMBLE_BROWSER_CLAUDE") or shutil.which("claude")


def system_prompt(folder: Path) -> str:
    return prompts.render("browser/main.md", {"workdir": str(folder)})


def _inside(folder: Path, p: str | None) -> bool:
    if not p:
        return True
    try:
        q = Path(p) if os.path.isabs(p) else folder / p
        q = q.resolve()
    except OSError:
        return False
    root = folder.resolve()
    return q == root or root in q.parents


class Session:
    writer = False
    view: str | None = None

    def __init__(self, ws: str, chat: str, folder: Path, *, unsandboxed: bool = False,
                 manager: "Sessions | None" = None) -> None:
        self.ws, self.chat, self.folder = ws, chat, folder
        self.manager = manager
        self.read_roots = [folder]
        self.unsandboxed = unsandboxed
        self.client: ClaudeSDKClient | None = None
        self.task: asyncio.Task | None = None
        self.running = False
        self._last_notify = 0.0
        self._pending_notify: asyncio.TimerHandle | None = None
        self.cards: list[str] = []

    # ---- permissions: decided here, never asked of the person

    async def can_use(self, name: str, inp: dict[str, Any], ctx: Any) -> Any:
        if name.startswith(PREFIX):
            return PermissionResultAllow()
        if name in READ_TOOLS:
            path = inp.get("file_path") or inp.get("path")
            if any(_inside(r, path) for r in self.read_roots):
                return PermissionResultAllow()
            return PermissionResultDeny(message=f"thimble browser reads only the folder {self.folder}")
        return PermissionResultDeny(message=f"thimble browser has no {name}: use Read, Grep, Glob and thimble's tools")

    async def guard_read(self, data: dict[str, Any], tool_use_id: str | None, ctx: Any) -> dict[str, Any]:
        """Before every Read, Grep and Glob, even one Claude Code would allow by itself: the path, with its symlinks
        resolved, must be inside the folder."""
        inp = data.get("tool_input") or {}
        path = inp.get("file_path") or inp.get("path")
        if any(_inside(r, path) for r in self.read_roots):
            return {}
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": f"thimble browser reads only the folder {self.folder}"}}

    def options(self) -> ClaudeAgentOptions:
        meta = chats.meta(self.ws, self.chat)
        tools = Tools(self.ws, self.chat, self.folder, unsandboxed=self.unsandboxed, on_card=self.cards.append,
                      writer=self.writer, view=self.view,
                      start_view=(lambda req: self.manager.start_view(self.ws, req)) if self.manager else None)
        if self.view:
            from .tools import BUILD_ATTEMPTS  # noqa: PLC0415

            prompt = views.builder_prompt(self.folder, BUILD_ATTEMPTS)
        elif self.writer:
            prompt = prompts.render("browser/writer.md", {"workdir": str(self.folder)})
        else:
            prompt = system_prompt(self.folder)
        if self.chat != "main" and meta.get("anchor"):
            prompt += (f"\n\n## This thread\n\nThe analyst opened this thread about {meta.get('anchor')}"
                       + (f", which reads: {meta.get('anchor_text')}" if meta.get("anchor_text") else "") + ".")
        return ClaudeAgentOptions(
            cwd=str(self.folder),
            cli_path=claude_path(),
            tools=list(READ_TOOLS),
            mcp_servers={"thimble": tools.server()},
            strict_mcp_config=True,
            setting_sources=[],
            can_use_tool=self.can_use,
            hooks={"PreToolUse": [HookMatcher(matcher="Read|Grep|Glob", hooks=[self.guard_read])]},
            permission_mode="default",
            system_prompt={"type": "preset", "preset": "claude_code", "append": prompt},
            include_partial_messages=True,
            resume=meta.get("session_id") or meta.get("fork_of") or None,
            fork_session=bool(not meta.get("session_id") and meta.get("fork_of")),
            extra_args={"safe-mode": None},
            effort=self.effort(),
            stderr=lambda line: log.debug("claude: %s", line),
        )

    def effort(self) -> Any:
        """The effort the analyst chose for this workspace's chats (the composer's chip), or Claude Code's default."""
        e = (home.read_json(home.workspace_dir(self.ws) / "session.json", {}) or {}).get("effort")
        return {"ultracode": "xhigh"}.get(e, e) or None

    # ---- the log

    def _notify(self) -> None:
        """Tell the page the chat changed, at most every NOTIFY_S while a reply streams."""
        now = time.monotonic()
        if now - self._last_notify >= NOTIFY_S:
            self._last_notify = now
            chats.hub.publish(self.ws, {"type": "chat", "chat": self.chat})
        elif self._pending_notify is None:
            loop = asyncio.get_running_loop()

            def fire() -> None:
                self._pending_notify = None
                self._last_notify = time.monotonic()
                chats.hub.publish(self.ws, {"type": "chat", "chat": self.chat})

            self._pending_notify = loop.call_later(NOTIFY_S, fire)

    def _append(self, rec: dict[str, Any]) -> None:
        chats.append(self.ws, self.chat, rec, notify=False)
        self._notify()

    # ---- a turn

    async def send(self, text: str) -> None:
        if self.running:
            raise RuntimeError("Claude is still answering the last message in this chat")
        chats.append(self.ws, self.chat, {"type": "user", "text": text, "by": "browser"})
        self.running = True
        self._set_running(True)
        self.task = asyncio.create_task(self._turn(text))

    def _set_running(self, on: bool) -> None:
        chats.hub.publish(self.ws, {"type": "chat", "chat": self.chat})

    async def _turn(self, text: str) -> None:
        streamed = False
        self.cards = []
        reply: list[str] = []
        try:
            if self.client is None:
                self.client = ClaudeSDKClient(self.options())
                await self.client.connect()
            await self.client.query(text)
            async for m in self.client.receive_response():
                if isinstance(m, StreamEvent):
                    ev = m.event or {}
                    if ev.get("type") == "content_block_delta" and (ev.get("delta") or {}).get("type") == "text_delta":
                        d = ev["delta"].get("text") or ""
                        if d:
                            if m.parent_tool_use_id:
                                continue
                            streamed = True
                            reply.append(d)
                            self._append({"type": "text", "delta": d})
                    elif ev.get("type") == "message_start":
                        streamed = False
                        if reply and not reply[-1].endswith("\n"):
                            reply.append("\n\n")
                            self._append({"type": "text", "delta": "\n\n"})
                elif isinstance(m, AssistantMessage):
                    for b in m.content:
                        if isinstance(b, TextBlock) and not streamed and b.text:
                            reply.append(b.text)
                            self._append({"type": "text", "delta": b.text})
                        elif isinstance(b, ToolUseBlock):
                            self._append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
                elif isinstance(m, UserMessage):
                    content = m.content if isinstance(m.content, list) else []
                    for b in content:
                        if isinstance(b, ToolResultBlock):
                            self._append(self._result_record(b))
                elif isinstance(m, ResultMessage):
                    meta = chats.meta(self.ws, self.chat)
                    if m.session_id and meta.get("session_id") != m.session_id:
                        meta["session_id"] = m.session_id
                        chats.save_meta(self.ws, meta)
                    if m.is_error and m.result:
                        self._append({"type": "error", "message": str(m.result)[:2000], "kind": "claude"})
                    self._append({"type": "done", "session_id": m.session_id, "cells": self.cards,
                                  "result": None})
        except asyncio.CancelledError:
            self._append({"type": "done", "result": "stopped"})
            raise
        except Exception as e:  # noqa: BLE001 — every failure is a row the person sees
            log.exception("turn failed")
            self._append({"type": "error", "message": _plain_error(e), "kind": "session"})
            self._append({"type": "done", "result": "failed"})
            await self.close()
        finally:
            self.running = False
            self._set_running(False)
        self.finished()
        text_out = "".join(reply).strip()
        if text_out and not self.writer and not self.view:
            asyncio.create_task(explain.after_turn(self.ws, self.chat, text_out, self.folder))

    def finished(self) -> None:
        """After a turn: nothing for a chat."""

    def _result_record(self, b: ToolResultBlock) -> dict[str, Any]:
        content = b.content
        if isinstance(content, list):
            text = "\n".join(str(x.get("text", "")) for x in content if isinstance(x, dict))
        else:
            text = str(content or "")
        rec: dict[str, Any] = {"type": "tool_result", "id": b.tool_use_id, "summary": text[:4000],
                               "is_error": bool(b.is_error)}
        m = re.match(r"card:([0-9a-f]{8})\b", text)
        if m and not b.is_error:
            rec["cell_id"] = m.group(1)
            try:
                from . import canvas

                rec["notebook"] = canvas.find(self.ws, m.group(1))[0]["id"]
            except KeyError:
                pass
        return rec

    async def interrupt(self) -> bool:
        if not self.running or self.client is None:
            return False
        try:
            await self.client.interrupt()
        except Exception:  # noqa: BLE001
            if self.task:
                self.task.cancel()
        return True

    async def close(self) -> None:
        c, self.client = self.client, None
        if c is not None:
            try:
                await c.disconnect()
            except Exception:  # noqa: BLE001
                pass


def _plain_error(e: Exception) -> str:
    text = str(e) or type(e).__name__
    if "CLINotFound" in type(e).__name__ or "not found" in text.lower() and "claude" in text.lower():
        return ("thimble browser could not start Claude Code. Install it (https://claude.com/claude-code), run "
                "`claude` once in a terminal to sign in, then send your message again.")
    if "auth" in text.lower() or "login" in text.lower() or "401" in text:
        return ("Claude Code is not signed in. Run `claude` once in a terminal and sign in, then send your message "
                "again.")
    return f"Claude stopped with an error: {text[:500]}"


class Writer(Session):
    """The report's writer: a session of its own, with the read tools, `add_card` (into `Report figures`) and
    `write_document`. Its chat is an agent thread (kind `agent`, role `writer`), and the Report tab shows it writing."""

    writer = True

    def finished(self) -> None:
        meta = chats.meta(self.ws, self.chat)
        last = [r for r in chats.records(self.ws, self.chat) if r.get("type") == "done"]
        failed = bool(last and last[-1].get("result") in ("failed", "stopped"))
        meta.update(status="failed" if failed else "done", ts_end=home.now())
        chats.save_meta(self.ws, meta)
        report.set_status(self.ws, "failed" if failed else "generated")


class ViewBuilder(Session):
    """A view's builder: a session of its own that reads the folder, the view kit's docs and the worked examples, and
    writes only the view's three files (write_view_file); finish_view marks the view built. Its chat is an agent thread
    (kind `agent`, role `dev`)."""

    def __init__(self, ws: str, chat: str, folder: Path, **kw: Any) -> None:
        super().__init__(ws, chat, folder, **kw)
        self.view = chats.meta(ws, chat).get("view")
        self.read_roots = [folder, views.REPO / "docs", views.REPO / "samples" / "views"]

    def finished(self) -> None:
        meta = chats.meta(self.ws, self.chat)
        row = next((r for r in views.proposals(self.ws) if r.get("slug") == self.view), {})
        built = row.get("status") == "built"
        meta.update(status="done" if built else "failed", ts_end=home.now())
        chats.save_meta(self.ws, meta)
        if not built:
            views.set_proposal(self.ws, str(self.view), status="failed")
        chats.append(self.ws, "main", {"type": "chip", "kind": "view", "text": f"{row.get('name') or self.view}: "
                                       + ("built" if built else "the build failed"), "ref": f"view:{self.view}",
                                       "view": self.view, "status": "built" if built else "failed"})


def writer_brief(ws: str, request: str) -> str:
    """The writer's first message: its task and the workspace as it stands."""
    from . import canvas  # noqa: PLC0415

    parts = [f"Write the report{': ' + request if request else '.'}", "", "## The analyst's chat", ""]
    for r in chats.records(ws, "main"):
        if r.get("type") == "user":
            parts.append(f"Analyst: {r.get('text')}")
        elif r.get("type") == "text":
            if parts[-1].startswith("Claude: "):
                parts[-1] += r.get("delta") or ""
            else:
                parts.append("Claude: " + (r.get("delta") or ""))
    parts += ["", "## The cards", ""]
    for nb in canvas.notebooks(ws):
        parts.append(f"### {nb.get('title')}")
        for c in nb["cells"]:
            parts.append(f"- card:{c['id']} ({c['kind']}) {c['title']} | takeaway: {c.get('takeaway') or '(none)'}")
    md = report.markdown(ws)
    parts += ["", "## The report as it stands", "", md if md else "(not written yet)"]
    return "\n".join(parts)


class Sessions:
    def __init__(self, *, unsandboxed: bool = False) -> None:
        self._s: dict[tuple[str, str], Session] = {}
        self.unsandboxed = unsandboxed

    def get(self, ws: str, chat: str) -> Session:
        key = (ws, chat)
        if key not in self._s:
            role = chats.meta(ws, chat).get("role")
            kind = Writer if role == "writer" else ViewBuilder if role == "dev" else Session
            self._s[key] = kind(ws, chat, home.corpus_of(ws), unsandboxed=self.unsandboxed, manager=self)
        return self._s[key]

    async def start_view(self, ws: str, req: dict[str, Any]) -> str:
        """Start building the view `req` asks for ({name, description, task, claims}); its slug."""
        import secrets  # noqa: PLC0415

        name = str(req.get("name") or "View")
        slug = views.slug_for(ws, name)
        cid = "d" + secrets.token_hex(4)
        m = chats.new_meta(cid, kind="agent", title=f"View: {name}", parent="main")
        m.update(role="dev", view=slug, status="running", asked=True)
        chats.save_meta(ws, m)
        views.set_proposal(ws, slug, name=name, description=str(req.get("description") or ""),
                           task=str(req.get("task") or ""), claims=list(req.get("claims") or []), status="building",
                           chat=cid, asked=True, proposed_by="main", attempts=0)
        await self.get(ws, cid).send(views.builder_brief(name, slug, str(req.get("description") or ""),
                                                         str(req.get("task") or ""), list(req.get("claims") or [])))
        return slug

    def running(self, ws: str) -> set[str]:
        return {c for (w, c), s in self._s.items() if w == ws and s.running}

    async def restart_idle(self, ws: str) -> None:
        """Close the idle sessions of `ws`, so their next message starts them again with the new settings, where they
        left off (the chat's session id)."""
        for (w, _), s in list(self._s.items()):
            if w == ws and not s.running:
                await s.close()

    async def close_all(self) -> None:
        for s in list(self._s.values()):
            await s.close()
