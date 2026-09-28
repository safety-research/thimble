"""plugin/viewers/swarm-map, the viewer of the map the orientation's swarm step writes (swarm.json): over its invented
sample it passes the checks a view a session writes must pass, serves the map and a record with the text its save
added, and counts the lines it cannot parse. The sample is copied into a temp DATA_DIR as the corpus `swarm-map`, with
its swarm.json in the corpus folder, where the reader finds it when the view's folder and the workspace hold none."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

from app import config, views

NAME = SLUG = "swarm-map"
LOCATORS = ["revisions.jsonl#L10", "view:swarm-map/agent:qa-bot-3", "view:swarm-map/thread:T2", "view:swarm-map/13-9"]


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    """The kernel's part run in this process, in the corpus folder, its stdout captured as the kernel's would be."""
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the same snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    views._folder_cache.clear()
    monkeypatch.setattr(views, "FOLDER_CACHE_S", 0.0)
    views._memo.clear()
    views._ready.clear()
    yield
    views._memo.clear()
    views._ready.clear()


@pytest.fixture()
async def saved(workspaces_tmp, tmp_path, monkeypatch) -> Path:
    """The sample as the corpus `swarm-map`, the reader run in this process, and the viewer saved as a view of it."""
    d = tmp_path / "data" / NAME
    shutil.copytree(views.EXAMPLES_DIR / NAME / "sample", d)
    (d / "manifest.json").write_text(json.dumps({"name": NAME, "description": "an example's sample"}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    monkeypatch.setattr(views, "_runner", _inproc_run)
    views._bind_loop()
    src = views.EXAMPLES_DIR / NAME
    raw = json.loads((src / "view.json").read_text("utf-8"))
    views.write_view(NAME, SLUG, reader=(src / "reader.py").read_text("utf-8"), html=(src / "view.html").read_text("utf-8"),
                     **{k: raw[k] for k in ("name", "why", "claims", "accepts", "declares", "default", "libs")})
    yield d
    sys.modules.pop("thimble_view_swarm_map", None)


async def test_the_viewer_answers_the_checks_over_its_sample_and_counts_a_torn_line(saved, tmp_path, monkeypatch):
    async def no_page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 0, "records": 1} for _ in states]

    monkeypatch.setattr(views, "shoot_states", no_page)
    before = (await views.reader_call(NAME, SLUG, "records", {}))["problems"]["count"]
    assert before == 1, "the sample's revisions end in a torn line"
    with (saved / "pages.jsonl").open("a") as f:
        f.write('{"page": "ops/Retro", "wiki": "ops", "revis\n')
    rep = await views.check(NAME, SLUG, LOCATORS, shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    checked = [r["locator"] for r in rep["checks"]]
    assert set(LOCATORS) <= set(checked) and any(c.startswith("pages.jsonl#L") for c in checked)
    assert (await views.reader_call(NAME, SLUG, "records", {}))["problems"]["count"] == before + 1


async def test_the_map_and_a_record_with_the_text_its_save_added(saved):
    m = await views.reader_call(NAME, SLUG, "records", {"op": "map"})
    assert m["total"] == {"agents": 8, "threads": 4, "actions": 14, "links": 15}
    assert [a["id"] for a in m["actions"]] == list(range(1, 15))
    assert sum(a["time"] is None for a in m["actions"]) == 2, "two saves carry no time"
    assert {a["username"]: a["signs_as"] for a in m["agents"]}["flake-hunter"] == ["QA-Night"]
    rec = await views.reader_call(NAME, SLUG, "records", {"op": "record", "ref": m["actions"][3]["ref"]})
    added = [line for hk in rec["hunks"] for line in hk["add"]]
    removed = [line for hk in rec["hunks"] for line in hk["del"]]
    assert added == ["LOCKED by runner-12 (hotfix hf-88)"] and removed == ["LOCKED by runner-07 (nightly build)"]
    assert rec["agents"] == ["runner-12"] and rec["threads"] == ["T2"]
    link = await views.resolve_locator(NAME, SLUG, {"key": "13-9"})
    assert link["label"] == "13→9 · contradicts" and link["target"] == {"link": "13-9"}


async def test_the_viewer_s_page_loads_headless_at_its_first_place(saved, tmp_path):
    """The whole check, the headless page included, where this machine has Node and the frontend's packages with their
    Chromium (scripts/check.sh install)."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)
        pytest.skip(why)
    rep = await views.check(NAME, SLUG, LOCATORS, shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    assert rep["page"]["fetches"] >= 1 and Path(rep["page"]["png"]).is_file()
    assert not views.unmarked(rep["page"]), "the cards carry their records' refs, for the labels"
