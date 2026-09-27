"""What the documents say about thimble's behaviour matches the code: the README's security section stays short and
names the contact the README already gives."""
import re
from pathlib import Path

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
