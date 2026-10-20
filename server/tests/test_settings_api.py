"""Settings in the page (settings_api.py): the sign-in, the model, the effort and explainers; an API key is kept
readable by this user alone and never sent back."""
import stat

from browser_client import Signed

from thimble_browser import home, settings

MADE_UP_KEY = "sk-made-up-0123456789"


def test_the_settings_and_their_choices(folder, tmp_path, monkeypatch):
    (tmp_path / "wif").mkdir()
    for org in ("team-a", "team-b"):
        (tmp_path / "wif" / f"org-{org}.env").write_text("# made up\n")
    monkeypatch.setattr(settings, "WIF_DIR", str(tmp_path / "wif"))
    api = Signed(folder)
    got = api("GET", "/ws/{ws}/settings").json()
    assert got["model"] == "claude-opus-5-5" and got["effort"] == "high" and got["explain"] is True
    assert got["choices"]["orgs"] == ["team-a", "team-b"]
    assert got["signed_in"] == "none" and got["has_api_key"] is False
    assert got["models"]["main"]["model"] == "claude-opus-5-5"


def test_a_change_is_saved_and_a_bad_one_refused(folder):
    api = Signed(folder)
    r = api("PUT", "/ws/{ws}/settings", json={"credentials": {"source": "wif", "org": "team-b"}, "model": "claude-sonnet-5-5",
                                              "effort": "max", "explain": False})
    assert r.status_code == 200
    got = r.json()
    assert got["credentials"] == {"source": "wif", "org": "team-b"} and got["signed_in"] == "Workload Identity Federation (team-b)"
    assert settings.read()["model"] == "claude-sonnet-5-5" and settings.read()["explain"] is False
    assert api("PUT", "/ws/{ws}/settings", json={"credentials": {"source": "wif", "org": "../elsewhere"}}).status_code == 400
    assert api("PUT", "/ws/{ws}/settings", json={"effort": "extreme"}).status_code == 400
    # a 0.8 role row's change is the one model's
    api("PUT", "/ws/{ws}/settings", json={"models": {"dev": {"model": "claude-opus-5"}}})
    assert settings.read()["model"] == "claude-opus-5"


def test_saving_the_effort_gives_the_workspace_choice_way(folder):
    api = Signed(folder)
    api("PUT", "/ws/{ws}/session/effort", json={"effort": "low"})
    api("PUT", "/ws/{ws}/settings", json={"effort": "xhigh"})
    assert "effort" not in (home.read_json(home.workspace_dir(api.ws) / "session.json", {}) or {})


def test_the_api_key_is_kept_private_and_never_sent_back(folder):
    api = Signed(folder)
    r = api("PUT", "/ws/{ws}/settings/api-key", json={"key": MADE_UP_KEY})
    assert r.status_code == 200 and MADE_UP_KEY not in r.text and r.json()["has_api_key"] is True
    p = home.root() / "api-key"
    assert stat.S_IMODE(p.stat().st_mode) == 0o600 and settings.api_key() == MADE_UP_KEY
    assert MADE_UP_KEY not in api("GET", "/ws/{ws}/settings").text
    bad = api("PUT", "/ws/{ws}/settings/api-key", json={"key": "two words"})
    assert bad.status_code == 400 and "two words" not in bad.text
    assert api("PUT", "/ws/{ws}/settings/api-key", content=b'"sk-just-a-string"',
               headers={"content-type": "application/json"}).status_code == 400
    assert api("DELETE", "/ws/{ws}/settings/api-key").json()["has_api_key"] is False
    assert not p.exists()


def test_check_says_why_it_cannot_sign_in(folder):
    api = Signed(folder)
    got = api("POST", "/ws/{ws}/settings/check").json()
    assert got["ok"] is False and "not signed in" in got["message"]
