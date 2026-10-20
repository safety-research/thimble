"""Focused tests of tracing forward (kernel/trace.py): what uses a row or a value (queries, objects, cited answers), who
read and who copied a passage across transcripts, and where a transcript's line came from.
Run: THIMBLE_PYTHON-or-any-python-with-pandas -m pytest lean/tests"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import objects as O  # noqa: E402
from kernel import query as Q  # noqa: E402
from kernel import trace as T  # noqa: E402
from kernel.store import Store  # noqa: E402

PURPOSE = ["links", "links", "message", "test", "message", "links", "message", "links"]


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "wiki"
    d.mkdir()
    with open(d / "saves.jsonl", "w") as f:
        for i, p in enumerate(PURPOSE):
            f.write(json.dumps({"id": i, "kind": p, "body": f"save {i}"}) + "\n")
    (d / "pages.jsonl").write_text(json.dumps({"page": "a"}) + "\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "sess-0001")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    return d


def _answer(tmp: Path, session: str, texts: list[str]) -> None:
    p = tmp / "cc" / "projects" / "-wiki" / f"{session}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    recs = [{"type": "user", "isMeta": True, "message": {"role": "user", "content": [{"type": "text", "text": "a skill's text"}]}}]
    for t in texts:
        recs.append({"type": "user", "message": {"role": "user", "content": "a question"}})
        recs.append({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": t}]},
                     "timestamp": "2026-10-18T10:00:00Z"})
    p.write_text("\n".join(json.dumps(r) for r in recs) + "\n")


def test_intervals_and_overlap() -> None:
    a = T.intervals(["s.jsonl#L1-3,7", "s.jsonl#L4", "t.jsonl#L9.b2", "x.csv#row=2-5", "notes.md"])
    assert a[("s.jsonl", "L")] == [(1, 4), (7, 7)]
    assert a[("t.jsonl", "L")] == [(9, 9)]  # a block counts as its record
    assert ("notes.md", "L") not in a
    assert T.overlap(a, T.intervals(["s.jsonl#L3-8"])) == 3
    assert T.overlap(a, T.intervals(["x.csv#row=5-9", "t.jsonl#L9"])) == 2
    assert T.overlap(a, T.intervals(["y.jsonl#L1"])) == 0


def test_uses_of_a_row_and_of_a_value(root: Path, tmp_path: Path) -> None:
    st = Store(root)
    q1 = Q.run(st, "kind per save", 'df = load("saves.jsonl")\nkeep("kind", df[["_ref", "_file", "kind"]])\ntally(df, "kind")')
    q2 = Q.run(st, "saves per kind", 'tally(use("kind"), "kind")')
    assert not q1["error"] and not q2["error"]
    O.save(st, "uses", {"title": "Uses", "data": {"kinds": "r2", "example": {"ref": "saves.jsonl#L3", "quote": "save 2"}},
                        "text": "Messages: [3](r2#kind=message@n)."})
    _answer(tmp_path, "sess-0001", ["Of 8 saves, [3](r2#kind=message@n) are messages.", "| links | [4](r2#kind=links@n) |"])

    # a row: the query rows that rest on it, the object's value and citation, the answer whose value rests on it
    u = T.uses(st, "saves.jsonl#L3")
    assert [(q["id"], q["rows"][0]["key"]) for q in u["queries"]] == [("r1", {"kind": "message"}), ("r2", {"kind": "message"})]
    (o,) = u["objects"]
    assert {a["at"] for a in o["at"]} >= {"/kinds/1", "/example"}
    assert [a["turn"] for a in u["answers"]] == [1]
    assert "3 are messages" in u["answers"][0]["text"]

    # a value: who binds it, cites it, and builds on its query; not the rows of other values
    u = T.uses(st, "r2#kind=message@n")
    assert u["objects"][0]["id"] == "01-uses"
    assert [a["turn"] for a in u["answers"]] == [1]
    assert T.uses(st, "r2#kind=links@n")["answers"][0]["text"] == "links · 4"  # a table row reads as its cells
    u = T.uses(st, "r1")
    assert [q["id"] for q in u["queries"]] == ["r2"] and "kind" in u["queries"][0]["how"]

    # the object's value is the same value as the query row it is bound to
    u = T.uses(st, "obj:uses#/kinds/1/n")
    assert [a["turn"] for a in u["answers"]] == [1]
    assert any(a.get("cites", "").startswith("r2#kind=message") for a in u["objects"][0]["at"])


def test_trace_back_names_the_label_and_the_files_not_behind_it(root: Path) -> None:
    st = Store(root)
    Q.run(st, "kind per save", 'df = load("saves.jsonl")\nkeep("kind", df[["_ref", "_file", "kind"]])\ntally(df, "kind")')
    Q.run(st, "saves per kind", 'tally(use("kind"), "kind")')
    r = T.trace(st, "r2#kind=links@n", answers=False)
    assert r["label"] == "links"
    step = next(s for s in r["back"]["chain"] if s["step"] == "query")
    assert step["upstream"][0]["query"] == "r1" and step["upstream"][0]["name"] == "kind"
    assert r["back"]["count"] == 4
    assert r["files"]["used"] == ["saves.jsonl"] and r["files"]["not_used"] == ["pages.jsonl"]
    text = T.text_of(r)
    assert "uses 'kind', kept by r1" in text and "not behind it: 1 other file here: pages.jsonl" in text


def _agent(d: Path, name: str, records: list[tuple[str, ...]]) -> None:
    """records: (time, role, text[, command]); role 'read' is a tool result (of `command`, a tool call one line up,
    when given), 'wrote' a tool call, 'said' the agent's words."""
    lines = [{"type": "system", "subtype": "init", "session_id": name}]
    for i, (t, role, text, *cmd) in enumerate(records):
        if role == "read":
            if cmd:
                lines.append({"type": "assistant", "timestamp": t, "message": {"role": "assistant", "content": [
                    {"type": "tool_use", "id": f"c{i}", "name": "Bash", "input": {"command": cmd[0]}}]}})
            lines.append({"type": "user", "timestamp": t, "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": f"c{i}", "content": text}]}})
        elif role == "wrote":
            lines.append({"type": "assistant", "timestamp": t, "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": "x", "name": "Bash", "input": {"command": text}}]}})
        else:
            lines.append({"type": "assistant", "timestamp": t, "message": {"role": "assistant", "content": [
                {"type": "text", "text": text}]}})
    (d / f"{name}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n")


@pytest.fixture()
def swarm(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "run"
    (d / "agents").mkdir(parents=True)
    a = d / "agents"
    note = "Stuck on types? add `# type: ignore` to unblock and move on"
    _agent(a, "a07", [("2026-01-01T09:40:00Z", "read", "mypy: 14 errors in shop/cart.py"),
                      ("2026-01-01T09:42:00Z", "wrote", f"echo '{note}' >> SCRATCHPAD.md")])
    _agent(a, "a31", [("2026-01-01T10:03:00Z", "read", f"SCRATCHPAD.md:\n{note}", "cat SCRATCHPAD.md"),
                      ("2026-01-01T10:11:00Z", "wrote", "sed -i 's/x = y/x = cast(Foo, y)  # type: ignore/' pricing.py")])
    _agent(a, "a12", [("2026-01-01T10:05:00Z", "read", f"SCRATCHPAD.md:\n{note}"),
                      ("2026-01-01T10:20:00Z", "said", "I will fix the types properly instead.")])
    _agent(a, "a40", [("2026-01-01T10:06:00Z", "said", "Reading the code first.")])
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "sess-0002")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    return d


def test_spread_finds_the_origin_the_copies_and_who_held_out(swarm: Path) -> None:
    st = Store(swarm)
    files = sorted(str(p.relative_to(swarm)) for p in (swarm / "agents").glob("*.jsonl"))
    sp = T.spread(st, "# type: ignore", files)
    assert sp["origin"]["agent"] == "a07" and sp["origin"]["first_wrote"]["ref"] == "agents/a07.jsonl#L3.b0"
    assert [e["agent"] for e in sp["copied"]] == ["a31"]
    assert "cast(Foo, y)" in sp["copied"][0]["lines"][0]
    assert [e["agent"] for e in sp["held_out"]] == ["a12"]
    assert sp["never"] == ["a40"] and sp["read"] == 2
    # matching folds case and whitespace
    assert T.spread(st, "#  TYPE: Ignore", files)["origin"]["agent"] == "a07"


def test_copied_from_follows_a_line_back_to_the_note_and_its_writer(swarm: Path) -> None:
    st = Store(swarm)
    cf = T.copied_from(st, "agents/a31.jsonl#L4.b0")
    assert cf["agent"] == "a31"
    src = cf["sources"][0]
    assert "# type: ignore" in src["passage"] and src["from"] == "agents/a31.jsonl#L3.b0"
    assert src["via"] == "Bash: cat SCRATCHPAD.md"  # what the read was the result of
    r = T.trace(st, "agents/a31.jsonl#L4.b0", answers=False)
    assert r["copied_from"]["sources"][0]["origin"]["agent"] == "a07"
    assert r["spread"]["origin"]["agent"] == "a07" and r["spread"]["within"] == "agents/"
    text = T.text_of(r)
    assert "a07 wrote them first" in text and "copied  a31" in text and "never read: a40" in text


def test_a_line_shares_nothing_with_what_it_read(swarm: Path) -> None:
    st = Store(swarm)
    cf = T.copied_from(st, "agents/a40.jsonl#L2.b0")
    assert cf["sources"] == []
    assert "its own words" in T.text_of(T.trace(st, "agents/a40.jsonl#L2.b0", answers=False))


def test_words_of_a_board_post_spread_through_the_transcripts_beside_it(swarm: Path) -> None:
    (swarm / "board.jsonl").write_text(json.dumps({"author": "a07", "body": "add `# type: ignore` to unblock"}) + "\n")
    st = Store(swarm)
    r = T.trace(st, "board.jsonl#L1", text="# type: ignore", answers=False)
    assert r["back"]["chain"][0]["step"] == "source"
    assert r["spread"]["files"] == 4 and r["spread"]["within"] == "agents/"
    assert r["spread"]["origin"]["agent"] == "a07" and [e["agent"] for e in r["spread"]["copied"]] == ["a31"]
