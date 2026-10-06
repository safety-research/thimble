"""CI (.github/workflows/ci.yml) runs every step scripts/check.sh runs by default, each through check.sh."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_ci_runs_every_default_step_of_check_sh():
    check = (ROOT / "scripts" / "check.sh").read_text()
    default = re.search(r'^\[ -n "\$steps" \] \|\| steps="([^"]+)"', check, re.M).group(1).split()
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    ran = re.findall(r"^\s+run: scripts/check\.sh (\w+)\s*$", ci, re.M)
    assert sorted(s for s in ran if s in default) == sorted(default), "each default step once, in whichever job"


def test_the_claude_code_canary_runs_on_a_schedule_or_by_hand_never_on_a_pull_request_and_needs_no_secret():
    """The daily job (.github/workflows/claude-code-canary.yml) installs the newest Claude Code and runs `claude plugin
    validate --strict` on thimble's plugins; it calls no model, so it needs no secret, and runs no pull request's code."""
    import yaml

    text = (ROOT / ".github" / "workflows" / "claude-code-canary.yml").read_text()
    wf = yaml.safe_load(text)
    assert set(wf.get("on", wf.get(True))) == {"schedule", "workflow_dispatch"}
    assert "secrets." not in text and "@anthropic-ai/claude-code@latest" in text
    ran = re.findall(r"^\s+run: (claude plugin validate --strict \S+)\s*$", text, re.M)
    assert ran == ["claude plugin validate --strict plugin", "claude plugin validate --strict mods/thimble-cc-mod",
                   "claude plugin validate --strict ."]
