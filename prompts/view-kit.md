{{if:browser}}
The view kit draws the parts that views share. Use a part where the view needs one, rather than drawing your own, and leave out the parts it does not need. Draw no color control, legend that restates the chips, label menu, zoom buttons, date presets or paging text of your own. Each snippet below shows one part. `{{docs}}/color.md`, `{{docs}}/time-range.md`, `{{docs}}/rows-and-filters.md`, `{{docs}}/search-table-diff.md` and `{{docs}}/charts.md` give every option and the reader's side of each part.

Color by, the one color control, in the top row of every view. It colors records, and `strip` gives a long list a strip of their colors with a loupe:

```js
const colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }], strip: '#list', onChange: draw })
list.innerHTML = recs.map((r) => `<div class="list-row" data-anchor="${r.ref}"${colour.attr(r)}>${r.title}</div>`).join('')
colour.counts(data.counts)                                 // the reader's {value: n}, '' for no value
mark.setAttribute('fill', colour.colourOf(r.kind) || gray) // a mark the page draws; null for no value and for Off
```

A group of records, such as a session or a page, takes no color of its own and shows the mix of its records' colors:

```js
thimble.mix(groupRow.querySelector('.mix'), counts)       // counts: {value: n}
```

Filter by, beside Color by. It is the only part that hides records:

```js
const filter = thimble.filterBy({ mount: '#filter', fields: [{ name: 'outcome', title: 'Outcome' }], onChange: draw })
const shown = recs.filter((r) => filter.keeps(r))
```

Rows, what the rows, lanes or tree group by: a field, a tree of fields or a label:

```js
const rows = thimble.rows({ mount: '#rows', fields: [{ name: 'team', title: 'Team', parentOf: (t) => parents[t] }], onChange: draw })
for (const g of rows.groups(shown)) drawGroup(g.guide + g.name, g.items)   // g.guide is its tree guide, such as '├ '
```

The search, in the top row. It finds text in every part on the screen, folded text included, and ticks the matches on each list's strip. A page that keeps only the matching records says which it kept:

```js
const search = thimble.search({ mount: '#search', in: '#body', onChange: draw })   // search.text, search.has(text)
search.kept(shown.map((r) => r.ref))                       // after drawing the records kept for search.text
```

The time range, when the task is about time, and its chart's axis:

```js
const range = thimble.timeRange({ mount: '#range', times: recs.map((r) => r.t), onChange: draw })
thimble.timeAxis('#axis', range.scale(chart.clientWidth)) // scale.x(t); range.has(t)
```

The timeline, a lane per group of Rows on one axis of times or of numbers, such as turns or scores:

```js
const tl = thimble.timeline({ mount: '#lanes', rows, range, end: (r) => r.t + r.secs, onMark: (r) => show(r) })
tl.draw(shown.filter((r) => range.has(r.t)))               // with no range, its own axis; unit: 'n' for numbers
```

A key for the series a chart draws beside Color by's colors, each entry a toggle:

```js
const key = thimble.key('#key', [{ id: 'median', name: 'Median', mark: 'line', n: 12 }], { onChange: draw })   // key.isOn('median')
```

The divider, a bar the analyst drags between an overview and the part under it:

```js
thimble.divider({ top: '#overview' })
```

The side panel, where a record or a group's records open beside the rest, never under a row:

```js
const side = thimble.side({ mount: '#body' })
side.open({ title: r.title, sub: r.path, ref: r.ref, render: (body) => thimble.record({ mount: body, value: r, ref: r.ref }) })
```

The tree, groups to navigate beside the records, such as channels, folders, files or pages, each with its count:

```js
const tree = thimble.tree({ mount: '#pages', split: '/', find: true, items: pages.map((p) => ({ key: p.path, n: p.edits })), onPick: (node) => pick(node.key) })
```

The table, thousands of records in columns that a click sorts, each row one line, or two where a column has a `sub`, as an inbox draws them. A row opens in the side panel:

```js
const table = thimble.table({ mount: '#list', rows: mails, columns: [{ name: 'from', title: 'From' }, { name: 'subject', title: 'Subject', sub: (m) => m.preview }, { name: 't', title: 'Date', type: 'time' }], side, search, filter })
table.draw()                                               // again in Filter by's onChange
```

A record as a card, or as a tile in a grid. Its only color is the bar that Color by draws on its left edge, so give it no side stripe, colored edge or corners of your own:

```js
grid.innerHTML = '<div class="thimble-cards-grid">' + recs.map((r) => thimble.recordCard({ ref: r.ref, record: r, key: r.id, title: r.title, body: r.summary })).join('') + '</div>'
```

One record's fields as a tree under its citation, such as in the side panel:

```js
thimble.record({ mount: body, value: r, ref: r.ref, find: search.text })
```

A record's text, such as a pull request's body or an email, as markdown or plain text with its links:

```js
thimble.text(body, pr.body, { ref: pr.ref, mentions: [{ match: /#(\d+)/g, ref: (m) => 'view:forge/pull/' + m[1] }] })
const html = thimble.text.html(mail.body, { format: 'plain' })   // for a card's body or a table's cell
```

An agent's turns, as the File browser draws them:

```js
const tr = thimble.transcript({ mount: '#list' })
tr.draw(turns, { title: session.name })                    // a turn: {ref, t, speaker, kind, tool, text, error}
```

Messages between people or agents, as a chat app, a forge's conversation or a mail thread draws them:

```js
const conv = thimble.messages({ mount: '#thread', onPick: (m) => show(m) })
conv.draw(posts.map((p) => ({ ref: p.ref, t: p.t, author: p.author, text: p.text, parent: p.reply_to })), { title: '# ' + channel })
```

Two versions of a text, or a patch such as a commit's, side by side or inline, the changed words marked:

```js
const diff = thimble.diff({ mount: '#diff', before: older.text, after: newer.text, titles: ['Revision 41', 'Revision 42'], ref: newer.ref })
thimble.diff({ mount: box, patch: commit.diff, ref: commit.ref })   // a unified patch in place of before and after
```

A chart of a card's `thimble.chart` kinds (bar, line, area, scatter, dots, box, histogram, density, ecdf, range or heatmap) in the canvas's style, its groups in Color by's colors. Name `vega-embed` in view.json's `libs`:

```js
thimble.chart('#chart', 'bar', counts.map((c) => ({ Agent: c.agent, Posts: c.n })), { colour, height: 140, onPick: (row) => pick(row.Agent) })
```

Reset, at the end of Color by's row, puts the page's own state back too:

```js
thimble.onReset({ changed: () => open != null, reset: () => { open = null; draw() } })
```

The Labels pane's filter, and the choices of Color by and Filter by that the page passes with its fetch (`colour.query()`, `filter.query()`), in the reader:

```python
if not thimble.kept(ref): continue                         # the record is filtered out
value = thimble.colour_value(query.get("colour"), ref, r)  # a field's value, or a label's value on ref
if not thimble.colour_on(query.get("filter"), thimble.colour_value(query.get("filter"), ref, r)): continue
```
{{end}}
