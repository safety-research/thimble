#!/usr/bin/env python3
"""Check the repo's files for content that must not be committed: secrets and files of kinds that never belong in the
tree. scripts/check.sh and CI run it.

    python3 scripts/check_content.py [DIR] [--no-gitleaks]

    DIR            the tree to check (default: this repo, its tracked files plus untracked ones git does not ignore);
                   a folder that is not a git checkout is checked whole
    --no-gitleaks  skip the secret scan (CI always runs it)

Kinds of hit:
    path        a file of a kind that never belongs in the tree (data, databases, captures, caches, a file over 2 MB)
    case        a file whose name differs from another's in its folder only by case once the extension is dropped, or
                a folder whose path differs from another's only by case: on a case-insensitive disk (macOS, Windows)
                an import of ./Checks can load checks.ts in place of Checks.tsx, and the two folders are one
    secret      a gitleaks finding
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

NEVER = re.compile(r"(^|/)(__pycache__|node_modules|\.venv)(/|$)|^(data|dev|notes|context|experiments|"
                   r"workspaces[^/]*|\.claude|docs/archive|docs/proposals)/|\.(db|sqlite3?|jsonl|pyc)$")
# the invented sample files of the worked examples and of the extensions' views and card types, in their folders, which
# are data on purpose
SAMPLES = re.compile(r"^(plugin/viewers|extensions/[\w-]+/(views|cards))/[\w-]+/sample/.+$")
MAX_BYTES = 2_000_000
# the extension a module import leaves out, with TypeScript's declaration suffix (types.d.ts is the module ./types)
EXTENSION = re.compile(r"(?<=.)(\.d)?\.[^.]+$")


def files_of(root: Path) -> list[str]:
    """Tracked files plus untracked ones git does not ignore, in a checkout; every file, in a plain folder."""
    if (root / ".git").exists():
        out = subprocess.run(["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                             capture_output=True, check=True).stdout.decode()
        return sorted({p for p in out.split("\0") if p and (root / p).is_file()})
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*")
                  if p.is_file() and ".git" not in p.relative_to(root).parts)


def scan(root: Path, rels: list[str]) -> list[tuple[str, int, str, str]]:
    """The files of kinds that never belong in the tree, and those over MAX_BYTES, as (path, 0, "path", why)."""
    hits = []
    for rel in rels:
        p = root / rel
        if NEVER.search(rel) and not SAMPLES.match(rel):
            hits.append((rel, 0, "path", "a file of a kind that never belongs in the tree"))
        if p.stat().st_size > MAX_BYTES:
            hits.append((rel, 0, "path", f"{p.stat().st_size} bytes, over {MAX_BYTES}"))
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
    a = ap.parse_args()
    root = a.dir.resolve()
    if not root.is_dir():
        print(f"check_content: {root} is not a directory", file=sys.stderr)
        return 2
    rels = files_of(root)
    hits = scan(root, rels) + case_clashes(rels) + ([] if a.no_gitleaks else gitleaks(root, rels))
    for rel, n, kind, text in sorted(hits):
        print(f"{rel}:{n}: [{kind}] {text}")
    kinds = ", ".join(f"{k} {v}" for k, v in Counter(h[2] for h in hits).most_common())
    secrets = "without the secret scan" if a.no_gitleaks else "with gitleaks"
    print(f"check_content: {len(rels)} files, {secrets}: "
          + (f"{len(hits)} hits ({kinds})" if hits else "no hits"))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
