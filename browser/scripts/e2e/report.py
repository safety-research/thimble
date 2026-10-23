"""Write the end-to-end test's report (scripts/e2e_release.sh) from its results.jsonl, and say whether the run passed.

    python3 scripts/e2e/report.py <results.jsonl> <report.md> --ref REF --commit SHA --started TS --seconds N [--strict]
                                  [--claude-code VERSION] [--tested-claude-code VERSION]

Each line of results.jsonl is one step: {step, status, detail, shots, title?, pending?}. A failing step with `pending`
waits for work that is not merged yet: it is reported as expected and fails the run only with --strict. The report's
first line names the Claude Code the run used (--claude-code) and says when it is not the version the ref under test
names as tested (--tested-claude-code, its TESTED_CLAUDE_CODE). Exit 0 when no step failed, 1 otherwise.
"""
import argparse
import json
import sys
from pathlib import Path

TITLES = {
    "clone": "A fresh clone of the ref",
    "zip": "The release zip",
    "install": "install.sh, non-interactive, into a fresh THIMBLE_HOME with the caller's HOME and Claude login",
    "doctor": "thimble doctor",
    "corpus": "A copy of the corpus, with the files the UI steps open",
    "server": "The server up and the corpus copy opened as a workspace",
    "cleanup": "Every process the run started is stopped",
    "claude-files": "The caller's Claude Code plugins, marketplaces, trusted folders and ~/.local/bin/thimble are as they were",
    "contract-print": "The `claude -p` contract check against Claude Code (THIMBLE_LIVE_CLAUDE=1)",
    "contract-module": "The interactive contract check of thimble's hooks module (THIMBLE_LIVE_CLAUDE=1)",
}


def verdict(r: dict, strict: bool) -> str:
    """pass, fail, skip, expected (a pending step that failed) or newly passing (a pending step that passed)."""
    if r.get("pending") and not strict:
        return {"fail": "expected", "pass": "now passes"}.get(r["status"], r["status"])
    return r["status"]


def claude_code_heading(have: str, tested: str) -> str:
    """report.md's first line: the Claude Code the run used, flagged when it is not the tested version."""
    if not have:
        return "# thimble end-to-end test, Claude Code not found"
    if not tested:
        return f"# thimble end-to-end test, Claude Code {have} (the version thimble is tested with was not read)"
    if have != tested:
        return f"# thimble end-to-end test, Claude Code {have}: NOT the tested version (TESTED_CLAUDE_CODE is {tested})"
    return f"# thimble end-to-end test, Claude Code {have}, the tested version"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("report")
    ap.add_argument("--ref", default="")
    ap.add_argument("--commit", default="")
    ap.add_argument("--started", default="")
    ap.add_argument("--seconds", default="")
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--claude-code", default="", help="the version `claude --version` printed in the run")
    ap.add_argument("--tested-claude-code", default="", help="TESTED_CLAUDE_CODE of the ref under test")
    a = ap.parse_args()
    rows = [json.loads(ln) for ln in Path(a.results).read_text("utf-8").splitlines() if ln.strip()]
    marks = [verdict(r, a.strict) for r in rows]
    failed = marks.count("fail")
    counts = {m: marks.count(m) for m in ("pass", "fail", "expected", "now passes", "skip") if marks.count(m)}
    out = [
        claude_code_heading(a.claude_code.strip(), a.tested_claude_code.strip()),
        "",
        f"{a.ref} at {a.commit[:12]}, started {a.started}, {a.seconds} s. "
        f"**{'Passed' if not failed else 'Failed'}**: " + ", ".join(f"{n} {m}" for m, n in counts.items()) + ".",
        "",
        "| # | step | result | detail | screenshots |",
        "|---|---|---|---|---|",
    ]
    for i, (r, m) in enumerate(zip(rows, marks), 1):
        title = r.get("title") or TITLES.get(r["step"], r["step"])
        result = {"pass": "pass", "fail": "**FAIL**", "expected": f"expected fail, waits for {r.get('pending')}",
                  "now passes": f"passes (was waiting for {r.get('pending')})", "skip": "skipped"}.get(m, m)
        detail = str(r.get("detail") or "").replace("|", "\\|").replace("\n", " ")
        shots = " ".join(f"[{Path(s).stem}]({s})" for s in r.get("shots") or [])
        out.append(f"| {i} | {title} | {result} | {detail} | {shots} |")
    if "now passes" in marks:
        out += ["", "A step marked as waiting now passes: its pending mark in scripts/e2e/release.mjs can go."]
    out += ["", "Logs are in logs/: install-plan.log, install.log, doctor.txt, server-up.log, workspace.log, ui.log, standin.log, stop.log, "
            "and with THIMBLE_LIVE_CLAUDE=1 contract-print.log, contract-module.log and contract-module-server.log; the contract "
            "checks' evidence is in contract-print/ and contract-module/."]
    Path(a.report).write_text("\n".join(out) + "\n", "utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
