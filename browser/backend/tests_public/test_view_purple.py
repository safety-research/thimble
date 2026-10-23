"""The view check's note on purple (views.purple_note): a page that writes purple colours, which thimble keeps for
agents' work, gets a note naming them, never a failure; the worked examples write none."""
from __future__ import annotations

from app import views

PAGE = """<style>.human { color: #7c3aed } .agent { fill: var(--viz-1) } .x { background: rgba(168, 85, 247, .2) }</style>
<svg><circle fill="purple"/><rect fill="#025ac3"/></svg>
<script>const SPEAKER = { human: 'hsl(280 60% 50%)', bot: '#d0750a', link: '&#9658;' }</script>"""


def test_purple_colours_are_named_once_each():
    assert views.purple_colours(PAGE) == ["#7c3aed", "rgb(168, 85, 247)", "hsl(280, 60%, 50%)", "purple"]
    assert views.purple_colours("<style>.a { color: #025ac3; background: #f5f3ff }</style>") == []
