"""What a demo pre-cache may hold, in the standard library alone: `thimble demo --export` (demo.py) writes pre-caches
with it, and scripts/check_content.py loads this file by its path to check demos/<dataset>/ the same way.

The scrub check (findings): a file's text after the export wrote its absolute paths as placeholders holds no absolute
path under /home, /Users, /mnt or /root, and not the maintainer's user name as a word. A Claude Code transcript is
also checked for the records the export drops (transcript_findings).

The transcript. Claude Code's transcript of the orientation (`<config>/projects/<folder>/<session>.jsonl`) holds,
besides the conversation, what Claude Code told the model about the maintainer's machine and account: their CLAUDE.md
files, their email, their organization, their skills and agents, the sandbox's paths, the system prompt.
clean_transcript keeps the conversation (the user, assistant and system records, and the attachments in
KEPT_ATTACHMENTS: the call refs thimble's hook added, the date, the model, the deferred tools it loaded) and drops every
other attachment, linking each record whose parent it dropped to the dropped record's parent, so Claude Code's resume
still reads one unbroken conversation.
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
TEXT_SUFFIXES = (".json", ".jsonl", ".md", ".txt", ".py", ".html", ".csv", ".js", ".mjs", ".css", ".tsv", ".yaml",
                 ".yml", ".svg")
ABS_PATH_RE = re.compile(r"(?<![\w.@])/(?:home|Users|mnt|root)/[\w.@+-]+")  # /tmp is the data's, mostly
# user names that are words of their own or a CI runner's, which check_content does not look for
COMMON_USERS = {"user", "runner", "root", "ubuntu", "node", "vscode", "codespace", "admin", "test"}

# The attachments a cleaned transcript keeps (module note): what the model read that the conversation needs.
KEPT_ATTACHMENTS = {"hook_additional_context", "date", "model", "deferred_tools_record"}
DROPPED_FIELDS = ("serverClassifierContext",)  # per record: the classifier's view of the machine (git state, cwd)
LINK_FIELDS = ("parentUuid", "logicalParentUuid", "leafUuid")


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
    n}, unreadable}."""
    records: list[dict[str, Any]] = []
    unreadable = 0
    for line in data.decode("utf-8", "replace").splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            unreadable += 1
            continue
        if isinstance(rec, dict):
            records.append(rec)
    parent: dict[str, str | None] = {}  # a dropped record's uuid -> its parent's
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
    return "" if kind in KEPT_ATTACHMENTS else f"attachment:{kind or '?'}"


def transcript_findings(text: str) -> list[str]:
    """What clean_transcript would have dropped, found in a transcript's text: one line per kind."""
    out: dict[str, int] = {}
    for line in text.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            out["a line that is not JSON"] = out.get("a line that is not JSON", 0) + 1
            continue
        kind = _dropped_kind(rec) if isinstance(rec, dict) else "a line that is not an object"
        if not kind and isinstance(rec, dict) and any(f in rec for f in DROPPED_FIELDS):
            kind = "a field the export drops"
        if kind:
            out[kind] = out.get(kind, 0) + 1
    return [f"{k} ({n})" for k, n in sorted(out.items())]


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
