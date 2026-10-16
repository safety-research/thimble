"""Card code in terminal mode (app/cardrun.py): add_card stores the card to run later and answers with the `thimble-run`
command; `thimble-run card <id>` runs it in its own process as a kernel cell would and stores what a kernel run stores;
card code never runs in the shim, and a card check's trial runs in a `thimble-run trial` process, in the sandbox runtime
where it runs; a code label runs through `thimble-run label`; the shim's watch starts the check of a card that ran.
The kernel runs here are real kernels, the card runs real `thimble-run` processes."""
from __future__ import annotations

import json
import os
import re
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
    return re.search(r"^card:([A-Za-z0-9_-]+)\s*$", text(res).split("\n", 1)[1], re.M).group(1)


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
