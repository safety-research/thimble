"""No agent thimble starts leaves anything in the corpus folder. thimble's own agents are subagents of main, whose fence
keeps the corpus read-only (cli.main_fence), and write in work folders outside it (subagents.write_dirs). Claude Code's
Bash sandbox makes a folder of its own in the folder a sandboxed command starts in, so every `claude -p` session thimble
starts itself (a code ticket's, an extension's program's) runs in a folder of its own with the corpus added, and each of
its Bash commands starts there again: a `cd` into the corpus does not carry over to the next command
(agent_session.HOME_SHELL_ENV).

The tests marked live run sandboxed Bash commands, on the user's own `claude`, in those sessions as thimble starts them,
and check that a copy of a corpus is left as it was. They need THIMBLE_LIVE_CLAUDE=1, a logged-in `claude` and Claude
Code's sandbox. The card and label kernels need no model and run wherever their sandbox runs."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from app import (agent_session, cc_settings, checks, config, critique_session, dev, harness, kernel_wrap, notebook,
                 orient_session, roles, srt, userconf, views, write_session)

CORPUS = "copy"
LIVE = os.environ.get("THIMBLE_LIVE_CLAUDE") == "1"
REAL_CLAUDE = shutil.which("claude")  # read at import, before the suite's stand-in goes first on PATH
LIVE_MODEL = os.environ.get("THIMBLE_LIVE_MODEL") or "claude-haiku-4-5"
LIVE_TIMEOUT_S = 300


@pytest.fixture()
def corpus(tmp_path, monkeypatch, mini_dir) -> Path:
    """A copy of the `mini` corpus under the name CORPUS."""
    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / CORPUS)
    (data / CORPUS / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    yield (data / CORPUS).resolve()


def snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """Every entry under `root`, hidden ones included: its size and modification time, 0 and 0 for a folder."""
    out: dict[str, tuple[int, int]] = {}
    for path in sorted(root.rglob("*")):
        st = path.lstat()
        out[str(path.relative_to(root))] = (0, 0) if path.is_dir() else (st.st_size, st.st_mtime_ns)
    return out


def _settings(argv: list[str]) -> dict:
    return json.loads(argv[argv.index("--settings") + 1])


def _added(argv: list[str]) -> list[str]:
    return [argv[i + 1] for i, a in enumerate(argv) if a == "--add-dir"]


def test_every_agent_s_work_folder_lies_outside_the_corpus(corpus):
    """The work folder of every kind of agent, and every folder main's Bash may write, lies outside the corpus folder."""
    from app import subagents

    for folder in subagents.write_dirs(CORPUS):
        assert not folder.resolve().is_relative_to(corpus), folder
    folders = {"orientation": orient_session.work_dir(CORPUS), "critic": critique_session.work_dir(CORPUS, "c1"),
               "writer": write_session.work_dir(CORPUS, "report"), "check": checks.work_dir(CORPUS, "k1", "report"),
               "view build": dev.view_work_dir(CORPUS, "posts")}
    for kind, folder in folders.items():
        assert not folder.resolve().is_relative_to(corpus), kind


def test_each_job_s_own_folder_is_one_main_s_fence_lets_it_write_and_its_task_names_it(corpus):
    """A view builder, a view reviewer and a check's run are subagents of main inside main's fence: each one's own folder
    lies under a folder main's Bash may write (subagents.write_dirs), and so does the view's folder; a build's task
    names both, and its registration names the corpus as the folder it reads."""
    from app import subagents, view_tools

    writable = [w.resolve() for w in subagents.write_dirs(CORPUS)]

    def under(p: Path) -> bool:
        return any(p.resolve().is_relative_to(w) for w in writable)

    slug = views.propose(CORPUS, "Posts", "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
    work, folder = dev.view_work_dir(CORPUS, slug), views.views_dir(CORPUS) / slug
    assert under(work) and under(folder) and under(checks.work_dir(CORPUS, "k1", "report"))
    task = dev.build_task(CORPUS, views.read_proposal(CORPUS, slug))
    assert str(work) in task and str(folder) in task
    assert str(corpus) in view_tools.builder_definition(CORPUS)["prompt"]


def test_a_program_s_session_runs_in_the_role_s_work_folder(corpus, tmp_path, monkeypatch):
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    part = roles.Part("x", "writer", tmp_path, tmp_path, {"command": ["true"]})
    work = write_session.work_dir(CORPUS, "report")
    job = harness.Job(CORPUS, "writer", "writer:report", "Write", {}, ("list_cards",), work)
    run = harness.Run(job, part, userconf.session(CORPUS, "writer", sandbox=True), "t", "t.s")
    argv, folder, _env = harness.claude_argv(run, ["-p"])
    assert folder == work and str(corpus) in _added(argv)
    assert _settings(argv)["env"][agent_session.HOME_SHELL_ENV] == "1"


# --------------------------------------------------------------------------- live: sandboxed Bash in each session


def _live_ok() -> str:
    """Why the live tests can't run here, '' when they can."""
    if not LIVE:
        return "set THIMBLE_LIVE_CLAUDE=1 to run sandboxed Bash on your own claude"
    if not REAL_CLAUDE:
        return "no claude on PATH"
    if not cc_settings.sandbox_ok():
        return "Claude Code's sandbox can't run here"
    return ""


def _live_argv(argv: list[str]) -> list[str]:
    """A session's argv as thimble starts it, run with --print on LIVE_MODEL: without its agent definition, appended
    prompt, session id, model and effort, and without the hooks that answer through thimble's server, its sandboxed Bash
    allowed unasked in their place."""
    drop_value = {"--agents", "--agent", "--append-system-prompt", "--session-id", "--model", "--effort",
                  "--output-format", "--resume", "-n"}
    out: list[str] = []
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in drop_value:
            i += 2
            continue
        if a in ("-p", "--print", "--verbose"):
            i += 1
            continue
        if a == "--settings":
            settings = json.loads(argv[i + 1])
            settings.pop("hooks", None)
            if isinstance(settings.get("sandbox"), dict):
                settings["sandbox"]["autoAllowBashIfSandboxed"] = True
            out += [a, json.dumps(settings)]
            i += 2
            continue
        out.append(a)
        i += 1
    return [str(REAL_CLAUDE), "-p", "--model", LIVE_MODEL, "--output-format", "stream-json", "--verbose", *out]


def _bash_in(argv: list[str], folder: Path, env: dict[str, str], corpus: Path) -> None:
    """Run the session `argv` in `folder` and have it run three sandboxed Bash commands: a `cd` into the corpus, then
    `pwd`, then a listing. The commands must have run, the second one in `folder`, and the corpus must be unchanged."""
    before = snapshot(corpus)
    prompt = ("Make exactly three Bash tool calls, one at a time, and no other tool calls. First: "
              f"`cd {corpus}/agents && ls | head -3`. Second: `pwd`. Third: `ls -a | head -5`. Then reply with the "
              "word done.")
    stand_in = str(Path(config.CLAUDE_BIN).parent)
    env = {**{k: v for k, v in env.items() if k != "CLAUDE_CONFIG_DIR" or k in os.environ},
           "PATH": os.pathsep.join(p for p in env.get("PATH", "").split(os.pathsep) if p != stand_in)}
    for attempt in range(3):
        proc = subprocess.run(_live_argv(argv), input=prompt, capture_output=True, text=True, cwd=folder, env=env,
                              timeout=LIVE_TIMEOUT_S)
        if "overloaded" not in proc.stdout and "rate_limit" not in proc.stdout:
            break
    calls: dict[str, str] = {}
    results: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        for b in ((rec.get("message") or {}).get("content") or []) if isinstance(rec.get("message"), dict) else []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use" and b.get("name") == "Bash":
                calls[b["id"]] = str((b.get("input") or {}).get("command") or "")
            elif b.get("type") == "tool_result":
                content = b.get("content")
                text = content if isinstance(content, str) else " ".join(
                    str(x.get("text") or "") for x in content or [] if isinstance(x, dict))
                results[str(b.get("tool_use_id"))] = text
    ran = [(cmd, results.get(tid, "")) for tid, cmd in calls.items()]
    assert len(ran) >= 3 and f"cd {corpus}" in ran[0][0], (ran, proc.stdout[-2000:], proc.stderr[-2000:])
    assert ran[1][1].strip() == str(folder.resolve()), ran
    assert snapshot(corpus) == before, sorted(set(snapshot(corpus)) ^ set(before))


def test_live_a_view_build_s_sandboxed_bash_leaves_the_corpus_as_it_was(corpus):
    if why := _live_ok():
        pytest.skip(why)
    slug = "posts"
    work, folder = dev.view_work_dir(CORPUS, slug), views.views_dir(CORPUS) / slug
    work.mkdir(parents=True, exist_ok=True)
    folder.mkdir(parents=True, exist_ok=True)
    conf = dev.dev_config(CORPUS, sandbox=True)
    flags = dev.Sessions()._flags(CORPUS, "thimble view: Posts", (folder, corpus),
                                  dev.view_fence(CORPUS, slug, corpus, folder, conf),
                                  dev.view_asking(CORPUS, slug, folder, conf))
    _bash_in([config.CLAUDE_BIN, *flags], work, dict(os.environ), corpus)


def test_live_a_program_s_session_s_sandboxed_bash_leaves_the_corpus_as_it_was(corpus, tmp_path):
    if why := _live_ok():
        pytest.skip(why)
    part = roles.Part("x", "writer", tmp_path, tmp_path, {"command": ["true"]})
    job = harness.Job(CORPUS, "writer", "writer:report", "Write", {}, ("list_cards",),
                      write_session.work_dir(CORPUS, "report"))
    run = harness.Run(job, part, userconf.session(CORPUS, "writer", sandbox=True), "t", "t.s")
    argv, folder, env = harness.claude_argv(run, ["-p"])
    _bash_in(argv, folder, env, corpus)


def _kernel_wraps() -> str:
    """The kernel's sandbox where one runs here, else ''."""
    node, package = srt.node(), srt.package(config.REPO_ROOT)
    if node and package and kernel_wrap.srt_works(node, package):
        return config.KERNEL_WRAP_SRT
    return config.KERNEL_WRAP_BWRAP if sys.platform == "linux" and kernel_wrap.works() else ""


async def test_card_and_label_code_that_runs_shell_commands_in_the_corpus_leaves_it_as_it_was(corpus, monkeypatch):
    wrap = _kernel_wraps()
    if not wrap:
        pytest.skip("no kernel sandbox runs here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    before = snapshot(corpus)
    code = (f"import os, subprocess\nos.chdir({str(corpus)!r})\n"
            f"print(subprocess.run('cd agents && ls | head -2; ls -a', shell=True, capture_output=True, text=True).stdout)")
    try:
        cell = await notebook.run_code(CORPUS, code, "main")
        said = "".join(b.get("text/plain", "") or b.get("text", "") for b in cell["outputs"])
        assert "agent-01.jsonl" in said, cell["outputs"]
        outputs, _n, _err = await notebook.execute_on(CORPUS, "labels", code)
        assert "agent-01.jsonl" in json.dumps(outputs), outputs
    finally:
        await notebook.shutdown_all()
    assert snapshot(corpus) == before, sorted(set(snapshot(corpus)) ^ set(before))
