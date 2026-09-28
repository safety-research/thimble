"""The terminal's commands for what only the chat bar did: /thimble:ask sends a message to a thread as its composer
would (message_thread): a side thread's follow-up with its anchor, Ask again with no message, a follow-up for the
orientation, a change to a view for its build thread, and main's own for any other chat; /thimble:orient passes Start's
switches, the critique and the permission mode among them, to start_orientation. The skills run no shell command, since
Claude Code puts typed arguments into one unescaped."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
import yaml

from app import agents, cc_settings, channel, config, ledger, orient_session, orientation, session, threads, tools, views

CORPUS = "mini"
SKILLS = config.REPO_ROOT / "plugin" / "skills"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    channel._subs.clear()
    session._live.clear()
    agents._busy.clear()
    yield
    channel._subs.clear()


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def _thread(tid: str, name: str) -> dict:
    meta = agents._defaults({"id": tid, "kind": agents.KIND_THREAD, "role": "thread", "title": name, "created_at": "t",
                             "parent": agents.MAIN_ID, "anchor": "card:0a1b2c3d", "anchor_text": "trees per orchard"})
    agents.write_meta(CORPUS, meta)
    agents.paths(CORPUS, tid)[1].touch()
    return meta


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def _split(path: Path) -> tuple[dict, str]:
    text = path.read_text("utf-8")
    head, _, body = text[4:].partition("\n---\n")
    return yaml.safe_load(head), body


def _analyst_mode(monkeypatch, tmp_path, mode: str) -> None:
    user = tmp_path / "cc" / "settings.json"
    user.parent.mkdir(parents=True, exist_ok=True)
    user.write_text(json.dumps({"permissions": {"defaultMode": mode}}))
    monkeypatch.setattr(cc_settings, "config_dir", lambda: user.parent)


async def test_a_start_orientation_call_may_lower_the_mode_but_never_raise_it(monkeypatch, tmp_path):
    """The mode is the analyst's (Start's switcher, the stored choice, their own mode); a model's call can only ask for
    less."""
    seen: dict = {}

    async def fake_start(c, brief, passes, call=None, chosen=None):
        seen.update(chosen=chosen)

    monkeypatch.setattr(orient_session, "start", fake_start)
    _analyst_mode(monkeypatch, tmp_path, "default")
    for asked in ("auto", "bypass", "run"):
        await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": asked})
        assert seen["chosen"] == {}, asked
    await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": "manual"})
    assert seen["chosen"] == {"permissions": "manual"}
    _analyst_mode(monkeypatch, tmp_path, "auto")
    await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": "bypass"})
    assert seen["chosen"] == {}
    orientation.request(CORPUS, "", ["views"], permissions="bypass")  # the analyst's Start, with Bypass on its switcher
    await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": "auto"})
    assert seen["chosen"] == {"permissions": "auto"}, "below the Bypass Start chose"
