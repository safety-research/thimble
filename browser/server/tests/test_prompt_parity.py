"""The browser's texts for citations and explain marks are the terminal plugin's (prompts/shared.json).

- The copies in prompts/terminal/ are the files SOURCE.json names, byte for byte. When the git ref they came from is
  here, they are also what that ref holds now: a change to the terminal's text fails this test until someone runs
  scripts/sync-terminal-prompts and looks at the result.
- Every change shared.json makes still finds its words in the terminal's text.
- The prompts Claude reads hold each shared part whole.
"""
import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from thimble_browser import prompts

TERMINAL = prompts.ROOT / "terminal"
SOURCE = json.loads((TERMINAL / "SOURCE.json").read_text())


@pytest.mark.parametrize("local", sorted(SOURCE["files"]))
def test_copies_are_the_files_source_names(local):
    data = (TERMINAL / local).read_bytes()
    assert hashlib.sha256(data).hexdigest() == SOURCE["files"][local]["sha256"], (
        f"prompts/terminal/{local} was edited here: run scripts/sync-terminal-prompts instead")


@pytest.mark.parametrize("local", sorted(SOURCE["files"]))
def test_copies_are_the_terminals_text_now(local):
    ref = SOURCE.get("ref")
    if not ref or ref == "dir":
        pytest.skip("copied from a folder, not a git ref")
    got = subprocess.run(["git", "-C", str(prompts.ROOT), "show", f"{ref}:{SOURCE['files'][local]['source']}"],
                         capture_output=True)
    if got.returncode != 0:
        pytest.skip(f"{ref} is not in this checkout")
    assert got.stdout == (TERMINAL / local).read_bytes(), (
        f"the terminal plugin's {SOURCE['files'][local]['source']} changed on {ref}: run "
        f"scripts/sync-terminal-prompts, then this test again")


@pytest.mark.parametrize("part", sorted(prompts.manifest()["parts"]))
def test_every_change_still_applies(part):
    prompts.shared(part)  # raises when the terminal's text no longer holds a string a change names


def _words(text):
    return text.split()


@pytest.mark.parametrize("part", sorted(prompts.manifest()["parts"]))
def test_changes_are_only_the_listed_ones(part):
    """Undoing the listed changes gives back the terminal's text, word for word."""
    spec = prompts.manifest()["parts"][part]
    got = prompts.shared(part)
    if spec.get("heading"):
        got = got.split("\n", 2)[2]
    source = prompts.source_part(part)
    for old in spec.get("drop", []):
        source = source.replace(old, "")
    for old, new in spec.get("replace", []):
        source = source.replace(old, new)
    assert _words(got) == _words(source)


def test_main_prompt_holds_the_shared_parts_whole():
    text = prompts.render("browser/main.md", {"workdir": "/folder"})
    for part in ("communicating", "citing"):
        assert prompts.shared(part) in text


def test_explain_prompt_holds_the_lens_whole():
    assert prompts.shared("explain") in prompts.render("browser/explain.md")


def test_tool_schemas_parse():
    from thimble_browser import tools

    from thimble_browser import agent

    for a in agent.AGENTS.values():
        for t in tools.definitions(a.tools):
            assert t["description"] and t["input_schema"]["type"] == "object"
