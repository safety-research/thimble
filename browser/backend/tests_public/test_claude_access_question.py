"""The install's question how the workbench reaches Claude (claude_access.setup with no --how, in a terminal), as
scripts/install.sh asks it when the person runs it: the Claude Code sign-in first and recommended, each way in a few
words, and Enter to choose later, which saves nothing; 3 asks for the path of the WIF config file. The question goes to
stderr, so that the install shows it as it comes; the line that says what was chosen goes to stdout."""
from __future__ import annotations

import io

import pytest

from app import claude_access


class Terminal(io.StringIO):
    """The person's answers, typed in a terminal."""

    def isatty(self) -> bool:
        return True


def ask(monkeypatch, capsys, *answers: str, argv: tuple[str, ...] = ("--no-check",)) -> tuple[int, str, str]:
    monkeypatch.setattr("sys.stdin", Terminal("".join(a + "\n" for a in answers)))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    rc = claude_access.setup(list(argv))
    got = capsys.readouterr()
    return rc, got.out, got.err


def test_the_question_gives_the_claude_code_sign_in_first_and_enter_chooses_later(capsys, monkeypatch):
    rc, out, err = ask(monkeypatch, capsys, "")
    assert err.splitlines() == [
        "How should the workbench reach Claude?",
        "  1  Your Claude Code sign-in (recommended): it runs Claude Code in the background, on your Claude plan",
        "  2  An Anthropic API key: ANTHROPIC_API_KEY when it is set, or a key you paste in the workbench",
        "  3  Workload Identity Federation: the path of your WIF config file",
        "  Enter: choose later; the workbench asks when it starts.",
        "Choose 1, 2 or 3: ",
    ]
    assert out == "Sign-in: not chosen yet. The workbench asks when it starts.\n"
    assert rc == 0 and claude_access.how() == "", "Enter saves nothing"


@pytest.mark.parametrize("answer, how, said", [
    ("1", claude_access.CLAUDE_CODE, "Sign-in: your Claude Code sign-in."),
    ("2", claude_access.API_KEY, "Sign-in: an API key. ANTHROPIC_API_KEY is not set here, so paste a key in the "
                                 "workbench with /login in its chat."),
])
def test_each_number_chooses_the_way_it_names(capsys, monkeypatch, answer, how, said):
    rc, out, _ = ask(monkeypatch, capsys, answer)
    assert rc == 0 and claude_access.how() == how and out.splitlines() == [said]


def test_3_asks_for_the_path_of_the_wif_config_file(tmp_path, capsys, monkeypatch):
    rc, out, err = ask(monkeypatch, capsys, "3", str(tmp_path / "nope.toml"))
    assert err.endswith("Choose 1, 2 or 3: The path of your WIF config file: ")
    assert rc == 1 and "It was not saved: there is no file" in out and claude_access.how() == ""


def test_another_answer_asks_again(capsys, monkeypatch):
    rc, _, err = ask(monkeypatch, capsys, "4", "")
    assert "Type 1, 2 or 3, or press Enter to choose later." in err and rc == 0


def test_keep_asks_only_while_nothing_is_chosen(capsys, monkeypatch):
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    rc, out, err = ask(monkeypatch, capsys, "2", argv=("--keep", "--no-check"))
    assert err == "" and out == "Sign-in: your Claude Code sign-in.\n"
    assert claude_access.how() == claude_access.CLAUDE_CODE
