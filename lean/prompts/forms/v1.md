# Card forms: another view of an answer

The person pressed v on one of your answers. They want to see what it says in a card, beside the words and beside
any card the answer already has. You write the card as a short program on the drawing toolkit and save it with
`lean save`. There are no chart types: compose what this answer needs. The worked programs below are examples to
adapt, not templates. For any part of the toolkit they do not show, read `../../draw/TOOLKIT.md` from this folder.

## Principles

**Another view, not the same card.** You add a card to an answer whenever the answer is best seen, without being asked.
So when v is pressed, the answer may have its card already. Make a different view of the same claim (a run's trail
where the answer listed steps, a number taken apart where it gave a total), or a closer look at one part. If the
request names proposals for this answer, start from the one the person picked.

**Let the shape of the claim choose the form.** Counts by group read as bars. One long run reads as its trail of
stations. A result that rests on a choice (a scale, a threshold) reads as curves with that choice as a knob. A change
to files reads as a map of where the diff touched them. Several runs read as strips on one axis, so the same moment
lines up. One total the person should take apart reads as the number unfolded.

**Overview first, the rows one key below.** The card shows the whole at once. Each part the person may ask about is a
region with the ref of its value (`k.region(id, { label, ref }, part)`), so selecting it opens its rows. Real records
go in `k.examples` on that part, with a label that says what they are examples of ("reruns with no code change,
steps 881–1720"). The person asks for them; the card does not list them.

**Put the choice inside the card.** When the claim rests on a choice, make it a knob (`k.knob`) and draw it with
`k.dial` where it acts. The words that state the result read the knob, so they change as the person turns it.

**Let the person zoom and filter inside the card.** When a part holds more than the overview can show (a long
station of a run, a busy day), give the card a `zoom` knob whose first value is `'overview'`, and a `filter` knob
(`'all'`, then a narrower set, such as failures only). The detail turns them with + − and f. The overview stays what
the person sees first; the zoomed view says where it is (`overview › Rerun loop`).

**Use the room you are given.** Under a reply a card has a few rows. In the detail it has the whole panel:
`k.mode === 'detail'` and `k.h` say so, so show more there (more stations, a taller plot), never something else.

**Keep values as values, bound to queries.** Put query refs in the card's data (`"data": {"days": "q1"}`), so each
number keeps its rows, and draw numbers with `bar`, `plot` and `spark`, so the browser draws them exactly.

**A card is its title, its chart and its takeaway.** The person reads it under your words, so it carries three things
only: a title that states the claim, the chart, and one line under it that says what to see. Label each mark where it
stands: a bar part's `label` is drawn inside the part when it fits, a station has its name, a line ends with its value.
A legend is only for a color that nothing labels in place. Leave out sources and ids: the detail's from line says
where each value comes from.

**Name the card by its claim, and save it.** The title says what the card shows ("Reruns took 840 of 2,143 steps").
Write the object as a file and run `lean save <name> --from FILE`; then say in one line what it shows. Do not repeat
the answer.

## Worked examples

Each program's data is in `forms/<name>.data.json` beside this file.

### Bars: counts by group, split by a label

```js
// Bars: one row per day, split by what the saves were for, each part labelled inside it where it fits (no legend).
// Each day is a part: its ref opens its rows, and its examples are real saves, labelled with what they are examples of.
const P = [['ask', 'c1'], ['instruct', 'c3'], ['share', 'c2'], ['test', 'c5']]
const items = data.days.map(d => ({
  id: 'day-' + d.day, label: d.day.slice(5), parts: P.map(([p, tone]) => ({ value: d[p], tone, label: p })),
  meta: { ref: `q1#day=${d.day}@n`,
    examples: k.examples('ex-' + d.day, { label: `saves to other agents on ${d.day}`, records: d.examples, total: d.n, fmt: '“{text}”\n{user} · {purpose}' }) },
}))
return k.stack(
  k.text(`**${k.fmt(data.total)}** saves to other agents`),
  k.bars(items),
)
```

### The trail of a run: stations on one line, zoom into a station, filter to its failures

```js
// The trail of one run: its stations in order on one line, and the run as a strip under it. Two knobs inside the card
// let the person go further: zoom (+ −) into a long station, one tick per step, and filter (f) to its failures.
const tone = { read: 'c4', search: 'c3', edit: 'c2', test: 'c1', revert: 'bad', rerun: 'c5' }
const zoom = k.knob('zoom', { values: ['overview', ...Object.keys(data.ticks)], at: 'overview', label: 'zoom' })
const filter = k.knob('filter', { values: ['all', 'failures only'], at: 'all', label: 'filter' })
if (zoom === 'overview') {
  const map = k.map({
    title: `run ${data.run}`, unit: 'steps',
    threads: [{ id: data.run, stops: data.stations.map(s => ({ station: s.id, from: s.from, to: s.to })) }],
    stations: data.stations.map(s => ({ id: s.id, label: s.label, note: s.note || `${s.from}–${s.to}`, ref: `q3#station=${s.id}@n`,
      examples: data.examples[s.id] && k.examples('ex-' + s.id, { label: `${s.label.toLowerCase()}, steps ${s.from}–${s.to}`, records: data.examples[s.id], total: s.to - s.from + 1 }) })),
  })
  // the strip: one cell per bucket of steps, its color what the run was doing then
  const W = Math.min(k.w - 2, 100), per = data.steps / W
  const c = k.canvas(W, 3)
  for (let x = 0; x < W; x++) {
    const step = Math.floor(x * per) + 1
    c.put(x, 0, '▆', tone[data.stations.find(t => step >= t.from && step <= t.to).activity])
  }
  // the colors labelled in place, each activity's name under where it first starts: no legend
  let free = 0
  for (const s of data.stations) {
    const x = Math.floor((s.from - 1) / per)
    if (x >= free && x + s.activity.length < W) { c.text(x, 1, s.activity, { tone: tone[s.activity] }); free = x + s.activity.length + 1 }
  }
  c.text(0, 2, '1', { tone: 'dim' })
  c.text(W - 1, 2, k.fmt(data.steps), { tone: 'dim', align: 'right' })
  return k.stack(map, c, { gap: 1 })
}
// zoomed into one station: a row of ticks per 60 steps, a failing step tall and red
const s = data.stations.find(x => x.id === zoom), t = data.ticks[zoom], W = Math.min(60, k.w - 20)
const rows = []
for (let i = 0; i < t.fails.length; i += W) {
  const from = t.from + i, bits = t.fails.slice(i, i + W), to = from + bits.length - 1
  const c = k.canvas(W, 1)
  ;[...bits].forEach((b, x) => { if (b === '1' || filter === 'all') c.put(x, 0, b === '1' ? '┃' : '│', b === '1' ? 'bad' : 'unseen') })
  const n = [...bits].filter(b => b === '1').length
  rows.push(k.region(`${zoom}-${from}`, { label: `steps ${from}–${to}: ${n} failures`, ref: `q3#step=${from}-${to}&failed=1@n` },
    k.beside(k.text(k.fmt(from), { w: 6, align: 'right', tone: 'dim' }), c, k.text(`1 in ${n ? Math.round(bits.length / n) : '–'}`, { w: 8, tone: 'dim' }), { gap: 1 })))
}
const all = [...t.fails].filter(b => b === '1').length
return k.stack(
  k.text(`{dim:overview ›} **${s.label}** · steps ${s.from}–${s.to} · one tick per step · ${all} failures${filter === 'all' ? '' : ' · {accent:failures only}'}`),
  ...rows,
)
```

### Curves with a knob: the claim rests on a choice

```js
// Curves with a knob: accuracy against the learning rate for two batch sizes. The claim rests on a choice (scale batch
// 256's lr by its 8x fewer updates), so the choice is a knob inside the card, and the words follow it.
const s = k.knob('scale', { values: [1, 2, 4, 8, 16], at: 8, label: 'scale batch 256 lr', fmt: v => '×' + v })
const of = b => data.runs.filter(r => r.batch === b && !r.diverged).sort((x, y) => x.lr - y.lr)
const b32 = of(32), b256 = of(256).map(r => ({ ...r, lr: r.lr / s }))
// the largest gap between the curves where both have runs, in log lr
const at = (rs, lr) => { const i = rs.findIndex(r => r.lr >= lr); if (i <= 0) return i === 0 && rs[0].lr === lr ? rs[0].acc : null
  const a = rs[i - 1], b = rs[i], t = (Math.log10(lr) - Math.log10(a.lr)) / (Math.log10(b.lr) - Math.log10(a.lr)); return a.acc + t * (b.acc - a.acc) }
const gaps = b32.map(r => [r, at(b256, r.lr)]).filter(([, y]) => y != null).map(([r, y]) => Math.abs(r.acc - y))
const gap = gaps.length ? Math.max(...gaps) : null
k.cite('gap', { text: `at ×${s} the curves are at most ${gap == null ? '?' : gap.toFixed(1)} points apart`, source: 'sweep.csv', query: 'SGD, epoch 10, batch 32 vs batch 256 at lr ÷ scale' })
const dv = data.runs.filter(r => r.diverged)
return k.stack(
  k.beside(k.dial('scale'), k.region('gap', { label: `max gap at ×${s}`, cite: 'gap' }, k.text(gap == null ? '{dim:no overlap}' : `max gap **${gap.toFixed(1)}** pts`, { tone: gap != null && gap < 2 ? 'good' : 'warn' })), { gap: 4 }),
  k.plot([
    { id: 'b32', name: 'batch 32', points: b32.map(r => [r.lr, r.acc]), meta: { ref: 'q4#batch=32@acc' } },
    { id: 'b256', name: `batch 256, lr ÷ ${s}`, points: b256.map(r => [r.lr, r.acc]), meta: { ref: 'q4#batch=256@acc' } },
  ], { h: k.mode === 'detail' ? 14 : 7, x: { label: 'learning rate', log: true }, y: { label: 'val acc', min: 0, max: 100 } }),
  k.region('diverged', { label: 'diverged runs', ref: 'q4#diverged@n',
    examples: k.examples('ex-diverged', { label: 'runs that diverged (loss NaN)', records: dv.map(r => ({ run: r.run, lr: r.lr, val_acc: r.acc })) }) },
    k.text(`{bad:✗} batch 32 diverges at lr ${dv.map(r => r.lr).join(' and ')}: accuracy falls to 10`)),
)
```

### A region map of a diff: where the change touched each file

```js
// A region map of a diff: one strip per file, as long as the file; each hunk sits where it is, colored by what it did.
// A hunk is a part: its ref opens its lines in the diff. Files with no change stay, dim, so the map shows what was not touched.
const W = Math.max(20, Math.min(k.w - 40, 70))
const tone = h => (h.added && h.removed ? 'warn' : h.added ? 'good' : 'bad')
const rows = data.files.map(f => {
  const c = k.canvas(W, 1)
  c.fill(0, 0, W, 1, '─', 'unseen')
  f.hunks.forEach((h, i) => {
    const x = Math.min(W - 1, Math.floor(h.at / f.lines * W)), w = Math.max(1, Math.round(h.len / f.lines * W))
    c.fill(x, 0, Math.min(w, W - x), 1, '█', tone(h))
    c.region(`${f.path}:${h.at}`.replace(/[^A-Za-z0-9_.:-]/g, '-'), x, 0, Math.min(w, W - x), 1,
      { label: `${f.path} line ${h.at}: ${h.why}`, ref: `${data.diff}#L${h.line}`, note: `+${h.added} −${h.removed}` })
  })
  const n = f.hunks.reduce((s, h) => s + h.added + h.removed, 0)
  return k.beside(k.text(f.path, { w: 24, tone: f.hunks.length ? 'ink' : 'dim', wrap: false }), c, k.text(n ? `${n} lines` : '{dim:untouched}', { w: 10 }), { gap: 1 })
})
return k.stack(
  k.text(`${data.files.filter(f => f.hunks.length).length} of ${data.files.length} files changed · {good:█} added {bad:█} removed {warn:█} both`),
  ...rows,
)
```

### Aligned strips: several runs on one axis

```js
// Aligned strips: several runs on one step axis, so the same moment lines up across them. One row per run, each cell
// what the run was doing at that share of its steps; a run is a part, its rows one key below.
const tone = { read: 'c4', search: 'c3', edit: 'c2', test: 'c1', rerun: 'c5' }
const W = Math.min(k.w - 18, 100)
const rows = data.runs.map(r => {
  const c = k.canvas(W, 1)
  for (let x = 0; x < W; x++) c.put(x, 0, '▆', tone[r.buckets[Math.floor(x / W * r.buckets.length)]])
  const share = r.buckets.filter(b => b === 'rerun').length / r.buckets.length
  return k.region('run-' + r.id, { label: `${r.id}: ${r.outcome}, ${Math.round(share * 100)}% reruns`, ref: `q7#run=${r.id}@steps`,
    examples: data.examples[r.id] && k.examples('ex-' + r.id, { label: `${r.id}'s key steps`, records: data.examples[r.id] }) },
    k.beside(k.text(`**${r.id}**`, { w: 4 }), c, k.text(r.outcome, { w: 8, tone: r.outcome === 'fixed' ? 'good' : 'bad' }), { gap: 1 }))
})
return k.stack(
  k.text(`${data.runs.length} runs, each scaled to its own length · ${Object.entries(tone).map(([a, t]) => `{${t}:■} ${a}`).join('  ')}`),
  ...rows,
)
```

### Unfold a number: one total, taken apart one way at a time

```js
// Unfold a number: one total, taken apart one way at a time. The way is a knob inside the card; each piece is a part
// whose ref opens its rows, and the pieces add up to the total, which the card says.
const by = k.knob('by', { values: Object.keys(data.splits), at: 'purpose', label: 'unfold by' })
const parts = data.splits[by]
const sum = parts.reduce((s, p) => s + p.n, 0)
return k.stack(
  k.beside(k.text(`**${k.fmt(data.total)}** ${data.what}`), k.dial('by'), { gap: 3 }),
  k.bars(parts.map(p => ({ id: `${by}-${p.key}`.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').slice(0, 60), label: p.key, value: p.n,
    note: `${Math.round(p.n / data.total * 100)}%`,
    meta: { ref: p.ref, examples: data.examples[p.key] && k.examples('ex-' + p.key, { label: `saves that ${p.key}`, records: data.examples[p.key], fmt: '“{text}”\n{user}' }) } }))),
  k.text(sum === data.total ? `{dim:${parts.map(p => k.fmt(p.n)).join(' + ')} = ${k.fmt(sum)}}` : `{warn:the pieces add to ${k.fmt(sum)}, not ${k.fmt(data.total)}}`),
)
```
