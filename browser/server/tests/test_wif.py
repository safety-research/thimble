"""Workload Identity Federation from a config file (wif.py): the keys and their SDK spellings, the three token sources,
and errors and pages that never hold an ID. Every file and ID here is made up."""
import os

import pytest

from thimble_browser import llm, settings, wif

IDS = {"federation_rule_id": "fdrl_made_up_rule", "organization_id": "00000000-made-up0-org0-000000000000",
       "service_account_id": "svac_made_up_account", "workspace_id": "wrkspc_made_up_space"}


def write(path, text, mode=0o600):
    path.write_text(text)
    os.chmod(path, mode)
    return path


def toml(tmp_path, extra="", ids=IDS, name="wif.toml"):
    return write(tmp_path / name, "".join(f'{k} = "{v}"\n' for k, v in ids.items()) + extra)


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
