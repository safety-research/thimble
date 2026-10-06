"""A card's script, run again on a click, as the mod runs it (hooks/register.tsx rerunCard, in the sandbox
helper/sandbox.py plans): it must not write outside the folder's .thimble-cc-mod/, nor change the corpus, nor read
what lies outside the folder. `python3 tests/test_sandbox.py` (no dependencies; skips where no sandbox runs)."""
from __future__ import annotations

import itertools
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), "helper")
SANDBOX = os.path.join(HELPER, "sandbox.py")
sys.path.insert(0, HELPER)
sys.path.insert(0, HERE)
import sandbox  # noqa: E402

ESCAPE = """import json, os, sys
sys.path.insert(0, {helper!r})
from tcard import card
tried = {{}}
for name, path in (("outside", {outside!r}), ("corpus", {corpus!r})):
    try:
        with open(path, "a") as f:
            f.write("written by a card's script\\n")
        tried[name] = "wrote"
    except OSError as e:
        tried[name] = type(e).__name__
try:
    with open({secret!r}) as f:
        tried["secret"] = f.read()
except OSError as e:
    tried["secret"] = type(e).__name__
tried["home"] = os.path.expanduser("~")
card("bar", "How many?", rows=[("a", 1)])
print("TRIED " + json.dumps(tried))
"""


def plan(cwd: str, python: str = "python3", env: dict | None = None) -> dict:
    """The plan the mod asks for once a session (register.tsx sandboxPlan)."""
    r = subprocess.run([python, SANDBOX, "plan", "--cwd", cwd], cwd=cwd, env={**os.environ, **(env or {})},
                       capture_output=True, text=True, timeout=120, check=True)
    return json.loads(r.stdout.strip().splitlines()[-1])


def rerun(cwd: str, script: str, env: dict | None = None, python: str = "python3") -> subprocess.CompletedProcess:
    """A card's script run again, as rerunCard runs it through boxRun: the plan's prefix, its Python, the card's choices
    in the environment and the plan's environment over them."""
    p = plan(cwd, python, env)
    assert not p["error"], p["error"]
    extra = {"THIMBLE_CC_MOD_PARAMS": "{}", "THIMBLE_CC_MOD_ONLY": "0:abc123", "THIMBLE_CC_MOD_ROOT": cwd}
    argv = [p["python"], script] if p["wrap"] == "none" else [*p["prefix"], p["python"], script]
    return subprocess.run(argv, cwd=cwd, env={**os.environ, **(env or {}), **extra, **p["env"]}, capture_output=True,
                          text=True, timeout=180)


def sandboxed() -> bool:
    with tempfile.TemporaryDirectory() as root:
        p = plan(root)
    if p["wrap"] == "none":
        print(f"skipped: no sandbox runs here: {p['line']}")
        return False
    return True


def _corpus(root: str, outside: str) -> tuple[str, str]:
    corpus = os.path.join(root, "pages.jsonl")
    with open(corpus, "w") as f:
        f.write('{"name": "Main"}\n')
    secret = os.path.join(outside, "secret.txt")
    with open(secret, "w") as f:
        f.write("a private file outside the folder\n")
    os.makedirs(os.path.join(root, ".thimble-cc-mod", "scripts"))
    script = os.path.join(".thimble-cc-mod", "scripts", "escape.py")
    with open(os.path.join(root, script), "w") as f:
        f.write(ESCAPE.format(helper=HELPER, outside=os.path.join(outside, "written.txt"), corpus=corpus, secret=secret))
    return corpus, script


def _tried(r: subprocess.CompletedProcess) -> dict:
    assert r.returncode == 0, r.stderr
    return json.loads(next(line for line in r.stdout.splitlines() if line.startswith("TRIED "))[6:])


def test_a_rerun_writes_only_under_thimble_cc_mod() -> None:
    if not sandboxed():
        return
    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
        corpus, script = _corpus(root, outside)
        tried = _tried(rerun(root, script))
        assert not os.path.exists(os.path.join(outside, "written.txt")), f"the rerun wrote outside the folder: {tried}"
        with open(corpus) as f:
            assert f.read() == '{"name": "Main"}\n', f"the rerun changed the corpus: {tried}"
        assert "wrote" not in tried.values(), tried
        # what it may write, it wrote: the card, under .thimble-cc-mod/
        assert len(os.listdir(os.path.join(root, ".thimble-cc-mod", "cards"))) == 1


def test_a_rerun_reads_nothing_outside_the_folder_and_has_a_home_of_its_own() -> None:
    if not sandboxed():
        return
    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
        _, script = _corpus(root, outside)
        tried = _tried(rerun(root, script))
        assert tried["secret"] in ("FileNotFoundError", "PermissionError"), tried
        assert tried["home"] != os.path.expanduser("~"), tried


SECRETS = {"OP_SERVICE_ACCOUNT_TOKEN": "op", "ANTHROPIC_API_KEY": "key", "CLAUDE_CODE_SESSION_ID": "s",
           "THIMBLE_PORT": "8300", "GITHUB_TOKEN": "gh", "DB_PASSWORD": "pw"}
ENV_SEEN = """import json, os
print("ENV " + json.dumps(sorted(k for k in os.environ if k in {names!r})))
"""


def test_a_rerun_inherits_none_of_the_session_s_secrets() -> None:
    """browser mode's kernels get none (notebook.kernel_env), since a script has the network and its output reaches the
    model; the mod's own variables, a card's choices among them, and the rest of the environment stay."""
    if not sandboxed():
        return
    names = [*SECRETS, "THIMBLE_CC_MOD_PARAMS", "THIMBLE_CC_MOD_ONLY", "THIMBLE_CC_MOD_ROOT", "CARD_COLOUR"]
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, ".thimble-cc-mod", "scripts"))
        script = os.path.join(".thimble-cc-mod", "scripts", "env.py")
        with open(os.path.join(root, script), "w") as f:
            f.write(ENV_SEEN.format(names=names))
        r = rerun(root, script, {**SECRETS, "CARD_COLOUR": "blue"})
        assert r.returncode == 0, r.stderr
        seen = json.loads(next(line for line in r.stdout.splitlines() if line.startswith("ENV "))[4:])
        assert seen == ["CARD_COLOUR", "THIMBLE_CC_MOD_ONLY", "THIMBLE_CC_MOD_PARAMS", "THIMBLE_CC_MOD_ROOT"], seen


def test_what_counts_as_a_secret_is_the_kernels_rule() -> None:
    for name in SECRETS:
        assert sandbox.secret(name), name
    for name in ("THIMBLE_CC_MOD_PARAMS", "THIMBLE_CC_MOD_ROOT", "PATH", "PYTHONUSERBASE", "LANG", "HOME"):
        assert not sandbox.secret(name), name
    assert sandbox.secret("THIMBLE_CC_MOD_TOKEN")
    unset = sandbox.secret_names({"ANTHROPIC_API_KEY": "k", "LANG": "C"})
    prefix = sandbox.bwrap_prefix(cwd=sandbox.Path("/data"), read=[], unset=unset)
    pairs = list(itertools.pairwise(prefix))
    assert ("--unsetenv", "ANTHROPIC_API_KEY") in pairs and ("--unsetenv", "LANG") not in pairs
    assert prefix.index("ANTHROPIC_API_KEY") < prefix.index("--")


def test_the_user_s_packages_and_a_venv_s_still_import() -> None:
    if not sandboxed():
        return
    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as base:
        site_dir = os.path.join(base, "lib", f"python{sys.version_info[0]}.{sys.version_info[1]}", "site-packages")
        os.makedirs(site_dir)
        with open(os.path.join(site_dir, "userpkg.py"), "w") as f:
            f.write("VALUE = 42\n")
        os.makedirs(os.path.join(root, ".thimble-cc-mod", "scripts"))
        script = os.path.join(".thimble-cc-mod", "scripts", "imports.py")
        with open(os.path.join(root, script), "w") as f:
            f.write("import userpkg; print('VALUE', userpkg.VALUE)\n")
        # pip install --user: the user's site-packages, which the fresh HOME would hide
        r = rerun(root, script, {"PYTHONUSERBASE": base}, python=sys.executable)
        assert r.returncode == 0 and "VALUE 42" in r.stdout, r.stderr
    # a venv whose interpreter links into a home folder (uv's), with packages a card imports
    venv = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))), "backend", ".venv", "bin", "python")
    if not os.path.exists(venv):
        print("skipped the venv: no backend/.venv beside this mod")
        return
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, ".thimble-cc-mod", "scripts"))
        script = os.path.join(".thimble-cc-mod", "scripts", "frame.py")
        with open(os.path.join(root, script), "w") as f:
            f.write("import pandas, matplotlib.pyplot as plt; print('ROWS', len(pandas.DataFrame({'a': [1, 2]})))\n")
        r = rerun(root, script, python=venv)
        assert r.returncode == 0 and "ROWS 2" in r.stdout, r.stderr


def test_node_runs_inside_for_a_view_s_checks() -> None:
    if not sandboxed() or not shutil.which("node"):
        return
    with tempfile.TemporaryDirectory() as root:
        p = plan(root)
        r = subprocess.run([*p["prefix"], "node", "-e", "console.log(process.version)"], cwd=root,
                           env={**os.environ, **p["env"]}, capture_output=True, text=True, timeout=60)
        assert r.returncode == 0 and r.stdout.startswith("v"), r.stderr


def test_a_view_s_checks_pass_in_the_sandbox_and_its_reader_cannot_write_beside_the_corpus() -> None:
    if not sandboxed():
        return
    import test_viewpipe  # noqa: PLC0415 — its worked view: a reader, a spec and two runs' chats
    d = test_viewpipe.folder()
    try:
        p = plan(d)
        argv = [*p["prefix"], p["python"], os.path.join(HELPER, "viewpipe.py"), "check", "chats", "--root", d]
        r = subprocess.run(argv, cwd=d, env={**os.environ, **p["env"]}, capture_output=True, text=True, timeout=600)
        assert r.returncode == 0 and "checks passed" in r.stdout, r.stdout + r.stderr
        assert os.path.exists(os.path.join(d, ".thimble-cc-mod", "views", "chats", "rows.json"))
        # a reader that writes beside the corpus is refused
        with open(os.path.join(d, ".thimble-cc-mod", "views", "chats", "reader.py"), "a") as f:
            f.write("\nopen(__import__('os').path.join(%r, 'written.txt'), 'w').close()\n" % d)
        subprocess.run(argv, cwd=d, env={**os.environ, **p["env"]}, capture_output=True, text=True, timeout=600)
        assert not os.path.exists(os.path.join(d, "written.txt"))
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_a_view_s_drawing_and_its_reviewed_copy_stay_in_the_folder() -> None:
    """The drawing the reviewer reads (register.tsx drawingsOf) and the copy of the view kept for review (copyReviewed)
    run in the sandbox: a script can make the copy's folder a link out of the folder, and outside the sandbox the copy
    then writes there."""
    if not sandboxed() or not shutil.which("node"):
        return
    import test_viewpipe  # noqa: PLC0415 — its worked view: a reader, a spec and two runs' chats
    d = test_viewpipe.folder()
    try:
        p = plan(d)
        env = {**os.environ, **p["env"]}
        view = os.path.join(d, ".thimble-cc-mod", "views", "chats")
        viewpipe = [*p["prefix"], p["python"], os.path.join(HELPER, "viewpipe.py")]
        r = subprocess.run([*viewpipe, "check", "chats", "--root", d], cwd=d, env=env, capture_output=True, text=True,
                           timeout=600)
        assert r.returncode == 0, r.stdout + r.stderr
        render = os.path.join(os.path.dirname(HELPER), "tools", "render_view.mjs")
        r = subprocess.run([*p["prefix"], "node", render, "--spec", f"{view}/view.json", "--rows", f"{view}/rows.json",
                            "--plain", "--height", "48", "--all", "--width", "96"], cwd=d, env=env, capture_output=True,
                           text=True, timeout=120)
        assert r.returncode == 0 and r.stdout.startswith("=== "), r.stderr
        with tempfile.TemporaryDirectory() as outside:
            os.symlink(outside, os.path.join(view, "reviewed"))
            subprocess.run([*viewpipe, "keep", "chats", "--root", d], cwd=d, env=env, capture_output=True, timeout=120)
            assert os.listdir(outside) == [], os.listdir(outside)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_the_plan_where_a_sandbox_is_named_or_none_runs() -> None:
    with tempfile.TemporaryDirectory() as root:
        none = sandbox.plan(root, "none")
        assert none["wrap"] == "none" and not none["prefix"] and not none["error"]
        assert none["line"] == "run unsandboxed, with your user's access (THIMBLE_KERNEL_WRAP)"
        os.makedirs(os.path.join(root, "bin"))
        # no bubblewrap and no Node on PATH: nothing can sandbox, so the scripts run as before, and the line says why
        path = os.environ["PATH"]
        os.environ["PATH"] = os.path.join(root, "bin")
        try:
            bare = sandbox.plan(root)
            named = sandbox.plan(root, "bwrap")
        finally:
            os.environ["PATH"] = path
        assert bare["wrap"] == "none" and not bare["error"], bare
        assert bare["line"].startswith("run unsandboxed, with your user's access ("), bare
        # a sandbox named that cannot run: an error, and nothing runs
        assert named["error"].startswith("THIMBLE_KERNEL_WRAP=bwrap names a sandbox that cannot run here ("), named
        # nothing of the plan is kept where the scripts can write
        assert sorted(os.listdir(os.path.join(root, ".thimble-cc-mod", "sandbox"))) in (["home"], ["home", "probe"])


def test_the_sandbox_runtime_s_rules_on_macos_keep_the_kernel_s_boundary() -> None:
    rules = sandbox.srt_rules(cwd=sandbox.Path("/Users/a/data"), read=[sandbox.Path("/Users/a/.local/lib/py")],
                              home="/Users/a")["filesystem"]
    assert rules["denyRead"][:2] == ["/Users/a", "/Users"] and "/private/var/folders" in rules["denyRead"]
    assert rules["allowRead"] == ["/Users/a/data", "/Users/a/.local/lib/py"]
    assert rules["allowWrite"] == ["/Users/a/data/.thimble-cc-mod"]
    assert rules["denyWrite"] == ["/tmp/claude", "/private/tmp/claude"]


def test_the_srt_launcher_runs_a_command_in_the_sandbox_runtime() -> None:
    node, pkg = sandbox.node(), sandbox.srt_package()
    if not node or pkg is None:
        print("skipped: no Node or no sandbox runtime package")
        return
    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
        home = os.path.join(root, "home")
        os.makedirs(os.path.join(home, "tmp"))
        with open(os.path.join(outside, "secret.txt"), "w") as f:
            f.write("private\n")
        rules = {"filesystem": {"denyRead": [outside], "allowRead": [], "allowWrite": [root], "denyWrite": []}}
        code = ("import os, sys\nopen(os.path.join(sys.argv[1], 'w'), 'w').close()\n"
                "try:\n    open(os.path.join(sys.argv[2], 'w'), 'w').close()\nexcept OSError: pass\n"
                "print('SECRET', os.path.exists(os.path.join(sys.argv[2], 'secret.txt')))\n"
                "print('HOME', os.environ['HOME'], os.environ['TMPDIR'])\n"
                "print('ENV', sorted(k for k in os.environ if k in ('ANTHROPIC_API_KEY', 'OP_SERVICE_ACCOUNT_TOKEN', "
                "'THIMBLE_CC_MOD_PARAMS', 'CARD_COLOUR')))\n")
        prefix = sandbox.srt_prefix(node_exe=node, srt_dir=pkg, rules=rules, box_home=sandbox.Path(home))
        env = {**os.environ, "ANTHROPIC_API_KEY": "k", "OP_SERVICE_ACCOUNT_TOKEN": "t", "THIMBLE_CC_MOD_PARAMS": "{}",
               "CARD_COLOUR": "blue"}
        r = subprocess.run([*prefix, sys.executable, "-c", code, root, outside], cwd=root, env=env, capture_output=True,
                           text=True, timeout=120)
        if r.returncode == 3 and "could not be set up" in r.stderr:
            print(f"skipped: the sandbox runtime does not run here: {r.stderr.strip()[-200:]}")
            return
        assert r.returncode == 0, r.stderr
        # written where it may write, and nothing in the folder it may not read (on Linux an empty tmpfs inside)
        assert os.path.exists(os.path.join(root, "w")) and not os.path.exists(os.path.join(outside, "w"))
        assert "SECRET False" in r.stdout, r.stdout
        assert f"HOME {home} {os.path.join(home, 'tmp')}" in r.stdout, r.stdout
        # no secret passed on; the mod's own variables and the rest stay
        assert "ENV ['CARD_COLOUR', 'THIMBLE_CC_MOD_PARAMS']" in r.stdout, r.stdout
        # the command's exit code is the launcher's
        assert subprocess.run([*prefix, sys.executable, "-c", "raise SystemExit(7)"], cwd=root, capture_output=True,
                              timeout=120).returncode == 7


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
