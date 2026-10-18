"""Card code in terminal mode (app/cardrun.py): add_card stores the card to run later and answers with the `thimble-run`
command; `thimble-run card <id>` runs it in its own process as a kernel cell would and stores what a kernel run stores;
card code never runs in the shim, and a card check's trial runs in a `thimble-run trial` process, in the sandbox runtime
where it runs; a code label runs through `thimble-run label`; the shim's watch starts the check of a card that ran.
The kernel runs here are real kernels, the card runs real `thimble-run` processes."""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
from pathlib import Path

import pytest

from app import cardrun, config, local, notebook, tools

CORPUS = "mini"


def _mode(mode: str) -> None:
    ws = config.workspace_dir(CORPUS)
    (ws / "trusted").mkdir(exist_ok=True)
    (ws / "trusted" / "launch.json").write_text(json.dumps({"mode": mode}))


@pytest.fixture()
def term(workspaces_tmp, mini_dir, monkeypatch) -> Path:
    """Workspace `mini` in terminal mode, and the environment a `thimble-run` in main's Bash has."""
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    _mode("terminal")
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    yield mini_dir
    cardrun.CardWatch.stop_all()
    local._started.clear()


def run(corpus: Path, *args: str, timeout: float = 120) -> subprocess.CompletedProcess:
    return subprocess.run([str(cardrun.bin_path()), *args], cwd=corpus, env=dict(os.environ), capture_output=True,
                          text=True, timeout=timeout)


async def call(corpus: Path, tool: str, **args) -> dict:
    return await local.call(tool, args, cwd=str(corpus))


def text(res: dict) -> str:
    return "\n".join(b.get("text", "") for b in res["content"] if b.get("type") == "text")


def card_id(res: dict) -> str:
    assert not res["is_error"], text(res)
    return re.search(r"^card:([A-Za-z0-9_-]+)\s*$", text(res), re.M).group(1)


CHART = ("import thimble, pandas as pd\nn = sum(1 for _ in open('board.jsonl'))\n"
         "thimble.chart('bar', pd.DataFrame({'agent': ['a', 'b'], 'posts': [n, 1]}))")


async def test_a_card_run_by_thimble_run_stores_what_a_kernel_run_stores(term):
    """A chart card that reads a corpus file, run by a kernel in browser mode and by `thimble-run card` in terminal
    mode: the same status, outputs, digest and reads, and the run prints what add_card answers with in browser mode."""
    _mode("browser")
    group = notebook.create_notebook(config.workspace_dir(CORPUS), "K")["id"]
    try:
        ran = await notebook.run_code(CORPUS, CHART, created_by="test", title="chart", notebook=group, kind="plot")
        k = notebook.get_cell(CORPUS, ran["id"])  # as stored: bounded, as the card run's is
    finally:
        await notebook.shutdown_all()
    _mode("terminal")
    res = await call(term, "add_card", kind="plot", question="chart", code=CHART, group="T")
    cid = card_id(res)
    waiting = notebook.get_cell(CORPUS, cid)
    assert waiting["status"] == "idle" and waiting["outputs"] == [] and waiting["run"]["state"] == "waiting"
    assert waiting["run"]["by"] == "bash" and waiting["run"]["script"] == f"card-runs/{cid}.py"
    assert cardrun.command("card", cid) in text(res)
    assert (config.workspace_dir(CORPUS) / "card-runs" / f"{cid}.py").read_text().endswith(CHART)
    done = run(term, "card", cid)
    cell = notebook.get_cell(CORPUS, cid)
    assert done.returncode == 0, done.stdout + done.stderr
    assert cell["status"] == k["status"] == "ok" and cell["run"]["state"] == "done"
    assert cell["outputs"] == k["outputs"] and cell.get("out_memo") == k.get("out_memo")
    assert cell["reads"] == k["reads"] == ["board.jsonl"]
    assert done.stdout.startswith(f"card:{cid}\n"), done.stdout
    full = notebook.get_cell(CORPUS, cid, full_outputs=True)  # add_card formats a run's complete outputs
    assert tools._format_cell_result(full, lines=tools.result_lines(CORPUS)) in done.stdout


async def test_the_shim_never_runs_card_code_in_terminal_mode(term):
    """Card code never runs in the shim: a run asked for there is refused, and the card check's trial of a revision
    runs in a `thimble-run trial` process of its own, as a card run would, and stores nothing. Where thimble's sandbox
    runtime runs, the trial runs in it: it writes the card folders and nothing of the corpus or the rest of the
    workspace."""
    from app import kernel_wrap, srt

    with pytest.raises(notebook.TerminalRun):
        await notebook.run_code(CORPUS, "print(1)", created_by="test")
    ws = config.workspace_dir(CORPUS)
    boxed = kernel_wrap.srt_works(srt.node(), srt.package(config.REPO_ROOT))
    cid = card_id(await call(term, "add_card", question="q", code="print(1)"))
    probe = "import os\nprint(os.getpid())\nprint(sum(1 for _ in open('board.jsonl')))\n"
    if boxed:
        probe += (
            "def can_write(d):\n"
            "    p = os.path.join(d, '.thimble-trial-probe')\n"
            "    try:\n"
            "        open(p, 'w').close()\n"
            "    except OSError:\n"
            "        return False\n"
            "    os.remove(p)\n"
            "    return True\n"
            f"print(can_write({str(term)!r}), can_write({str(ws)!r}), can_write({str(ws / 'card-runs')!r}))\n"
            "print(os.environ.get('SANDBOX_RUNTIME'))")
    trial = await notebook.trial_run(CORPUS, cid, probe)
    assert trial["status"] == "ok" and trial["trial"] == "", trial["outputs"]
    pid, lines, *box = trial["outputs"][0]["text/plain"].split()
    assert int(pid) != os.getpid(), "the revision ran in a card runner, not in this process"
    assert int(lines) > 0, "in the scratch mirror of the corpus, as a card run is"
    if boxed:
        assert box == ["False", "False", "True", "1"], "in the sandbox runtime, writing the card folders alone"
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["code"] == "print(1)" and cell["outputs"] == [], "a trial stores nothing"
    assert cell["run"]["state"] == "waiting"


def test_a_trial_s_sandbox_has_the_rules_of_a_trial_where_srt_runs_and_none_elsewhere(term, monkeypatch, tmp_path):
    """Where Anthropic's sandbox runtime runs, a card check's trial runs in it with no network, thimble's token files
    (userconf.private_paths: server.json, and paired.json once the hooks lane adds it) and links folder unreadable,
    writes only to the agents' work folders and the card folders, and the corpus and the workspace's config.json and
    settings.json not writable. Where it can't run, the trial runs plain, as main's Bash runs `thimble-run`."""
    from app import kernel_wrap, subagents, userconf

    ws = config.workspace_path(CORPUS)
    home = userconf.global_file().parent
    monkeypatch.setattr(kernel_wrap, "srt_works", lambda node, package: True)
    box = cardrun.trial_sandbox(CORPUS)
    fs = box["filesystem"]
    assert box["network"] == {"allowedDomains": [], "deniedDomains": []}
    assert str(home / "server.json") in fs["denyRead"] and set(userconf.private_paths()) <= set(fs["denyRead"])
    assert str(home / userconf.LINKS_DIR) in fs["denyRead"] and fs["allowRead"] == []
    assert set(fs["allowWrite"]) == {str(d) for d in [*subagents.write_dirs(CORPUS), *cardrun.write_dirs(CORPUS)]}
    assert str(config.workspace_dir(CORPUS) / "card-runs") in fs["allowWrite"]
    assert str(ws) not in fs["allowWrite"] and str(term) not in fs["allowWrite"]
    assert fs["denyWrite"] == [os.path.realpath(config.corpus_dir(CORPUS)), str(userconf.workspace_file(CORPUS)),
                               str(ws / "settings.json")]
    monkeypatch.setattr(kernel_wrap, "srt_works", lambda node, package: False)
    assert cardrun.trial_sandbox(CORPUS) is None
    assert cardrun.trial_argv(CORPUS, "c1", tmp_path) == [str(cardrun.bin_path()), cardrun.TRIAL, "c1"], "plain"


async def test_a_code_label_runs_through_thimble_run(term):
    rule = "def label(u):\n    return 'long' if len(str(u)) > 300 else 'short'"
    res = await call(term, "apply_label", scope="files", name="long", predicate={"kind": "code", "text": rule},
                     paths=["agents/*.jsonl"], values=["long", "short"], filter=True)
    assert not res["is_error"], text(res)
    assert "It is the files filter now." in text(res), "the shim sets the filter: the run may not write filters.json"
    from app import concepts as _c

    assert "filter" not in _c.read_concept(config.workspace_dir(CORPUS),
                                           re.search(r"concept:([A-Za-z0-9_-]+)", text(res)).group(1))["pending_run"]["args"]
    lid = re.search(r"concept:([A-Za-z0-9_-]+)", text(res)).group(1)
    assert cardrun.command("label", lid) in text(res) and "applied label" not in text(res)
    from app import concepts

    assert concepts.read_concept(config.workspace_dir(CORPUS), lid)["applications"] == [], "nothing ran in the shim"
    done = run(term, "label", lid)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "applied label long" in done.stdout and "long 22, short 38" in done.stdout
    assert concepts.read_concept(config.workspace_dir(CORPUS), concepts.PENDING_RUN) is None
    assert concepts.PENDING_RUN not in concepts.read_concept(config.workspace_dir(CORPUS), lid)


async def test_the_commands_main_is_told_to_run_are_thimble_run_alone_with_no_cd(term):
    """Bug hunt F3: main ran `cd <folder>; thimble-run card …`, so the one "don't ask again" Claude Code offered in
    Manual mode was `cd *`, and once wrapped the command in `$(…)`. A card's, a code label's and the stale cards'
    results give the command alone, `thimble-run <kind> …`, and say to run it exactly as it is with no `cd` before it,
    so INSTALL's `Bash(thimble-run:*)` matches what main runs."""
    from app import concepts

    res = await call(term, "add_card", kind="table", question="How many?", group="T",
                     code="import pandas as pd\npd.DataFrame({'n': [1]})")
    rule = "def label(u):\n    return 'long' if len(str(u)) > 300 else 'short'"
    lab = await call(term, "apply_label", scope="files", name="long", predicate={"kind": "code", "text": rule},
                     paths=["agents/*.jsonl"], values=["long", "short"])
    told = {"card": text(res), "label": text(lab), "stale": concepts.stale_note(CORPUS, [{"id": card_id(res)}])}
    for kind, said in told.items():
        [cmd] = re.findall(r"`([^`]*thimble-run[^`]*)`", said)
        argv = shlex.split(cmd)
        assert Path(argv[0]).name == "thimble-run" and argv[1] == kind, (kind, cmd)
        assert not re.search(r"[;&|$()<>]", cmd) and "cd" not in argv, (kind, cmd)
        assert "exactly as it is, with no `cd` before it" in said, (kind, said)


async def test_a_label_panel_run_of_an_unchanged_code_label_waits_for_no_run(term):
    """Bug hunt B31: the label panel's `run on a sample` of a code label nobody changed asked main to run it, and
    `thimble-run label` answered with the old rows. `label-run` now answers `unchanged` when the label's last run covers
    the run asked for (the same code over the same files, all of them or the same sample), and no run waits for main; a
    run its last run does not cover (a wider one, or new code) still waits for `thimble-run label`."""
    from app import concepts

    rule = "def label(u):\n    return 'long' if len(str(u)) > 300 else 'short'"
    res = await call(term, "apply_label", scope="files", name="long", predicate={"kind": "code", "text": rule},
                     paths=["agents/*.jsonl"], values=["long", "short"], limit=3)
    lid = re.search(r"concept:([A-Za-z0-9_-]+)", text(res)).group(1)
    assert run(term, "label", lid).returncode == 0
    ws = config.workspace_dir(CORPUS)
    # the same sample, then every file: the sample is covered, every file is not
    same = await local.act(CORPUS, "label-run", {"label": lid, "limit": 3})
    assert same == {"ok": True, "label": lid, "unchanged": True}
    assert concepts.PENDING_RUN not in concepts.read_concept(ws, lid)
    wider = await local.act(CORPUS, "label-run", {"label": lid})
    assert wider["deferred"] is True and concepts.read_concept(ws, lid)[concepts.PENDING_RUN]["args"].get("limit") is None
    assert run(term, "label", lid).returncode == 0
    # once every file ran, a sample of them is covered too
    assert (await local.act(CORPUS, "label-run", {"label": lid, "limit": 3}))["unchanged"] is True
    assert (await local.act(CORPUS, "label-run", {"label": lid}))["unchanged"] is True
    # new code is not
    await local.act(CORPUS, "label", {"label": lid, "body": rule.replace("300", "200")})
    changed = await local.act(CORPUS, "label-run", {"label": lid, "limit": 3})
    assert changed["deferred"] is True and "unchanged" not in changed


async def test_the_shims_watch_starts_the_check_of_a_card_run_with_a_takeaway(term, monkeypatch):
    from app import card_check

    started: list[tuple[str, str]] = []
    monkeypatch.setattr(card_check, "start", lambda c, cid, author, **kw: started.append((cid, author)))
    monkeypatch.setenv("THIMBLE_CARD_CHECK", "on")
    cid = card_id(await call(term, "add_card", question="Posts?", code="print(8)", takeaway="There are 8 posts."))
    started.clear()  # add_card's own call (card_check.after_tool), which the real start refuses for a card not run yet
    watch = cardrun.CardWatch(CORPUS)
    watch.look()
    assert run(term, "card", cid).returncode == 0
    assert notebook.get_cell(CORPUS, cid).get("check") == "pending"
    watch.look()
    assert started == [(cid, "main")] and "check" not in notebook.get_cell(CORPUS, cid)
    # the runner wrote no history (main's sandbox cannot write the workspace's logs); the watch records its run
    lines = [json.loads(x) for x in (config.workspace_dir(CORPUS) / "canvas-history.jsonl").read_text().splitlines()]
    mine = [x for x in lines if x.get("card") == cid]
    assert [x["op"] for x in mine] == ["created", "edited"], "the run and its takeaway, in one line from the watch"
    assert mine[-1]["state"]["status"] == "ok" and mine[-1]["state"]["takeaway"].startswith("There are")


async def test_a_run_again_s_check_starts_before_and_after_the_press(term, monkeypatch):
    """Bug hunt B19: after `run again` a card stayed `check: "pending"` for good. The shim's watch never started (the shim
    makes local.begin in a worker thread, which has no loop, and the calls after it took the start as made), and after
    the press no process watched. Now the shim's watch starts with the next call on its loop and acts while main's
    transport is local, and the server's watch acts after the press. An edit's new code waits for its run, so no check
    reads it beside the old outputs, and a run whose card stands as its last check read it leaves no mark."""
    import asyncio

    from app import card_check, checkstore

    started: list[str] = []
    monkeypatch.setattr(card_check, "start", lambda c, cid, author, **kw: started.append(cid))
    monkeypatch.setenv("THIMBLE_CARD_CHECK", "on")

    async def claimed(cid: str) -> bool:
        for _ in range(50):
            if started == [cid] and "check" not in notebook.get_cell(CORPUS, cid):
                return True
            await asyncio.sleep(0.1)
        return False

    assert await asyncio.to_thread(local.begin, str(term)) == CORPUS  # as bin/thimble-mcp's go_live makes it
    cid = card_id(await call(term, "add_card", question="Posts?", code="print(8)", takeaway="There are 8 posts."))
    started.clear()  # add_card's own call (card_check.after_tool)
    assert run(term, "card", cid).returncode == 0
    assert await claimed(cid), "the shim's watch started the check of the run on local transport"
    # an edit that keeps the takeaway waits for its run beside the old outputs: no check of it yet, and its run's end
    # marks it
    await call(term, "edit_card", card=cid, code="print(8)")
    staged = notebook.get_cell(CORPUS, cid)
    assert staged["run"]["state"] == "waiting" and staged["takeaway"] and not card_check.wants_check(staged)
    # the press: main's calls go to the server, and so does the run's check
    (config.workspace_dir(CORPUS) / "trusted" / "launch.json").write_text(json.dumps({"transport": "server"}))
    started.clear()
    assert run(term, "card", cid).returncode == 0
    assert notebook.get_cell(CORPUS, cid).get("check") == "pending"
    await asyncio.sleep(2 * cardrun.WATCH_S)
    assert started == [], "the shim's watch leaves it to the server after the press"
    async with notebook._lifespan(None):
        assert await claimed(cid), "the server's watch started the check of the run again"
    # a run again whose outputs came out as the last check read them: that check stands, and no mark
    check = checkstore.begin(CORPUS, cid)
    assert checkstore.finish(CORPUS, cid, check, "ok")
    started.clear()
    assert run(term, "card", cid).returncode == 0
    assert notebook.get_cell(CORPUS, cid)["check"]["status"] == "ok"


def test_main_s_bash_runs_thimble_run_by_its_name_from_the_plugin_s_bin(tmp_path, monkeypatch):
    """Claude Code puts the bin/ of the plugin copy it started the shim from (CLAUDE_PLUGIN_ROOT) on main's Bash's PATH,
    after its own, and not on the shim's: the command names `thimble-run` alone then. It names the full path when main's
    Bash would find another `thimble-run` first, when Claude Code leaves that bin/ off (a path with a `$`), when the
    session's copy is another, and outside the shim."""
    def plugin_copy(root: Path) -> Path:
        (root / "bin").mkdir(parents=True)
        (root / "bin" / cardrun.BIN).write_text("#!/bin/sh\n")
        (root / "bin" / cardrun.BIN).chmod(0o755)
        return root

    def full(root: Path, *args: str) -> str:
        return shlex.join([str(root / "bin" / cardrun.BIN), *args])

    copy, other, odd = (plugin_copy(tmp_path / n) for n in ("cache/thimble/0.9.0", "other", "a$b"))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv(cardrun.PLUGIN_ROOT_ENV, str(copy))
    monkeypatch.setattr(local, "PLUGIN_ROOT", copy)  # the shim's copy (bin/thimble-mcp)
    assert cardrun.command("card", "c1") == "thimble-run card c1"
    assert cardrun.command("stale") == "thimble-run stale"
    monkeypatch.setenv("PATH", f"{other / 'bin'}:/usr/bin:/bin")
    assert cardrun.command("card", "c1") == full(copy, "card", "c1"), "another thimble-run comes first on the PATH"
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv(cardrun.PLUGIN_ROOT_ENV, str(other))
    assert cardrun.command("card", "c1") == full(copy, "card", "c1"), "the session's plugin copy is another"
    monkeypatch.setenv(cardrun.PLUGIN_ROOT_ENV, str(odd))
    monkeypatch.setattr(local, "PLUGIN_ROOT", odd)
    assert cardrun.command("label", "l1") == full(odd, "label", "l1"), "Claude Code leaves that bin/ off its PATH"
    monkeypatch.setenv(cardrun.PLUGIN_ROOT_ENV, str(copy))
    monkeypatch.setattr(local, "PLUGIN_ROOT", None)  # the server, `thimble act`: no plugin copy of a session
    assert cardrun.command("card", "c1") == shlex.join([str(cardrun.bin_path()), "card", "c1"])
