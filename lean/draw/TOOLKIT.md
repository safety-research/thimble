# Drawing an object

An object is something you make for the person: a summary, a chart, a map, a table. You write it as a short
program. The same program draws in the terminal, in cells, and in the browser, with type and lines. You do not
choose a chart type. You compose what this object needs from a few parts.

A program is the body of a function `(k, data) => node`. `data` is the object's data. `k` is the toolkit. Return
what to draw:

```js
const total = data.days.reduce((s, d) => s + d.messages, 0)
return k.frame(k.stack(
  k.text(`**${k.fmt(total)}** messages in ${data.days.length} days`),
  k.bars(data.days.map(d => ({ id: 'day-' + d.day, label: d.day, value: d.messages }))),
), { title: 'Messages per day' })
```

The program runs in a sandbox. It sees `k` and `data` and nothing else: no files, no network, no clock. It runs
start to end, with no `await`.

## Principles

**Give values as values.** `k.bar(132, { max: 1546 })` keeps the number 132, so the browser draws the bar exactly
and the terminal rounds it to whole cells. A bar painted cell by cell is only cells, and the browser can only copy
them. Use `bar`, `spark`, `plot` and `table` whenever the thing is a number or a series.

**Compose freely.** `stack` puts parts under each other, `beside` puts them side by side, `frame` draws a border
with a title. They nest to any depth. `bars`, `legend` and `dots` are compositions of the parts below, written for
you. If they do not fit, build your own the same way.

**Use the canvas when the shape is yours.** A map of runs, lanes of a timeline, a flow from causes to outcomes:
no helper has these shapes, so draw them on `k.canvas(w, h)`. The canvas is a normal part. It sits in a `stack`
or a `frame` like any other. On a canvas, prefer `c.text`, `c.bar` and `c.spark` to single cells, so the values
stay values there too.

**Name the parts a person may ask about.** Wrap each one in `k.region(id, meta, node)`. The id names what the
part is, such as `day-06-18`, `run-sgd-b32-lr5.7` or `flow-timezone-fixed`, not where it sits. A selection, a
link to the browser and a question about the part all carry this id. Keep the ids when you change the program, so
a selection still finds its part.

**Rows of the data keep their lineage.** Each row the kernel bound into `data` knows its source rows. A bar item, a
table row or a region meta made from such a row (the row, `{ ...row }`, or `{ row: d }`) is a part that opens those
rows, with real examples spread across them. A part with none is matched to the rows whose words it shows.

**Answer what the person does.** `k.on(name, fn, label)` takes a key (`'j'`, `'space'`), a press on a part
(`'press:<id>'`, or `onPress` in a region's meta) or a drag in the browser (`'brush'`, from `k.plot(…, { brush:
'id' })` or `c.brush`). `fn(event)` returns the new state; the program runs again and reads it in `k.state`. The
terminal and the browser keep the same state. A knob is the same thing with ◂ ▸ built in.

**Cite what you state.** A number the person reads should say where it came from:
`k.cite(id, { text, source, query, rows, more, note })`. Give the query you ran and a few of the real rows. When
the person would want to see real records, attach them: `k.examples(id, { label, records, total, fmt })`. A region
points at both: `{ cite: 'day-06-18', examples: 'saves-06-18' }`. In text, `[1,546](#day-06-18)` links words to a
cite or a region.

**Let the person turn what you assumed.** When a result rests on a choice (a threshold, a scale, a split, which step
of a run), make the choice a knob: `const s = k.knob('scale', { values: [1, 2, 4, 8], at: 8 })`. The program reads
the value and draws what follows from it, words included. The person turns it with ◂ ▸ and the program runs again
with the new value. Show the knob where it acts, with `k.dial('scale')` or a link `[◂ ×8 ▸](#scale)` in a sentence.
One knob is usually enough; a view with several is harder to read.

**Draw what is not in hand.** Files you did not read, rows you could not get: draw them with `k.unseen()`, hatched,
not as a blank or a footnote.

**Keep it calm.** One title. Color only where it means something, and label it in place rather than in a legend: a
bar part's `label` is drawn inside the part when it fits, and a line or a dot can end with its own name. No
decoration. Short labels. Leave out what the person does not need for this question.

**Fit the width.** The object has `k.w` columns. Add detail only when there is room: `if (k.w >= 100) ...`. The
terminal and the browser both lay the parts out to the width they have.

**Add any metadata you need.** A region's meta and a cite keep every extra field you give them, such as
`{ label: 'Thu Jun 18', lineage: {...}, confidence: 0.8 }`. Nothing is checked against a schema.

## The toolkit

Text and layout:

- `k.text(str, { tone, bold, align, wrap, max, w })`. In `str`: `**bold**`, `{dim:words}` for a tone, and
  `[words](#id)` for a link. `k.escape(s)` makes data safe to put in markup.
- `k.stack(...parts, { gap, align })` and `k.beside(...parts, { gap, align })`. A part may be a node, a string, a
  number, an array (a stack), or `false` (left out).
- `k.frame(part, { title, right, bottom, tone })`.
- `k.size(part, { w, grow })` fixes a width in columns or lets a part take spare width. Most helpers also take
  `w` and `grow` directly.
- `k.space(w, h)`, `k.rule()`.

Values:

- `k.bar(value, { max, tone })`, or `k.bar([{ value, tone, label }, ...], { max })` for stacked parts.
- `k.spark(values, { min, max, tone, w })`, a one-line trend. `null` is a gap.
- `k.plot(series, { h, x: { label, log, ticks, min, max }, y: {...}, dots })`. A series is numbers, `[x, y]` pairs,
  or `{ name, values | points, tone, id, cite }`.
- `k.table(rows, { cols, max, id, cite, examples })`. `cols` is keys or `{ key, label, align, fmt, tone, w }`.
  `id`, `cite` and `examples` are functions of a row, and make each row a region.
- `k.unseen({ label, w, h })`.
- Conveniences: `k.bars(items, { max, labelW })` for rows of label, bar, value and note; `k.legend(items)`;
  `k.dots(n, total)`.

Interaction:

- `k.on(name, fn, label)`, `k.state`, and `k.event` (what this run answers, or null).
- In a handler: `k.set(key, value)`, and `k.ask({ label, rows, region, text })`, which sends the person's next
  question (or `text`, at once) to the card's thread about that selection.
- `k.rows(x)`: the refs of rows of the data, for an ask or a cite. `k.title`, `k.id`, `k.surface` (`'terminal'` or
  `'browser'`).

Knobs:

- `k.knob(id, { values, at, label, fmt })` returns the value the person set, else `at` (else the first value).
  `values` is a list of numbers, words or anything JSON, or `{ min, max, step }` in place of it. `fmt(value)` is how
  the person reads a value. Up to 2,000 values: a run's steps fit.
- `k.dial(id, { label, w })` draws the knob as `label ◂ value ▸`. Any link to the knob's id, `[words](#id)`, is the
  knob too.
- `k.state` holds every knob's value as the host ran the program.

Meaning:

- `k.region(id, meta, part)`. `meta` is a label string or `{ label, cite, examples, note, ...anything }`.
- `k.cite(id, {...})` and `k.examples(id, {...})` register a cite or a set of records and return the id.

A map of work:

- `k.map(spec, { full, form, lens, w, rows })` lays work out by its own structure. `spec` holds `threads` (runs,
  agents, one long run), each with `stops` (the stations it passes, in order, as ids or `{ station, from, to, ref,
  note }`), or a list of `moves` (`{ thread, station, from, to }`); `stations` (`{ id, label, ref, note, key, end,
  group }`); `links` (`{ from, to, n, label }`); `groups` of stations; and a `lens`, the thread field that colors the
  lanes. Every field is optional and any other field is kept on the regions' meta. One thread draws as a line of its
  stations, many as a metro map whose bundles fork and merge, stations with no threads as regions of boxes. `full:
  false` is the calm form for under a reply (one row for one thread; the key stations and the endings for many); it
  defaults to `k.mode === 'detail'` or `spec.full`. Each station, lane and group is a region whose meta names its rows
  (`ref`, or the rows a query bound) and holds the threads through it as examples.

The canvas, `const c = k.canvas(w, h)`, in cells (x across, y down):

- `c.text(x, y, str, { tone, bold, align, max })`, `c.put(x, y, ch, tone)`, `c.fill(x, y, w, h, ch, tone)`.
- `c.hline(x, y, w, ch, tone)` and `c.vline(x, y, h, ch, tone)`. The browser draws `─` as a line, `━` as a heavy
  line and `╌` as a dashed one.
- `c.box(x, y, w, h, { title, tone })`.
- `c.px(x, y, tone)` and `c.line(x0, y0, x1, y1, tone)` work in half cells down (y from 0 to 2h−1).
- `c.bar(x, y, w, value, max, tone)` and `c.spark(x, y, values, { w, min, max, tone })`.
- `c.region(id, x, y, w, h, meta)`, and `c.brush(id, x, y, w, h, { min, max })`: an area a browser drag reads as a
  range from min to max.

Other: `k.w` and `k.h` (the room in columns and rows), `k.fmt(n, { dp, pct, sign, compact })` for numbers people
read, `k.len(s)` for a string's width in columns.

Tones name meanings: `ink`, `dim`, `accent`, `good`, `bad`, `warn`, `unseen`, and `c1` to `c6` for categories.

## Worked examples

**A summary with bars, cites and real records.** Each day is a region with its own cite and its saves as
examples. The days before the change are one row, so the jump reads at a glance.

```js
const n = k.fmt
const days = data.days.map(d => {
  const id = 'day-' + d.day
  k.cite(id, { text: `${n(d.messages)} messages on ${d.day}`, source: 'daily.csv',
    query: `sum(messages) where day = '${d.day}'`, rows: d.rows })
  k.examples('saves-' + d.day, { label: `saves on ${d.day}`, records: d.samples, total: d.saves,
    fmt: '“{text}”\n{user} on {page}' })
  return { id, label: d.day, value: d.messages, cite: id, examples: 'saves-' + d.day }
})
return k.frame(k.stack(
  k.bars(days),
  k.beside(k.text('not read', { tone: 'dim', w: 12 }), k.unseen({ label: '3 of 4 dump files', w: 30 })),
  { gap: 1 },
), { title: 'Messages to other agents, per day', right: 'daily.csv' })
```

**A grid of runs.** Each cell is a spark of one run and its final value. The grid is `beside` inside `stack`; no
grid helper is needed.

```js
const cell = r => k.region(r.run, { label: r.run, cite: k.cite(r.run, { text: `${r.run} ends at ${r.final}`,
  source: 'sweep.csv', query: `where run = '${r.run}'`, rows: r.rows }) },
  k.stack(k.spark(r.acc, { min: 0, max: 100, tone: r.final >= 95 ? 'good' : 'accent' }), k.text(r.final.toFixed(1)), { w: 12 }))
return k.stack(data.configs.map(c => k.beside(k.text(`**${c.name}**`, { w: 10 }), c.runs.map(cell), { gap: 1 })), { gap: 1 })
```

**A map on a canvas.** One row per flow from a theory to an outcome; the line's weight shows its count, and the
count is written at its end. Each theory, outcome and flow is a region.

```js
const c = k.canvas(70, data.flows.length + 1)
data.flows.forEach((f, y) => {
  if (f.first) c.text(0, y, `${f.theory} {dim:${f.theoryRuns}}`, { max: 20 })
  c.hline(22, y, 36, f.runs >= 10 ? '━' : f.runs >= 5 ? '─' : '╌', f.tone)
  c.text(61, y, String(f.runs), { tone: 'dim', align: 'right' })
  c.region(`flow-${f.from}-${f.to}`, 22, y, 40, 1, { label: `${f.runs} runs: ${f.from} → ${f.to}`, cite: f.cite })
  if (f.lastOfOutcome) c.text(63, y, `{${f.tone}:${f.outcome}}`)
})
return k.frame(c, { title: 'map', right: `${data.runs} runs` })
```

## When something goes wrong

A program that throws, runs past its time or draws too much shows one line under the card's title: the error, its
line, and what to fix. Warnings, such as a region with no id or a link to an id nothing defines, come back with the
drawing. The draw tool shows you the cells
the person sees, the region ids, the warnings, and anything cut to fit, so you can check what you made.

To check an interaction before the person tries it, run the saved card with an event: `node cli.mjs
thimble/objects/<id>.json --text --event '{"type":"key","key":"f"}'` (`cli.mjs` is beside this file). It prints the
cells the card then draws and the state its handler set.
