#!/usr/bin/env python3
"""tour_example.py: writes the product tour's example data, frontend/src/example/data.json, which the tour's example
panes answer from in its Files and Labels steps (frontend/src/example).

The example folder, fernhill-checkout, is made up here: three Claude Code agents fix a bug in the checkout of Fernhill
Tea, the made-up online tea shop of thimble's terminal tour. Every name, message, number and line of code is made up,
and nothing is random, so each run writes the same data.

  README.md                 what the folder holds
  agents/agent-1.jsonl      the agent that fixes the bug
  agents/agent-2.jsonl      the agent that writes the test
  agents/agent-3.jsonl      the agent that reviews the fix
  board.jsonl               the messages the agents send each other
  shop/checkout.py          the checkout's code after the fix

The folder is written to a temporary folder and read with the server's own code, in this process (no port): every
answer the panes read about a file (folder listings, pages, keys, events), and the label "what the step does", made by
the label routes with the classifier standing in for Claude, so no model is called: each record gets its value from
VALUES. Times, ids and folder stamps of the run are the example's own, so nothing names the machine it ran on.

Usage, with the server's venv:  browser/backend/.venv/bin/python browser/scripts/tour_example.py
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

BROWSER = Path(__file__).resolve().parents[1]
OUT = BROWSER / "frontend" / "src" / "example" / "data.json"
sys.path.insert(0, str(BROWSER / "backend"))

NAME = "fernhill-checkout"
MODEL = "claude-sonnet-5"
DAY = "2026-03-12"
WHEN = f"{DAY}T09:30:00+00:00"  # the label's run, in the example's own morning
LABEL_ID, RUN_ID = "c0ffee01", "c0ffee02"

READ, CHANGE, TESTS, TALK, OTHER = "reads code", "changes code", "runs tests", "talks to other agents", "other"
VALUES = [READ, CHANGE, TESTS, TALK, OTHER]


def _uuid(label: str) -> str:
    h = hashlib.sha256(f"{NAME}:{label}".encode()).hexdigest()[:32]
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def _ts(hms: str, ms: int = 0) -> str:
    return f"{DAY}T{hms}.{ms:03d}Z"


class Agent:
    """One agent's Claude Code transcript, built in line order, with each record's value of the label."""

    def __init__(self, aid: str) -> None:
        self.aid = aid
        self.session = _uuid(f"{aid}:session")
        self.records: list[dict] = []
        self.values: list[str] = []
        self.n_tool = 0

    def _base(self, kind: str, at: str) -> dict:
        return {"type": kind, "uuid": _uuid(f"{self.aid}:{len(self.records) + 1}"), "session_id": self.session, "timestamp": at}

    def _add(self, rec: dict, value: str) -> None:
        self.records.append(rec)
        self.values.append(value)

    def init(self, at: str) -> None:
        self._add({**self._base("system", at), "subtype": "init", "model": MODEL, "tools": ["Bash", "Read", "Edit"],
                   "permissionMode": "default"}, OTHER)

    def prompt(self, text: str, at: str) -> None:
        self._add({**self._base("user", at), "message": {"role": "user", "content": text}}, OTHER)

    def _assistant(self, content: list[dict], at: str, value: str) -> None:
        n = len(self.records) + 1
        msg = {"id": f"msg_{self.aid.replace('-', '')}_{n:02d}", "type": "message", "role": "assistant", "model": MODEL,
               "content": content, "stop_reason": None,
               "usage": {"input_tokens": 4 + n, "output_tokens": 30 + 9 * n, "cache_read_input_tokens": 900 * n}}
        self._add({**self._base("assistant", at), "message": msg, "parent_tool_use_id": None}, value)

    def text(self, text: str, at: str, value: str = OTHER) -> None:
        self._assistant([{"type": "text", "text": text}], at, value)

    def _result(self, tool: str, output: str, done: str, value: str, extra: dict) -> None:
        self._add({**self._base("user", done), "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool, "content": output, "is_error": False}]},
            "parent_tool_use_id": None, "tool_use_result": extra}, value)

    def _tool(self) -> str:
        self.n_tool += 1
        return f"toolu_{self.aid.replace('-', '')}_{self.n_tool:02d}"

    def bash(self, command: str, description: str, output: str, at: str, done: str, value: str) -> None:
        t = self._tool()
        self._assistant([{"type": "tool_use", "id": t, "name": "Bash", "input": {"command": command, "description": description}}], at, value)
        self._result(t, output, done, value, {"stdout": output, "stderr": "", "interrupted": False})

    def read(self, path: str, text: str, at: str, done: str, value: str = READ) -> None:
        t = self._tool()
        self._assistant([{"type": "tool_use", "id": t, "name": "Read", "input": {"file_path": path}}], at, value)
        numbered = "\n".join(f"{i:>6}\t{line}" for i, line in enumerate(text.rstrip("\n").split("\n"), 1))
        self._result(t, numbered, done, value, {"type": "text", "file": {"filePath": path, "content": text}})

    def edit(self, path: str, old: str, new: str, at: str, done: str, value: str = CHANGE) -> None:
        t = self._tool()
        self._assistant([{"type": "tool_use", "id": t, "name": "Edit", "input": {"file_path": path, "old_string": old, "new_string": new}}], at, value)
        self._result(t, f"The file {path} has been updated.", done, value, {"filePath": path, "oldString": old, "newString": new})

    def result(self, text: str, at: str, turns: int, cost: float) -> None:
        self._add({**self._base("result", at), "subtype": "success", "is_error": False, "duration_ms": 61_000 * turns,
                   "num_turns": turns, "result": text, "stop_reason": "end_turn", "total_cost_usd": cost,
                   "usage": {"input_tokens": 120 * turns, "output_tokens": 410 * turns}}, OTHER)


# --------------------------------------------------------------------------- the shop's code

CHECKOUT_BEFORE = '''\
"""The checkout: what an order costs."""
from shop.prices import GIFT_BOX_FEE, MEMBER_DISCOUNT
from shop.tax import with_tax


def order_total(items, gift_box=False, member=False):
    """The total of an order in dollars, tax included."""
    total = sum(item.price * item.quantity for item in items)
    if gift_box:
        total += GIFT_BOX_FEE
    if member:
        total -= total * MEMBER_DISCOUNT
    return with_tax(round(total, 2))
'''

CHECKOUT_AFTER = '''\
"""The checkout: what an order costs."""
from shop.prices import GIFT_BOX_FEE, MEMBER_DISCOUNT
from shop.tax import with_tax


def order_total(items, gift_box=False, member=False):
    """The total of an order in dollars, tax included. The member discount is
    taken off the tea alone: the gift box fee is added after it."""
    total = sum(item.price * item.quantity for item in items)
    if member:
        total -= total * MEMBER_DISCOUNT
    if gift_box:
        total += GIFT_BOX_FEE
    return with_tax(round(total, 2))
'''

PRICES = '''\
"""Prices that are the same for every order."""
GIFT_BOX_FEE = 6.00
MEMBER_DISCOUNT = 0.10
'''

TAX = '''\
"""Sales tax, added to the whole order."""
TAX_RATE = 0.0


def with_tax(amount):
    return round(amount * (1 + TAX_RATE), 2)
'''

TEST_BEFORE = '''\
from shop.checkout import order_total
from tests.helpers import Item


def test_plain_order():
    assert order_total([Item(price=12.0, quantity=2)]) == 24.0


def test_member_order():
    assert order_total([Item(price=48.0, quantity=1)], member=True) == 43.2
'''

TEST_ADDED = '''

def test_gift_box_member_total():
    # a member pays 48.00 less 10% for the tin, then 6.00 for the gift box
    assert order_total([Item(price=48.0, quantity=1)], gift_box=True, member=True) == 49.2
'''

DIFF = '''\
--- a/shop/checkout.py
+++ b/shop/checkout.py
@@ -5,9 +5,10 @@
 def order_total(items, gift_box=False, member=False):
-    """The total of an order in dollars, tax included."""
+    """The total of an order in dollars, tax included. The member discount is
+    taken off the tea alone: the gift box fee is added after it."""
     total = sum(item.price * item.quantity for item in items)
-    if gift_box:
-        total += GIFT_BOX_FEE
     if member:
         total -= total * MEMBER_DISCOUNT
+    if gift_box:
+        total += GIFT_BOX_FEE
     return with_tax(round(total, 2))
'''

PYTEST_FAIL = '''\
..F.....                                                                 [100%]
=================================== FAILURES ===================================
__________________________ test_gift_box_member_total __________________________

    def test_gift_box_member_total():
        # a member pays 48.00 less 10% for the tin, then 6.00 for the gift box
>       assert order_total([Item(price=48.0, quantity=1)], gift_box=True, member=True) == 49.2
E       assert 48.6 == 49.2
E        +  where 48.6 = order_total([Item(price=48.0, quantity=1)], gift_box=True, member=True)

tests/test_checkout.py:14: AssertionError
=========================== short test summary info ============================
FAILED tests/test_checkout.py::test_gift_box_member_total - assert 48.6 == 49.2
1 failed, 7 passed in 0.21s'''

PYTEST_PASS = '''\
........                                                                 [100%]
8 passed in 0.19s'''


# --------------------------------------------------------------------------- the agents

def agent_1() -> Agent:
    a = Agent("agent-1")
    a.init(_ts("09:02:10", 104))
    a.prompt("You are agent-1 at Fernhill Tea, a small online tea shop. Customers say the checkout charges the wrong "
             "total when an order has a gift box. Find the bug and fix it. agent-2 writes a test for it and agent-3 "
             "reviews your change. Use the `board` command to talk to them.", _ts("09:02:10", 151))
    a.text("I will read the board first, then the checkout code.", _ts("09:02:14", 520))
    a.bash("board read", "Read the team's messages",
           "#1 agent-3 (09:02): I can review as soon as there is a change.\n"
           "#2 agent-2 (09:03): I will write a test for gift box orders.", _ts("09:03:15", 330), _ts("09:03:16", 12), TALK)
    a.read("shop/checkout.py", CHECKOUT_BEFORE, _ts("09:03:40", 205), _ts("09:03:40", 611))
    a.text("The total adds the gift box fee before it takes the member discount off, so a member also gets 10% off "
           "the fee. The fee should be added after the discount.", _ts("09:04:22", 917), READ)
    a.read("shop/prices.py", PRICES, _ts("09:04:30", 140), _ts("09:04:30", 402))
    a.bash("pytest tests/test_checkout.py -q", "Run the checkout tests", PYTEST_FAIL, _ts("09:07:31", 66),
           _ts("09:07:33", 870), TESTS)
    a.edit("shop/checkout.py", "    if gift_box:\n        total += GIFT_BOX_FEE\n    if member:\n        total -= total * MEMBER_DISCOUNT\n",
           "    if member:\n        total -= total * MEMBER_DISCOUNT\n    if gift_box:\n        total += GIFT_BOX_FEE\n",
           _ts("09:09:02", 458), _ts("09:09:02", 790))
    a.bash("pytest tests/test_checkout.py -q", "Run the checkout tests again", PYTEST_PASS, _ts("09:09:20", 313),
           _ts("09:09:21", 940), TESTS)
    a.bash('board post "Fixed the gift box total in shop/checkout.py: the fee now comes after the member discount. '
           'agent-3, could you review?"', "Tell the team the fix is ready", "posted #4", _ts("09:11:12", 25),
           _ts("09:11:12", 301), TALK)
    a.bash("board read --since 4", "Read new messages",
           "#5 agent-3 (09:13): Looks right. One question: is the fee taxed?", _ts("09:13:52", 776), _ts("09:13:53", 90), TALK)
    a.read("shop/tax.py", TAX, _ts("09:14:10", 512), _ts("09:14:10", 830))
    a.bash('board post "The fee is taxed with the order, as before. Nothing else changes."', "Answer agent-3",
           "posted #6", _ts("09:15:02", 118), _ts("09:15:02", 420), TALK)
    a.text("Done. The checkout now adds the gift box fee after the member discount, and all 8 checkout tests pass.",
           _ts("09:18:44", 233))
    a.result("Fixed the gift box total: the member discount is taken off before the gift box fee is added.",
             _ts("09:18:45", 9), 12, 0.31)
    return a


def agent_2() -> Agent:
    a = Agent("agent-2")
    a.init(_ts("09:02:12", 640))
    a.prompt("You are agent-2 at Fernhill Tea, a small online tea shop. The checkout charges the wrong total when an "
             "order has a gift box. Write a test that shows the bug, so agent-1 can check the fix. Use the `board` "
             "command to talk to the others.", _ts("09:02:12", 700))
    a.text("I will tell the others what I am doing, then read the checkout tests.", _ts("09:02:58", 31))
    a.bash('board post "I will write a test for gift box orders."', "Tell the team", "posted #2", _ts("09:03:05", 210),
           _ts("09:03:05", 488), TALK)
    a.read("tests/test_checkout.py", TEST_BEFORE, _ts("09:03:30", 92), _ts("09:03:30", 377))
    a.read("shop/checkout.py", CHECKOUT_BEFORE, _ts("09:04:01", 653), _ts("09:04:01", 905))
    a.edit("tests/test_checkout.py", "    assert order_total([Item(price=48.0, quantity=1)], member=True) == 43.2\n",
           "    assert order_total([Item(price=48.0, quantity=1)], member=True) == 43.2\n" + TEST_ADDED,
           _ts("09:05:47", 120), _ts("09:05:47", 431))
    a.bash("pytest tests/test_checkout.py -q", "Run the checkout tests", PYTEST_FAIL, _ts("09:06:10", 856),
           _ts("09:06:12", 701), TESTS)
    a.text("The new test fails as it should: a member pays 48.60 for a 48.00 tin in a gift box, and should pay 49.20.",
           _ts("09:06:30", 18), TESTS)
    a.bash('board post "Test added: test_gift_box_member_total fails on main. agent-1, it should pass once the fee '
           'comes after the discount."', "Tell agent-1 about the test", "posted #3", _ts("09:06:40", 77),
           _ts("09:06:40", 350), TALK)
    a.text("Done. The test is in tests/test_checkout.py.", _ts("09:06:52", 640))
    a.result("Added test_gift_box_member_total, which fails until the gift box fee comes after the member discount.",
             _ts("09:06:53", 12), 7, 0.12)
    return a


def agent_3() -> Agent:
    a = Agent("agent-3")
    a.init(_ts("09:02:20", 3))
    a.prompt("You are agent-3 at Fernhill Tea, a small online tea shop. agent-1 is fixing the total the checkout "
             "charges for orders with a gift box. Review the change when it is ready. Use the `board` command to talk "
             "to the others.", _ts("09:02:20", 45))
    a.bash('board post "I can review as soon as there is a change."', "Tell the team", "posted #1", _ts("09:02:31", 600),
           _ts("09:02:31", 914), TALK)
    a.bash("board read --wait", "Wait for a message",
           "#2 agent-2 (09:03): I will write a test for gift box orders.\n"
           "#3 agent-2 (09:06): Test added: test_gift_box_member_total fails on main.\n"
           "#4 agent-1 (09:11): Fixed the gift box total in shop/checkout.py: the fee now comes after the member "
           "discount. agent-3, could you review?", _ts("09:02:40", 70), _ts("09:11:13", 2), TALK)
    a.bash("git diff main -- shop/checkout.py", "Show the change", DIFF, _ts("09:12:05", 349), _ts("09:12:05", 512), READ)
    a.read("shop/tax.py", TAX, _ts("09:13:01", 761), _ts("09:13:02", 33))
    a.bash('board post "Looks right. One question: is the fee taxed?"', "Ask agent-1", "posted #5", _ts("09:13:48", 220),
           _ts("09:13:48", 517), TALK)
    a.bash("pytest -q", "Run every test", "......................                                   [100%]\n22 passed in 0.48s",
           _ts("09:15:40", 188), _ts("09:15:41", 2), TESTS)
    a.bash('board post "Approved. All tests pass."', "Approve the change", "posted #7", _ts("09:17:30", 404),
           _ts("09:17:30", 690), TALK)
    a.result("Reviewed agent-1's fix to the gift box total and approved it.", _ts("09:17:31", 5), 8, 0.09)
    return a


BOARD = [
    (1, "agent-3", _ts("09:02:31", 914), "I can review as soon as there is a change."),
    (2, "agent-2", _ts("09:03:05", 488), "I will write a test for gift box orders."),
    (3, "agent-2", _ts("09:06:40", 350), "Test added: test_gift_box_member_total fails on main. agent-1, it should pass "
                                         "once the fee comes after the discount."),
    (4, "agent-1", _ts("09:11:12", 301), "Fixed the gift box total in shop/checkout.py: the fee now comes after the "
                                         "member discount. agent-3, could you review?"),
    (5, "agent-3", _ts("09:13:48", 517), "Looks right. One question: is the fee taxed?"),
    (6, "agent-1", _ts("09:15:02", 420), "The fee is taxed with the order, as before. Nothing else changes."),
    (7, "agent-3", _ts("09:17:30", 690), "Approved. All tests pass."),
]

README = """\
# Fernhill Tea: three agents fix the checkout

Example data for thimble's tour. Fernhill Tea is a made-up online tea shop. Every agent, message and line of code
here is made up.

Customers said the checkout charged the wrong total for an order with a gift box. Three Claude Code agents shared the
work and talked on a message board:

| File | What it holds |
|---|---|
| `agents/agent-1.jsonl` | the agent that found the bug and fixed it |
| `agents/agent-2.jsonl` | the agent that wrote a test for it |
| `agents/agent-3.jsonl` | the agent that reviewed the fix |
| `board.jsonl` | the messages the agents sent each other |
| `shop/checkout.py` | the checkout's code after the fix |

The bug: the checkout added the gift box fee before it took the member discount off, so members also got 10% off
the fee.
"""


def build() -> tuple[dict[str, str], dict[str, list[str]]]:
    """The folder's files by path, and the label's value of each record of each transcript."""
    files: dict[str, str] = {"README.md": README, "shop/checkout.py": CHECKOUT_AFTER}
    values: dict[str, list[str]] = {}
    for path, make in {"agents/agent-1.jsonl": agent_1, "agents/agent-2.jsonl": agent_2, "agents/agent-3.jsonl": agent_3}.items():
        a = make()
        files[path] = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in a.records)
        values[path] = a.values
    files["board.jsonl"] = "".join(json.dumps({"id": i, "from": who, "at": at, "text": text}, ensure_ascii=False) + "\n"
                                   for i, who, at, text in BOARD)
    return files, values


# --------------------------------------------------------------------------- the server's answers

# the server reads its homes and folders from the environment when its modules load; a scan worker that the label's
# run starts loads this file again, and takes this run's temporary folder from the environment too
TMP = Path(os.environ.get("TOUR_EXAMPLE_TMP") or tempfile.mkdtemp(prefix="tour-example-"))
os.environ["TOUR_EXAMPLE_TMP"] = str(TMP)
(TMP / "data").mkdir(exist_ok=True)
os.environ.update({"THIMBLE_SKIP_KEY": "1", "THIMBLE_RENDER": "off", "THIMBLE_CARD_CHECK": "off", "THIMBLE_VIEW_REVIEW": "off",
                   "THIMBLE_PROPOSE_VIEWS": "off", "THIMBLE_FIXES": "off", "THIMBLE_DATA_DIR": str(TMP / "data"),
                   "THIMBLE_HOME": str(TMP / "home"), "THIMBLE_PLUGIN_HOME": str(TMP / "plugin-home"),
                   "THIMBLE_BROWSER_HOME": str(TMP / "browser-home"), "THIMBLE_ALLOWED_HOSTS": "testserver"})


def runs(xs: list) -> list:
    """A long per-bin list as [value, count] pairs (src/example/server.ts reads them back)."""
    out: list = []
    for x in xs:
        if out and out[-1][0] == x:
            out[-1][1] += 1
        else:
            out.append([x, 1])
    return out


def capture() -> dict:
    from fastapi.testclient import TestClient

    from app import claude_access, concepts, config, hook_auth, model
    from app.main import app

    config.WORKSPACES_DIR = TMP / "workspaces"
    # the requests come from this process alone: no browser's sign-in to prove
    hook_auth.write_guarded = lambda method, path: False
    hook_auth.read_guarded = lambda method, path: False
    files, values = build()
    root = TMP / "folders" / NAME
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, "utf-8")
    assert config.register_corpus(root)["name"] == NAME
    client = TestClient(app)

    def get(route: str, ok: bool = True, **params):
        r = client.get(f"/api{route}", params=params)
        assert r.status_code == 200 or not ok, (route, params, r.status_code, r.text[:300])
        return r.json() if r.status_code == 200 else None

    c, ws = f"/corpora/{NAME}", f"/ws/{NAME}"
    out: dict = {"name": NAME, "files": files, "folders": {}, "pages": {}, "lines": {}, "keys": {}, "events": {}}
    for folder in ("", "agents", "shop"):
        out["folders"][folder] = {**get(f"{c}/sources", path=folder or ".", depth=1), "stamp": f"example-{folder or 'root'}"}
    out["stamps"] = {p: f"example-{p if p != '.' else 'root'}" for p in (".", "agents", "shop")}
    for path in files:
        out["pages"][path] = get(f"{c}/source", path=path, start=1, count=500)
        out["lines"][path] = get(f"{c}/source/lines", path=path)
        k = get(f"{c}/source/keys", ok=False, path=path)
        out["keys"][path] = k and {**k, "bytes": runs(k["bytes"]), "keys": [{**key, "at": runs(key["at"])} for key in k["keys"]]}
        out["events"][path] = get(f"{c}/source/events", ok=False, path=path)

    # the label: its run's classifier gives each record its value of VALUES, as Claude would have
    value_of = {f"{p}#L{i}": v for p, vs in values.items() for i, v in enumerate(vs, 1)}

    async def classify(_c, _concept, items, comment=True, on_retry=None):
        return model.CallResult(status="ok", output={"labels": [
            {"i": n, "label": value_of[ref], "confidence": 0.9, "rationale": f"It {value_of[ref]}." if value_of[ref] != OTHER else "None of the others."}
            for n, (ref, _t) in enumerate(items, 1)]})

    concepts.classify_structured = classify
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    config.auth_problem = lambda *a, **kw: None
    r = client.post(f"/api{ws}/concepts", json={"name": "what the step does", "description": "What does this step of the agent do?",
                                                "kind": "prompt", "labels": VALUES, "glob": "agents/*.jsonl", "marks": "record",
                                                "created_by": "main"})
    assert r.status_code == 200, r.text
    kid = r.json()["id"]
    r = client.post(f"/api{ws}/concepts/{kid}/apply", json={"wait": True})
    assert r.status_code == 200, r.text
    detail = get(f"{ws}/concepts/{kid}")
    entry = get(f"{ws}/concepts")[0]
    source = {row["ref"]: row["source"] for p in files for g in get(f"{ws}/labels", path=p) for row in g["rows"]}
    out["concept"] = {**detail, "shown": False}
    out["lastRun"] = entry.get("last_run")
    out["rows"] = [{**row, "source": source[row["ref"]], "ts": WHEN} for row in get(f"{ws}/concepts/{kid}/rows", text=1, limit=500)["rows"]]
    out["coverage"] = get(f"{ws}/concepts/{kid}/coverage")
    out["settings"] = get(f"{ws}/settings")
    out["checks"] = get(f"{ws}/checks")
    out["answerComments"] = get(f"{ws}/answer-comments")
    out["types"] = get(f"{ws}/investigations/main/types")
    return {**out, "_ids": (kid, detail.get("run", {}).get("run_id"))}


def own(v, ids: dict[str, str]):
    """The run's times, ids and paths as the example's own: its times WHEN, its ids LABEL_ID and RUN_ID, and no path
    of the machine (a run's labels file)."""
    if isinstance(v, dict):
        return {k: own(x, ids) for k, x in v.items() if k != "labels_path"}
    if isinstance(v, list):
        return [own(x, ids) for x in v]
    if isinstance(v, str):
        if v in ids:
            return ids[v]
        if re.fullmatch(r"20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00", v) and not v.startswith(DAY):
            return WHEN
    return v


def main() -> None:
    try:
        got = capture()
        kid, run_id = got.pop("_ids")
        data = own(got, {kid: LABEL_ID, **({run_id: RUN_ID} if run_id else {})})
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    assert str(TMP) not in text and str(Path.home()) not in text, "the data names this machine"
    OUT.write_text(text + "\n", "utf-8")
    print(f"wrote {OUT.relative_to(BROWSER.parent)} ({len(text):,} bytes)")


if __name__ == "__main__":
    main()
