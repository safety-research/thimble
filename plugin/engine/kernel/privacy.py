"""The privacy scan of a fix's draft: what `thimble fix draft` removes before the person reads the text it would send.

A plain module: the standard library only, no plugin imports, so the browser workbench can use the same file.

It finds two sorts of details in the parts of a draft (the issue, the PR body, the diff, the branch name, the commit
messages):

- Generic: home and mount paths (/home/<x>, /Users/<x>, paths under /mnt, C:\\Users\\<x>), emails, private key headers, token
  shapes (the same patterns as scripts/scan.sh --generic, plus long hex and base64 strings), IP addresses, and what
  gitleaks finds when it is installed.
- Session: terms the caller collects from the person's machine and session (session_terms in fixes.py): their user name,
  host name, git name and email, the data folder's path and the names of its files and folders, and the field names and
  string values the session read.

A field name, a value, or a file's or folder's bare name that also appears in thimble's own source tree is not a hit (the
caller's `known` answers that), so words such as "card", "rows", "label" or "tests" pass, and a diff of thimble's code
still applies after the scan. A whole file name (board.jsonl), a path, and the person's user, host or git name are hits
even when thimble's source holds the same words. Each hit gets a placeholder by its kind, and a path inside thimble's own tree
becomes its path in the repository.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from typing import Callable, Iterable

PLACEHOLDER = {
    "path": "‹path›", "email": "‹email›", "token": "‹secret›", "key": "‹secret›", "generic": "‹secret›",
    "name": "‹name›", "host": "‹host›", "git": "‹name›", "folder": "‹folder›", "file": "‹data file›",
    "field": "‹field›", "value": "‹value›",
}
NEVER_KEPT = {"token", "key", "generic"}  # keys and tokens are never put back
WHERE = ("issue", "pr", "diff", "branch", "commit")

_PATH_TAIL = r"(?:[/\\][^\s'\"`<>()\[\]{},;|*?]*)*"
_NAME = r"[A-Za-z0-9._-]+"
# (kind, pattern, characters that must not come right before a match)
GENERIC: list[tuple[str, str, str | None]] = [
    ("path", r"/(?:home|Users)/" + _NAME + _PATH_TAIL, r"[\w.~$-]"),
    ("path", r"/mnt[/]" + _NAME + _PATH_TAIL, r"[\w.~$-]"),
    ("path", r"[A-Za-z]:\\Users\\[A-Za-z0-9._ -]+" + _PATH_TAIL, r"[\w]"),
    ("key", r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:.*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----)?", None),
    ("token", r"sk-ant-[a-z]{2,8}\d{2}-[A-Za-z0-9_-]{20,}", r"[\w-]"),
    ("token", r"sk-[A-Za-z0-9_-]{20,}", r"[\w-]"),
    ("token", r"gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}", r"[\w-]"),
    ("token", r"(?:AKIA|ASIA)[A-Z0-9]{16}\b", r"[\w-]"),
    ("token", r"AIza[0-9A-Za-z_-]{35}", r"[\w-]"),
    ("token", r"ya29\.[0-9A-Za-z_-]{20,}", r"[\w-]"),
    ("token", r"xox[abposr]-[A-Za-z0-9-]{10,}", r"[\w-]"),
    ("token", r"hf_[A-Za-z0-9]{30,}", r"[\w-]"),
    ("token", r"npm_[A-Za-z0-9]{36}\b", r"[\w-]"),
    ("token", r"[rs]k_live_[A-Za-z0-9]{20,}", r"[\w-]"),
    ("token", r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", r"[\w-]"),
    ("token", r"[0-9a-f]{32,}(?![0-9A-Za-z])", r"[0-9A-Za-z]"),
    ("token", r"(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{40,}={0,2}",
     r"[A-Za-z0-9+/_-]"),
    ("email", r"[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}", r"[\w.+%-]"),
    ("host", r"(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.]*\d)", r"[\d.]"),
]
# the made-up home folder thimble's tests use and the placeholders its docs use; local addresses; an email at a domain
# reserved for examples (example.com, .org, .net and *.example), which a reproduction on made-up data uses
ALLOW = re.compile(r"^/(?:home|Users)/(?:t|you|user|username|name|me)(?:/|$)|^(?:127\.0\.0\.1|0\.0\.0\.0)$"
                   r"|@(?:[A-Za-z0-9-]+\.)*(?i:example\.(?:com|org|net)|example)$")
_COMPILED = [(k, re.compile(rx, re.S), re.compile(b) if b else None) for k, rx, b in GENERIC]
_WORDY = {"name", "host", "git", "folder", "file", "field", "value"}
KNOWN_PASS = {"field", "value"}  # the session kinds a word of thimble's own source lets pass, with bare names (_passes)


def _passes(kind: str, s: str) -> bool:
    """Whether a word of thimble's own source lets this term pass: a field or a value, or a file's or folder's bare
    name with no extension (tests, prompt), which thimble's code is full of; never a whole file name or a person's."""
    return kind in KNOWN_PASS or (kind in ("file", "folder") and "." not in s)


def _finds(text: str, found: str, kind: str) -> Iterable[tuple[int, int]]:
    """The spans of `found` in text: a session word only where it stands as a whole word, anything else wherever it
    occurs."""
    if not found:
        return
    if kind in _WORDY:
        pre = r"(?<![A-Za-z0-9_])" if re.match(r"\w", found) else ""
        post = r"(?![A-Za-z0-9_])" if re.search(r"\w$", found) else ""
        for m in re.finditer(pre + re.escape(found) + post, text):
            yield m.start(), m.end()
        return
    i = text.find(found)
    while i >= 0:
        yield i, i + len(found)
        i = text.find(found, i + len(found))


def _generic(text: str) -> list[tuple[str, str]]:
    out = []
    for kind, rx, before in _COMPILED:
        for m in rx.finditer(text):
            if before and m.start() and before.match(text, m.start() - 1):
                continue
            s = m.group(0)
            if kind == "path":
                s = s.rstrip(".:,!'\"")
            if ALLOW.search(s):
                continue
            out.append((kind, s))
    return out


def gitleaks(texts: dict[str, str]) -> tuple[list[tuple[str, str]], str | None]:
    """What gitleaks finds in the texts, when it is installed: ([(where, secret)], a note when it could not run). Its
    report stays in a private temporary folder, which is removed at once."""
    exe = shutil.which("gitleaks")
    if not exe:
        return [], None
    with tempfile.TemporaryDirectory(prefix="thimble-scan-") as d:
        os.chmod(d, 0o700)
        src = os.path.join(d, "src")
        os.mkdir(src)
        for where, t in texts.items():
            with open(os.path.join(src, where + ".txt"), "w", encoding="utf-8") as f:
                f.write(t)
        rep = os.path.join(d, "report.json")
        p = subprocess.run([exe, "dir", src, "--no-banner", "--no-color", "--log-level", "error", "--exit-code", "0",
                            "--report-format", "json", "--report-path", rep], capture_output=True, text=True)
        if p.returncode != 0 or not os.path.exists(rep):
            return [], f"gitleaks did not run (exit {p.returncode}); the other checks ran"
        try:
            found = json.load(open(rep, encoding="utf-8"))
        except ValueError:
            return [], "gitleaks gave a report that is not JSON; the other checks ran"
    out = []
    for f in found or []:
        where = os.path.basename(str(f.get("File") or "")).rsplit(".", 1)[0]
        s = f.get("Secret") or f.get("Match") or ""
        if where in texts and s:
            out.append((where, s))
    return out, None


def scan(parts: dict[str, str], session: dict[str, Iterable[str]] | None = None,
         known: Callable[[list[str]], set[str]] | None = None, repo_paths: Iterable[tuple[str, str]] = (),
         allow: Iterable[str] = (), use_gitleaks: bool = True) -> tuple[list[dict], list[str]]:
    """The hits in a draft's parts ({where: text}): ([{id, kind, found, replacement, where, kept}], notes).

    session: {kind: terms} from the person's machine and session (kinds name, host, git, path, folder, file, field,
    value). known(terms) returns the terms that also appear in thimble's own source tree; a field name or a value among
    them is not a hit, any other kind still is.
    repo_paths: (prefix, replacement) pairs that turn a path inside thimble's own tree into its path in the repository.
    allow: strings that are never hits (such as the release's commit)."""
    allowed = {a for a in allow if a}
    notes: list[str] = []
    generic = {where: _generic(text) for where, text in parts.items()}
    leaks: list[tuple[str, str]] = []
    if use_gitleaks:
        leaks, note = gitleaks(parts)
        if note:
            notes.append(note)
    terms: list[tuple[str, str]] = []
    for kind, xs in (session or {}).items():
        for x in xs:
            x = (x or "").strip()
            if x and "\n" not in x:
                terms.append((kind, x))
    terms.sort(key=lambda kt: -len(kt[1]))
    present = {where: [(k, x) for k, x in terms if next(iter(_finds(text, x, k)), None)] for where, text in parts.items()}
    generic_words = sorted({x for p in present.values() for k, x in p if _passes(k, x)} - allowed)
    public = known(generic_words) if (known and generic_words) else set()
    hits: list[dict] = []
    for where, text in parts.items():
        # the longest first, so a term inside a path or a file name that is already a hit is not listed again
        cand = generic[where] + [("generic", s) for w, s in leaks if w == where]
        cand = sorted(cand, key=lambda ks: -len(ks[1])) + present[where]
        taken = [False] * len(text)
        listed: set[str] = set()
        for kind, s in cand:
            if s in allowed or s in listed or (_passes(kind, s) and s in public):
                continue
            spans = [(a, b) for a, b in _finds(text, s, kind) if not any(taken[a:b])]
            if not spans:
                continue
            for a, b in spans:
                taken[a:b] = [True] * (b - a)
            listed.add(s)
            rep = PLACEHOLDER[kind]
            if kind == "path":
                for prefix, to in repo_paths:
                    if prefix and s.startswith(prefix):
                        rep = to + s[len(prefix):]
                        break
            hits.append({"id": "", "kind": kind, "found": s, "replacement": rep, "where": where, "kept": False})
    hits.sort(key=lambda h: (WHERE.index(h["where"]) if h["where"] in WHERE else 9, h["kind"], h["found"]))
    for i, h in enumerate(hits, 1):
        h["id"] = f"h{i}"
    return hits, notes


def keepable(hit: dict) -> bool:
    """Whether the person may put a hit back: never a key or a token."""
    return hit.get("kind") not in NEVER_KEPT


def redact(text: str, hits: Iterable[dict]) -> str:
    """text with each hit that is not kept replaced, the longest first, so a path holding a file's name goes whole. A
    key or a token goes whatever its `kept` says."""
    taken = [False] * len(text)
    spans: list[tuple[int, int, str]] = []
    for h in sorted((h for h in hits if not h.get("kept") or not keepable(h)), key=lambda h: -len(h["found"])):
        for a, b in _finds(text, h["found"], h["kind"]):
            if not any(taken[a:b]):
                taken[a:b] = [True] * (b - a)
                spans.append((a, b, h["replacement"]))
    for a, b, rep in sorted(spans, reverse=True):
        text = text[:a] + rep + text[b:]
    return text


def apply(parts: dict[str, str], hits: list[dict]) -> dict[str, str]:
    """Each part with its own hits replaced."""
    return {w: redact(t, [h for h in hits if h["where"] == w]) for w, t in parts.items()}
