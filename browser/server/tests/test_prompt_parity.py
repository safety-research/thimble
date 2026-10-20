"""The browser's texts for citations, explain marks and labels are the terminal plugin's (prompts/shared.json), read
from plugin/ as they are now.

- Every change shared.json makes still finds its words in the terminal's text, so a reworded sentence there stops
  this test until someone looks at it.
- Undoing the listed changes gives back the terminal's text word for word, so no other edit slips in.
- The default version the server reads from the plugin's prompt registry is the one Node reads from it.
- The prompts Claude reads hold each shared part whole.
"""
import json
import shutil
import subprocess

import pytest

from thimble_browser import prompts

PARTS = sorted(prompts.manifest()["parts"])


@pytest.mark.parametrize("part", PARTS)
def test_every_change_still_applies(part):
    prompts.shared(part)  # raises when the terminal's text no longer holds a string a change names


def _words(text):
    return text.split()


@pytest.mark.parametrize("part", PARTS)
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


FEATURES = sorted({s["prompt"] for s in prompts.manifest()["parts"].values() if s.get("prompt")})
READ_DEFAULTS = """
import { loadIndex } from './prompts/node.mjs'
const idx = loadIndex()
const out = {}
for (const f of process.argv.slice(1)) out[f] = idx[f].versions[idx[f].default].file
console.log(JSON.stringify(out))
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node to read the plugin's prompt registry")
def test_the_default_versions_are_the_registrys():
    got = subprocess.run(["node", "--input-type=module", "-e", READ_DEFAULTS, *FEATURES], cwd=prompts.PLUGIN,
                         capture_output=True, text=True, check=True)
    assert json.loads(got.stdout) == {f: prompts.default_file(f) for f in FEATURES}


def test_main_prompt_holds_the_shared_parts_whole():
    text = prompts.render("main.md", {"workdir": "/folder"})
    for part in ("communicating", "citing", "labels-guide"):
        assert prompts.shared(part) in text


def test_explain_prompt_holds_the_lens_whole():
    assert prompts.shared("explain") in prompts.render("explain.md")


def test_tool_schemas_parse():
    from thimble_browser import agent, tools

    for a in agent.AGENTS.values():
        for t in tools.definitions(a.tools):
            assert t["description"] and t["input_schema"]["type"] == "object"
