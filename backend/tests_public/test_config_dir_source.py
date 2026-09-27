"""The Claude Code config dir this server serves (config.serve_claude_config) decides which settings.json it reads for
apiKeyHelper and which CLAUDE_CONFIG_DIR its sessions get, so it comes from the environment of the attaching process
(config.process_claude_config), never from a value a request carries or from sessions.json, which a notebook cell
can write."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from test_delivery import CORPUS, _cwd, _fresh  # noqa: F401 — the fixture, used by name

from app import channel, config, export, feedback, main, procs, session

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


def _subscribe_once(query: str, monkeypatch, headers: dict[str, str]) -> int:
    """GET /api/channel through the app, with the stream cut off right after the subscription attached its session."""
    real = session.connected

    def connected_then_stop(*a, **k):
        real(*a, **k)
        raise HTTPException(418, "stop before the stream")

    monkeypatch.setattr(session, "connected", connected_then_stop)
    return TestClient(main.create_app()).get(f"/api/channel?{query}", headers=headers).status_code


def test_a_config_dir_in_the_subscription_query_is_ignored(served, monkeypatch, tmp_path, plugin_headers):
    before = config.claude_config_dir()
    planted = tmp_path / "planted"
    q = f"cwd={_cwd()}&session={FIRST}&delivery=channel&config_dir={planted}"
    assert _subscribe_once(q, monkeypatch, plugin_headers()) == 418
    assert session.current(CORPUS).sid == FIRST
    assert config.claude_config_dir() == before != planted
    assert config.settings_files()[-1] == before / "settings.json"


@needs_proc
def test_the_subscription_serves_the_config_dir_of_the_claude_process_it_names(served, claude_like, monkeypatch, tmp_path,
                                                                             plugin_headers):
    pid, real = claude_like
    q = f"cwd={_cwd()}&session={FIRST}&pid={pid}&delivery=channel&config_dir={tmp_path / 'planted'}"
    assert _subscribe_once(q, monkeypatch, plugin_headers()) == 418
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


def _plant_config_dir(planted: Path, sid: str = FIRST, pid: int | None = None) -> None:
    """A sessions.json whose record names `planted` as the session's config dir (and `pid` as its process), as a
    notebook cell could write it."""
    (config.workspace_dir(CORPUS) / "sessions.json").write_text(json.dumps(
        {sid: {"session": sid, "cwd": _cwd(), "config_dir": str(planted), "pid": pid, "since": "2026-01-01T00:00:00Z"}}))


def test_a_config_dir_in_sessions_json_is_never_served(served, tmp_path):
    before = config.claude_config_dir()
    _plant_config_dir(tmp_path / "planted")
    try:
        lv = session.attach(CORPUS, FIRST, _cwd())
        assert lv is not None and not lv.config_known
        assert config.claude_config_dir() == before
    finally:
        session.detach(CORPUS, FIRST)


@needs_proc
def test_a_pid_in_sessions_json_does_not_choose_the_served_config_dir(served, claude_like, tmp_path):
    pid, real = claude_like
    before = config.claude_config_dir()
    _plant_config_dir(tmp_path / "planted", pid=pid)
    try:
        session.attach(CORPUS, FIRST, _cwd())
        assert config.claude_config_dir() == before != real
    finally:
        session.detach(CORPUS, FIRST)


def test_the_export_and_the_problem_report_look_for_transcripts_outside_a_config_dir_in_sessions_json(served, tmp_path):
    planted = tmp_path / "planted"
    other = "22222222-bbbb-4bbb-8bbb-000000000002"
    (planted / "projects" / "-x").mkdir(parents=True)
    (planted / "projects" / "-x" / f"{other}.jsonl").write_text('{"type": "user", "message": {"content": "private"}}\n')
    _plant_config_dir(planted, other)
    ws = config.workspace_dir(CORPUS)
    for roots in (export._projects_roots(ws), feedback.transcript_roots(ws)):
        assert planted / "projects" not in roots and config.claude_config_dir() / "projects" in roots
    assert export._find_transcript(other, export._projects_roots(ws)) is None
