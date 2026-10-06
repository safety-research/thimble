"""The one tool registry: the tools every thimble model calls.

prompts/tools.md holds each tool's description and JSON input schema (one `## <tool>` section each, read fresh on
every listing); REGISTRY holds the roles that get a tool and its handler as an import path resolved at call time. This
module imports only config, prompts, cite and frames, so the stdio shim (plugin/bin/thimble-mcp) builds its tool list
without loading the notebook or a kernel. The shim lists the tools (`list("analyst")`) and posts each call to
`POST /api/tools/{name}`; its THIMBLE_SESSION (Ctx.session) says which session called: none for main, `orient`,
`writer:<doc>`, `critique:orient` or `check:<id>:<doc>`. Tools whose machinery lives elsewhere run `tool_<name>(ctx,
args)` in that module. Every result starts with the call as run (call_line); a card's result shows the first lines of
each output, a chart as the rows it draws, and hint lines from prompts/tools.md. The card tools also answer to the
alias names of the cell tools and `cell:` refs (Spec.aliases, ARG_ALIASES, cite.CARD_PREFIXES)."""
from __future__ import annotations

import asyncio
import base64
import builtins
import contextlib
import importlib
import inspect
import json
import logging
import re
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import cardrun, cite, config, frames, headless, prompts
from .kernel_thimble import CARD_MIME  # a card type's graphic, which counts as a chart and is read through its listing

log = logging.getLogger("thimble.tools")
router = APIRouter()

SERVER_NAME = "thimble"  # workers see mcp__thimble__<tool>; the user's session mcp__plugin_thimble_thimble__<tool>
TOOLS_PROMPT = "tools"  # prompts/tools.md: the `## <tool>` sections (description and schema) and the hint sections
ANALYST = "analyst"
# The key of each of thimble's agents (subagents.py), the session its calls run as: `orient`, or `writer:<doc>` since
# two documents may be written at once (session_kind).
ORIENT_SESSION = "orient"
WRITER_SESSION = "writer"
CRITIQUE_SESSION = "critique"  # `critique:orient`, the critic of the orientation's analysis (critique_session.py)
CHECK_SESSION = "check"  # `check:<id>:<doc>`, a run of a report check on a document (checks.py)
VIEW_SESSION = "view"  # `view:<slug>`, a build of a view (dev.py, view_tools.py)
REVIEW_SESSION = "review"  # `review:<slug>`, a review of a built view (view_review.py, view_tools.py)
TICKET_SESSION = "ticket"  # `ticket:<id>`, a code ticket's agent (dev.py, ticket_tools.py)
MAIN_ONLY: "tuple[str | None, ...]" = (None,)  # Spec.sessions of a tool only main's shim lists (no THIMBLE_SESSION)
ROLES = (ANALYST,)  # the dev worker is a Claude Code session with its own tools (dev.py)
ANALYSIS_ROLES = (ANALYST,)  # who reads cards and records
# The callers whose cards answer the analyst as they wait: main and its threads. Their cards get
# notebook.CHAT_EXEC_TIMEOUT when the card names no allowance (_default_timeout); the sessions in
# FULL_TIME_SESSIONS keep notebook.EXEC_TIMEOUT.
CHAT_ACTORS = (ANALYST,)
FULL_TIME_SESSIONS = (ORIENT_SESSION, WRITER_SESSION)
ANALYST_NOTEBOOK_TITLE = "Your work"  # notebook.ANALYST_NOTEBOOK_TITLE, repeated: notebook is imported lazily here
TERMINAL = "terminal"  # created_by of the terminal session's cells and notebook record (notebook.TERMINAL_CREATOR)
# Where the terminal session's cells land: the analyst's notebook, each cell stamped `created_by: terminal`. A workspace
# holding a root notebook stamped `created_by: terminal` keeps writing into it (find_terminal_notebook). Groups the
# session's add_card makes are not stamped `terminal` (_group_author).
BROWSER_AUTHOR = "user"  # a browser chat's comments, labels and report requests: the analyst asking through their chat
# created_by of a cell the analyst's caller outside the terminal writes when the call names no chat (one that does
# stamps `chat:<id>`, cell_author); never `user` or `terminal`.
BROWSER_CELL_AUTHOR = "chat"
# The add_card result shows the first RESULT_LINES lines of each output (settings.json `run_cell_result_lines`, read
# fresh per call), at most RESULT_CHARS_PER_LINE chars per allowed line, and at most RESULT_OUTPUTS outputs' worth of
# chars; the `## add_card-more` hint names `read_ref` for the rest.
RESULT_LINES = 40
RESULT_CHARS_PER_LINE = 50
RESULT_OUTPUTS = 4
RESULT_LINES_KEY = "run_cell_result_lines"  # settings.json; a persisted key, not renamed with the tool
# chars of outputs read_ref returns for a card, a ceiling against a runaway print
CELL_READ_LIMIT = 40_000
WARM_REFS_MAX = 20  # an example's quoted refs a view reads, resolved off the loop before add_card or edit_card reads them
LINE_LIMIT = 160  # chars of a takeaway / md text on a `cells` line
CALL_ARG_CHARS = 80  # chars of one argument on a result's `$` line (call_line)
TAKEAWAY_AUTHOR = "model"  # cell.takeaway_author for a takeaway written with edit_card (the analyst's is `analyst`)
TAKEAWAY_WORDS = 40  # the words a takeaway may run to, which the `## takeaway-long` line of prompts/tools.md states
ERROR_MIME = "application/vnd.thimble.error+json"
# the drawings the canvas makes from a card's code, thimble.diagram and thimble.timeline (kernel_thimble.py), by the
# kind of card that shows each; their text/plain listing is what a model reads
DRAWING_MIMES = {"application/vnd.thimble.diagram+json": "diagram", "application/vnd.thimble.timeline+json": "timeline"}
LABEL_KINDS = ("prompt", "regex", "code")
LABEL_SCOPES = ("files", "canvas", "report")
UNIT_WORDS = {"cell": "card", "span": "sentence"}  # a label's stored unit (concepts.SCOPES) as a result names it
CELL_KINDS = ("plot", "table", "code", "example", "note", "diagram", "timeline", "label", "custom")
# add_card's and edit_card's enum, in the order of thimble's grammar of cards, then custom. The grammar's classifier is
# the label card, which apply_label makes.
ADD_CELL_KINDS = ("example", "table", "code", "diagram", "plot", "timeline", "note", "custom")
EDIT_CELL_KINDS = ADD_CELL_KINDS
RUN_KINDS = ("plot", "table", "code", "timeline", "diagram")  # notebook.RUNNABLE_KINDS: the kinds that run `code`
INSTRUCTIONS_HINT = "instructions"  # prompts/tools.md `## instructions`: the shim's MCP server instructions (instructions)
SCREENSHOT_HOSTS = ("127.0.0.1", "localhost", "::1")  # a page screenshot is of thimble's own interface on this machine
# a figure's own page (_shot_page_file): no network, inline script and style only, images from data: URLs; the figure
# runs in a frame sandboxed to scripts alone, which reports its size to the page
SHOT_PAGE_CSP = ("default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; "
                 "img-src data: blob:; font-src data:; connect-src data:")
# the browser builds a card's chart is drawn with for its screenshot (the frontend's vega, vega-lite and vega-embed)
VEGA_BUILDS = tuple(config.REPO_ROOT / "frontend" / "node_modules" / p for p in
                    ("vega/build/vega.min.js", "vega-lite/build/vega-lite.min.js", "vega-embed/build/vega-embed.min.js"))

_SECTION_RE = re.compile(r"^## (\S+)\s*$", re.M)
_CELL_ID_RE = re.compile(r"^" + cite.CARD_RE + r"([A-Za-z0-9_-]+)")
_SELF_REF_RE = r"\s*\[\[(?:card|cell):{cid}(?:@\d+)?\]\]"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- results


@dataclass
class ToolResult:
    """What a tool call returns: MCP content blocks and an error flag. Never raised; every failure the
    model should read is an is_error result."""

    content: list[dict[str, Any]] = field(default_factory=list)
    is_error: bool = False

    @property
    def text(self) -> str:
        return "\n".join(str(b.get("text", "")) for b in self.content if b.get("type") == "text")

    def as_dict(self) -> dict[str, Any]:
        return {"content": self.content, "is_error": self.is_error}


def ok(text: str) -> ToolResult:
    return ToolResult([{"type": "text", "text": text}])


def err(text: str) -> ToolResult:
    return ToolResult([{"type": "text", "text": text}], is_error=True)


# --------------------------------------------------------------------------- the registry


@dataclass(frozen=True)
class Spec:
    """What is code about a tool: its name, the roles that get it, and its handler as `module:attr`, called as
    `handler(ctx, args)`. `sessions` names the session kinds whose shims alone list it; `aliases` are alternative
    names a
    call still reaches but no listing shows; with `drop_stops`, a call whose request the caller drops is cancelled."""

    name: str
    roles: tuple[str, ...]
    handler: str
    sessions: "tuple[str | None, ...]" = ()
    aliases: tuple[str, ...] = ()
    drop_stops: bool = False


_H = "app.tools:_h_"

REGISTRY: dict[str, Spec] = {
    s.name: s
    for s in (
        Spec("read_ref", ANALYSIS_ROLES, _H + "read_ref"),
        # the card tools, named as the interface and the prompts name them, with their cell aliases
        Spec("list_cards", ANALYSIS_ROLES, _H + "list_cards", aliases=("list_cells",)),
        Spec("add_card", ANALYSIS_ROLES, _H + "add_card", aliases=("add_cell",)),
        Spec("edit_card", (ANALYST,), _H + "edit_card", aliases=("edit_cell",)),
        Spec("delete_card", (ANALYST,), _H + "delete_card", aliases=("delete_cell",)),
        Spec("apply_label", (ANALYST,), _H + "apply_label"),
        # a label over files on or off in Files and the views, which runs nothing (concepts.show_concept)
        Spec("show_label", (ANALYST,), _H + "show_label"),
        # the filters the browser's Filter menu and label chips set, by a label that exists or by the cards' own facts
        Spec("set_filter", (ANALYST,), "app.filters:tool_set_filter"),
        Spec("clear_filter", (ANALYST,), "app.filters:tool_clear_filter"),
        # the browser's panes, laid out in one of the presets (panes.py); main's, since it answers the analyst
        Spec("set_layout", (ANALYST,), "app.panes:tool_set_layout", sessions=MAIN_ONLY),
        # a card of a card type opened as its view in Files, as the card's Open as view does (cardtypes.py); main's
        Spec("open_view", (ANALYST,), "app.cardtypes:tool_open_view", sessions=MAIN_ONLY),
        Spec("propose_view", (ANALYST,), _H + "propose_view"),
        Spec("write_document", (ANALYST,), "app.report_types:tool_write_document"),
        Spec("edit_document", (ANALYST,), "app.report_types:tool_edit_document"),
        # a comment beside a passage of a document: a check's, from the check's own session, or main's own note
        # (comments.py)
        Spec("add_comment", (ANALYST,), "app.checks:tool_add_comment", sessions=(None, CHECK_SESSION)),
        # a comment resolved or opened again, as the margin's ✓ does; main's, since a check's run only adds comments
        Spec("resolve_comment", (ANALYST,), "app.comments:tool_resolve_comment", sessions=MAIN_ONLY),
        Spec("reply_in_thread", (ANALYST,), "app.threads:tool_reply_in_thread"),
        # a message typed in the terminal to a thread, sent as that thread's composer would (/thimble:ask); main's
        Spec("message_thread", (ANALYST,), "app.threads:tool_message_thread", sessions=MAIN_ONLY),
        # thimble's agents listed for the terminal (tray.py)
        Spec("list_agents", (ANALYST,), "app.tray:tool_list_agents", sessions=MAIN_ONLY),
        # a thread renamed or deleted from the chat, as its row's menu does; main's, as the analyst asks it
        Spec("rename_thread", (ANALYST,), "app.threads:tool_rename_thread", sessions=MAIN_ONLY),
        Spec("delete_thread", (ANALYST,), "app.threads:tool_delete_thread", sessions=MAIN_ONLY),
        Spec("screenshot", (ANALYST,), _H + "screenshot"),
        Spec("start_orientation", (ANALYST,), "app.orient_session:tool_start_orientation", aliases=("orient",)),
        Spec("start_writing", (ANALYST,), "app.write_session:tool_start_writing"),
        # the orientation's check of its own analysis: its result is the Agent call that starts the critic; the
        # orientation's alone (subagents.allowed)
        Spec("critique", (ANALYST,), "app.critique_session:tool_critique", sessions=(ORIENT_SESSION,)),
        # a message to the orientation after it finished, which continues its agent (orient_session); main's alone
        Spec("message_orientation", (ANALYST,), "app.orient_session:tool_message_orientation", sessions=MAIN_ONLY),
        # a report check made or run from the chat; main's alone
        Spec("run_check", (ANALYST,), "app.checks:tool_run_check", sessions=MAIN_ONLY),
        # a report check turned off, as the Checks pane's switch does, its runs stopped; main's, as run_check is
        Spec("stop_check", (ANALYST,), "app.comments:tool_stop_check", sessions=MAIN_ONLY),
        Spec("file_dev_ticket", (ANALYST,), _H + "file_dev_ticket"),
        # a view's builder and reviewer check the view as often as they want, and finish once, where the server runs the
        # gates of record (view_tools.py); a gate stops when its caller drops the call (the agent was stopped)
        Spec("view_check", (ANALYST,), "app.view_tools:tool_view_check", sessions=(VIEW_SESSION, REVIEW_SESSION),
             drop_stops=True),
        Spec("finish_view", (ANALYST,), "app.view_tools:tool_finish_view", sessions=(VIEW_SESSION,), drop_stops=True),
        Spec("view_pictures", (ANALYST,), "app.view_tools:tool_view_pictures", sessions=(REVIEW_SESSION,),
             drop_stops=True),
        Spec("finish_review", (ANALYST,), "app.view_tools:tool_finish_review", sessions=(REVIEW_SESSION,),
             drop_stops=True),
        # a code ticket's agent checks its change in the ticket's box as often as it wants, and finishes once, where the
        # server commits the change and runs the gates of record (ticket_tools.py)
        Spec("ticket_checks", (ANALYST,), "app.ticket_tools:tool_ticket_checks", sessions=(TICKET_SESSION,),
             drop_stops=True),
        Spec("finish_ticket", (ANALYST,), "app.ticket_tools:tool_finish_ticket", sessions=(TICKET_SESSION,),
             drop_stops=True),
    )
}

# Argument aliases: {tool: {alias: current argument}}. The handlers read both spellings; the shim adds the alias to a
# tool's signature (unlisted) so a call by it passes the shim's validation.
ARG_ALIASES: dict[str, dict[str, str]] = {"add_card": {"title": "question"},
                                          "edit_card": {"cell": "card", "title": "question"},
                                          "delete_card": {"cell": "card"}}
# an alias of a tool -> its name (Spec.aliases)
TOOL_ALIASES: dict[str, str] = {a: s.name for s in REGISTRY.values() for a in s.aliases}

_SCHEMA_RE = re.compile(r"^```json[ \t]*\n(.*?)^```[ \t]*$", re.M | re.S)


class ToolsFileError(prompts.PromptError):
    """prompts/tools.md has no section for a registry tool, or the section has no ```json block holding an object
    schema. Every listing raises it, so a broken hand edit fails loudly instead of listing a tool without a schema."""


def known(name: str) -> bool:
    return name in REGISTRY or name in TOOL_ALIASES


def canonical(name: str) -> str:
    """A tool's canonical name, for its name or an alias (TOOL_ALIASES)."""
    return TOOL_ALIASES.get(name, name)


def role_of(actor: str) -> str:
    """The role an actor name denotes (actors are named by their role); ValueError for an unknown one."""
    if actor not in ROLES:
        raise ValueError(f"unknown actor/role {actor!r}; one of {', '.join(ROLES)}")
    return actor


def sections() -> dict[str, str]:
    """Every `## <name>` section of prompts/tools.md as written, read fresh; PromptError when the file is unusable."""
    return _sections_of(prompts.load(TOOLS_PROMPT))


def _sections_of(text: str) -> dict[str, str]:
    marks = [*_SECTION_RE.finditer(text)]
    return {m.group(1): text[m.end():marks[i + 1].start() if i + 1 < len(marks) else len(text)].strip()
            for i, m in enumerate(marks)}


def split_section(body: str) -> tuple[str, Any]:
    """(the description, the schema) of a tool's section: the prose with its last ```json block taken out, and that
    block parsed (None when the section has none). ValueError when the block is not JSON. An earlier plain ``` block,
    such as apply_label's examples, stays in the description."""
    blocks = [*_SCHEMA_RE.finditer(body)]
    if not blocks:
        return body.strip(), None
    m = blocks[-1]
    return (body[:m.start()] + body[m.end():]).strip(), json.loads(m.group(1))


# prompts/tools.md as descriptions() last read it, and what it made of it: every hint line of every call and request
# reads the file, which is cheap, and parses it again only when its text changed
_described: tuple[str, dict[str, str]] | None = None


def descriptions() -> dict[str, str]:
    """Every section of prompts/tools.md by name, a tool's as its description without the schema block and a hint's as
    written; {} (with a warning) when the file is unusable, so a result still reads without its hint lines. The dict is
    shared, so callers never change it."""
    global _described
    try:
        text = prompts.load(TOOLS_PROMPT)
    except prompts.PromptError as e:
        log.warning("prompts/%s.md unusable (%s); results go without their hint lines", TOOLS_PROMPT, e)
        return {}
    hit = _described
    if hit is not None and hit[0] == text:
        return hit[1]
    secs = _sections_of(text)
    out: dict[str, str] = {}
    for name, body in secs.items():
        try:
            out[name] = split_section(body)[0]
        except ValueError:
            out[name] = body
    _described = (text, out)
    return out


def tool_sections(names: "builtins.list[str] | tuple[str, ...] | None" = None) -> dict[str, tuple[str, dict[str, Any]]]:
    """{tool: (description, input schema)} from prompts/tools.md for the registry tools named (every one when None);
    ToolsFileError naming the first whose section is missing or has no ```json block holding an object schema."""
    try:
        secs = sections()
    except prompts.PromptError as e:
        raise ToolsFileError(f"prompts/{TOOLS_PROMPT}.md is unusable: {e}") from e
    out: dict[str, tuple[str, dict[str, Any]]] = {}
    for name in REGISTRY if names is None else names:
        body = secs.get(name)
        if body is None:
            raise ToolsFileError(f"prompts/{TOOLS_PROMPT}.md has no `## {name}` section for the tool {name}")
        try:
            desc, schema = split_section(body)
        except ValueError as e:
            raise ToolsFileError(f"prompts/{TOOLS_PROMPT}.md `## {name}`: its json block is not JSON ({e})") from e
        if not isinstance(schema, dict) or schema.get("type") != "object":
            raise ToolsFileError(f"prompts/{TOOLS_PROMPT}.md `## {name}`: no ```json block holding an object schema")
        out[name] = (desc, schema)
    return out


def schema_of(name: str) -> dict[str, Any]:
    """The input schema of one registry tool, from its section of prompts/tools.md."""
    return tool_sections((name,))[name][1]


def hint(name: str, **values: Any) -> str:
    """A hint section of prompts/tools.md (`## card-errored` …) with its {placeholders} filled; '' when absent."""
    body = descriptions().get(name, "")
    try:
        return body.format(**values) if body else ""
    except (KeyError, IndexError, ValueError):
        return body


def session_kind(session: str | None) -> str | None:
    """The kind of a THIMBLE_SESSION: `writer` for `writer:<doc>`, the value itself for one without a colon, None for
    main's shim, which sets none."""
    return str(session).split(":", 1)[0] or None if session else None


def list(role: str = ANALYST, session: str | None = None) -> "builtins.list[dict[str, Any]]":  # noqa: A001 — the contract names it `tools.list`
    """[{name, description, input_schema}] for the tools the role may use in the session `session` (a THIMBLE_SESSION),
    in registry order. A tool with `sessions` of its own is listed in those alone, but main's shim (no session) lists
    them all, since thimble's agents are main's subagents and call through it: each agent's registration takes away
    the tools that are not its own, and a call is refused when its caller may not make it (call_route)."""
    role_of(role)
    kind = session_kind(session)
    names = [s.name for s in REGISTRY.values() if role in s.roles and (kind is None or not s.sessions or kind in s.sessions)]
    secs = tool_sections(names)
    return [{"name": n, "description": secs[n][0], "input_schema": secs[n][1]} for n in names]


PLUGIN_NAME = "thimble"  # the plugin's name (orientation.PLUGIN), the scope of its MCP server's tools
WEB_TOOLS = ("WebFetch", "WebSearch")  # Claude Code's web tools, which an agent's `web: off` takes away


def thimble_tool(name: str) -> str:
    """A thimble tool's name as a subagent of main or a session thimble starts sees it, from the plugin's server."""
    return f"mcp__plugin_{PLUGIN_NAME}_{SERVER_NAME}__{name}"


def not_own(own: "builtins.list[str] | tuple[str, ...]") -> "builtins.list[str]":
    """The thimble tools of the registry not in `own`, as an agent sees them: its disallowedTools, which leave it its own
    thimble tools beside Claude Code's."""
    return [thimble_tool(n) for n in REGISTRY if n not in own]


def allowed_tools(role: str) -> "builtins.list[str]":
    """The `allowed_tools` names of a worker's thimble tools: mcp__thimble__<tool> per tool of the role."""
    role_of(role)
    return [f"mcp__{SERVER_NAME}__{s.name}" for s in REGISTRY.values() if role in s.roles and not s.sessions]

# --------------------------------------------------------------------------- the call context


def _created_by(actor: str) -> str:
    return TERMINAL if actor == ANALYST else actor


@dataclass
class Ctx:
    """One call's caller: workspace, actor, and the notebook its cells land in (resolved lazily). `terminal` says the
    call
    came from the terminal session's shim; False from an in-process SDK server."""

    c: str
    actor: str
    notebook: str | None = None
    terminal: bool = True
    anchor: str | None = None  # the card a thread is on (its `card:<id>` anchor's id; agents.py): edit_card's default card
    # the chat (agents.py) a call comes from: its cards are stamped `created_by: chat:<id>`; None from the terminal's shim
    chat: str | None = None
    session: str | None = None  # the THIMBLE_SESSION of the shim that posted the call: None for main's, `orient`, `writer:<doc>`
    # the id Claude Code gave the call (MCP `_meta` "claudecode/toolUseId"), named by the `agent` record a call writes
    # into
    # main
    tool_use_id: str | None = None

    @property
    def ws(self) -> Path:
        return config.workspace_dir(self.c)

    @property
    def created_by(self) -> str:
        """`terminal` for the terminal session's calls; a browser chat acts as the browser does (BROWSER_AUTHOR); a
        worker, its
        name. For cells, see `cell_author`."""
        if self.actor == ANALYST and not self.terminal:
            return BROWSER_AUTHOR
        return _created_by(self.actor)

    @property
    def cell_author(self) -> str:
        """created_by of a card this caller writes: the chat that wrote it (`chat:<id>`), the terminal's shim
        (`terminal`), else the actor's name; never the human's by-hand `user`."""
        if self.chat:
            return f"chat:{self.chat}"
        if own_group_session(self.session):
            run_chat = session_chat(self.c, self.session)
            if run_chat:  # a writer's card is the writer's from the start, never the analyst's `terminal`
                return f"chat:{run_chat}"
        if self.actor == ANALYST and not self.terminal:
            return BROWSER_CELL_AUTHOR
        return _created_by(self.actor)

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.c, self.actor, self.notebook or ("" if self.terminal else "browser"))

    def nb_id(self) -> str:
        """The caller's notebook: the explicit one when given (it must exist); else, as the analyst, the terminal
        session's
        (terminal_notebook) or, from a browser chat, the human's (analyst_notebook); ValueError for a worker without
        one."""
        from . import notebook

        if self.notebook:
            if notebook.read_notebook(self.ws, self.notebook) is None:
                raise ValueError(f"no such notebook: {self.notebook}")
            return self.notebook
        if own_group_session(self.session):
            return session_notebook(self)
        if self.actor == ANALYST:
            return terminal_notebook(self.c) if self.terminal else analyst_notebook(self.c)
        raise ValueError(f"the {self.actor} caller was started without a notebook, so cards have nowhere to land")


# The card a caller made or ran last, under (workspace, actor, notebook) and that key plus its group. From the terminal
# main, its forks and its subagents share the first key, so the takeaway reminder looks only at the caller's group, and
# a takeaway with no `cell` from the terminal is refused.
_last_cell: dict[tuple[str, ...], str] = {}


def _own_root(r: dict) -> bool:
    """Whether a group row can be a notebook of its own (the analyst's, or the session's): a root that no thread owns.
    A frame nested in another, a thread's frame and a question's frame hang in someone's notebook and are never one."""
    return not r.get("parent") and not r.get("anchor") and not r.get("chat")


def analyst_notebook(c: str) -> str:
    """The human's notebook id, where browser-originated cells land and by default the terminal session's:
    settings.active_notebook when it is theirs, else the newest of theirs with cells, else the newest, else a new
    "Your
    work", bound as settings.active_notebook. Theirs means a root group of role analyst that no thread owns
    (_own_root)."""
    from . import notebook
    from .ledger import read_json, write_json

    ws = config.workspace_dir(c)
    term = find_terminal_notebook(ws)
    own = [r for r in notebook.list_notebooks(ws)
           if (r.get("role") or notebook.DEFAULT_ROLE) == "analyst" and (term is None or r["id"] != term["id"])
           and r.get("kind") != notebook.LOOSE_KIND  # the cards dragged out of every frame are nobody's notebook
           and _own_root(r)]
    settings = read_json(ws / "settings.json", {})
    settings = settings if isinstance(settings, dict) else {}
    active = settings.get("active_notebook")
    pick = next((r for r in own if r["id"] == active), None)
    if pick is None and own:
        own.sort(key=lambda r: str(r.get("ts") or ""), reverse=True)
        pick = next((r for r in own if r.get("n_cells")), own[0])
    if pick is None:
        pick = notebook.create_notebook(ws, ANALYST_NOTEBOOK_TITLE, role="analyst", created_by=BROWSER_AUTHOR)
    elif not pick.get("created_by"):
        with notebook.editing(ws):
            nb = notebook.read_notebook(ws, pick["id"])
            if nb is not None:
                nb["created_by"] = BROWSER_AUTHOR
                notebook.write_notebook(ws, nb)
    if active != pick["id"]:
        settings["active_notebook"] = pick["id"]
        write_json(ws / "settings.json", settings)
    return str(pick["id"])


def find_terminal_notebook(ws: Path) -> "dict | None":
    """The terminal session's own notebook, read-only: a root group no thread owns whose record says `created_by:
    terminal`
    (the newest); None otherwise, when session cells go to the analyst's notebook. Nothing is created here."""
    from . import notebook

    mine = [r for r in notebook.list_notebooks(ws) if r.get("created_by") == TERMINAL and _own_root(r)]
    if not mine:
        return None
    mine.sort(key=lambda r: str(r.get("ts") or ""), reverse=True)
    return mine[0]


# A session thimble runs beside main (a writer, a report check, the critic) is not the analyst: its cards go to a root
# group of its own (session_notebook) stamped with its THIMBLE_SESSION under SESSION_GROUP_KEY and credited to its chat.
# The orientation is not one of them: its cards go to its deck (orient_deck).
SESSION_GROUP_KEY = "session"


def own_group_session(session: str | None) -> bool:
    """Whether the session `session` names (a THIMBLE_SESSION) keeps its cards in a group of its own (SESSION_GROUP_KEY):
    every session thimble runs beside main except the orientation, and never main's shim (None)."""
    kind = session_kind(session)
    return kind is not None and kind != ORIENT_SESSION


def session_chat(c: str, session: str | None) -> str | None:
    """The chat of the running agent of thimble's whose key `session` is, None when none runs (the mirror then credits
    its cards to it, agents.claim_cell)."""
    from . import subagents  # noqa: PLC0415 — subagents imports this module

    run = subagents.current(c, session) if session else None
    return run.chat if run is not None and run.chat else None


def session_group_title(c: str, session: str) -> str:
    """The title of a session's own group: `<document's name> figures` for a writer (`Report figures`), since what a
    writer adds is the document's figures; else the kind's, such as `Check cards`."""
    kind, _, rest = session.partition(":")
    if kind == WRITER_SESSION:
        from . import report_types  # noqa: PLC0415

        t = report_types.read_type(c, rest) if report_types.SLUG_RE.match(rest or "") else None
        name = str((t or {}).get("name") or rest or "document").strip()
        return f"{name[:1].upper()}{name[1:]} figures"
    return f"{kind.capitalize()} cards"


def session_notebook(ctx: "Ctx") -> str:
    """The group of the session ctx.session: the root group stamped with it, made at the canvas root the first time the
    session adds a card, never under the analyst's Your work. An unstamped figures group is not it."""
    from . import notebook

    key = str(ctx.session or "")
    mine = [r for r in notebook.list_notebooks(ctx.ws, figures=False)
            if not r.get("parent") and r.get(SESSION_GROUP_KEY) == key]  # notebook.summary carries the stamp
    if mine:
        return str(mine[0]["id"])
    with notebook.editing(ctx.ws):
        nb = notebook.create_notebook(ctx.ws, session_group_title(ctx.c, key), created_by=_group_author(ctx))
        nb[SESSION_GROUP_KEY] = key
        notebook.write_notebook(ctx.ws, nb)
    return str(nb["id"])


def _analysts(ws: Path, nb_id: str) -> bool:
    """Whether group `nb_id` is the analyst's: under a root of role analyst that no session stamped
    (SESSION_GROUP_KEY), no thread owns and is not the loose group; Your work, every frame in it and a group main made
    at the root. The orientation's deck (role exploration) and a session's own group are not."""
    from . import notebook

    seen: set[str] = set()
    cur = notebook.read_notebook(ws, nb_id)
    while cur is not None and cur.get("parent") and cur["id"] not in seen:
        seen.add(cur["id"])
        cur = notebook.read_notebook(ws, str(cur["parent"]))
    if cur is None:
        return False
    return ((cur.get("role") or notebook.DEFAULT_ROLE) == "analyst" and not cur.get(SESSION_GROUP_KEY)
            and cur.get("kind") != notebook.LOOSE_KIND and _own_root(cur))


def terminal_notebook(c: str) -> str:
    """The terminal session's notebook id, where its cards land and under which the groups its add_card names are made:
    the
    analyst's notebook (analyst_notebook) unless the workspace has one of the session's own (find_terminal_notebook)."""
    ws = config.workspace_dir(c)
    row = find_terminal_notebook(ws)
    return analyst_notebook(c) if row is None else str(row["id"])


def workspace_for_cwd(path: str | None) -> str | None:
    """The corpus a directory belongs to (config.workspace_for_cwd), None for no path."""
    return config.workspace_for_cwd(path) if path else None


# --------------------------------------------------------------------------- calling


def _resolve(path: str) -> Callable[..., Awaitable[ToolResult]]:
    mod_name, _, attr = path.partition(":")
    return getattr(importlib.import_module(mod_name), attr)


def _detail_text(detail: Any) -> str:
    """An HTTPException's detail as the model should read it: a string as is, a dict by its `message`, anything else as
    JSON."""
    if isinstance(detail, str):
        return detail
    if isinstance(detail, dict) and isinstance(detail.get("message"), str):
        return detail["message"]
    try:
        return json.dumps(detail)
    except (TypeError, ValueError):
        return str(detail)


async def call(c: str, name: str, args: dict[str, Any] | None, *, actor: str = ANALYST,
               notebook: str | None = None, terminal: bool = True, anchor: str | None = None,
               chat: str | None = None, session: str | None = None, tool_use_id: str | None = None) -> ToolResult:
    """Run one tool for one caller, by its name or an alias. KeyError for a tool the registry does not have; every other
    failure is an is_error result the model reads. `terminal`, `anchor`, `session` and `tool_use_id` go to the Ctx."""
    from . import canvas_history, undo  # noqa: PLC0415

    name = canonical(name)
    spec = REGISTRY[name]
    # a follow-up of the orientation is one change the analyst asked for, so its steps are one undo (undo.batching)
    batch = None
    if session_kind(session) == ORIENT_SESSION:
        from . import orient_session  # noqa: PLC0415 — orient_session imports this module

        batch = orient_session.undo_batch(c)
    # a session thimble started (the orientation, a writer) owns the steps its calls make (undo, sessions)
    with undo.batching(batch), undo.acting_session(session):
        with canvas_history.acting(Ctx(c, actor, notebook, terminal, anchor, chat, session).cell_author):  # who changed a card
            res = await _run(spec, c, name, args, actor, notebook, terminal, anchor, chat, session, tool_use_id)
        # the card check (card_check.py): a card add_card or edit_card wrote is drawn and read once it has its
        # takeaway; nothing of the check joins this result
        from . import card_check  # noqa: PLC0415 — card_check imports the harness

        res = await card_check.after_tool(c, name, args, res, session=session, anchor=anchor)
    return with_call_line(name, args, res)


async def _run(spec: Spec, c: str, name: str, args: dict[str, Any] | None, actor: str, notebook: str | None, terminal: bool,
               anchor: str | None, chat: str | None, session: str | None = None,
               tool_use_id: str | None = None) -> ToolResult:
    try:
        role = role_of(actor)
    except ValueError as e:
        return err(str(e))
    if role not in spec.roles:
        return err(f"{name} is not available to the {actor} caller")
    try:
        config.workspace_dir(c)
    except ValueError as e:
        return err(f"{name}: {e}")
    ctx = Ctx(c, actor, notebook, terminal, anchor, chat, session, tool_use_id)
    try:
        return _as_result(await _maybe_await(_resolve(spec.handler)(ctx, dict(args or {}))))
    except HTTPException as e:  # a request the backing module rejected: the model's mistake, told plainly
        return err(f"{name} failed: {_detail_text(e.detail)}")
    except (ValueError, KeyError) as e:
        return err(f"{name} failed: {e}")
    except Exception as e:  # noqa: BLE001 — never raise into the SDK or the route
        log.exception("tool %s failed", name)
        return err(f"{name} failed: {type(e).__name__}: {e}")


def call_line(name: str, args: dict[str, Any] | None) -> str:
    """The first line of every result, the call as run, the way a shell echoes a command: `$ add_card kind=plot
    question="..."`, strings quoted and cut to CALL_ARG_CHARS, other values as compact JSON."""
    parts = [f"$ {name}"]
    for k, v in (args or {}).items():
        if v is None or not isinstance(k, str):
            continue
        if isinstance(v, str):
            body = json.dumps(v, ensure_ascii=False)[1:-1]
            parts.append(f'{k}="{_cut(body)}"')
        elif isinstance(v, bool) or isinstance(v, (int, float)):
            parts.append(f"{k}={json.dumps(v)}")
        else:
            try:
                parts.append(f"{k}={_cut(json.dumps(v, ensure_ascii=False, separators=(',', ':'), default=str))}")
            except (TypeError, ValueError):
                parts.append(f"{k}={_cut(str(v))}")
    return " ".join(parts)


def _cut(s: str, n: int = CALL_ARG_CHARS) -> str:
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def with_call_line(name: str, args: dict[str, Any] | None, res: ToolResult) -> ToolResult:
    """`res` with call_line(name, args) as its first line, ahead of the first text block (or as a new one)."""
    line = call_line(name, args)
    for b in res.content:
        if b.get("type") == "text":
            b["text"] = f"{line}\n{b.get('text', '')}" if str(b.get("text", "")) else line
            return res
    res.content.insert(0, {"type": "text", "text": line})
    return res


# --------------------------------------------------------------------------- shared helpers


def _optional(module: str, attr: str) -> Callable[..., Any] | None:
    """`attr` of `app.<module>` when both exist, else None."""
    try:
        mod = importlib.import_module(f"app.{module}")
    except ModuleNotFoundError as e:
        if e.name in (f"app.{module}", module):
            return None
        raise
    fn = getattr(mod, attr, None)
    return fn if callable(fn) else None


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _not_available(name: str, module: str, attr: str) -> ToolResult:
    return err(f"{name} is not available yet: app.{module}.{attr} is not in this build")


def _cell_id_of(raw: Any) -> str:
    """'card:<id>', '[[card:<id>]]', 'card:<id>#...', '<id>' -> '<id>' ('' when empty); `cell:` reads as `card:`."""
    s = str(raw or "").strip().strip("[]").strip()
    if cite.is_card_ref(s):
        m = _CELL_ID_RE.match(s)
        return m.group(1) if m else ""
    return s.split("#", 1)[0].split("@", 1)[0]


def _outputs_text(cell: dict, addressed: bool = False) -> tuple["builtins.list[str]", set[str]]:
    """(the text of a cell's outputs as the model reads them, in order; the rich kinds present). An error is its
    traceback, a
    table its printed text, a table card's frame the rows it shows, a chart the rows it draws. `addressed` heads each
    output so it can be cited (`[out<i>]` with `L<n>|` lines, table addresses, `## frame-rows`, `## chart-rows`)."""
    from .verify import table_address

    texts: builtins.list[str] = []
    extras: set[str] = set()
    cid = str(cell.get("id") or "")
    for i, out in cite.iter_outputs(cell.get("outputs")):
        e = out.get(ERROR_MIME)
        if isinstance(e, dict):
            tb = e.get("traceback") or []
            texts.append("\n".join([f"{e.get('ename', 'Error')}: {e.get('evalue', '')}", *map(str, tb)]))
            continue
        frame = frames.frame_of(out)
        if frame is not None:  # a table card's DataFrame: the rows the card shows, as it formats them
            extras.add("table")
            body = frames.frame_text(frame)
            if addressed:
                head = (hint("frame-rows", out=i, rows=len(frame["rows"]), cid=cid, label=frame["label"]) if frame.get("label")
                        else hint("frame-rows-numbered", out=i, rows=len(frame["rows"]), cid=cid))
                body = "\n".join(x for x in (head, body) if x)
            texts.append(body)
            continue
        for mime in out:
            if mime.startswith("image/"):
                extras.add("image")
            elif mime == "text/html":
                extras.add("html")
            elif "vega" in mime:
                extras.add("chart")
            elif mime in DRAWING_MIMES:
                extras.add(DRAWING_MIMES[mime])
            elif mime == CARD_MIME:
                extras.add("chart")
        if any(k.startswith("image/") or "vega" in k for k in out):
            chart = cite.chart_table(out)
            rows = chart.text() if chart is not None else ""
            if addressed:
                # the row names a ref uses: the label column's values, else the row's position, which the rows'
                # text prints first either way (cite.ChartTable.text), so the header says which
                head = (hint("chart-no-rows", out=i) if chart is None
                        else hint("chart-rows", out=i, rows=chart.total, cid=cid, label=chart.label) if chart.label
                        else hint("chart-rows-numbered", out=i, rows=chart.total, cid=cid))
                texts.append("\n".join(x for x in (head, rows) if x))
            elif rows:
                texts.append(rows)
            continue
        if "text/plain" in out and "text/markdown" not in out:
            tp = out["text/plain"]
            body = "".join(tp) if isinstance(tp, builtins.list) else str(tp)
            if addressed and "text/html" in out:
                body = table_address(cid, i) + "\n" + body.rstrip("\n")
            elif addressed:
                body = f"[out{i}]\n" + "\n".join(f"L{n}|{line}" for n, line in enumerate(body.rstrip("\n").split("\n"), 1))
            texts.append(body)
        elif addressed and "text/markdown" in out:
            texts.append(f"[out{i}: markdown]")
    return texts, extras

def result_lines(c: str) -> int:
    """How many lines of one output an add_card result shows in workspace `c`: settings.json `run_cell_result_lines`
    when a
    positive integer, else RESULT_LINES. Read fresh per call."""
    from .ledger import read_json

    try:
        settings = read_json(config.workspace_dir(c) / "settings.json", {})
    except (OSError, ValueError):
        return RESULT_LINES
    v = settings.get(RESULT_LINES_KEY) if isinstance(settings, dict) else None
    if isinstance(v, str) and v.strip().isdigit():
        v = int(v.strip())
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v < 1:
        return RESULT_LINES
    return int(v)


def _more_trailer(what: str, cid: str) -> str:
    """The line that closes a cut output: prompts/tools.md `## add_card-more` with {more} and {ref} filled."""
    return hint("add_card-more", more=what, ref=f"card:{cid}")


def _cap_output(text: str, lines: int, chars: int, cid: str) -> str:
    """One addressed output cut to its first `lines` lines and `chars` chars, closed by the add_card-more trailer when
    anything was left out. The `[out<i>]` header counts for neither."""
    rows = text.split("\n")
    head = rows[:1] if rows and rows[0].startswith("[out") else []
    body = rows[len(head):]
    kept = body[:lines]
    total = sum(len(r) + 1 for r in kept)
    while len(kept) > 1 and total > chars:
        total -= len(kept[-1]) + 1
        kept.pop()
    omitted = len(body) - len(kept)
    cut_chars = 0
    if len(kept) == 1 and len(kept[0]) > chars:
        cut_chars = len(kept[0]) - chars
        kept[0] = kept[0][:chars].rstrip() + "…"
    if not omitted and not cut_chars:
        return text
    what = f"{omitted} more line{'s' if omitted != 1 else ''}" if omitted else f"{cut_chars} more chars"
    return "\n".join([*head, *kept, _more_trailer(what, cid)])


def _format_cell_result(cell: dict, lines: int = RESULT_LINES) -> str:
    """The string the model sees from add_card: 'card:<id>', the addressed outputs cut to size, and a note on rich
    output."""
    cid = cell.get("id", "?")
    lines = max(1, int(lines))
    chars = lines * RESULT_CHARS_PER_LINE
    texts, extras = _outputs_text(cell, addressed=True)
    body = "\n".join(_cap_output(t, lines, chars, cid) for t in texts if t)
    limit = RESULT_OUTPUTS * chars
    if len(body) > limit:
        cut = body[:limit].rstrip()
        body = cut + "\n" + _more_trailer(f"{len(body) - len(cut)} more chars", cid)
    if cell.get("status") == "error" and not texts:
        body = body or "(the card errored with no output)"
    out = [f"card:{cid}"]
    if body:
        out.append(body)
    if extras:
        out.append(f"(rendered a chart/table; thimble shows it as [[card:{cid}]])")  # mode-neutral: both modes draw it
    return "\n".join(out)


def _cell_timeout(cell: dict) -> float | None:
    for out in cell.get("outputs") or []:
        e = out.get(ERROR_MIME) if isinstance(out, dict) else None
        if isinstance(e, dict) and e.get("ename") == "TimeoutError":
            t = e.get("timeout_s")
            return float(t) if isinstance(t, (int, float)) and not isinstance(t, bool) and t > 0 else 0.0
    return None


def _error_hint(cell: dict) -> str:
    """The hint an errored card's result ends with: `## card-errored`, or `## card-timeout` when the run was
    interrupted. Both tools that run a card share them, and both name edit_card as the way to fix it."""
    t = _cell_timeout(cell)
    text = hint("card-errored") if t is None else hint("card-timeout", limit=f"{t:g} s" if t else "its time limit")
    return f"\n\n{text}" if text else ""


def _output_shape(cell: dict) -> str:
    if cell.get("status") == "error":
        return "error"
    texts, extras = _outputs_text(cell)
    if "chart" in extras or extras & set(DRAWING_MIMES.values()):
        return "chart"
    if "image" in extras:
        return "image"
    if extras & {"html", "table"}:
        return "table"
    return "text" if any(t.strip() for t in texts) else "none"


def _default_timeout(ctx: Ctx) -> float | None:
    """The `default_timeout_s` a card run takes when the card stores no allowance, decided by who called:
    notebook.CHAT_EXEC_TIMEOUT for main and its threads (CHAT_ACTORS), None (notebook.EXEC_TIMEOUT) for the
    background
    sessions in FULL_TIME_SESSIONS."""
    from . import notebook

    if ctx.actor not in CHAT_ACTORS or session_kind(ctx.session) in FULL_TIME_SESSIONS:
        return None
    return float(getattr(notebook, "CHAT_EXEC_TIMEOUT", 30.0))


def _first_clause(text: str, cap: int = LINE_LIMIT) -> str:
    t = " ".join((text or "").split())
    for sep in (". ", "; "):
        i = t.find(sep)
        if i != -1:
            t = t[: i + 1]
            break
    return t if len(t) <= cap else t[: cap - 1].rstrip() + "…"


def _find_notebook(ws: Path, ref: str) -> dict | None:
    """A group by id, path of titles (`Orientation / Final`, as add_card takes it; _group_at_path), exact title
    (case-insensitive), title substring, or role name."""
    from . import notebook

    rows = notebook.list_notebooks(ws, figures=False)
    key = " ".join(ref.split()).casefold()
    for r in rows:
        if r["id"] == ref:
            return r
    if GROUP_PATH_SEP in " ".join(ref.split()):
        hit = _group_at_path(rows, ref)
        if hit is not None:
            return hit
    for r in rows:
        if str(r.get("title") or "").casefold() == key:
            return r
    hits = [r for r in rows if key and key in str(r.get("title") or "").casefold()]
    if len(hits) == 1:
        return hits[0]
    for r in rows:
        if str(r.get("role") or "").casefold() == key:
            return r
    return None


# --------------------------------------------------------------------------- handlers: cells


# The role a group made by title gets, by the title's last word: `Orientation` and the legacy `Final` are the
# orientation's deck; anything else the analyst's.
GROUP_ROLES_BY_TITLE = {"final": "exploration", "orientation": "exploration"}
# How the canvas writes a group under another (canvas/layout.ts) and how a caller names one. The spaces are part of it:
# a thread's group is titled `main/<slug>`, one title with a slash in it.
GROUP_PATH_SEP = " / "
PARENT_KIND = "split"  # a group made above another by a path (notebook.GROUP_KINDS; every group renders as one column)
# The `group` of a `card` event (a request sent from a document with ⌘↵, or /card): `request:<id>`. The card lands in
# the analyst's Your work, and the stream carries `card-request {request, card}` once it is made.
REQUEST_GROUP_RE = re.compile(r"^request:([A-Za-z0-9_-]{1,64})$")


def request_of(group: str) -> str | None:
    """The request id a `request:<id>` group names, else None."""
    m = REQUEST_GROUP_RE.match(str(group or "").strip())
    return m.group(1) if m else None


def _answer_request(ctx: "Ctx", request: str | None, cid: str) -> None:
    """Say on the workspace stream that card `cid` answers the browser's card request `request`."""
    if not request or not cid:
        return
    from . import investigation  # noqa: PLC0415

    try:
        investigation.emit(ctx.c, investigation.MAIN, {"type": "card-request", "request": request, "card": cid})
    except RuntimeError:  # no running loop: the card is on the canvas all the same
        log.debug("card-request %s not announced off the event loop", request)


def _role_by_title(title: str) -> str:
    from . import notebook

    return GROUP_ROLES_BY_TITLE.get(title.rsplit(" ", 1)[-1].casefold(), notebook.DEFAULT_ROLE)


def group_path(ws: Path, path: str, *, created_by: str | None = None, made: "builtins.list[str] | None" = None) -> str:
    """The group a path of titles names (`Orientation / Final`), made where missing, matched by title without case; a
    group
    stored under the whole path as one title is that group. Each title made is appended to `made`. Under the groups'
    lock, so two processes that look for one path make it once."""
    from . import notebook

    with notebook.editing(ws):
        return _group_path(ws, path, created_by, made)


def _group_path(ws: Path, path: str, created_by: str | None, made: "builtins.list[str] | None") -> str:
    from . import notebook

    parts = [p.strip() for p in path.split(GROUP_PATH_SEP.strip()) if p.strip()]
    rows = notebook.list_notebooks(ws, figures=False)
    flat = " / ".join(parts).casefold()
    legacy = next((r for r in rows if str(r.get("title") or "").strip().casefold() == flat), None)
    if legacy is not None:
        return str(legacy["id"])
    parent: str | None = None
    for i, title in enumerate(parts):
        key = title.casefold()
        hit = next((r for r in rows if (r.get("parent") or None) == parent and str(r.get("title") or "").strip().casefold() == key), None)
        if hit is None:
            leaf = i == len(parts) - 1
            hit = notebook.create_notebook(ws, title, role=_role_by_title(title), parent=parent, created_by=created_by,
                                           kind=None if leaf else PARENT_KIND)
            rows.append(notebook.summary(hit))
            if made is not None:
                made.append(GROUP_PATH_SEP.join(parts[: i + 1]))
        parent = str(hit["id"])
    return str(parent)


def _group_at_path(rows: "builtins.list[dict]", path: str) -> dict | None:
    """The group a path of titles names, found as group_path finds it and never made; None when a title is missing."""
    parts = [p.strip() for p in path.split(GROUP_PATH_SEP.strip()) if p.strip()]
    flat = " / ".join(parts).casefold()
    hit = next((r for r in rows if str(r.get("title") or "").strip().casefold() == flat), None)
    if hit is not None:
        return hit
    parent: str | None = None
    for title in parts:
        key = title.casefold()
        hit = next((r for r in rows if (r.get("parent") or None) == parent and str(r.get("title") or "").strip().casefold() == key), None)
        if hit is None:
            return None
        parent = str(hit["id"])
    return hit


def _group_name(rows: "builtins.list[dict]", row: dict) -> str:
    """A group's name as add_card and list_cards take it: its title after the titles of the groups above it, joined
    by GROUP_PATH_SEP, so `Final` under `Orientation` reads `Orientation / Final`."""
    by_id = {str(r["id"]): r for r in rows}
    names, seen, cur = [], set(), row
    while cur is not None and str(cur["id"]) not in seen:
        seen.add(str(cur["id"]))
        names.append(str(cur.get("title") or cur["id"]))
        cur = by_id.get(str(cur.get("parent") or ""))
    return GROUP_PATH_SEP.join(reversed(names))


def _group_author(ctx: Ctx) -> str | None:
    """created_by of a group a caller's add_card makes: the caller's name, but never `terminal`, which marks the
    session's own notebook (find_terminal_notebook); the terminal's cards in it say who made them."""
    author = ctx.cell_author
    return None if author == TERMINAL else author


def _group_id(ctx: Ctx, group: str, made: "builtins.list[str]") -> str:
    """The group `group` names, made when missing: the deck for the orientation's session (orient_deck); a thread's
    group for
    `thread:<id>`; the analyst's Your work for `request:<id>`; a path of titles (group_path); a group by id or title;
    else a
    new group with that title under the caller's own group, its role by the title's last word. A session with its own
    group (own_group_session) never reaches the analyst's groups. Titles made are appended to `made`."""
    from . import notebook, threads

    if session_kind(ctx.session) == ORIENT_SESSION:
        return orient_deck(ctx)
    if own_group_session(ctx.session):
        # a writer's (or another session's) card never lands in the analyst's groups, whatever it names: those land
        # in its own group, and a new title is a group under its own (session_notebook)
        own = ctx.nb_id()
        if group.casefold() == notebook.read_notebook(ctx.ws, own)["title"].casefold():
            return own
        if request_of(group) is None and threads.group_of(ctx.c, group) is None and GROUP_PATH_SEP not in group:
            row = _find_notebook(ctx.ws, group)
            if row is not None and not _analysts(ctx.ws, str(row["id"])):
                return str(row["id"])
            if row is None:
                nb = notebook.create_notebook(ctx.ws, group, role=_role_by_title(group), parent=own, created_by=_group_author(ctx))
                made.append(group)
                return str(nb["id"])
        return own
    if (thread_group := threads.group_of(ctx.c, group)) is not None:
        return thread_group
    if request_of(group) is not None:
        return analyst_notebook(ctx.c)
    if GROUP_PATH_SEP in group:
        return group_path(ctx.ws, group, created_by=_group_author(ctx), made=made)
    row = _find_notebook(ctx.ws, group)
    if row is not None:
        return str(row["id"])
    nb = notebook.create_notebook(ctx.ws, group, role=_role_by_title(group), parent=ctx.nb_id(), created_by=_group_author(ctx))
    made.append(group)
    return str(nb["id"])


def orient_deck(ctx: Ctx) -> str:
    """The group every card of the orientation's session lands in, whatever the call names: its deck, `Orientation`
    (orientation.ensure_groups makes it when missing)."""
    from . import orientation  # noqa: PLC0415 — orientation imports agents, which imports this module

    return orientation.ensure_groups(ctx.c)["orientation"]


def _group_role(ctx: Ctx, nb_id: str) -> str:
    from . import notebook

    nb = notebook.read_notebook(ctx.ws, nb_id)
    return str((nb or {}).get("role") or notebook.DEFAULT_ROLE)


# The group a card lands in when add_card or apply_label names none (default_group): the active group, else the last
# one, else Your work.
ACTIVE_GROUP_KEY = "active_group"  # settings.json: the frame the analyst last selected or worked in (active_group_route)
# The group each caller last added a card to, by _caller, kept in memory.
_last_group: dict[tuple[str, ...], str] = {}


def _caller(ctx: Ctx) -> tuple[str, ...]:
    """Who a call belongs to, for _last_group: the workspace, the actor, the notebook, the shim's session (main's, the
    orientation's, a writer's) and the chat. Main, its forks and its subagents call through main's shim, so they share
    one entry."""
    return (*ctx.key, ctx.session or "", ctx.chat or "")


def _live_group(ws: Path, nb_id: object) -> str | None:
    """`nb_id` when it names a group a card can land in: one that exists and is drawn as a frame, so neither the loose
    group (the cards dragged out of every frame) nor a document's figures; else None."""
    from . import notebook

    if not isinstance(nb_id, str) or not notebook.ID_RE.match(nb_id):
        return None
    nb = notebook.read_notebook(ws, nb_id)
    if nb is None or nb.get("kind") == notebook.LOOSE_KIND or notebook.is_figures(nb):
        return None
    return nb_id


def active_group(c: str) -> str | None:
    """The group the analyst has active on the canvas, as the browser last reported it (active_group_route), while that
    group still exists; None when the browser has reported none."""
    from .ledger import read_json

    ws = config.workspace_dir(c)
    settings = read_json(ws / "settings.json", {})
    return _live_group(ws, settings.get(ACTIVE_GROUP_KEY) if isinstance(settings, dict) else None)


def default_group(ctx: Ctx) -> str:
    """The group a card lands in when the call names none. A caller with a notebook of its own uses it; the orientation
    gets
    its deck. Otherwise: the group active in the browser (main's session only), then the group this caller last added
    a
    card to, then the caller's own group (Ctx.nb_id)."""
    if not ctx.notebook:
        if session_kind(ctx.session) == ORIENT_SESSION:
            return orient_deck(ctx)
        if ctx.actor == ANALYST and not ctx.session:
            hit = active_group(ctx.c)
            if hit:
                return hit
        hit = _live_group(ctx.ws, _last_group.get(_caller(ctx)))
        if hit:
            return hit
    return ctx.nb_id()


def _note_group(ctx: Ctx, nb_id: str) -> None:
    """Remember the group a caller added a card to, for default_group. A thread's group is not remembered, since a fork
    calls
    through main's shim."""
    from . import notebook

    nb = notebook.read_notebook(ctx.ws, nb_id)
    if nb is not None and (nb.get("chat") or nb.get("anchor")):
        return
    _last_group[_caller(ctx)] = nb_id


# add_card's content fields beside `code`, by the data kind that shows each (notebook.PAYLOAD_KEYS)
CONTENT_FIELDS = ("refs", "text", "html")
# what a diagram's and a timeline's code ends in (kernel_thimble.diagram and .timeline), for the line that asks for it
KIND_ENDINGS = {"diagram": "thimble.diagram(nodes, edges)", "timeline": "thimble.timeline(events)"}


# the data kind whose content each field is (add_card's schema: example shows `refs`, note `text` and custom `html`)
FIELD_KINDS = {"refs": "example", "text": "note", "html": "custom"}


def _given(args: dict[str, Any], field: str) -> bool:
    v = args.get(field)
    return bool(v) if isinstance(v, (builtins.list, tuple)) else bool(str(v or "").strip())


def _needs_code(tool: str, kind: str, args: dict[str, Any] | None = None) -> str:
    """The error line for a card of a running kind called without `code`, naming the kind a content field given
    instead belongs to (a `text` with no `kind` meant a note, and the default kind is code)."""
    end = KIND_ENDINGS.get(kind)
    line = f"{tool}: a {kind} card needs `code`" + (f" that ends in {end}, after import thimble" if end else "")
    field = next((f for f in CONTENT_FIELDS if _given(args or {}, f)), None)
    return line + (f"; `{field}` is what a {FIELD_KINDS[field]} card shows, so pass kind {FIELD_KINDS[field]}" if field else "")


def _code_on_data(tool: str, kind: str, args: dict[str, Any]) -> str:
    """The error line for `code` given to a card of a data kind, which would drop it without running it."""
    from . import notebook

    if not _given(args, "code"):
        return ""
    a = "an" if kind[:1] in "aeiou" else "a"
    return (f"{tool}: {a} {kind} card shows `{notebook.PAYLOAD_KEYS.get(kind, 'content')}` and runs no `code`, so leave "
            f"`code` out, or add a card of code for what it computes")


def _content_on_code(tool: str, kind: str, args: dict[str, Any]) -> str:
    """The error line for a data kind's field (`refs`, `text`, `html`) given to a card that runs code, which would store
    the
    card without it."""
    field = next((f for f in CONTENT_FIELDS if _given(args, f)), None)
    if field is None:
        return ""
    other = FIELD_KINDS[field]
    a = "an" if other[:1] in "aeiou" else "a"
    return (f"{tool}: a {kind} card shows what its `code` outputs, and `{field}` is what {a} {other} card shows, so "
            f"leave `{field}` out, or add {a} {other} card for it")


def _example_ref(c: str | None, item: Any) -> tuple[str, str]:
    """(one ref of an example card, the error line): a ref as given, or for {ref, quote} the span of the quoted passage
    in that record (refs.span_of_quote), so the card shows the passage rather than the record's first lines."""
    from . import refs as refs_mod

    if not isinstance(item, dict):
        return str(item).strip().strip("[]"), ""
    ref = str(item.get("ref") or "").strip().strip("[]")
    quote = str(item.get("quote") or "")
    if not ref or not quote.strip() or c is None:
        return ref, ""
    try:
        return refs_mod.span_of_quote(config.corpus_dir(c), ref, quote), ""
    except refs_mod.RefError:
        return ref, hint("example-quote-missing", ref=ref, quote=_cut(" ".join(quote.split()), 80))


async def _warm_view_refs(c: str | None, args: dict[str, Any]) -> None:
    """Resolve an example's quoted view refs once in a worker thread before the handler reads them on the loop, since
    views.resolve_sync cannot run a view's reader on that loop. The answer is memoised for _example_ref."""
    from . import refs as refs_mod

    if c is None:
        return
    raw = args.get("refs")
    items = [raw] if isinstance(raw, dict) else raw if isinstance(raw, builtins.list) else []
    wanted = [str(i.get("ref") or "").strip().strip("[]") for i in items if isinstance(i, dict) and i.get("quote")]
    def read_by_view(r: str) -> bool:  # a unit of a view, or a file's locator only a view reads
        try:
            p = refs_mod.parse_ref(r)
        except ValueError:
            return False
        return p["kind"] == "view" or (p["kind"] == "path" and bool(p.get("locator")))

    for ref in [r for r in wanted if read_by_view(r)][:WARM_REFS_MAX]:
        try:
            await asyncio.to_thread(refs_mod.resolve, config.corpus_dir(c), ref)
        except Exception:  # noqa: BLE001 — _example_ref reports a ref that does not resolve
            continue


def _payload_args(kind: str, args: dict[str, Any], tool: str = "add_card", c: str | None = None) -> tuple[dict | None, str]:
    """(the payload a data card of `kind` carries from the call's arguments, the error line when it is missing). An
    example's refs are resolved in workspace `c` where one is a {ref, quote} (_example_ref)."""
    if kind == "example":
        raw = args.get("refs")
        items = [raw] if isinstance(raw, (str, dict)) else raw if isinstance(raw, builtins.list) else []
        refs: builtins.list[str] = []
        for item in items:
            ref, problem = _example_ref(c, item)
            if problem:
                return None, f"{tool}: {problem}"
            if ref:
                refs.append(ref)
        return ({"refs": refs}, "") if refs else (None, f"{tool}: an example card needs `refs`")
    if kind == "note":
        text = str(args.get("text") or "")
        return ({"text": text}, "") if text.strip() else (None, f"{tool}: a note card needs `text`")
    if kind == "custom":
        html = str(args.get("html") or "")
        return ({"html": html}, "") if html.strip() else (None, f"{tool}: a custom card needs `html`")
    if kind == "label":
        return None, f"{tool}: a label card is made by `apply_label`"
    return None, _needs_code(tool, kind)


def _kind_mismatch(kind: str, cell: dict) -> str:
    """The shape a clean run's output has when it is not what `kind` promises, else ''. A diagram or a timeline may be
    the canvas's drawing (thimble.diagram, thimble.timeline) or a chart."""
    if cell.get("status") != "ok":
        return ""
    shape = _output_shape(cell)
    if kind in ("plot", "timeline") and shape not in ("chart", "image"):
        return shape
    if kind == "table" and shape != "table":
        return shape
    return ""


def _card_installs(ctx: Ctx, code: str, tool: str) -> str:
    """The refusal of card code that installs software or downloads files (sandbox_allow.code_installs), from an agent
    thimble started; '' otherwise. Such code runs in the kernel, where neither a permission prompt nor Claude Code's
    permission mode reaches it, so it is refused whatever the mode (userconf's `installs` is read and ignored)."""
    from . import sandbox_allow  # noqa: PLC0415

    if not ctx.session or not code.strip():
        return ""
    return hint("card-installs", tool=tool) if sandbox_allow.code_installs(code) else ""


async def _h_add_card(ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    """One new card on the canvas. A running kind runs its code and the result is checked against the kind; a data kind
    (example, note, custom) stores its refs, text or html. `group` names the group, else default_group picks. A
    `takeaway`
    given here is stored once the card is in (_takeaway_after)."""
    from . import notebook

    kind = str(args.get("kind") or notebook.DEFAULT_KIND).strip().lower()
    if kind == "label":
        return err("add_card: a label card is made by `apply_label`")
    if kind not in ADD_CELL_KINDS:
        return err(f"add_card: `kind` must be one of {', '.join(ADD_CELL_KINDS)}")
    title = " ".join(str(args.get("question") or args.get("title") or "").split())
    if not title:
        return err("add_card: `question` is empty (the one question this card answers)")
    code = str(args.get("code") or "")
    data = kind in notebook.DATA_KINDS
    payload: dict | None = None
    if data:
        await _warm_view_refs(ctx.c, args)
        payload, problem = _payload_args(kind, args, "add_card", ctx.c)
        problem = problem or _code_on_data("add_card", kind, args)
        if problem:
            return err(problem)
    elif not code.strip():
        return err(_needs_code("add_card", kind, args))
    elif problem := _content_on_code("add_card", kind, args) or _card_installs(ctx, code, "add_card"):
        return err(problem)
    group = " ".join(str(args.get("group") or "").split())
    request = request_of(group)
    made: builtins.list[str] = []
    nb_id = _group_id(ctx, group, made) if group else default_group(ctx)
    _note_group(ctx, nb_id)
    lines: builtins.list[str] = [f"made the group {t!r}" for t in made]  # what the result says after the card's result
    warn = ""
    prev = _last_cell.get((*ctx.key, nb_id))
    if prev:
        pc = notebook.get_cell(ctx.c, prev)
        # the caller's last card still has no takeaway: a card of code that ran clean, or an example, note or custom
        # card, whose content the caller chose
        shown = pc and (pc.get("status") == "ok" or (not notebook.runnable(pc) and pc.get("kind") != "label"))
        if shown and not str(pc.get("takeaway") or "").strip():
            note = hint("takeaway-reminder", cid=prev)
            warn = f"{note}\n\n" if note else ""
    raw_takeaway = args.get("takeaway")
    takeaway = str(raw_takeaway) if raw_takeaway is not None and str(raw_takeaway).strip() else None
    if data:
        res = _add_data_cell(ctx, nb_id, kind, title, payload or {}, lines)
        if res.is_error:
            return res
        new = res.text.split("\n", 1)[0].removeprefix("card:")
        _answer_request(ctx, request, new)
        line, _ = _takeaway_after(ctx, new, takeaway, None)
        if takeaway is None:
            # an example, note or custom card is asked for its takeaway as a clean run is (_takeaway_missing), since
            # otherwise nothing reminds the caller when no add_card follows
            line = hint("takeaway-missing-shown", cid=new)
        return ok(warn + res.text + (f"\n\n{line}" if line else ""))
    if cardrun.defers(ctx.c):  # terminal mode: the code runs through `thimble-run` in the caller's Bash
        await cardrun.ready_types(ctx.c, code)
        cell = notebook.new_cell(kind, ctx.cell_author, title, nb_id, code=code)
        cell[notebook.RUN_KEY] = cardrun.run_record(str(cell["id"]), takeaway=takeaway,
                                                    default_timeout_s=_default_timeout(ctx), session=ctx.session)
        cell = notebook.insert_cell(ctx.c, nb_id, cell)
        _remember_cell(ctx, nb_id, str(cell["id"]))
        _answer_request(ctx, request, str(cell["id"]))
        return ok(warn + cardrun.waiting(ctx.c, cell, lines))
    cell = await notebook.run_code(ctx.c, code, created_by=ctx.cell_author, title=title, notebook=nb_id,
                                   default_timeout_s=_default_timeout(ctx), kind=kind)
    cid = str(cell.get("id") or "")
    if cid:
        _remember_cell(ctx, nb_id, cid)
    _answer_request(ctx, request, cid)
    text = _format_cell_result(cell, lines=result_lines(ctx.c)) + _run_hint(cell, kind)
    for line in lines:
        text += f"\n\n{line}"
    line, noted = _takeaway_after(ctx, cid, takeaway, cell) if cid else ("", False)
    if line:
        text += f"\n\n{line}"
    if not noted:
        text += _takeaway_missing(ctx, nb_id, cell)
    return ok(warn + text)


def _run_hint(cell: dict, kind: str) -> str:
    """What a run's result ends with after its output: the `## card-errored` or `## card-timeout` hint when the card
    errored, the `## kind-mismatch` hint when a clean output does not fit `kind`, else nothing."""
    if cell.get("status") == "error":
        return _error_hint(cell)
    shape = _kind_mismatch(kind, cell)
    line = hint("kind-mismatch", cid=str(cell.get("id") or ""), kind=kind, shape=shape) if shape else ""
    return f"\n\n{line}" if line else ""


def _remember_cell(ctx: Ctx, nb_id: str, cid: str) -> None:
    _last_cell[ctx.key] = cid
    _last_cell[(*ctx.key, nb_id)] = cid


def _add_data_cell(ctx: Ctx, nb_id: str, kind: str, title: str, payload: dict,
                   lines: "builtins.list[str]") -> ToolResult:
    """A new card with a payload and no code: stored and announced."""
    from . import notebook

    cell = notebook.insert_cell(ctx.c, nb_id, notebook.new_cell(kind, ctx.cell_author, title, nb_id, payload=payload))
    cid = str(cell["id"])
    _remember_cell(ctx, nb_id, cid)
    return ok(f"card:{cid}" + "".join(f"\n\n{line}" for line in lines))


def _edit_data_cell(ctx: Ctx, nb_id: str, cid: str, cell: dict, args: dict[str, Any], group: str,
                    place: "tuple[str, str | None] | None" = None, *, allow_empty: bool = False) -> ToolResult:
    """edit_card for a card that carries a payload and no code (a note, example, custom card, or a dataset-backed
    diagram or
    timeline): change its content and question in place; `code` points at add_card. `group` and `place` move it once
    the
    call is known to be good. `allow_empty`: the call also sets a takeaway."""
    from . import notebook

    kind = str(cell.get("kind") or notebook.DEFAULT_KIND)
    new_kind = str(args.get("kind") or "").strip().lower()
    if new_kind and new_kind != kind:
        return err(hint("edit_card-kind", cid=cid, kind=kind, new=new_kind))
    if str(args.get("code") or "").strip():
        return err(hint("edit_card-data", cid=cid, kind=kind, field=notebook.PAYLOAD_KEYS.get(kind, "content")))
    title = " ".join(str(args.get("question") or args.get("title") or "").split()) or None
    key = notebook.PAYLOAD_KEYS.get(kind)
    payload: dict | None = None
    if key in CONTENT_FIELDS and args.get(key) is not None:
        payload, problem = _payload_args(kind, args, "edit_card", ctx.c)
        if problem:
            return err(problem)
    lines: builtins.list[str] = []
    if group:
        nb_id = _move_to_group(ctx, cid, nb_id, group, lines)
    if place:
        _place(ctx, cid, place[0], place[1], lines)
        nb_id = place[0]
    if payload is None and title is None:
        if lines or allow_empty:  # the call only moved the card, or only sets its takeaway
            return ok(f"card:{cid}" + "".join(f"\n\n{line}" for line in lines))
        what = f"`code` that ends in {KIND_ENDINGS[kind]}" if kind in KIND_ENDINGS else f"its new `{key or 'content'}`"
        return err(f"edit_card: card:{cid} is of kind {kind}, so pass {what} or a new question")
    updated = notebook.edit_cell(ctx.c, cid, payload=payload, title=title, by=ctx.cell_author)
    _remember_cell(ctx, nb_id, cid)
    return ok(f"card:{cid}\n\n" + "\n".join(_payload_lines(kind, updated.get("payload") or {}))
              + "".join(f"\n\n{line}" for line in lines))


def _move_to_group(ctx: Ctx, cid: str, nb_id: str, group: str, lines: "builtins.list[str]") -> str:
    """edit_card's `group`: the card moved to the end of the group it names (made when missing, as add_card makes it),
    with a line for the result; the id of the group the card is in afterwards."""
    from . import notebook

    made: builtins.list[str] = []
    target = _group_id(ctx, group, made)
    lines.extend(f"made the group {t!r}" for t in made)
    if target != nb_id:
        notebook.move_cells(ctx.c, [cid], target)
        lines.append(f"moved to the group {group!r}")
    return target


def card_locked(ctx: Ctx, cid: str, cell: dict | None = None, *, tool: str = "edit_card") -> ToolResult | None:
    """The `## card-locked` refusal when the analyst locked card `cid`, else None. edit_card refuses every change to a
    locked
    card and delete_card refuses to delete it; each refusal is a `lock-refused` telemetry row."""
    from . import notebook, telemetry

    if cell is None:
        hit = notebook.find_cell(ctx.ws, cid)
        cell = hit[1] if hit else None
    if not cell or cell.get("locked") is not True:
        return None
    telemetry.note(ctx.c, "lock-refused", f"card:{cid}", actor="model", detail={"tool": tool})
    return err(hint("card-locked", cid=cid) or f"card:{cid} is locked")


FIRST = "first"  # edit_card's `after` for the top of the group


def _placement(ctx: Ctx, cid: str, raw: Any, group: str) -> tuple[str | None, str | None, str]:
    """edit_card's `after`, checked before anything changes: (the target group, the card it goes after or None for the
    top,
    the error line). A group named beside a card must be that card's, and is looked up, never made."""
    from . import notebook

    here = (notebook.find_cell(ctx.ws, cid) or ("", {}))[0]
    text = str(raw or "").strip().strip("[]").strip()
    if text.lower() == FIRST:
        return (_group_id(ctx, group, []) if group else here), None, ""
    other = _cell_id_of(text)
    if not other or other == cid:
        return None, None, hint("edit_card-after", cid=cid)
    hit = notebook.find_cell(ctx.ws, other)
    if hit is None:
        return None, None, hint("edit_card-gone", cid=other)
    named = _find_notebook(ctx.ws, group) if group else None
    if group and (named or {}).get("id") != hit[0]:
        return None, None, hint("edit_card-after-group", after=other)
    if session_kind(ctx.session) in FULL_TIME_SESSIONS and hit[0] != here:
        return None, None, hint("edit_card-after-group", after=other)
    return hit[0], other, ""


def _place(ctx: Ctx, cid: str, target: str, after: str | None, lines: "builtins.list[str]") -> None:
    """Move the card into its place in `target`'s column (notebook.move_cells, a reorder when it is the card's own group),
    with a line for the result, so a caller can reorder a group without rebuilding it card by card."""
    from . import notebook

    notebook.move_cells(ctx.c, [cid], target, after=after)
    lines.append(f"placed after card:{after}" if after else "placed first in its group")


def _takeaway_after(ctx: Ctx, cid: str, takeaway: str | None, cell: dict | None) -> tuple[str, bool]:
    """The line a change's result ends with for a takeaway given in the same call, checked against the new outputs, and
    whether it was stored. Over a run that errored or timed out it is not stored."""
    if takeaway is None:
        return "", False
    if cell is not None and cell.get("status") in ("error", "timeout"):
        return hint("edit_card-takeaway-errored"), False
    done, line = _takeaway_on(ctx, cid, takeaway)
    return line, done


async def _h_edit_card(ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    """Change a card that exists; it takes add_card's fields. `takeaway` alone sets the takeaway without a run; with a
    change,
    the change runs first and the takeaway is resolved against the new outputs. `group` moves the card and `after`
    places
    it. The card is `card`, else the thread's anchor, and for a takeaway alone from a browser chat the caller's last
    card."""
    from . import notebook

    raw_takeaway = args.get("takeaway")
    takeaway = str(raw_takeaway) if raw_takeaway is not None and str(raw_takeaway).strip() else None
    changes = any(str(args.get(k) or "").strip() for k in ("code", "question", "title", "kind", *CONTENT_FIELDS))
    given = changes
    card_arg = args.get("card") if args.get("card") not in (None, "") else args.get("cell")
    moves = bool(str(args.get("group") or "").strip() or str(args.get("after") or "").strip())
    if takeaway is not None and not changes and not moves:
        last = "" if ctx.terminal else _last_cell.get(ctx.key, "")  # see _last_cell: shared by the session's agents
        cid = _cell_id_of(card_arg) or str(ctx.anchor or "").strip() or last
        if not cid:
            return err(hint("edit_card-no-card"))
        if refused := card_locked(ctx, cid):
            return refused
        args, kept = _kept_by_check(ctx.c, cid, args)
        if args.get("takeaway") is None:
            return ok("\n\n".join([f"card:{cid}", *kept]))
        done, line = _takeaway_on(ctx, cid, str(args["takeaway"]))
        return ok("\n\n".join([line, *kept])) if done else err(line)
    kind = str(args.get("kind") or "").strip().lower() or None
    if kind is not None and kind not in EDIT_CELL_KINDS:
        return err(f"edit_card: `kind` must be one of {', '.join(EDIT_CELL_KINDS)}")
    title = " ".join(str(args.get("question") or args.get("title") or "").split()) or None
    cid = _cell_id_of(card_arg) or str(ctx.anchor or "").strip()
    if not cid:
        return err(hint("edit_card-no-card"))
    hit = notebook.find_cell(ctx.ws, cid)
    if hit is None:
        return err(hint("edit_card-gone", cid=cid))
    nb_id, cell = hit
    if refused := card_locked(ctx, cid, cell):
        return refused
    args, kept = _kept_by_check(ctx.c, cid, args)
    if kept:
        takeaway = str(args["takeaway"]) if str(args.get("takeaway") or "").strip() else None
        title = " ".join(str(args.get("question") or args.get("title") or "").split()) or None
        given = any(str(args.get(k) or "").strip() for k in ("code", "question", "title", "kind", *CONTENT_FIELDS))
        if not given and takeaway is None and not moves:
            return ok("\n\n".join([f"card:{cid}", *kept]))
    group = " ".join(str(args.get("group") or "").split())
    place: tuple[str, str | None] | None = None
    if str(args.get("after") or "").strip():
        target, after, problem = _placement(ctx, cid, args.get("after"), group)
        if problem:
            return err(problem)
        place, group = (target, after), ""  # `after` names the column, so `group` has nothing left to do
    # a dataset-backed diagram or timeline becomes a card of code when the call gives code (notebook.edit_and_run's
    # from_dataset)
    from_dataset = (not notebook.runnable(cell) and cell.get("kind") in KIND_ENDINGS
                    and bool(str(args.get("code") or "").strip()))
    if not notebook.runnable(cell) and not from_dataset:
        await _warm_view_refs(ctx.c, args)
        res = _edit_data_cell(ctx, nb_id, cid, cell, args, group, place, allow_empty=takeaway is not None or bool(kept))
        if res.is_error:
            return res
        tail = [*kept, *([_takeaway_after(ctx, cid, takeaway, None)[0]] if takeaway is not None else [])]
        return ok("\n\n".join([res.text, *tail])) if tail else res
    if kind is not None and kind not in RUN_KINDS:
        return err(hint("edit_card-kind", cid=cid, kind=cell.get("kind") or notebook.DEFAULT_KIND, new=kind))
    field = next((f for f in CONTENT_FIELDS if _given(args, f)), None)
    if field:  # a note's `text` or an example's `refs` on a card of code, which would be dropped and the code run again
        return err(hint("edit_card-kind", cid=cid, kind=cell.get("kind") or notebook.DEFAULT_KIND, new=FIELD_KINDS[field]))
    if problem := _card_installs(ctx, str(args.get("code") or ""), "edit_card"):
        return err(problem)
    # the card moves only once the call is known to be good, so a refused call leaves it where it was
    lines: builtins.list[str] = builtins.list(kept)
    if group:
        nb_id = _move_to_group(ctx, cid, nb_id, group, lines)
    if place:
        _place(ctx, cid, place[0], place[1], lines)
        nb_id = place[0]
    if (group or place) and not given:  # the call only moved the card, and maybe set its takeaway
        line, _ = _takeaway_after(ctx, cid, takeaway, None)
        return ok(f"card:{cid}\n\n" + "\n\n".join(lines + ([line] if line else [])))
    raw = args.get("code")
    code = str(raw) if raw is not None and str(raw).strip() else str(cell.get("code") or "")
    if not code.strip():
        return err("edit_card: the card has no code, so pass `code`")
    if cardrun.defers(ctx.c):  # terminal mode: the code runs through `thimble-run` in the caller's Bash
        await cardrun.ready_types(ctx.c, code)
        run = cardrun.run_record(cid, takeaway=takeaway, default_timeout_s=_default_timeout(ctx), session=ctx.session)
        cell = notebook.stage_edit(ctx.c, nb_id, cid, code, run, by=ctx.cell_author, title=title, kind=kind,
                                   from_dataset=from_dataset)
        _remember_cell(ctx, nb_id, cid)
        return ok(cardrun.waiting(ctx.c, cell, lines))
    cell = await notebook.edit_and_run(ctx.c, nb_id, cid, code, by=ctx.cell_author,
                                       default_timeout_s=_default_timeout(ctx), title=title, kind=kind,
                                       from_dataset=from_dataset)
    _remember_cell(ctx, nb_id, cid)
    text = _format_cell_result(cell, lines=result_lines(ctx.c))
    text += _run_hint(cell, str(cell.get("kind") or notebook.DEFAULT_KIND))
    for line in lines:
        text += f"\n\n{line}"
    line, noted = _takeaway_after(ctx, cid, takeaway, cell)
    if line:
        text += f"\n\n{line}"
    if not noted:
        text += _takeaway_missing(ctx, nb_id, cell)
    return ok(text)


def _same_part(field: str, a: Any, b: Any) -> bool:
    """Whether two values of a card's question, code or takeaway say the same: a question with its spaces collapsed,
    code up to trailing spaces and blank lines, a takeaway as its words read with its links' values in place."""
    from . import card_check, cite

    if field == "code":
        return card_check._lines(str(a or "")) == card_check._lines(str(b or ""))
    if field == "takeaway":
        return " ".join(cite._prose(str(a or "")).split()) == " ".join(cite._prose(str(b or "")).split())
    return " ".join(str(a or "").split()) == " ".join(str(b or "").split())


# a card's fields the card check fixes: (the field, the edit_card arguments that set it, its word in the hint)
CHECK_FIXED = (("title", ("question", "title"), "question"), ("code", ("code",), "code"),
               ("takeaway", ("takeaway",), "takeaway"))


def _kept_by_check(c: str, cid: str, args: dict[str, Any]) -> "tuple[dict[str, Any], builtins.list[str]]":
    """The call's fields as they apply to a card the card check has fixed, and a hint line for each field changed: a
    field
    equal to what the fix replaced is dropped (`## edit_card-check-kept`), and one that changes it is merged into the
    check's version (card_check.merge_edit, `## edit_card-check-merged`); anything else goes through as given."""
    from . import card_check, notebook

    cell = notebook.get_cell(c, cid) or {}
    fixes = [f for f in cell.get("fixes") or [] if isinstance(f, dict) and f.get("state") == "applied"]
    out, lines = dict(args), []
    for field, keys, word in CHECK_FIXED:
        fix = next((f for f in reversed(fixes) if field in (f.get("fields") or [])), None)
        key = next((k for k in keys if str(out.get(k) or "").strip()), None)
        if fix is None or key is None or not _same_part(field, cell.get(field), (fix.get("after") or {}).get(field)):
            continue
        before = (fix.get("before") or {}).get(field)
        if _same_part(field, out[key], cell.get(field)):
            continue
        if _same_part(field, out[key], before):
            for k in keys:
                out.pop(k, None)
            lines.append(hint("edit_card-check-kept", cid=cid, field=word))
        elif (merged := card_check.merge_edit(field, str(before or ""), str(cell.get(field) or ""), str(out[key]))) is not None:
            out[key] = merged
            lines.append(hint("edit_card-check-merged", cid=cid, field=word))
    return out, lines


CITE_CELL_RE = r"(?:card|cell):{cid}(?![A-Za-z0-9_-])"


def _citing_documents(c: str, cid: str) -> "builtins.list[str]":
    """The documents that cite card `cid`, as `report:<slug>`: a saved document or its frame of pinned figures under the
    main investigation that names `card:<cid>` (or `cell:<cid>`) anywhere, a citation or a figure."""
    from . import investigation

    pat = re.compile(CITE_CELL_RE.format(cid=re.escape(cid)))
    found: dict[str, None] = {}
    try:
        paths = sorted(investigation.inv_dir(c, investigation.MAIN).glob("*.json"))
    except OSError:
        return []
    for p in paths:
        if p.name == "investigation.json":
            continue
        try:
            if pat.search(p.read_text("utf-8")):
                found[f"report:{p.name.removesuffix('.json').removesuffix('.frame')}"] = None
        except OSError:
            continue
    return builtins.list(found)


async def _h_delete_card(ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    """Delete a card (notebook.delete_cell). A card a document cites is kept, with the `## delete_card-cited` line
    naming the
    documents. The caller's remembered last card is forgotten when it is the one deleted."""
    from . import notebook

    cid = _cell_id_of(args.get("card") if args.get("card") not in (None, "") else args.get("cell"))
    if not cid:
        return err(hint("edit_card-no-card"))
    hit = notebook.find_cell(ctx.ws, cid)
    if hit is None:
        return err(hint("edit_card-gone", cid=cid))
    if refused := card_locked(ctx, cid, hit[1], tool="delete_card"):
        return refused
    docs = _citing_documents(ctx.c, cid)
    if docs:
        return err(hint("delete_card-cited", cid=cid, docs=", ".join(docs)))
    question = " ".join(str(hit[1].get("title") or "").split()) or "(no question)"
    notebook.delete_cell(ctx.c, cid)
    for key in [k for k, v in _last_cell.items() if v == cid]:
        del _last_cell[key]
    return ok(hint("delete_card-deleted", cid=cid, question=question))


def _takeaway_missing(ctx: Ctx, nb_id: str, cell: dict) -> str:
    """What a run's result ends with when the card ran clean and has no takeaway: the `## takeaway-missing` line, since
    the agent that ran the card writes its takeaway, or `## takeaway-stale` when it kept one written before its outputs
    changed. An errored card gets the error's hint instead."""
    from . import notebook

    if cell.get("status") != "ok":
        return ""
    if str(cell.get("takeaway") or "").strip():
        line = hint("takeaway-stale", cid=str(cell.get("id") or "")) if cell.get(notebook.TAKEAWAY_STALE) else ""
    else:
        line = hint("takeaway-missing", cid=str(cell.get("id") or ""))
    return f"\n\n{line}" if line else ""


def _takeaway_on(ctx: Ctx, cid: str, raw: Any) -> tuple[bool, str]:
    """edit_card's takeaway for one card: the card must exist, then
    _attach_takeaway resolves its numbers against the card's complete outputs. Returns (attached, the line)."""
    from . import notebook

    cell = notebook.get_cell(ctx.c, cid, full_outputs=True)
    if cell is None:
        return False, hint("edit_card-gone", cid=cid) or f"takeaway: card:{cid} does not exist"
    return _attach_takeaway(ctx.c, cid, raw, cell)


def _attach_takeaway(c: str, cid: str, raw: Any, cell: dict | None, *, author: str = TAKEAWAY_AUTHOR) -> tuple[bool, str]:
    """Store a takeaway on a card with its numbers linked (cite.normalise_markup, qualify_bare_spans, quote_refs, and on
    a
    runnable card cite.resolve). Returns (attached, the line the model reads), naming the values that linked and,
    through
    `## not-found-in-outputs`, those the outputs do not show."""
    from . import cite, notebook

    text = re.sub(_SELF_REF_RE.format(cid=re.escape(cid)), "", str(raw or ""))
    text = cite.quote_refs(cell, cite.qualify_bare_spans(cid, cite.normalise_markup(text)))
    note = ""
    if cell and notebook.runnable(cell):
        resolved = cite.resolve(cid, text, cell.get("outputs"))
        text = resolved.annotated
        parts = []
        if resolved.links:
            parts.append("linked " + ", ".join(f"{l.token}→{l.ref.split(cid, 1)[-1] or l.ref}" for l in resolved.links[:8]))
        if resolved.unresolved:
            parts.append(hint("not-found-in-outputs", values=", ".join(resolved.unresolved[:10])))
        note = (" (" + "; ".join(p for p in parts if p) + ")") if parts else ""
    text = re.sub(r"\s+([,;:)]|\.(?!\w))", r"\1", text).strip()  # not before a period that starts a word (".yardopts", ".5")
    if not text:
        return False, "takeaway: `text` is empty"
    if not notebook.append_takeaway(c, cid, text, overwrite=True, author=author):
        return False, hint("edit_card-gone", cid=cid) or f"takeaway: card:{cid} does not exist"
    words = takeaway_words(text)
    if author == TAKEAWAY_AUTHOR and words > TAKEAWAY_WORDS:
        # the limit lives in this result line, where the model reads it as the rule applies
        note += "\n" + hint("takeaway-long", words=words)
    if author == TAKEAWAY_AUTHOR and (first := _uncited_example_ref(cell, text)):
        # an example's takeaway rests on its records, and the rule to cite them is read here as it applies, like the limit
        note += "\n" + hint("takeaway-uncited-example", ref=first)
    return True, f"takeaway noted on card:{cid}{note}"


def _uncited_example_ref(cell: dict | None, text: str) -> str:
    """The first record an example card shows, when its takeaway cites none of them (no `[[…]]` at all), else ''."""
    if not isinstance(cell, dict) or cell.get("kind") != "example" or "[[" in text:
        return ""
    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
    for r in payload.get("refs") or []:
        ref = r.get("ref") if isinstance(r, dict) else r
        if ref := str(ref or "").strip().strip("[]").strip():
            return ref
    return ""


def takeaway_words(text: str) -> int:
    """The words of a takeaway as the analyst reads it: a value-ref counts as its value, a bare ref as nothing."""
    plain = re.sub(r"\[\[([^\[\]|]*)\|[^\[\]]*\]\]", r"\1", text)
    return sum(1 for w in re.sub(r"\[\[[^\[\]]*\]\]", " ", plain).split() if re.search(r"\w", w))


def _payload_lines(kind: str, payload: dict) -> "builtins.list[str]":
    """A data card's payload as the model reads it."""
    if kind == "note":
        return ["text:", str(payload.get("text") or "")]
    if kind == "example":
        refs = payload.get("refs") or []
        return ["refs:", *(f"- {r}" for r in refs)] if refs else ["refs: (none)"]
    if kind == "label":
        return [f"label: concept:{payload.get('concept') or '?'}"]
    if kind == "custom":
        html = str(payload.get("html") or "")
        if len(html) > CELL_READ_LIMIT:
            html = html[:CELL_READ_LIMIT] + f"\n... [truncated, {len(html) - CELL_READ_LIMIT} more chars]"
        return ["html:", html]
    body = json.dumps(payload.get("dataset"), ensure_ascii=False, default=str)
    if len(body) > CELL_READ_LIMIT:
        body = body[:CELL_READ_LIMIT] + f"\n... [truncated, {len(body) - CELL_READ_LIMIT} more chars]"
    return ["dataset:", body]


async def _h_read_ref(ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    """Anything citable, by its ref: a card or span (_read_cell), `type:<name>`, a whole document (`report:<slug>`),
    `view:`
    refs, an orientation call (`call:<chat>/<n>`), and every other ref through refs.resolve (_read_excerpt). A
    value-ref
    reads its ref."""
    ref = str(args.get("ref") or "").strip().strip("[]").strip()
    if "|" in ref:  # a value-ref: the ref is the part after the bar
        ref = ref.split("|", 1)[1].strip()
    if not ref:
        return err("read_ref: `ref` is empty")
    if cite.is_card_ref(ref):
        return _read_cell(ctx, cite.canon(ref))
    if ref.startswith("type:"):
        return _read_type(ctx, ref[len("type:"):].strip())
    if ref.startswith("report:") and "#" not in ref:
        return await _delegate("app.report_types:tool_read_ref", ctx, {**args, "ref": ref})
    if ref.startswith("view:"):
        return await _delegate("app.views:tool_read_ref", ctx, {**args, "ref": ref})
    if ref.startswith("call:"):
        from . import calls  # noqa: PLC0415

        text, bad = calls.tool_read_ref(ctx.c, ref)
        return err(text) if bad else ok(text)
    return await _read_excerpt(ctx, ref)


def _read_cell(ctx: Ctx, ref: str) -> ToolResult:
    """A card whole: its group, kind, status, question, code, every addressed output up to CELL_READ_LIMIT chars (or a
    data
    card's payload), then its takeaway and labels; a span ref adds the value the span names."""
    from . import notebook, refs

    cid = _cell_id_of(ref)
    cell = notebook.get_cell(ctx.c, cid, full_outputs=True) if cid else None
    if cell is None:
        return err(f"read_ref: there is no card {cid or ref}")
    nb_id = str(cell.get("notebook") or "")
    kind = cell.get("kind", notebook.DEFAULT_KIND)
    run = notebook.runnable(cell)
    head = (f"card:{cid} (group {nb_id}, {kind}" + (f", status {cell.get('status', 'idle')}" if run else "")
            + (", locked" if cell.get("locked") is True else "") + ")")
    lines = [head, f"question: {str(cell.get('title') or '').strip() or '(untitled)'}"]
    if run:
        lines += ["code:", str(cell.get("code") or "").rstrip()]
        texts, extras = _outputs_text(cell, addressed=True)
        body = "\n".join(t for t in texts if t)
        if len(body) > CELL_READ_LIMIT:
            body = body[:CELL_READ_LIMIT] + f"\n... [truncated, {len(body) - CELL_READ_LIMIT} more chars]"
        lines += ["outputs:", body or "(no text output)"]
        if extras:
            lines.append(f"({', '.join(sorted(extras))} output rendered; thimble shows it)")
    else:
        lines += _payload_lines(kind, cell.get("payload") or {})
    if str(cell.get("takeaway") or "").strip():
        lines += ["takeaway:", str(cell["takeaway"]).strip()]
    if cell.get("labels"):
        lines.append("labels: " + ", ".join(f"concept:{l}" for l in cell["labels"]))
    if "#" in ref or "@out" in ref:
        try:
            res = refs.resolve(config.corpus_dir(ctx.c), ref)
            span = (res.get("meta") or {}).get("span")
            lines.append(f"span {ref}: {span.get('value', span.get('text'))}" if span else f"span {ref}: not in the current output")
        except refs.RefError as e:
            lines.append(f"span {ref}: {e.detail}")
    return ok(cite.canon_text("\n".join(lines)))


async def _read_excerpt(ctx: Ctx, ref: str) -> ToolResult:
    """The excerpt refs.resolve gives a reader of `ref`: a file, a line or a range, a record's block, a database row, a
    label, a passage of a document."""
    from . import refs

    try:
        res = await asyncio.to_thread(refs.resolve, config.corpus_dir(ctx.c), ref)
    except refs.RefError as e:
        return err(f"read_ref: {ref} does not resolve: {e.detail}")
    meta = res.get("meta") or {}
    lines = [f"{ref} ({res.get('kind', 'record')})"]
    if meta.get("span_missing"):
        lines.append("(the cited span is not in the card's current output; the whole card follows)")
    lines.append(str(res.get("excerpt") or "").strip() or "(empty)")
    return ok("\n".join(lines))


def _read_type(ctx: Ctx, name: str) -> ToolResult:
    """What a document type asks its writer for and the markdown it is saved in (report_types.type_form), the one text
    the writer agent reads for a type."""
    from . import report_types

    t = report_types.read_type(ctx.c, name) if name else None
    if t is None:
        names = ", ".join(x["slug"] for x in report_types.list_types(ctx.c))
        return err(f"read_ref: no document type {name!r}; the types are {names}")
    return ok(f"type:{t['slug']} ({t.get('name') or t['slug']}, {t.get('renderer')})\n{report_types.type_form(t).strip()}")


def _cell_line(cell: dict, filtered_out: bool = False) -> str:
    """One card on a list_cards line: its ref, kind (and status when it runs), question and the takeaway's first clause.
    `filtered_out` tags a card the canvas's filter leaves out."""
    from . import notebook

    kind = cell.get("kind", notebook.DEFAULT_KIND)
    tag = f"{kind}, {cell.get('status', 'idle')}" if notebook.runnable(cell) else kind
    if cell.get("locked") is True:  # the analyst's lock (card_locked), so a model sees it before it tries a change
        tag += ", locked"
    if filtered_out:
        tag += ", filtered out"
    title = str(cell.get("title") or "").strip()
    if not title and kind == "note":
        text = str((cell.get("payload") or {}).get("text") or "")
        title = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    line = f"- card:{cell.get('id')} [{tag}] {_first_clause(title) if title else '(untitled)'}"
    takeaway = cite.canon_text(str(cell.get("takeaway") or "").strip())
    if takeaway:
        line += f" — {_first_clause(takeaway)}"
    return line


async def _h_list_cards(ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    """The cards of the group `group` names, or of every group for `all`; a call without one is refused with the groups'
    names. While the canvas has a filter, the list starts with it and tags each card it leaves out."""
    from . import filters, notebook, threads

    which = " ".join(str(args.get("group") or "").split())
    rows = notebook.list_notebooks(ctx.ws, figures=False)
    names = ", ".join(f"{_group_name(rows, r)!r}" for r in rows) or "(none yet)"
    if not which:
        return err(f"list_cards: `group` is required, a group's title or id or all; the groups are {names}")
    if which.casefold() in ("all", "*"):
        targets = [notebook.read_notebook(ctx.ws, r["id"]) for r in rows]
    elif threads.THREAD_REF_RE.match(which) and threads.is_thread(ctx.c, which.split(":", 1)[1]):
        # a thread's event names its group as the thread, which has no group until its first card (threads.group_of)
        gid = threads.group_of(ctx.c, which, make=False)
        if gid is None:
            return ok(f"list_cards: the thread {which} has no cards yet")
        targets = [notebook.read_notebook(ctx.ws, gid)]
    else:
        row = _find_notebook(ctx.ws, which)
        if row is None:
            return err(f"list_cards: no group {which!r}; the groups are {names}")
        targets = [notebook.read_notebook(ctx.ws, row["id"])]
    out: builtins.list[str] = []
    view = await asyncio.to_thread(filters.canvas_view, ctx.c)
    kept, shown = (view["kept"], {x["id"] for x in view["cards"]}) if view else (None, set())
    if view:
        out += [hint("list_cards-filter", filter=filters.describe(ctx.c, view["entry"]), kept=len(kept), total=len(shown)), ""]
    for nb in targets:
        if not nb:
            continue
        cells = nb.get("cells") or []
        row = next((r for r in rows if r["id"] == nb["id"]), None)
        name = _group_name(rows, row) if row is not None else nb.get("title") or nb["id"]
        out.append(f'Group "{name}" ({nb["id"]}, {nb.get("role", "analyst")}, {len(cells)} card{"" if len(cells) == 1 else "s"})')
        out.extend(_cell_line(cell, kept is not None and cell.get("id") in shown and cell.get("id") not in kept) for cell in cells)
        out.append("")
    return ok("\n".join(out).rstrip() or "(no groups yet)")


def holdings(c: str) -> dict[str, Any]:
    """What a workspace holds, for /thimble's resume line: the cards, labels, documents written and chats someone wrote
    in;
    `text` names the first three."""
    from . import agents, concepts, investigation, notebook, report_types

    ws = config.workspace_path(c)  # a read: validated, never created (report_types is asked only for a dir that exists)
    cards = sum(int(r.get("n_cells") or 0) for r in notebook.list_notebooks(ws, figures=False))
    labels = len(concepts.list_concepts(ws, trials=False))
    docs = [t["slug"] for t in (report_types.list_types(c) if ws.is_dir() else [])
            if report_types.doc_file(c, investigation.MAIN, t["slug"]).is_file()]
    return {"workspace": c, "cards": cards, "labels": labels, "documents": docs, "chats": agents.held_chats(ws),
            "text": ", ".join([_count("card", cards), _count("label", labels), _docs_phrase(docs)])}


def _count(noun: str, n: int) -> str:
    if n == 0:
        return f"no {noun}s"
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _docs_phrase(docs: "builtins.list[str]") -> str:
    if not docs:
        return "no documents"
    if len(docs) == 1:
        return f"document {docs[0]}"
    return "documents " + ", ".join(docs[:-1]) + f" and {docs[-1]}"


def instructions() -> str:
    """The MCP server instructions the shim carries: the `## instructions` section of prompts/tools.md, a short pointer
    (Claude Code cuts server instructions at 2 KB)."""
    return hint(INSTRUCTIONS_HINT).strip()


# --------------------------------------------------------------------------- handlers: labels


def _label_list(labels: Any) -> "builtins.list[str] | None":
    if labels is None or labels == "" or labels == []:
        return None
    if isinstance(labels, str):
        labels = [labels]
    if not isinstance(labels, builtins.list):
        raise ValueError("`labels` must be a list of strings, positive label first")
    out: builtins.list[str] = []
    for l in labels:
        s = " ".join(str(l or "").split())
        if s and s not in out:
            out.append(s)
    if len(out) < 2:
        raise ValueError("`labels` needs at least two distinct values (positive label first), or omit it for yes/no")
    return out


# --------------------------------------------------------------------------- handlers: the owning modules' tools


def _as_result(value: Any) -> ToolResult:
    """What a tool function returned, as a ToolResult: a ToolResult as it is, its text as an ok result."""
    return value if isinstance(value, ToolResult) else ok(str(value or ""))


async def _delegate(path: str, ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    """Run a tool function of another module (`module:attr`, module note), for a case of a tool that module owns."""
    return _as_result(await _maybe_await(_resolve(path)(ctx, args)))


def _image(data: str, mime: str, caption: str) -> ToolResult:
    return ToolResult([{"type": "text", "text": caption}, {"type": "image", "data": data, "mimeType": mime}])


async def _h_screenshot(ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    """An image of what the analyst sees, by ref: a page of thimble's interface on this machine (_shot_page), a card
    (_shot_card), and the view, document and thread modules' cases."""
    ref = str(args.get("ref") or "").strip().strip("[]").strip()
    if not ref:
        return err("screenshot: `ref` is empty")
    from . import local  # noqa: PLC0415

    if local.terminal(ctx.c) and not cite.is_card_ref(ref):  # terminal mode has no page to shoot: a card alone
        return err(hint("screenshot-terminal") or f"screenshot: {headless.NO_SCREENSHOTS} in terminal mode")
    if urlsplit(ref).scheme in ("http", "https"):
        return await _shot_page(ref, str(args.get("selector") or "").strip() or None)
    if cite.is_card_ref(ref):
        return await _shot_card(ctx, cite.canon(ref))
    if ref.startswith("view:"):
        return await _delegate("app.views:tool_screenshot", ctx, {**args, "ref": ref})
    if ref.startswith("report:"):
        return await _delegate("app.report_types:tool_screenshot", ctx, {**args, "ref": ref})
    from . import views

    if await asyncio.to_thread(views.opening_view, ctx.c, ref):
        return await _delegate("app.views:tool_screenshot", ctx, {**args, "ref": ref})
    return await _delegate("app.threads:tool_screenshot", ctx, {**args, "ref": ref})


def shot_ports() -> set[int]:
    """The ports a page screenshot may reach: this server's (THIMBLE_PORT, else 8300) and, in dev mode, the Vite
    server's that serves its interface (ui_base)."""
    import os

    port = os.environ.get("THIMBLE_PORT", "").strip()
    ports = {int(port) if port.isdigit() else 8300}
    ui = ui_base()
    with contextlib.suppress(ValueError):
        if ui and urlsplit(ui).port:
            ports.add(int(urlsplit(ui).port))  # type: ignore[arg-type]
    return ports


async def _shot_page(url: str, selector: str | None) -> ToolResult:
    """A page of the thimble interface, headless (dev.run_shot), only on this machine (SCREENSHOT_HOSTS) and on this
    server's own port or its interface's (shot_ports). The browser loads the address rebuilt from what was checked, and
    one with a backslash or a user part is refused, since Chromium reads those hosts differently from Python."""
    parts = urlsplit(url)
    try:
        port = parts.port
    except ValueError:
        port = None
    allowed = shot_ports()
    host = parts.hostname or ""
    if (host not in SCREENSHOT_HOSTS or port not in allowed or parts.scheme not in ("http", "https") or "\\" in url
            or "@" in parts.netloc):
        return err(f"screenshot: an http address must be thimble's own interface on this machine (port "
                   f"{', '.join(str(p) for p in sorted(allowed))})")
    url = urlunsplit((parts.scheme, f"[{host}]:{port}" if ":" in host else f"{host}:{port}", parts.path, parts.query,
                      parts.fragment))
    run_shot = _optional("dev", "run_shot")
    if run_shot is None:
        return _not_available("screenshot", "dev", "run_shot")
    with tempfile.TemporaryDirectory(prefix="thimble-shot-") as d:
        out = Path(d) / "shot.png"
        try:
            code = await _maybe_await(run_shot(url, out, selector))
        except headless.Missing:
            return err(headless.NO_SCREENSHOTS)
        if not out.is_file():
            return err(f"screenshot failed (exit {code}): no image was written for {url}")
        data = base64.b64encode(out.read_bytes()).decode("ascii")
    note = "" if code == 0 else " (the selector was not found; this is the whole viewport)" if code == 2 else f" (exit {code})"
    return _image(data, "image/png", f"screenshot of {url}" + (f" [{selector}]" if selector else "") + note)


async def _shot_card(ctx: Ctx, ref: str) -> ToolResult:
    """A card's picture as the analyst sees it: the workspace's page opened at the card and the card shot in it
    (_shot_card_in_ui). When no interface can be reached or the page did not show the card, the output alone stands
    in: its
    raster image, SVG figure or Vega-Lite chart (_shot_page_file), else the `## screenshot-none` line."""
    from . import notebook

    cid = _cell_id_of(ref)
    cell = notebook.get_cell(ctx.c, cid, full_outputs=True) if cid else None
    if cell is None:
        return err(f"screenshot: there is no card {cid or ref}")
    from . import local  # noqa: PLC0415 — imported above too: _shot_card is also reached on its own

    if local.terminal(ctx.c):  # no page to open in terminal mode: the card harness draws the card offscreen
        return await _shot_card_offscreen(ctx, cid, cell)
    if any(CARD_MIME in b for _, b in cite.iter_outputs(cell.get("outputs"))):
        return await _shot_type_card(ctx, cid, cell)
    ui = ui_base()
    if ui:
        shot = await _shot_card_in_ui(ctx.c, cid, ui)
        if shot is not None:
            return shot
    kind = str(cell.get("kind") or notebook.DEFAULT_KIND)
    if kind in ("diagram", "timeline") and isinstance(cell.get("payload"), dict):
        # the canvas draws these from their dataset; there is no raster to grab here, and the result says so, since
        # "shows none" would read as a blank card
        return err(hint("screenshot-none", what=f"card:{cid}, the {kind} card, is drawn by the canvas from its dataset"))
    if not notebook.runnable(cell):
        # an example, a note, a label or a custom card is drawn by the canvas from what it holds, and "shows none" would
        # read as a blank card
        return err(hint("screenshot-none", what=f"card:{cid}, the {kind} card, is drawn by the canvas from its "
                                                f"{notebook.PAYLOAD_KEYS.get(kind, 'content')}"))
    drawn = next((DRAWING_MIMES[m] for _, b in cite.iter_outputs(cell.get("outputs")) for m in b if m in DRAWING_MIMES), None)
    if drawn:
        # the canvas lays out what the code handed thimble.diagram or thimble.timeline; there is no raster here
        return err(hint("screenshot-none", what=f"card:{cid}, the {kind} card, is drawn by the canvas from its code's "
                                                f"thimble.{drawn}(…)"))
    for _, b in cite.iter_outputs(cell.get("outputs")):
        for mime in ("image/png", "image/jpeg"):
            raw = b.get(mime)
            if raw:
                data = "".join(raw) if isinstance(raw, builtins.list) else str(raw)
                return _image(data.replace("\n", ""), mime, f"screenshot of card:{cid}")
        svg = b.get("image/svg+xml")
        if svg:
            return await _shot_svg(cid, "".join(svg) if isinstance(svg, builtins.list) else str(svg))
    spec = cite.chart_spec(next((b for _, b in cite.iter_outputs(cell.get("outputs")) if cite.chart_spec(b)), None))
    if spec is None:
        return err(hint("screenshot-none", what=f"card:{cid} shows {_output_shape(cell)}"))
    if not all(p.is_file() for p in VEGA_BUILDS):
        return err(headless.NO_SCREENSHOTS)
    return await _shot_page_file(cid, chart_page(spec))


async def _shot_card_offscreen(ctx: Ctx, cid: str, cell: dict) -> ToolResult:
    """A card drawn by the card harness (render.py, the card check's drawing) in headless Chromium with the built page,
    as terminal mode's screenshot; the `## screenshot-terminal` line when the harness cannot draw here."""
    from . import render  # noqa: PLC0415

    try:
        shot = await render.render_card(ctx.c, cell)
    except render.Unavailable as e:
        log.info("screenshot: card:%s not drawn in terminal mode: %s", cid, e)
        return err(hint("screenshot-terminal") or f"screenshot: {headless.NO_SCREENSHOTS} ({e})")
    if not shot.ok or shot.png is None:
        return err(hint("screenshot-terminal") or f"screenshot: card:{cid} was not drawn ({shot.error or 'no picture'})")
    return _image(base64.b64encode(shot.png).decode("ascii"), "image/png", f"screenshot of card:{cid}")


async def _shot_type_card(ctx: Ctx, cid: str, cell: dict) -> ToolResult:
    """A card of a card type drawn by the card harness (render.py) from the data the card stored, as the card check
    sees it."""
    from . import render

    try:
        res = await render.render_card(ctx.c, cell)
    except render.Unavailable as e:
        return err(f"screenshot: card:{cid} is drawn in the browser, and the card harness is off here: {e}")
    if not res.ok:
        return err(f"screenshot: card:{cid} did not render: {res.error}")
    return _image(base64.b64encode(res.png).decode("ascii"), "image/png", f"screenshot of card:{cid}")


# The page a card is shot in: 1280 px wide at device scale 2, tall enough for the tallest cards, with the chat closed
# and the canvas at 100%.
CARD_SHOT_VIEWPORT = "1280x2400"
CARD_SHOT_SCALE = 2
# after the page is quiet: the card opened by `?ref=` flashes for 1.6 s (Canvas.flashCard), and charts settle
CARD_SHOT_WAIT_MS = 2200


def ui_base() -> str | None:
    """The address of thimble's interface on this machine: the Vite server in dev mode (THIMBLE_FRONTEND_URL), else this
    server when it serves the built UI (THIMBLE_PORT); None when neither is known."""
    import os

    if os.environ.get("THIMBLE_DEV", "").strip().lower() in ("1", "true", "yes", "on"):  # main.dev_mode's rule
        url = os.environ.get("THIMBLE_FRONTEND_URL", "").strip().rstrip("/")
        return url or None
    port = os.environ.get("THIMBLE_PORT", "").strip()
    built = (Path(config.FRONTEND_DIST) / "index.html").is_file()  # main.frontend_dist: the UI this server serves at /
    return f"http://127.0.0.1:{port}" if port.isdigit() and built else None


async def _shot_card_in_ui(c: str, cid: str, ui: str) -> ToolResult | None:
    """The card shot in the workspace's page opened at `?ref=card:<id>` in a headless browser (dev.run_shot), canvas at
    100%
    with the chat closed. None when the page could not be shot or did not show the card, so the caller falls back."""
    from urllib.parse import urlencode

    run_shot = _optional("dev", "run_shot")
    if run_shot is None or headless.missing(headless.PAGES):
        return None
    url = f"{ui}/?{urlencode({'ws': c, 'ref': f'card:{cid}'})}"
    storage = {f"thimble:{c}:layout": json.dumps({"tab": "canvas", "chatOpen": False}),
               f"thimble:{c}:canvas-view": json.dumps({"x": 0, "y": 0, "scale": 1})}
    with tempfile.TemporaryDirectory(prefix="thimble-shot-") as d:
        png = Path(d) / "card.png"
        try:
            code = await _maybe_await(run_shot(url, png, f'article.canvas-card[data-cell="{cid}"]', viewport=CARD_SHOT_VIEWPORT,
                                               scale=CARD_SHOT_SCALE, storage=storage, press=["Escape"],
                                               wait_ms=CARD_SHOT_WAIT_MS))
        except headless.Missing:
            return None
        except Exception:  # noqa: BLE001 — a missing node is the fallback's case, not an error to the model
            log.warning("card shot in the interface failed for card:%s", cid, exc_info=True)
            return None
        if code != 0 or not png.is_file():
            return None
        data = base64.b64encode(png.read_bytes()).decode("ascii")
    return _image(data, "image/png", f"screenshot of card:{cid}")


def _inline_script(js: str) -> str:
    """Script text that cannot end its <script> element early."""
    return js.replace("</script", "<\\/script").replace("</SCRIPT", "<\\/SCRIPT")


def figure_page(inner: str) -> str:
    """The page a card's figure is shot on: `inner`, a document of its own, in a frame sandboxed to scripts alone under
    SHOT_PAGE_CSP, which takes the size the figure reports (`{w, h}` posted to its parent)."""
    import html as html_mod  # noqa: PLC0415

    size = ("addEventListener('message', (e) => { const f = document.getElementById('fig'); const d = e.data || {}; "
            "if (e.source === f.contentWindow && d.w > 0 && d.h > 0) { f.style.width = d.w + 'px'; "
            "f.style.height = d.h + 'px' } })")
    return (f"<!doctype html><html><head><meta http-equiv='Content-Security-Policy' content=\"{SHOT_PAGE_CSP}\">"
            f"<script>{size}</script></head><body style='margin:0;background:#fff'>"
            f"<iframe id='fig' sandbox='allow-scripts' style='border:0;display:block;width:1200px;height:900px' "
            f"srcdoc=\"{html_mod.escape(inner, quote=True)}\"></iframe></body></html>")


# the figure's frame reports the size of what it drew, so the shot is of the figure alone
_REPORT_SIZE = ("const r = document.getElementById('vis').getBoundingClientRect(); "
                "parent.postMessage({w: Math.ceil(r.right), h: Math.ceil(r.bottom)}, '*')")


def chart_page(spec: dict[str, Any]) -> str:
    """A Vega or Vega-Lite chart's page (figure_page): the spec as data, never as markup, without the embed options
    it may carry, drawn by the frontend's vega, vega-lite and vega-embed builds inlined."""
    meta = spec.get("usermeta")
    if isinstance(meta, dict) and "embedOptions" in meta:
        spec = {**spec, "usermeta": {k: v for k, v in meta.items() if k != "embedOptions"}}
    data = json.dumps(spec).replace("<", "\\u003c")
    scripts = "".join(f"<script>{_inline_script(p.read_text('utf-8'))}</script>" for p in VEGA_BUILDS)
    body = (f"<div id='vis' style='display:inline-block'></div><script>vegaEmbed('#vis', {data}, "
            f"{{renderer: 'svg', actions: false}}).then(() => {{ {_REPORT_SIZE} }})"
            ".catch(e => document.body.append(String(e)))</script>")
    return figure_page(f"<!doctype html><html><head>{scripts}</head><body style='margin:0;background:#fff'>{body}"
                       "</body></html>")


def svg_page(svg: str) -> str:
    """An SVG figure's page (figure_page): the figure as an image, which runs no script and loads nothing."""
    src = "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return figure_page(f"<!doctype html><html><body style='margin:0;background:#fff'><img id='vis' src='{src}' "
                       f"style='display:block' onload=\"{_REPORT_SIZE}\"></body></html>")


async def _shot_svg(cid: str, svg: str) -> ToolResult:
    """An SVG figure as a PNG, since a model reads raster images only: the figure alone on a white page."""
    return await _shot_page_file(cid, svg_page(svg))


FIGURE_SHOT_WAIT_MS = 800  # after the page is quiet: the frame draws the figure and takes its size


async def _shot_page_file(cid: str, page_html: str) -> ToolResult:
    """A card's figure drawn on a page of its own (figure_page) in a temporary file and shot by its frame
    (dev.run_shot, the headless Chromium the ticket runner's page shots use), with every request refused."""
    run_shot = _optional("dev", "run_shot")
    if run_shot is None:
        return _not_available("screenshot", "dev", "run_shot")
    with tempfile.TemporaryDirectory(prefix="thimble-shot-") as d:
        page, png = Path(d) / "card.html", Path(d) / "card.png"
        page.write_text(page_html, "utf-8")
        try:
            code = await _maybe_await(run_shot(page.as_uri(), png, "#fig", offline=True, wait_ms=FIGURE_SHOT_WAIT_MS))
        except headless.Missing:
            return err(headless.NO_SCREENSHOTS)
        if not png.is_file() or code not in (0, None):
            return err(f"screenshot: card:{cid}'s figure did not render (exit {code})")
        data = base64.b64encode(png.read_bytes()).decode("ascii")
    return _image(data, "image/png", f"screenshot of card:{cid}")


def _chip(c: str, kind: str, text: str, **fields: Any) -> None:
    """An act with no reply lands in main as a chip (agents.chip); never raises into a tool result."""
    try:
        from . import agents  # noqa: PLC0415

        agents.chip(c, kind, text, **fields)
    except Exception:  # noqa: BLE001
        log.debug("chip not written", exc_info=True)


async def _h_apply_label(ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    """Define a category and apply it over one scope's units (concepts.apply_scoped): the label is a card (in `group` or
    default_group's pick) and, when `filter` is true, the scope's filter. The orientation's labels get no card. A
    changed
    label names the cards that read it before (`## apply_label-stale`)."""
    from . import concepts

    scope = str(args.get("scope") or "files").strip().lower()
    name = " ".join(str(args.get("name") or "").split())
    pred = args.get("predicate") if isinstance(args.get("predicate"), dict) else {}
    kind = str(pred.get("kind") or "prompt").strip().lower()
    text = str(pred.get("text") or "").strip()
    if scope not in LABEL_SCOPES:
        return err(f"apply_label: `scope` must be one of {', '.join(LABEL_SCOPES)}")
    if not name:
        return err("apply_label: `name` is required")
    if kind not in LABEL_KINDS:
        return err(f"apply_label: predicate.kind must be one of {', '.join(LABEL_KINDS)}")
    if not text:
        return err("apply_label: predicate.text is required (the description, the pattern or the function)")
    values = _label_list(args.get("values"))
    paths = args.get("paths")
    if isinstance(paths, str):
        paths = [paths]
    paths = [str(p).strip() for p in (paths or []) if str(p).strip()] if isinstance(paths, builtins.list) else []
    if scope == "files" and not paths:
        paths = ["**/*"]
    limit: int | None = None
    if args.get("limit") is not None and str(args.get("limit")).strip():
        try:
            limit = max(1, int(args["limit"]))
        except (TypeError, ValueError):
            return err("apply_label: `limit` must be an integer")
    # a label is one scope's: the same name over another scope would redefine it there and drop its rows, such as the
    # analyst's label over files when a chat labels cards after it
    prior = concepts.find_concept(ctx.ws, name)
    if prior is not None and concepts.SCOPE_OF_UNIT.get(prior["unit"]) != scope:
        return err(hint("apply_label-other-scope", label=prior["name"], ref=f"concept:{prior['id']}",
                        scope=concepts.SCOPE_OF_UNIT.get(prior["unit"]), new=scope))
    orienting = session_kind(ctx.session) == ORIENT_SESSION
    group = str(args.get("group") or "").strip()
    target = None if orienting else _group_id(ctx, group, []) if group else default_group(ctx)
    if target:
        _note_group(ctx, target)
    question = " ".join(str(args.get("question") or "").split()) or None
    within = args.get("within") or None
    if isinstance(within, str):
        within = {"label": within}
    defer = kind == "code" and cardrun.defers(ctx.c)  # terminal mode: the code runs through `thimble-run label`
    s = await concepts.apply_scoped(ctx.c, scope=scope, name=name, kind=kind, text=text, values=values, paths=paths, limit=limit,
                                    comment=bool(args.get("comment")), filter=bool(args.get("filter")),
                                    created_by=ctx.created_by, chat=ctx.chat, group=target, question=question,
                                    card=not orienting, within=within, show=bool(args.get("show")), defer=defer)
    if s.get("deferred"):
        concepts.set_pending_run(ctx.c, str(s["concept"]), dict(args), ctx.session)
        cmd = cardrun.command("label", str(s["concept"]))
        cardrun.mirror(ctx.c)
        line = (f"defined label {s.get('name', name)} [[concept:{s.get('concept')}]]"
                f"{' over ' + ', '.join(paths) if scope == 'files' else ''}. "
                + (hint("label-run", command=cmd) or f"Run with Bash: {cmd}"))
        if s.get("cell"):
            line += f" The label's card is [[card:{s['cell']}]]."
        return ok(line)
    if s.get("partial") and not orienting and ctx.session is None:
        concepts.tell_when_done(ctx.c, str(s["concept"]))
    counts = ", ".join(f"{k} {v}" for k, v in sorted((s.get("counts") or {}).items()))
    unit = UNIT_WORDS.get(str(s.get("unit") or ""), s.get("unit") or "unit")
    line = (f"applied label {s.get('name', name)} [[concept:{s.get('concept')}]] over {s.get('total', 0)} {unit}(s)"
            f"{' in ' + ', '.join(paths) if scope == 'files' else ''}{' within ' + within['label'] if within else ''}: "
            f"{counts or 'no values yet'}.")
    if s.get("failed"):
        line += f" {s['failed']} {unit}(s) failed: {s.get('message') or 'no reason given'}."
    values = (concepts.find_concept(ctx.ws, s["concept"]) or {}).get("labels") or [None]
    if kind != "prompt" and s.get("unit") == "record" and not s.get("partial") and (s.get("counts") or {}).get(values[0]):
        shown = await asyncio.to_thread(concepts.examples, ctx.c, s["concept"], values[0])
        if shown:
            line += f" Some it gave {values[0]!r}: " + "; ".join(f"{ref} “{text}”" for ref, text in shown) + "."
    elif kind == "prompt" and s.get("unit") == "record" and args.get("comment"):
        said = await asyncio.to_thread(concepts.reasons, ctx.c, s["concept"], values)
        if said:
            line += " Reasons it gave so far: " + " | ".join(
                f"{v}: " + "; ".join(f"{ref} “{why}”" for ref, why in rs) for v, rs in said.items()) + "."
    if s.get("unchanged"):
        line += " " + hint("apply_label-unchanged")
    if s.get("partial"):
        line += (" The run goes on in the background, and a label_done event comes when it finishes."
                 if not orienting and ctx.session is None else
                 " The run goes on in the background; the counts are final when its card stops spinning.")
    if s.get("cell"):
        line += f" The label's card is [[card:{s['cell']}]]."
    if s.get("stale") and cardrun.defers(ctx.c):  # terminal mode: those cards run again through `thimble-run stale`
        line += " " + concepts.stale_note(ctx.c, [{"id": x} for x in s["stale"]])
    elif s.get("stale"):
        line += " " + hint("apply_label-stale", cards=", ".join(f"[[card:{x}]]" for x in s["stale"]))
    if s.get("filter"):
        line += f" It is the {scope} filter now."
    elif args.get("show") and scope == "files":
        line += " It is on in Files and the views."
    if scope == "files" and s.get("labels_path"):
        # the rows a card reads: thimble.labels(name) holds only the first value's units (kernel_thimble.labels), not
        # one row per labeled unit, and the hint says so
        line += " " + hint("apply_label-rows", label=s.get("name", name))
    if s.get("cell") and not s.get("partial"):
        # the counts are final, so the label's card is asked for its finding, as a card of code is once it ran clean
        # (_takeaway_missing)
        from . import notebook

        card = notebook.get_cell(ctx.c, str(s["cell"])) or {}
        if not str(card.get("takeaway") or "").strip():
            line += _takeaway_missing(ctx, target, {**card, "status": "ok"})
        elif prior is not None and not s.get("unchanged"):
            line += " " + hint("apply_label-takeaway-stale", cid=str(s["cell"]))
    return ok(line)


async def _h_show_label(ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    """Turn a label over files on or off in Files and the views (concepts.show_concept), like the Labels pane's toggle;
    it
    runs nothing. `values` sets which values are highlighted while it is on."""
    from . import concepts

    name = " ".join(str(args.get("name") or "").split())
    if not name:
        return err("show_label: `name` is required, the label's name or id")
    on = args.get("on")
    if isinstance(on, str) and on.strip().lower() in ("true", "false"):
        on = on.strip().lower() == "true"
    colours = args.get("colours") if isinstance(args.get("colours"), dict) else None
    if not isinstance(on, bool) and not (on is None and colours):
        return err("show_label: `on` is required, true or false, unless it gives `colours`")
    values = args.get("values")
    values = [values] if isinstance(values, str) else values if isinstance(values, builtins.list) else None
    k = concepts.find_concept(ctx.ws, name)
    if k is not None and k["unit"] not in concepts.FILE_UNITS:
        where = concepts.SCOPE_OF_UNIT[k["unit"]]
        return err(hint("show_label-not-files", label=k["name"], units=f"{UNIT_WORDS.get(k['unit'], k['unit'])}s",
                        where="the canvas" if where == "canvas" else "the report"))
    was = bool(k["shown"]) if k is not None else None
    k = await asyncio.to_thread(concepts.show_concept, ctx.c, name, on, values, colours)
    from . import local  # noqa: PLC0415

    local.ui_note(ctx.c, "label", {"label": k["id"], "name": k["name"], "on": bool(k["shown"]),
                                   "highlight": [cl["name"] for cl in k["classes"] if cl.get("highlight")],
                                   **({"colours": colours} if colours else {})})
    ref = f"[[concept:{k['id']}]]"
    if on is None:
        painted = ", ".join(f"{v} {n}" for v, n in colours.items())
        return ok(f"label {k['name']} {ref} colours {painted}; it is {'on' if k['shown'] else 'off'} in Files and the views.")
    # what it was before, since the analyst may have turned it on or off in Files since the chat last did
    now = f"{'on' if on else 'off'} in Files and the views"
    state = f"was {'on' if was else 'off'} and is now {now}" if was is not None and was != on else f"is {now}, as it was"
    if not on:
        return ok(f"label {k['name']} {ref} {state}.")
    lit = [cl["name"] for cl in k["classes"] if cl["highlight"]]
    return ok(f"label {k['name']} {ref} {state}, highlighting {', '.join(lit) or 'none of its values'}.")


async def _h_propose_view(ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    """A proposal for a view written for how the corpus arranges its records, which a `thimble:view-builder` builds at
    once (views.propose, dev.start_build) from its fields (views.SPEC_FIELDS), on the model and effort the call names,
    else Settings' dev row. The orientation's proposals are built as follow-on starts of its own start, and held until
    their views pass their checks, so each reaches the analyst as soon as it works. A viewer of unusual file types the
    orientation proposes (views.offered_type_viewer) is stored `suggested`, offered in the File browser and built once
    the analyst accepts it. A claim that matches no corpus file is refused, naming real paths near it; where views
    cannot be built the proposal fails at once. A proposal from main's shim is one the analyst asked for: its result is
    the exact Agent call that starts its builder, which main makes (`## start_job-subagent`), and the browser opens the
    view once built."""
    from . import views

    claims = args.get("claims")
    if isinstance(claims, str):
        claims = views._fold(claims)
    spec = views.clean_spec(args)
    given = {"name": args.get("name"), "why": args.get("why"), "claims": claims, **spec}
    for k in ("name", "why", "claims", *(k for k, _ in views.SPEC_FIELDS)):
        v = given.get(k)
        if not v or (isinstance(v, str) and not v.strip()):
            return err(f"propose_view: `{k}` is required")
    unmatched = await asyncio.to_thread(views.unmatched_claims, ctx.c, claims)
    if unmatched:
        near = " ".join(hint("propose_view-near", claim=g, paths=", ".join(p)) for g, p in unmatched.items() if p)
        return err(" ".join(hint("propose_view-unmatched", claims=", ".join(unmatched), near=near).split()))
    orient = session_kind(ctx.session) == ORIENT_SESSION
    typed = ctx.session is None  # main's own call: the build is main's Agent call
    values = {k: str(args[k]) for k in ("model", "effort") if args.get(k)}
    if typed:
        from . import subagents  # noqa: PLC0415

        if (before := subagents.refusal_before(ctx.c)) is not None:
            return err(before.reason or f"propose_view: {before.kind}")
    prop = await _maybe_await(views.propose(ctx.c, name=str(args["name"]).strip(), why=str(args["why"]).strip(),
                                            claims=claims, arrangement="", proposed_by=ctx.created_by,
                                            orientation=orient, asked=typed,
                                            suggested=orient and views.offered_type_viewer(claims), spec=spec,
                                            route=views.TYPED if typed else None, values=values or None))
    status = str(prop.get("status") or "queued")
    if not prop.get("held"):
        _chip(ctx.c, "view", str(prop.get("name") or prop.get("slug")), ref=f"view:{prop.get('slug')}", status=status)
    claimed = ", ".join(prop.get("claims") or [])
    if status == "suggested":
        return ok(hint("propose_view-suggested", view=prop.get("name"), slug=prop.get("slug"), claims=claimed))
    # without Node 20+ or the frontend's packages the build fails at once (dev.start_build), and main is told why
    if why := await asyncio.to_thread(views.build_problem):
        if typed:
            views.update_proposal(ctx.c, str(prop["slug"]), status="failed", error=why)
        return ok(hint("propose_view-cannot-build", view=prop.get("name"), slug=prop.get("slug"), why=why))
    if typed:
        return await _typed_build(ctx, str(prop["slug"]), values)
    if prop.get("revised") and not prop.get("held"):  # a view built under this name is changed in place (views.revise)
        return ok(hint("view-changing", view=prop.get("name"), slug=prop.get("slug")))
    return ok(hint("propose_view-proposed", view=prop.get("name"), slug=prop.get("slug"), claims=claimed))


async def _typed_build(ctx: Ctx, slug: str, values: dict[str, str] | None = None) -> ToolResult:
    """The build of the view `slug` main asked for: its pending start and the exact Agent call main makes
    (`## start_job-subagent`), or the refusal (dev.start_build)."""
    from . import dev  # noqa: PLC0415

    ans = await dev.start_build(ctx.c, slug, "typed", values or None, call=ctx.tool_use_id)
    if ans.get("program"):
        return ok(hint("view-changing", view=slug, slug=slug))
    if ans.refused or "input" not in ans:
        return err(ans.reason or f"propose_view: {ans.kind}")
    return ok(hint("start_job-subagent", input=json.dumps(ans["input"], ensure_ascii=False)))


async def _h_file_dev_ticket(ctx: Ctx, args: dict[str, Any]) -> ToolResult:
    from . import local  # noqa: PLC0415

    # a code ticket's Allow card is in the browser, which terminal mode does not open; a change to a view is a view
    # build, which runs in both modes
    if local.terminal(ctx.c) and not " ".join(str(args.get("view") or "").split()):
        return err(hint("ticket-terminal") or "file_dev_ticket: code tickets are filed in browser mode")
    title = " ".join(str(args.get("title") or "").split())
    body = str(args.get("body") or "").strip()
    if not title:
        return err("file_dev_ticket: `title` is required")
    if not body:
        return err("file_dev_ticket: `body` is required")
    if view := " ".join(str(args.get("view") or "").split()):
        # a change to a view the dev agent built is a view ticket on that view, in the workspace, not a change to
        # thimble's code
        from . import views

        slug = await asyncio.to_thread(views.built_slug, ctx.c, view) or next(
            (str(p["slug"]) for p in views.list_proposals(ctx.c) if p.get("name", "").casefold() == view.casefold()
             or p.get("slug") == view.removeprefix("view:")), None)
        if slug is None:
            names = [v["name"] for v in views.list_views(ctx.c) if v.get("origin") == "workspace"]
            return err(hint("file_dev_ticket-no-view", view=view, views=", ".join(names) or "none"))
        typed = ctx.session is None  # main's own call: the change is main's Agent call
        prop = views.revise(ctx.c, slug, f"{title}\n\n{body}", proposed_by=ctx.created_by,  # on the loop: it queues
                            asked=typed, route=views.TYPED if typed else views.FOLLOW_ON)
        _chip(ctx.c, "view", str(prop.get("name") or slug), ref=f"view:{slug}", status="queued")
        if why := await asyncio.to_thread(views.build_problem):
            return ok(hint("propose_view-cannot-build", view=prop.get("name"), slug=slug, why=why))
        if typed:
            return await _typed_build(ctx, slug)
        return ok(hint("view-changing", view=prop.get("name"), slug=slug))
    fn = _optional("dev", "file_ticket")
    if fn is None:
        return _not_available("file_dev_ticket", "dev", "file_ticket")
    from . import dev  # noqa: PLC0415 — dev imports this module's callers

    source = ANALYST if ctx.actor == ANALYST else ctx.actor
    rec = await _maybe_await(fn(ctx.c, title, body, urgent=bool(args.get("urgent")), source=source, start=False,
                                route="typed"))
    label = dev._label(rec)
    # main's ticket: prepared, then the exact Agent call that starts its agent, which auto mode judges (dev.start_typed)
    ans = await dev.start_typed(rec, call=ctx.tool_use_id)
    if ans.get("held"):
        return ok(hint("file_dev_ticket-waits", label=label, running=str(ans.get("running") or "another ticket")))
    if ans.refused or "input" not in ans:
        return ok(hint("file_dev_ticket-cannot-run", label=label, why=ans.reason or str(ans.kind or "")))
    return ok(hint("file_dev_ticket-start", label=label, title=title,
                   start=hint("start_job-subagent", input=json.dumps(ans["input"], ensure_ascii=False))))

# --------------------------------------------------------------------------- HTTP


class CallBody(BaseModel):
    args: dict[str, Any] = {}
    actor: str = ANALYST
    cwd: str | None = None  # the caller's directory (the shim's THIMBLE_CWD); mapped to a workspace
    workspace: str | None = None  # or the workspace by name
    notebook: str | None = None
    session: str | None = None  # the shim's THIMBLE_SESSION: `orient`, `writer:<doc>` or `critique:orient`
    session_token: str | None = None  # the shim's THIMBLE_SESSION_TOKEN, which proves `session` (hook_auth)
    tool_use_id: str | None = None  # Claude Code's id of the call (Ctx.tool_use_id)


@router.get("/tools")
async def list_route(role: str = ANALYST) -> "builtins.list[dict[str, Any]]":
    try:
        return list(role)
    except ValueError as e:
        raise HTTPException(400, str(e))


def _workspace_of(cwd: str | None, workspace: str | None) -> str:
    c = workspace or workspace_for_cwd(cwd)
    if not c:
        raise HTTPException(400, f"{cwd or '(no cwd)'} is not inside a corpus thimble knows; say /thimble to register it")
    try:
        config.workspace_path(c)  # validated, not created: these are GETs
    except ValueError as e:
        raise HTTPException(404, str(e))
    return c


@router.get("/tools/holdings")
async def holdings_route(cwd: str | None = None, workspace: str | None = None) -> dict[str, Any]:
    """{workspace, cards, labels, documents, chats, text}: what the workspace holds, for /thimble's resume line."""
    c = _workspace_of(cwd, workspace)
    return await asyncio.to_thread(holdings, c)


@router.post("/tools/{name}")
async def call_route(name: str, body: CallBody, request: Request) -> dict[str, Any]:
    """Run one tool for the shim: {content, is_error}. 404 for a tool the registry does not have, 400 when the caller's
    directory belongs to no corpus; everything else the model should read is an is_error result, never an HTTP error.
    A tool marked drop_stops is cancelled when the shim drops the request (until_dropped). The call runs as the session
    it names only with a token that proves it (hook_auth.session_proven): without one it runs as the analyst's, unless
    it comes from a workspace's own folder, and with a wrong one it does not run. A call through main's shim runs as
    the agent of thimble's that made it (_as_caller)."""
    if not known(name):
        raise HTTPException(404, f"no such tool: {name}")
    from . import harness, hook_auth  # noqa: PLC0415 — harness imports agent_session's helpers lazily

    agent = hook_auth.agent_of(request.scope)
    run = harness.by_token(agent) if agent else None
    if agent and run is None:
        raise HTTPException(401, "the agent's token has ended")
    if run is not None:  # a program's call runs as its role's session, in its workspace and its thread (harness.py)
        return await harness.tool_call(run, {"name": name, "args": body.args})
    # a session thimble starts in its workspace's own folder (the orientation's, which runs in its work folder so the
    # corpus folder can be denied to Bash whole) reaches its workspace from that folder, before any corpus that holds it
    session = body.session or None
    folder = config.workspace_for_folder(body.cwd) if session else None
    if folder and not body.session_token:  # a session there without a token, as one an earlier thimble started
        return err(hint("session-unproven", tool=name)).as_dict()
    c = body.workspace or folder or workspace_for_cwd(body.cwd)
    if not c:
        raise HTTPException(400, f"{body.cwd or '(no cwd)'} is not inside a corpus thimble knows; say /thimble to register it")
    if session and not hook_auth.session_proven(c, session, body.session_token or ""):
        if body.session_token:
            return err(hint("session-unproven", tool=name)).as_dict()
        log.info("a call of %s names the session %s without its token; it runs as the analyst's", name, session)
        session = None
    if session is None:  # main's shim: main's own call, or one of thimble's agents', told apart by its caller
        refused, session = await _as_caller(c, name, body.tool_use_id or None)
        if refused:
            return err(refused).as_dict()
    work = call(c, name, body.args, actor=body.actor, notebook=body.notebook, session=session,
                tool_use_id=body.tool_use_id or None)
    if REGISTRY[canonical(name)].drop_stops:
        res = await until_dropped(request.receive, work, name)
        return (res or err(f"{name} was stopped: its caller dropped the call")).as_dict()
    return (await work).as_dict()


# the start tools, whose result is an Agent call for the caller to make: a thread's fork may not make one, since Claude
# Code tells its forks not to start subagents, so a fork's call is refused at once with start-refused-fork (U5), and its
# file_dev_ticket, which starts a code ticket's agent or a view's builder, with start-refused-fork-ticket; another
# subagent of main's makes the call itself (subagents.typed_caller)
FORK_REFUSED = ("start_orientation", "start_writing", "propose_view", "run_check", "file_dev_ticket")


async def _as_caller(c: str, name: str, tool_use_id: str | None) -> tuple[str, str | None]:
    """(why the call is refused, '' when it runs; the session it runs as) for a call through main's shim: the key of the
    agent of thimble's that made it (subagents.caller, from the caller hook's line, else the transcript that holds the
    call), or None for main's own. A call its caller may not make is refused (subagents.allowed): main's `critique`, the
    critic's `add_card`, a tool of a part the orientation's run has off (orientation.part_on), a thread's fork's start
    tool (FORK_REFUSED)."""
    from . import orientation, orient_session, subagents  # noqa: PLC0415 — each imports this module

    canon = canonical(name)
    who = await subagents.caller(c, tool_use_id) if tool_use_id else None
    if who is None and canon in FORK_REFUSED and subagents.fork_call(c, tool_use_id):
        if canon == "file_dev_ticket":
            return hint("start-refused-fork-ticket"), None
        return hint("start-refused-fork"), None
    if who is None:
        spec = REGISTRY[canon]
        if spec.sessions and None not in spec.sessions:
            return f"{canon} is not available to main", None
        return "", None
    if not subagents.allowed(who, canon):
        return f"{canon} is not available to {who.agent_type or 'this agent'}", None
    if session_kind(who.key) == ORIENT_SESSION:
        part = next((p for p, names in orient_session.PART_TOOLS.items() if canon in names), None)
        if part is not None and not orientation.part_on(c, part):
            return f"{canon} is not available in this run of the orientation, whose {part} output is off", None
    return "", who.key


async def until_dropped(receive: Callable[[], Awaitable[dict[str, Any]]], work: Awaitable[ToolResult],
                        name: str = "") -> ToolResult | None:
    """Await `work` while the caller holds its request open; None once the caller dropped it, after `work` was
    cancelled.
    Uvicorn does not cancel a handler whose client went away, so this watches `receive` for `http.disconnect`."""
    task = asyncio.ensure_future(work)

    async def dropped() -> None:
        while (await receive()).get("type") != "http.disconnect":
            pass

    watch = asyncio.ensure_future(dropped())
    try:
        await asyncio.wait({task, watch}, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        watch.cancel()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        raise
    if task.done():
        watch.cancel()
        return task.result()
    log.info("the caller of %s dropped the call; it is cancelled", name or "a tool")
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task
    return None


class ActiveGroupBody(BaseModel):
    group: str  # a group's id


@router.put("/ws/{c}/canvas/active-group")
async def active_group_route(c: str, body: ActiveGroupBody) -> dict[str, Any]:
    """The browser's report of the frame the analyst last selected, stored in settings.json (ACTIVE_GROUP_KEY) for
    default_group. {group}; 404 for a group a card cannot land in."""
    from .ledger import read_json, write_json, ws_dir

    ws = ws_dir(c)
    gid = _live_group(ws, body.group.strip())
    if gid is None:
        raise HTTPException(404, f"no group {body.group!r} a card can land in")
    path = ws / "settings.json"
    settings = read_json(path, {})
    settings = settings if isinstance(settings, dict) else {}
    if settings.get(ACTIVE_GROUP_KEY) != gid:
        write_json(path, {**settings, ACTIVE_GROUP_KEY: gid})
    return {"group": gid}
