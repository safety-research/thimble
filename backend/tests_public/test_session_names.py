"""The names of the Claude Code sessions thimble starts (config.session_name): `thimble:<role> · <workspace>`, since
`claude agents` lists the sessions of every folder; a long name kept short and distinct, and main's name as launch-args
prints it (cli.main_name) and the launcher passes it. The statusline and /thimble:agents name thimble's agents by what
they do (tray.py)."""
from __future__ import annotations

import json
from pathlib import Path


from app import tray, cli, config, dev

CORPUS = "mini"
INSTALLED_COPY = cli.installed_copy  # before conftest's autouse fixture stands it in


def test_names_carry_the_workspace():
    assert config.session_name("main", "logs-2") == "thimble:main · logs-2"
    assert config.session_name("dev", None) == "thimble:dev", "a ticket of no workspace"
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

    head = [str(tmp_path / "plugin"), "mcp__x", "", "{}", ""]
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
    assert argv[argv.index("--plugin-dir") + 1] == str(tmp_path / "plugin")
    assert [a for a in argv if a.startswith("--")] == ["--plugin-dir", "--allowedTools", "--settings", "--name",
                                                       "--append-system-prompt", "--"], "no flag but these"
    argv = run("-c")
    assert argv[argv.index("--name") + 1] == "thimble:main · logs"
    assert argv[argv.index("--resume") + 1] == "sid-last"
    assert argv[argv.index("--append-system-prompt") + 1] == "the prompt"
    for own in (["-n", "mine"], ["--name", "mine"], ["--name=mine"]):
        argv = run(*own)
        assert "thimble:main · logs" not in argv and own[-1] in argv


def test_without_the_plugin_registered_the_launcher_loads_its_own_plugin_folder(tmp_path, monkeypatch):
    """thimble is not added to every Claude Code session unless asked (install.sh --plugin, `thimble plugin on`), so the
    launcher must load the plugin itself: when Claude Code lists no thimble copy of this install (installed_copy is
    None), launch-args names this tree's plugin folder and the launcher passes it with --plugin-dir; when launch-args
    names none (an installed copy, which Claude Code loads already), the launcher adds no --plugin-dir."""
    path = tmp_path / "path"
    path.mkdir()
    (path / "claude").write_text('#!/bin/sh\ncase "$*" in *"plugin list"*|*"marketplace list"*) echo "[]";; esac\n')
    (path / "claude").chmod(0o755)
    monkeypatch.setenv("PATH", f"{path}:/usr/bin:/bin")
    assert INSTALLED_COPY(tmp_path) is None
    (path / "claude").write_text('#!/bin/sh\ncase "$*" in *"plugin list"*) echo \'[{"id": "thimble@elsewhere", '
                                 '"enabled": true}]\';; *"marketplace list"*) echo "[]";; esac\n')
    assert INSTALLED_COPY(tmp_path) is None, "another marketplace's thimble is not this install's"
    name = config.marketplace_name()
    listed = json.dumps([{"id": f"thimble@{name}", "enabled": True}])
    markets = json.dumps([{"name": name, "source": "directory", "path": str(config.REPO_ROOT)}])
    (path / "claude").write_text(f"#!/bin/sh\ncase \"$*\" in *\"marketplace list\"*) echo '{markets}';; "
                                 f"*\"plugin list\"*) echo '{listed}';; esac\n")
    assert INSTALLED_COPY(tmp_path) == cli.Installed(cli.PLUGIN_DIR.resolve(), name), "the control: registered here"
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    logs = tmp_path / "work" / "logs"
    logs.mkdir(parents=True)
    assert cli.launch_args(logs).split("\n")[0] == str(cli.plugin_root()), "installed_copy None: load plugin/"

    work = tmp_path / "w"
    work.mkdir()
    launcher, cpath = _launcher(work, [str(work / "plugin"), "mcp__x", "", "{}", "", "thimble:main · w", "the prompt"])
    argv_out = tmp_path / "argv.txt"
    subprocess_env = {"PATH": f"{cpath}:/usr/bin:/bin", "HOME": str(tmp_path), "ARGV_OUT": str(argv_out)}
    import subprocess  # noqa: PLC0415

    subprocess.run(["bash", str(launcher)], check=True, capture_output=True, cwd=work, env=subprocess_env)
    argv = argv_out.read_text().splitlines()
    assert argv[argv.index("--plugin-dir") + 1] == str(work / "plugin")
    assert "--dangerously-load-development-channels" not in argv
    (work / "launch-args.txt").write_text("\n".join(["", "mcp__x", "", "{}", "", "thimble:main · w", "the prompt"]))
    subprocess.run(["bash", str(launcher)], check=True, capture_output=True, cwd=work, env=subprocess_env)
    argv = argv_out.read_text().splitlines()
    assert "--plugin-dir" not in argv and argv[-1] == "/thimble"


async def test_the_statusline_shows_the_orientation_and_its_cards_and_the_listing_plain_words(monkeypatch):
    """thimble's statusline shows the orientation's state and its cards, the other agents being rows of Claude Code's
    own tray; /thimble:agents lists every running agent of thimble's by what it does."""
    rows = [{"name": "thimble:orientation", "label": "orientation", "state": "working", "role": "orientation"},
            {"name": "thimble:writer", "label": "writer: report", "state": "waiting for a permission", "role": "writer"},
            {"name": "fork(thread:probe)", "state": "idle"}]
    monkeypatch.setattr(tray, "_cards", lambda c: 7)
    assert tray.status_line(CORPUS, rows) == "thimble · orientation working · 7 cards"
    assert tray.status_line(CORPUS, rows[1:]) == "", "no orientation runs"
    assert tray.listing_text(rows).splitlines()[:3] == [f"{'orientation':<18}  working",
                                                         f"{'writer: report':<18}  waiting for you",
                                                         "fork(thread:probe)  done"]
    monkeypatch.setattr(config, "workspace_for_cwd", lambda cwd: CORPUS)
    monkeypatch.setattr(tray, "agent_rows", lambda c: rows)
    got = await tray.agents_route(tray.AgentsQuery(cwd="/work", session="main-1", announce=True))
    assert got["line"] == "thimble · orientation working · 7 cards" and got["announce"] == ""
