"""The 0.9.0 scaffold's routes: each new command of the build spec's section 4 answers its stub's JSON with exit 0 through
plugin/bin/thimble (activate, guide, features, open, state coverage | label-unsure | answer-comments, act coverage
--stdin, act answer-comment-resolve), the shim lists load_thimble alone in a folder that is no workspace, and
local.transport reads launch.json. Each owner's tests replace these once its lane lands; the integrator deletes this
file then."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from app import config

THIMBLE = config.REPO_ROOT / "plugin" / "bin" / "thimble"
SID = "11111111-1111-4111-8111-111111111111"


@pytest.fixture()
def setup(tmp_path):
    """A corpus folder, and the environment of a command a session runs there (its own home, data and workspaces)."""
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "events.jsonl").write_text('{"a": 1}\n{"a": 2}\n')
    env = {k: v for k, v in os.environ.items() if not k.startswith("THIMBLE_") and k != "CLAUDE_CODE_SESSION_ID"}
    env.update({"THIMBLE_HOME": str(tmp_path / "home"), "THIMBLE_DATA_DIR": str(tmp_path / "data"),
                "THIMBLE_WORKSPACES_DIR": str(tmp_path / "workspaces"), "CLAUDE_CONFIG_DIR": str(tmp_path / "cc")})
    return corpus, env, tmp_path


def run(env: dict, cwd: Path, *argv: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([str(THIMBLE), *argv], cwd=cwd, env=env, input=stdin, capture_output=True, text=True,
                          timeout=120)


def answer(r: subprocess.CompletedProcess) -> dict:
    assert r.returncode == 0, (r.stdout, r.stderr)
    return json.loads(r.stdout)


def test_activate_registers_the_folder_and_writes_the_session_files(setup):
    corpus, env, tmp = setup
    got = answer(run(env, corpus, "activate", "--cwd", str(corpus), "--session", SID, "--via", "command", "--mod",
                     "--json"))
    assert got["ok"] is True and got["session"] == SID and got["role"] == "main" and got["first_in_folder"] is True
    assert got["took_over"] is None and set(got["settings"]) == {"autoActivate", "viewProposals", "labels", "checks",
                                                                 "citationMarks", "coverage", "cardCheck"}
    marker = tmp / "home" / "up" / f"{SID}.active"
    rec = json.loads(marker.read_text())
    assert rec["mod"] is True and rec["via"] == "command" and rec["role"] == "main" and rec["ws"] == got["ws"]
    assert oct(marker.stat().st_mode & 0o777) == oct(0o600)
    launch = json.loads((Path(got["path"]) / "trusted" / "launch.json").read_text())
    assert launch["session"] == SID and launch["transport"] == "local" and "mode" not in launch
    assert len((tmp / "home" / "up" / SID / "guide-marker").read_text().strip()) == 8
    assert list((tmp / "home" / "active").iterdir()), "the folder marker the hooks' gate reads"
    # again, without --mod: idempotent, and `mod` stays true
    again = answer(run(env, corpus, "activate", "--cwd", str(corpus), "--session", SID, "--via", "data", "--json"))
    assert again["ok"] is True and again["first_in_folder"] is False
    assert json.loads(marker.read_text())["mod"] is True and json.loads(marker.read_text())["via"] == "command"


def test_activate_refuses_the_home_folder_and_the_root(setup):
    corpus, env, tmp = setup
    home = tmp / "fakehome"
    home.mkdir()
    env = {**env, "HOME": str(home)}
    for folder, code in ((home, "REFUSED_HOME"), (Path("/"), "REFUSED_ROOT")):
        got = answer(run(env, corpus, "activate", "--cwd", str(folder), "--session", SID, "--via", "data", "--json"))
        assert got["ok"] is False and got["error"]["code"] == code and got["error"]["fix"]


def test_guide_prints_the_lead_line_then_main_s_prompt_and_marks_once(setup):
    corpus, env, tmp = setup
    answer(run(env, corpus, "activate", "--cwd", str(corpus), "--session", SID, "--via", "command", "--json"))
    marker = (tmp / "home" / "up" / SID / "guide-marker").read_text().strip()
    r = run(env, corpus, "guide", "--cwd", str(corpus), "--session", SID, "--if-owed", "--mark")
    assert r.returncode == 0 and r.stdout.startswith(f"thimble guidance {marker}: thimble is on in this folder.")
    assert "thimble" in r.stdout and len(r.stdout) > 1000
    assert json.loads((tmp / "home" / "up" / SID / "guide.json").read_text())["digest"]
    again = run(env, corpus, "guide", "--cwd", str(corpus), "--session", SID, "--if-owed", "--mark")
    assert again.returncode == 0 and again.stdout == ""
    assert run(env, corpus, "guide", "--cwd", str(corpus), "--session", SID, "--unmark").returncode == 0
    assert run(env, corpus, "guide", "--cwd", str(corpus), "--session", SID, "--if-owed").stdout.startswith(
        "thimble guidance")


def test_features_answers_every_switch_on_and_stores_a_change(setup):
    corpus, env, tmp = setup
    got = answer(run(env, corpus, "features", "--json"))
    assert got["settings"] == {k: True for k in ("autoActivate", "viewProposals", "labels", "checks", "citationMarks",
                                                 "coverage", "cardCheck")}
    off = answer(run(env, corpus, "features", "--json", "--set", "labels=off"))
    assert off["settings"]["labels"] is False and off["at"] > 0
    assert json.loads((tmp / "home" / "config.json").read_text())["features"] == {"labels": False}


def test_open_answers_not_built(setup):
    corpus, env, _ = setup
    got = answer(run(env, corpus, "open", "--cwd", str(corpus), "--ref", "home", "--json"))
    assert got == {"ok": False, "error": {"code": "NOT_BUILT", "message": "thimble open is not built yet",
                                          "fix": "wait for the browser lane"}}


def test_coverage_label_unsure_and_answer_comments_answer_their_stubs(setup):
    corpus, env, _ = setup
    answer(run(env, corpus, "activate", "--cwd", str(corpus), "--session", SID, "--via", "command", "--json"))
    facts = {"session": SID, "turn": "u1", "facts": [
        {"path": "events.jsonl", "how": "part", "lines": [1, 1], "total": 2, "by": "Read", "at": 1.0},
        {"path": "events.jsonl", "how": "whole", "by": "Bash", "at": 2.0},
        {"path": "src/a.py", "how": "whole", "by": "Read", "at": 3.0},
        {"path": "/elsewhere/b.jsonl", "how": "whole", "by": "Read", "at": 4.0}]}
    got = answer(run(env, corpus, "act", "coverage", "--cwd", str(corpus), "--stdin", stdin=json.dumps(facts)))
    # the features lane's coverage (C7): with no index yet, the files the facts name; src/a.py and a path outside
    # the corpus are dropped (the line in the owner's read/searched words, 10-16)
    assert got["ok"] is True and got["summary"]["line"] == "read 1 file" and got["counting"] is True
    assert got["summary"]["files"]["seen"] == 1 and got["summary"]["records"]["counted"] is False
    state = answer(run(env, corpus, "state", "coverage", "--cwd", str(corpus), "--session", SID))
    assert state["summary"]["files"]["seen"] == 1 and state["folder"] == "" and isinstance(state["rows"], list)
    assert "rows" not in answer(run(env, corpus, "state", "coverage", "--cwd", str(corpus), "--session", SID,
                                    "--summary"))
    assert answer(run(env, corpus, "state", "label-unsure", "--cwd", str(corpus), "--counts")) == {"labels": []}
    assert answer(run(env, corpus, "state", "answer-comments", "--cwd", str(corpus), "--session", SID)) == \
        {"comments": [], "running": []}
    # a comment that is not there is refused (C9's act resolves a comment of the store)
    r = run(env, corpus, "act", "answer-comment-resolve", "--cwd", str(corpus),
            json.dumps({"comment": "c1", "reopen": False}))
    assert "no comment 'c1'" in r.stdout


def test_the_shim_lists_load_thimble_alone_in_a_folder_that_is_no_workspace(setup):
    corpus, env, _ = setup
    r = subprocess.run([str(config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"), "--list"], cwd=corpus, env=env,
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0  # --list prints the full set, as before; build_server's S0 listing is test_shim.py's
    from app import activate

    assert activate.LOAD_TOOL["name"] == "load_thimble" and activate.LOAD_TOOL["input_schema"] == {
        "type": "object", "properties": {}}


def test_local_transport_reads_launch_json(workspaces_tmp):
    from app import local
    from terminal_fakes import CORPUS, write_launch

    ws = config.workspace_dir(CORPUS)
    assert local.transport(CORPUS) == "local"  # no launch.json yet
    write_launch(ws, session="s1", mode="terminal")
    assert local.transport(CORPUS) == "local" and local.terminal(CORPUS)
    write_launch(ws, session="s1", mode="browser")
    assert local.transport(CORPUS) == "server" and local.transport(CORPUS, "s1") == "server"
    assert local.transport(CORPUS, "s2") == "local"  # another session: never the server's
    (ws / "trusted" / "launch.json").write_text(json.dumps({"session": "s1", "transport": "local"}))
    assert local.transport(CORPUS) == "local" and local.terminal(CORPUS)
    (ws / "trusted" / "launch.json").write_text(json.dumps({"session": "s1", "transport": "server", "peers": ["s3"]}))
    assert local.transport(CORPUS, "s1") == "server" and local.transport(CORPUS, "s3") == "local"


def test_answer_ended_is_a_no_op_for_now(workspaces_tmp):
    from app import checks
    from terminal_fakes import CORPUS

    assert checks.answer_ended(CORPUS, {"sid": "s1", "turn": "u1", "rows": [], "tools": [], "at": 0.0}) is None
