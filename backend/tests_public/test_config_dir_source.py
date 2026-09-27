"""The Claude Code config dir this server serves (config.serve_claude_config) decides which settings.json it reads for
apiKeyHelper and which CLAUDE_CONFIG_DIR its sessions get, so it comes from the environment of the attaching process
(config.process_claude_config), never from a value a request carries."""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from test_delivery import CORPUS, _cwd, _fresh  # noqa: F401 — the fixture, used by name

from app import channel, config, main, procs, session

FIRST = "11111111-aaaa-4aaa-8aaa-000000000001"
needs_proc = pytest.mark.skipif(not procs.HAVE_PROC, reason="another process's environment is read from /proc")


@pytest.fixture()
def served(monkeypatch):
    monkeypatch.setattr(config, "_served_config", None)
    monkeypatch.setattr(session, "_ensure_tail", lambda lv: None)


@pytest.fixture()
def claude_like(tmp_path):
    """A running process whose CLAUDE_CONFIG_DIR is `<tmp>/real-cc`, as a `claude` would be."""
    real = tmp_path / "real-cc"
    p = subprocess.Popen([sys.executable, "-c", "import time; print('up', flush=True); time.sleep(30)"],
                         env={"PATH": os.environ.get("PATH", ""), "CLAUDE_CONFIG_DIR": str(real)},
                         stdout=subprocess.PIPE, text=True)
    assert p.stdout is not None and p.stdout.readline() == "up\n"
    try:
        yield p.pid, real
    finally:
        p.kill()
        p.wait()
        p.stdout.close()


def _subscribe_once(query: str, monkeypatch) -> int:
    """GET /api/channel through the app, with the stream cut off right after the subscription attached its session."""
    real = session.connected

    def connected_then_stop(*a, **k):
        real(*a, **k)
        raise HTTPException(418, "stop before the stream")

    monkeypatch.setattr(session, "connected", connected_then_stop)
    return TestClient(main.create_app()).get(f"/api/channel?{query}").status_code


def test_a_config_dir_in_the_subscription_query_is_ignored(served, monkeypatch, tmp_path):
    before = config.claude_config_dir()
    planted = tmp_path / "planted"
    q = f"cwd={_cwd()}&session={FIRST}&delivery=channel&config_dir={planted}"
    assert _subscribe_once(q, monkeypatch) == 418
    assert session.current(CORPUS).sid == FIRST
    assert config.claude_config_dir() == before != planted
    assert config.settings_files()[-1] == before / "settings.json"


@needs_proc
def test_the_subscription_serves_the_config_dir_of_the_claude_process_it_names(served, claude_like, monkeypatch, tmp_path):
    pid, real = claude_like
    q = f"cwd={_cwd()}&session={FIRST}&pid={pid}&delivery=channel&config_dir={tmp_path / 'planted'}"
    assert _subscribe_once(q, monkeypatch) == 418
    assert config.claude_config_dir() == real


def test_a_config_dir_in_the_session_body_is_ignored(served, tmp_path):
    before = config.claude_config_dir()
    body = channel.SessionBody.model_validate({"session": FIRST, "cwd": _cwd(), "config_dir": str(tmp_path / "planted")})

    async def name() -> dict:
        try:
            return await channel.session_route(CORPUS, body)
        finally:
            session.detach(CORPUS, FIRST)

    assert asyncio.run(name())["attached"] is True
    assert config.claude_config_dir() == before


@needs_proc
def test_the_session_route_serves_the_config_dir_of_the_process_that_asks(served, claude_like):
    """`thimble server up --session` sends its own pid; the server reads that process's CLAUDE_CONFIG_DIR."""
    pid, real = claude_like
    body = channel.SessionBody(session=FIRST, cwd=_cwd(), env_pid=pid)

    async def name() -> dict:
        try:
            return await channel.session_route(CORPUS, body)
        finally:
            session.detach(CORPUS, FIRST)

    assert asyncio.run(name())["attached"] is True
    assert config.claude_config_dir() == real
