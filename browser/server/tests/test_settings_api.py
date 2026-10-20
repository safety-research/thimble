"""Settings in the page (settings_api.py): the sign-in, the model, the effort and the features' switches; an API key is
kept readable by this user alone and never sent back."""
import stat

from browser_client import Signed

from thimble_browser import home, settings

MADE_UP_KEY = "sk-made-up-0123456789"


def test_the_settings_and_their_choices(folder):
    api = Signed(folder)
    got = api("GET", "/ws/{ws}/settings").json()
    assert got["model"] == "claude-opus-5-5" and got["effort"] == "high"
    assert all(f["on"] for f in got["features"])
    assert "claude-opus-5-5" in got["choices"]["models"] and got["wif"] is None
    assert got["signed_in"] == "none" and got["has_api_key"] is False
    assert got["models"]["main"]["model"] == "claude-opus-5-5"


def test_a_change_is_saved_and_a_bad_one_refused(folder, tmp_path):
    conf = tmp_path / "wif.toml"
    conf.write_text('federation_rule_id = "fdrl_made_up"\norganization_id = "made-up-org"\ntoken_file = "/made/up/token"\n')
    conf.chmod(0o600)
    api = Signed(folder)
    r = api("PUT", "/ws/{ws}/settings", json={"credentials": {"source": "wif", "file": str(conf)}, "model": "claude-sonnet-5-5",
                                              "effort": "max", "features": {"lenses": False}})
    assert r.status_code == 200
    got = r.json()
    assert got["credentials"] == {"source": "wif", "file": str(conf)}
    assert got["signed_in"] == f"Workload Identity Federation from {conf} (the token file /made/up/token)"
    assert settings.read()["model"] == "claude-sonnet-5-5" and settings.read()["features"] == {"lenses": False}
    assert api("PUT", "/ws/{ws}/settings", json={"credentials": {"source": "wif", "file": str(folder)}}).status_code == 400
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
