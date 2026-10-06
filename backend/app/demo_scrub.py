"""What a demo pre-cache may hold, in the standard library alone: `thimble demo --export` (demo.py) writes pre-caches
with it, and scripts/check_content.py loads this file by its path to check demos/<dataset>/ the same way.

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
