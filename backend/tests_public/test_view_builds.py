"""A view ticket's run (app/dev.py run_view) when the API is at capacity or the build fails. A turn that Claude Code
ended on `API Error: Repeated 529 Overloaded errors` is no attempt: the build waits on the schedule a session's retry
uses (30 s, 60 s, 120 s, 240 s, then 5 min four times) and wakes the same session, and the view is built with no Retry
click. When the API stays at capacity through every wait, the build stops and names the API's error, not a file the
gate found empty. A view the analyst asked for that fails keeps its failure, with Retry; the orientation's proposals,
which the analyst never asked for, start again in a new session told what failed, and one that still fails is dropped
from the proposals with one line in the orientation's thread. The background session is a stand-in that writes the
view's files; the view's reader runs in this process and its headless page is a stand-in too. The board is invented."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import agent_session, agents, config, dev, ledger, orientation, tools, views

CORPUS = "boards"
SCHEDULE = [30.0, 60.0, 120.0, 240.0, 300.0, 300.0, 300.0, 300.0]  # agent_session.retry_waits' defaults, 27.5 min
ERROR_529 = ("API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again "
             "in a moment.")
READER = '''
import json


def build_index(paths):
    return {"lines": {f"{p}#L{n}": json.loads(line)["body"] for p in paths for n, line in enumerate(open(p), 1)}}


def records(index, query):
    return [{"ref": r, "body": b} for r, b in index["lines"].items()]


def resolve(index, locator):
    ref = f"{locator.get('path')}#{locator.get('fragment')}"
    body = index["lines"].get(ref)
    return None if body is None else {"excerpt": body, "label": "a post", "refs": [ref], "key": None, "target": {"ref": ref}}
'''
HTML = """<!doctype html><html><body><div id="out"></div><script>
thimble.onOpen(async () => { document.getElementById('out').textContent = JSON.stringify(await thimble.fetch({})) })
</script></body></html>"""


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("first post", "second post")))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return corpus


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


def _stand_ins(monkeypatch) -> list[float]:
    """The reader and page stand-ins, no chat, and waits that are only recorded."""
    monkeypatch.setattr(views, "_runner", _inproc_run)
    monkeypatch.setattr(views, "build_problem", lambda: "")
    monkeypatch.setattr(dev, "_view_chat", lambda c, prop: None)

    async def page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 1, "refs": 2, "records": 2, "fetched_records": 2} for _ in states]

    monkeypatch.setattr(views, "shoot_states", page)
    waits: list[float] = []

    async def no_wait(s: float) -> None:
        waits.append(s)

    monkeypatch.setattr(dev, "_capacity_sleep", no_wait)
    monkeypatch.setattr(dev.SESSIONS, "stop", lambda short: None)
    return waits


def _queued(asked: bool = True) -> None:
    """The proposal `posts`: one the analyst asked for in main, or with `asked` off one of the orientation's."""
    views._save_proposals(CORPUS, [{"slug": "posts", "name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"],
                                    "arrangement": "one post per page", "proposed_by": "analyst", "status": "queued",
                                    "ts": "2026-09-25T00:00:00+00:00", **({"asked": True} if asked else {})}])
    views._bind_loop()


def _orientation() -> str:
    """An orientation that has ended, whose thread a dropped proposal's line goes to; its chat's id."""
    chat = agents.new_agent(CORPUS, "orient", "Orientation")["id"]
    orientation._write_run(CORPUS, {"status": "done", "chats": {orientation.ROLE: chat}})
    return chat


def _lines(chat: str) -> list[str]:
    """The stage lines of a chat's log (dev.Log.stage), in order."""
    _, log = agents.paths(CORPUS, chat)
    recs = [json.loads(x) for x in log.read_text().splitlines() if x.strip()]
    return [r["delta"].strip()[2:] for r in recs if r.get("type") == "text" and r.get("delta", "").startswith("\n· ")]


def _write(files: dict[str, str]) -> None:
    d = views.views_dir(CORPUS) / "posts"
    d.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        (d / name).write_text(text)


VIEW_JSON = json.dumps({"name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"],
                        "accepts": [{"form": "L<n>", "means": "a post"}], "declares": []})


def test_a_view_build_s_session_may_read_the_corpus_but_not_change_it(board, monkeypatch):
    """The session runs in the corpus folder with Edit and Bash allowed, so its flags deny edits in the corpus and in
    the worked examples, and put Bash in the sandbox with no network where it can run, beside the dev role's fast
    mode, with its check command the one command run outside the sandbox; the prompt names that same command. A code
    ticket's session, in its own worktree, gets none of it."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    monkeypatch.setattr(config, "models_for", lambda c=None, settings=None: {"dev": {"model": "claude-opus-4-8", "fast": True}})
    corpus = config.corpus_dir(CORPUS)
    folder = views.views_dir(CORPUS) / "posts"
    flags = dev.Sessions()._flags(CORPUS, "thimble view: Posts", (folder,), dev.view_fence(CORPUS, "posts", corpus, folder))
    settings = json.loads(flags[flags.index("--settings") + 1])
    assert settings["permissions"]["deny"] == [f"Edit(/{corpus}/**)", f"Edit(/{views.EXAMPLES_DIR}/**)"]
    box = settings["sandbox"]
    assert box["network"] == {"deniedDomains": ["*"]} and not box["allowUnsandboxedCommands"]
    check = dev.view_check_command(CORPUS, "posts")
    assert box["excludedCommands"] == [check, f"{check} *"] and check.endswith(f"/api/ws/{CORPUS}/views/posts/check")
    assert settings["fastMode"] is True and "Read" in flags[flags.index("--allowedTools") + 1].split(",")
    prompt = dev.build_view_prompt(CORPUS, {"slug": "posts", "name": "Posts", "claims": ["board.jsonl"]}, folder, corpus)
    assert f"`{check} '<ref>'`" in prompt and "curl" not in prompt
    code = dev.Sessions()._flags(CORPUS, "thimble ticket 1: x")
    assert json.loads(code[code.index("--settings") + 1]) == {"fastMode": True}, "a code ticket is not fenced"
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    assert "sandbox" not in dev.read_only_fence([corpus]), "no sandbox where it cannot run; the deny stays"
    inside = corpus / ".thimble" / "views" / "posts"
    assert dev.view_read_only(corpus, inside) == (views.EXAMPLES_DIR,), "a corpus that holds the view's folder is left out"


BUILT_AT = "2026-09-01T00:00:00+00:00"
CHANGE = "Put the newest post first"
NEW_HTML = HTML.replace('<div id="out">', '<div id="out" class="newest-first">')


def _built_with_change(monkeypatch) -> str:
    """The view `posts`, built at BUILT_AT, with CHANGE asked in its build's thread (views.message) and not yet run;
    the build's chat's id. Runs are not queued, so the test runs the change itself."""
    agents.ensure_main(CORPUS)
    monkeypatch.setattr(dev, "queue_view", lambda c, slug: None)
    monkeypatch.setattr(dev, "stop_view", lambda c, slug, why: False)
    views._bind_loop()
    views.write_view(CORPUS, "posts", name="Posts", why="one post at a time", claims=["board.jsonl"],
                     accepts=[{"form": "L<n>", "means": "a post"}], declares=[], reader=READER, html=HTML)
    vj = views.views_dir(CORPUS) / "posts" / views.VIEW_JSON
    vj.write_text(json.dumps({**json.loads(vj.read_text()), "built": BUILT_AT}))
    chat = agents.new_agent(CORPUS, "dev", "view: Posts", view="posts", announce=True, asked=True)["id"]
    views._save_proposals(CORPUS, [{"slug": "posts", "name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"],
                                    "arrangement": "one post per page", "proposed_by": "analyst", "status": "built",
                                    "asked": True, "chat": chat, "ts": "2026-09-25T00:00:00+00:00"}])
    views.message(CORPUS, "posts", CHANGE)
    return chat


def _gates(monkeypatch) -> list[str]:
    """The gate, run as it is, with each run recorded."""
    seen: list[str] = []
    real = views.gate

    async def gate(c, slug, locators=None, **kw):
        seen.append(slug)
        return await real(c, slug, locators, **kw)

    monkeypatch.setattr(views, "gate", gate)
    return seen


def _app() -> FastAPI:
    a = FastAPI()
    a.include_router(views.router, prefix="/api")
    a.include_router(ledger.router, prefix="/api")
    return a
