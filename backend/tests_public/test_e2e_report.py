"""The release test's report (scripts/e2e/report.py): its first line names the Claude Code the run used and flags one
that is not the version thimble is tested with, which scripts/e2e_release.sh reads from the ref's cli.py."""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

from app import cli

ROOT = Path(__file__).resolve().parents[2]
TESTED = cli.TESTED_CLAUDE_CODE


def first_line(tmp_path: Path, *flags: str) -> str:
    results = tmp_path / "results.jsonl"
    results.write_text(json.dumps({"step": "clone", "status": "pass", "detail": "abc", "shots": []}) + "\n")
    report = tmp_path / "report.md"
    subprocess.run([sys.executable, "-I", str(ROOT / "scripts" / "e2e" / "report.py"), str(results), str(report),
                    "--ref", "0.6.0", "--commit", "08a4d6b1", *flags], check=True)
    return report.read_text().splitlines()[0]


def test_the_report_s_first_line_names_claude_code_and_flags_a_version_thimble_is_not_tested_with(tmp_path):
    assert first_line(tmp_path, "--claude-code", TESTED, "--tested-claude-code", TESTED) == (
        f"# thimble end-to-end test, Claude Code {TESTED}, the tested version")
    assert first_line(tmp_path, "--claude-code", "2.1.297", "--tested-claude-code", TESTED) == (
        f"# thimble end-to-end test, Claude Code 2.1.297: NOT the tested version (TESTED_CLAUDE_CODE is {TESTED})")
    assert first_line(tmp_path, "--claude-code", "", "--tested-claude-code", TESTED) == (
        "# thimble end-to-end test, Claude Code not found")
    assert first_line(tmp_path, "--claude-code", TESTED) == (
        f"# thimble end-to-end test, Claude Code {TESTED} (the version thimble is tested with was not read)")


def test_e2e_release_reads_the_tested_version_from_the_line_cli_py_writes_it_on():
    script = (ROOT / "scripts" / "e2e_release.sh").read_text()
    assert """sed -n 's/^TESTED_CLAUDE_CODE = "\\([^"]*\\)".*/\\1/p'""" in script
    assert '--claude-code "$cc_version" --tested-claude-code "$tested"' in script
    found = re.findall(r'^TESTED_CLAUDE_CODE = "([^"]*)"', (ROOT / "backend" / "app" / "cli.py").read_text(), re.M)
    assert found == [TESTED]
