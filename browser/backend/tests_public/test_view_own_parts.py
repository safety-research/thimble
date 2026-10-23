"""The view check's note on thimble's parts (views.own_parts_note): a page whose styles change how thimble's chips,
buttons, segmented controls or fields look, or draw rounded chips of their own, gets a note naming each rule, never a
failure; laying the parts out is fine, and the worked examples get none."""
from __future__ import annotations

import asyncio
from pathlib import Path

from app import views

PAGE = """<style>
  /* the page's own layout of thimble's parts: no note */
  .search .field { width: 100%; padding-left: 27px; }
  .bar .btn { margin-left: auto; }
  .chips { display: flex; gap: 4px; }
  .chipf { max-width: 200px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  .avatar2 { width: 24px; height: 24px; padding: 2px; border-radius: 50%; background: #eee; }
  .pop { padding: 4px; border-radius: var(--radius-card); background: var(--raised-bg); }
  .switch { width: 24px; height: 14px; border-radius: 7px; background: #ccc; }
  .key { height: 24px; padding: 0 6px; border: 1px solid var(--border-subtle); border-radius: var(--radius-chip); }
  /* thimble's parts restyled */
  .chip { border-radius: 999px; }
  .dacts .chip:hover { color: var(--text-primary); }
  .fbtn.field { display: inline-flex; gap: 6px; }
  .fbtn.is-set { background: var(--surface-selected); }
  @media (max-width: 600px) { .seg-opt { font-size: 11px; } }
  /* chips of the page's own, rounder than a chip */
  .tag { padding: 1px 8px; border-radius: 999px; background: var(--surface-selected); }
  .tab { display: inline-flex; height: 26px; padding: 0 9px; border: 1px solid #ddd; border-radius: var(--radius-ui); }
</style>
<button class="field fbtn">Wiki</button><span class="tag">dse</span>"""


def test_restyled_parts_and_round_chips_are_named_and_layout_is_not():
    found = views.own_parts(PAGE)
    assert found == [
        "`.chip` sets border-radius",
        "`.dacts .chip:hover` sets color",
        "`.fbtn.is-set` sets background",
        "`.seg-opt` sets font-size",
        "`.tag` draws a chip with border-radius 999px",
        "`.tab` draws a chip with border-radius var(--radius-ui)",
    ]
    assert views.own_parts("<style>.search .field { width: 100% } .lane .btn { flex: none }</style>") == []
    assert views.own_parts("<p>no styles</p>") == []


def test_the_row_controls_side_panel_and_transcript_are_thimble_s_parts_too():
    """A page lays out Filter by, Rows, the lanes, the side panel and the transcript (viewer_parts.css) but does not
    change how they look."""
    css = ("<style>#filter { margin-left: auto } .thimble-side { min-width: 300px } .thimble-lanes { flex: 1 }"
           " .thimble-lane-name { color: red } .thimble-side-head { background: #eee } .thimble-turn-head { font-size: 14px }"
           " .thimble-filter-chip { border-radius: 999px }</style>")
    assert views.own_parts(css) == [
        "`.thimble-lane-name` sets color",
        "`.thimble-side-head` sets background",
        "`.thimble-turn-head` sets font-size",
        "`.thimble-filter-chip` sets border-radius",
    ]


def test_the_record_card_is_one_of_thimble_s_parts():
    """A page lays out the kit's record card (viewer_kit.css .thimble-card) and its column or grid, but does not give it
    corners, an edge or a color of its own, such as a colored side stripe in place of Color by's bar."""
    css = ("<style>.col .thimble-card { margin: 0 0 6px } .thimble-cards { gap: 8px; background: #f4f4f4 }"
           " .thimble-cards-grid { --thimble-tile-w: 180px } .thimble-card-title { -webkit-line-clamp: 3 }"
           " .thimble-card { border-radius: 12px } .thimble-card.hot { border-left: 3px solid #d0750a }"
           " .thimble-card-key { color: #d0750a }</style>")
    assert views.own_parts(css) == [
        "`.thimble-card` sets border-radius",
        "`.thimble-card.hot` sets border-left",
        "`.thimble-card-key` sets color",
    ]


def test_the_search_table_and_diff_are_thimble_s_parts_too():
    """A page sets the search's width and the table's and the diff's place, but does not change how they look."""
    css = ("<style>#search .thimble-search { width: 320px } .thimble-table-host { flex: 1 } .thimble-diff-host { margin: 8px }"
           " .thimble-table-row { background: #fafafa } .thimble-diff-ins { color: green } .thimble-search { border-radius: 999px }</style>")
    assert views.own_parts(css) == [
        "`.thimble-table-row` sets background",
        "`.thimble-diff-ins` sets color",
        "`.thimble-search` sets border-radius",
    ]


def test_the_text_is_thimble_s_part_too():
    """A page sets the text's width and place, but does not change how it or its links look."""
    css = ("<style>#body .thimble-text { max-width: 720px; margin: 0 auto } .thimble-text-ref { color: crimson }"
           " .post .thimble-text { font-family: serif }</style>")
    assert views.own_parts(css) == [
        "`.thimble-text-ref` sets color",
        "`.post .thimble-text` sets font-family",
    ]


def test_the_note_names_them_and_the_worked_examples_get_none():
    note = views.own_parts_note(PAGE)
    assert "`.chip` sets border-radius" in note and "and 2 more" in note and "chip-key" in note
    assert views.own_parts_note("<style>.search .field { width: 100% }</style>") == ""
    for name in ("timeline", "linked-sessions", "repository"):
        assert views.own_parts((views.EXAMPLES_DIR / name / "view.html").read_text("utf-8")) == [], name


def test_the_gate_adds_the_note(tmp_path, monkeypatch):
    """The gate's report carries the note beside its checks, and a pass stays a pass."""
    d = tmp_path / "board"
    d.mkdir()
    (d / views.VIEW_JSON).write_text('{"name": "Board", "claims": ["*.jsonl"]}')
    (d / views.READER_PY).write_text("")
    (d / views.VIEW_HTML).write_text(PAGE)
    monkeypatch.setattr(views, "views_dir", lambda c: tmp_path)
    monkeypatch.setattr(views, "source_problems", lambda *a, **k: [])

    async def no_libs(c, slug, d, libs):
        return {"problems": [], "notes": []}

    async def passed(c, slug, locators, **kw):
        return {"ok": True, "problems": [], "checks": [], "page": None}

    async def no_media(html):
        return ""

    monkeypatch.setattr(views.view_libs, "ensure", no_libs)
    monkeypatch.setattr(views, "check", passed)
    monkeypatch.setattr(views, "media_note", no_media)
    monkeypatch.setattr(views, "read_proposal", lambda c, slug: None)
    report = asyncio.run(views._gate("ws", "board", None, shot_dir=None, picture=False))
    assert report["ok"] is True
    assert any("`.chip` sets border-radius" in n for n in report["notes"])
