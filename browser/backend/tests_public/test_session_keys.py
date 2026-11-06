"""The ANTHROPIC_* variables that a `claude` thimble starts signs in with (config.launch_environ) reach none of the
commands its sessions run: every session thimble fences runs its commands in Claude Code's sandbox, which unsets them
(cc_settings.env_denies)."""
from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

from app import cc_settings, runtime_cc

FAKE_KEY = "-".join(("sk", "ant", "made", "up", "key", "for", "tests"))  # built, so no scanner takes it for a key
DENIED = [{"name": "ANTHROPIC_API_KEY", "mode": "deny"}, {"name": "ANTHROPIC_BASE_URL", "mode": "deny"}]


@pytest.fixture()
def key(monkeypatch):
    """A made-up ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL where thimble runs, and no other ANTHROPIC_* variable."""
    for k in [k for k in os.environ if k.startswith("ANTHROPIC_")]:
        monkeypatch.delenv(k)
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9")


def test_every_session_thimble_fences_runs_its_commands_without_the_anthropic_variables(key, tmp_path, monkeypatch):
    """runtime_cc's sessions and a dev ticket's (dev.ticket_fence) take their sandbox from cc_settings.offline_sandbox;
    a name Claude Code would refuse in its settings is left out."""
    monkeypatch.setenv("ANTHROPIC_NOT.A-NAME", "x")
    box = cc_settings.offline_sandbox()
    assert box["credentials"] == {"envVars": DENIED}
    spec = SimpleNamespace(model="claude-opus-5-5", effort="high", cwd=tmp_path, write_roots=[], private=[],
                           no_write=[])
    assert runtime_cc.settings(spec, True, tmp_path / "t")["sandbox"]["credentials"] == {"envVars": DENIED}
