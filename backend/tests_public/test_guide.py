"""thimble's guide (app/guide.py, contract C3): main's prompt with the mode branches merged, the guidance of a switched
-off feature left out, and a lead line that names the session's own guide marker; whether a session is owed it, and the
one check-and-mark step that sends it once to eight callers at once. Also: no prompt file keeps a mode block, the view
build targets render their blocks, and the guide keeps the phrases the owner's prompts must keep."""
from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from app import activate, cli, config, features, guide

MUST_KEEP = ("apply_label", "never a regex", "[[", "takeaway", "with its base", "edit_card",
             "Write nothing into the corpus")
REGISTER_HERE = cli.register_here  # the real one (conftest replaces it in every test)


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(workspaces_tmp))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    monkeypatch.setattr(activate, "refresh_later", lambda c: None)
    monkeypatch.setattr(activate, "refresh", lambda c: None)
    monkeypatch.setattr(cli, "register_here", REGISTER_HERE)
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    d = tmp_path / "runs"
    d.mkdir()
    (d / "events.jsonl").write_text('{"a": 1}\n')
    return str(d)


@pytest.mark.parametrize("off, gone, kept", [
    ("labels", ["## Labels\n", "- `labeled`", "- `label_done`", "- `rerun`", "never a regex"], ["## Checks\n", "- `checked`"]),
    ("checks", ["## Checks\n", "- `checked`"], ["## Labels\n", "- `labeled`", "- `label_done`", "- `rerun`"]),
])
def test_a_switched_off_feature_leaves_its_guidance_out(corpus, off, gone, kept):
    on = guide.render(corpus)
    assert all(g in on for g in gone + kept)
    features.set_settings({off: "off"}, "test")
    text = guide.render(corpus)
    assert not [g for g in gone if g in text], off
    assert all(k in text for k in kept)
    assert "\n\n\n" not in text, "a block of whole lines leaves no blank line"


def test_take_if_owed_sends_the_guide_once_to_eight_callers_at_once(corpus):
    assert activate.activate(corpus, "s-t", "data")["ok"]
    got: list[str | None] = []
    threads = [threading.Thread(target=lambda: got.append(guide.take_if_owed(corpus, "s-t"))) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    sent = [g for g in got if g]
    assert len(got) == 8 and len(sent) == 1 and guide.holds_lead(sent[0], "s-t")
    assert guide.take_if_owed(corpus, "s-t") is None


def test_the_guide_keeps_the_phrases_the_owner_s_prompts_must_keep(corpus):
    text = guide.render(corpus)
    assert not [p for p in MUST_KEEP if p not in text]


def test_guide_markers_and_files_are_private(corpus):
    assert activate.activate(corpus, "s-p", "data")["ok"]
    from app import userconf

    up = str(Path(userconf.global_file().parent) / "up")
    assert up in userconf.private_paths()
    assert f"Read(/{up}/**)" in userconf.private_rules()
    assert json.loads(activate.marker_path("s-p").read_text())["ws"]
