"""scripts/third_party_notices.py: the release's THIRD_PARTY_NOTICES list the npm packages with their license texts and
end with the notice of the glyphs that follow published icon sets, copied from Icon.tsx's /*! comment; that notice
credits every such glyph."""
import importlib.util
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "third_party_notices.py"


@pytest.fixture()
def tpn():
    spec = importlib.util.spec_from_file_location("third_party_notices", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_notices_end_with_the_icon_notice_without_its_comment_markers(tpn, tmp_path):
    front = tmp_path / "frontend"
    (front / "node_modules" / "pad").mkdir(parents=True)
    (front / "package-lock.json").write_text(json.dumps({"packages": {
        "": {"name": "app"}, "node_modules/pad": {"version": "1.0.0", "license": "MIT"},
        "node_modules/tool": {"version": "2.0.0", "license": "MIT", "dev": True}}}))
    (front / "node_modules" / "pad" / "package.json").write_text('{"version": "1.0.0", "repository": "example/pad"}')
    (front / "node_modules" / "pad" / "LICENSE").write_text("MIT License, pad's text")
    (front / "src" / "components").mkdir(parents=True)
    (front / "src" / "components" / "Icon.tsx").write_text(
        "// a comment that opens with /*! is kept\n/*! The star glyph follows an invented set, Copyright (c) Nobody.\n"
        " * Under a made-up license.\n *\n * Second paragraph. */\nexport const x = 1\n")
    npm = tpn.npm_packages(tmp_path)
    for p in npm:
        tpn.npm_details(p)
    text = tpn.render(npm, tpn.icon_notices(tmp_path))
    assert "pad 1.0.0  MIT  https://github.com/example/pad" in text and "tool" not in text
    assert text.endswith("Icons\n-----\nSome of the UI's glyphs follow published icon sets "
                         "(frontend/src/components/Icon.tsx):\n\nThe star glyph follows an invented set, Copyright (c) "
                         "Nobody.\nUnder a made-up license.\n\nSecond paragraph.\n")
    assert "Icons" not in tpn.render(npm, tpn.icon_notices(tmp_path / "elsewhere"))


def test_the_icon_notice_credits_every_glyph_it_names_and_each_is_a_glyph_of_icon_tsx(tpn):
    (notice,) = tpn.icon_notices(ROOT)
    for part in ("Feather", "Tabler Icons", "Lucide", "MIT License", "ISC License"):
        assert part in notice, part
    source = (ROOT / tpn.ICONS).read_text()
    named = {"gear", "branch", "reader", "edit", "undo", "redo", "braces"}
    for glyph in named:
        assert re.search(rf"\b{glyph}\b", notice), glyph
        assert re.search(rf"^  '?{glyph}'?: ", source, re.M), glyph
    assert "seven follow published icon sets" in source and len(named) == 7
