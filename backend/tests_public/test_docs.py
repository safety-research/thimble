"""What the documents say about thimble's behaviour matches the code: the README's security section stays short and
names the contact the README already gives, INSTALL.md says which credentials thimble reads and what a problem
report holds, and docs/terminal-first.md describes the Claude Code variables thimble sets by what they do."""
import re
from pathlib import Path

from app import bg_session, config, terminal_tools

ROOT = Path(__file__).resolve().parents[2]


def section(text: str, heading: str) -> str:
    """The body of the `## heading` section of a markdown text, up to the next `## `."""
    m = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    assert m, f"no ## {heading} section"
    return m.group(1).strip()


def test_the_readme_has_a_short_security_section_with_the_existing_contact():
    readme = (ROOT / "README.md").read_text()
    body = section(readme, "Security")
    bullets = [ln for ln in body.splitlines() if ln.startswith("- ")]
    assert len(bullets) == len(body.splitlines()) and 3 <= len(bullets) <= 7, "a few plain bullets, nothing else"
    assert len(body.split()) <= 100
    for fact in ("127.0.0.1", "no login", "pre-approved", "no sandbox", "hooks run in every Claude Code session",
                 "dev agent edits and restarts", "billed to your own account", "telemetry stays local"):
        assert fact in body, fact
    contacts = set(re.findall(r"\[@(\w+)\]\((https://github\.com/\w+)\)", readme))
    assert len(contacts) == 1 and "@" + next(iter(contacts))[0] in body


def test_install_says_which_credentials_thimble_reads_and_that_it_never_writes_or_logs_them():
    intro = (ROOT / "INSTALL.md").read_text().split("\n## ", 1)[0]
    assert "never reads" not in intro
    for name in (*config.ENV_CREDENTIALS, "apiKeyHelper", "login file"):
        assert name in intro, name
    assert "never writes an API key to disk" in intro and "never logs one" in intro


def test_install_says_a_problem_report_holds_chats_and_transcripts_that_quote_the_corpus():
    text = " ".join((ROOT / "INSTALL.md").read_text().split())
    line = next(s for s in text.split("- ") if s.startswith("To report a problem"))
    assert "chats" in line and "Claude Code transcripts" in line and "quote your corpus" in line


def test_terminal_first_describes_the_claude_code_variables_by_what_they_do():
    text = (ROOT / "docs" / "terminal-first.md").read_text()
    assert "undocumented" not in text.lower() and "does not document" not in text
    for name in (terminal_tools.ENV, *bg_session.FOREGROUND_ENV):
        assert f"`{name}" in text, name
