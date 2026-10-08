"""The Claude Code config dir this server serves (config.serve_claude_config) decides which settings.json it reads and
which CLAUDE_CONFIG_DIR its sessions get, so it comes only from the shim's signed subscription, never from a request
anyone on the machine can send or from sessions.json, which a notebook cell can write."""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from test_delivery import CORPUS, _cwd, _fresh  # noqa: F401 — the fixture, used by name

from app import config, main, session

FIRST = "11111111-aaaa-4aaa-8aaa-000000000001"


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
                                                       "config_dir": str(tmp_path / "planted")})
    assert r.status_code == 200 and config.claude_config_dir() == tmp_path / "real-cc"
