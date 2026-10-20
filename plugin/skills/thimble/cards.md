# The card guide

This guide says what makes a good card, lists the toolkit a card's program is made of, and ends with worked programs to adapt.

## What makes a good card

A card shows the analyst one finding: a question, the content that shows the answer, and a takeaway that answers the question in a sentence or two, in words the analyst knows. The analyst reads the question and the takeaway, then checks the takeaway against the content. So the takeaway claims only what the card shows and no more than the data holds, and gives the one or two numbers it rests on, each with its base, as in "26 of the 53". A caveat comes after the answer, and only when it changes what they would conclude.

```
Analyst   Which bus lines run late most often?
Good      takeaway   Line 12 Harbor ran late most often, on [212](r4#line=line-12-harbor@late) of its 930 trips,
                     nearly twice the share of the next line.
Bad       takeaway   Line 12 was late on 212 trips (22.8%), Line 7 on 118 and Line 30 on 97, with a mean of 3.4
                     minutes late (sd 2.9).
```

The bad takeaway gives six numbers, two of them without a base, so the analyst cannot tell which line is late most often for its size.

**Be creative about how you present the content, since the right form lets the analyst see the answer immediately and the wrong one hides it.** There are no card kinds: you compose the form from the toolkit's parts, as the worked programs below do, each in another form. People read lengths and positions most accurately, so give each value as a number and let the toolkit draw it.

**Every part the analyst can select opens what it stands for.** Draw the whole first, and let the analyst open a part for its records: a query row, a record, or the lines of a file (`ref: 'server/auth.py#L60-94'`). A part drawn from a row of a bound query output opens that row's records by itself.

**Use color for what the question needs, one encoding at a time.** Gray (`dim`) is for context and for "other". Name each color where it stands, such as a bar part's `label`. Draw what you did not read with `k.unseen()`, so a gap does not read as a zero.

**Answer with as few cards as the question needs.** Under your reply a card has about half a screen, and the detail view (`k.mode === 'detail'`) has more room for more of the same. Lead with the card that answers most directly, then the pattern or the records that support it: three or four cards that build on each other are easy to follow, and ten are not. Say how you worked in a sentence, not in a card.

## The toolkit

A card's program is the body of a function `(k, data) => node`. `data` is the card's data, with query outputs bound in it, and `k` is the toolkit. Return what to draw. The same program draws in the terminal, in cells, and in the browser, with type and lines. It runs in a sandbox: it sees `k` and `data` and nothing else, and it runs start to end, with no `await`. There are no chart types: the helpers below are made of the same parts, and when one does not fit, build your own from `stack`, `beside` and the canvas.

```js
const total = data.days.reduce((s, d) => s + d.messages, 0)
return k.frame(k.stack(
  k.text(`**${k.fmt(total)}** messages in ${data.days.length} days`),
  k.bars(data.days.map(d => ({ id: 'day-' + d.day, label: d.day, value: d.messages }))),
), { title: 'Messages per day' })
```

**Text and layout.** `k.text(str, { tone, bold, align, wrap, max, w })`, where `str` may hold `**bold**` and `{dim:words}` for a tone; `k.escape(s)` makes data safe to put in it. `k.stack(...parts, { gap, align })` puts parts under each other, `k.beside(...)` side by side, and `k.frame(part, { title, right, bottom, tone })` draws a border with a title. A part may be a node, a string, a number, an array or `false` (left out). `k.size(part, { w, grow })`, `k.space(w, h)` and `k.rule()` place them.

**Values.** A value given as a number stays a number: the browser draws it exactly, and the terminal rounds it to cells. `k.bar(value, { max, tone })`, or `k.bar([{ value, tone, label }, ...], { max })` for stacked parts, whose labels `k.bars` names in a key above its rows. `k.bars(items, { max, labelW })` draws rows of label, bar, value and note, an item being `{ id, label, value | parts, tone, note, meta }`. `k.spark(values, { min, max, tone, w })` is a one-line trend. `k.plot(series, { h, x: { label, log, min, max }, y: {...}, dots, brush })` takes numbers, `[x, y]` pairs, or `{ id, name, values | points, tone, meta }`. `k.table(rows, { cols, max, id, cite, examples })` takes `cols` as keys or `{ key, label, align, fmt, tone, w }`. `k.unseen({ label, w, h })` draws what you did not read, hatched. `k.legend(items)` is there for a color you cannot name where it stands.

**Parts the analyst can select.** `k.region(id, meta, part)` makes a part. The id names what the part is (`day-06-18`), not where it sits, since a selection and a question about the part carry it, so keep ids when you change the program. `meta` is a label or `{ label, ref, cite, examples, note, row, ... }`. A bar item, a stacked part, a table row or a region's meta made from a row of a bound query output (the row, `{ ...row }` or `{ row: d }`) opens the records behind that row. `k.cite(id, { text, source, query, rows, note })` and `k.examples(id, { label, records, total, fmt })` register a citation or a set of real records and return the id, and a region points at them with `{ cite, examples }`.

**Knobs and keys.** `k.knob(id, { values, at, label, fmt })` returns the value the analyst set, else `at`; `values` is a list (up to 2,000) or `{ min, max, step }`. `k.dial(id)` draws it as `label ◂ value ▸`. `k.on(name, fn, label)` answers a key (`'j'`), a press on a part (`'press:<id>'`) or a drag in the browser (`'brush'`); `fn(event)` returns the new state, and the program runs again and reads it in `k.state`. In a handler, `k.set(key, value)` sets one value, and `k.ask({ label, rows, text })` sends the analyst's next question to the card's thread. A card gets its keys while it has the focus, and the bar shows each with the label you gave it, such as `c flip · , . year`, so the card draws no key hints. Claude Code keeps ← and → in the terminal, and `0` goes back, so a card never gets them; `thimble save` names a key a card cannot get.

**A map of work.** `k.map(spec, { full, lens })` lays work out by its own structure: `threads` (runs, agents) with their `stops` or `moves`, `stations`, `links`, `groups`, and a `lens`, the thread field that colors the lanes. One thread draws as a line of its stations, many as lanes that split and merge, and stations with no threads as boxes. Under a reply it draws its short form, and in the detail its full form. Each station, lane and group opens its records.

**A diagram.** `k.graph({ nodes, edges }, { dir })` draws boxes joined by arrows and places them itself: you say what connects to what, never where it goes. A node is `{ id, label, note, tone, ref }` and an edge `{ from, to, label, tone, weight, dash, ref }`; a cycle, a long edge and an edge from a node to itself all draw. It lies across the card when it fits, else down it. Each node and edge with a ref opens its records.

**The canvas.** `const c = k.canvas(w, h)` draws a shape no helper has, in cells (x across, y down), and sits in a stack or a frame like any part. `c.text(x, y, str, { tone, bold, align, max })`, `c.put(x, y, ch, tone)`, `c.fill(x, y, w, h, ch, tone)`, `c.bg(x, y, w, h, tone)`, `c.hline` and `c.vline(x, y, len, ch, tone)` (`─` a line, `━` heavy, `╌` dashed), `c.box(x, y, w, h, { title, tone, fill })`, `c.dot(x, y, tone, { size, label, part })` and `c.link(x0, y0, x1, y1, tone)` for nodes and links, `c.bar(x, y, w, value, max, tone)` and `c.spark(x, y, values, { w, min, max, tone })` for values, `c.region(id, x, y, w, h, meta)` for a part, and `c.brush(id, x, y, w, h, { min, max })` for a range a browser drag reads.

**Other.** `k.w` and `k.h` are the room in columns and rows, `k.mode` is `'inline'` under a reply and `'detail'` in the detail view, `k.fmt(n, { dp, pct, sign, compact })` formats numbers people read, `k.len(s)` is a string's width, and `k.cat(i)` is the i-th category tone. Tones name meanings: `ink`, `dim`, `accent`, `good`, `bad`, `warn`, `unseen`, and `c1` to `c6` for categories; `c2-faint` is `c2`, stepped back.

**When something goes wrong.** `thimble save` checks each citation and binding, saves the card anyway, and lists each problem: fix it and save again under the same name. A program that throws shows one line under the card's title with the error and what to fix, and warnings come back with the drawing. To check a key or a press before the analyst tries it, run the saved card with an event: `node ../../draw/cli.mjs thimble/objects/<id>.json --text --event '{"type":"key","key":"f"}'`.

## Worked programs

Each program below answers a different kind of question about a different kind of material, in a form made for that question. Bars and lines answer how much and how it changed. Many questions ask something else: how parts connect, what happened in what order and why, where things sit, or how two versions differ. For those, a picture of the connections, the sequence, the places or the differences shows the answer that a count of them hides. Start from the question, and when no form here fits it, compose a new one from the toolkit. Each program's data is in `forms/<name>.data.json` beside this file.

```
Analyst   Why do some users get logged out after a few minutes?
Takeaway  Every request passes is_expired() in server/auth.py, which reads the timeout as seconds, but config/app.yaml
          gives it in minutes, so a 30-minute session ends after 30 seconds.
```

The question is about how parts of the code connect, so the card draws the path a request takes, with the step that goes wrong in red and the two lines that show why under it. Each box and each line opens its code.

```js
const quote = q => k.region(q.id, { label: q.where, ref: q.ref }, k.frame(k.text(k.escape(q.code)), { title: q.where, tone: q.tone }))
return k.stack(
  k.text('Every request passes **is_expired()**, which reads the timeout as seconds; the config gives it in minutes'),
  k.graph(data),
  k.stack(...data.quotes.map(quote)),
  { gap: 1 })
```

```
Analyst   Why did run 17 take three times as many steps as the other runs?
Takeaway  It spent 410 of its 620 steps re-running one test: it took a failure caused by the test fixture's random seed
          for a bug in its own parser, and opened conftest.py only at step 571.
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

```
Analyst   Which learning rates and batch sizes make training diverge?
Takeaway  All four runs at learning rate 3e-3 diverged, and so did batch 32 at 1e-3; the lowest final loss, 0.569, was
          at 1e-3 with batch 256.
```

The answer depends on two settings at once, so the card lays the runs out as a grid of the two, each cell the run's own loss curve on one shared scale, so the eye compares the cells.

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
Analyst   What changed in the data policy between the March and June drafts?
Takeaway  June drops the 30-day deletion rule, adds a section on training models, and moves consent to the front; 8 of
          the 12 March sections are unchanged.
```

The question compares two versions of one document, so the card sets them side by side, with each section that stayed on one row, and draws what moved, what was removed and what is new.

```js
const tone = Object.fromEntries(data.kinds.map(d => [d.key, d.tone]))
const longest = Math.max(...data.rows.flatMap(r => [r.old, r.new]).filter(Boolean).map(s => k.len(s.title))) + 4
const tw = Math.max(16, Math.min(longest, Math.floor((k.w - 16) / 2))), gx = tw + 1, gw = 14, bx = gx + gw + 1
const c = k.canvas(bx + tw, data.rows.length + 1)
c.text(0, 0, `**${data.old}**`); c.text(bx, 0, `**${data.new}**`)
const section = (s, x, y, change, name) => {
  c.text(x, y, `{dim:${s.n}} ${k.escape(s.title)}`, { tone: change === 'removed' || change === 'added' ? tone[change] : 'ink', max: tw })
  c.region(`${name.toLowerCase()}-${s.n}`, x, y, tw, 1, { label: `${name} §${s.n} ${s.title} (${change})`, ref: s.ref })
}
data.rows.forEach((r, i) => {
  const y = i + 1
  if (r.old) section(r.old, 0, y, r.change, data.old)
  if (r.new) section(r.new, bx, y, r.change, data.new)
  if (r.old && r.new) c.hline(gx, y, gw, r.change === 'reworded' ? '╌' : '─', tone[r.change])
  if (r.change === 'removed') c.text(gx + 1, y, '✕ removed', { tone: 'bad' })
  if (r.change === 'added') c.text(gx + gw - 6, y, 'new +', { tone: 'good' })
})
data.moves.forEach(m => {
  const y0 = m.from + 1, y1 = m.to + 1, lx = gx + Math.floor(gw / 2), t = tone.moved
  for (let y = Math.min(y0, y1) + 1; y < Math.max(y0, y1); y++) c.put(lx, y, '┼', t)
  c.hline(gx, y0, lx - gx, '─', t); c.hline(lx + 1, y1, gx + gw - lx - 1, '─', t)
  c.put(lx, y0, y1 > y0 ? '╮' : '╯', t); c.put(lx, y1, y1 > y0 ? '╰' : '╭', t)
})
const same = data.rows.filter(r => r.change === 'same').length, total = data.rows.filter(r => r.old).length
return k.stack(
  k.text(`${data.new} drops the 30-day deletion rule, adds a section on training models, and moves consent to the front; ${same} of the ${total} ${data.old} sections are unchanged`, { wrap: true }),
  c, k.legend(data.kinds), { gap: 1 })
```

```
Analyst   How many of last night's CI jobs hung?
Takeaway  5 of the 7 jobs went quiet for 5 minutes or more; with 10 minutes as the limit, 3 did.
```

The count rests on what "hung" means, so that limit is a knob, and the strips and the count follow it as the analyst turns it.

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
