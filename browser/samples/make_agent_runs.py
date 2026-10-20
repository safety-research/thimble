"""Writes samples/agent-runs/, a small made-up corpus for trying thimble browser and for its tests.

Twenty-four runs of a coding agent on six made-up tasks. Each run is one JSONL file of events; results.csv has one row
per run. Every name, task and message here is invented. Run it again to rebuild the folder: the output is the same
each time (a fixed seed).

    python3 samples/make_agent_runs.py
"""
import csv
import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parent / "agent-runs"
TASKS = {
    "fix-date-parser": "Fix the date parser so it accepts '2026-03-07T10:00' without seconds.",
    "add-csv-export": "Add a CSV export button to the orders page.",
    "flaky-login-test": "Make test_login_redirect stop failing at random.",
    "rename-config-key": "Rename the config key 'retries' to 'max_retries' everywhere.",
    "cache-invalidation": "Clear the product cache when a price changes.",
    "upgrade-http-lib": "Upgrade the HTTP client library to version 3.",
}
CAUSES = {
    "timeout": "the test suite ran past the 20-minute limit",
    "wrong-file": "edited a copy of the module under build/ instead of src/",
    "flaky-test": "test_login_redirect failed on one run and passed on the next",
    "gave-up": "stopped after three failed attempts and asked for help",
}


def run_events(rng, run_id, task, outcome, cause):
    t = 0
    ev = []

    def add(kind, **kw):
        nonlocal t
        t += rng.randint(5, 90)
        ev.append({"t": f"2026-03-{10 + int(run_id[-2:]) % 18:02d}T{9 + t // 3600:02d}:{(t // 60) % 60:02d}:{t % 60:02d}",
                   "run": run_id, "kind": kind, **kw})

    add("task", text=TASKS[task])
    add("message", role="agent", text="I will read the code around this task first.")
    add("tool_call", tool="grep", args={"pattern": task.split("-")[0]})
    add("tool_result", tool="grep", ok=True, text=f"src/{task.replace('-', '_')}.py: 3 matches")
    add("tool_call", tool="read", args={"path": f"src/{task.replace('-', '_')}.py"})
    add("tool_result", tool="read", ok=True, text="(212 lines)")
    if cause == "wrong-file":
        add("tool_call", tool="edit", args={"path": f"build/lib/{task.replace('-', '_')}.py"})
        add("tool_result", tool="edit", ok=True, text="1 change")
        add("tool_call", tool="run_tests", args={})
        add("tool_result", tool="run_tests", ok=False, text="FAILED: the change had no effect on src/")
        add("message", role="agent", text="The tests still fail. My edit went to build/lib, which the tests do not import.")
    else:
        add("tool_call", tool="edit", args={"path": f"src/{task.replace('-', '_')}.py"})
        add("tool_result", tool="edit", ok=True, text="1 change")
    attempts = 3 if cause == "gave-up" else rng.randint(1, 2)
    for i in range(attempts):
        add("tool_call", tool="run_tests", args={"attempt": i + 1})
        if cause == "wrong-file":
            add("tool_result", tool="run_tests", ok=False, text="FAILED test_" + task.split("-")[0] + " (the change is not in src/)")
        elif cause == "timeout" and i == attempts - 1:
            add("tool_result", tool="run_tests", ok=False, text="ERROR: timed out after 20 minutes")
        elif cause == "flaky-test" and i == 0:
            add("tool_result", tool="run_tests", ok=False, text="FAILED test_login_redirect (expected 302, got 200)")
        elif cause == "gave-up":
            add("tool_result", tool="run_tests", ok=False, text=f"FAILED 2 tests (attempt {i + 1})")
        else:
            add("tool_result", tool="run_tests", ok=True, text="all 48 tests passed")
    if outcome == "merged":
        add("message", role="agent", text="All tests pass. I opened a pull request.")
        add("review", reviewer="Rowan Pike" if rng.random() < .5 else "Ines Okafor", verdict="approved")
    elif cause == "gave-up":
        add("message", role="agent", text="I tried three times and the same two tests fail. I need help to go on.")
    elif cause == "wrong-file":
        add("message", role="agent", text="I could not make the tests pass, so I stopped.")
    elif cause == "timeout":
        add("message", role="agent", text="The test run timed out, so I stopped.")
    elif cause == "flaky-test":
        add("message", role="agent", text="test_login_redirect failed once, then passed. I think it is flaky, so I did not open a pull request.")
    add("end", outcome=outcome, cause=cause or "")
    return ev


def main():
    rng = random.Random(7)
    (OUT / "runs").mkdir(parents=True, exist_ok=True)
    rows = []
    plan = (["merged"] * 13) + (["failed"] * 11)
    rng.shuffle(plan)
    causes = ["timeout"] * 2 + ["wrong-file"] * 5 + ["flaky-test"] * 3 + ["gave-up"] * 1
    rng.shuffle(causes)
    for i, outcome in enumerate(plan, start=1):
        run_id = f"run-{i:02d}"
        task = list(TASKS)[(i - 1) % len(TASKS)]
        cause = causes.pop() if outcome == "failed" else None
        ev = run_events(rng, run_id, task, outcome, cause)
        with open(OUT / "runs" / f"{run_id}.jsonl", "w") as f:
            for e in ev:
                f.write(json.dumps(e) + "\n")
        minutes = round(sum(1 for _ in ev) * rng.uniform(0.6, 1.8), 1) + (20 if cause == "timeout" else 0)
        rows.append({"run": run_id, "task": task, "outcome": outcome, "cause": cause or "", "events": len(ev),
                     "minutes": minutes})
    with open(OUT / "results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    (OUT / "README.md").write_text(
        "# Agent runs (made up)\n\n"
        "Twenty-four runs of a coding agent on six small tasks. Every name and message here is invented, for trying\n"
        "thimble browser.\n\n"
        "- `results.csv`: one row per run: its task, its outcome (`merged` or `failed`), the cause of a failure, the\n"
        "  number of events and the minutes it took.\n"
        "- `runs/run-NN.jsonl`: one event per line: the task, the agent's messages, its tool calls and their results,\n"
        "  a review, and the end.\n")


if __name__ == "__main__":
    main()
