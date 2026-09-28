#!/usr/bin/env python3
"""Check the repo's files for content that must not be committed: secrets, private names, and files of kinds that
never belong in the tree; or, with --commits, the messages of a range of commits. scripts/check.sh and CI run it.

    python3 scripts/check_content.py [DIR] [--no-gitleaks]
    python3 scripts/check_content.py --commits RANGE [DIR]
    python3 scripts/check_content.py --digest TERM

    DIR            the tree to check (default: this repo, its tracked files plus untracked ones git does not ignore);
                   a folder that is not a git checkout is checked whole
    --no-gitleaks  skip the secret scan (CI always runs it)
    --commits RANGE
                   check the messages of the commits in RANGE (a git revision range, such as origin/main..HEAD) instead
                   of the files; the commits that SESSION_LINES_UNTIL's commits reach are left out
    --digest TERM  print the line that adds TERM to TERMS, and exit

Kinds of hit:
    private     a name that belongs to private material: a corpus, a machine, a home folder, an unreleased name
    maintainer  the maintainer's name or address outside the files that carry it on purpose (MAINTAINER_FILES)
    path        a file of a kind that never belongs in the tree (data, databases, captures, caches, a file over 2 MB)
    case        a file whose name differs from another's in its folder only by case once the extension is dropped, or
                a folder whose path differs from another's only by case: on a case-insensitive disk (macOS, Windows)
                an import of ./Checks can load checks.ts in place of Checks.tsx, and the two folders are one
    secret      a gitleaks finding
    session     a commit message line that is a Claude-Session: trailer or holds a link to a Claude Code session, which
                is private (--commits)

TERMS holds SHA-256 digests rather than the words, so the list does not publish the names it keeps out. A word of a
line, or two neighbouring words joined with "-", matches when its digest is listed, in its own spelling or in lower
case: with the digest of "red-kite" listed, "red_kite", "red kite" and "Red-Kite" all match.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

TERMS: dict[str, str] = {
    "84a4b19e19aa4e2a562ae0286b1e188ef4f4f9a98a92b8730d20a1e0f2882523": "maintainer",
    "edd2916124c93479ced1dd30f618d002478a35eeec25f633c33b9de974e201ad": "maintainer",
    "ca20bc284dca33ca4a0b37047d96317dcebd8a1159f8eaa8846284cabffa5508": "maintainer",
    "966cee0ffd2059c07ad04128c6dbe073270254c6cc37194f4af3ac1dae745037": "maintainer",
    "0765290967c4542befc6ed93b0a69d7254e58dedb1823a3936c0192059a0e7b7": "maintainer",
    "40faadd855a600fd8e1125f1227cf2f3c7758b514a1b57e9558e25bd6f0d9346": "maintainer",
    "2269a2f862c3ec36d8e6ff5a9391f7a160b6bef68cca09b61f33aee46b7901da": "maintainer",
    "9a6285a78267e722658e50cf74550ecb47340dd93cf003c8d23327af2947ee72": "private",
    "7ff547fd1e7e3c6d57c91ba24966f7e6346be29c98431130b246982ebd4cbbbc": "private",
    "040e0f2afab838a1bb8917e50104daec7a677cf0d97d219b750052dcf1bbcecd": "private",
    "78a1b7778633522827c4d4a27776b59922351cddd2203ed65c72272ba0c3bfa1": "private",
    "3c7a4b6f9fdb74d9892cca93e119bfb25fd3f6ad2517d01ca9c4d87c6e617c8c": "private",
    "2ff8ddd61f5e0a0c72ad9390b7c448e32b5055707f1be2e65a361b24f2a180ce": "private",
    "553133ea03bb73bd9d747281fdfc7d1164d8cb59f4d638d198c7443c681c6848": "private",
    "bfee7d219a3ef750e97b5f573536eb919730559e698210747ece4d19b4a6afa6": "private",
    "7b8913941bd60ec5fbd1c8c0c1506231973263f3357af5fe7ae5c64e78551289": "private",
    "11aa2d6d6532859ee020bec416be2ef13c8d96f181086666e7433ce5fece163e": "private",
    "b2b692d7fbee7c2222f8a7cb43334d6febf135723c1941b461a6aca25d8e2d30": "private",
    "426e5e34acd037d3c6f4066c81a101fdd0e6bfeb6e06740e3b45fc7104279add": "private",
    "9fe37cb898d86ea769163a95ac48d5fe5241e40dc4ec9c8b938563d8832f4dbc": "private",
    "0e420f434786a4e4f6ef9ffc3330fcca43cf37a95cda0b239a8c488448b3f745": "private",
    "aa033bda2a7c6092d9d81213bfdfc7179f525d8f2801e55eb1252ba22bfb6cb6": "private",
    "2b61e117ac894f8ac9a777f7298b4952212712f9f3b76a77c54c16cab7d891a8": "private",
    "1db75045812446d78b988690eee79ba892125fd58edb1554b6d54dc6de2f148e": "private",
}
# The files that name the maintainer on purpose: the marketplace owner, the contact address and the maintainer notes.
MAINTAINER_FILES = {".claude-plugin/marketplace.json", "CLAUDE.md", "README.md", "backend/app/feedback.py"}
# Third-party texts, lockfiles and the built UI (a release's): other people's names, generated hashes and minified
# names, checked for secrets and file kinds only.
EXEMPT = re.compile(r"^(LICENSE|THIRD_PARTY_NOTICES|backend/app/fonts/OFL-[\w-]+\.txt|backend/uv\.lock|"
                    r"frontend/package-lock\.json|frontend/dist/.+)$")
NEVER = re.compile(r"(^|/)(__pycache__|node_modules|\.venv)(/|$)|^(data|dev|notes|context|experiments|"
                   r"workspaces[^/]*|\.claude|docs/archive|docs/proposals)/|\.(db|sqlite3?|jsonl|pyc)$")
# the worked examples' invented sample files, in any folder of a sample, which are data on purpose
SAMPLES = re.compile(r"^plugin/viewers/[\w-]+/sample/(?:[\w-]+/)*[^/]+$")
MAX_BYTES = 2_000_000
SESSION_LINE = re.compile(r"^\s*claude-session:|claude\.ai/code/session_", re.I)
# The newest commits, one per branch, made before messages were checked. They and the commits they reach keep their
# messages, since the history is not rewritten.
SESSION_LINES_UNTIL = ("bab9a2fece178f9208ecc719f27fbc3af805bc70", "566afdf63861c8d30fef3c132d8f679d263037d6")
# the extension a module import leaves out, with TypeScript's declaration suffix (types.d.ts is the module ./types)
EXTENSION = re.compile(r"(?<=.)(\.d)?\.[^.]+$")
WORD = re.compile(r"[^\W_]+")
_digests: dict[str, str] = {}


def digest(term: str) -> str:
    if term not in _digests:
        _digests[term] = hashlib.sha256(term.encode()).hexdigest()
    return _digests[term]


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


def commit_hits(root: Path, rev_range: str, until: str | tuple[str, ...] | None = SESSION_LINES_UNTIL,
                ) -> list[tuple[str, int, str, str]]:
    """Every session line in the messages of the commits in `rev_range`, as (commit, line, "session", text). The
    commits that `until` (a commit or several) reaches are left out, each when the checkout has it. CalledProcessError
    when git refuses the range."""
    git = ["git", "-C", str(root)]
    revs = [rev_range]
    for old in (until,) if isinstance(until, str) else until or ():
        if subprocess.run([*git, "cat-file", "-e", f"{old}^{{commit}}"], capture_output=True).returncode == 0:
            revs.append(f"^{old}")
    out = subprocess.run([*git, "log", "--format=%H%x00%B%x1e", *revs, "--"], capture_output=True, text=True,
                         check=True).stdout
    hits = []
    for entry in out.split("\x1e"):
        sha, _, body = entry.strip("\n").partition("\0")
        for n, line in enumerate(body.splitlines(), 1):
            if SESSION_LINE.search(line):
                hits.append((sha[:12], n, "session", line.strip()))
    return hits


def check_commits(root: Path, rev_range: str) -> int:
    try:
        hits = commit_hits(root, rev_range)
    except subprocess.CalledProcessError as e:
        print(f"check_content: git cannot list the commits {rev_range}: {e.stderr.strip()[:300]}", file=sys.stderr)
        return 2
    for sha, n, kind, text in hits:
        print(f"{sha}:{n}: [{kind}] {text}")
    print(f"check_content: the commits {rev_range}: " + (f"{len(hits)} hits (session {len(hits)})" if hits else "no hits"))
    return 1 if hits else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("dir", type=Path, nargs="?", default=Path(__file__).resolve().parent.parent)
    ap.add_argument("--no-gitleaks", action="store_true")
    ap.add_argument("--commits", metavar="RANGE")
    ap.add_argument("--digest", metavar="TERM")
    a = ap.parse_args()
    if a.digest:
        print(f'    "{digest(a.digest)}": "private",')
        return 0
    root = a.dir.resolve()
    if not root.is_dir():
        print(f"check_content: {root} is not a directory", file=sys.stderr)
        return 2
    if a.commits:
        return check_commits(root, a.commits)
    rels = files_of(root)
    hits = scan(root, rels) + case_clashes(rels) + ([] if a.no_gitleaks else gitleaks(root, rels))
    for rel, n, kind, text in sorted(hits):
        print(f"{rel}:{n}: [{kind}] {text}")
    kinds = ", ".join(f"{k} {v}" for k, v in Counter(h[2] for h in hits).most_common())
    secrets = "without the secret scan" if a.no_gitleaks else "with gitleaks"
    print(f"check_content: {len(rels)} files, {secrets}: " + (f"{len(hits)} hits ({kinds})" if hits else "no hits"))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
