"""prompts/tools.md is where each tool is defined for a model: its `## <tool>` section is the description, and the
```json block under the prose is the input schema, so the schema sits beside the prompt. backend/app/tools.py reads both from there and keeps only the roles and the handler in
REGISTRY. These tests hold the file to what the registry and Claude Code need: a section and a parsing object schema
for every registry tool, a description of one to three sentences that never carries the block, every section under 2 KB
less its schema block (Claude Code cuts a tool description at 2 KB, and not the input schema), the enums the handlers
check equal to the schema's, and a loud failure when a hand edit breaks a section. A property carries a description only where its name is not enough.
"""
from __future__ import annotations

import re
import shutil

import pytest

from app import config, prompts, tools

TOOLS_MD = config.REPO_ROOT / "prompts" / "tools.md"
SECTION_MAX_BYTES = 2048


@pytest.fixture(autouse=True)
def _real_prompts(monkeypatch):
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)


def _sections_with_headings() -> dict[str, str]:
    """Every `## ` section of the file as written, its heading line included (what a reviewer sees as the section)."""
    text = TOOLS_MD.read_text("utf-8")
    marks = [*re.finditer(r"^## (\S+)\s*$", text, re.M)]
    return {m.group(1): text[m.start():marks[i + 1].start() if i + 1 < len(marks) else len(text)] for i, m in enumerate(marks)}


def test_every_registry_tool_has_a_section_with_an_object_schema():
    secs = tools.tool_sections()
    assert list(secs) == list(tools.REGISTRY)
    for name, (desc, schema) in secs.items():
        assert len(desc) > 40, name
        assert schema["type"] == "object" and isinstance(schema.get("properties"), dict), name
        props = schema["properties"]
        assert set(schema.get("required") or []) <= set(props), name
        assert not set(tools.ARG_ALIASES.get(name, {})) & set(props), (name, "an alias is never listed")
        # a description says what the tool does, when to use it instead of a neighbour and what comes back; the when
        # and why of using it live in the agents' prompts
        assert 1 <= desc.count(". ") + 1 <= 3, (name, "one to three sentences")
    for role in tools.ROLES:
        for entry in tools.list(role):
            assert entry["input_schema"] == secs[entry["name"]][1] and entry["description"] == secs[entry["name"]][0]


def test_a_description_is_the_prose_without_the_schema_block():
    """What a model reads as the description is the section's prose; the json block reaches it only as the schema."""
    for name, (desc, _) in tools.tool_sections().items():
        assert "```" not in desc and '"properties"' not in desc, name
    assert tools.descriptions()["add_card"] == tools.tool_sections()["add_card"][0]


def test_every_section_is_under_2_kb_less_its_schema():
    """Claude Code cuts an MCP tool's description and the server's instructions at 2,048 characters, and not the input
    schema, which the shim lists apart from the description (plugin/bin/thimble-mcp). So what counts is a section's prose, its
    heading included, and a property's description in the json block, such as add_card's takeaway, does not."""
    for name, body in _sections_with_headings().items():
        prose = re.sub(r"```json\n.*?\n```", "", body, flags=re.S)
        assert len(prose.encode("utf-8")) < SECTION_MAX_BYTES, f"## {name} is {len(prose.encode('utf-8'))} bytes"


def test_the_file_loads_and_no_tool_retired_by_the_merge_has_a_section():
    """A doubled brace would fail prompts.load for the whole file (a broken slot), so a schema is written without one;
    retired tools have no section, and every other lowercase section is a hint a result carries."""
    text = prompts.load("tools")
    assert "{{" not in text and "}}" not in text
    names = set(_sections_with_headings())
    retired = {"get_cell", "get_record", "read_chat", "set_takeaway", "build_view", "revise_document", "rewrite_span",
               "add_figure", "stop_orientation", "take_screenshot", "tell_user",
               "begin_final_notebook", "finish_orientation", "check_view", "save_view"}
    assert not names & retired
    hints = names - set(tools.REGISTRY)
    assert {"instructions", "chart-rows", "chart-no-rows", "edit_card-takeaway-errored", "screenshot-none",
            "view-built", "write_document-form"} <= hints
    assert not hints & {"edit_card-takeaway-alone", "not-built", "check_view-passed", "check_view-failed", "save_view-saved",
                        "save_view-passed", "save_view-failed", "screenshot-no-image",
                        "screenshot-data", "screenshot-diagram", "screenshot-file", "screenshot-passage"}
    assert not any(tools.split_section(tools.sections()[h])[1] for h in hints), "a hint has no schema block"


def test_the_enums_the_handlers_check_are_the_schemas():
    add = tools.schema_of("add_card")["properties"]
    assert tuple(add["kind"]["enum"]) == tools.ADD_CELL_KINDS
    assert tuple(tools.schema_of("edit_card")["properties"]["kind"]["enum"]) == tools.EDIT_CELL_KINDS
    label = tools.schema_of("apply_label")["properties"]
    assert tuple(label["scope"]["enum"]) == tools.LABEL_SCOPES
    assert tuple(label["predicate"]["properties"]["kind"]["enum"]) == tools.LABEL_KINDS
    # a check's comment has no kind: the check it comes from is what the analyst sees (checks.tool_add_comment)
    assert set(tools.schema_of("add_comment")["properties"]) == {"ref", "text"}
    assert set(tools.schema_of("run_check")["properties"]) == {"name", "instructions", "passages"}


def test_a_broken_section_fails_every_listing_loudly(tmp_path, monkeypatch):
    shutil.copytree(TOOLS_MD.parent, tmp_path / "prompts")
    broken = tmp_path / "prompts" / "tools.md"
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(tmp_path / "prompts"))
    text = TOOLS_MD.read_text("utf-8")
    broken.write_text(text.replace('"required": ["ref"]\n}', '"required": ["ref"],\n}', 1), "utf-8")
    with pytest.raises(tools.ToolsFileError, match="## read_ref"):
        tools.list("analyst")
    broken.write_text(text.replace("## screenshot\n", "## screenshots\n", 1), "utf-8")
    with pytest.raises(tools.ToolsFileError, match="no `## screenshot` section"):
        tools.list("analyst")
    assert tools.hint("card-errored"), "the hint lines still read"
    broken.write_text(text.replace('  "required": ["title", "body"]\n}', '  "required": ["title", "body"]}}', 1), "utf-8")
    with pytest.raises(tools.ToolsFileError, match="unusable"):
        tools.list("analyst")
    assert tools.descriptions() == {} and tools.hint("card-errored") == ""
