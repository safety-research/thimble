"""CI (.github/workflows/ci.yml) runs every step scripts/check.sh runs by default, each through check.sh, and checks
out the whole history, which the commits step needs to find its base."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_ci_runs_every_default_step_of_check_sh():
    check = (ROOT / "scripts" / "check.sh").read_text()
    default = re.search(r'^\[ -n "\$steps" \] \|\| steps="([^"]+)"', check, re.M).group(1).split()
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    ran = re.findall(r"^\s+run: scripts/check\.sh (\w+)\s*$", ci, re.M)
    assert sorted(s for s in ran if s in default) == sorted(default), "each default step once, in whichever job"
    assert re.search(r"^\s+fetch-depth: 0\b", ci, re.M)
