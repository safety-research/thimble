"""thimble fix in the browser (app/fixes.py): /thimble-fix starts a fork of main's conversation on a copy the kernel
makes, in the person's words as they typed them; the kernel checks what it changed, and a fix that passes is ready: a
notice asks the person, and only their click (Use it now) puts it on, with the secret of that click, and starts the
server again from live; Undo takes it off and starts the server again. The kernel is a stand-in that keeps its records
in memory, and the Messages API the fake client of test_runtime: no model is called and nothing restarts."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from test_runtime import CORPUS, api_key, call, main_turn, on, text  # noqa: F401 — `on` is a fixture

from app import agents, dev, fixes

PAGE = 'The card open in focus (card:c1), "Incidents by week":\nweek  incidents\n1  4\n2  7'


class Kernel:
    """`thimble fix VERB` in memory: new makes the copy's folder, done answers ready, apply takes the click's secret and
    puts the fix on, undo takes it off."""

    def __init__(self, home: Path) -> None:
        self.home = home
        self.recs: dict[int, dict[str, Any]] = {}
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, args: list[str], *, stdin: str | None = None, timeout: float = 0, env: dict | None = None):
        self.calls.append(tuple(args))
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
            rec.update(state="ready", tests="passed", error=None,
                       summary="The card's title now ends with its row count.", files=[{"path": "a"}, {"path": "b"}])
        elif verb == "apply":
            assert stdin and len(stdin) == 64  # the secret of the click, on stdin
            ask = self.home / "fixes" / "asks" / f"{rec['id']}.json"
            assert json.loads(ask.read_text())["key"] == fixes.hashlib.sha256(stdin.encode()).hexdigest()
            ask.unlink()
            rec["state"] = "on"
        elif verb == "undo":
            rec["state"] = "off"
        return fixes.Ran(True, json.dumps(rec), "")


@pytest.fixture()
def fixing(on, monkeypatch, tmp_path):
    """Fixes on, the kernel a stand-in, the page taken as built, and the restart recorded instead of made."""
    monkeypatch.setenv("THIMBLE_FIXES", "on")
    k = Kernel(fixes.plugin_home())
    monkeypatch.setattr(fixes, "kernel", k)
    monkeypatch.setattr(fixes, "srt_ready", lambda: "")
    monkeypatch.setattr(fixes, "prepare", lambda root, built=None: "")
    restarts: list[tuple[str, Path | None]] = []

    async def restart(title: str, *, ticket_id: str | None = None, cwd: Path | None = None) -> None:
        restarts.append((title, cwd))

    monkeypatch.setattr(dev, "supervised", lambda: True)
    monkeypatch.setattr(dev, "_do_restart", restart)
    fixes._phase.clear()
    fixes._fixers.clear()
    fixes._asked.clear()
    fixes._waiting.clear()
    k.restarts = restarts  # type: ignore[attr-defined]
    yield k
    fixes._phase.clear()
    fixes._fixers.clear()
    fixes._asked.clear()
    fixes._waiting.clear()


WAIT_S = 60.0  # the most a test waits for the event it waits on, which a busy machine delays but never skips


async def _until(cond: Any, what: str) -> None:
    """Waits until cond() holds: an apply or an undo runs the kernel in a thread and starts the server again a moment
    later (fixes.restart, call_later), which a busy machine stretches past any fixed sleep. Fails with `what` after
    WAIT_S."""
    end = time.monotonic() + WAIT_S
    while not cond():
        assert time.monotonic() < end, f"{what} (waited {WAIT_S:g} s)"
        await asyncio.sleep(0.02)


async def _ended(fid: int = 1) -> None:
    """Fix `fid`'s fixer ended, and so did the kernel's checks after it (fixes.settle, which runs in the fixer's task):
    no fixer of it runs and its phase is neither fixing nor testing, which settle ends as it writes the fix's notice."""
    end = time.monotonic() + WAIT_S
    while True:
        conv = fixes._fixers.get(fid)
        if conv is not None and conv.task is not None and not conv.task.done():
            await asyncio.wait_for(asyncio.shield(conv.task), max(0.0, end - time.monotonic()))
            continue
        if fixes._phase.get(fid) not in ("fixing", "testing"):
            return
        assert time.monotonic() < end, f"fix {fid}'s fixer did not end within {WAIT_S:g} s"
        await asyncio.sleep(0.02)


async def _went_on(fid: int = 1) -> None:
    """What a click on Use it started (fixes.apply's task): the page's build, then the undo or the restart's call."""
    for task in [t for t in asyncio.all_tasks() if t.get_name() == f"fix-apply:{fid}"]:
        await asyncio.wait_for(task, WAIT_S)


async def _restarted(fixing: Any, after: str, n: int = 1) -> None:
    """The n-th restart was called (fixes.restart calls dev._do_restart a moment after it returns)."""
    await _until(lambda: len(fixing.restarts) >= n, f"the server never started again after {after}")


def _log(c: str, chat: str = "main") -> list[dict[str, Any]]:
    return agents.read_events(agents.paths(c, chat)[1])


def _fixer_chats(c: str) -> list[dict[str, Any]]:
    return [m for m in agents.list_chats(c) if m.get("role") == fixes.FIXER]


async def test_a_fix_is_a_fork_of_main_on_its_copy_and_asks_the_person_when_its_checks_pass(fixing, monkeypatch):
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

    # the kernel checks what the change touched; the fix is ready, and nothing goes on by itself
    verbs = [c[0] for c in fixing.calls]
    assert verbs[:1] == ["new"] and "done" in verbs and "apply" not in verbs and fixing.restarts == []
    done = fixing.calls[verbs.index("done")]
    assert done[done.index("--title") + 1] == "Card says how many rows"
    row = fixes.status()["fixes"][0]
    assert (row["kind"], row["state"], row["phase"]) == ("ready", "ready", None)
    assert row["words"] == "make this card's title say how many rows it shows" and row["files"] == 2
    [chat] = _fixer_chats(CORPUS)
    assert any(r.get("kind") == "fix" and r.get("status") == "ready" for r in _log(CORPUS, chat["id"]))


async def test_only_the_analyst_s_click_puts_a_fix_on_and_undo_takes_it_off(fixing, monkeypatch, analyst):
    from starlette.requests import Request

    from app import hook_auth

    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    token_only = Request({"type": "http", "headers": [], "state": {}})
    with pytest.raises(HTTPException) as e:
        await fixes.apply_route(1, token_only)
    assert e.value.status_code == 403 and e.value.detail == hook_auth.ANALYST_ONLY
    assert "apply" not in [c[0] for c in fixing.calls]
    await fixes.apply_route(1, analyst)
    await _went_on()
    await _restarted(fixing, "Use it now")
    assert fixing.recs[1]["state"] == "on"
    assert (await fixes.undo_route(1, analyst))["restart"] is True
    await _restarted(fixing, "Undo", 2)
    assert fixing.restarts[-1][0] == "undo of fix 1" and fixing.recs[1]["state"] == "off"
    fixes._phase.clear()
    assert fixes.status()["fixes"][0]["said"] == "thimble fix undone: Card counts rows"
    await fixes.dismiss_route(1, analyst)
    assert fixes.status()["fixes"] == []
