"""app.extension_manifest: an extension's JSON files are checked against extension.schema.json and the rules it cannot
state, and each problem names its file and line, so `thimble extension add` can refuse with every problem listed."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from app import config, extension_manifest, extensions

FIXTURE = Path(__file__).parent / "fixtures" / "ext-min"


def _write(root: Path, rel: str, data) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(data if isinstance(data, str) else json.dumps(data, indent=2))


def _problems(root: Path) -> list[str]:
    return [str(p) for p in extension_manifest.check(root)]


def test_the_schema_is_a_json_schema_and_names_every_part():
    from jsonschema import Draft202012Validator

    schema = extension_manifest.schema()
    Draft202012Validator.check_schema(schema)
    assert {"extension", "view", "card", "report", "agent", "task", "check", "subagent"} <= set(schema["$defs"])
    agent = schema["$defs"]["agent"]
    assert {"prompt", "sdk", "command", "replace", "subagents"} <= set(agent["properties"])
    assert "permissionMode" not in agent["properties"] and "hooks" not in agent["properties"]


def test_the_extensions_thimble_ships_and_the_fixture_have_no_problem():
    for d in sorted(p for p in extensions.builtin_dir().iterdir() if (p / "extension.json").is_file()):
        assert _problems(d) == [], d.name
    assert _problems(FIXTURE) == []


def test_a_problem_names_its_file_and_line_and_the_nearest_known_key(tmp_path):
    root = tmp_path / "tally"
    _write(root, "extension.json", {"name": "tally", "version": "0.1.0"})
    _write(root, "views/tally/view.json", '{\n  "description": "Each tally line.",\n  "scopes": ["tally/*.jsonl"]\n}\n')
    _write(root, "views/tally/view.html", "<div></div>")
    assert _problems(root) == ['views/tally/view.json:3  unknown key "scopes". Did you mean "scope"?',
                               'views/tally/view.json:1  needs "scope", since extension.json sets none']
    _write(root, "extension.json", {"name": "tally", "version": "0.1.0", "scope": ["tally/*.jsonl"]})
    _write(root, "views/tally/view.json", {"description": "Each tally line.",
                                           "records": [{"name": "entry", "fields": [{"name": "who", "type": "word"}]}]})
    assert _problems(root) == ['views/tally/view.json:9  "records[0].fields[0].type" is "word". It takes "text", '
                               '"category", "number", "time", "ref", "list"']
    (root / "extension.json").write_text('{"name": "tally",\n "version": 1,}')
    assert _problems(root)[0].startswith("extension.json:2  is not JSON")
    assert extension_manifest.check(tmp_path / "nothing") == [extension_manifest.Problem("extension.json", 0, "is missing")]


def test_an_agent_or_task_is_defined_one_way_with_files_of_its_own(tmp_path):
    root = tmp_path / "ways"
    _write(root, "extension.json", {"name": "ways", "version": "1"})
    _write(root, "agents/critic/agent.json", {"description": "Two critics.", "sdk": "critic.py", "command": ["x"]})
    _write(root, "agents/main/agent.json", {"description": "Mine.", "prompt": "main.md", "replace": True})
    _write(root, "agents/main/main.md", "More.")
    _write(root, "agents/dev/agent.json", {"description": "Mine.", "command": ["python", "dev.py"]})
    _write(root, "agents/orientation/agent.json", {"description": "Reads all.", "prompt": "prompt.md",
                                                   "permissionMode": "bypass",
                                                   "subagents": {"reader": {"description": "Reads.", "prompt": "r.md"}}})
    _write(root, "agents/orientation/prompt.md", "Read {{files}} from {{dir}}; then {{default#Order of work}} {{nope}}")
    _write(root, "agents/planner/agent.json", {"description": "x", "prompt": "p.md"})
    _write(root, "tasks/labels/task.json", {"description": "Three models vote.", "command": ["python", "labels.py"]})
    _write(root, "tasks/labels/fixtures/one.json", "{")
    _write(root, "tasks/summaries/task.json", {"description": "x", "prompt": "p.md"})
    got = _problems(root)
    assert "agents/critic/agent.json:4  takes one of prompt, sdk or command, and it has sdk and command" in got
    assert "agents/main/agent.json:4  main takes a prompt addition only, so it cannot set replace" in got
    assert "agents/dev/agent.json:3  dev takes a prompt only" in got
    assert "agents/orientation/agent.json:4  the permission mode is the analyst's, and an extension cannot set it" in got
    assert any("the subagent \"reader\" names 'r.md'" in x for x in got)
    assert any(x.startswith("agents/orientation/prompt.md:1  {{nope}} is no placeholder") for x in got)
    assert len([x for x in got if x.startswith("agents/orientation/prompt.md")]) == 1
    assert "agents/planner  is no role. The roles are main, orientation, critic, writer, dev" in got
    assert "tasks/summaries  is no task. The tasks are labels, label-draft, card-check, view-review, view-fit, " \
           "file-viewer, checks" in got
    assert any(x.startswith("tasks/labels/fixtures/one.json:1  is not JSON") for x in got)
    assert not any(x.startswith("tasks/labels/task.json") for x in got), "a command names no file of its own"


def test_add_refuses_an_extension_with_problems_and_lists_them_all(tmp_path, workspaces_tmp):
    d = tmp_path / "broken"
    shutil.copytree(FIXTURE, d)
    raw = json.loads((d / "extension.json").read_text())
    (d / "extension.json").write_text(json.dumps({**raw, "name": "broken", "sccope": ["x"]}))
    _write(d, "agents/critic/agent.json", {"description": "Mine."})
    with pytest.raises(extensions.AddError) as got:
        extensions.add(str(d), yes=True, say=lambda _: None)
    text = str(got.value)
    assert 'extension.json:1  unknown key "sccope". Did you mean "scope"?' in text
    assert "agents/critic/agent.json:1  needs one of prompt, sdk or command" in text
    assert not extensions.source_path("broken").exists()


@pytest.fixture()
def corpus(workspaces_tmp, tmp_path, monkeypatch) -> str:
    d = tmp_path / "data" / "kitws"
    d.mkdir(parents=True)
    (d / "notes.jsonl").write_text('{"who": "ana"}\n')
    (d / "manifest.json").write_text(json.dumps({"name": "kitws", "description": "notes"}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    return "kitws"


def test_the_new_layout_gives_roles_tasks_subagents_and_report_types(tmp_path, corpus):
    root = tmp_path / "kit"
    _write(root, "extension.json", {"name": "kit", "version": "1", "description": "A kit.", "python": ["json"]})
    _write(root, "agents/orientation/agent.json", {
        "description": "Reads all.", "prompt": "prompt.md",
        "subagents": {"reader": {"description": "Reads one share.", "prompt": "reader.md", "tools": ["Read"],
                                 "disallowedTools": ["Write"], "maxTurns": 40}}})
    _write(root, "agents/orientation/prompt.md", "Read {{files}} with the reader.")
    _write(root, "agents/orientation/reader.md", "Read the share.")
    _write(root, "agents/critic/agent.json", {"description": "Two critics.", "sdk": "critic.py"})
    _write(root, "agents/critic/critic.py", "async def run(input):\n    return 'ok'\n")
    _write(root, "tasks/labels/task.json", {"description": "Three models vote.", "command": ["python", "labels.py"]})
    _write(root, "reports/one-pager/report.json", {"name": "One pager", "description": "One page.", "viewer": "document"})
    _write(root, "reports/one-pager/report.md", "A one-page brief.")
    _write(root, "reports/one-pager/writer.md", "Lead with the answer.")
    info = extensions.read_extension(root, "kit", set())
    assert info["problems"] == [] and info["python"] == ["json"] and info["description"] == "A kit."
    assert info["orient"] == "agents/orientation/prompt.md" and info["agents"] == ["reader"]
    assert [(r["role"], r["kind"]) for r in info["roles"]] == [("orientation", "prompt"), ("critic", "sdk")]
    assert info["tasks"] == [{"task": "labels", "kind": "command", "description": "Three models vote.", "file": "",
                              "command": ["python", "labels.py"], "replace": False}]
    assert extensions.parts(info) == ["One pager report type", "adds to the orientation", "its own critic, an Agent SDK program",
                                      "reader agent", "its own labels task, a program"]
    lines = "\n".join(extensions.summary(info, {"source": str(root), "kind": "folder"}))
    assert "critic      Two critics. It runs it as an Agent SDK program (critic.py)." in lines
    assert "task        labels: Three models vote. It runs it as a program of its own (python labels.py)." in lines

    assert extensions.add(str(root), yes=True, say=lambda _: None) == ["kit"]
    c = corpus
    await_refresh(c)
    reader = extensions.agent_definitions(c)["reader"]
    assert reader["prompt"] == "Read the share." and reader["tools"] == ["Read"] and reader["maxTurns"] == 40
    assert "Write" in reader["disallowedTools"] and "WebFetch" in reader["disallowedTools"]
    brief = next(t for t in extensions.report_types(c) if t["id"] == "one-pager")
    assert brief["prompt"] == "Lead with the answer.\n\nA one-page brief." and brief["renderer"] == "document"
    row = next(r for r in extensions.public(c)["extensions"] if r["name"] == "kit")
    assert row["description"] == "A kit." and "reader agent" in row["parts"]
    assert row["consent"] == "orientation and critic: no network, web asks first, corpus read-only. reader: no network, no web."


def await_refresh(c: str) -> None:
    import asyncio

    asyncio.run(extensions.refresh(c))
