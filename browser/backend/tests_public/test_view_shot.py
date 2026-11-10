"""A view's page measured headless (scripts/view_shot.mjs, through views.shoot_page): what a state reports is its page
once the page is done. A page that loads its rows again late is waited for and measured again: when its thread was busy
while it seemed quiet, when the check of the label marks scrolled it, and when it began while the measurement ran.

The page (PAGE) draws one row per record its fetch answers, and loads them again once, in the way its state's `open`
names (`how`). Its fetches after the first are answered late (LATE_S), so a measurement taken while it loads again
finds a page without its rows. The test runs the real script in the headless Chromium, and is skipped where a view
cannot be loaded."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app import views

PAGE = """<!doctype html>
<style>
  body { margin: 0; font: 13px sans-serif; }
  .row { height: 24px; line-height: 24px; padding-left: 12px; white-space: nowrap; }
</style>
<div id="rows"></div>
<script>
  const box = document.getElementById('rows')
  let loads = 0
  async function load() {
    const refs = await thimble.fetch({ load: ++loads })
    box.replaceChildren(...refs.map((ref) => {
      const row = document.createElement('div')
      row.className = 'row'
      row.setAttribute('data-anchor', ref)
      row.textContent = ref
      return row
    }))
  }
  function again() {
    box.replaceChildren()
    load()
  }
  thimble.onOpen(async (place) => {
    await load()
    // its thread is busy for a while, and it loads again a moment after
    if (place.how === 'busy')
      setTimeout(() => {
        const until = Date.now() + 2500
        while (Date.now() < until);
        setTimeout(again, 300)
      }, 100)
    // it loads again when it is scrolled, as the check of the label marks scrolls it
    if (place.how === 'scroll') addEventListener('scroll', again, { once: true })
    // it loads again when a font has loaded, as the font the measurement loads does
    if (place.how === 'font') document.fonts.addEventListener('loadingdone', again, { once: true })
  })
</script>
"""
LATE_S = 0.7  # under the second after which the bridge shows that a fetch is running
ROWS = [f"log.jsonl#L{n}" for n in range(1, 13) if n % views.PROBE_EVERY]
# the one row the test label marks comes last, below the pane's fold
BELOW = [f"log.jsonl#L{n}" for n in range(1, 60) if n % views.PROBE_EVERY][:40] + [f"log.jsonl#L{views.PROBE_EVERY}"]


async def test_a_page_that_loads_again_late_is_measured_once_it_is_done(tmp_path):
    if views.build_problem():
        pytest.skip("a view cannot be loaded here")
    folder = tmp_path / "rows"
    folder.mkdir()
    (folder / views.VIEW_HTML).write_text(PAGE, "utf-8")
    doc = views.frame_document({"dir": str(folder), "slug": "rows", "name": "Rows"})
    probe = views.probe_context()
    states = [({"open": {"how": "busy"}, "out": tmp_path / "busy.png"}, ROWS, views.NO_LABELS),
              ({"open": {"how": "scroll"}}, BELOW, probe),
              ({"open": {"how": "font"}, "out": tmp_path / "font.png"}, ROWS, views.NO_LABELS),
              ({"open": {}, "sweep": True}, ROWS, views.NO_LABELS)]

    async def answer(kind, i, msg):
        _state, rows, ctx = states[i]
        if kind == "fetch":
            if (msg.get("query") or {}).get("load", 1) > 1:
                await asyncio.sleep(LATE_S)
            return {"data": rows}
        if kind == "marks":
            marks = {r: m for r in msg.get("refs") or [] if (m := views._record_mark(ctx, r)) is not None}
            return {"marks": marks, **views._state_labels(ctx)}
        return {"error": "the page has no media"}

    shots = await views.shoot_page(doc, [s for s, _rows, _ctx in states], answer, width=800, height=700)
    if any(s.get("unavailable") for s in shots):
        pytest.skip("no headless browser here")
    assert all(s["ok"] and not s["errors"] for s in shots), [s["errors"] for s in shots]
    busy, scroll, font, sweep = shots
    # busy: the page seemed quiet while its thread was busy, and loaded again once it was free
    assert (busy["fetches"], busy["shown"]["records"]) == (2, len(ROWS))
    # scroll: the marks are looked at again once the rows are back, and so are the counts
    assert (scroll["fetches"], scroll["shown"]["records"]) == (2, len(BELOW))
    assert (scroll["shown"]["due"], scroll["shown"]["drawn"]) == (1, 1)
    painted = scroll["painted"] or {}
    assert [painted.get(k) for k in ("due", "checked", "seen", "unseen")] == [1, 1, 1, []]
    # font: the picture and the counts are taken again once the page that began to load under them is done
    assert (font["fetches"], font["shown"]["records"]) == (2, len(ROWS))
    assert Path(font["png"]).is_file()
    # a state that tries the controls' choices reports them, and none of the counts of a state of its own
    assert sweep["choices"] == [] and sweep["records"] == len(ROWS)
    assert not {"shown", "layout", "controls", "label_controls", "painted"} & set(sweep)
