"""A label notice's Run again on these N from the terminal after the press (bug hunt E8): `thimble act label-run` with
`again` runs in thimble's server (local.SERVER_RUNS, term_acts.py), where main's session's module takes the classifier's
calls, not in the command's own process, where it ended at once with "no Claude Code session runs thimble in this
folder". The run keeps the scope the label ran `within`; a run again that fails leaves the run it ran again for as the
label's last run, and a later run that labels every unit takes the failure's notice away.

The classifier is scripted at concepts.classify_structured: it answers only "in the server" (the server's act route,
called in this process for `thimble act`'s post) and while main's module is up, and gives no value to the refs in
`drop`."""
from __future__ import annotations

import json
import re

import pytest

from app import call_result as model_mod
from app import concepts, config, events, local, notices, refs, term_acts

CORPUS = "mini"
PATTERN = r"(?i)forge pr claim"  # 3 of the 8 board posts match
KW = dict(scope="files", values=None, paths=["board.jsonl"], limit=None, comment=False, filter=False,
          created_by="test", chat=None, group=None, card=False)


@pytest.fixture(autouse=True)
def _clean_state(workspaces_tmp):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()


class Classify:
    def __init__(self):
        self.where = {"server": True, "module": True}
        self.drop: set[str] = set()
        self.asked: list[str] = []

    async def __call__(self, c, concept, items, comment=True, on_retry=None):
        if not (self.where["server"] and self.where["module"]):
            return model_mod.CallResult(status="no_session", detail=model_mod.NO_SESSION)
        self.asked += [r for r, _t in items]
        if any(r in self.drop for r, _t in items):
            return model_mod.CallResult(status="refused", detail="Claude's safeguards refused the request", attempts=1)
        return model_mod.CallResult(status="ok", output={"labels": [{"i": n, "label": "no", "confidence": 0.9}
                                                                    for n, _ in enumerate(items, 1)]}, attempts=1)


def _kept() -> list[str]:
    rx, out = re.compile(PATTERN), []
    for i, line in enumerate((config.corpus_dir(CORPUS) / "board.jsonl").read_text("utf-8").splitlines(), 1):
        if rx.search("\n\n".join(b["text"] for b in refs.record_blocks(json.loads(line), "board"))):
            out.append(f"board.jsonl#L{i}")
    return out


async def test_run_again_from_the_terminal_after_the_press_runs_in_the_server_and_keeps_within(monkeypatch):
    classify = Classify()
    monkeypatch.setattr(concepts, "classify_structured", classify)
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 1)
    monkeypatch.setattr(events, "post", lambda *a, **k: {"id": "e1", "delivered": 1})
    posted: list[str] = []

    def post_to_server(c, kind, payload, timeout=local.SERVER_ACT_TIMEOUT_S):
        """thimble's server, in this process: its act route runs the act with main's module in reach."""
        import asyncio

        posted.append(kind)
        classify.where["server"] = True
        try:
            return asyncio.run(term_acts.act_route(c, term_acts.ActBody(kind=kind, payload=payload)))
        finally:
            classify.where["server"] = False

    monkeypatch.setattr(local, "_post_to_server", post_to_server)
    monkeypatch.setattr(local, "transport", lambda c, sid=None: local.SERVER)

    # a prompt label within a regex label's 3 posts, which gives 2 of them no value
    await concepts.apply_scoped(CORPUS, name="claims a PR", kind="regex", text=PATTERN, **KW)
    await concepts.wait_apply(CORPUS, concepts.find_concept(config.workspace_dir(CORPUS), "claims a PR")["id"], 60)
    kept = _kept()
    classify.drop = set(kept[:2])
    s = await concepts.apply_scoped(CORPUS, name="asks for review", kind="prompt", text="The post asks for a review.",
                                    within={"label": "claims a PR"}, **KW)
    cid = s["concept"]
    await concepts.wait_apply(CORPUS, cid, 60)
    ws = config.workspace_dir(CORPUS)
    first = concepts.read_concept(ws, cid)["applications"][-1]
    assert (first["matched_total"], first["failed"], first["status"]) == (3, 2, "done"), first
    classify.where["server"] = False  # from here, this process is `thimble act`'s, which reaches no module

    def last() -> dict:
        return concepts.read_concept(ws, cid)["applications"][-1]

    def notice() -> dict | None:
        return next((n for n in notices.open_notices(CORPUS) if n.get("key") == f"label:{cid}"), None)

    # main's session is gone: the run again fails, and the label's last run stays the one it ran again for
    classify.where["module"] = False
    with pytest.raises(local.StateError, match="cannot run"):
        await local.act(CORPUS, "label-run", {"label": cid, "again": True}, session="s-heron")
    assert posted == ["label-run"]
    run = last()
    assert (run["status"], run["matched_total"], run["within"], run["failed"]) == ("done", 3, first["within"], 2), run
    assert run["again"]["status"] == "error" and "cannot run" in run["again"]["message"], run
    assert "failed" in (notice() or {}).get("text", ""), notice()

    # with main's module up, the notice's Run again from the terminal labels the 2 in the server, within the 3
    classify.where["module"] = True
    classify.drop.clear()
    classify.asked.clear()
    out = await local.act(CORPUS, "label-run", {"label": cid, "again": True}, session="s-heron")
    assert out["ok"] and out["via"] == "server" and posted == ["label-run", "label-run"], out
    assert sorted(classify.asked) == sorted(kept[:2])
    run = last()
    assert (run["labeled"], run["failed"], run["matched_total"], run["within"], run["again"]["total"]) == \
        (3, 0, 3, first["within"], 2), run
    assert concepts._runs[(CORPUS, cid)]["matched_total"] == 3  # the run's own record counted the 3, not the board's 8
    assert notice() is None
