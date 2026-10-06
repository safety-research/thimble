"""What a demo pre-cache may hold, in the standard library alone: `thimble demo --export --outputs-only` (demo.py)
writes pre-caches with it, and scripts/check_content.py loads this file by its path to check demos/<dataset>/ the same
way. A full export (`thimble demo --export`) also uses its placeholders, its scrub check and clean_transcript.

The kinds of file (workspace_kind): a pre-cache holds the orientation's outputs and nothing else, each under its path in
the workspace. The cards (notebooks/), the documents (investigations/<name>/*.json), the labels' definitions
(concepts/) and their values by record ref (labels/*.jsonl), the views' code and manifests (extension/extension.json,
each view's view.json and code in extension/views/<slug>/, and views/proposals.json), the orientation's record
(orient/run.json, orient/summary.md), its thread's meta with an empty log (chats/<id>.meta.json, chats/<id>.jsonl) and
the calls the report or a card cites (calls/<id>.jsonl, each result cut to an excerpt). No Claude Code transcript, no
conversation, no work file of the orientation's and no index or cache a view built from the corpus.

The shape of what the export writes (shape_findings), which check_content checks again in the tree: the only chat is the
orientation's, with an empty log; a call log holds only the calls the manifest's `cited_calls` lists, each output at
most CALL_KEPT lines of at most CALL_LINE_CHARS characters; a label row holds no `spans` (the texts a label marked).

The scrub check (findings): a file's text after the export wrote its absolute paths as placeholders holds no absolute
path under /home, /Users, /mnt or /root, and not the maintainer's user name as a word.

The transcripts of a full export. Claude Code's transcript of a session (`<config>/projects/<folder>/<session>.jsonl`)
holds, besides the conversation, what Claude Code told the model about the exporter's machine and account: their
CLAUDE.md files, their email, their organization, their skills, agents and MCP servers, the machine and the sandbox's
paths, the system prompt. clean_transcript drops those attachments (MACHINE_ATTACHMENTS) and keeps every other record,
so the conversation stays whole (the messages queued to the session, the files it edited, the call refs thimble's
hooks added), linking each record whose parent it dropped to the dropped record's parent, so Claude Code's resume still
reads one unbroken conversation; a resumed session is told its own machine's again. The install writes each
transcript into Claude Code's projects folder for its new place (projects_folder).
"""
from __future__ import annotations

import json
import re
from typing import Any

# the folders a pre-cache writes as placeholders: the workspace, the corpus, thimble's install, thimble's home
# ($THIMBLE_HOME) and the user's home
PLACEHOLDERS = {"workspace": "@@THIMBLE_WORKSPACE@@", "corpus": "@@THIMBLE_CORPUS@@", "app": "@@THIMBLE_APP@@",
                "thimble_home": "@@THIMBLE_HOME@@", "home": "@@THIMBLE_USER_HOME@@"}
DASHED = {k: v.replace("@@THIMBLE_", "@@THIMBLE_DASHED_") for k, v in PLACEHOLDERS.items()}
# the kinds of file a pre-cache keeps: text a reviewer can read in a diff
TEXT_SUFFIXES = (".json", ".jsonl", ".md", ".txt", ".py", ".html", ".js", ".mjs", ".css", ".svg")
CARD_SUFFIXES = (".json", ".txt", ".md", ".html", ".svg")  # a card group and its full-size outputs
VIEW_CODE_SUFFIXES = (".html", ".js", ".mjs", ".css", ".py", ".md", ".svg")  # beside a view's view.json
ABS_PATH_RE = re.compile(r"(?<![\w.@])/(?:home|Users|mnt|root)/[\w.@+-]+")  # /tmp is the data's, mostly
# user names that are words of their own or a CI runner's, which check_content does not look for
COMMON_USERS = {"user", "runner", "root", "ubuntu", "node", "vscode", "codespace", "admin", "test"}
# A cited call's output as a pre-cache keeps it (demo.call_excerpt): its first CALL_LINES lines unless only lines are
# cited, and the lines cited, at most CALL_KEPT lines in all, each cut to CALL_LINE_CHARS. In nine finished orientations
# (2026-10-05) a citation named at most one line of a call.
CALL_LINES = 30
CALL_KEPT = 100
CALL_LINE_CHARS = 500
CALL_CUT_NOTE = ("[thimble demo: the pre-cache keeps only the first lines of this output and the lines a card or the "
                 "report cites]")
LABEL_DROPPED = ("spans",)  # a label row's field that holds the record's own text (labels_store: the texts it marks)
# The attachments clean_transcript drops (module note): what Claude Code told the model about the exporter's machine,
# account and setup (CLAUDE.md files, email, organization, skills, agents, MCP servers, environment, system prompt).
MACHINE_ATTACHMENTS = {"instructions", "nested_memory", "session_context", "credential_org", "skill_listing",
                       "agent_listing_delta", "mcp_instructions_delta", "environment", "sandbox_instructions",
                       "remote_session_change", "prompt_snapshot"}
DROPPED_FIELDS = ("serverClassifierContext",)  # per record: the classifier's view of the machine (git state, cwd)
LINK_FIELDS = ("parentUuid", "logicalParentUuid", "leafUuid")


def workspace_kind(rel: str) -> bool:
    """Whether `rel`, a path in the workspace, is of a kind a pre-cache holds (module note)."""
    parts = rel.split("/")
    if any(not p or p.startswith((".", "__")) for p in parts):
        return False
    top, name, n = parts[0], parts[-1], len(parts)
    if top == "notebooks":
        return n >= 2 and not {"trash", "cache", "tmp"} & set(parts) and name.endswith(CARD_SUFFIXES)
    if top == "investigations":
        return n == 3 and name.endswith(".json")
    if top == "concepts":
        return n == 2 and name.endswith(".json")
    if top in ("labels", "calls"):
        return n == 2 and name.endswith(".jsonl")
    if top == "extension":
        return rel == "extension/extension.json" or (
            n >= 4 and parts[1] == "views" and parts[3] != "cache"
            and (name == "view.json" or name.endswith(VIEW_CODE_SUFFIXES)))
    if top == "chats":
        return n == 2 and name.endswith((".meta.json", ".jsonl"))
    return rel in ("views/proposals.json", "orient/run.json", "orient/summary.md")


def _rows(text: str) -> list[Any] | None:
    """The JSON values of a JSONL file's lines, None when a line is not JSON."""
    out = []
    for line in text.split("\n"):
        if line.strip():
            try:
                out.append(json.loads(line))
            except ValueError:
                return None
    return out


def shape_findings(rel: str, text: str, manifest: dict[str, Any]) -> list[str]:
    """What in the workspace file `rel` of a pre-cache, with `text`, the export does not write (module note), given the
    pre-cache's manifest."""
    parts = rel.split("/")
    orient = str((manifest.get("orientation") or {}).get("chat") or "")
    if parts[0] == "chats":
        if not orient or rel not in (f"chats/{orient}.meta.json", f"chats/{orient}.jsonl"):
            return ["a chat other than the orientation's"]
        if rel.endswith(".jsonl") and text:
            return ["the orientation's log, which the export writes empty"]
    elif parts[0] == "calls":
        chat = parts[-1][: -len(".jsonl")]
        cited = {x.get("n") for x in manifest.get("cited_calls") or [] if isinstance(x, dict) and x.get("chat") == chat}
        rows = _rows(text)
        if rows is None:
            return ["a call log line that is not JSON"]
        for row in rows:
            if not isinstance(row, dict) or row.get("n") not in cited:
                return ["a call the manifest's cited_calls does not list"]
            result = row.get("result")
            if result is None:
                continue
            lines = result.split("\n") if isinstance(result, str) else None
            if lines is None or sum(1 for x in lines if x) > CALL_KEPT + 1 or any(len(x) > CALL_LINE_CHARS for x in lines):
                return [f"call {row.get('n')}'s output is longer than the excerpt the export keeps"]
    elif parts[0] == "labels":
        rows = _rows(text)
        if rows is None:
            return ["a label row that is not JSON"]
        if any(isinstance(r, dict) and set(LABEL_DROPPED) & set(r) for r in rows):
            return [f"a label row with {', '.join(LABEL_DROPPED)} (the texts a label marked)"]
    return []


def findings(text: str, user: str) -> list[str]:
    """What in a file's text could be private: the user name `user` as a word (when it has 3 characters or more),
    absolute paths (the first five)."""
    out = []
    if user and len(user) >= 3 and re.search(rf"(?<![\w]){re.escape(user)}(?![\w])", text):
        out.append(f"the user name {user!r}")
    out += sorted({m.group() for m in ABS_PATH_RE.finditer(text)})[:5]
    return out


def clean_transcript(data: bytes) -> tuple[bytes, dict[str, Any]]:
    """The transcript `data` with only the conversation kept (module note), and what was dropped: {kept, dropped: {kind:
    n}, unreadable}. Lines are split at `\n` alone, since a record may hold U+2028."""
    records: list[dict[str, Any]] = []
    unreadable = 0
    for line in data.decode("utf-8", "replace").split("\n"):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            unreadable += 1
            continue
        if isinstance(rec, dict):
            records.append(rec)
    parent: dict[str, Any] = {}  # a dropped record's uuid -> its parent's
    dropped: dict[str, int] = {}
    kept: list[dict[str, Any]] = []
    for rec in records:
        kind = _dropped_kind(rec)
        if kind:
            dropped[kind] = dropped.get(kind, 0) + 1
            if rec.get("uuid"):
                parent[str(rec["uuid"])] = rec.get("parentUuid")
            continue
        kept.append(rec)

    def resolve(u: Any) -> Any:
        seen = set()
        while isinstance(u, str) and u in parent and u not in seen:
            seen.add(u)
            u = parent[u]
        return u

    lines = []
    for rec in kept:
        for f in LINK_FIELDS:
            if f in rec:
                rec[f] = resolve(rec[f])
        for f in DROPPED_FIELDS:
            rec.pop(f, None)
        lines.append(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
    out = ("\n".join(lines) + "\n").encode("utf-8") if lines else b""
    return out, {"kept": len(kept), "dropped": dict(sorted(dropped.items())), "unreadable": unreadable}


def _dropped_kind(rec: dict[str, Any]) -> str:
    """The kind under which clean_transcript drops `rec`, or '' when it is kept."""
    if rec.get("type") != "attachment":
        return ""
    att = rec.get("attachment")
    kind = str(att.get("type") or "") if isinstance(att, dict) else ""
    return f"attachment:{kind}" if kind in MACHINE_ATTACHMENTS else ""


def _java_hash(s: str) -> int:
    """Claude Code's string hash (a 32-bit `h * 31 + c` over UTF-16 code units), for a long folder's name."""
    data, h = s.encode("utf-16-le"), 0
    for i in range(0, len(data), 2):
        h = (h * 31 + (data[i] | data[i + 1] << 8)) & 0xFFFFFFFF
    return h - (1 << 32) if h >= 1 << 31 else h


def _base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if n == 0:
            return out


def projects_folder(path: str) -> str:
    """The name of Claude Code's projects folder for a session run in `path`: every character but a letter or digit as
    `-`, and over 200 characters the first 200 and a hash of the path."""
    name = re.sub(r"[^A-Za-z0-9]", lambda m: "--" if ord(m.group()) > 0xFFFF else "-", path)  # per UTF-16 unit
    return name if len(name) <= 200 else f"{name[:200]}-{_base36(abs(_java_hash(path)))}"
