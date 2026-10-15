"""Text an agent reads whole with Claude Code's Read tool (read_parts.py): a text that one Read call cannot return is
cut at line ends into numbered files of at most PART_CHARS characters, which its prompt names in order, and a file that
stays whole gets a window of lines one Read call returns whole wherever it starts."""
from __future__ import annotations

from app import read_parts, tools


def test_cut_at_line_ends_and_rejoin_exactly():
    text = "short\n" + "a" * 250 + "\n" + "tail\n"
    parts = read_parts.cut(text, limit=100)
    assert "".join(parts) == text
    assert all(len(p) <= 100 for p in parts)
    assert parts[0] == "short\n", "a line that does not fit the open part starts the next one"
    assert parts[1] == "a" * 100 and parts[2] == "a" * 100, "a line past the cap alone is cut mid-line"
    assert read_parts.cut("", limit=100) == [""]


def test_write_puts_the_parts_beside_the_first_file_and_a_shorter_text_removes_only_their_extra_files(tmp_path,
                                                                                                    monkeypatch):
    """The parts are task.md, task-2.md…; a later, shorter text leaves task.md alone and removes those numbered files,
    and only those: an agent's own files in the folder stay, and a link planted as a part goes as a link."""
    monkeypatch.setattr(read_parts, "PART_CHARS", 100)
    folder = tmp_path / "work"
    first = folder / "task.md"
    big = "".join(f"line {i:03d} " + "x" * 30 + "\n" for i in range(12))
    paths = read_parts.write(tmp_path, first, big)
    assert [p.name for p in paths] == ["task.md", "task-2.md", "task-3.md", "task-4.md", "task-5.md", "task-6.md"]
    assert "".join(p.read_text() for p in paths) == big and all(len(p.read_text()) <= 100 for p in paths)
    keep = {name: folder / name for name in ("task-notes.md", "task-2.txt", "transcript.md", "task-02x.md")}
    for path in keep.values():
        path.write_text("an agent's own file")
    outside = tmp_path / "outside.md"
    outside.write_text("not thimble's to remove")
    (folder / "task-9.md").symlink_to(outside)
    assert read_parts.write(tmp_path, first, "small\n") == [first]
    assert first.read_text() == "small\n"
    assert sorted(p.name for p in folder.iterdir()) == sorted(["task.md", *keep])
    assert outside.read_text() == "not thimble's to remove"


def test_named_names_one_file_or_every_part_in_order(monkeypatch, tmp_path):
    real = tools.descriptions
    hints = {"x-file": "READ {path}", "x-files": "READ {n}: {paths}"}
    monkeypatch.setattr(tools, "descriptions", lambda: {**real(), **hints})
    a, b, c = (tmp_path / n for n in ("task.md", "task-2.md", "task-3.md"))
    assert read_parts.named([a], "x-file", "x-files") == f"READ {a}"
    assert read_parts.named([a, b, c], "x-file", "x-files") == f"READ 3: {a}, {b}, {c}"
