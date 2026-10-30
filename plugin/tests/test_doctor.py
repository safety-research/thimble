"""thimble doctor (engine/kernel/doctor.py): a checklist for a person in a shell, one line per part, ✓ when it works and
× with the step that fixes it on the line below. The world is test_fixes.py's made-up thimble 0.10.2; claude and node
are fakes, alone on PATH with git. All data here is made up."""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, fake, upstream, world  # noqa: E402, F401  (world and upstream are fixtures)

from kernel import cli  # noqa: E402


def answers(node: str, sandbox: dict) -> str:
    """A made-up node's script: its version, and for the sandbox's check (setup.mjs --json) this answer."""
    return f"case \"$1\" in --version) echo {node};; *) echo '{json.dumps(sandbox)}';; esac"


def doctor_world(w, monkeypatch, claude="2.1.312", enabled=True, node="v22.20.0", sandbox=None) -> Path:
    """The made-up thimble's plugin as the one that runs, and a claude and a node that answer as given: claude's
    version and its plugin list, node's version and the answer of the sandbox's check."""
    plugin = w["rel"] / "plugin"
    (plugin / "sandbox" / "setup.mjs").write_text("// the made-up node answers for it\n")
    monkeypatch.setattr(FX, "PLUGIN", plugin)
    bin_ = w["tmp"] / "doctor-bin"
    bin_.mkdir()
    (bin_ / "git").symlink_to(shutil.which("git"))
    listed = json.dumps([{"id": "thimble@thimble", "version": "0.10.2", "enabled": enabled}])
    fake(bin_ / "claude", w["log"], f'case "$1 $2" in "--version ") echo "{claude} (Claude Code)";; '
                                    f"\"plugin list\") echo '{listed}';; esac")
    fake(bin_ / "node", w["log"], answers(node, sandbox or {"ok": True}))
    monkeypatch.setenv("THIMBLE_CLAUDE", str(bin_ / "claude"))
    monkeypatch.setenv("PATH", str(bin_))
    monkeypatch.setenv("THIMBLE_BROWSER_HOME", str(w["tmp"] / "browser-home"))
    return bin_


def test_each_problem_the_doctor_finds_says_how_to_fix_it(world, upstream, monkeypatch, capsys):
    """thimble doctor in a shell: each part that does not work is a × line, and the line below it is the step that
    fixes it, a command to copy where there is one. The sandbox's check runs as the install runs it: it draws a test
    card (setup.mjs --probe) and installs the sandbox again when its own files are broken (--repair)."""
    upstream({"plugin/notes.md": "made-up release note\n"}, "v0.10.3")
    bin_ = doctor_world(world, monkeypatch, claude="2.1.283", enabled=False, node="v22.14.0",
                        sandbox={"ok": False, "why": "the card runner did not answer in 15 s", "fix": ""})
    FX.put({"id": 1, "state": "pending", "title": "Bar says read", "words": ["the bar should say read"]})
    # scripts/install.sh linked the thimble command into a folder that is not on PATH
    (world["rel"] / "plugin" / "bin").mkdir()
    fake(world["rel"] / "plugin" / "bin" / "thimble", world["log"])
    link = world["tmp"] / "local-bin" / "thimble"
    link.parent.mkdir()
    link.symlink_to(world["rel"] / "plugin" / "bin" / "thimble")
    (FX.thimble_home() / "cli-link").write_text(f"{link}\n")
    assert cli.main(["doctor"]) == 1
    out = capsys.readouterr().out.splitlines()
    assert "\x1b[" not in "\n".join(out)  # plain text off a terminal
    assert out[0] == f"  ✓ thimble 0.10.2, the terminal plugin from {FX._tilde(str(world['rel'] / 'plugin'))}"
    fixes = {out[i]: out[i + 1] for i, line in enumerate(out) if line.startswith("  × ")}
    assert all(fix.startswith("      ") and fix.strip() for fix in fixes.values()), out
    setup = world["rel"] / "plugin" / "sandbox" / "setup.mjs"
    assert fixes == {
        "  × Claude Code 2.1.283 is older than 2.1.307, which thimble needs":
            "      Update it with the package manager that installed it, or: claude update",
        "  × the thimble plugin is off in Claude Code": "      Turn it on: claude plugin enable thimble@thimble",
        "  × Node 22.14.0 is older than 22.18, which thimble's plugin needs":
            "      Install Node 22.18 or later, from your system's packages or https://nodejs.org",
        "  × the sandbox that cards run in does not work: the card runner did not answer in 15 s":
            f"      See its whole message: node {FX._tilde(str(setup))} --probe",
        "  × the browser workbench is not installed": "      Install it from a thimble checkout: scripts/install.sh",
        f"  × the thimble command ({FX._tilde(str(link))}) is not on PATH":
            "      Add this line to your shell's startup file (~/.zshrc or ~/.bashrc): "
            f"export PATH=\"{link.parent}:$PATH\"",
        "  × 1 of your fixes is set aside since thimble update": "      Bring it back: thimble reapply",
        "  × thimble 0.10.3 is out (you have 0.10.2)": "      Get it: thimble update",
    }
    assert f"{setup} --json --probe --repair" in world["log"].read_text().splitlines()
    # the fix the sandbox's check gives is the one the doctor says
    fake(bin_ / "node", world["log"], answers("v22.20.0", {
        "ok": False, "why": "this machine lacks what the sandbox needs: bubblewrap (bwrap) not installed",
        "fix": "Install it: sudo apt-get install bubblewrap"}))
    assert cli.main(["doctor", "--offline"]) == 1
    out = capsys.readouterr().out.splitlines()
    i = out.index("  × the sandbox that cards run in does not work: this machine lacks what the sandbox needs: "
                  "bubblewrap (bwrap) not installed")
    assert out[i + 1] == "      Install it: sudo apt-get install bubblewrap"
    assert "  ✓ Node 22.20.0" in out


def test_the_doctor_says_each_part_that_works(world, monkeypatch, capsys):
    """Everything works: a ✓ line for each part, and the exit code 0. A clone install's newest is its checkout's
    commit, which needs no network."""
    bin_ = doctor_world(world, monkeypatch)
    seed = world["tmp"] / "checkout" / "browser"
    (seed / "scripts").mkdir(parents=True)
    (seed / "scripts" / "thimble-browser").write_text("#!/bin/sh\n")
    (seed / "backend" / ".venv").mkdir(parents=True)
    (world["tmp"] / "browser-home").mkdir()
    (world["tmp"] / "browser-home" / "checkout").write_text(f"{seed}\n")
    fake(bin_ / "thimble", world["log"])
    assert cli.main(["doctor"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out == [
        f"  ✓ thimble 0.10.2, the terminal plugin from {FX._tilde(str(world['rel'] / 'plugin'))}",
        "  ✓ Claude Code 2.1.312",
        "  ✓ the thimble plugin is on in Claude Code (0.10.2)",
        "  ✓ Node 22.20.0",
        "  ✓ the sandbox that cards run in works",
        f"  ✓ the browser workbench: {FX._tilde(str(seed / 'scripts' / 'thimble-browser'))}",
        f"  ✓ the thimble command is on PATH ({FX._tilde(str(bin_ / 'thimble'))})",
        f"  ✓ thimble is up to date with your checkout (main at {world['base'][:7]})",
    ]
    # --offline leaves out the look for a newer release
    assert cli.main(["doctor", "--offline"]) == 0
    assert capsys.readouterr().out.splitlines() == out[:-1]
