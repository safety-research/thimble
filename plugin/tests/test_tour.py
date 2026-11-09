"""thimble tour (engine/kernel/tour.py): a person in a shell gets the tour's sample data in a folder of its own,
$THIMBLE_HOME/tour, and Claude Code opens there in its fullscreen layout with /thimble:tour as its first prompt. Inside
Claude Code it opens nothing and says to type /thimble:tour. The test's claude is never started: the exec is caught.
All data is made up."""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))

from kernel import cli  # noqa: E402
from kernel import tour as TR  # noqa: E402


@pytest.fixture
def started(tmp_path, monkeypatch):
    """A shell with its own THIMBLE_HOME and a made-up claude; the exec and the change of folder are recorded."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("THIMBLE_CLAUDE", "/made-up/bin/claude")
    for v in ("CLAUDECODE", "THIMBLE_HANDED_OFF", TR.FULLSCREEN):
        monkeypatch.delenv(v, raising=False)
    got: dict = {}
    monkeypatch.setattr(TR.os, "chdir", lambda p: got.setdefault("cwd", str(p)))

    def execvpe(file, argv, env):
        got.update(file=file, argv=list(argv), env=dict(env))
        return 0

    monkeypatch.setattr(TR.os, "execvpe", execvpe)
    return got


def test_the_tour_copies_the_sample_into_its_own_folder_and_opens_claude_there_with_the_tour(started, tmp_path, capsys):
    folder = tmp_path / "home" / "tour"
    folder.mkdir(parents=True)
    # a copy an earlier tour left, changed since: the tour starts from the sample again; the person's own file stays
    (folder / "orders.csv").write_text("order_id\nF-9999\n")
    (folder / "notes.txt").write_text("my own notes\n")
    assert cli.main(["tour"]) == 0
    sample = sorted(p.name for p in TR.SAMPLE.iterdir())
    assert "orders.csv" in sample and "README.md" in sample
    for name in sample:
        assert (folder / name).read_bytes() == (TR.SAMPLE / name).read_bytes()
    assert (folder / "notes.txt").read_text() == "my own notes\n"
    assert started["cwd"] == str(folder)
    assert started["argv"] == ["/made-up/bin/claude", "/thimble:tour"]
    # the fullscreen layout, where the tour's clicks and selections reach thimble
    assert started["env"][TR.FULLSCREEN] == "1"
    out = capsys.readouterr().out
    assert "starts the tour" in out
    # Claude Code's question about a new folder exits on its first choice: the line says which one to take
    assert "Yes, I trust this folder" in out


def test_a_layout_the_person_chose_stays(started, monkeypatch):
    monkeypatch.setenv(TR.FULLSCREEN, "0")
    assert cli.main(["tour"]) == 0
    assert started["env"][TR.FULLSCREEN] == "0"


def test_inside_claude_code_it_opens_nothing_and_names_the_command_there(started, monkeypatch, capsys):
    monkeypatch.setenv("CLAUDECODE", "1")
    assert cli.main(["tour"]) == 1
    assert "argv" not in started
    assert "/thimble:tour" in capsys.readouterr().err


def test_on_a_claude_code_too_old_for_the_tour_it_opens_nothing_and_names_the_update(started, tmp_path, monkeypatch,
                                                                                     capsys):
    """The tour needs Claude Code 2.1.314 or later, the first that places its rows ($.ui.place); thimble itself runs on
    older ones. On one of those it opens nothing and says what updates Claude Code; on 2.1.314 it opens Claude Code."""
    claude = tmp_path / "bin" / "claude"
    claude.parent.mkdir()
    monkeypatch.setenv("THIMBLE_CLAUDE", str(claude))
    for version in ("2.1.311", "2.1.314"):
        claude.write_text(f'#!/bin/sh\n[ "$1" = --version ] && echo "{version} (Claude Code)"\n')
        claude.chmod(0o755)
        if version == "2.1.311":
            assert cli.main(["tour"]) == 1
            assert "argv" not in started
            assert ("the tour needs Claude Code 2.1.314 or later (the one here is 2.1.311). Update it with claude update"
                    in capsys.readouterr().err)
        else:
            assert cli.main(["tour"]) == 0
            assert started["argv"] == [str(claude), "/thimble:tour"]


def test_the_help_names_the_tour():
    assert "thimble tour " in cli._help()


def test_the_sample_is_small_made_up_data_with_the_numbers_the_tours_answer_states():
    """The answer in skills/tour/SKILL.md states these numbers, with no citations; one of them (the refunds) is wrong on
    purpose."""
    rows = list(csv.DictReader((TR.SAMPLE / "orders.csv").open()))
    assert len(rows) == 36
    assert sum(int(r["total_usd"]) for r in rows) == 1872
    assert sum(r["refunded"] == "yes" for r in rows) == 4
    assert sum(r["arrived"] == "late" for r in rows) == 6
    assert sum(r["region"] == "North" for r in rows) == 14
    skill = (Path(TR.SAMPLE).parents[1] / "skills" / "tour" / "SKILL.md").read_text()
    for stated in ("refunded 7 orders", "6 orders", "36 orders", "$1,872", "$52", "14 of the 36"):
        assert stated in skill
    assert "](#)" not in skill
    # with Citations manual the tour's cite step names the wrong number's words (tour/tour.ts CITE_WORDS), which the
    # person finds in the answer and cites with c
    tour_ts = (Path(TR.SAMPLE).parents[1] / "tour" / "tour.ts").read_text()
    words = re.search(r"export const CITE_WORDS = '([^']+)'", tour_ts).group(1)
    assert words in skill and "7" in words
