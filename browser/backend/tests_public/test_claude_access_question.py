"""The install's question how the workbench reaches Claude (claude_access.setup with no --how), as scripts/install.sh
asks it in a terminal: the Claude Code sign-in first, recommended and the default, and each way by its name alone. A
choice of the Claude Code sign-in still shows its consent text and saves nothing without a yes."""
from __future__ import annotations

import io

import pytest

from app import claude_access


def ask(monkeypatch, capsys, *answers: str) -> tuple[int, str]:
    got = iter(answers)
    monkeypatch.setattr("builtins.input", lambda prompt="": print(prompt, end="") or next(got))
    monkeypatch.setattr("sys.stdin", io.StringIO(""))  # no key typed, when the answer chose the API key
    rc = claude_access.setup([])
    return rc, capsys.readouterr().out


def test_the_question_gives_the_claude_code_sign_in_first_as_the_recommended_default(capsys, monkeypatch):
    rc, out = ask(monkeypatch, capsys, "", "n")  # Enter, then no to the consent text
    assert out.split("Choose 1, 2 or 3 [1]: ", 1)[0].splitlines() == [
        "How should thimble browser reach Claude?",
        "  1  Claude Code sign-in (recommended)",
        "  2  Anthropic API key",
        "  3  Workload Identity Federation",
    ]
    assert claude_access.CONSENT in out, "Enter chose the Claude Code sign-in, which shows its consent text first"
    assert rc == 1 and claude_access.how() == "", "nothing is saved without a yes"


@pytest.mark.parametrize("answer, then", [
    ("1", claude_access.CONSENT),
    ("2", "thimble: not saved: paste an Anthropic API key"),
    ("3", "Path of the Workload Identity Federation config file: "),
])
def test_each_number_chooses_the_way_it_names(capsys, monkeypatch, answer, then):
    rc, out = ask(monkeypatch, capsys, answer, "")
    assert then in out.split("Choose 1, 2 or 3 [1]: ", 1)[1], out
    assert rc == 1 and claude_access.how() == ""
