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
    demo        a file of a pre-cached orientation (demos/<dataset>/) outside the terms of the exception below
    secret      a gitleaks finding

The one exception: demos/<dataset>/. A pre-cached orientation that `thimble demo --export --outputs-only` wrote, which a
maintainer read before committing it (demos/README.md), holds .jsonl files and files over 2 MB. Under demos/<dataset>/
these are allowed, on these terms only (demo_hits):
    - the folder holds the export's manifest, thimble-demo-precache.json with schema thimble-demo-precache and version
      DEMO_VERSION (the outputs alone, no transcript; a full export, the default of `thimble demo --export`, is another
      version and is refused), and its README.md, and every other file in it is one the manifest lists as
      workspace/<path> among its `files`
    - each such <path> is of a kind the export writes (backend/app/demo_scrub.py workspace_kind): the cards
      (notebooks/), the documents (investigations/<name>/*.json), the labels' definitions (concepts/*.json) and values
      (labels/*.jsonl), the views' code and manifests (extension/extension.json, extension/views/<slug>/ view.json and
      .html, .js, .mjs, .css, .py, .md or .svg files outside cache/, views/proposals.json), the orientation's record
      (orient/run.json, orient/summary.md), the orientation's chat meta and its empty log (chats/<id>.meta.json,
      chats/<id>.jsonl) and cited calls (calls/<id>.jsonl); no Claude Code transcript, no work file, no view index or
      cache
    - each such file has the shape the export writes (demo_scrub.shape_findings): no chat but the orientation's
      (the manifest's orientation.chat) and its log empty; in a call log only the calls the manifest's `cited_calls`
      lists, each output at most demo_scrub.CALL_KEPT lines of at most CALL_LINE_CHARS characters; no label row with
      the texts a label marked (`spans`)
    - README.md is there, and holds the manifest's `notice` (the source's own notice, such as mythos-5's canary string)
    - each file is UTF-8 text of a kind the export writes (demo_scrub.TEXT_SUFFIXES: .json, .jsonl, .md, .txt, .py,
      .html, .js, .mjs, .css, .svg), at most DEMO_FILE_MAX bytes, and the folder's files together at most DEMO_TOTAL_MAX
    - each file passes the export's scrub check (demo_scrub.findings): no absolute path under /home, /Users, /mnt or
      /root, and not this machine's user name as a word (unless it is a common one, demo_scrub.COMMON_USERS), except a
      finding the manifest's `flagged` names for that file, which the maintainer kept with --allow-private
The export also refused any file that shares a long stretch with the dataset (backend/app/demo_verbatim.py); that
check needs the dataset, which is not in the tree, so this one cannot repeat it. gitleaks scans these files like every
other, and the other rules (databases, caches, case) still apply to them.
"""
from __future__ import annotations

import argparse
import getpass
import importlib.util
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
# the invented sample files of the worked examples (thimble's and a mod's copy of them) and of the extensions' views and
# card types, in their folders, which are data on purpose
SAMPLES = re.compile(r"^(plugin/viewers|mods/[\w-]+/viewers|extensions/[\w-]+/(views|cards))/[\w-]+/sample/.+$")
MAX_BYTES = 2_000_000
# demos/<dataset>/<file>: a pre-cached orientation, checked by demo_hits instead of NEVER's .jsonl and MAX_BYTES
DEMO = re.compile(r"^demos/([a-z0-9][a-z0-9-]*)/(.+)$")
DEMO_MANIFEST = "thimble-demo-precache.json"
DEMO_SCHEMA = "thimble-demo-precache"
# the outputs alone (backend/app/demo.py VERSION); 2 carried the orientation's transcript, and 4 is the full export
DEMO_VERSION = 3
DEMO_FILE_MAX = 6_000_000
DEMO_TOTAL_MAX = 30_000_000
SCRUB = Path(__file__).resolve().parent.parent / "backend" / "app" / "demo_scrub.py"  # standard library only
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
    """The files of kinds that never belong in the tree, and those over MAX_BYTES, as (path, 0, "path", why). A
    pre-cache's .jsonl files and its size are demo_hits' to check."""
    hits = []
    for rel in rels:
        p = root / rel
        demo = DEMO.match(rel) is not None
        if NEVER.search(rel[: -len(".jsonl")] if demo and rel.endswith(".jsonl") else rel) and not SAMPLES.match(rel):
            hits.append((rel, 0, "path", "a file of a kind that never belongs in the tree"))
        if not demo and p.stat().st_size > MAX_BYTES:
            hits.append((rel, 0, "path", f"{p.stat().st_size} bytes, over {MAX_BYTES}"))
    return hits


def demo_hits(root: Path, rels: list[str]) -> list[tuple[str, int, str, str]]:
    """The files under demos/<dataset>/ outside the terms of the exception (module note), as (path, 0, "demo", why)."""
    groups: dict[str, list[str]] = defaultdict(list)
    for rel in rels:
        m = DEMO.match(rel)
        if m:
            groups[m.group(1)].append(m.group(2))
    if not groups:
        return []
    try:
        spec = importlib.util.spec_from_file_location("demo_scrub", SCRUB)
        scrub = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scrub)
    except (OSError, ImportError, AttributeError) as e:
        return [("demos/", 0, "demo", f"the pre-caches cannot be checked without {SCRUB.name}: {e}")]
    user = getpass.getuser()
    user = "" if user.lower() in scrub.COMMON_USERS else user
    hits = []
    for name, inner in sorted(groups.items()):
        folder = f"demos/{name}"
        try:
            man = json.loads((root / folder / DEMO_MANIFEST).read_text("utf-8"))
        except (OSError, ValueError):
            man = None
        if not isinstance(man, dict) or man.get("schema") != DEMO_SCHEMA:
            hits += [(f"{folder}/{sub}", 0, "demo", f"{folder} has no {DEMO_MANIFEST} of the export") for sub in inner]
            continue
        if man.get("version") != DEMO_VERSION:
            hits += [(f"{folder}/{sub}", 0, "demo", f"{folder} is a pre-cache of version {man.get('version')}, not "
                      f"{DEMO_VERSION} (the outputs alone, with no transcript: `thimble demo --export --outputs-only`)")
                     for sub in inner]
            continue
        listed = {DEMO_MANIFEST, "README.md"} | {f"workspace/{f.get('path')}" for f in man.get("files") or []
                                                 if isinstance(f, dict)}
        kept = {str(x) for x in man.get("flagged") or []}
        try:
            notice_ok = str(man.get("notice") or "") in (root / folder / "README.md").read_text("utf-8")
        except (OSError, UnicodeDecodeError):
            notice_ok = False
        if not notice_ok:
            hits.append((f"{folder}/README.md", 0, "demo", "missing, or without the source's notice the manifest names"))
        total = 0
        for sub in sorted(inner):
            rel, p = f"{folder}/{sub}", root / folder / sub
            size = p.stat().st_size
            total += size
            if sub not in listed:
                hits.append((rel, 0, "demo", f"a file the pre-cache's {DEMO_MANIFEST} does not list"))
                continue
            if sub.startswith("workspace/") and not scrub.workspace_kind(sub[len("workspace/"):]):
                hits.append((rel, 0, "demo", "not one of the orientation's outputs the export writes"))
                continue
            if not sub.lower().endswith(scrub.TEXT_SUFFIXES):
                hits.append((rel, 0, "demo", "not a kind of file the export writes"))
                continue
            if size > DEMO_FILE_MAX:
                hits.append((rel, 0, "demo", f"{size} bytes, over {DEMO_FILE_MAX}"))
                continue
            try:
                text = p.read_text("utf-8")
            except UnicodeDecodeError:
                hits.append((rel, 0, "demo", "not UTF-8 text"))
                continue
            if sub == DEMO_MANIFEST:  # its `flagged` names the findings kept, so it is checked without them
                text = json.dumps({k: v for k, v in man.items() if k != "flagged"}, ensure_ascii=False)
            found = [f for f in scrub.findings(text, user) if f"{sub}: {f}" not in kept]
            hits += [(rel, 0, "demo", f"the export's scrub check: {f}") for f in found]
            if sub.startswith("workspace/"):
                hits += [(rel, 0, "demo", f"not as the export writes it: {f}")
                         for f in scrub.shape_findings(sub[len("workspace/"):], text, man)]
        if total > DEMO_TOTAL_MAX:
            hits.append((folder + "/", 0, "demo", f"{total} bytes in all, over {DEMO_TOTAL_MAX}"))
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
    hits = scan(root, rels) + demo_hits(root, rels) + case_clashes(rels)
    hits += [] if a.no_gitleaks else gitleaks(root, rels)
    for rel, n, kind, text in sorted(hits):
        print(f"{rel}:{n}: [{kind}] {text}")
    kinds = ", ".join(f"{k} {v}" for k, v in Counter(h[2] for h in hits).most_common())
    secrets = "without the secret scan" if a.no_gitleaks else "with gitleaks"
    print(f"check_content: {len(rels)} files, {secrets}: "
          + (f"{len(hits)} hits ({kinds})" if hits else "no hits"))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
