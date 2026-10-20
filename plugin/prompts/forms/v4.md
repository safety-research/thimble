# The card guide

This guide says what makes a good card, lists the toolkit a card's program is made of, and ends with worked programs
to adapt.

## What makes a good card

A card shows the analyst one finding: a question, the content that shows the answer, and a takeaway that answers the
question in a sentence or two, in words the analyst knows. The analyst reads the question and the takeaway, then checks
the takeaway against the content. So the takeaway claims only what the card shows and no more than the data holds, and
gives the one or two numbers it rests on, each with its base, as in "26 of the 53". A caveat comes after the answer,
and only when it changes what they would conclude.

```
Analyst   Which bus lines run late most often?
Good      takeaway   Line 12 Harbor ran late most often, on [212](r4#line=line-12-harbor@late) of its 930 trips,
                     nearly twice the share of the next line.
Bad       takeaway   Line 12 was late on 212 trips (22.8%), Line 7 on 118 and Line 30 on 97, with a mean of 3.4
                     minutes late (sd 2.9).
```

The bad takeaway gives six numbers, two of them without a base, so the analyst cannot tell which line is late most
often for its size.

**Let the shape of the claim choose the form.** There are no card kinds: you compose the form from the toolkit's parts,
and the right form lets the analyst see the answer at once. People read lengths and positions most accurately, so give
each value as a number and let the toolkit draw it.
- Counts by group read as bars, a trend as a plot, and exact values as a short table with a few columns.
- One long run reads as its stations in order (`k.map`), and several runs as strips on one axis, so the same moment
  lines up.
- How parts connect, such as the modules of a codebase or the steps of a pipeline, reads as a diagram on the canvas.
  A change to files reads as a map of where it touched them.
- A total the analyst should take apart reads as the pieces that add up to it. A result that rests on a choice, such
  as a threshold, reads best with the choice as a knob, so the analyst sees the answer change as they turn it.
- A why question wants a story, a timeline or a diagram, more than a count. Real records make a pattern believable:
  quote the passage that makes the point.

**Every part the analyst can select opens what it stands for.** Draw the whole first, and let the analyst open a part
for its records. A part they may ask about is a region whose meta names what it stands for: a query row, a record, or
the lines of a file (`ref: 'server/auth.py#L60-94'`). A part drawn from a row of a bound query output opens that row's
records by itself. A part that looks selectable and opens nothing leaves the analyst unsure what went wrong, so give
each region a ref, a cite or examples, or draw it as plain text.

**Use color for what the question needs, one encoding at a time.** Gray (`dim`) is for context and for "other". Name
each color where it stands, such as a bar part's `label`. Draw what you did not read with `k.unseen()`, so a gap does
not read as a zero.

**Answer with as few cards as the question needs.** Under your reply a card has about half a screen, and the detail
view (`k.mode === 'detail'`) has more room for more of the same. Lead with the card that answers most directly, then
the pattern or the records that support it: three or four cards that build on each other are easy to follow, and ten
are not. Say how you worked in a sentence, not in a card.

**A guide is one card with pages.** When the analyst asks to be taught something (an introduction, a tour, a
textbook), make one card whose page knob holds the chapters, as in `k.knob('chapter', { values: [1, 2, 3], label:
'chapter', fmt: v => `${v} of 3`, pages: true })`, and draw each page from the knob's value alone. Teach one idea per
page with a picture, such as a diagram of the parts, a flow, bars of sizes or a real record, and two or three sentences
that walk through it, with the parts of the picture opening the lines or rows behind them. A page of bullet points reads
as notes, not as a lesson. The dial and the bar turn the pages, so give the card no page keys and no key hints.

## The toolkit

A card's program is the body of a function `(k, data) => node`. `data` is the card's data, with query outputs bound in
it, and `k` is the toolkit. Return what to draw. The same program draws in the terminal, in cells, and in the browser,
with type and lines. It runs in a sandbox: it sees `k` and `data` and nothing else, and it runs start to end, with no
`await`. There are no chart types: the helpers below are made of the same parts, and when one does not fit, build your
own from `stack`, `beside` and the canvas.

```js
const total = data.days.reduce((s, d) => s + d.messages, 0)
return k.frame(k.stack(
  k.text(`**${k.fmt(total)}** messages in ${data.days.length} days`),
  k.bars(data.days.map(d => ({ id: 'day-' + d.day, label: d.day, value: d.messages }))),
), { title: 'Messages per day' })
```

**Text and layout.** `k.text(str, { tone, bold, align, wrap, max, w })`, where `str` may hold `**bold**`, `{dim:words}`
for a tone, and `[words](#id)` for a link to a part or a knob; `k.escape(s)` makes data safe to put in it.
`k.stack(...parts, { gap, align })` puts parts under each other, `k.beside(...)` side by side, and `k.frame(part,
{ title, right, bottom, tone })` draws a border with a title. A part may be a node, a string, a number, an array or
`false` (left out). `k.size(part, { w, grow })`, `k.space(w, h)` and `k.rule()` place them.

**Values.** A value given as a number stays a number: the browser draws it exactly, and the terminal rounds it to cells.
`k.bar(value, { max, tone })`, or `k.bar([{ value, tone, label }, ...], { max })` for stacked parts, each `label` drawn
inside its part when it fits. `k.bars(items, { max, labelW })` draws rows of label, bar, value and note, an item being
`{ id, label, value | parts, tone, note, meta }`. `k.spark(values, { min, max, tone, w })` is a one-line trend.
`k.plot(series, { h, x: { label, log, min, max }, y: {...}, dots, brush })` takes numbers, `[x, y]` pairs, or
`{ id, name, values | points, tone, meta }`. `k.table(rows, { cols, max, id, cite, examples })` takes `cols` as keys or
`{ key, label, align, fmt, tone, w }`. `k.unseen({ label, w, h })` draws what you did not read, hatched. `k.legend(items)`
is there for a color you cannot name where it stands.

**Parts the analyst can select.** `k.region(id, meta, part)` makes a part. The id names what the part is
(`day-06-18`), not where it sits, since a selection and a question about the part carry it, so keep ids when you change
the program. `meta` is a label or `{ label, ref, cite, examples, note, row, ... }`. A bar item, a stacked part, a table
row or a region's meta made from a row of a bound query output (the row, `{ ...row }` or `{ row: d }`) opens the records
behind that row. `k.cite(id, { text, source, query, rows, note })` and `k.examples(id, { label, records, total, fmt })`
register a citation or a set of real records and return the id, and a region points at them with `{ cite, examples }`.

**Knobs and keys.** `k.knob(id, { values, at, label, fmt })` returns the value the analyst set, else `at`; `values` is a
list (up to 2,000) or `{ min, max, step }`. `k.dial(id)` draws it as `label ◂ value ▸`, and a link `[words](#id)` is the
knob too. `k.on(name, fn, label)` answers a key (`'j'`), a press on a part (`'press:<id>'`) or a drag in the browser
(`'brush'`); `fn(event)` returns the new state, and the program runs again and reads it in `k.state`. In a handler,
`k.set(key, value)` sets one value, and `k.ask({ label, rows, text })` sends the analyst's next question to the card's
thread. A card gets its keys while it has the focus, and the bar shows each with the label you gave it, such as
`c flip · , . year`, so the card draws no key hints. Claude Code keeps ← and → in the terminal, and `0` goes back, so a
card never gets them; `thimble save` names a key a card cannot get.

**A map of work.** `k.map(spec, { full, lens })` lays work out by its own structure: `threads` (runs, agents) with their
`stops` or `moves`, `stations`, `links`, `groups`, and a `lens`, the thread field that colors the lanes. One thread draws
as a line of its stations, many as lanes that split and merge, and stations with no threads as boxes. Under a reply it
draws its short form, and in the detail its full form. Each station, lane and group opens its records.

**The canvas.** `const c = k.canvas(w, h)` draws a shape no helper has, in cells (x across, y down), and sits in a stack
or a frame like any part. `c.text(x, y, str, { tone, bold, align, max })`, `c.put(x, y, ch, tone)`, `c.fill(x, y, w, h,
ch, tone)`, `c.bg(x, y, w, h, tone)`, `c.hline` and `c.vline(x, y, len, ch, tone)` (`─` a line, `━` heavy, `╌` dashed),
`c.box(x, y, w, h, { title, tone, fill })`, `c.dot(x, y, tone, { size, label, part })` and `c.link(x0, y0, x1, y1, tone)`
for nodes and links, `c.bar(x, y, w, value, max, tone)` and `c.spark(x, y, values, { w, min, max, tone })` for values,
`c.region(id, x, y, w, h, meta)` for a part, and `c.brush(id, x, y, w, h, { min, max })` for a range a browser drag reads.

**Other.** `k.w` and `k.h` are the room in columns and rows, `k.mode` is `'inline'` under a reply and `'detail'` in the
detail view, `k.fmt(n, { dp, pct, sign, compact })` formats numbers people read, `k.len(s)` is a string's width, and
`k.cat(i)` is the i-th category tone. Tones name meanings: `ink`, `dim`, `accent`, `good`, `bad`, `warn`, `unseen`, and
`c1` to `c6` for categories; `c2-faint` is `c2`, stepped back.

**When something goes wrong.** `thimble save` checks each citation and binding, saves the card anyway, and lists each
problem: fix it and save again under the same name. A program that throws shows one line under the card's title with
the error and what to fix, and warnings come back with the drawing. To check a key or a press before the analyst tries it,
run the saved card with an event: `node ../../draw/cli.mjs thimble/objects/<id>.json --text --event
'{"type":"key","key":"f"}'`.

## Worked programs

Examples to adapt, not templates: each shows another form on another kind of data. Each program's data is in `forms/<name>.data.json` beside this file.

Counts by group, split by a label (edits to a wiki per day, by what each edit was for). Each day is a part that opens its records and real edits, and each piece is named where it stands.

```js
const P = [['ask', 'c1'], ['instruct', 'c3'], ['share', 'c2'], ['test', 'c5']]
const items = data.days.map(d => ({
  id: 'day-' + d.day, label: d.day.slice(5), parts: P.map(([p, tone]) => ({ value: d[p], tone, label: p })),
  meta: { ref: `r1#day=${d.day}@n`,
    examples: k.examples('ex-' + d.day, { label: `saves to other agents on ${d.day}`, records: d.examples, total: d.n, fmt: '“{text}”\n{user} · {purpose}' }) },
}))
return k.stack(
  k.text(`**${k.fmt(data.total)}** saves to other agents`),
  k.bars(items),
)
```

A trend and the moment that changed it (p95 latency of a service per hour, two regions, a deploy). The deploy sits on the axis where it landed, and each line opens its rows.

```js
const d = data.deploy
return k.stack(
  k.text(`eu-west's p95 rose from **${data.before} ms** to **${data.after} ms** after ${d.version} went out, and us-east stayed flat`),
  k.plot(data.regions.map((r, i) => ({ id: 'region-' + r.name, name: r.name, tone: i ? 'c3' : 'c1', points: r.hours.map(h => [h.hour, h.p95]), meta: { label: `${r.name}, p95 per hour`, ref: `r2#region=${r.name}@p95` } })),
    { h: k.mode === 'detail' ? 14 : 8, x: { label: 'hours from Jun 17 00:00', min: 0, max: 72, ticks: [0, 24, { at: d.hour, label: `▲ ${d.version}` }, 72] }, y: { label: 'p95 ms', min: 0 } }),
  k.region('deploy', { label: `${d.version} deployed ${d.label}`, ref: d.ref }, k.text(`{warn:▲} ${d.version} deployed ${d.label}`)),
)
```

Real records, quoted (support tickets). The passage of each record that makes the point, with what the analyst needs to place it; each opens the record.

```js
return k.stack(
  k.text(`**${k.fmt(data.n)}** of the ${k.fmt(data.total)} March refund tickets name the X200 charger. Three of them:`),
  ...data.tickets.map(t => k.region('ticket-' + t.id, { label: `ticket ${t.id}, ${t.date}`, ref: t.ref },
    k.beside(k.text('{c1:▎}', { w: 1 }), k.stack(k.text(`“${k.escape(t.quote)}”`, { wrap: true }), k.text(`{dim:${t.id} · ${t.date} · ${t.outcome}}`)), { gap: 1 }))),
  { gap: 1 })
```

One long run as its stations in order (an agent's transcript), each as wide as its share of the steps and each opening its lines. The data is the map's spec: the thread, its moves, and stations named after reading the run.

```js
return k.frame(k.map(data), { title: data.title })
```

A table kept small (a training sweep): six rows, four columns, the best row marked, each row opening its run.

```js
const best = data.runs.reduce((a, b) => (b.acc > a.acc ? b : a))
return k.stack(
  k.text(`The best run, **${best.run}**, reached ${best.acc}% with Adam at learning rate ${best.lr}`),
  k.table(data.runs.map(r => ({ ...r, note: r === best ? 'best' : r.acc < 75 ? 'diverged' : '' })), {
    cols: [{ key: 'run' }, { key: 'lr', label: 'learning rate', fmt: v => String(v) }, { key: 'batch' },
      { key: 'acc', label: 'val acc %', fmt: v => v.toFixed(1) }, { key: 'note', label: '', tone: v => (v === 'best' ? 'good' : 'bad') }],
    id: r => 'run-' + r.run }),
)
```

A knob that changes the answer (CI jobs that hung): the count rests on a threshold, so the threshold is a knob, and the strips and the count follow it.

```js
const t = k.knob('quiet', { values: [2, 5, 10, 20], at: 5, label: 'hung after', fmt: v => `${v} min quiet` })
const W = Math.max(20, Math.min(k.w - 20, 70))
const hung = data.jobs.filter(j => j.gaps.some(g => g.min >= t))
return k.stack(
  k.beside(k.text(`**${hung.length}** of ${data.jobs.length} jobs hung`), k.dial('quiet'), { gap: 3 }),
  ...data.jobs.map(j => {
    const c = k.canvas(W, 1)
    c.fill(0, 0, W, 1, '─', 'unseen')
    for (const g of j.gaps) {
      const x = Math.min(W - 1, Math.floor(g.at / j.minutes * W))
      c.fill(x, 0, Math.max(1, Math.min(W - x, Math.round(g.min / j.minutes * W))), 1, '█', g.min >= t ? 'bad' : 'c4-faint')
    }
    const longest = Math.max(...j.gaps.map(g => g.min))
    return k.region('job-' + j.id, { label: `${j.id}: quiet for ${longest} min at most`, ref: j.ref },
      k.beside(k.text(j.id, { w: 10 }), c, k.text(longest >= t ? '{bad:hung}' : '{dim:ran}', { w: 5 }), { gap: 1 }))
  }),
)
```

A guide in pages (a tour of a codebase): one idea per page, each a picture whose parts open the lines or rows behind them, and a few sentences that walk through it.

```js
const n = data.chapters.length
const ch = k.knob('chapter', { values: data.chapters.map((_, i) => i + 1), label: 'chapter', fmt: v => `${v} of ${n}`, pages: true })
const c = data.chapters[ch - 1]
const w = Math.max(14, Math.min(24, Math.floor((k.w - 3 * (c.steps?.length || 1)) / (c.steps?.length || 1))))
const picture = c.sizes
  ? k.bars(c.sizes.map(s => ({ id: 'size-' + s.id, label: s.label, value: s.lines, meta: { label: s.label, ref: s.ref } })))
  : k.beside(...c.steps.map((s, i) => k.region('step-' + s.id, { label: s.label, ref: s.ref },
      k.frame(k.text(s.does, { wrap: true, w: w - 2 }), { title: `${i + 1} ${s.label}`, tone: s.tone }))), { gap: 1 })
return k.stack(k.text(`**${c.title}**`), picture, k.text(c.text, { wrap: true }), { gap: 1 })
```

## A sequence of cards

When a question takes several cards, their order is part of the answer. Lead with the card that gives the analyst the picture they need, then the finding, then the records that make it believable.

```
Analyst   Why did refunds jump in March?
Reply     Refunds jumped because a batch of X200 chargers shipped on Feb 24 began failing in the first days of March,
          and nearly all of the extra refunds are for those chargers.
Cards     1  timeline   the shipment, the first failure reports, the peak and the recall, in order (the program below)
          2  bars       refunds per week by product: the jump is all X200, from about 20 a week to 140 after Mar 3
          3  records    three March X200 tickets, quoted: each says the charger died within days
```

The timeline of the first card:

```js
const W = Math.max(30, Math.min(k.w, 96)), n = data.events.length
const x = day => Math.round((day - data.from) / (data.to - data.from) * (W - 1))
const c = k.canvas(W, n + 2)
c.hline(0, 0, W, '─', 'dim')
c.text(0, n + 1, data.start, { tone: 'dim' })
c.text(W - 1, n + 1, data.end, { tone: 'dim', align: 'right' })
// the ticks and their stems first, then the labels over them, so no stem cuts a label
data.events.forEach((e, i) => { c.put(x(e.day), 0, '●', e.tone); if (i) c.vline(x(e.day), 1, i, '│', 'dim') })
data.events.forEach((e, i) => {
  const left = Math.max(0, Math.min(x(e.day), W - e.label.length))
  c.text(left, i + 1, e.label, { tone: e.tone === 'dim' ? 'ink' : e.tone })
  c.region('event-' + i, left, i + 1, e.label.length, 1, { label: e.label, ref: e.ref })
})
return c
```
