"""The Claude Code config dir this server serves (config.serve_claude_config) decides which settings.json it reads and
which CLAUDE_CONFIG_DIR its sessions get, so it comes only from the shim's signed subscription, never from a request
anyone on the machine can send or from sessions.json, which a notebook cell can write."""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import agents, config, events, main, session

CORPUS = "mini"
FIRST = "11111111-aaaa-4aaa-8aaa-000000000001"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    for table in (events._subs, events._pending, events._taken, events._asks, events._waiters, events._lines,
                  events._notices, session._live, session._expected, session._event_threads, session._came_back,
                  session._shim_pids, session._shim_configs):
        table.clear()
    agents._busy.clear()
    yield
    for table in (events._subs, events._pending, events._taken, events._asks, events._waiters, events._notices,
                  session._live):
        table.clear()


def _cwd() -> str:
    return str(config.corpus_dir(CORPUS))


@pytest.fixture()
def served(monkeypatch):
    monkeypatch.setattr(config, "_served_config", None)
    monkeypatch.setattr(session, "_ensure_tail", lambda lv: None)


def test_the_served_config_dir_is_the_one_the_shim_reported(served, monkeypatch, tmp_path, plugin_headers):
    real = session.connected

    def connected_then_stop(*a, **k):
        real(*a, **k)
        raise HTTPException(418, "stop before the stream")

    monkeypatch.setattr(session, "connected", connected_then_stop)
    client = TestClient(main.create_app())
    q = f"cwd={_cwd()}&session={FIRST}&delivery=hook&config_dir={tmp_path / 'real-cc'}"
    assert client.get(f"/api/events?{q}", headers=plugin_headers()).status_code == 418
    # /thimble names the session, which attaches it with the config dir its shim reported, not one the request names
    r = client.post(f"/api/ws/{CORPUS}/session", json={"session": FIRST, "cwd": _cwd(), "env_pid": 1,
                                                       "config_dir": str(tmp_path / "planted")}, headers=plugin_headers())
    assert r.status_code == 200 and config.claude_config_dir() == tmp_path / "real-cc"
