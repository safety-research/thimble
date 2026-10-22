"""The card check's red ✕ for numbers a card's code types in (card_check.typed_numbers) compares them with the numbers the
card shows (shown_numbers). A chart shows the rows of its table, so the heights typed in to place event notes over its
bars are no data, while bars whose counts are typed in still are (live QA 3: a merges chart with three events called
out got the ✕ for its notes' heights 39, 36 and 33)."""
from __future__ import annotations

import altair as alt
import pandas as pd

from app import card_check

EVENTS = '''events = pd.DataFrame([
    ("2026-08-28 07:40", "Wave 2: every open PR has an owner", 39, "left", 4),
    ("2026-08-28 09:42", "Manager merges 11 approved PRs", 36, "left", 4),
    ("2026-08-28 12:49", "Freeze: 7 PRs for one bug", 33, "right", -4),
], columns=["t", "event", "y", "align", "dx"])
'''
COMPUTED = 'b = d.groupby("bin").size().rename("merged").reset_index()\n'
TYPED = 'b = pd.DataFrame({"bin": pd.date_range("2026-08-28 07:30", periods=4, freq="30min"), "merged": [21, 34, 27, 12]})\n'
LAYERS = '''bars = alt.Chart(b).mark_bar().encode(x="bin:T", y="merged:Q")
rules = alt.Chart(events).mark_rule().encode(x="t:T")
notes = alt.Chart(events).mark_text().encode(x="t:T", y="y:Q", text="event:N")
alt.layer(bars, rules, notes)
'''


def _cell(code: str) -> dict:
    """A plot card of `code` and the chart it draws: four half-hour bars and three event notes placed by height."""
    b = pd.DataFrame({"bin": pd.date_range("2026-08-28 07:30", periods=4, freq="30min"), "merged": [21, 34, 27, 12]})
    events = pd.DataFrame([("2026-08-28 07:40", "Wave 2: every open PR has an owner", 39, "left", 4),
                           ("2026-08-28 09:42", "Manager merges 11 approved PRs", 36, "left", 4),
                           ("2026-08-28 12:49", "Freeze: 7 PRs for one bug", 33, "right", -4)],
                          columns=["t", "event", "y", "align", "dx"])
    chart = alt.layer(alt.Chart(b).mark_bar().encode(x="bin:T", y="merged:Q"),
                      alt.Chart(events).mark_rule().encode(x="t:T"),
                      alt.Chart(events).mark_text().encode(x="t:T", y="y:Q", text="event:N"))
    return {"id": "c1", "kind": "plot", "code": code,
            "outputs": [{"application/vnd.vegalite.v6.json": chart.to_dict(), "text/plain": "<VegaLite 6 object>"}]}


def _typed(code: str) -> list[str]:
    cell = _cell(code)
    return card_check.typed_numbers(cell["code"], card_check.shown_numbers(cell))


def test_the_heights_that_place_a_chart_s_event_notes_are_not_numbers_it_shows():
    assert _typed(COMPUTED + EVENTS + LAYERS) == []


def test_a_chart_whose_bar_counts_are_typed_in_still_gets_the_red_x_for_those_counts_alone():
    assert _typed(TYPED + EVENTS + LAYERS) == ["21", "34", "27", "12"]


def test_a_table_s_numbers_are_still_all_shown():
    cell = {"outputs": [{"text/html": "<table><tr><td>39</td><td>1,071</td></tr></table>", "text/plain": "39 1071"}]}
    assert {"39", "1071"} <= card_check.shown_numbers(cell)
