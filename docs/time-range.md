# Time in a view

Every view page has thimble's time range selector, `thimble.timeRange`, in its view kit. It is the one control for a
view's time: an overview of the data's whole span, its records over time in the Color by colors ([color.md](color.md)),
with a viewfinder over it, as a video editor's zoom bar or a music editor's arrangement navigator. Use it in place of a
fixed axis, "N before / N after" links, zoom buttons or a date menu of your own, so that every time view works the same
way.

- Drag the viewfinder to pan, and drag either of its edges, which show grips, to zoom. Drag across the overview outside
  it to frame a new range, or click outside it to move it there. A double click shows the whole span. Ctrl, ⌘ or Alt with
  the wheel (or a trackpad's pinch) zooms around the pointer; Shift with the wheel pans. With the viewfinder focused,
  the arrow keys pan, `+` and `-` zoom and Home shows the whole span.
- The part outside the viewfinder is dimmed. The readout gives the range's start, end and length in the data's units.
- Hovering the overview gives the time under the pointer and how many records lie there.
- The range opens on the whole span. thimble keeps a range zoomed in per view, with the Color by choice, and Reset in
  Color by's row brings back the whole span.
- Zoom is horizontal only: the time zooms, and the view's rows or lanes keep their height and scroll as a list.
- One readable axis: the overview carries light ticks, and at most a few labels while the viewfinder frames part of the
  span, none while it shows the whole span. The chart of the range below it holds the axis with its labels
  (`thimble.timeAxis`).
- Point events, such as a context compaction, are flags: a pin on the overview with its label on hover, and on the
  chart's axis a pin with its label at a readable size; hovering it lets the chart draw a faint guide line through
  itself.

[plugin/viewers/colour-by](../plugin/viewers/colour-by) uses it above its list.

## Mount it

```html
<div class="top"><input class="field" id="q" type="search"><span id="colour"></span></div>
<div id="range"></div>
<div id="axis"></div>
<div id="lanes"></div>
<script>
const colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }], onChange: draw })
const range = thimble.timeRange({
  mount: '#range',
  times: rows.map((r) => r.t),                 // seconds since 1970
  values: (i) => colour.valueOf(rows[i]),      // each record's Color by value, for the overview's colors
  gap: 3600,                                   // an hour with no record is drawn as a narrow break
  marks: [{ t: compaction, label: 'context compaction' }],
  onChange: draw,
})

function draw() {
  const scale = range.scale(document.getElementById('lanes').clientWidth)
  thimble.timeAxis('#axis', scale, { marks: [{ t: compaction, label: 'context compaction' }], onMark: (m, x) => guide(x) })
  const bins = scale.bins(3)                   // the chart's bins, each at least 3 px wide
  for (const r of rows) if (range.has(r.t)) { /* count r in bins[scale.binOf(r.t)], draw it at scale.x(r.t) */ }
}
</script>
```

| option | what it is |
|---|---|
| `mount` | an element or a selector the control fills, as wide as the time the view draws below it. The readout stands at its left, above the overview when the mount is narrow. |
| `times` | each record's time, an array or a typed array |
| `values` | each record's Color by value, an array beside `times` or a function of the record's index; by default `colour.valueOf(i)` |
| `bins` | counts already binned, in place of `times`: `{from, step, counts}`, `counts[i]` a number or `{value: n}` for the bin starting at `from + i * step` |
| `span` | the whole span `[first, last]`, when it is not that of `times` or `bins` |
| `unit` | `'s'` seconds since 1970 (the default), `'ms'`, or `'n'` a plain number such as a row or a turn |
| `utc` | times shown in UTC (the default); `false` shows them in the browser's zone |
| `gap` | an empty stretch longer than this, in the units, is drawn as a narrow break on the overview and on the range's scale |
| `marks` | point events, `[{t, label, colour?}]`, drawn as flags |
| `min` | the shortest range, in the units |
| `height` | the overview's height in px, 28 by default |
| `readout` | `false` for none, or an element or a selector to put it in |
| `key` | the name thimble keeps the range under, `'time'` by default; give each control of a page its own |
| `onChange(range)` | the range settled: after a drag, a wheel, a click, a double click, `set()` or Reset. Draw what lies between `range.from` and `range.to`. |
| `onInput(range)` | while the viewfinder moves, for a page that can draw that fast |
| `onMark(mark, range)` | a flag on the overview hovered (`null` when the pointer leaves it) |

## The control

| member | what it gives |
|---|---|
| `from`, `to` | the range's start and end, in the data's units |
| `full` | whether it shows the whole span |
| `span` | the whole span, `[first, last]` |
| `has(t)` | whether a time lies in the range |
| `set(from, to)`, `set(null)`, `fit()` | the range set, or the whole span; `onChange` follows |
| `data({times, values, bins, span, marks, gap})` | new data, any of them, such as after a filter; the range is kept where it can be |
| `scale(width)` | the scale of the range across `width` px, with the overview's breaks: `{from, to, width, broken, x(t), t(x), ticks(px), bins(px), step(px), binOf(t), gaps()}` |
| `format(t, step?)` | a time in the readout's words, as precise as `step` needs |
| `redraw()` | the overview drawn again, after the page changed what its values mean |

Draw the chart of the range on `range.scale(width)`, so its bins and its ticks match the overview and every chart of the
view at that width reads as a small multiple of the same time: a row's strip, a lane and the main chart take the same
`scale.bins(px)`.

`thimble.timeAxis(mount, scale, {marks, onMark, px})` draws the chart's axis in `mount`, an element as wide as the
chart: its ticks with labels at least `px` (72) apart, a `//` at each break, and the marks as flags on a row under it,
each with its label; `onMark(mark, x)` hears a flag hovered, with its px on the chart, and `onMark(null)` when the
pointer leaves it.
