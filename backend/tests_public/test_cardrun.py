"""Card code in terminal mode (app/cardrun.py): add_card and edit_card store the card to run later and answer with the
`thimble-run` command; `thimble-run card <id>` runs it in its own process as a kernel cell would and stores what a
kernel run stores; a code label runs through `thimble-run label`, and the cards that read a changed label through
`thimble-run stale`. The kernel runs here are real kernels, the card runs real `thimble-run` processes."""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from app import cardrun, config, local, notebook, tools

CORPUS = "mini"
ANSI = re.compile(r"\x1b\[[0-9;]*m")


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


def _comparable(outputs: list[dict]) -> list[dict]:
    """Outputs with what differs between two runs of one card left out: a traceback's colours and cell number, an SVG's
    dates and ids, and the name of a bounded output's side file, which names its card."""
    out = []
    for b in outputs:
        b = json.loads(json.dumps(b))
        err = b.get(notebook.ERROR_MIME)
        if isinstance(err, dict):
            err["traceback"] = [re.sub(r"In\[\d+\]", "In[N]", ANSI.sub("", t)) for t in err.get("traceback") or []]
        if isinstance(b.get("truncated"), dict):
            b["truncated"] = {k: v for k, v in b["truncated"].items() if not isinstance(v, str) or "outputs/" not in v}
        svg = b.get("image/svg+xml")
        if isinstance(svg, str):
            b["image/svg+xml"] = re.sub(r'(id|href|clip-path)="[^"]*"', "", re.sub(r"<dc:date>.*?</dc:date>", "", svg))
        out.append(b)
    return out


CARDS = {
    "table": ("table", "import pandas as pd\npd.DataFrame({'a': [1, 2, 3], 'b': ['x', 'y', 'z']}).set_index('b')"),
    "altair": ("plot", "import altair as alt, pandas as pd\n"
                       "alt.Chart(pd.DataFrame({'x': [1, 2, 3], 'y': [3, 1, 2]})).mark_bar().encode(x='x:O', y='y:Q')"),
    "matplotlib": ("plot", "import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.bar(['a', 'b'], [1, 2])\nfig"),
    "diagram": ("diagram", "import thimble\nthimble.diagram(['a', 'b'], [('a', 'b', 'calls')])"),
    "timeline": ("timeline", "import thimble\n"
                             "thimble.timeline([('2026-03-12T09:00:00', 'start'), ('2026-03-12T09:30:00', 'end')])"),
    "streams": ("code", "import sys\nprint('hello')\nprint('err', file=sys.stderr)\nprint('again')\n1 + 1"),
    "display": ("code", "from IPython.display import display, Markdown\n"
                        "h = display(Markdown('one'), display_id=True)\nh.update(Markdown('two'))\nprint('done')"),
    "error": ("code", "x = 1\nraise ValueError('boom')"),
    "reads": ("code", "print(sum(1 for _ in open('board.jsonl')))"),
    "bounded": ("code", "for i in range(20000):\n    print(i)"),
}


async def test_a_card_run_by_thimble_run_stores_what_a_kernel_run_stores(term):
    _mode("browser")
    group = notebook.create_notebook(config.workspace_dir(CORPUS), "K")["id"]
    kernel = {}
    try:
        for name, (kind, code) in CARDS.items():
            ran = await notebook.run_code(CORPUS, code, created_by="test", title=name, notebook=group, kind=kind)
            kernel[name] = notebook.get_cell(CORPUS, ran["id"])  # as stored: bounded, as the card run's is
    finally:
        await notebook.shutdown_all()
    _mode("terminal")
    for name, (kind, code) in CARDS.items():
        res = await call(term, "add_card", kind=kind, question=name, code=code, group="T")
        cid = card_id(res)
        waiting = notebook.get_cell(CORPUS, cid)
        assert waiting["status"] == "idle" and waiting["outputs"] == [] and waiting["run"]["state"] == "waiting"
        assert waiting["run"]["by"] == "bash" and waiting["run"]["script"] == f"card-runs/{cid}.py"
        assert cardrun.command("card", cid) in text(res)
        assert (config.workspace_dir(CORPUS) / "card-runs" / f"{cid}.py").read_text().endswith(code)
        done = run(term, "card", cid)
        cell = notebook.get_cell(CORPUS, cid)
        k = kernel[name]
        assert done.returncode == (1 if name == "error" else 0), done.stdout + done.stderr
        assert cell["status"] == k["status"] and cell["run"]["state"] == "done", name
        assert _comparable(cell["outputs"]) == _comparable(k["outputs"]), name
        if not any("image/svg+xml" in b for b in cell["outputs"]):  # an SVG's digest holds its random ids
            assert cell.get("out_memo") == k.get("out_memo"), name
        if name == "reads":
            assert cell["reads"] == k["reads"] == ["board.jsonl"]
        if name == "bounded":
            assert any("truncated" in b for b in cell["outputs"]), "an oversized output is bounded with its side file"
        # what the run prints is what add_card answers with in browser mode
        assert done.stdout.startswith(f"card:{cid}\n"), done.stdout
        full = notebook.get_cell(CORPUS, cid, full_outputs=True)  # add_card formats a run's complete outputs
        assert tools._format_cell_result(full, lines=tools.result_lines(CORPUS)) in done.stdout


async def test_what_a_child_process_writes_is_in_the_card(term):
    """As ipykernel captures file descriptors 1 and 2 by default, a child process's output is the card's."""
    cid = card_id(await call(term, "add_card", question="child", code="import subprocess\n"
                             "subprocess.run(['echo', 'from a child'])\nprint('parent')"))
    assert run(term, "card", cid).returncode == 0
    assert notebook.get_cell(CORPUS, cid)["outputs"] == [{"text/plain": "from a child\nparent\n", "_stream": "stdout"}]


async def test_a_takeaway_given_with_the_card_is_stored_after_its_run(term):
    res = await call(term, "add_card", kind="code", question="How many posts?",
                     code="print(sum(1 for _ in open('board.jsonl')))", takeaway="The board holds 8 posts.")
    cid = card_id(res)
    assert notebook.get_cell(CORPUS, cid)["takeaway"] == "", "nothing ran yet, so nothing is noted"
    done = run(term, "card", cid)
    assert done.returncode == 0, done.stderr
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["takeaway"].startswith("The board holds") and "takeaway" not in cell["run"]
    assert f"takeaway noted on card:{cid}" in done.stdout


async def test_an_edit_waits_too_and_a_kept_takeaway_goes_stale_when_the_outputs_change(term):
    count = ("import pathlib\np = pathlib.Path('runs.txt')\nn = int(p.read_text()) + 1 if p.exists() else 1\n"
             "p.write_text(str(n))\nprint(n)")
    cid = card_id(await call(term, "add_card", kind="code", question="Runs?", code="print(1)"))
    assert run(term, "card", cid).returncode == 0
    res = await call(term, "edit_card", card=cid, code=count, takeaway="Runs once.")
    assert cardrun.command("card", cid) in text(res) and notebook.get_cell(CORPUS, cid)["run"]["state"] == "waiting"
    assert notebook.get_cell(CORPUS, cid)["previous_code"] == "print(1)"
    assert run(term, "card", cid).returncode == 0
    assert notebook.get_cell(CORPUS, cid)["takeaway"] == "Runs once."
    # the same code, question and kind run again keep the takeaway; outputs that changed mark it stale
    await call(term, "edit_card", card=cid, code=count)
    assert "kept" in notebook.get_cell(CORPUS, cid)["run"]
    done = run(term, "card", cid)
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["takeaway"] == "Runs once." and cell["takeaway_stale"] is True and "kept" not in cell["run"]
    assert tools.hint("takeaway-stale", cid=cid) in done.stdout
    # new code clears it
    await call(term, "edit_card", card=cid, code="print(2)")
    assert notebook.get_cell(CORPUS, cid)["takeaway"] == ""


async def test_a_run_past_its_limit_is_interrupted_and_errors(term, monkeypatch):
    monkeypatch.setattr(notebook, "CHAT_EXEC_TIMEOUT", 1.0)
    cid = card_id(await call(term, "add_card", kind="code", question="Slow", code="import time\ntime.sleep(30)"))
    assert notebook.get_cell(CORPUS, cid)["run"]["default_timeout_s"] == 1.0
    done = run(term, "card", cid, timeout=60)
    assert done.returncode == 1
    cell = notebook.get_cell(CORPUS, cid)
    names = [b[notebook.ERROR_MIME]["ename"] for b in cell["outputs"] if notebook.ERROR_MIME in b]
    assert names[:2] == ["TimeoutError", "KeyboardInterrupt"] and cell["status"] == "error"
    assert cell["outputs"][0][notebook.ERROR_MIME]["timeout_s"] == 1.0


async def test_the_shim_never_runs_card_code_in_terminal_mode(term):
    with pytest.raises(notebook.TerminalRun):
        await notebook.run_code(CORPUS, "print(1)", created_by="test")
    trial = await notebook.trial_run(CORPUS, card_id(await call(term, "add_card", question="q", code="print(1)")), "1")
    assert trial["status"] == "error", "the card check keeps no code fix it could not run"


async def test_a_code_label_runs_through_thimble_run_and_its_readers_go_stale(term):
    rule = "def label(u):\n    return 'long' if len(str(u)) > 300 else 'short'"
    res = await call(term, "apply_label", scope="files", name="long", predicate={"kind": "code", "text": rule},
                     paths=["agents/*.jsonl"], values=["long", "short"])
    assert not res["is_error"], text(res)
    lid = re.search(r"concept:([A-Za-z0-9_-]+)", text(res)).group(1)
    assert cardrun.command("label", lid) in text(res) and "applied label" not in text(res)
    from app import concepts

    assert concepts.read_concept(config.workspace_dir(CORPUS), lid)["applications"] == [], "nothing ran in the shim"
    done = run(term, "label", lid)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "applied label long" in done.stdout and "long 22, short 38" in done.stdout
    assert concepts.read_concept(config.workspace_dir(CORPUS), concepts.PENDING_RUN) is None
    assert concepts.PENDING_RUN not in concepts.read_concept(config.workspace_dir(CORPUS), lid)
    # a card reads it; a regex label of the same name changes it, and the shim names the card as stale
    cid = card_id(await call(term, "add_card", kind="code", question="How many long?",
                             code="import thimble\nprint(len(thimble.labels('long')))"))
    assert run(term, "card", cid).returncode == 0
    res = await call(term, "apply_label", scope="files", name="long", predicate={"kind": "regex", "text": "Bash"},
                     paths=["agents/*.jsonl"], values=["long", "short"])
    assert f"[[card:{cid}]]" in text(res) and cardrun.command("stale") in text(res), text(res)
    await call(term, "edit_card", card=cid, takeaway="Some records are long.")  # a takeaway the new output leaves behind
    done = run(term, "stale")
    assert done.returncode == 0 and f"[[card:{cid}]]" in done.stdout, done.stdout + done.stderr
    now = re.search(r": long (\d+)", text(res)).group(1)
    assert now != "22" and notebook.get_cell(CORPUS, cid)["outputs"][0]["text/plain"].strip() == now
    assert "no card reads a label that changed" in run(term, "stale").stdout


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


async def test_the_watch_ends_a_run_whose_process_is_gone(term):
    cid = card_id(await call(term, "add_card", question="q", code="print(1)"))
    ws = config.workspace_dir(CORPUS)
    with notebook.editing(ws):
        nb, cell = notebook._locate(ws, cid)
        cell["status"] = "running"
        cell["run"] = {**cell["run"], "state": "running", "pid": 12345}
        notebook.write_notebook(ws, nb)
    # a run whose process holds its run lock is left alone, whatever its pid says (main's sandbox has its own pids)
    holder = subprocess.Popen([sys.executable, "-c", (
        f"import sys; sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r})\n"
        "from pathlib import Path\nfrom app import cardrun\n"
        f"cardrun.hold_run(Path({str(ws)!r}), {cid!r})\nprint('held', flush=True)\nimport time; time.sleep(30)")],
        stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "held"
        cardrun.CardWatch(CORPUS).look()
        assert notebook.get_cell(CORPUS, cid)["status"] == "running"
    finally:
        holder.kill()
        holder.wait()
    cardrun.CardWatch(CORPUS).look()
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["status"] == "error" and cell["run"]["state"] == "done"
    assert cell["outputs"][0][notebook.ERROR_MIME]["ename"] == cardrun.DEAD_ENAME


async def test_thimble_run_refuses_a_browser_mode_workspace_and_a_missing_card(term):
    assert "no card:nope" in run(term, "card", "nope").stdout
    _mode("browser")
    cid = notebook.insert_cell(CORPUS, notebook.create_notebook(config.workspace_dir(CORPUS), "G")["id"],
                               notebook.new_cell("code", "test", "q", code="print(1)"))["id"]
    refused = run(term, "card", cid)
    assert refused.returncode == 1 and "browser mode" in refused.stdout
    assert run(term).returncode == 2


def test_write_dirs_are_the_folders_a_run_writes(term):
    ws = config.workspace_dir(CORPUS)
    assert cardrun.write_dirs(CORPUS) == [ws / "notebooks", ws / "notebooks" / "outputs", ws / "labels", ws / "concepts",
                                          ws / "card-runs", ws / "scratch"]


async def test_a_card_type_card_draws_the_same_in_both(workspaces_tmp, tmp_path, monkeypatch):
    """A card of a card type (thimble.card) run by thimble-run stores what a kernel run stores; the shim refreshed the
    types before it gave the command."""
    from app import cardtypes, extensions

    d = tmp_path / "data" / "crew"
    d.mkdir(parents=True)
    rows = [{"page": f"p{i % 4}", "user": f"bot{i % 35}", "ts": f"2026-04-14T{i // 60:02d}:{i % 60:02d}:00Z",
             "text": f"Relay from bot{(i + 1) % 35}: the value is {i}."} for i in range(140)]
    (d / "saves.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (d / "manifest.json").write_text(json.dumps({"name": "crew", "description": "a swarm"}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    monkeypatch.setenv("THIMBLE_DATA_DIR", str((tmp_path / "data").resolve()))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    extensions.add("swarm-orient", yes=True, say=lambda _: None)
    await extensions.refresh("crew", wait=10)
    await cardtypes.refresh("crew", warm=False)
    code = ("import thimble\nthimble.card('multiagent-swimlane', actions=[{'ref': 'saves.jsonl#L9', 'summary': 'Relayed 8'},"
            " {'ref': 'saves.jsonl#L2', 'summary': 'Relayed 1'}])")
    ws = config.workspace_dir("crew")
    (ws / "trusted").mkdir(exist_ok=True)
    try:
        ran = await notebook.run_code("crew", code, created_by="test", title="swim", kind="plot")
    finally:
        await notebook.shutdown_all()
    kernel = notebook.get_cell("crew", ran["id"])
    assert kernel["status"] == "ok" and cardtypes.CARD_MIME in kernel["outputs"][0], kernel["outputs"]
    (ws / "trusted" / "launch.json").write_text(json.dumps({"mode": "terminal"}))
    try:
        res = await local.call("add_card", {"kind": "plot", "question": "swim", "code": code}, cwd=str(d))
        cid = card_id(res)
        done = run(d.resolve(), "card", cid)
        assert done.returncode == 0, done.stdout + done.stderr
        assert _comparable(notebook.get_cell("crew", cid)["outputs"]) == _comparable(kernel["outputs"])
    finally:
        cardrun.CardWatch.stop_all()
        local._started.clear()
