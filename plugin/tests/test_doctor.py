"""thimble doctor (engine/kernel/doctor.py): a checklist for a person in a shell, one line per part, ✓ when it works and
× with the step that fixes it on the line below. The world is test_fixes.py's made-up thimble 0.10.2; claude and node
are fakes, alone on PATH with git and curl (which reads the newest release from a stand-in for GitHub, upstream). All
data here is made up."""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, fake, made, upstream, world  # noqa: E402, F401  (world and upstream are fixtures)

from kernel import cli, doctor, tour  # noqa: E402


def answers(node: str, sandbox: dict) -> str:
    """A made-up node's script: its version, and for the sandbox's check (setup.mjs --json) this answer."""
    return f"case \"$1\" in --version) echo {node};; *) echo '{json.dumps(sandbox)}';; esac"


def doctor_world(w, monkeypatch, claude="2.1.316", enabled=True, node="v22.20.0", sandbox=None) -> Path:
    """The made-up thimble's plugin as the one that runs, and a claude and a node that answer as given: claude's
    version and its plugin list, node's version and the answer of the sandbox's check."""
    plugin = w["rel"] / "plugin"
    (plugin / "sandbox" / "setup.mjs").write_text("// the made-up node answers for it\n")
    monkeypatch.setattr(FX, "PLUGIN", plugin)
    bin_ = w["tmp"] / "doctor-bin"
    bin_.mkdir()
    (bin_ / "git").symlink_to(shutil.which("git"))
    (bin_ / "curl").symlink_to(shutil.which("curl"))
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
    bin_ = doctor_world(world, monkeypatch, claude="2.1.305", enabled=False, node="v22.14.0",
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
        "  × Claude Code 2.1.305 is older than 2.1.307, which thimble needs":
            "      Update it with the package manager that installed it, or: claude update",
        "  × the thimble plugin is off in Claude Code": "      Turn it on: claude plugin enable thimble@thimble",
        "  × Node 22.14.0 is older than 22.18, which thimble's plugin needs":
            "      Install Node 22.18 or later, from your system's packages or https://nodejs.org",
        "  × the sandbox that cards run in does not work: the card runner did not answer in 15 s":
            f"      See its whole message: node {FX._tilde(str(setup))} --probe",
        f"  × the thimble command ({FX._tilde(str(link))}) is not on PATH":
            "      Add this line to your shell's startup file (~/.zshrc or ~/.bashrc): "
            f"export PATH=\"{link.parent}:$PATH\"",
        "  × 1 of your fixes is set aside since thimble update": "      Bring it back: thimble reapply",
        "  × thimble 0.10.3 is out (you have 0.10.2)": "      Get it: thimble update",
    }
    # a terminal-only install is a choice, not a problem: a – line, with the step that adds the workbench
    i = out.index("  – the browser workbench is not installed")
    assert out[i + 1] == "      To add it, run the install again without --no-browser (INSTALL.md)"
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
    # the doctor looks for a newer release on a page, and downloads no release's file
    assert world["gh"].requests().count("GET /releases/latest") == 1 and world["gh"].files() == []
    # a page that names no release: the line below says what GitHub answered, as a sentence
    world["gh"].refuse(404)
    assert cli.main(["doctor"]) == 1
    out = capsys.readouterr().out.splitlines()
    i = out.index("  × thimble could not look for a newer release")
    assert out[i + 1] == (f"      Thimble found no release at {world['gh'].url} (GitHub answered 404); run thimble "
                          "update again")


def test_a_workbench_without_the_headless_chromium_it_checks_cards_in_says_so_with_the_command_that_fetches_it(
        world, monkeypatch, capsys):
    """The workbench checks a card by its picture, which it draws in a headless Chromium: Playwright's, where it finds
    no system browser. thimble doctor asks the workbench's own check (python -m app.headless): one that lacks it is a
    × line, with the command that fetches it on the line below; one that has it adds no line."""
    doctor_world(world, monkeypatch)
    b = world["tmp"] / "live-browser"
    (b / "scripts").mkdir(parents=True)
    (b / "backend" / ".venv" / "bin").mkdir(parents=True)
    fake(b / "scripts" / "thimble-browser", world["log"])
    lacks = {"ok": False, "why": "no headless Chromium, so cards are not checked", "fix": "Fetch it: made-up command"}
    fake(b / "backend" / ".venv" / "bin" / "python", world["log"], f"echo '{json.dumps(lacks)}'")
    FX.home().mkdir(parents=True, exist_ok=True)
    (FX.home() / "browser-ready").write_text(f"{b}\n")
    assert cli.main(["doctor", "--offline"]) == 1
    out = capsys.readouterr().out.splitlines()
    i = out.index("  × the browser workbench has no headless Chromium, so cards are not checked")
    assert out[i - 1:i + 2] == [f"  ✓ the browser workbench: {FX._tilde(str(b / 'scripts' / 'thimble-browser'))}",
                                "  × the browser workbench has no headless Chromium, so cards are not checked",
                                "      Fetch it: made-up command"]
    assert "-m app.headless" in world["log"].read_text().splitlines()
    fake(b / "backend" / ".venv" / "bin" / "python", world["log"], "echo '{\"ok\": true}'")
    cli.main(["doctor", "--offline"])
    assert "headless Chromium" not in capsys.readouterr().out


def test_each_place_that_names_the_claude_code_thimble_needs_names_the_one_ci_tests():
    """CI runs the plugin's tests (.github/workflows/ci.yml) on the oldest Claude Code that has what the plugin calls,
    and on the first that places the tour's rows ($.ui.place). The doctor, the install, INSTALL.md, the README,
    scripts/check.sh and the workbench (TESTED_CLAUDE_CODE) name the oldest; thimble tour, the install's end, INSTALL.md,
    the README, the plugin's tour and its hooks tests name the tour's. A pin raised for a newer call fails here until each
    of them names it too."""
    root = Path(__file__).resolve().parents[2]
    v = r"(\d+\.\d+\.\d+)"
    numbers = lambda s: tuple(map(int, s.split(".")))  # noqa: E731
    tested = sorted({m for m in re.findall(rf"claude: {v}", (root / ".github" / "workflows" / "ci.yml").read_text())},
                    key=numbers)
    assert len(tested) == 2, tested
    pin, tour_pin = tested
    assert ".".join(map(str, doctor.CLAUDE_CODE_MIN)) == pin, "plugin/engine/kernel/doctor.py"
    assert ".".join(map(str, tour.CLAUDE_CODE_MIN)) == tour_pin, "plugin/engine/kernel/tour.py"
    for path, named in (("scripts/install.sh", r"tour_cc=(\S+)"),
                        ("INSTALL.md", rf"the tour needs {v} or later"),
                        ("README.md", rf"{v}\+ for the tour"),
                        ("plugin/tour/tour.ts", rf"TOUR_CLAUDE_CODE = '{v}'|Claude Code {v} or later"),
                        ("plugin/tests/kit.ts", rf"'ui\.place': '{v}'")):
        found = {g for m in re.finditer(named, (root / path).read_text()) for g in m.groups() if g}
        assert found == {tour_pin}, path
    for path, named in (("scripts/install.sh", rf'ver_ge "\$v" {v}|Claude Code {v} or later'),
                        ("INSTALL.md", rf"Claude Code {v} or later|Claude Code is older than {v}"),
                        ("README.md", rf"Claude Code {v}\+"),
                        ("scripts/check.sh", rf"Claude Code {v} or later"),
                        ("browser/backend/app/cli.py", rf'TESTED_CLAUDE_CODE = "{v}"')):
        found = {g for m in re.finditer(named, (root / path).read_text()) for g in m.groups() if g}
        assert found == {pin}, path
