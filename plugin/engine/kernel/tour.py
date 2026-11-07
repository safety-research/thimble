"""thimble tour: a two-minute tour of thimble, for a person in a shell. It copies the tour's sample data
(plugin/tour/sample) into a folder of its own, $THIMBLE_HOME/tour, and opens Claude Code there with /thimble:tour as
its first prompt (skills/tour/SKILL.md), in Claude Code's fullscreen layout, where the tour's clicks and selections
reach thimble. A copy of the sample that is already there is replaced, so each tour starts from the same data; other
files in the folder stay. Before it opens Claude Code, it says to answer yes when Claude Code asks whether the person
trusts the folder: there, the first choice exits."""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from .store import thimble_home

# the plugin folder this kernel belongs to: its tour's sample data
SAMPLE = Path(__file__).resolve().parents[2] / "tour" / "sample"
# Claude Code's first prompt: the tour's skill
FIRST = "/thimble:tour"
# what makes Claude Code draw its fullscreen layout in this one session
FULLSCREEN = "CLAUDE_CODE_NO_FLICKER"
# Claude Code asks once whether the person trusts a new folder, and its first choice exits
TRUST = "If Claude Code asks whether you trust this folder, choose \"Yes, I trust this folder\"."
IN_CLAUDE_CODE = "it opens Claude Code, so run it in a shell. In this Claude Code session, type /thimble:tour."


def folder() -> Path:
    return thimble_home() / "tour"


def claude() -> str:
    return os.environ.get("THIMBLE_CLAUDE") or "claude"


def _tilde(p: Path) -> str:
    home = str(Path.home())
    s = str(p)
    return "~" + s[len(home):] if s.startswith(home + os.sep) else s


def prepare() -> dict:
    """The tour's folder with a fresh copy of the sample, and how Claude Code starts there: argv, cwd and env."""
    dest = folder()
    dest.mkdir(parents=True, exist_ok=True)
    for f in sorted(SAMPLE.iterdir()):
        if f.is_file():
            shutil.copyfile(f, dest / f.name)
    env = dict(os.environ)
    env.setdefault(FULLSCREEN, "1")
    return {"argv": [claude(), FIRST], "cwd": str(dest), "env": env}


def cmd(a) -> int:
    if os.environ.get("CLAUDECODE") or os.environ.get("THIMBLE_HANDED_OFF"):
        print(f"thimble tour: {IN_CLAUDE_CODE}", file=sys.stderr)
        return 1
    try:
        r = prepare()
    except OSError as e:
        print(f"thimble tour: could not copy the sample data into {_tilde(folder())} ({e.strerror or e}).",
              file=sys.stderr)
        return 1
    print(f"Claude Code opens in {_tilde(Path(r['cwd']))}, with made-up sample data, and starts the tour.\n"
          f"{TRUST}", flush=True)
    try:
        os.chdir(r["cwd"])
        os.execvpe(r["argv"][0], r["argv"], r["env"])
    except OSError as e:
        print(f"thimble tour: could not start {r['argv'][0]} ({e.strerror}). Install Claude Code, or run: "
              f"cd {_tilde(Path(r['cwd']))} && claude {FIRST}", file=sys.stderr)
        return 1
    return 0
