"""The notebook kernel's sandbox (app/kernel_wrap.py, app/kernel_srt.mjs): the rules Anthropic's sandbox runtime gets on
macOS and Linux, the Seatbelt profile it makes of them on macOS, and what the server does around a sandboxed kernel."""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from app import channel, config, kernel_wrap, notebook, srt, views

SRT = srt.package(config.REPO_ROOT)
NODE = srt.node()
LINUX = sys.platform.startswith("linux")
WS, CORPUS, HOME = "/Users/matt/.thimble/workspaces/w", "/Users/matt/corpus", "/Users/matt"


def _uv_venv(tmp_path):
    """A venv whose bin/python links to a uv-managed interpreter through its folder link per minor version."""
    real = tmp_path / "uv" / "cpython-3.12.13-macos-aarch64-none"
    (real / "bin").mkdir(parents=True)
    (real / "bin" / "python3.12").write_text("")
    minor = real.with_name("cpython-3.12-macos-aarch64-none")
    minor.symlink_to(real.name)
    venv = tmp_path / "venv"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").symlink_to(minor / "bin" / "python3.12")
    return venv, minor, real


def _rules(tmp_path, platform: str) -> tuple[dict, tuple]:
    venv, minor, real = _uv_venv(tmp_path)
    rules = kernel_wrap.srt_rules(corpus_dir=CORPUS, workspace_dir=WS, venv=venv, python=venv / "bin" / "python",
                                  srt_dir="/app/frontend/node_modules/@anthropic-ai/sandbox-runtime",
                                  read=["/app/backend/app/fonts"], hide=[f"{HOME}/.thimble", f"{HOME}/.claude"],
                                  home=HOME, platform=platform)
    return rules, (venv, minor, real)


def test_on_macos_srt_hides_the_home_and_user_data_and_shows_the_kernel_its_own_paths(tmp_path):
    """The kernel under srt on macOS reads neither the home folder, other users' folders, other volumes, the temp
    folders nor thimble's and Claude Code's folders; it reads the corpus, the workspace, the venv, each folder its
    interpreter resolves through and the fonts; it writes only the workspace; the workspace's config stays hidden and
    read-only inside the workspace, telemetry.jsonl, the view log, the registry folder, the views' state and the
    workspace's local extension read-only."""
    rules, (venv, minor, real) = _rules(tmp_path, "darwin")
    fs = rules["filesystem"]
    hidden = {f"{WS}/settings.json", f"{WS}/config.json"}
    assert {HOME, "/Users", "/Volumes", "/private/tmp", "/private/var/folders", f"{HOME}/.thimble", f"{HOME}/.claude",
            *hidden} <= set(fs["denyRead"])
    assert {CORPUS, WS, str(venv), str(minor), str(real), "/app/backend/app/fonts"} <= set(fs["allowRead"])
    assert not any("sandbox-runtime" in p for p in fs["allowRead"]), "apply-seccomp runs only on Linux"
    assert fs["allowWrite"] == [WS]
    read_only = {f"{WS}/telemetry.jsonl", f"{WS}/viewed.jsonl", f"{WS}/registry", f"{WS}/views", f"{WS}/extension"}
    assert set(fs["denyWrite"]) == {*hidden, *read_only, "/tmp/claude", "/private/tmp/claude"}
    linux = _rules(tmp_path / "l", "linux")[0]["filesystem"]
    assert {"/home", "/tmp", "/mnt", "/run/user"} <= set(linux["denyRead"]) and "/Users" not in linux["denyRead"]
    assert "/app/frontend/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp" in linux["allowRead"]


@pytest.mark.skipif(NODE is None or SRT is None, reason="needs node and frontend/node_modules (scripts/check.sh install)")
def test_srt_makes_a_seatbelt_profile_of_the_rules_that_keeps_the_workspace_config_hidden(tmp_path):
    """With the platform mocked as macOS, the profile srt makes of the rules (kernel_srt.mjs --print) denies reads under
    the home, allows the kernel's paths after that, denies the workspace's config after those, allows writes to the
    workspace alone, leaves the network open and runs the kernel under sandbox-exec."""
    rules = _rules(tmp_path, "darwin")[0]
    macos = "data:text/javascript,Object.defineProperty(process,'platform',{value:'darwin'})"
    r = subprocess.run([NODE, "--import", macos, str(kernel_wrap.SRT_LAUNCHER), "--print", str(SRT), json.dumps(rules),
                        "--", "python3", "-m", "ipykernel_launcher"], capture_output=True, text=True, timeout=60,
                       cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    profile = r.stdout
    assert "/usr/bin/sandbox-exec" in profile and "(allow network*)" in profile

    def at(clause: str, sub: str, start: int = 0) -> int:
        i = profile.index(clause, start)
        return profile.index(f'(subpath "{sub}")', i)

    home_denied = at("(deny file-read*", HOME)
    corpus_allowed = at("(allow file-read*\n", CORPUS, home_denied)
    config_denied = at("(deny file-read*", f"{WS}/settings.json", corpus_allowed)
    assert home_denied < corpus_allowed < config_denied
    writes = profile[profile.index("; File write"):]
    allowed = writes[writes.index("(allow file-write*"):writes.index("(with message", writes.index("(allow file-write*"))]
    assert f'(subpath "{WS}")' in allowed and HOME + '"' not in allowed and CORPUS not in allowed


def test_on_linux_srt_hides_a_folder_inside_a_hidden_one_by_the_outer_rule_unless_something_between_is_shown():
    """The home inside /home, and thimble's folder inside the home, are hidden by /home's rule alone, which lets srt
    show uv's minor-version link inside the home; with the corpus being the home, thimble's folder keeps its own rule,
    and the workspace's config inside the shown workspace always does."""
    ws = "/home/u/.thimble/workspaces/w"

    def deny(corpus: str) -> set[str]:
        rules = kernel_wrap.srt_rules(corpus_dir=corpus, workspace_dir=ws, venv=None, python="/usr/bin/python3",
                                      srt_dir="/srt", hide=["/home/u/.thimble"], home="/home/u", platform="linux")
        return set(rules["filesystem"]["denyRead"])

    config_files = {f"{ws}/settings.json", f"{ws}/config.json"}
    assert "/home" in deny("/data/c") and config_files <= deny("/data/c")
    assert not {"/home/u", "/home/u/.thimble"} & deny("/data/c")
    assert {"/home/u", "/home/u/.thimble", *config_files} <= deny("/home/u")


def _wrap_works(wrap: str) -> bool:
    if wrap == "srt":
        return kernel_wrap.srt_works(NODE, SRT)
    return LINUX and kernel_wrap.works()


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
def test_on_linux_a_venv_whose_python_goes_through_uv_s_minor_version_folder_runs_wrapped(wrap, tmp_path):
    """A venv's python that links into uv's minor-version folder (cpython-3.12-… → cpython-3.12.13-…) in the home folder
    runs in the kernel's sandbox: the link resolves inside it as outside, though the home lies in /tmp, both hidden."""
    if not (LINUX and _wrap_works(wrap)):
        pytest.skip(f"{wrap} can't sandbox a process here")
    home = tmp_path / "home"
    real = home / ".local" / "share" / "uv" / "python" / "cpython-3.12.13-linux-x86_64-gnu"
    (real / "bin").mkdir(parents=True)
    (real / "bin" / "python3.12").symlink_to(os.path.realpath(sys.executable))
    minor = real.with_name("cpython-3.12-linux-x86_64-gnu")
    minor.symlink_to(real.name)
    venv, ws, corpus, conn = (tmp_path / n for n in ("venv", "ws", "corpus", "conn"))
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").symlink_to(minor / "bin" / "python3.12")
    for d in (ws, corpus, conn, *(ws / name for name in kernel_wrap.READ_ONLY_DIRS)):
        d.mkdir()
    for name in kernel_wrap.HIDDEN_FILES:
        (ws / name).write_text("{}\n")
    py = str(venv / "bin" / "python")
    cmd = [py, "-c", "print('ran')"]
    if wrap == "srt":
        rules = kernel_wrap.srt_rules(corpus_dir=corpus, workspace_dir=ws, venv=venv, python=py, srt_dir=SRT, home=home,
                                      platform=sys.platform)
        argv, env = kernel_wrap.srt_argv(cmd, node=NODE, srt_dir=SRT, rules=rules), kernel_wrap.srt_env(dict(os.environ), home=ws)
    else:
        argv, env = kernel_wrap.kernel_wrap_argv(cmd, corpus_dir=corpus, workspace_dir=ws, connection_dir=conn, venv=venv,
                                                 python=py), None
    r = subprocess.run(argv, capture_output=True, text=True, timeout=60, env=env, cwd=ws, stdin=subprocess.DEVNULL)
    assert (r.returncode, r.stdout.strip()) == (0, "ran"), r.stderr[-2000:]


READER = """
def build_index(paths):
    return sum(1 for p in paths for _ in open(p))


def records(index, query):
    return index


def resolve(index, locator):
    return None
"""
CARD = """
import json, os, pathlib
ws = pathlib.Path.cwd().parent
local, state, registry = ws / "extension", ws / "views", ws / "registry"
views = local / "views"
said = [json.loads((views / "posts" / "view.json").read_text())["accepts"][0]["means"]]
forged = {"name": "x", "claims": ["board.jsonl"], "accepts": [{"form": "L<n>", "means": "WRITTEN-BY-A-CARD"}], "built": "x"}
for path in (views / "posts" / "view.json", views / "planted" / "view.json", local / "extension.json",
             state / "proposals.json", registry / "card_types.json", registry / "extensions.json"):
    try:
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(forged))
        said.append("wrote")
    except OSError:
        said.append("refused")
for folder in (local, state):
    try:
        os.rename(folder, ws / "moved")
        said.append("moved")
    except OSError:
        said.append("kept")
print(*said)
"""


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_card_code_reads_the_views_but_can_t_change_the_forms_main_s_prompt_lists(wrap, monkeypatch, workspaces_tmp):
    """In the wrapped kernel a card's code reads a view's view.json in the workspace's local extension but can neither
    change it, plant a view, rewrite the extension's manifest or the proposals, nor move either folder away, so nothing
    it writes reaches the citation forms of main's prompt, nor rewrite the card types and extensions of the registry
    folder; the views kernel still reads the reader and keeps its index and the bytes it read outside the views."""
    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    views.write_view("mini", "posts", name="Posts", description="", claims=["board.jsonl"],
                     accepts=[{"form": "L<n>", "means": "one post"}], reader=READER, html="<p>posts</p>")
    registry = config.registry_dir("mini")
    for name in ("card_types.json", "extensions.json"):
        (registry / name).write_text("{}\n")
    try:
        cell = await notebook.run_code("mini", CARD, "main")
        said = "".join(b.get("text/plain", "") for b in cell["outputs"]).split()
        assert said == ["one", "post", *["refused"] * 6, "kept", "kept"], said
        assert all((registry / name).read_text() == "{}\n" for name in ("card_types.json", "extensions.json"))
        prompt = channel.session_prompt(str(config.corpus_dir("mini")))
        assert "one post (Posts)" in views.forms_text("mini") and "one post" in prompt and "WRITTEN-BY-A-CARD" not in prompt
        assert await views.reader_call("mini", "posts", "records") == 8
        assert list(views.index_dir("mini", "posts").glob("*.index.pickle"))
        assert list(views.index_dir("mini", "posts").glob("*.reads.json"))
    finally:
        await notebook.shutdown_all()


def test_a_workspace_set_to_srt_never_runs_unwrapped(monkeypatch, workspaces_tmp):
    """A workspace whose settings name srt gets no kernel when node or the runtime is missing, rather than one that runs
    outside the sandbox."""
    monkeypatch.setattr(srt, "node", lambda: None)
    with pytest.raises(RuntimeError, match="node is not on PATH"):
        notebook.sandboxed_argv(["python"], workspace="mini", corpus=config.corpus_dir("mini"))


def test_the_start_up_sweep_leaves_a_sandboxed_kernel_s_processes_alone():
    """Under srt the kernel runs below the recorded launcher in a session of its own, so the sweep of unrecorded
    kernels counts every process below a claimed one as claimed."""
    tree = {40: 30, 30: 20, 20: 10, 99: 1}
    assert notebook._descends(40, {10}, tree) and notebook._descends(30, {20}, tree)
    assert not notebook._descends(99, {10}, tree) and not notebook._descends(10, {40}, tree)


def test_the_server_reads_no_settings_from_a_workspace_file_another_name_can_change(workspaces_tmp):
    """The kernel can't reach settings.json or config.json by name. Should it reach one by another name (a hard link),
    the server ignores that settings.json's kernel_wrap and starts no agent on that config.json."""
    from app import userconf

    ws = workspaces_tmp / "w"
    ws.mkdir()
    (ws / "settings.json").write_text(json.dumps({config.KERNEL_WRAP_KEY: "none"}))
    (ws / "config.json").write_text("{}")
    assert notebook._ws_settings("w") == {config.KERNEL_WRAP_KEY: "none"} and userconf.load("w")
    for name in ("settings.json", "config.json"):
        (ws / f"{name}.other").hardlink_to(ws / name)
    assert notebook._ws_settings("w") == {}
    with pytest.raises(userconf.ConfigError, match="another name"):
        userconf.load("w")
