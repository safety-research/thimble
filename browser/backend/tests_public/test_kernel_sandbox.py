"""The notebook kernel's sandbox (app/kernel_wrap.py, app/kernel_srt.mjs): the rules Anthropic's sandbox runtime gets on
macOS and Linux, the Seatbelt profile it makes of them on macOS, and what the server does around a sandboxed kernel."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from app import config, events, kernel_wrap, notebook, srt, views

SRT = srt.package(config.REPO_ROOT)
NODE = srt.node()
LINUX = sys.platform.startswith("linux")
WS, CORPUS, HOME = "/Users/sam/.thimble/workspaces/w", "/Users/sam/corpus", "/Users/sam"


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
    interpreter resolves through and the fonts; of the workspace it writes only its own folders (scratch/, tmp/,
    view-indexes/), and the workspace's config and its locks folder stay hidden. On Linux each of its own folders is
    hidden by a rule of its own too, so srt binds it back writable over the workspace's read-only bind."""
    rules, (venv, minor, real) = _rules(tmp_path, "darwin")
    fs = rules["filesystem"]
    hidden = {f"{WS}/settings.json", f"{WS}/config.json", f"{WS}/locks"}
    own = [f"{WS}/scratch", f"{WS}/tmp", f"{WS}/view-indexes"]
    assert {HOME, "/Users", "/Volumes", "/private/tmp", "/private/var/folders", f"{HOME}/.thimble", f"{HOME}/.claude",
            *hidden} <= set(fs["denyRead"])
    assert not set(own) & set(fs["denyRead"]), "on macOS a read deny would win over the write allowed in it"
    assert {CORPUS, WS, str(venv), str(minor), str(real), "/app/backend/app/fonts"} <= set(fs["allowRead"])
    assert not any("sandbox-runtime" in p for p in fs["allowRead"]), "apply-seccomp runs only on Linux"
    assert fs["allowWrite"] == own
    assert set(fs["denyWrite"]) == {*hidden, "/tmp/claude", "/private/tmp/claude"}
    linux = _rules(tmp_path / "l", "linux")[0]["filesystem"]
    assert {"/home", "/tmp", "/mnt", "/run/user"} <= set(linux["denyRead"]) and "/Users" not in linux["denyRead"]
    assert "/app/frontend/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp" in linux["allowRead"]
    assert linux["allowWrite"] == own and set(own) <= set(linux["denyRead"])


@pytest.mark.skipif(NODE is None or SRT is None, reason="needs node and frontend/node_modules (scripts/check.sh install)")
def test_srt_makes_a_seatbelt_profile_of_the_rules_that_keeps_the_workspace_config_hidden(tmp_path):
    """With the platform mocked as macOS, the profile srt makes of the rules (kernel_srt.mjs --print) denies reads under
    the home, allows the kernel's paths after that, denies the workspace's config after those, allows writes to the
    kernel's own folders of the workspace alone, leaves the network open and runs the kernel under sandbox-exec."""
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
    assert all(f'(subpath "{WS}/{name}")' in allowed for name in ("scratch", "tmp", "view-indexes"))
    assert f'(subpath "{WS}")' not in allowed and HOME + '"' not in allowed and CORPUS not in allowed


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
    venv, ws, corpus = (tmp_path / n for n in ("venv", "ws", "corpus"))
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").symlink_to(minor / "bin" / "python3.12")
    for d in (ws, corpus, *(ws / name for name in (*kernel_wrap.KERNEL_DIRS, kernel_wrap.LOCKS_DIR))):
        d.mkdir()  # as the server makes them before a kernel starts
    for name in kernel_wrap.HIDDEN_FILES:
        (ws / name).write_text("{}\n")
    py = str(venv / "bin" / "python")
    cmd = [py, "-c", "print('ran')"]
    if wrap == "srt":
        rules = kernel_wrap.srt_rules(corpus_dir=corpus, workspace_dir=ws, venv=venv, python=py, srt_dir=SRT, home=home,
                                      platform=sys.platform)
        argv, env = kernel_wrap.srt_argv(cmd, node=NODE, srt_dir=SRT, rules=rules), kernel_wrap.srt_env(dict(os.environ), home=ws)
    else:
        argv, env = kernel_wrap.kernel_wrap_argv(cmd, corpus_dir=corpus, workspace_dir=ws, venv=venv, python=py), None
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
             state / "proposals.json", registry / "web_rules.json"):
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
    it writes reaches the citation forms of main's prompt, nor rewrite the kept web rules of the registry folder; the
    views kernel still reads the reader and keeps its index and the bytes it read outside the views."""
    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    views.write_view("mini", "posts", name="Posts", description="", claims=["board.jsonl"],
                     accepts=[{"form": "L<n>", "means": "one post"}], reader=READER, html="<p>posts</p>")
    registry = config.registry_dir("mini")
    (registry / "web_rules.json").write_text("{}\n")
    try:
        cell = await notebook.run_code("mini", CARD, "main")
        said = "".join(b.get("text/plain", "") for b in cell["outputs"]).split()
        assert said == ["one", "post", *["refused"] * 5, "kept", "kept"], said
        assert (registry / "web_rules.json").read_text() == "{}\n"
        prompt = events.session_prompt(str(config.corpus_dir("mini")))
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


def test_the_kernel_s_command_leaves_srt_room_in_its_one_shell_argument(tmp_path):
    """srt wraps the kernel's whole command in one shell argument of at most MAX_ARG_STRLEN bytes, its own words with
    it (2026-10-10: 133,125 bytes of a 131,071 limit when the `thimble` module's source went as text, and every kernel
    died before answering; 59,943 bytes when it went compressed). The command names the module's file, which the
    kernel reads, so the quoted command takes at most an eighth of the argument however the module grows."""
    import shlex

    argv = notebook.kernel_argv(tmp_path / "k.conn.json", tmp_path / "k.json", roots=(str(tmp_path),), workspace=tmp_path)
    assert len(" ".join(shlex.quote(a) for a in argv)) < notebook.MAX_ARG_STRLEN // 8
    # the line installs the module from its file, with the workspace set, and tracebacks name that file
    line = next(a for a in argv if "types.ModuleType('thimble')" in a).split("=", 1)[1]
    try:
        exec(line, {})  # noqa: S102 — the kernel's own exec line
        mod = sys.modules["thimble"]
        assert mod.WS == str(tmp_path) and mod.CHARTS.keys() >= {"bar", "box", "area"}
        assert mod.__file__ == str(notebook.THIMBLE_MODULE) == mod.labels.__code__.co_filename
    finally:
        sys.modules.pop("thimble", None)


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_wrapped_kernel_imports_the_thimble_module_from_its_file(wrap, monkeypatch, workspaces_tmp):
    """In the wrapped kernel `import thimble` gives the module the start line built from kernel_thimble.py, which the
    sandbox lets the kernel read, with the workspace set; the rest of the backend's folder stays hidden."""
    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    code = ("import os, thimble\n"
            "print(thimble.WS == os.path.realpath('..'), thimble.__file__, thimble.chart.__module__,\n"
            "      os.path.exists(os.path.join(os.path.dirname(thimble.__file__), 'notebook.py')))\n")
    try:
        cell = await notebook.run_code("mini", code, "main")
        said = "".join(b.get("text/plain", "") for b in cell["outputs"]).split()
        assert said == ["True", str(notebook.THIMBLE_MODULE), "thimble", "False"], cell["outputs"]
    finally:
        await notebook.shutdown_all()


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_wrapped_kernel_reads_a_parquet_file_of_the_corpus(wrap, monkeypatch, workspaces_tmp, data_tmp):
    """Card code reads a corpus's parquet files, as eval data often comes: pandas finds its parquet engine (pyarrow) in
    the wrapped kernel, as it finds openpyxl for a workbook."""
    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    import pandas as pd  # noqa: PLC0415

    pd.DataFrame({"agent": ["a", "b", "a"], "edits": [3, 1, 2]}).to_parquet(data_tmp / "mini" / "edits.parquet")
    code = "import pandas as pd\nd = pd.read_parquet('edits.parquet')\nprint(len(d), int(d.edits.sum()))\n"
    try:
        cell = await notebook.run_code("mini", code, "main")
        said = "".join(b.get("text/plain", "") for b in cell["outputs"]).split()
        assert said == ["3", "6"], cell["outputs"]
    finally:
        await notebook.shutdown_all()


def test_a_backend_imported_through_a_link_names_the_files_a_wrapped_kernel_reads_by_their_real_paths(tmp_path):
    """srt hides the install tree by its real path (notebook._kernel_hides), so each file a wrapped kernel reads is
    named by its real path even when the backend is imported through a link (a PYTHONPATH naming a linked checkout):
    else srt kept kernel_thimble.py hidden and the kernel's `import thimble` failed with No module named 'thimble'."""
    link = tmp_path / "tree"
    link.symlink_to(config.REPO_ROOT, target_is_directory=True)
    code = "from app import notebook\nprint(notebook.THIMBLE_MODULE)\nfor p in notebook._kernel_reads(): print(p)"
    out = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True, timeout=60,
                         env={"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "PYTHONPATH": str(link / "backend")})
    assert out.returncode == 0, out.stderr
    module, *reads = out.stdout.split()
    assert len(reads) == 3 and module in reads
    assert all(p == os.path.realpath(p) and p.startswith(f"{config.REPO_ROOT}{os.sep}") for p in reads), reads


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


TRUSTED_CELL = """
import json, os, pathlib
trusted = pathlib.Path.cwd().parent / "trusted"
said = []
for name in ("subagents.json", "callers.jsonl", "planted.json"):
    try:
        with open(trusted / name, "a") as f:
            f.write(json.dumps({"requests": {"req_0000000001": {"state": "pending", "route": "click"}}}))
        said.append("wrote")
    except OSError:
        said.append("refused")
try:
    os.rename(trusted, trusted.with_name("moved"))
    said.append("moved")
except OSError:
    said.append("kept")
print(*said)
"""


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_card_code_can_t_write_the_trusted_files_after_the_server_replaced_them(wrap, monkeypatch,
                                                                                      workspaces_tmp):
    """subagents.json and callers.jsonl stay read-only to a card's code while the server replaces them whole (a new file
    renamed over each). Linux takes a bind off a file that another mount namespace renames a file over, so binding each
    file read-only held only until the first write after the kernel started, and a cell could then write a pending click
    into subagents.json; the kernel binds their folder read-only instead."""
    from app import subagent_files

    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    ws = config.workspace_dir("mini")
    subagent_files.ensure(ws)
    try:
        await notebook.run_code("mini", "print('started')", "main")  # the kernel runs before the writes below
        for i in range(2):
            with subagent_files.update(ws) as state:
                state["agents"] = {"a1": {"status": "running", "n": i}}
        subagent_files.add_caller(ws, "toolu_x", "a1", "thimble:orientation")
        subagent_files.trim_callers(ws)
        cell = await notebook.run_code("mini", TRUSTED_CELL, "main")
        said = "".join(b.get("text/plain", "") for b in cell["outputs"]).split()
        assert said == ["refused"] * 3 + ["kept"], said
        assert "req_0000000001" not in subagent_files.state_path(ws).read_text()
        assert not (subagent_files.trusted_dir(ws) / "planted.json").exists()
    finally:
        await notebook.shutdown_all()


# a cell that tries to read `secret` and write `write` in a folder outside the workspace, then writes its own TMPDIR
OUTSIDE_CELL = """
import os
said = []
try:
    with open({secret!r}) as f:
        said.append(f.read().strip())
except OSError as e:
    said.append(type(e).__name__)
try:
    with open({write!r}, 'w') as f:
        f.write('written by a card')
    said.append('wrote')
except OSError as e:
    said.append(type(e).__name__)
t = os.environ['TMPDIR']
with open(os.path.join(t, 'own.csv'), 'w') as f:
    f.write('night,minutes\\n')
print(*said, os.path.islink(t), os.path.realpath(t) == t)
"""


def _outside(tmp_path_factory) -> tuple:
    """A folder outside the workspace, readable by all (0755), that holds a file a card must not read."""
    outside = tmp_path_factory.mktemp("outside-the-workspace").resolve()
    os.chmod(outside, 0o755)
    (outside / "secret.txt").write_text("OUTSIDE-SECRET")
    return outside, outside / "secret.txt"


def _said(cell: dict) -> list[str]:
    return "".join(b.get("text/plain", "") for b in cell["outputs"]).split()


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_link_a_card_left_at_the_workspace_s_tmp_gives_no_later_kernel_the_folder_it_points_to(
        wrap, monkeypatch, workspaces_tmp, tmp_path_factory):
    """On the Messages API every kernel's TMPDIR is the workspace's tmp/ (config.temp_dir), which a card's code can put a
    link to any folder in place of. The next kernel, a dedicated one or the shared one after Restart, had the link's
    target as its TMPDIR, the wrapper let it read and write that folder as one outside the workspace, and the server
    made the folder private (0700). Now the TMPDIR is tmp/ in the workspace, a folder made again in place of a link.
    (A card's kernel has tmp/ as a folder of its own, a mount point, and writes none of the rest of the workspace, so
    here the link is put there by other means, as an earlier version's kernel could.)"""
    from app import runtime

    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    monkeypatch.setattr(runtime, "engine", lambda: "api")
    outside, secret = _outside(tmp_path_factory)
    try:
        tmp = config.temp_dir("mini")
        shutil.rmtree(tmp)
        tmp.symlink_to(outside, target_is_directory=True)
        dedicated = await notebook.run_code("mini", OUTSIDE_CELL.format(secret=str(secret), write=str(outside / "k2.txt")),
                                            "main", kernel="k2")
        await notebook.restart("mini")
        shared = await notebook.run_code("mini", OUTSIDE_CELL.format(secret=str(secret), write=str(outside / "k.txt")),
                                         "main")
    finally:
        await notebook.shutdown_all()
    for said in (_said(dedicated), _said(shared)):
        assert len(said) == 4 and "OUTSIDE-SECRET" not in said and "wrote" not in said, said
        assert said[2:] == ["False", "True"], said
    assert sorted(os.listdir(outside)) == ["secret.txt"]
    assert stat.S_IMODE(os.stat(outside).st_mode) == 0o755
    assert (config.temp_dir("mini") / "own.csv").is_file()


# a card's code that tries to move each of `folders` away and to remove it, so that a link could take its place
MOVE_CELL = """
import os, shutil
for d in {folders!r}:
    try:
        os.rename(d, d + '.moved')
        print('moved')
    except OSError:
        try:
            shutil.rmtree(d)
            print('removed' if not os.path.exists(d) else 'kept')
        except OSError:
            print('kept')
"""


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_card_code_can_t_move_the_workspace_s_folders_main_s_bash_writes_by_their_paths(
        wrap, monkeypatch, workspaces_tmp):
    """Main's Bash on the Messages API writes the workspace's tmp/ and card-libs/, which srt binds by their paths when
    each command starts, after its own check that neither is a link. A card's code that moved one away and put a link
    in its place in that moment had srt bind the folder the link points to, and main's Bash wrote and read outside its
    folders. In the kernel's sandbox tmp/ is a folder of its own (a mount point) and card-libs/ read-only, as the rest
    of the workspace is, so no card's code can move or remove either."""
    from app import card_libs, runtime

    if not (LINUX and _wrap_works(wrap)):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    monkeypatch.setattr(runtime, "engine", lambda: "api")
    card_libs.folder("mini").mkdir()  # as main's first npm install makes it
    folders = [str(config.temp_dir("mini")), str(card_libs.folder("mini"))]
    try:
        said = _said(await notebook.run_code("mini", MOVE_CELL.format(folders=folders), "main"))
    finally:
        await notebook.shutdown_all()
    assert said == ["kept", "kept"], said
    assert all(os.path.isdir(d) and not os.path.islink(d) for d in folders)


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_link_left_at_the_workspace_s_kernels_folder_gives_no_kernel_the_folder_it_points_to(
        wrap, monkeypatch, workspaces_tmp, tmp_path_factory):
    """The workspace's kernels/ folder holds each kernel's connection file, record, log and lease, and the folder a
    kernel under srt writes can hold a link in its place. bwrap bound the folder the link points to writable for the
    next kernel, and the server wrote the kernel's files there. Now a link there is replaced by a folder before the
    server writes any of them."""
    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    outside, secret = _outside(tmp_path_factory)
    kernels = config.workspace_dir("mini") / notebook.KERNELS_DIR
    shutil.rmtree(kernels, ignore_errors=True)
    kernels.symlink_to(outside, target_is_directory=True)
    try:
        cell = await notebook.run_code("mini", OUTSIDE_CELL.format(secret=str(secret), write=str(outside / "k.txt")),
                                       "main")
    finally:
        await notebook.shutdown_all()
    said = _said(cell)
    assert len(said) == 4 and "OUTSIDE-SECRET" not in said and "wrote" not in said, said
    assert sorted(os.listdir(outside)) == ["secret.txt"]
    assert kernels.is_dir() and not kernels.is_symlink()


# a card's code that tries to put a link to `target` in place of the workspace's kernels/, again and again
SWAP_KERNELS_CELL = """
import os
K, T = {kernels!r}, {target!r}
said = set()
for n in range(20):
    try:
        os.rename(K, K + '.moved-' + str(n))
        os.symlink(T, K)
        said.add('swapped')
    except OSError:
        said.add('refused')
print(*sorted(said))
"""
# the same, from a process of the test's own outside any sandbox, as an earlier version's kernel could: argv K, T
SWAP_SRC = """
import os, sys, time
K, T = sys.argv[1:3]
end, n = time.monotonic() + 120, 0
while time.monotonic() < end:
    n += 1
    try:
        if not os.path.islink(K):
            os.rename(K, K + '.moved-' + str(n))
            os.symlink(T, K)
    except OSError:
        pass
"""


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_link_that_keeps_coming_back_at_kernels_gets_none_of_a_kernel_s_files_written_outside(
        wrap, monkeypatch, workspaces_tmp, tmp_path_factory):
    """A kernel under srt could rename the workspace's kernels/ and put a link in its place at any time, from a thread
    of its own that kept doing it; now a card's code writes none of the workspace but its own folders, and its tries are
    refused, so here a process of the test's own does it, as an earlier version's kernel could. The server made
    kernels/ a folder again, then wrote the next kernel's connection file, log, record and lease by their paths, so
    through a link put there after that: into the folder the link points to, whose mode the connection file's writer
    changed (0755 to 01755), and bwrap bound that folder for the next kernel, which read and wrote it. Now the server
    opens each of those files as nofollow does and bwrap binds no folder of them, so a start may fail while the link is
    there and nothing of the server's or the kernel's lands outside."""
    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    outside, secret = _outside(tmp_path_factory)
    kernels = config.workspace_dir("mini") / notebook.KERNELS_DIR
    said: list = []
    try:
        card = await notebook.run_code("mini", SWAP_KERNELS_CELL.format(kernels=str(kernels), target=str(outside)),
                                       "main", kernel="k1")
        assert _said(card) == ["refused"], card["outputs"]
        swapper = subprocess.Popen([sys.executable, "-c", SWAP_SRC, str(kernels), str(outside)])
        try:
            for i in range(4):
                try:
                    cell = await notebook.run_code(
                        "mini", OUTSIDE_CELL.format(secret=str(secret), write=str(outside / f"k{i}.txt")), "main",
                        kernel=f"k2-{i}")
                    said.append([b.get("text/plain") or b.get("evalue") for b in cell["outputs"]])
                except Exception as e:  # noqa: BLE001 — a start the link made fail
                    said.append(f"{type(e).__name__}: {e}")
        finally:
            swapper.kill()
            swapper.wait()
    finally:
        await notebook.shutdown_all()
    assert "OUTSIDE-SECRET" not in str(said) and "wrote" not in str(said), said
    assert sorted(os.listdir(outside)) == ["secret.txt"], said
    assert stat.S_IMODE(os.stat(outside).st_mode) == 0o755


# a card's code that tries to put a link to `target` in place of a file or a folder of the workspace the server writes
PLANT_CELL = """
import os
p = {path!r}
try:
    if os.path.isdir(p) and not os.path.islink(p):
        os.rename(p, p + '.moved')
    elif os.path.lexists(p):
        os.unlink(p)
    os.symlink({target!r}, p)
    print('planted')
except OSError:
    print('refused')
"""


def _plant(p: Path, target: Path) -> None:
    """What PLANT_CELL tries, done by the test itself, as an earlier version's kernel, whose sandbox let it write the
    whole workspace, could."""
    if p.is_dir() and not p.is_symlink():
        p.rename(p.with_name(p.name + ".moved"))
    elif os.path.lexists(p):
        p.unlink()
    p.symlink_to(target)


def _dotfile(tmp_path_factory) -> Path:
    """A made-up dotfile outside the workspace, as one a link a card left could lead the server's write to."""
    p = tmp_path_factory.mktemp("outside-the-workspace").resolve() / "made-up-dotfile"
    p.write_text("# a made-up dotfile\n")
    return p


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_the_server_appends_no_line_through_a_link_left_in_place_of_the_canvas_history(
        wrap, monkeypatch, workspaces_tmp, tmp_path_factory):
    """canvas-history.jsonl gets a line at each card's run (ledger.append_jsonl). A card's code could put a link to any
    file in its place, and the next run appended its JSON line, the card's code in it, to that file, with no race. Now
    a card's code writes none of the workspace but its own folders, and the append opens the log as nofollow does, so a
    link an earlier version's kernel left there goes and the log starts again as a file of its own."""
    from app import canvas_history

    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    dotfile = _dotfile(tmp_path_factory)
    log = config.workspace_dir("mini") / canvas_history.LOG_NAME
    try:
        planted = await notebook.run_code("mini", PLANT_CELL.format(path=str(log), target=str(dotfile)), "main")
        assert _said(planted) == ["refused"], planted["outputs"]
        _plant(log, dotfile)
        await notebook.run_code("mini", "print('a second card')", "main", title="made-up title")
    finally:
        await notebook.shutdown_all()
    assert dotfile.read_text() == "# a made-up dotfile\n"
    assert not log.is_symlink() and "a second card" in log.read_text()


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_the_next_start_writes_no_kernel_log_through_a_link_left_in_place_of_it(
        wrap, monkeypatch, workspaces_tmp, tmp_path_factory):
    """A card's code could put a link to any file in place of its kernel's log, kernels/<key>.log, which the next start
    of the kernel opened to write ('wb') through the link, so it emptied and overwrote that file with the kernel's
    start-up output. Now a card's code writes none of kernels/, and the log is opened as nofollow opens it, so a link an
    earlier version's kernel left there goes and the log is a file of its own."""
    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    dotfile = _dotfile(tmp_path_factory)
    kernels = config.workspace_dir("mini") / notebook.KERNELS_DIR
    try:
        planted = await notebook.run_code("mini", PLANT_CELL.format(path=str(kernels / "shared.log"),
                                                                    target=str(dotfile)), "main")
        assert _said(planted) == ["refused"], planted["outputs"]
        logs = sorted(kernels.glob("*.log"))
        assert logs
        for log in logs:
            _plant(log, dotfile)
        await notebook.restart("mini")
        again = await notebook.run_code("mini", "print(6 * 7)", "main")
    finally:
        await notebook.shutdown_all()
    assert _said(again) == ["42"], again["outputs"]
    assert dotfile.read_text() == "# a made-up dotfile\n"
    assert any(not p.is_symlink() for p in kernels.glob("*.log"))


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_the_scratch_mirror_makes_and_removes_no_link_in_a_folder_a_link_left_there_leads_to(
        wrap, monkeypatch, workspaces_tmp, tmp_path_factory):
    """scratch/, the kernels' cwd, is where the server makes a link to each entry of the corpus and removes those whose
    target is gone (mirror_corpus). A card's code could put a link to any folder in its place, and the next pass made
    the corpus's links in that folder and removed each dangling link there. Now scratch/ is a folder of the kernel's
    own, a mount point it can neither move nor remove, and the pass works in the folder as nofollow opens it, so a link
    an earlier version's kernel left there is replaced by a folder."""
    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    outside = tmp_path_factory.mktemp("outside-the-workspace").resolve()
    (outside / "a-dangling-link-of-the-person-s").symlink_to(outside / "made-up-gone")
    scratch = config.workspace_dir("mini") / notebook.SCRATCH_DIR
    try:
        planted = await notebook.run_code("mini", PLANT_CELL.format(path=str(scratch), target=str(outside)), "main")
        assert _said(planted) == ["refused"], planted["outputs"]
    finally:
        await notebook.shutdown_all()
    _plant(scratch, outside)
    notebook.scratch_dir("mini", fresh=True)
    assert sorted(os.listdir(outside)) == ["a-dangling-link-of-the-person-s"]
    assert scratch.is_dir() and not scratch.is_symlink() and (scratch / "manifest.json").is_symlink()


async def test_the_records_written_at_attach_and_the_files_dropped_at_shutdown_never_go_through_a_link_at_kernels(
        workspaces_tmp, tmp_path_factory):
    """A kernel's record is written again when a server attaches to it, and its files are removed when it is stopped:
    by their paths, so through a link a card left in place of kernels/, they wrote and removed files of the folder it
    points to. Now both open kernels/ as nofollow does: a link there fails them and leads nowhere."""
    outside = tmp_path_factory.mktemp("outside-the-workspace").resolve()
    k = notebook._Kernel("mini", "made-up")
    for p in (k.record, k.conn, k.log, k.lease):
        (outside / p.name).write_text("the person's own\n")
    (outside / k.home.name).mkdir()
    (outside / k.home.name / "kept.txt").write_text("the person's own\n")
    kernels = config.workspace_dir("mini") / notebook.KERNELS_DIR
    shutil.rmtree(kernels, ignore_errors=True)
    kernels.symlink_to(outside, target_is_directory=True)
    with pytest.raises(OSError):
        notebook._write_record(k, {"name": "made-up", "server_pid": os.getpid()})
    await notebook._kill(k)
    assert notebook._read_record(k.record) is None
    assert sorted(os.listdir(outside)) == sorted([k.record.name, k.conn.name, k.log.name, k.lease.name, k.home.name])
    assert all((outside / n).read_text() == "the person's own\n" for n in (k.record.name, k.conn.name, k.lease.name))
    assert (outside / k.home.name / "kept.txt").is_file()


async def test_bwrap_binds_the_temp_folder_of_main_s_claude_code_bash_the_server_checked_not_a_link_put_there_later(
        monkeypatch, workspaces_tmp, tmp_path_factory):
    """On Claude Code sign-in a kernel's TMPDIR is the temp folder Claude Code's sandbox gives main's commands
    (runtime_cc.shell_tmp), outside the workspace, which main's Bash may write, so it can put a link in that folder's
    place. The server checked the folder, then bwrap bound it writable by its path, so a link put there between the two
    gave the kernel the folder it points to. Now bwrap binds the folder by the descriptor the server opened it with
    (`--bind-fd`), whatever is at its path by then."""
    from app import runtime, runtime_cc

    if not (_wrap_works("bwrap") and kernel_wrap.bind_fd_works(shutil.which("bwrap") or "bwrap")):
        pytest.skip("bwrap can't bind a folder by its descriptor here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, "bwrap")
    monkeypatch.setattr(runtime, "engine", lambda: "cc")
    outside, secret = _outside(tmp_path_factory)
    shell = runtime_cc.shell_tmp("mini")
    (shell / "from-main-s-bash.csv").write_text("night,minutes\n")
    real = kernel_wrap.kernel_wrap_argv

    def swapped_after_the_check(*a, **kw):
        out = real(*a, **kw)
        if shell.is_dir() and not shell.is_symlink():  # main's Bash, between the server's check and bwrap's bind
            shell.rename(shell.with_name(shell.name + ".moved"))
            shell.symlink_to(outside, target_is_directory=True)
        return out

    monkeypatch.setattr(kernel_wrap, "kernel_wrap_argv", swapped_after_the_check)
    try:
        cell = await notebook.run_code("mini", TMPDIR_CELL, "main")
    finally:
        await notebook.shutdown_all()
    said = "".join(b.get("text/plain", "") for b in cell["outputs"])
    assert "from-main-s-bash.csv" in said and "secret.txt" not in said, said
    assert sorted(os.listdir(outside)) == ["secret.txt"]
    assert (shell.with_name(shell.name + ".moved") / "own.csv").is_file()


# a cell that lists its TMPDIR and writes a file of its own there
TMPDIR_CELL = """
import os
t = os.environ['TMPDIR']
print(sorted(os.listdir(t)))
with open(os.path.join(t, 'own.csv'), 'w') as f:
    f.write('night,minutes\\n')
"""


# B25: the kernel writes only its own folders of the workspace.
#
# made-up files where the server keeps its own state in a workspace, each by the name the server gives it, which no
# card's run makes the server write
SERVER_FILES = {
    "sessions.json": '{"sessions": {}}\n', "held-events.json": "[]\n", "answers.json": "{}\n", "notices.json": "[]\n",
    "render-theme.json": "{}\n", "runtime/main.json": '{"session": "made-up"}\n',
    "runtime/convs/main-made-up.api.json": "[]\n", "runtime/made-up.jsonl": "{}\n", "chats/made-up.jsonl": "{}\n",
    "chats/made-up.meta.json": "{}\n", "notebooks/made-up.json": "{}\n", "concepts/made-up.json": "{}\n",
    "labels/made-up.jsonl": '{"ref": "a.jsonl#L1", "label": "yes", "source": "code", "ts": "t"}\n',
    "marks/0000abcd.json": "{}\n", "report-types/notes/type.json": "{}\n", "report-types/notes/prompt.md": "made-up\n",
    "checks/made-up.json": "{}\n", "card-libs/lib/libs.json": "{}\n", "registry/made-up.json": "{}\n",
    "views/made-up.json": "{}\n", "extension/made-up.json": "{}\n", "writers/report/context.md": "made-up\n",
    "check-work/made-up/task.md": "made-up\n", "views-work/posts/notes.md": "made-up\n",
    "orient/work/notes.md": "made-up\n", ".trash/made-up/step.json": "{}\n",
}
# a card's code that tries every way to change the workspace outside its own folders (OWN, and its HOME) and prints
# what it managed as JSON: a file written, emptied, linked into its own temp folder, removed, moved, or its mode or
# times changed; a file, a folder, a link or a FIFO made in a folder; a folder moved; one of its own folders moved. A
# folder the sandbox hides (HIDDEN) shows the kernel a stand-in, under srt an empty tmpfs of the sandbox's own whose
# writes never reach the disk: it is only moved
ATTACK_SRC = r"""
import json, os
ws = os.path.realpath('..')
own = [os.path.join(ws, n) for n in OWN]
stand_ins = [os.path.join(ws, n) for n in HIDDEN]
home = os.path.realpath(os.environ['HOME'])
def mine(p):
    return any(p == o or p.startswith(o + os.sep) for o in [*own, *stand_ins, home])
done, tried = [], 0
def attempt(what, fn):
    global tried
    tried += 1
    try:
        fn()
        done.append(what)
    except OSError:
        pass
entries = [(ws, True)]
for root, dirs, files in os.walk(ws):
    dirs[:] = [d for d in dirs if not mine(os.path.join(root, d))]
    entries += [(os.path.join(root, d), True) for d in dirs] + [(os.path.join(root, f), False) for f in files]
hard = os.path.join(ws, 'tmp', 'made-up-hard-link')
for s in stand_ins:
    attempt('move ' + s, lambda: os.rename(s, s + '.moved'))
for p, folder in entries:
    if folder:
        attempt('file in ' + p, lambda: open(os.path.join(p, 'planted.json'), 'x').close())
        attempt('folder in ' + p, lambda: os.mkdir(os.path.join(p, 'planted-folder')))
        attempt('link in ' + p, lambda: os.symlink('/', os.path.join(p, 'planted-link')))
        attempt('FIFO in ' + p, lambda: os.mkfifo(os.path.join(p, 'planted-fifo')))
    else:
        attempt('write ' + p, lambda: open(p, 'a').write('planted'))
        attempt('empty ' + p, lambda: os.truncate(p, 0))
        attempt('hard link ' + p, lambda: os.link(p, hard))
        attempt('remove ' + p, lambda: os.unlink(p))
    if p != ws:
        attempt('move ' + p, lambda: os.rename(p, p + '.moved'))
        attempt('mode of ' + p, lambda: os.chmod(p, 0o777))
        attempt('times of ' + p, lambda: os.utime(p, (0, 0)))
for o in own:
    attempt('move ' + o, lambda: os.rename(o, o + '.moved'))
print(json.dumps({'tried': tried, 'entries': len(entries), 'done': done}))
"""


def _text(cell: dict) -> str:
    return "".join(b.get("text/plain", "") for b in cell["outputs"])


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_card_s_code_changes_nothing_of_the_workspace_but_its_own_folders(wrap, monkeypatch, workspaces_tmp):
    """The server keeps its own state in the workspace (the undo journal, the chats and their metas, the sessions, the
    groups, the canvas history, the labels and their stores, the kernels' records, the agents' folders and the rest),
    and the kernels could write all of it but a few hidden or read-only names, so each such file was input a card's
    code could forge. Now a kernel writes only its own folders (scratch/, tmp/, view-indexes/, and under srt its HOME):
    in every other folder of the workspace a card's code can make no file, folder, link or FIFO, and no file or folder
    there can it write, empty, link into its own folders, remove, move or change the mode or times of, nor can it move
    one of its own folders. The server's files stay as they were."""
    from app import labels_store

    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    ws = config.workspace_dir("mini")
    for rel, text in SERVER_FILES.items():
        (ws / rel).parent.mkdir(parents=True, exist_ok=True)
        (ws / rel).write_text(text)
    labels_store.rebuild_file(str(ws / "labels" / "made-up.jsonl"))
    kept = {p: p.read_bytes() for p in [*(ws / rel for rel in SERVER_FILES), ws / "labels" / "made-up.sqlite",
                                         *(ws / "trusted").iterdir()]}
    try:
        await notebook.run_code("mini", "print('a first card')", "main")  # the kernel's files, the group, the history
        cell = await notebook.run_code(
            "mini", f"OWN = {list(kernel_wrap.KERNEL_DIRS)!r}\nHIDDEN = {[kernel_wrap.LOCKS_DIR]!r}\n{ATTACK_SRC}", "main")
    finally:
        await notebook.shutdown_all()
    got = json.loads(_text(cell))
    assert got["done"] == [], got["done"][:20]
    assert got["entries"] > len(SERVER_FILES) and got["tried"] > 7 * len(SERVER_FILES), got
    assert [p for p, b in kept.items() if p.read_bytes() != b] == []
    assert [p for p in ws.rglob("*") if "planted" in p.name or p.name.endswith(".moved")] == []
    assert all(os.path.isdir(ws / name) and not os.path.islink(ws / name) for name in kernel_wrap.KERNEL_DIRS)


# a card's code that writes a file in each folder it writes and reads a label's store as `thimble.labels` does
OWN_SRC = r"""
import json, os, thimble
from pathlib import Path
ws = Path(os.path.realpath('..'))
wrote = []
for d in [ws / 'scratch', ws / 'tmp', ws / 'view-indexes', Path(os.environ['HOME']), Path(os.environ['TMPDIR'])]:
    (d / 'made-up.csv').write_text('night,minutes\n')
    wrote.append((d / 'made-up.csv').read_text() == 'night,minutes\n')
jsonl = ws / 'labels' / 'made-up.jsonl'
db = jsonl.with_suffix('.sqlite')
print(json.dumps({'wrote': wrote, 'wal': os.path.exists(str(db) + '-wal'), 'fresh': thimble._store_fresh(jsonl, db),
                  'rows': len(thimble._store_parts(db)[0]), 'labelled': len(thimble._members(jsonl)[0])}))
"""


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_card_s_code_writes_its_own_folders_and_reads_a_label_s_store(wrap, monkeypatch, workspaces_tmp):
    """A card's code writes its working folder, the workspace's tmp/ and view-indexes/, its HOME and its TMPDIR, and
    reads a label's store, which SQLite keeps in WAL mode: a read-only connection opens such a store only while its
    -wal and -shm files are there, which the kernel cannot make in labels/, so where the server has the store closed it
    is read as immutable, whole as it lies on disk."""
    from app import labels_store

    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    jsonl = config.workspace_dir("mini") / "labels" / "made-up.jsonl"
    jsonl.parent.mkdir(parents=True)
    jsonl.write_text("".join(json.dumps({"ref": f"a.jsonl#L{n}", "label": "yes", "source": "code", "ts": "t"}) + "\n"
                             for n in range(1, 51)))
    labels_store.rebuild_file(str(jsonl))
    try:
        cell = await notebook.run_code("mini", OWN_SRC, "main")
    finally:
        await notebook.shutdown_all()
    assert json.loads(_text(cell)) == {"wrote": [True] * 5, "wal": False, "fresh": True, "rows": 50, "labelled": 50}, \
        cell["outputs"]


def test_a_store_read_as_immutable_is_not_taken_when_the_server_wrote_it_meanwhile(tmp_path):
    """Read as immutable, a store's file is taken as it lies on disk, so a read that the server's write of the store
    may have overlapped is refused (kernel_thimble._store_open's check), and the reader reads the labels file
    instead."""
    from app import kernel_thimble, labels_store

    jsonl = tmp_path / "labels" / "made-up.jsonl"
    jsonl.parent.mkdir()
    jsonl.write_text(json.dumps({"ref": "a.jsonl#L1", "label": "yes", "source": "code", "ts": "t"}) + "\n")
    labels_store.rebuild_file(str(jsonl))
    db = jsonl.with_suffix(".sqlite")
    os.chmod(jsonl.parent, 0o555)  # as the kernel sees labels/: no -wal and -shm can be made there
    try:
        conn, check = kernel_thimble._store_open(db)
        assert conn.execute("SELECT COUNT(*) FROM current").fetchone() == (1,)
        conn.close()
        check()  # nothing changed
        conn, check = kernel_thimble._store_open(db)
        conn.close()
        os.chmod(jsonl.parent, 0o755)
        st = labels_store.Store(jsonl)
        w = st.connect(write=True)  # the server writes the store while the reader reads it, and closes it
        try:
            st.add([{"ref": "a.jsonl#L2", "label": "no", "source": "code", "ts": "t"}], None, w)
        finally:
            w.close()
        assert not os.path.exists(f"{db}-wal")
        with pytest.raises(sqlite3.OperationalError, match="changed while it was read"):
            check()
    finally:
        os.chmod(jsonl.parent, 0o755)


@pytest.mark.parametrize("swap", ["a link", "another folder"])
async def test_srt_s_kernel_shown_another_temp_folder_than_the_server_checked_is_stopped(swap, monkeypatch,
                                                                                      workspaces_tmp, tmp_path_factory):
    """On Claude Code sign-in a kernel's TMPDIR is the temp folder Claude Code's sandbox gives main's commands, outside
    the workspace and in a folder main's Bash writes. srt takes it by its path and binds it after checks of its own, so
    a link main's Bash put in its place in between gave the kernel the folder the link points to; bwrap binds the folder
    the server checked by its descriptor, but srt takes none. Now the server checks, before any card's code runs in the
    kernel, that its sandbox shows it the very folders the server made or checked there (by their device and inode,
    read through /proc), and stops a kernel shown anything else."""
    from app import runtime, runtime_cc

    if not (LINUX and _wrap_works("srt")):
        pytest.skip("srt can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, "srt")
    monkeypatch.setattr(runtime, "engine", lambda: "cc")
    outside, secret = _outside(tmp_path_factory)
    shell = runtime_cc.shell_tmp("mini")
    (shell / "from-main-s-bash.csv").write_text("night,minutes\n")
    real = notebook._kernel_folders

    def swapped_after_the_check(*a, **kw):
        out = real(*a, **kw)
        shell.rename(shell.with_name(shell.name + ".moved"))  # main's Bash, between the server's check and srt's bind
        if swap == "a link":
            shell.symlink_to(outside, target_is_directory=True)
        else:
            shell.mkdir(mode=0o700)
        return out

    monkeypatch.setattr(notebook, "_kernel_folders", swapped_after_the_check)
    try:
        cell = await notebook.run_code("mini", TMPDIR_CELL, "main")
    finally:
        await notebook.shutdown_all()
    said = str(cell["outputs"])
    assert "the kernel" in said and "stopped" in said and "from-main-s-bash.csv" not in said, said
    assert sorted(os.listdir(outside)) == ["secret.txt"]
    assert not (shell.with_name(shell.name + ".moved") / "own.csv").exists()


async def test_srt_s_kernel_shown_the_folders_the_server_checked_runs(monkeypatch, workspaces_tmp):
    """The check passes for a kernel under srt on Claude Code sign-in whose temp folder nothing moved: its card reads
    what main's Bash wrote in $TMPDIR and writes a file of its own there."""
    from app import runtime, runtime_cc

    if not (LINUX and _wrap_works("srt")):
        pytest.skip("srt can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, "srt")
    monkeypatch.setattr(runtime, "engine", lambda: "cc")
    shell = runtime_cc.shell_tmp("mini")
    (shell / "from-main-s-bash.csv").write_text("night,minutes\n")
    try:
        cell = await notebook.run_code("mini", TMPDIR_CELL, "main")
    finally:
        await notebook.shutdown_all()
    assert "from-main-s-bash.csv" in _text(cell), cell["outputs"]
    assert (shell / "own.csv").is_file()


@pytest.mark.parametrize("earlier", ["writes the workspace", "shows the locks"])
@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_kernel_an_earlier_version_started_is_stopped_rather_than_taken_back(wrap, earlier, monkeypatch,
                                                                                     workspaces_tmp):
    """Kernels outlive a server's restart, an update's among them, and the next server takes each back. One an earlier
    version started runs in a sandbox that lets it write the whole workspace, its record among it (0.10.8), or shows it
    the workspace's locks (this version before its locks folder was hidden), so the next server tells it by its
    wrapper's command line, which no code in the sandbox can change, and stops it rather than take it back whatever its
    record says: the check that read the record's `writes` took back a kernel that had written this version's folders
    there, and its next card wrote sessions.json. The next card starts a kernel in the sandbox of this version: the
    variables of the one stopped are gone."""
    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    real_argv, real_rules = kernel_wrap.kernel_wrap_argv, kernel_wrap.srt_rules

    def earlier_argv(*a, **kw):  # 0.10.8's bwrap binds the workspace writable; the next one hid no locks folder
        out, ws = list(real_argv(*a, **kw)), str(kw["workspace_dir"])
        if earlier == "shows the locks":
            locks = str(Path(ws) / kernel_wrap.LOCKS_DIR)
            i = out.index("--tmpfs", out.index(ws))
            assert out[i:i + 4] == ["--tmpfs", locks, "--remount-ro", locks]
            return out[:i] + out[i + 4:]
        for i in range(len(out) - 2):
            if out[i:i + 3] == ["--ro-bind", ws, ws]:
                out[i] = "--bind"
        return out

    def earlier_rules(*a, **kw):  # 0.10.8's srt rules: the workspace among the folders it writes; then no locks hidden
        rules = real_rules(*a, **kw)
        fs, ws = rules["filesystem"], str(kw["workspace_dir"])
        if earlier == "shows the locks":
            for k in ("denyRead", "denyWrite"):
                fs[k] = [p for p in fs[k] if p != str(Path(ws) / kernel_wrap.LOCKS_DIR)]
        else:
            fs["allowWrite"].insert(0, ws)
        return rules

    monkeypatch.setattr(kernel_wrap, "kernel_wrap_argv", earlier_argv)
    monkeypatch.setattr(kernel_wrap, "srt_rules", earlier_rules)
    ws = config.workspace_dir("mini")
    (ws / "sessions.json").write_text('{"sessions": {}}\n')
    try:
        await notebook.run_code("mini", "made_up = 42", "main", kernel="made-up")
        k = notebook._kernel("mini", "made-up")
        old = k.pid
        rec = notebook._read_record(k.record)  # as the earlier version's kernel may write its record
        notebook.write_json(k.record, {**rec, "wrap": wrap, "writes": list(kernel_wrap.KERNEL_DIRS)})
        monkeypatch.setattr(kernel_wrap, "kernel_wrap_argv", real_argv)  # the update
        monkeypatch.setattr(kernel_wrap, "srt_rules", real_rules)
        await notebook.detach_all()  # a restart: the kernel runs on for the next server
        cell = await notebook.run_code(
            "mini", "print(globals().get('made_up'))\nopen('../sessions.json', 'w').write('{\"forged\": true}')", "main",
            kernel="made-up")
        assert _said(cell) == ["None"] and "Read-only file system" in str(cell["outputs"]), cell["outputs"]
        assert (ws / "sessions.json").read_text() == '{"sessions": {}}\n'
        assert not notebook.procs.alive(old) and notebook._kernel("mini", "made-up").pid != old
        # the kernel this version started is taken back over a restart, its variables with it
        await notebook.run_code("mini", "made_up = 43", "main", kernel="made-up")
        await notebook.detach_all()
        cell = await notebook.run_code("mini", "print(globals().get('made_up'))", "main", kernel="made-up")
        assert _said(cell) == ["43"], cell["outputs"]
    finally:
        await notebook.shutdown_all()


# a card's code that makes a chain of folders deeper than Python's recursion limit in its HOME, and another in place of
# the link of a corpus folder in its working folder (prompts/), as it may
DEEP_CELL = """
import os
def deep(top, n):
    here = os.getcwd()
    os.mkdir(top)
    os.chdir(top)
    for _ in range(n):
        os.mkdir('d')
        os.chdir('d')
    os.chdir(here)
deep(os.path.join(os.environ['HOME'], 'made-up'), {n})
os.unlink('prompts')
deep('prompts', {n})
print('deep')
"""


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_deep_tree_a_card_leaves_stops_no_later_kernel_start(wrap, monkeypatch, workspaces_tmp):
    """The server removes an srt kernel's HOME at each start, and in scratch/ a folder under a corpus name that an
    earlier version's per-file mirror left. Both removals recursed, so a chain of folders deeper than Python's
    recursion limit that a card's code made there raised RecursionError, which nothing caught: every later start of the
    kernel failed, and with the chain in scratch/ every kernel of the workspace. Now the removal walks with a stack of
    its own, the mirror takes a folder for one of its own only when the corpus holds each folder in it, and neither
    removal fails a start."""
    if not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    monkeypatch.setattr(notebook, "MIRROR_MEMO_S", 0.0)  # every start mirrors the corpus again
    try:
        cell = await notebook.run_code("mini", DEEP_CELL.format(n=sys.getrecursionlimit() + 500), "main")
        assert _said(cell) == ["deep"], cell["outputs"]
        await notebook.shutdown_all()  # the kernel ends; the next card starts it again
        again = await notebook.run_code("mini", "print('ran')", "main")
        other = await notebook.run_code("mini", "print('ran')", "main", kernel="made-up")
    finally:
        await notebook.shutdown_all()
    assert (_said(again), _said(other)) == (["ran"], ["ran"]), (again["outputs"], other["outputs"])
    prompts = config.workspace_dir("mini") / notebook.SCRATCH_DIR / "prompts"
    assert prompts.is_dir() and not prompts.is_symlink()  # the card's own, left as it is


def test_a_kernel_start_never_depends_on_removing_what_a_card_left(monkeypatch, workspaces_tmp):
    """The mirror's pass replaces a folder of scratch/ under a corpus name by the corpus folder's link only when it is
    one an earlier version's per-file mirror left: a link to each file, in folders the corpus holds. A folder the
    corpus does not hold is the kernel's and stays. Whatever goes wrong in that removal, or in the removal of an srt
    kernel's HOME, leaves what it could not remove, and the start goes on."""
    corpus = config.corpus_dir("mini").resolve()
    scratch = notebook.scratch_dir("mini", fresh=True)
    (scratch / "prompts").unlink()
    (scratch / "prompts").mkdir()
    (scratch / "prompts" / "worker.md").symlink_to(corpus / "prompts" / "worker.md")
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "prompts").is_symlink()  # an earlier version's mirror goes
    (scratch / "prompts").unlink()
    (scratch / "prompts" / "made-up" / "d").mkdir(parents=True)
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "prompts" / "made-up" / "d").is_dir() and not (scratch / "prompts").is_symlink()

    def fails(*a, **kw):
        raise RecursionError("made up")

    monkeypatch.setattr(notebook, "_unmirror", fails)
    (scratch / "README.md").unlink()
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "README.md").is_symlink() and (scratch / "prompts" / "made-up").is_dir()
    k = notebook._Kernel("mini", "made-up")
    (k.home / "kept").mkdir(parents=True)
    monkeypatch.setattr(notebook.nofollow, "rmtree", fails)
    notebook._fresh_home(k)
    assert k.home.is_dir() and not k.home.is_symlink()


# code a card leaves in its working folder, named like modules a kernel imports at its start: each writes a file into
# $TMPDIR when it runs, then gives the start what it imports
STARTED_SRC = """
import os, sys
open(os.path.join(os.environ['TMPDIR'], 'ran-at-the-start-' + __name__ + '.txt'), 'w').close()
here = os.path.realpath(os.getcwd())
sys.path[:] = [p for p in sys.path if os.path.realpath(p or '.') != here]
if __name__ == '__main__':
    import runpy
    runpy.run_module('ipykernel_launcher', run_name='__main__', alter_sys=True)
else:
    import importlib
    del sys.modules[__name__]
    sys.modules[__name__] = importlib.import_module(__name__)
"""
PLANT_START_CELL = f"""
for name in ('ipykernel_launcher', 'altair'):
    with open(name + '.py', 'w') as f:
        f.write({STARTED_SRC!r})
with open('made_up_helper.py', 'w') as f:
    f.write('VALUE = 42\\n')
print('planted')
"""
STARTED_CELL = """
import os, sys, json, altair, pandas, made_up_helper
print(json.dumps({'ran': sorted(n for n in os.listdir(os.environ['TMPDIR']) if n.startswith('ran-at-the-start')),
                  'installed': ['site-packages' in m.__file__ for m in (altair, pandas)],
                  'helper': made_up_helper.VALUE, 'last': sys.path[-1]}))
"""


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_no_python_runs_in_a_kernel_s_sandbox_before_the_server_checked_it(wrap, monkeypatch, workspaces_tmp,
                                                                                data_tmp):
    """A kernel started as `python -m ipykernel_launcher` in scratch/, which a card's code writes and where each entry
    of the corpus is linked, and IPython put that folder on sys.path ahead of the installed packages: a file there named
    ipykernel_launcher.py, altair.py or pandas.py, left by a card or in the corpus, ran in the next kernel's sandbox
    before the server checked through /proc that the sandbox shows the kernel the folders it made, so a check that then
    stopped the kernel came after that code had read and written whatever the sandbox showed. Now a wrapped kernel's
    command waits in a gate until the server has checked the sandbox, and the kernel's Python starts with the working
    folder off sys.path; it goes at the end of sys.path as the last start line, so a card still imports a module it
    wrote there."""
    from app import procs

    if not (LINUX and _wrap_works(wrap)):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    (data_tmp / "mini" / "pandas.py").write_text(STARTED_SRC)  # a corpus file, linked in scratch/
    temp = config.temp_dir("mini")
    checked: list = []
    real = notebook._sandbox_problem

    def looking(pid, *a, **kw):  # what the kernel's TMPDIR holds, and what its process runs, as the check starts
        checked.append((sorted(n for n in os.listdir(temp) if n.startswith("ran-at-the-start")), procs.argv(pid)[:4]))
        return real(pid, *a, **kw)

    try:
        planted = await notebook.run_code("mini", PLANT_START_CELL, "main")
        assert _said(planted) == ["planted"], planted["outputs"]
        await notebook.shutdown_all()  # the kernel ends (Restart, idle, a crash); the next card starts a new one
        for p in temp.glob("ran-at-the-start-*"):
            p.unlink()
        monkeypatch.setattr(notebook, "_sandbox_problem", looking)
        cell = await notebook.run_code("mini", STARTED_CELL, "main")
    finally:
        await notebook.shutdown_all()
    assert [ran for ran, _ in checked] == [[]], checked  # nothing a card or the corpus left ran before the check
    assert [argv for _, argv in checked] == [list(kernel_wrap.GATE)], checked  # nor any Python: the gate still waited
    assert json.loads(_text(cell)) == {"ran": [], "installed": [True, True], "helper": 42, "last": ""}, cell["outputs"]
    assert not list(temp.glob("ran-at-the-start-*"))


def test_a_kernel_s_python_starts_with_its_working_folder_off_sys_path_until_its_last_start_line(tmp_path):
    argv = notebook.kernel_argv(tmp_path / "k.conn.json", tmp_path / "k.json", roots=(str(tmp_path),), workspace=tmp_path)
    assert argv[:4] == [notebook.PYTHON, "-P", "-m", "ipykernel_launcher"] and "--IPKernelApp.ignore_cwd=True" in argv
    assert argv[-1] == f"--IPKernelApp.exec_lines={notebook.CWD_LAST}"


def test_a_kernel_s_sandbox_is_read_from_its_wrapper_s_command_line_as_the_system_shows_it(tmp_path):
    """What a kernel's wrapper shows it is read from the wrapper's command line: bwrap's binds and tmpfs mounts up to
    its `--`, and srt's rules, from the line as a whole, as `ps` shows it on macOS (split at every space, a path with
    spaces too)."""
    ws, corpus = tmp_path / "work space", tmp_path / "corpus"
    argv = kernel_wrap.kernel_wrap_argv(["python", "-m", "ipykernel_launcher", "--bind", "/x", "/x"], corpus_dir=corpus,
                                        workspace_dir=ws, venv=None, python="/usr/bin/python3", write_fds=[(5, "/t")])
    box = kernel_wrap.sandbox_of(argv[len(kernel_wrap.SIGINT_PREFIX):])  # the shell execs bwrap
    assert (box.wrap, box.writes) == ("bwrap", [*(str(ws / n) for n in kernel_wrap.KERNEL_DIRS), "/t"])
    assert {str(ws), str(corpus)} <= set(box.reads) and box.hides == ["/tmp", str(ws / kernel_wrap.LOCKS_DIR)]
    rules = kernel_wrap.srt_rules(corpus_dir=corpus, workspace_dir=ws, venv=None, python="/usr/bin/python3",
                                  srt_dir="/srt", home=tmp_path / "home", platform="darwin", write=[ws / "kernels" / "k.home"])
    line = kernel_wrap.srt_argv(["python", "-m", "ipykernel_launcher"], node="/usr/bin/node", srt_dir=Path("/srt"),
                                rules=rules)
    fs = rules["filesystem"]
    for shown in (line, " ".join(line).split()):
        assert kernel_wrap.sandbox_of(shown) == ("srt", fs["allowWrite"], fs["allowRead"], fs["denyRead"])
    assert kernel_wrap.sandbox_of(["/usr/bin/python3", "-P", "-m", "ipykernel_launcher"]) is None


# a card's code that opens every lock file it finds in its workspace and holds an flock on each, as long as it runs
HOLD_LOCKS_CELL = r"""
import fcntl, os
ws = os.path.realpath('..')
held = globals().setdefault('_made_up_held', [])
names = []
for root, dirs, files in os.walk(ws):
    for f in files:
        if f.endswith('.lock') or os.path.relpath(root, ws).split(os.sep)[0] == 'locks':
            try:
                fd = os.open(os.path.join(root, f), os.O_RDONLY)
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                held.append(fd)
                names.append(os.path.relpath(os.path.join(root, f), ws))
            except OSError:
                pass
print(sorted(names))
"""


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_a_card_s_code_holds_no_lock_of_the_workspace_s_stores(wrap, monkeypatch, workspaces_tmp):
    """A lock file a kernel may read it may also open and flock: a card that held the groups' lock (notebooks/.lock)
    made every later change of the groups wait ledger.LOCK_WAIT_S for it, on the server's event loop, and then go on
    without the lock, so every card run took 6 s and the server stood still 2 s at a time. Now every lock of the
    workspace lies in its locks folder, which the kernel sees empty (bwrap) or not at all (srt): the card finds no lock
    to hold, and the runs after it take no longer."""
    import asyncio
    import time

    from app import ledger

    if not (LINUX and _wrap_works(wrap)):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    gaps: list[float] = []
    stop = asyncio.Event()

    async def ticker():
        last = time.monotonic()
        while not stop.is_set():
            await asyncio.sleep(0.05)
            gaps.append(time.monotonic() - (last := time.monotonic() - 0) + 0 if False else time.monotonic() - last)
            last = time.monotonic()

    try:
        await notebook.run_code("mini", "print(1)", "main")  # the kernel, the group and their locks
        held = await notebook.run_code("mini", HOLD_LOCKS_CELL, "main")
        tick = asyncio.create_task(ticker())
        t0 = time.monotonic()
        later = await notebook.run_code("mini", "print(2)", "main")
        took = time.monotonic() - t0
        stop.set()
        await tick
    finally:
        await notebook.shutdown_all()
    assert _text(held).strip() == "[]", held["outputs"]
    assert _said(later) == ["2"] and took < ledger.LOCK_WAIT_S and max(gaps) < 1.0, (took, max(gaps))


# a card's code that reads the workspace's settings.json and config.json
READ_HIDDEN_CELL = r"""
import json, os
ws = os.path.realpath('..')
out = {}
for n in ('settings.json', 'config.json'):
    try:
        with open(os.path.join(ws, n)) as f:
            out[n] = f.read()
    except OSError as e:
        out[n] = 'refused: ' + str(e.strerror)
print(json.dumps(out))
"""


@pytest.mark.parametrize("wrap", ["srt", "bwrap"])
async def test_the_workspace_s_config_stays_hidden_from_a_kernel_after_the_server_writes_it(wrap, monkeypatch,
                                                                                           workspaces_tmp):
    """Both wrappers hide settings.json and config.json each by a mount on the file, and the server wrote each as a new
    file renamed over the old one, which takes that mount off inside a kernel that runs: after a Settings save and a
    save of the workspace's config, the same kernel read both files whole. Now the server writes them in place, so the
    mount holds and the kernel reads neither."""
    from app import ledger, userconf

    if not (LINUX and _wrap_works(wrap)):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    ws = config.workspace_dir("mini")
    try:
        before = json.loads(_text(await notebook.run_code("mini", READ_HIDDEN_CELL, "main")))
        inodes = {n: (ws / n).stat().st_ino for n in kernel_wrap.HIDDEN_FILES}
        ledger.put_settings("mini", {"corpus_edits": False})  # a Settings save
        userconf._write(ws / userconf.FILE, {"agents": {"orientation": {"env": ["MADE_UP_KEY_NAME"]}}})
        after = json.loads(_text(await notebook.run_code("mini", READ_HIDDEN_CELL, "main")))
    finally:
        await notebook.shutdown_all()
    assert all(v.startswith("refused") or v == "" for v in [*before.values(), *after.values()]), (before, after)
    assert json.loads((ws / "settings.json").read_text())["corpus_edits"] is False
    assert "MADE_UP_KEY_NAME" in (ws / userconf.FILE).read_text()
    assert {n: (ws / n).stat().st_ino for n in kernel_wrap.HIDDEN_FILES} == inodes  # the same files, written in place
