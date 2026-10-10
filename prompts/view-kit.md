The view kit draws the parts that views share. Use a part where the view needs one, rather than drawing your own, and leave out the parts it does not need. Draw no color control, legend that restates the chips, label menu, zoom buttons, date presets or paging text of your own. Each snippet below shows one part. `{{docs}}/color.md`, `{{docs}}/time-range.md` and `{{docs}}/rows-and-filters.md` give every option and the reader's side of each part.

Color by, the one color control, in the top row of every view. It colors records, and a group of records shows only their mix:

```js
const colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }], strip: '#list', onChange: load })
list.innerHTML = recs.map((r) => `<div class="list-row" data-anchor="${r.ref}"${colour.attr(r)}>${r.title}</div>`).join('')
colour.counts(data.counts)                                 // the reader's {value: n}, '' for no value
mark.setAttribute('fill', colour.colourOf(r.kind) || gray) // a chart's mark; null for no value and for Off
groupRow.querySelector('.mix').innerHTML = thimble.mix(counts)
```

Filter by, beside Color by. It is the only part that hides records:

```js
const filter = thimble.filterBy({ mount: '#filter', fields: [{ name: 'outcome', title: 'Outcome' }], onChange: draw })
const shown = recs.filter((r) => filter.keeps(r))
```

Rows, what the rows or lanes are grouped by: a field, a tree of fields or a label:

```js
const rows = thimble.rows({ mount: '#rows', fields: [{ name: 'team', title: 'Team', parentOf: (t) => parents[t] }], onChange: draw })
for (const g of rows.groups(shown)) drawGroup(g.guide + g.name, g.items)   // g.guide is its tree guide, such as '├ '
```

The time range, for anything on a time axis, and the axis of its chart:

```js
const range = thimble.timeRange({ mount: '#range', times: recs.map((r) => r.t), gap: 3600, marks: [{ t: cut, label: 'outage' }], onChange: draw })
const scale = range.scale(chart.clientWidth)               // scale.x(t), scale.bins(3), range.has(t)
thimble.timeAxis('#axis', scale)
```

The lanes, one lane per group of Rows on the range's scale:

```js
const lanes = thimble.lanes({ mount: '#lanes', rows, range, end: (r) => r.t + r.secs, problem: (r) => r.failed, onMark: (r) => show(r) })
lanes.draw(shown.filter((r) => range.has(r.t)))
```

The side panel, where a record or a row's children open, never under the row:

```js
const side = thimble.side({ mount: '#body' })
side.open({ title: r.title, sub: r.path, ref: r.ref, render: (body) => details(body, r) })
```

A record as a card, or as a tile in a grid:

```js
grid.innerHTML = '<div class="thimble-cards-grid">' + recs.map((r) => thimble.recordCard({ ref: r.ref, record: r, key: r.id, title: r.title, body: r.summary })).join('') + '</div>'
```

An agent's turns, as the File browser draws them:

```js
const tr = thimble.transcript({ mount: '#list', colour })
tr.draw(turns, { title: session.name })                    // a turn: {ref, t, speaker, kind, tool, text, error}
```

A key for the series a chart draws beside Color by's, each a toggle; the divider between an overview and the list; Reset for the page's own state:

```js
const key = thimble.key('#key', [{ id: 'median', name: 'Median', mark: 'line', n: 12 }], { onChange: draw })
thimble.divider({ top: '#overview' })
thimble.onReset({ changed: () => open != null, reset: () => { open = null; draw() } })
```

The Labels pane's filter and Color by's value, in the reader:

```python
if not thimble.kept(ref): continue                         # the record is filtered out
value = thimble.colour_value(query.get("colour"), ref, r)  # a field's value, or a label's value on ref
```
