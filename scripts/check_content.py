#!/usr/bin/env python3
"""Check the repo's files for content that must not be committed: secrets, private names, and files of kinds that
never belong in the tree. scripts/check.sh and CI run it.

    python3 scripts/check_content.py [DIR] [--no-gitleaks]
    python3 scripts/check_content.py --digest TERM

    DIR            the tree to check (default: this repo, its tracked files plus untracked ones git does not ignore);
                   a folder that is not a git checkout is checked whole
    --no-gitleaks  skip the secret scan (CI always runs it)
    --digest TERM  print the line that adds TERM to the private list as a digest, and exit

Kinds of hit:
    private     a name that belongs to private material: a corpus, a machine, a home folder, an unreleased name
    maintainer  the maintainer's name or address outside the files that carry it on purpose (MAINTAINER_FILES)
    path        a file of a kind that never belongs in the tree (data, databases, captures, caches, a file over 2 MB)
    case        a file whose name differs from another's in its folder only by case once the extension is dropped, or
                a folder whose path differs from another's only by case: on a case-insensitive disk (macOS, Windows)
                an import of ./Checks can load checks.ts in place of Checks.tsx, and the two folders are one
    secret      a gitleaks finding

The private and maintainer names are kept out of this repo, which is public. They come from a private list: the
environment variable THIMBLE_PRIVATE_TERMS (CI sets it from the repository secret of that name), else the file that
THIMBLE_PRIVATE_TERMS_FILE names, else ~/.config/thimble/private-terms. Without a list those two kinds are not checked,
and the output says so. Each line of the list is `<kind> <term>`, where kind is private or maintainer and term is a
word, two words joined with "-", or the SHA-256 digest of one; blank lines and lines starting with # are skipped. A word
of a line, or two neighbouring words joined with "-", matches a listed term in its own spelling or in lower case: with
"red-kite" listed, "red_kite", "red kite" and "Red-Kite" all match.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

TERMS: dict[str, str] = {}  # digest -> kind, from the private list (load_terms)
TERMS_VAR = "THIMBLE_PRIVATE_TERMS"
TERMS_FILE_VAR = "THIMBLE_PRIVATE_TERMS_FILE"
TERMS_FILE = "~/.config/thimble/private-terms"
KINDS = ("private", "maintainer")
DIGEST = re.compile(r"[0-9a-f]{64}")
# The files that name the maintainer on purpose: the marketplace owner, the contact address and the maintainer notes.
MAINTAINER_FILES = {".claude-plugin/marketplace.json", "CLAUDE.md", "README.md", "backend/app/feedback.py"}
# Third-party texts, lockfiles and the built UI (a release's): other people's names, generated hashes and minified
# names, checked for secrets and file kinds only.
EXEMPT = re.compile(r"^(LICENSE|THIRD_PARTY_NOTICES|backend/app/fonts/OFL-[\w-]+\.txt|backend/uv\.lock|"
                    r"frontend/package-lock\.json|frontend/dist/.+)$")
NEVER = re.compile(r"(^|/)(__pycache__|node_modules|\.venv)(/|$)|^(data|dev|notes|context|experiments|"
                   r"workspaces[^/]*|\.claude|docs/archive|docs/proposals)/|\.(db|sqlite3?|jsonl|pyc)$")
# the worked examples' invented sample files, in their folders, which are data on purpose
SAMPLES = re.compile(r"^plugin/viewers/[\w-]+/sample/.+$")
MAX_BYTES = 2_000_000
# the extension a module import leaves out, with TypeScript's declaration suffix (types.d.ts is the module ./types)
EXTENSION = re.compile(r"(?<=.)(\.d)?\.[^.]+$")
WORD = re.compile(r"[^\W_]+")
_digests: dict[str, str] = {}


def digest(term: str) -> str:
    if term not in _digests:
        _digests[term] = hashlib.sha256(term.encode()).hexdigest()
    return _digests[term]


def load_terms(env: dict[str, str]) -> tuple[dict[str, str] | None, str]:
    """The private list as {digest: kind} and where it was read, or None and where it was looked for. Raises
    ValueError on a line that is not `<kind> <term>` and on a THIMBLE_PRIVATE_TERMS_FILE that does not exist."""
    if env.get(TERMS_VAR, "").strip():
        text, source = env[TERMS_VAR], f"${TERMS_VAR}"
    else:
        named = env.get(TERMS_FILE_VAR, "")
        path = Path(named or TERMS_FILE).expanduser()
        if not path.is_file():
            if named:
                raise ValueError(f"{TERMS_FILE_VAR} names {path}, which is not a file")
            return None, f"${TERMS_VAR}, ${TERMS_FILE_VAR} or {TERMS_FILE}"
        text, source = path.read_text(), str(path)
    terms = {}
    for n, line in enumerate(text.splitlines(), 1):
        parts = line.split(None, 1)
        if not parts or parts[0].startswith("#"):
            continue
        if len(parts) != 2 or parts[0] not in KINDS:
            raise ValueError(f"{source}:{n}: expected <{'|'.join(KINDS)}> <term>")
        kind, term = parts[0], parts[1].strip()
        terms[term if DIGEST.fullmatch(term) else digest(term)] = kind
    return terms, source


def listed(term: str) -> str | None:
    """The kind of a word or word pair that TERMS lists, in its own spelling or in lower case."""
    return TERMS.get(digest(term)) or TERMS.get(digest(term.lower()))


def files_of(root: Path) -> list[str]:
    """Tracked files plus untracked ones git does not ignore, in a checkout; every file, in a plain folder."""
    if (root / ".git").exists():
        out = subprocess.run(["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                             capture_output=True, check=True).stdout.decode()
        return sorted({p for p in out.split("\0") if p and (root / p).is_file()})
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*")
                  if p.is_file() and ".git" not in p.relative_to(root).parts)


def scan(root: Path, rels: list[str]) -> list[tuple[str, int, str, str]]:
    """Every hit as (path, line, kind, matched text)."""
    hits = []
    for rel in rels:
        p = root / rel
        if NEVER.search(rel) and not SAMPLES.match(rel):
            hits.append((rel, 0, "path", "a file of a kind that never belongs in the tree"))
        if p.stat().st_size > MAX_BYTES:
            hits.append((rel, 0, "path", f"{p.stat().st_size} bytes, over {MAX_BYTES}"))
        data = p.read_bytes()
        if b"\0" in data[:8192] or EXEMPT.match(rel):
            continue
        for n, line in enumerate(data.decode(errors="replace").splitlines(), 1):
            words = WORD.findall(line)
            for i, w in enumerate(words):
                for term in (w, f"{w}-{words[i + 1]}" if i + 1 < len(words) else None):
                    kind = term and listed(term)
                    if kind and not (kind == "maintainer" and rel in MAINTAINER_FILES):
                        hits.append((rel, n, kind, term))
    return hits


def case_clashes(rels: list[str]) -> list[tuple[str, int, str, str]]:
    """The files and folders whose names a case-insensitive disk or module resolver cannot tell apart."""
    names: dict[tuple[str, str], set[str]] = defaultdict(set)
    folders: dict[str, set[str]] = defaultdict(set)
    for rel in rels:
        folder, _, name = rel.rpartition("/")
        names[(folder.casefold(), EXTENSION.sub("", name).casefold())].add(rel)
        while folder:
            folders[folder.casefold()].add(folder)
            folder = folder.rpartition("/")[0]
    hits = []
    for group in names.values():
        stems = {EXTENSION.sub("", rel.rpartition("/")[2]) for rel in group}
        if len(stems) > 1:
            for rel in sorted(group):
                others = ", ".join(r.rpartition("/")[2] for r in sorted(group) if r != rel)
                hits.append((rel, 0, "case", f"differs from {others} only by case, without the extension"))
    for group in folders.values():
        if len(group) > 1:
            for folder in sorted(group):
                others = ", ".join(f for f in sorted(group) if f != folder)
                hits.append((folder + "/", 0, "case", f"this folder differs from {others} only by case"))
    return hits


def gitleaks(root: Path, rels: list[str]) -> list[tuple[str, int, str, str]]:
    """gitleaks over a copy of exactly the checked files, so installed packages and ignored files are not scanned."""
    exe = shutil.which("gitleaks")
    if not exe:
        return [(".", 0, "secret", "gitleaks is not installed (install it, or pass --no-gitleaks)")]
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "tree"
        for rel in rels:
            (copy / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / rel, copy / rel)
        report = Path(tmp) / "gitleaks.json"
        r = subprocess.run([exe, "dir", str(copy), "--no-banner", "--redact", "--report-format", "json",
                            "--report-path", str(report), "--exit-code", "0", "--log-level", "error"],
                           capture_output=True, text=True)
        if r.returncode != 0 or not report.is_file():
            return [(".", 0, "secret", f"gitleaks failed: {(r.stderr or r.stdout).strip()[:300]}")]
        found = json.loads(report.read_text() or "[]")
        out = []
        for f in found:
            path = Path(f.get("File", ""))
            rel = path.relative_to(copy).as_posix() if path.is_relative_to(copy) else str(path)
            what = f"{f.get('RuleID', '?')}: {f.get('Description', '')}"
            out.append((rel, int(f.get("StartLine", 0)), "secret", what))
        return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("dir", type=Path, nargs="?", default=Path(__file__).resolve().parent.parent)
    ap.add_argument("--no-gitleaks", action="store_true")
    ap.add_argument("--digest", metavar="TERM")
    a = ap.parse_args()
    if a.digest:
        print(f"private {digest(a.digest)}")
        return 0
    root = a.dir.resolve()
    if not root.is_dir():
        print(f"check_content: {root} is not a directory", file=sys.stderr)
        return 2
    try:
        terms, source = load_terms(dict(os.environ))
    except (OSError, UnicodeDecodeError, ValueError) as e:
        print(f"check_content: the private list: {e}", file=sys.stderr)
        return 2
    if terms is None:
        print(f"check_content: no private list ({source}), so private and maintainer names are not checked")
    else:
        TERMS.update(terms)
    rels = files_of(root)
    hits = scan(root, rels) + case_clashes(rels) + ([] if a.no_gitleaks else gitleaks(root, rels))
    for rel, n, kind, text in sorted(hits):
        print(f"{rel}:{n}: [{kind}] {text}")
    kinds = ", ".join(f"{k} {v}" for k, v in Counter(h[2] for h in hits).most_common())
    secrets = "without the secret scan" if a.no_gitleaks else "with gitleaks"
    names = "without the private list" if terms is None else f"with the private list ({len(terms)} terms)"
    print(f"check_content: {len(rels)} files, {secrets}, {names}: "
          + (f"{len(hits)} hits ({kinds})" if hits else "no hits"))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
