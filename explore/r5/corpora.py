"""The five corpora of views round 5, copied from Matt's testbed (~/dev/thimble/data, see its INDEX.md) into
/mnt/store/scratch/rel/views-r5/corpora/<key>/ and made read-only, as round 4's corpora are.

    python3 -I explore/r5/corpora.py [--only KEY ...] [--force]

  pandas-swarm    the whole dataset: 16 runs of a 48-agent coding swarm on a pandas fork (forge.db, events.jsonl,
                  board.jsonl, each agent's transcripts) and the harness that ran them
  ml-tasks        a slice: 11 of the 24 Claude Code runs on long ML and software tasks, every task family once or twice
                  and each condition (specified, underspecified, fan-out, goal): prompt, main transcript, session-data
                  (subagents, workflows, memory) and what the run left in its folder, without .git folders, symlinks
                  and files over 2 MB outside the transcript and session-data (the whole dataset is about 12 GB, 11 of
                  them one run's chess checkpoints)
  collusion-wiki  the whole dataset: a wiki's pages, revisions, events and labels (jsonl)
  rosetta         the whole dataset: 11 episodes, three users' conversations each (json)
  pilot           the whole dataset: the pilot study's 7 participants, each a screen recording (mp4), a speech
                  transcript (md) and the thimble workspace they returned

The sources are only read. Nothing from these corpora leaves the machine."""
from __future__ import annotations

import argparse
import os
import shutil
import stat
import sys
from pathlib import Path

SRC = Path.home() / "dev" / "thimble" / "data"
OUT = Path("/mnt/store/scratch/rel/views-r5/corpora")
BIG = 2 * 1024 * 1024  # ml-tasks: files over this, outside the transcript and session-data, are left out
ML_RUNS = ("annotation-platform__specified", "annotation-platform__underspecified", "bandit-sim__specified",
           "clarifying-questions__underspecified", "displacement-forge__specified", "esm-platform__specified-fan-out",
           "habit-tracker__underspecified", "rl-20q__specified", "tracekit__specified", "tracekit__underspecified",
           "chess-nano__goal")
SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__"}


def copy_whole(key: str):
    def make(dest: Path) -> str:
        shutil.copytree(SRC / key, dest, symlinks=True, dirs_exist_ok=True)
        return f"copy of {SRC / key}"
    return make


def ml_tasks(dest: Path) -> str:
    kept = dropped = 0
    for run in ML_RUNS:
        src = SRC / "ml-tasks" / run
        for root, dirs, files in os.walk(src):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not (Path(root) / d).is_symlink())
            r = Path(root).relative_to(src)
            whole = r.parts[:1] == ("session-data",)
            for name in sorted(files):
                p = Path(root) / name
                if p.is_symlink():
                    dropped += 1
                    continue
                if not whole and name != "transcript.jsonl" and p.stat().st_size > BIG:
                    dropped += 1
                    continue
                out = dest / run / r / name
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, out)
                kept += 1
    return f"{len(ML_RUNS)} runs, {kept} files kept, {dropped} left out (symlinks, files over 2 MB)"


CORPORA = {"pandas-swarm": copy_whole("pandas-swarm"), "ml-tasks": ml_tasks,
           "collusion-wiki": copy_whole("collusion-wiki"), "rosetta": copy_whole("rosetta"),
           "pilot": copy_whole("pilot")}


def writable(p: Path) -> None:
    for d in [p, *p.rglob("*")]:
        if not d.is_symlink():
            os.chmod(d, os.stat(d).st_mode | stat.S_IWUSR)


def read_only(p: Path) -> None:
    for d in [*p.rglob("*"), p]:
        if not d.is_symlink():
            os.chmod(d, os.stat(d).st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append", choices=sorted(CORPORA))
    ap.add_argument("--force", action="store_true", help="replace a corpus folder that exists")
    a = ap.parse_args()
    for key in a.only or list(CORPORA):
        dest = OUT / key
        if dest.exists():
            if not a.force:
                print(f"{key}: {dest} exists (--force replaces it)")
                continue
            writable(dest)
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        what = CORPORA[key](dest)
        read_only(dest)
        files = [p for p in dest.rglob("*") if p.is_file()]
        size = sum(p.stat().st_size for p in files)
        print(f"{key}: {what}; {len(files)} files, {size / 1e6:.1f} MB in {dest}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
