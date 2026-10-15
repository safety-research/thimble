"""Reads of the local API need a credential (app/hook_auth.py LocalReadGuard), as writes do: the signed-in browser's
cookie or the token's proof, which the CLI sends with every request. The health check names no path or pid without the
proof, so the CLI tells another install's server by the home it does not name."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import cli, hook_auth, main

REFUSED = {"detail": hook_auth.SIGN_IN_NEEDED, "signin": True}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("THIMBLE_PORT", "8300")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    return TestClient(main.create_app(), base_url="http://testserver")


@pytest.mark.real_read_guard
def test_health_names_its_home_and_pid_only_to_the_token_s_holder(client, plugin_headers):
    assert set(client.get("/api/health").json()) == {"ok", "boot", "ui"}
    full = client.get("/api/health", headers=plugin_headers()).json()
    assert full["home"] == str(hook_auth.home().resolve()) and full["leader"] and full["app"]
    wrong = hook_auth.headers("another-install-s-token", "n0nce")
    assert set(client.get("/api/health", headers=wrong).json()) == {"ok", "boot", "ui"}


def test_the_cli_takes_a_server_that_names_no_home_for_another_install_s(monkeypatch):
    """foreign_home: this install's server names its home to this install's proof; one that names none took the proof
    for none (another install's, or another account's), and the CLI does not use it."""
    answers = {"mine": (200, {"ok": True, "boot": "b", "ui": None, "home": str(cli.home().resolve()), "app": "/x",
                              "leader": 7}),
               "theirs": (200, {"ok": True, "boot": "b", "ui": None}),
               "older": (200, {"ok": True, "home": "/home/someone/.thimble"}),
               "down": (0, "ConnectionRefusedError")}
    monkeypatch.setattr(cli, "_request", lambda m, url, b=None, timeout=5.0: answers[url.split("//")[1].split("/")[0]])
    assert cli.foreign_home("http://mine") is None
    assert cli.foreign_home("http://theirs") == cli.FOREIGN_UNNAMED
    assert cli.foreign_home("http://older") == "/home/someone/.thimble"
    assert cli.foreign_home("http://down") is None
