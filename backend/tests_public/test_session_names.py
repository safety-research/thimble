"""The names of the Claude Code sessions thimble starts (config.session_name): `thimble:<role> · <workspace>`, since
`claude agents` lists the sessions of every folder; how bg_session addresses and shows them, a name an earlier build
gave (`thimble:writer`) or one a model wrote with another separator included, a long name kept short and distinct, and
main's name as launch-args prints it (cli.main_name) and the launcher passes it."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import bg_session, cli, config, dev, tools

CORPUS = "mini"


def test_names_carry_the_workspace():
    assert config.session_name("main", "logs-2") == "thimble:main · logs-2"
    assert config.session_name("dev", None) == "thimble:dev", "a ticket of no workspace"
    assert bg_session.name_of(CORPUS, "orient") == "thimble:orient · mini"
    assert bg_session.name_of(CORPUS, "writer:report") == "thimble:writer · mini"
    assert bg_session.name_of(CORPUS, "writer:story") == "thimble:writer-story · mini"
    assert bg_session.name_of(CORPUS, "critique") == "thimble:critic · mini"
    assert dev.dev_session_name(CORPUS) == "thimble:dev · mini"
    assert dev.view_session_name(CORPUS, "board") == "thimble:view-board · mini"


def test_a_long_name_stays_within_the_limit_and_distinct():
    name = config.session_name("view-" + "x" * 200, "field-logs")
    assert len(name) == config.SESSION_NAME_MAX and name.endswith(" · field-logs"), "the role gives way to a short workspace"
    assert name != config.session_name("view-" + "x" * 199, "field-logs")
    ws = "b" * 50
    v2, v3 = (config.session_name(f"writer-final-report-{v}", ws) for v in ("v2", "v3"))
    assert v2 != v3 and v2.startswith("thimble:writer-final-report-v2 · "), "the role is kept whole while the workspace can give"
    assert max(len(v2), len(v3)) <= config.SESSION_NAME_MAX
    long_ws = "w" * 100
    names = {r: config.session_name(r, long_ws) for r in ("main", "writer", "writer-story", "orient", "critic")}
    assert all(n.startswith(f"thimble:{r} · ") and len(n) <= config.SESSION_NAME_MAX for r, n in names.items())
    assert len(set(names.values())) == len(names)
    assert names["main"] != config.session_name("main", "w" * 99), "two long workspaces with one start stay apart"
    both = config.session_name("view-" + "x" * 200, long_ws)
    assert len(both) == config.SESSION_NAME_MAX
    assert len(config.session_name("dev-" + "y" * 200, None)) == config.SESSION_NAME_MAX


def test_role_drops_the_workspace_only_from_thimble_names():
    assert config.session_role("thimble:writer-story · logs") == "thimble:writer-story"
    assert config.session_role("thimble:orient") == "thimble:orient", "an earlier build's name"
    assert config.session_role("fork(thread:a · b)") == "fork(thread:a · b)"


@pytest.fixture()
def followed():
    """Two followed sessions of the workspace: a new one, and one an earlier build named without the workspace."""
    new = bg_session.Entry(CORPUS, "writer:report", bg_session.name_of(CORPUS, "writer:report"), "ab12cd34", "sid-1",
                           "chat-1", "writer", "/work/report")
    old = bg_session.Entry(CORPUS, "critique", "thimble:critic", "ef56ab78", "sid-2", "chat-2", "critique", "/work/c")
    bg_session._loaded.add(CORPUS)
    bg_session._entries[(CORPUS, new.key)] = new
    bg_session._entries[(CORPUS, old.key)] = old
    yield new, old
    bg_session._entries.pop((CORPUS, new.key), None)
    bg_session._entries.pop((CORPUS, old.key), None)
    bg_session._loaded.discard(CORPUS)


def test_by_name_matches_the_whole_name_and_its_ref(followed):
    new, old = followed
    assert bg_session.by_name(CORPUS, "thimble:writer · mini") is new
    assert bg_session.by_name(CORPUS, "Thimble:Writer · mini [3fa9c1]") is new, "SendMessage's ` [ref]`, any case"
    assert bg_session.by_name(CORPUS, "thimble:critic") is old, "an earlier build's name is still its address"


def test_by_name_takes_the_role_alone_unless_exact(followed):
    new, _old = followed
    assert bg_session.by_name(CORPUS, "thimble:writer") is new, "wait_session with the role alone"
    assert bg_session.by_name(CORPUS, "ab12cd34") is new
    # Claude Code delivers a SendMessage by the whole name, so `thimble:writer` reaches some other session
    assert bg_session.by_name(CORPUS, "thimble:writer", exact=True) is None
    assert bg_session.relay_check(CORPUS, None, "thimble:writer", "hello") is None


def test_the_tray_entry_is_described_by_the_session_name(followed):
    new, _old = followed
    hint = bg_session.proxy_start_hint(CORPUS, new.key)
    assert '`description` "thimble:writer · mini"' in hint
    prompt = Path(bg_session.proxy_prompt(CORPUS, new.key)).read_text("utf-8")
    assert 'SendMessage with `to` "thimble:writer · mini"' in prompt
    assert bg_session._by_tray(CORPUS, "thimble:writer", "thimble:writer · mini") is new


def test_record_keeps_the_name_claude_agents_lists(followed, monkeypatch):
    monkeypatch.setattr(bg_session, "_ensure_watcher", lambda: None)
    monkeypatch.setattr(bg_session.session, "find_transcript", lambda sid, config_dir=None: None)
    e = bg_session.record(CORPUS, "orient", short="99aa88bb", sid="sid-9", chat="chat-9", role="orient",
                          folder=Path("/work/o"), name="thimble:orient")
    assert e.name == "thimble:orient" and e.shown == "thimble:orient"
    bg_session._entries.pop((CORPUS, "orient"), None)
    e = bg_session.record(CORPUS, "orient", short="99aa88bc", sid="sid-9", chat="chat-9", role="orient",
                          folder=Path("/work/o"))
    assert e.name == "thimble:orient · mini" and e.shown == "thimble:orient"
    bg_session._entries.pop((CORPUS, "orient"), None)


def test_the_statusline_shows_roles_and_the_listing_plain_names():
    rows = [{"name": "thimble:writer · mini", "label": "writer: story", "state": "working"},
            {"name": "fork(thread:probe)", "state": "idle"}]
    assert bg_session.status_line(rows) == "thimble · ● thimble:writer working · ○ fork(thread:probe) idle"
    assert bg_session.listing_text(rows).splitlines()[:2] == [f"{'writer: story':<18}  working",
                                                              "fork(thread:probe)  done"]
    assert [bg_session.label_of(k) for k in ("orient", "critique:orient", "writer:report", "writer:story")] == [
        "orientation", "critic", "writer", "writer: story"]
    assert "{label}" not in tools.hint("bg-proxy-start", type="t", session="s", prompt="p", short="x")


async def test_the_agents_list_and_the_start_lines_name_each_agent_in_plain_words(followed, monkeypatch):
    """/thimble:agents and the lines main's terminal prints as a session starts name it by what it does, with no
    session name, id or command; the statusline keeps the roles."""
    _new, old = followed
    old.status, old.waiting_for = "waiting", "permission"
    monkeypatch.setattr(config, "workspace_for_cwd", lambda cwd: CORPUS)
    monkeypatch.setattr(bg_session, "_announced", {})
    monkeypatch.setattr(bg_session, "_announced_loaded", {CORPUS})
    monkeypatch.setattr(bg_session, "_save_announced", lambda c: None)
    got = await bg_session.agents_route(bg_session.AgentsQuery(cwd="/work", session="main-1", announce=True))
    assert got["text"] == "writer  working\ncritic  waiting for you\n\n↓ to follow any of them"
    assert got["announce"] == "writer started: ↓ to follow it\ncritic started: ↓ to follow it"
    assert got["line"] == "thimble · ● thimble:writer working · ◐ thimble:critic waiting for a permission"


def test_main_name_is_the_workspace_slash_thimble_opens(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    logs = tmp_path / "work" / "logs"
    (logs / "sub").mkdir(parents=True)
    assert cli.main_name(logs) == "thimble:main · logs", "a folder not registered yet: its basename"
    (data / "logs.corpus.json").write_text(json.dumps({"name": "logs", "path": str(tmp_path / "elsewhere" / "logs")}))
    assert cli.main_name(logs) == "thimble:main · logs-2", "the basename is taken: the next free name"
    (data / "logs-2.corpus.json").write_text(json.dumps({"name": "logs-2", "path": str(logs)}))
    assert cli.main_name(logs) == "thimble:main · logs-2", "a registered folder: its workspace"
    assert cli.main_name(logs / "sub") == "thimble:main · sub", "/thimble opens a folder inside as its own workspace"


def test_main_name_skips_only_a_readable_sidecar(tmp_path, monkeypatch):
    """An unreadable sidecar holds no name for register_corpus (config.free_name), so main's name does not skip it."""
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    logs = tmp_path / "work" / "logs"
    logs.mkdir(parents=True)
    (data / "logs.corpus.json").write_text("{not json")
    assert cli.main_name(logs) == "thimble:main · logs"
    assert config.free_name("logs", data) == "logs"


def test_launch_args_put_mains_name_before_the_resume_id_and_the_prompt(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    logs = tmp_path / "work" / "logs"
    logs.mkdir(parents=True)
    monkeypatch.setattr(cli, "last_main", lambda cwd: "sid-last")
    plain = cli.launch_args(logs).split("\n")
    assert plain[5] == cli.main_name(logs) == "thimble:main · logs"
    assert "\n".join(plain[6:]).strip() and plain[6] != "sid-last", "the prompt follows the name"
    resumed = cli.launch_args(logs, resume=True).split("\n")
    assert resumed[5] == "thimble:main · logs" and resumed[6] == "sid-last"
    assert resumed[7:] == plain[6:]


def _launcher(tmp_path: Path, lines: list[str]) -> tuple[Path, Path]:
    """plugin/bin/thimble in a tree of stubs: launch-args prints `lines`, and `claude` writes its argv, one per line."""
    import shutil  # noqa: PLC0415

    bin_ = tmp_path / "plugin" / "bin"
    bin_.mkdir(parents=True)
    shutil.copy(Path(__file__).resolve().parents[2] / "plugin" / "bin" / "thimble", bin_ / "thimble")
    (tmp_path / "backend").mkdir()
    out = tmp_path / "launch-args.txt"
    out.write_text("\n".join(lines))
    stubs = {"thimble-app-dir": f'#!/bin/sh\necho "{tmp_path}"\n',
             "thimble-python": f'#!/bin/sh\ncase " $* " in *" --resume "*) cat "{out}.resume";; *) cat "{out}";; esac\n'}
    for name, body in stubs.items():
        (bin_ / name).write_text(body)
        (bin_ / name).chmod(0o755)
    path = tmp_path / "path"
    path.mkdir()
    (path / "claude").write_text('#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$ARGV_OUT"\n')
    (path / "claude").chmod(0o755)
    return bin_ / "thimble", path


def test_the_launcher_passes_mains_name_and_lets_the_analysts_win(tmp_path):
    import subprocess  # noqa: PLC0415

    head = ["plugin:thimble@inline", "mcp__x", "", "{}", ""]
    launcher, path = _launcher(tmp_path, [*head, "thimble:main · logs", "the prompt"])
    (tmp_path / "launch-args.txt.resume").write_text("\n".join([*head, "thimble:main · logs", "sid-last", "the prompt"]))
    argv_out = tmp_path / "argv.txt"

    def run(*flags: str) -> list[str]:
        subprocess.run(["bash", str(launcher), *flags], check=True, capture_output=True, cwd=tmp_path,
                       env={"PATH": f"{path}:/usr/bin:/bin", "HOME": str(tmp_path), "ARGV_OUT": str(argv_out)})
        return argv_out.read_text().splitlines()

    argv = run()
    assert argv[argv.index("--name") + 1] == "thimble:main · logs" and "--resume" not in argv
    assert argv[argv.index("--append-system-prompt") + 1] == "the prompt"
    argv = run("-c")
    assert argv[argv.index("--name") + 1] == "thimble:main · logs"
    assert argv[argv.index("--resume") + 1] == "sid-last"
    assert argv[argv.index("--append-system-prompt") + 1] == "the prompt"
    for own in (["-n", "mine"], ["--name", "mine"], ["--name=mine"]):
        argv = run(*own)
        assert "thimble:main · logs" not in argv and own[-1] in argv


def test_by_name_takes_the_role_before_any_separator(followed):
    new, _old = followed
    for mangled in ("thimble:writer - mini", "thimble:writer • mini", "thimble:writer·mini", "thimble:writer  ·  mini"):
        assert bg_session.by_name(CORPUS, mangled) is new, mangled
        assert bg_session.by_name(CORPUS, mangled, exact=True) is None


def test_a_peer_messages_sender_is_found_in_a_slugged_name(followed):
    new, old = followed
    assert bg_session.by_origin(CORPUS, "thimble:writer · mini") is new
    assert bg_session.by_origin(CORPUS, "thimble-writer-mini") is new
    assert bg_session.by_origin(CORPUS, "thimble-writer") is new
    assert bg_session.by_origin(CORPUS, "thimble-critic") is old
    assert bg_session.by_origin(CORPUS, "thimble-dev") is None


def test_a_session_started_again_keeps_its_start_flags(monkeypatch, tmp_path, workspaces_tmp):
    """Claude Code keeps none of an ended session's options, so a session started again is passed its whole argv."""
    import asyncio

    calls: list[list[str]] = []
    sid = "0123abcd-0000-0000-0000-000000000000"

    def cli(bin_, args, env, cwd=None, timeout=0):
        calls.append(args)
        return 0, "backgrounded · 9999ffff"

    monkeypatch.setattr(bg_session.shutil, "which", lambda *a, **k: "/bin/claude")
    monkeypatch.setattr(bg_session, "_cli", cli)
    monkeypatch.setattr(bg_session, "listing", lambda *a: [{"id": "9999ffff", "sessionId": "9999ffff-1", "pid": 1}])
    argv = ["claude", "-p", "--resume", sid, "--disallowedTools", "WebFetch", "--settings", json.dumps({"hooks": {}})]
    proc = asyncio.run(bg_session.start(CORPUS, "orient", argv, tmp_path, {}, "go on", sid, "chat", "orient"))
    got = calls[-1]
    assert got[:3] == ["--bg", "--resume", sid] and got.count("--resume") == 1
    assert "--settings" in got and got[got.index("--disallowedTools") + 1] == "WebFetch"
    assert got[got.index("-n") + 1] == bg_session.name_of(CORPUS, "orient") and proc.session_id == "9999ffff-1"
