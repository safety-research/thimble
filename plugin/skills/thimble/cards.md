# The card guide

A card is a short program that draws a finding from your query outputs. thimble draws it under your reply in the terminal and on the canvas in the browser, and each part the analyst selects opens the records behind it. This guide describes how to save a card and the toolkit its program uses, and ends with three examples.

## Saving a card

Write the card as a JSON file and save it with `thimble save NAME --from card.json`.

```json
{
  "title": "Messages per day",
  "data": { "days": "r1" },
  "program": "return k.bars(data.days.map(d => ({ id: 'day-' + d.day, label: d.day, value: d.messages })))",
  "text": "Most messages came on Jun 18, [6,543](r1#day=06-18@messages) of the 14,591."
}
```

- `title` says what the card shows.
- `data` binds query outputs by their ids. The program reads them as `data.days`, and each row keeps the records behind it.
- `program` is the body of a function `(k, data) => node` (see the toolkit below). `--program FILE` reads it from a file.
- `text` is an optional takeaway of a sentence or two, with its numbers cited. Leave it out when the content and your reply already say it.
- `declared` says what you read or judged by hand, when part of the card rests on that.

`thimble save` checks each citation and binding, saves the card anyway, and lists each problem. Fix it and save again under the same name, which makes a new version. A program that throws shows one line under the card's title with the error. To try a key or a press before the analyst does, run `node ../../draw/cli.mjs thimble/objects/<id>.json --text --event '{"type":"key","key":"f"}'`.

## Choosing the form

Start from the question. Bars and lines answer how much and how it changed. A diagram answers how parts connect, a timeline what happened in what order, a grid of small charts how two settings act together, and two columns side by side how two versions differ. There are no card kinds, so compose the form the question needs from the toolkit.

- Give each value as a number and let the toolkit draw it, since people read lengths and positions most accurately.
- Draw the whole first. The analyst opens a part for its records.
- Use color for one thing at a time. Gray (`dim`) is for context and for "other". Name each color where it stands, such as in a bar part's `label`. Draw what you did not read with `k.unseen()`, so a gap does not read as a zero.
- Use as few cards as the question needs. Under a reply a card has about half a screen, and the detail view has more room. When a question takes several cards, lead with the one that gives the picture, then the finding, then the records that make it believable.

## The toolkit

A card's program is the body of a function `(k, data) => node`. `data` is the card's data, with query outputs bound in it, and `k` is the toolkit. The program returns what to draw. It runs in a sandbox that holds only `k` and `data`, from start to end, with no `await`. The helpers below are made of the same parts, and when none fits, build your own from `stack`, `beside` and the canvas.

```js
const total = data.days.reduce((s, d) => s + d.messages, 0)
return k.frame(k.stack(
  k.text(`**${k.fmt(total)}** messages in ${data.days.length} days`),
  k.bars(data.days.map(d => ({ id: 'day-' + d.day, label: d.day, value: d.messages }))),
), { title: 'Messages per day' })
```

**Text and layout.** `k.text(str, { tone, bold, align, wrap, max, w })` draws text, in which `**bold**` and `{dim:words}` set a tone, and `k.escape(s)` makes data safe to put in it. `k.stack(...parts, { gap, align })` puts parts under each other, `k.beside(...)` puts them side by side, and `k.frame(part, { title, right, bottom, tone })` draws a border with a title. A part may be a node, a string, a number, an array or `false`, which is left out. `k.size(part, { w, grow })`, `k.space(w, h)` and `k.rule()` place parts.

**Values.** `k.bar(value, { max, tone })` draws one bar, and `k.bar([{ value, tone, label }, ...], { max })` stacked parts. `k.bars(items, { max, labelW })` draws rows of label, bar, value and note, from items `{ id, label, value | parts, tone, note, meta }`, with a key for stacked parts. `k.spark(values, { min, max, tone, w })` is a one-line trend. `k.plot(series, { h, x: { label, log, min, max }, y, dots, brush })` takes numbers, `[x, y]` pairs, or `{ id, name, values | points, tone, meta }`. `k.table(rows, { cols, max, id, cite, examples })` takes `cols` as keys or `{ key, label, align, fmt, tone, w }`. `k.unseen({ label, w, h })` draws what you did not read, hatched. `k.legend(items)` names colors that you cannot name where they stand.

**Parts the analyst can select.** `k.region(id, meta, part)` makes a part. The id names what the part is, such as `day-06-18`, and stays the same when you change the program. `meta` is a label or `{ label, ref, cite, examples, note, row }`, where `ref` opens records or lines of a file, such as `'server/auth.py#L60-94'`. A bar item, a stacked part, a table row or a region made from a row of a bound query output opens the records behind that row by itself. `k.cite(id, { text, source, query, rows, note })` and `k.examples(id, { label, records, total, fmt })` register a citation or a set of real records, and a region points at them with `{ cite, examples }`.

**Knobs and keys.** `k.knob(id, { values, at, label, fmt })` returns the value the analyst set, else `at`, where `values` is a list or `{ min, max, step }`, and `k.dial(id)` draws it as `label ◂ value ▸`. `k.on(name, fn, label)` answers a key such as `'j'`, a press on a part (`'press:<id>'`) or a drag in the browser (`'brush'`). `fn(event)` returns the new state, the program runs again, and it reads the state in `k.state`. In a handler, `k.set(key, value)` sets one value, and `k.ask({ label, rows, text })` sends a question to the card's thread. The bar shows each key with its label, so the card draws no key hints. A card never gets ←, → or `0`.

**A diagram.** `k.graph({ nodes, edges }, { dir })` draws boxes joined by arrows and places them itself, so you say what connects to what and never where it goes. A node is `{ id, label, note, tone, ref }` and an edge `{ from, to, label, tone, weight, dash, ref }`.

**A map of work.** `k.map(spec, { full, lens })` lays out work by its own structure: `threads` (runs or agents) with their `stops` or `moves`, `stations`, `links` and `groups`, colored by `lens`, a field of the threads. Under a reply it draws a short form, and in the detail view the full form.

**The canvas.** `const c = k.canvas(w, h)` draws a shape that no helper has, in cells, with x across and y down. `c.text(x, y, str, { tone, bold, align, max })`, `c.put(x, y, ch, tone)`, `c.fill(x, y, w, h, ch, tone)`, `c.bg(x, y, w, h, tone)`, `c.hline` and `c.vline(x, y, len, ch, tone)`, `c.box(x, y, w, h, { title, tone, fill })`, `c.dot(x, y, tone, { size, label, part })`, `c.link(x0, y0, x1, y1, tone)`, `c.bar(x, y, w, value, max, tone)` and `c.spark(x, y, values, { w, min, max, tone })` draw. `c.region(id, x, y, w, h, meta)` makes a part, and `c.brush(id, x, y, w, h, { min, max })` a range that a browser drag reads.

**Other.** `k.w` and `k.h` are the room in columns and rows, and `k.mode` is `'inline'` under a reply and `'detail'` in the detail view. `k.fmt(n, { dp, pct, sign, compact })` formats a number, `k.len(s)` gives a string's width, and `k.cat(i)` gives the i-th category tone. The tones are `ink`, `dim`, `accent`, `good`, `bad`, `warn`, `unseen`, and `c1` to `c6` for categories, with a faint step such as `c2-faint`.

## Examples

Each example answers a different kind of question, in a form made for that question. Its data is in `forms/<name>.data.json` beside this file.

```
Analyst   Why do some users get logged out after a few minutes?
Title     How a request reaches the session check
```

The question is about how parts of the code connect, so the card draws the path a request takes, with the step that goes wrong in red and the two lines of code that show why under it.

```js
const quote = q => k.region(q.id, { label: q.where, ref: q.ref }, k.frame(k.text(k.escape(q.code)), { title: q.where, tone: q.tone }))
return k.stack(
  k.text('Every request passes **is_expired()**, which reads the timeout as seconds; the config gives it in minutes'),
  k.graph(data),
  k.stack(...data.quotes.map(quote)),
  { gap: 1 })
```

```
Analyst   Which learning rates and batch sizes make training diverge?
Title     Training loss by learning rate and batch size
```

The answer depends on two settings at once, so the card lays the runs out as a grid of the two, each cell the run's own loss curve on one shared scale.

```js
const lrs = [...new Set(data.runs.map(r => r.lr))], batches = [...new Set(data.runs.map(r => r.batch))]
const W = Math.max(10, Math.min(24, Math.floor((k.w - 12) / batches.length) - 2))
const best = data.runs.filter(r => !r.diverged).reduce((a, b) => (b.final < a.final ? b : a))
const cell = r => {
  const tone = r.diverged ? 'bad' : r === best ? 'good' : 'c1'
  const words = r.diverged ? `{bad:diverged, epoch ${r.diverged}}` : `{${r === best ? 'good' : 'dim'}:final loss ${r.final}}`
  return k.region('run-' + r.id, { label: `lr ${r.lr}, batch ${r.batch}: ${r.diverged ? 'diverged at epoch ' + r.diverged : 'final loss ' + r.final}`, ref: r.ref },
    k.stack(k.spark(r.loss, { w: W, min: 0, max: data.max, tone }), k.text(words, { w: W })))
}
return k.stack(
  k.text(`Every run at learning rate 3e-3 diverged; the lowest final loss, **${best.final}**, was at ${best.lr} with batch ${best.batch}`),
  k.beside(k.text('{dim:lr  batch}', { w: 10 }), ...batches.map(b => k.text(`{dim:${b}}`, { w: W })), { gap: 2 }),
  ...lrs.map(lr => k.beside(k.text(lr, { w: 10 }), ...batches.map(b => cell(data.runs.find(r => r.lr === lr && r.batch === b))), { gap: 2 })),
  k.text(`{dim:each cell: training loss over ${data.epochs} epochs, on one scale from 0 to ${data.max}}`))
```

```
Analyst   Why did run 17 take three times as many steps as the other runs?
Title     Run 17, step by step
```

The question is about one run, so the card draws that run whole, one cell per stretch of steps, and numbers the moments that explain it. Each note quotes the transcript and opens the lines it quotes.

```js
const W = Math.max(40, Math.min(k.w, 110)), n = data.steps.length
const x = s => Math.min(W - 1, Math.floor(s / n * W))
const tone = Object.fromEntries(data.kinds.map(d => [d.key, d.tone]))
const c = k.canvas(W, 3)
// the run, one cell per stretch of steps: red where a test failed, else what it did most
for (let i = 0; i < W; i++) {
  const bin = data.steps.slice(Math.floor(i * n / W), Math.floor((i + 1) * n / W))
  const most = [...new Set(bin)].sort((a, b) => bin.split(b).length - bin.split(a).length)[0]
  c.put(i, 1, '▆', tone[bin.includes('f') ? 'f' : most])
}
// each note's number over the step it marks, or over the stretch it spans
data.notes.forEach((m, i) => {
  if (m.to) { c.hline(x(m.at), 0, x(m.to) - x(m.at), '─', 'dim'); c.put(x(m.to), 0, '┤', 'dim') }
  c.text(x(m.at), 0, `**${i + 1}**`, { tone: 'accent' })
})
c.text(0, 2, '{dim:step 0}'); c.text(W - 1, 2, `{dim:${n}}`, { align: 'right' })
const spans = data.notes.map(m => `${m.at}${m.to ? '–' + m.to : ''}`)
return k.stack(
  k.text(`Run ${data.run} took **${n}** steps, three times the median of ${data.median}; 410 of them went to one test`),
  k.stack(c, k.legend(data.kinds)),
  k.stack(...data.notes.map((m, i) => k.region(m.id, { label: `step ${spans[i]}: ${m.text}`, ref: m.ref },
    k.beside(k.text(`{accent:**${i + 1}**}`, { w: 2 }), k.text(`{dim:${spans[i]}}`, { w: Math.max(...spans.map(s => s.length)) }),
      k.text(k.escape(m.text) + (m.quote ? `  {dim:“${k.escape(m.quote)}”}` : ''), { wrap: true }), { gap: 1 })))),
  { gap: 1 })
```
