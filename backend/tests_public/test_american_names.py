"""thimble's API names are spelled the American way (color), and each British name an earlier card, view, check or
extension used (colour) still works as its alias: the `thimble` module's colors, color_value and color_on, the
"color" of a mark and of a label a reader gets, show_label's `colors`, and the `color` of a check's front matter and of
an extension's check.json."""
import json
import re
from pathlib import Path

from app import checks, kernel_thimble, prompts, tools, views


def test_the_thimble_module_s_american_names_and_their_british_aliases(tmp_path, monkeypatch):
    (tmp_path / "concepts").mkdir()
    (tmp_path / "concepts" / "k1.json").write_text(json.dumps({"id": "k1", "name": "kind", "labels": ["a", "b"], "ts": "1"}))
    monkeypatch.setattr(kernel_thimble, "WS", str(tmp_path))
    monkeypatch.setattr(kernel_thimble, "_LABELS_READ", [])
    assert kernel_thimble.colors("kind") == kernel_thimble.colours("kind") == {"a": kernel_thimble.LABEL_COLOURS[1],
                                                                               "b": kernel_thimble.LABEL_COLOURS[0]}
    by_kind = {"field": "kind", "off": ["b"]}
    for value, on in ((kernel_thimble.color_value, kernel_thimble.color_on), (kernel_thimble.colour_value, kernel_thimble.colour_on)):
        assert value(by_kind, "m#L1", {"kind": "a"}) == "a" and on(by_kind, "a") and not on(by_kind, "b")
    assert {"colors", "color_value", "color_on", "colours", "colour_value", "colour_on"} <= set(kernel_thimble.__all__)

    monkeypatch.setattr(kernel_thimble, "_view_ctx", views.probe_context(filtered=True))
    [mark] = kernel_thimble.marked("messages.jsonl#L14")
    assert mark["color"] == mark["colour"] == kernel_thimble.PROBE_COLOUR
    on = kernel_thimble.view_labels()
    [label] = on["labels"]
    assert label["color"] == label["colour"] and label["values"][0]["color"] == label["values"][0]["colour"]
    assert on["filter"]["color"] == on["filter"]["colour"] == kernel_thimble.PROBE_COLOUR
    assert kernel_thimble.color_value({"label": kernel_thimble.PROBE_ID}, "messages.jsonl#L14") == kernel_thimble.PROBE_NAME


def test_show_label_documents_colors():
    assert "colors" in tools.schema_of("show_label")["properties"]
    assert "colours" not in tools.schema_of("show_label")["properties"], "the alias is not offered to the model"


def test_a_check_s_color_and_its_british_alias(monkeypatch, tmp_path):
    for cid in checks.BUILTINS:
        head = prompts.load(f"{prompts.CHECKS_DIR}/{cid}").split("\n---\n", 1)[0]
        assert "\ncolor: " in head and "colour" not in head, cid
        assert checks.builtin(cid)["colour"] == int(head.split("\ncolor: ", 1)[1].split()[0])
    real = prompts.load
    monkeypatch.setattr(prompts, "load", lambda name: "---\nname: Old\ncolour: 6\n---\nComment." if "checks" in name else real(name))
    assert checks.builtin(checks.BUILTINS[0])["colour"] == 6, "a check file written with `colour` keeps its color"

    from app import extensions  # noqa: PLC0415

    for slug, raw in (("new", {"name": "New", "color": "5"}), ("old", {"name": "Old", "colour": "7"})):
        (tmp_path / "checks" / slug).mkdir(parents=True)
        (tmp_path / "checks" / slug / "check.json").write_text(json.dumps(raw))
        (tmp_path / "checks" / slug / "check.md").write_text("Comment on each sentence.")
    monkeypatch.setattr(extensions, "active", lambda c: [{"name": "ext", "src": str(tmp_path),
                                                          "checks": [{"slug": "new"}, {"slug": "old"}]}])
    got = checks.from_extensions("c")
    assert (got["ext-new"]["colour"], got["ext-old"]["colour"]) == (5, 7)
    schema = json.loads((Path(checks.__file__).with_name("extension.schema.json")).read_text())
    assert {"color", "colour"} <= set(schema["$defs"]["check"]["properties"])


BRITISH = re.compile(r"(?<![\w-])(colour\w*|grey\w*|behaviours?|centre[sd]?|neighbour\w*|labell(?:ed|ing)|organis\w*|"
                     r"recognis\w*|summaris\w*|normalis\w*|favour\w*|licence|cancell(?:ed|ing)|signall(?:ed|ing)|"
                     r"modell(?:ed|ing)|analys(?:e|ed|ing)|catalogue|judgement)(?![\w-])", re.I)
CODE = re.compile(r"`[^`\n]*`|\{\w+\}")  # inline code (identifiers, the British aliases) and a prompt's {placeholders}
# a short date with its day first (`18 Jun`, `24 May 12:30`), in code spans too, where the American order is `Jun 18`
DAY_FIRST = re.compile(r"(?<![\w.:/-])\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b")


def test_the_prompts_and_docs_are_written_in_american_english():
    """Matt (10-10): "Colour > Color (not british)". What the agents and the analyst read is spelled the American way;
    an inline code span may still name a British alias. A short date puts its month first, as thimble writes dates."""
    root = Path(__file__).resolve().parents[2]
    files = [*root.glob("prompts/**/*.md"), *root.glob("docs/*.md"), *root.glob("plugin/skills/**/*.md"),
             *root.glob("extensions/*/cards/*/card.md"), root / "mods/thimble-term/README.md",
             root / "mods/thimble-term/SPEC.md", root / "README.md", root / "INSTALL.md", root / "CONTRIBUTING.md"]
    found = [f"{p.relative_to(root)}:{n}: {m.group(0)}" for p in files for n, line in enumerate(p.read_text().splitlines(), 1)
             for m in [*BRITISH.finditer(CODE.sub(" ", line)), *DAY_FIRST.finditer(line)]]
    assert not found, found
