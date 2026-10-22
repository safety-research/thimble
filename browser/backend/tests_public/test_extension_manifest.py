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


def test_a_card_json_written_before_the_spec_settled_needs_no_example(tmp_path):
    """A card.json in today's layout (`use`) still loads without an example; one in the new layout needs one, and a card
    type with neither a reader of its own nor a view to read with says it lacks the reader."""
    root = tmp_path / "cards"
    _write(root, "extension.json", {"name": "cards", "version": "1", "scope": ["*.jsonl"]})
    _write(root, "cards/old/card.json", {"use": "How many records each person made."})
    _write(root, "cards/new/card.json", {"description": "How many records each person made."})
    for d in ("old", "new"):
        _write(root, f"cards/{d}/card.html", "<div></div>")
        _write(root, f"cards/{d}/card.py", "def card(**args):\n    return args\n")
    assert _problems(root) == ['cards/new/card.json:1  needs "example"']
    _write(root, "cards/new/card.json", {"description": "How many records each person made.", "example": {}})
    assert _problems(root) == []
    assert "its card type 'old' has no reader.py, which thimble needs to read its files" in \
        extensions.read_extension(root, "cards", set())["problems"]


def test_a_folder_over_the_size_limit_is_refused_without_being_read(tmp_path, workspaces_tmp, monkeypatch):
    d = tmp_path / "big"
    shutil.copytree(FIXTURE, d)
    raw = json.loads((d / "extension.json").read_text())
    (d / "extension.json").write_text(json.dumps({**raw, "name": "big"}))
    (d / "sample.bin").write_bytes(b"x" * 4096)
    monkeypatch.setattr(extensions, "SIZE_MAX", 2048)
    read: list[Path] = []
    real = Path.read_bytes
    monkeypatch.setattr(Path, "read_bytes", lambda self: read.append(self) or real(self))
    assert extensions.digest(d)[0] == "" and read == []
    with pytest.raises(extensions.AddError, match="an extension may hold 2,048"):
        extensions.add(str(d), yes=True, say=lambda _: None)


@pytest.fixture()
def corpus(workspaces_tmp, tmp_path, monkeypatch) -> str:
    d = tmp_path / "data" / "kitws"
    d.mkdir(parents=True)
    (d / "notes.jsonl").write_text('{"who": "ana"}\n')
    (d / "manifest.json").write_text(json.dumps({"name": "kitws", "description": "notes"}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    return "kitws"


def await_refresh(c: str) -> None:
    import asyncio

    asyncio.run(extensions.refresh(c))


def test_a_view_the_dev_agent_built_can_be_copied_into_an_extension(tmp_path):
    """A generated view's view.json carries the stamp thimble wrote when it passed its checks (views.mark_built), and
    copying its folder into an extension is how a view is shared."""
    root = tmp_path / "shared"
    _write(root, "extension.json", {"name": "shared", "version": "1"})
    _write(root, "views/tally/view.json", {"name": "Tally", "description": "Each tally line.", "claims": ["*.jsonl"],
                                           "accepts": [], "units": [], "libs": [], "built": "2026-10-01T00:00:00Z",
                                           "version": "abc123def456"})
    _write(root, "views/tally/view.html", "<div></div>")
    assert _problems(root) == []
