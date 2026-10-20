"""Workload Identity Federation from a config file (wif.py): the keys and their SDK spellings, the three token sources,
and errors and pages that never hold an ID. Every file and ID here is made up."""
import os
import sys

import pytest
from browser_client import Signed

from thimble_browser import llm, settings, wif

IDS = {"federation_rule_id": "fdrl_made_up_rule", "organization_id": "00000000-made-up0-org0-000000000000",
       "service_account_id": "svac_made_up_account", "workspace_id": "wrkspc_made_up_space"}


def write(path, text, mode=0o600):
    path.write_text(text)
    os.chmod(path, mode)
    return path


def toml(tmp_path, extra="", ids=IDS, name="wif.toml"):
    return write(tmp_path / name, "".join(f'{k} = "{v}"\n' for k, v in ids.items()) + extra)


def test_plain_keys_and_a_google_token_by_default(tmp_path):
    conf = wif.load(str(toml(tmp_path)))
    assert conf.ids == IDS and conf.source == "google" and conf.audience == wif.DEFAULT_AUDIENCE
    assert conf.describe() == "a Google identity token for https://api.anthropic.com"
    other = wif.load(str(toml(tmp_path, 'token_source = "google"\naudience = "https://made-up.example"\n')))
    assert other.audience == "https://made-up.example"


def test_the_sdk_names_in_key_value_lines_and_a_token_file_read_each_time(tmp_path):
    token = write(tmp_path / "token", "made-up-token-1\n")
    names = {"federation_rule_id": "ANTHROPIC_FEDERATION_RULE_ID", "organization_id": "ANTHROPIC_ORGANIZATION_ID",
             "service_account_id": "ANTHROPIC_SERVICE_ACCOUNT_ID", "workspace_id": "ANTHROPIC_WORKSPACE_ID"}
    lines = "# made up\n" + "".join(f"{names[k]}={v}\n" for k, v in IDS.items()) + f"ANTHROPIC_IDENTITY_TOKEN_FILE={token}\n"
    conf = wif.load(str(write(tmp_path / "wif.env", lines)))
    assert conf.ids == IDS and conf.source == "file" and conf.describe() == f"the token file {token}"
    get = conf.token_provider()
    assert get() == "made-up-token-1"
    token.write_text("made-up-token-2")
    assert get() == "made-up-token-2"


def test_a_token_command(tmp_path):
    ok = wif.load(str(toml(tmp_path, f'token_command = ["{sys.executable}", "-c", "print(\'made-up-token\')"]\n')))
    assert ok.source == "command" and ok.token_provider()() == "made-up-token"
    assert ok.describe() == f"the command {os.path.basename(sys.executable)}"
    bad = wif.load(str(toml(tmp_path, 'token_source = "command"\ntoken_command = "false"\n')))
    with pytest.raises(wif.WifError, match="exit code 1"):
        bad.token_provider()()
    with pytest.raises(wif.WifError, match="was not found"):
        wif.load(str(toml(tmp_path, 'token_command = "no-such-made-up-command"\n'))).token_provider()()


def test_an_unusable_file_is_refused_in_words_without_its_values(tmp_path, monkeypatch):
    # the environment is never read: the SDK's variable does not fill in a missing ID
    monkeypatch.setenv("ANTHROPIC_FEDERATION_RULE_ID", "fdrl_from_the_environment")
    cases = {
        "no federation_rule_id": toml(tmp_path, ids={k: v for k, v in IDS.items() if k != "federation_rule_id"}, name="a"),
        "token_source is one of": toml(tmp_path, 'token_source = "elsewhere"\n', name="b"),
        "needs token_file": toml(tmp_path, 'token_source = "file"\n', name="c"),
        "no file": tmp_path / "missing.toml",
    }
    for want, path in cases.items():
        with pytest.raises(wif.WifError, match=want) as got:
            wif.load(str(path))
        assert not any(v in str(got.value) for v in [*IDS.values(), "fdrl_from_the_environment"])
    with pytest.raises(wif.WifError, match="chmod go-w"):
        wif.load(str(write(tmp_path / "shared.toml", toml(tmp_path).read_text(), 0o666)))


def test_the_client_and_its_failures_name_the_file_not_the_ids(tmp_path):
    path = toml(tmp_path, 'token_command = "false"\n')
    settings.write({"credentials": {"source": "wif", "file": str(path)}})
    assert llm.client() is not None
    said = llm.describe()
    assert said == f"Workload Identity Federation from {path} (the command false)"
    msg = llm.failure(wif.WifError("the token command false failed with exit code 1"))
    assert str(path) in msg and " UTC" in msg and not any(v in msg for v in IDS.values())
    path.unlink()
    with pytest.raises(llm.NoCredentials, match="no file"):
        llm.client()


def test_settings_show_the_path_and_the_token_source_never_the_ids(folder, tmp_path):
    path = toml(tmp_path)
    api = Signed(folder)
    r = api("PUT", "/ws/{ws}/settings", json={"credentials": {"source": "wif", "file": str(path)}})
    assert r.status_code == 200
    got = r.json()
    assert got["credentials"] == {"source": "wif", "file": str(path)}
    assert got["wif"] == {"file": str(path), "token": "a Google identity token for https://api.anthropic.com", "error": None}
    assert not any(v in r.text for v in IDS.values())
    assert not any(v in api("GET", "/ws/{ws}/settings").text for v in IDS.values())
    bad = api("PUT", "/ws/{ws}/settings", json={"credentials": {"source": "wif", "file": str(tmp_path / "missing.toml")}})
    assert bad.status_code == 400 and "no file" in bad.text
    assert settings.read()["credentials"]["file"] == str(path)
    path.unlink()
    assert "no file" in api("GET", "/ws/{ws}/settings").json()["wif"]["error"]
