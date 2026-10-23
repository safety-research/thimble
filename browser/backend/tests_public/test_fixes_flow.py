"""thimble fix in the browser (app/fixes.py): /thimble-fix starts a fork of main's conversation on a copy the kernel
makes, the kernel checks what it changed, and a fix that passes is ready: a notice asks the person, and only their
click (Use it now) puts it on, with the secret of that click, and starts the server again from live. The kernel is a stand-in that keeps its records in memory (the kernel's own tests are plugin/tests/test_fixes.py), and the
Messages API the fake client of test_runtime: no model is called and nothing restarts."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from test_runtime import CORPUS, api_key, call, main_turn, on, text  # noqa: F401 — `on` is a fixture

from app import config, dev, fixes, tools

PAGE = 'The card open in focus (card:c1), "Incidents by week":\nweek  incidents\n1  4\n2  7'


class Kernel:
    """`thimble fix VERB` in memory: new makes the copy's folder, done answers `ends` (ready by default)."""

    def __init__(self, home: Path, ends: str = "ready", error: str = "") -> None:
        self.home, self.ends, self.error = home, ends, error
        self.recs: dict[int, dict[str, Any]] = {}
        self.calls: list[tuple[str, ...]] = []
        self.envs: list[dict[str, str]] = []

    def __call__(self, args: list[str], *, stdin: str | None = None, timeout: float = 0, env: dict | None = None):
        self.calls.append(tuple(args))
        self.envs.append(dict(env or {}))
        verb = args[0]
        if verb == "new":
            fid = len(self.recs) + 1
            work = self.home / "fixes" / "work" / str(fid)
            (work / "browser").mkdir(parents=True)
            title = args[args.index("--title") + 1] if "--title" in args else (stdin or "")[:40]
            self.recs[fid] = {"id": fid, "title": title, "words": [stdin], "state": "working", "work": str(work),
                              "base": "HEAD", "made_in": args[args.index("--made-in") + 1], "updated": 1.0}
            return fixes.Ran(True, json.dumps(self.recs[fid]), "")
        if verb == "list":
            return fixes.Ran(True, json.dumps({"fixes": list(self.recs.values())}), "")
        rec = self.recs[int(args[1])]
        if verb == "done":
            if "--title" in args:
                rec["title"] = args[args.index("--title") + 1]
            rec.update(state=self.ends, tests="passed" if self.ends == "ready" else "failed", error=self.error or None,
                       summary="The card's title now ends with its row count.", files=[{"path": "a"}, {"path": "b"}])
        elif verb == "apply":
            assert stdin and len(stdin) == 64  # the secret of the click, on stdin
            ask = self.home / "fixes" / "asks" / f"{rec['id']}.json"
            assert json.loads(ask.read_text())["key"] == fixes.hashlib.sha256(stdin.encode()).hexdigest()
            ask.unlink()
            if rec["state"] not in ("ready", "off"):
                return fixes.Ran(False, "", f"fix {rec['id']} is {rec['state']}, so there is nothing to apply")
            rec["state"] = "on"
        elif verb == "undo":
            rec["state"] = "off"
        elif verb == "redo":
            rec.update(state="working", words=[*rec["words"], ""])
        return fixes.Ran(True, json.dumps(rec), "")


@pytest.fixture()
def fixing(on, monkeypatch, tmp_path):
    """Fixes on, the kernel a stand-in, the page built, and the restart recorded instead of made."""
    monkeypatch.setenv("THIMBLE_FIXES", "on")
    k = Kernel(fixes.plugin_home())
    monkeypatch.setattr(fixes, "kernel", k)
    monkeypatch.setattr(fixes, "srt_ready", lambda: "")
    monkeypatch.setattr(fixes, "prepare", lambda root: "")
    monkeypatch.setattr(fixes, "changed", lambda work, base: ["browser/frontend/src/canvas/Focus.tsx"])
    restarts: list[tuple[str, Path | None]] = []

    async def restart(title: str, *, ticket_id: str | None = None, cwd: Path | None = None) -> None:
        restarts.append((title, cwd))

    monkeypatch.setattr(dev, "supervised", lambda: True)
    monkeypatch.setattr(dev, "_do_restart", restart)
    fixes._phase.clear()
    fixes._fixers.clear()
    k.restarts = restarts  # type: ignore[attr-defined]
    yield k
    fixes._phase.clear()
    fixes._fixers.clear()


async def _ended(fid: int = 1) -> None:
    conv = fixes._fixers.get(fid)
    if conv is not None and conv.task is not None:
        await conv.task
    await asyncio.sleep(0.4)  # the restart is called a moment after


def test_the_words_after_the_command():
    assert fixes.words_of("/thimble-fix make this card say rows") == "make this card say rows"
    assert fixes.words_of("  /thimble-fix\n two lines\nhere ") == "two lines\nhere"
    assert fixes.words_of("/thimble-fix") == ""
    assert fixes.words_of("/thimble-fixes now") is None
    assert fixes.words_of("please /thimble-fix it") is None


def test_the_tests_follow_what_the_change_touched():
    page = fixes.tests_for(["browser/frontend/src/chat/Rows.tsx"])
    assert "tsc -b" in page and "vitest run --changed HEAD~1" in page and "pytest" not in page
    server = fixes.tests_for(["browser/backend/app/tools.py"])
    assert "tests_public" in server and "vitest" not in server
    assert "pytest plugin" in fixes.tests_for(["plugin/core/answers.ts"])
    assert fixes.tests_for(["docs/notes.md"]) == "true"


async def test_a_fix_is_a_fork_of_main_on_its_copy_and_asks_the_person_when_its_checks_pass(fixing, monkeypatch, analyst):
    work = fixing.home / "fixes" / "work" / "1"
    client = api_key(monkeypatch, [
        text("Week 2 had the most incidents."),
        call("Write", {"file_path": str(work / "browser" / "note.txt"), "content": "rows\n"}),
        text("Title: Card says how many rows\nWhat it does: The card's title now ends with its row count."),
    ])
    await main_turn("Which week had the most incidents?")
    got = await fixes.request(CORPUS, "make this card's title say how many rows it shows", PAGE)
    assert got["fix"]["id"] == 1
    assert fixes.status()["fixes"][0]["phase"] == "fixing"
    await _ended()

    # the fixer has the chat so far, then the registry's fixer text, the person's words and the page
    body = client.bodies[1]
    said = json.dumps(body["messages"])
    assert "Which week had the most incidents?" in said and "Week 2 had the most incidents." in said
    first = body["messages"][-1]["content"]
    assert (fixes.plugin_dir() / "prompts" / "fixer.md").read_text().strip()[:80] in first
    assert "make this card's title say how many rows it shows" in first
    assert "Incidents by week" in first and str(work) in first
    assert {"Edit", "Write", "Read"} <= {t["name"] for t in body["tools"] if "name" in t}
    # it wrote its copy, and nothing else
    assert (work / "browser" / "note.txt").read_text() == "rows\n"

    # the kernel's checks, with the tests of what the change touched; the fix is ready and nothing goes on by itself
    verbs = [c[0] for c in fixing.calls]
    assert verbs[:1] == ["new"] and "done" in verbs and "apply" not in verbs and fixing.restarts == []
    done = fixing.calls[verbs.index("done")]
    assert done[done.index("--title") + 1] == "Card says how many rows"
    assert "vitest" in fixing.envs[verbs.index("done")]["THIMBLE_FIX_TESTS"]
    assert not (fixes.fixes_home() / "asks" / "1.json").exists()
    row = fixes.status()["fixes"][0]
    assert (row["kind"], row["said"], row["state"], row["phase"]) == (
        "ready", "thimble fixed: Card says how many rows · tests pass", "ready", None)
    # What changed: the person's words, what Claude did, how many files
    assert row["words"] == "make this card's title say how many rows it shows"
    assert row["summary"] == "The card's title now ends with its row count." and row["files"] == 2

    # Use it now: the click's secret to the kernel's apply, then the server starts again from live
    assert (await fixes.apply_route(1, analyst))["restart"] is True
    await asyncio.sleep(0.4)
    assert [c[0] for c in fixing.calls].count("apply") == 1
    assert fixing.restarts == [("fix 1: Card says how many rows", config.REPO_ROOT / "backend")]
    assert fixes.status()["fixes"][0]["phase"] == "restarting"
    fixes._phase.clear()  # the server that starts again knows of no phase: the notice says the fix is on
    row = fixes.status()["fixes"][0]
    assert (row["kind"], row["said"], row["state"]) == ("fixed", "Card says how many rows is on", "on")


async def test_a_fix_that_fails_its_checks_says_why_and_offers_redo(fixing, monkeypatch):
    fixing.ends, fixing.error = "failed", "its tests failed in the sandbox"
    api_key(monkeypatch, [text("Title: Bar counts rows\nWhat it does: The bar counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    assert "apply" not in [c[0] for c in fixing.calls] and fixing.restarts == []
    row = fixes.status()["fixes"][0]
    assert row["kind"] == "failed"
    assert row["said"] == "Fix 1 did not pass: Bar counts rows · its tests failed in the sandbox"


async def test_later_leaves_the_fix_ready_in_your_fixes_and_use_it_there_puts_it_on(fixing, monkeypatch, analyst):
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    await fixes.dismiss_route(1, analyst)  # Later
    assert fixes.status()["fixes"] == [] and fixing.recs[1]["state"] == "ready"
    listed = fixes.status(every=True)["fixes"]
    assert [(r["id"], r["state"], r["kind"]) for r in listed] == [(1, "ready", None)]
    await fixes.apply_route(1, analyst)  # Use it, in Your fixes
    await asyncio.sleep(0.4)
    assert fixing.recs[1]["state"] == "on" and fixing.restarts[-1][0] == "fix 1: Card counts rows"


async def test_a_ready_notice_goes_once_the_fix_is_on_elsewhere(fixing, monkeypatch):
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    fixing.recs[1]["state"] = "on"  # the terminal's y put it on
    assert fixes.status()["fixes"] == []


async def test_only_the_click_applies_and_a_refused_apply_says_why(fixing, monkeypatch, analyst):
    from app import hook_auth
    from starlette.requests import Request

    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    token_only = Request({"type": "http", "headers": [], "state": {}})
    with pytest.raises(HTTPException) as e:
        await fixes.apply_route(1, token_only)
    assert e.value.status_code == 403 and e.value.detail == hook_auth.ANALYST_ONLY
    assert "apply" not in [c[0] for c in fixing.calls]
    fixing.recs[1]["state"] = "failed"
    with pytest.raises(HTTPException) as e:
        await fixes.apply_route(1, analyst)
    assert e.value.status_code == 409 and "nothing to apply" in e.value.detail
    assert fixes._phase == {} and fixing.restarts == []


async def test_a_page_that_does_not_build_takes_the_fix_off_again(fixing, monkeypatch, analyst):
    monkeypatch.setattr(fixes, "prepare", lambda root: "the page did not build: src/x.tsx(3,1): error TS1005")
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    await fixes.apply_route(1, analyst)
    await asyncio.sleep(0.4)
    verbs = [c[0] for c in fixing.calls]
    assert verbs.index("undo") > verbs.index("apply") and fixing.restarts == []
    assert fixes.status()["fixes"][0]["said"].endswith("error TS1005; it is off again")


async def test_undo_takes_the_fix_off_and_starts_the_server_again(fixing, monkeypatch, analyst):
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    await fixes.apply_route(1, analyst)
    await asyncio.sleep(0.4)
    assert (await fixes.undo_route(1, analyst))["restart"] is True
    await asyncio.sleep(0.4)
    assert fixing.restarts[-1][0] == "undo of fix 1"
    fixes._phase.clear()
    assert fixes.status()["fixes"][0]["said"] == "thimble fix undone: Card counts rows"
    await fixes.dismiss_route(1, analyst)
    assert fixes.status()["fixes"] == []


async def test_the_routes_take_the_analyst_s_click_alone(fixing):
    from app import hook_auth
    from starlette.requests import Request

    token_only = Request({"type": "http", "headers": [], "state": {}})
    with pytest.raises(HTTPException) as e:
        await fixes.request_route(CORPUS, fixes.Asked(words="count the rows"), token_only)
    assert e.value.status_code == 403 and e.value.detail == hook_auth.ANALYST_ONLY
    with pytest.raises(HTTPException) as e:
        await fixes.request(CORPUS, "   ", "")
    assert e.value.status_code == 400


async def test_file_dev_ticket_on_thimble_s_code_asks_for_a_fix(fixing, monkeypatch):
    api_key(monkeypatch, [text("Title: Wider pane\nWhat it does: The pane is wider.")])
    res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Wider pane", "body": "the pane is narrow"},
                           tool_use_id="toolu_ticket")
    said = json.dumps(res.content)
    assert "fix 1" in said and "Wider pane" in said
    assert fixing.calls[0][0] == "new" and fixing.recs[1]["words"] == ["Wider pane\n\nthe pane is narrow"]
    assert fixing.recs[1]["made_in"] == "browser"
    await _ended()


def test_fixes_off_leave_the_code_tickets_their_entry_points(monkeypatch):
    monkeypatch.setenv("THIMBLE_FIXES", "off")
    assert fixes.problem() == fixes.OFF_LINE
    assert fixes.status() == {"problem": fixes.OFF_LINE, "fixes": []}


def test_a_copy_gets_the_installed_packages_and_a_folder_of_its_own_for_the_page_s_temp_files(tmp_path):
    src, copy = tmp_path / "install", tmp_path / "copy"
    (src / "backend" / ".venv" / "bin").mkdir(parents=True)
    (src / "frontend" / "node_modules" / "vite").mkdir(parents=True)
    (src / "frontend" / "node_modules" / ".vite").mkdir()
    (copy / "backend").mkdir(parents=True)
    (copy / "frontend").mkdir()
    fixes.lend(copy, src)
    assert (copy / "backend" / ".venv").resolve() == (src / "backend" / ".venv").resolve()
    nm = copy / "frontend" / "node_modules"
    assert nm.is_dir() and not nm.is_symlink()
    assert (nm / "vite").resolve() == (src / "frontend" / "node_modules" / "vite").resolve()
    assert not (nm / ".vite").exists()
