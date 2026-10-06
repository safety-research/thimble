"""What a demo pre-cache may hold, in the standard library alone: `thimble demo --export` (demo.py) writes pre-caches
with it, and scripts/check_content.py loads this file by its path to check demos/<dataset>/ the same way.

The kinds of file (workspace_kind): a pre-cache holds the orientation's outputs and nothing else, each under its path in
the workspace. The cards (notebooks/), the documents (investigations/<name>/*.json), the labels' definitions
(concepts/) and their values by record ref (labels/*.jsonl), the views' code and manifests (extension/extension.json,
each view's view.json and code in extension/views/<slug>/, and views/proposals.json), the orientation's record
(orient/run.json, orient/summary.md), its thread's meta with an empty log (chats/<id>.meta.json, chats/<id>.jsonl) and
the calls the report or a card cites (calls/<id>.jsonl, each result cut to an excerpt). No Claude Code transcript, no
conversation, no work file of the orientation's and no index or cache a view built from the corpus.

The scrub check (findings): a file's text after the export wrote its absolute paths as placeholders holds no absolute
path under /home, /Users, /mnt or /root, and not the maintainer's user name as a word.
"""
from __future__ import annotations

import re

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


def findings(text: str, user: str) -> list[str]:
    """What in a file's text could be private: the user name `user` as a word (when it has 3 characters or more),
    absolute paths (the first five)."""
    out = []
    if user and len(user) >= 3 and re.search(rf"(?<![\w]){re.escape(user)}(?![\w])", text):
        out.append(f"the user name {user!r}")
    out += sorted({m.group() for m in ABS_PATH_RE.finditer(text)})[:5]
    return out
