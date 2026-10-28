"""The install's question how the workbench reaches Claude (claude_access.setup with no --how), as scripts/install.sh
asks it in a terminal: it recommends the Claude Code sign-in to a person with a Claude subscription, and its numbers
choose as before."""
from __future__ import annotations

from app import claude_access


def test_the_question_recommends_the_claude_code_sign_in_to_a_subscriber(capsys, monkeypatch):
    answers = iter(["2", "n"])  # the Claude Code sign-in, then no to its consent text
    monkeypatch.setattr("builtins.input", lambda prompt="": print(prompt, end="") or next(answers))
    assert claude_access.setup([]) == 1
    out = capsys.readouterr().out
    menu = out.split("Choose 1, 2 or 3")[0].splitlines()
    [key] = [line for line in menu if line.strip().startswith("1 ")]
    [cc] = [line for line in menu if line.strip().startswith("2 ")]
    assert "Claude Code sign-in" in cc and "recommended" in cc and "Claude subscription" in cc, cc
    assert "API key" in key and "recommended" not in key
    assert claude_access.CONSENT in out, "2 chose the Claude Code sign-in, which shows its consent text first"
    assert claude_access.how() == ""
