"""prompts.py: load, includes, slots and render, and the repository's own prompt files: every one loads and renders
with its own slots and no `{{` left, includes stay under prompts/, and cycles, escapes or stray braces raise naming the
file."""

import pytest

from app import prompts
from app.prompts import PromptError


@pytest.fixture()
def pdir(tmp_path, monkeypatch):
    """A fixtures prompts dir, selected via THIMBLE_PROMPTS_DIR (re-read on every call, no reload needed)."""
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(tmp_path))
    return tmp_path


def write(pdir, rel, text):
    p = pdir / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


# ----------------------------------------------------------------------------- load and includes


def test_load_appends_md_and_reads(pdir):
    write(pdir, "run.md", "hello {{brief}}")
    assert prompts.load("run") == "hello {{brief}}"
    assert prompts.load("run.md") == "hello {{brief}}"


def test_load_nested_name_works(pdir):
    write(pdir, "rubrics/report.md", "the rubric")
    assert prompts.load("rubrics/report") == "the rubric"


def test_include_resolved_recursively(pdir):
    write(pdir, "a.md", "A [{{include:b.md}}]")
    write(pdir, "b.md", "B <{{include:c.md}}>")
    write(pdir, "c.md", "C")
    assert prompts.load("a") == "A [B <C>]"


def test_include_relative_to_prompts_dir_not_including_file(pdir):
    # sub/inner.md includes "leaf.md": that must resolve to <dir>/leaf.md, never <dir>/sub/leaf.md.
    write(pdir, "top.md", "{{include:sub/inner.md}}")
    write(pdir, "sub/inner.md", "{{include:leaf.md}}")
    write(pdir, "leaf.md", "root leaf")
    write(pdir, "sub/leaf.md", "WRONG leaf")
    assert prompts.load("top") == "root leaf"


def test_include_cycle_raises_naming_files(pdir):
    write(pdir, "a.md", "{{include:b.md}}")
    write(pdir, "b.md", "{{include:a.md}}")
    with pytest.raises(PromptError) as e:
        prompts.load("a")
    assert "a.md" in str(e.value) and "b.md" in str(e.value) and "cycle" in str(e.value)


def test_self_include_raises(pdir):
    write(pdir, "a.md", "{{include:a.md}}")
    with pytest.raises(PromptError, match="cycle"):
        prompts.load("a")


def test_missing_prompt_names_file(pdir):
    with pytest.raises(PromptError) as e:
        prompts.load("nope")
    assert "nope.md" in str(e.value)


def test_missing_include_names_including_file(pdir):
    write(pdir, "a.md", "{{include:gone.md}}")
    with pytest.raises(PromptError) as e:
        prompts.load("a")
    assert "a.md" in str(e.value) and "gone.md" in str(e.value)


def test_path_escape_refused(pdir):
    write(pdir, "a.md", "{{include:../secrets.md}}")
    with pytest.raises(PromptError):
        prompts.load("a")
    with pytest.raises(PromptError):
        prompts.load("../outside")


def test_fresh_read_every_call(pdir):
    """No cache: a hand edit to a prompt file takes effect on the very next call."""
    f = write(pdir, "a.md", "one")
    assert prompts.load("a") == "one"
    f.write_text("two", encoding="utf-8")
    assert prompts.load("a") == "two"


# ----------------------------------------------------------------------------- directive grammar


def test_unknown_directive_raises_loudly(pdir):
    write(pdir, "a.md", "x {{Brief}} y")  # uppercase: not a slot, not an include
    with pytest.raises(PromptError) as e:
        prompts.load("a")
    assert "a.md" in str(e.value) and "Brief" in str(e.value)


def test_spaced_slot_is_an_error_not_a_slot(pdir):
    write(pdir, "a.md", "{{ brief }}")
    with pytest.raises(PromptError):
        prompts.load("a")


def test_slot_grammar(pdir):
    write(pdir, "a.md", "{{brief}} {{notes_2}} {{a_b_c}}")
    assert prompts.slots("a") == frozenset({"brief", "notes_2", "a_b_c"})


def test_slots_sees_through_includes(pdir):
    write(pdir, "a.md", "{{brief}} {{include:b.md}}")
    write(pdir, "b.md", "{{material}}")
    assert prompts.slots("a") == frozenset({"brief", "material"})


# ----------------------------------------------------------------------------- render


def test_render_fills_all_slots(pdir):
    write(pdir, "a.md", "Q: {{brief}}\nN: {{notes}}")
    assert prompts.render("a", {"brief": "why", "notes": "none"}) == "Q: why\nN: none"


def test_render_unfilled_slot_raises_naming_it(pdir):
    write(pdir, "a.md", "{{brief}} {{notes}}")
    with pytest.raises(PromptError) as e:
        prompts.render("a", {"brief": "b"})
    assert "notes" in str(e.value) and "a.md" in str(e.value)


def test_render_extra_keys_ignored(pdir):
    """channel.render_prompts fills main's slots for every file it renders, whichever of them a file uses."""
    write(pdir, "a.md", "{{previous}}")
    assert prompts.render("a", {"previous": "p", "material": "unused"}) == "p"


def test_render_verbatim_no_recursion_into_values(pdir):
    write(pdir, "a.md", "-{{brief}}-")
    # A value containing slot or include markup is inserted literally, never expanded.
    assert prompts.render("a", {"brief": "{{notes}} {{include:x.md}} \\1"}) == "-{{notes}} {{include:x.md}} \\1-"


def test_render_non_string_value_raises(pdir):
    write(pdir, "a.md", "{{n}}")
    with pytest.raises(PromptError, match="str"):
        prompts.render("a", {"n": 3})


# ----------------------------------------------------------------------------- the repository's own prompts


def test_every_prompt_file_loads_and_includes_only_the_shared_parts(monkeypatch):
    """Every prompt file under prompts/ loads, the names the code asks for are all there, and the only files a prompt
    includes are preamble.md (what thimble is) and shared.md (the rules main, the orientation and the thimble agents
    share), each after the prompt's own file."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    on_disk = {p.stem for p in prompts.PROMPTS_DIR.glob("*.md")}
    wanted = {*prompts.PROMPT_NAMES, *prompts.TYPE_FILES.values(), *prompts.AGENT_FILES, *prompts.DEV_FILES}
    assert wanted <= on_disk, sorted(wanted - on_disk)
    for name in sorted(on_disk):
        assert prompts.load(name), name
        chain = prompts.files(name)
        assert chain[0] == f"{name}.md" and set(chain[1:]) <= {"preamble.md", "shared.md"}, (name, chain)
    for name in ("main", "orient"):
        assert "shared.md" in prompts.files(name), name
    from app import checks

    assert sorted(p.stem for p in (prompts.PROMPTS_DIR / prompts.CHECKS_DIR).glob("*.md")) == sorted(checks.BUILTINS)


def test_every_registry_tool_has_a_description_section(monkeypatch):
    """prompts/tools.md carries one `## <name>` section per tool of the registry (tools.descriptions reads it fresh)."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    from app import tools

    sections = tools.descriptions()
    for name in tools.REGISTRY:
        assert len(sections.get(name, "")) > 40, name


def test_section_reads_one_section(pdir):
    """prompts.section: the body of one `## ` section, up to the next, with a `###` sub-heading inside it; a missing
    section names the ones there."""
    (pdir / "fam.md").write_text("# Fam\n\nOpen {{a}}.\n\n## One\n\nBody one {{x}}.\n\n### Sub\n\nmore\n\n## Two words\n\nBody two.\n")
    assert prompts.section("fam", "One") == "Body one {{x}}.\n\n### Sub\n\nmore\n" and prompts.section("fam", "Two words") == "Body two.\n"
    with pytest.raises(prompts.PromptError, match="no section '## Three'"):
        prompts.section("fam", "Three")


def test_agent_prompt_renders_a_template_body_and_without_leaves_parts_out(pdir, monkeypatch):
    """prompts.agent_prompt: an agent definition's body with its includes pasted in and its slots filled, the
    frontmatter left off. prompts.without: each named `### ` or `#### ` part left out up to the next heading of its own
    level or higher, so a `#### ` part inside a kept `### ` section goes alone and a dropped `### ` part takes its `#### `
    parts with it, a heading inside a code fence ignored, and a part the text lacks an error rather than a part kept.
    A line part is the one line that holds a text, and a text on no line or on two is an error, since a line reworded or
    repeated must not be kept or cut unnoticed."""
    monkeypatch.setattr(prompts, "AGENT_FILES", ("agent",))
    write(pdir, "agent.md", "---\nname: a\ntools: Read\n---\n\n# A\n\nHi {{who}}.\n\n{{include:inc.md}}\n")
    write(pdir, "inc.md", "## Shared\n\nShared text.\n")
    body = prompts.agent_prompt("agent", {"who": "you"})
    assert body == "# A\n\nHi you.\n\n## Shared\n\nShared text."
    with pytest.raises(PromptError):
        prompts.agent_prompt("inc", {})
    text = ("## Top\n\nkeep\n\n### One\n\ndrop one\n\n```\n### not a heading\n```\n\n### Two\n\nkeep two\n\n"
            "### Three\n\ndrop three\n\n## Next\n\nkeep next\n")
    assert prompts.without(text, ["One", "Three"]) == "## Top\n\nkeep\n\n### Two\n\nkeep two\n\n## Next\n\nkeep next\n"
    assert prompts.without(text, []) == text
    with pytest.raises(PromptError, match="Four"):
        prompts.without(text, ["Four"])
    outs = ("### Guides\n\n- read `a`\n- call `tool`\n\n### Outputs\n\nalways\n\n#### Final\n\nfinal\n\n#### Views\n\n"
            "views\n\n### Last\n\nlast\n")
    assert prompts.without(outs, ["Final"]) == ("### Guides\n\n- read `a`\n- call `tool`\n\n### Outputs\n\nalways\n\n"
                                               "#### Views\n\nviews\n\n### Last\n\nlast\n")
    assert prompts.without(outs, ["Views"]) == outs.replace("#### Views\n\nviews\n\n", "")
    assert prompts.without(outs, ["Outputs"]) == "### Guides\n\n- read `a`\n- call `tool`\n\n### Last\n\nlast\n"
    assert prompts.without(outs, ["Final", "Views"], ["`tool`"]) == \
        "### Guides\n\n- read `a`\n\n### Outputs\n\nalways\n\n### Last\n\nlast\n"
    with pytest.raises(PromptError, match="`nope`"):
        prompts.without(outs, [], ["`nope`"])
    with pytest.raises(PromptError, match="read"):
        prompts.without(outs + "- read it again\n", [], ["read"])


def test_real_prompts_render_clean(monkeypatch):
    """Every prompt renders with its own slots and no {{...}} survives — nothing half-filled can reach a model."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for name in (*prompts.PROMPT_NAMES, *prompts.TYPE_FILES.values(), *prompts.DEV_FILES):
        values = {s: f"<{s}>" for s in prompts.slots(name)}
        out = prompts.render(name, values)
        assert "{{" not in out and "}}" not in out, name
        prose = "\n".join(ln for ln in out.splitlines() if not ln.startswith("    "))  # an example may show it as a fault
        assert "load-bearing" not in prose.replace('"load-bearing"', ""), name  # quoted, it is shared.md's example of a flourish


# ----------------------------------------------------------------------------- half-typed directives


def test_unclosed_directive_raises_naming_file(pdir):
    """'{{brief}' is the most likely hand-edit typo; it must not flow to a model as literal text."""
    write(pdir, "a.md", "text {{brief} more")
    with pytest.raises(PromptError) as e:
        prompts.load("a")
    assert "a.md" in str(e.value) and "{{" in str(e.value)


def test_stray_closing_braces_raise(pdir):
    write(pdir, "a.md", "text {brief}} more")
    with pytest.raises(PromptError) as e:
        prompts.load("a")
    assert "a.md" in str(e.value)


def test_stray_brace_in_included_file_names_that_file(pdir):
    write(pdir, "a.md", "{{include:b.md}}")
    write(pdir, "b.md", "oops {{notes}")
    with pytest.raises(PromptError) as e:
        prompts.load("a")
    assert "b.md" in str(e.value)


def test_stray_brace_after_a_valid_directive_raises(pdir):
    write(pdir, "a.md", "{{brief}} and then {{oops}")
    with pytest.raises(PromptError):
        prompts.load("a")


def test_values_with_braces_still_inserted_verbatim(pdir):
    """The stray-brace check reads prompt FILE text only; analyst content in values stays untouched."""
    write(pdir, "a.md", "-{{brief}}-")
    assert prompts.render("a", {"brief": "notes with {{ and }} inside"}) == "-notes with {{ and }} inside-"
