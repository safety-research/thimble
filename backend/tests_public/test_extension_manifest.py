"""app.extension_manifest: an extension's JSON files are checked against extension.schema.json and the rules it cannot
state, and each problem names its file and line, so `thimble extension add` can refuse with every problem listed."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from app import extension_manifest, extensions

FIXTURE = Path(__file__).parent / "fixtures" / "ext-min"


def _write(root: Path, rel: str, data) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(data if isinstance(data, str) else json.dumps(data, indent=2))


def _problems(root: Path) -> list[str]:
    return [str(p) for p in extension_manifest.check(root)]


def test_the_extensions_thimble_ships_and_the_fixture_have_no_problem():
    for d in sorted(p for p in extensions.builtin_dir().iterdir() if (p / "extension.json").is_file()):
        assert _problems(d) == [], d.name
    assert _problems(FIXTURE) == []


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
