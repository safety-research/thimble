## Worked examples

Each example below is a card made on real data with this runtime: what it draws, the rows its data holds, and its program. Together they show what a program can do: layouts, marks, knobs, keys, presses, a brush, and asking about a selection. They are not templates. Choose the form from this claim and this data.

### Bars split by a label: what the calls were, per group

One bar per task, split into what its tool calls were, each part labelled inside it; a knob turns counts into shares, and the detail shows one bar per run under its task. `data.tasks`: rows of a tally by task, `{task, n, n_edit, n_write, n_shell, n_read, n_other}`; `data.runs`: rows of a tally by run, the same counts and its `task`.

```js
// Bars split by a label: one bar per group, its parts what the calls were, each part labelled inside it where it
// fits. A knob turns counts into shares, so groups of different sizes compare by their mix.
const KINDS = [['edit', 'c2'], ['write', 'c3'], ['shell', 'c1'], ['read', 'c4'], ['other', 'dim']]
const by = k.knob('by', { values: ['count', 'share'], at: 'count', label: 'bars show' })
const detail = k.mode === 'detail'
const bar = (d, label) => ({
  ...d, id: (detail ? d.run : d.task).replace(/[^A-Za-z0-9_.-]+/g, '-'), label,
  parts: KINDS.map(([kd, tone]) => ({ value: by === 'share' ? Math.round(d['n_' + kd] / d.n * 100) : d['n_' + kd], tone, label: kd })),
  text: by === 'share' ? `of ${k.fmt(d.n)}` : k.fmt(d.n),
})
// under a reply, one bar per task; in the detail, one bar per run, under its task
const rows = detail
  ? data.tasks.flatMap(t => [k.text(`**${t.task}**`), k.bars(data.runs.filter(r => r.task === t.task).map(r => bar(r, r.run.split('__').slice(1).join(' ') || r.run)), { max: by === 'share' ? 100 : Math.max(...data.runs.map(r => r.n)), labelW: 24 })])
  : [k.bars(data.tasks.map(t => bar(t, t.task)), { max: by === 'share' ? 100 : Math.max(...data.tasks.map(t => t.n)), labelW: 20 })]
const all = data.tasks.reduce((s, t) => s + t.n, 0)
const sum = kd => data.tasks.reduce((s, t) => s + t['n_' + kd], 0)
const files = sum('edit') + sum('write'), shell = sum('shell')
return k.stack(
  k.beside(k.text(`{dim:tool calls per ${detail ? 'run' : 'task'}${by === 'share' ? ', as % of its calls' : ''}}`), k.dial('by'), { gap: 4 }),
  ...rows,
  k.region('takeaway', { label: 'all the tool calls', refs: k.rows(data.tasks) },
    k.text(`Of **${k.fmt(all)}** tool calls, **${Math.round(files / all * 100)}%** edit or write files and **${Math.round(shell / all * 100)}%** run shell commands`)),
)
```

### Trail of one page: its eras, then every save

The page's eras as stations along one line, and under them one column per save, as tall as the page was after it and colored by what the save did; a press on an era or the zoom knob opens it save by save, and a filter knob colors only the wipes. `data.revisions`: rows of one page's saves in order, `{seq, time, label, body_len, move, era}`; `data.eras`: rows of a tally of those saves by era, `{era, n, first, last, wipes, peak, end_len}`.

```js
// The trail of one page's life: its eras as stations along one line, and under them every save as a column as tall as
// the page was after it, colored by what the save did. Knobs go further: zoom (+ −) into one era, filter (f) to wipes.
const eras = data.eras.slice().sort((a, b) => a.first - b.first)
const revs = data.revisions.slice().sort((a, b) => a.seq - b.seq)
const zoom = k.knob('zoom', { values: ['overview', ...eras.map(e => e.era)], at: 'overview', label: 'zoom' })
const filter = k.knob('filter', { values: ['all', 'wipes only'], at: 'all', label: 'filter' })
const peak = Math.max(...revs.map(r => r.body_len))
const tone = { created: 'accent', grew: 'accent', restored: 'good', wiped: 'bad', trimmed: 'dim', same: 'dim' }
const LEVEL = '▁▂▃▄▅▆▇█'
const size = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))
const shown = r => filter === 'all' || r.move === 'wiped'
const moves = '{accent:■} grew {bad:■} wiped {good:■} restored {dim:■} trimmed'
// one column per save (from x(i) to x(i+1)), its height the page's length after it, in eighths from the bottom up
function columns(c, rs, x, y0, rh, top) {
  rs.forEach((r, i) => {
    const x0 = x(i), w = Math.max(1, x(i + 1) - x0 - (x(i + 1) - x0 > 2 ? 1 : 0))
    // a save the filter leaves out stays as a gray column, so the ones it keeps stand out against the page's shape
    let e = Math.max(1, Math.round(r.body_len / top * 8 * rh))
    for (let y = rh - 1; y >= 0 && e > 0; y--, e -= 8) for (let i = 0; i < w; i++) c.put(x0 + i, y0 + y, LEVEL[Math.min(8, e) - 1], shown(r) ? tone[r.move] : 'unseen')
    c.region('save-' + r.seq, x0, y0, Math.max(1, x(i + 1) - x0), rh, { label: `save ${r.seq}: ${r.move}, ${k.fmt(r.body_len)} bytes`, row: r })
  })
}
if (zoom === 'overview') {
  const W = Math.min(k.w - 2, 96), n = revs.length, x = i => Math.floor(i * W / n)
  const rh = k.mode === 'detail' ? 6 : 2
  const c = k.canvas(W, rh + 1)
  // the stations: each era a stretch of the line, named where it starts; a press on one zooms into it
  for (const e of eras) {
    const x0 = x(e.first - 1), x1 = x(e.last), room = x1 - x0 - 3, id = 'era-' + e.era.replace(/[^A-Za-z0-9]+/g, '-')
    const long = `${e.era} ${e.first}–${e.last}`
    const name = k.len(long) < room ? `${e.era} {dim:${e.first}–${e.last}}` : k.len(e.era) < room ? e.era : ''
    const nw = name ? k.len(name.replace(/\{dim:|\}/g, '')) : 0
    c.put(x0, 0, '├', 'ink')
    c.hline(x0 + 1, 0, 1, '─', 'dim')
    if (name) c.text(x0 + 2, 0, name)
    c.hline(x0 + 3 + nw, 0, Math.max(0, x1 - x0 - 3 - nw), '─', 'dim')
    c.region(id, x0, 0, x1 - x0, 1, { label: `${e.era}: saves ${e.first}–${e.last}, ${e.wipes} wipes`, row: e, onPress: () => ({ zoom: e.era }) })
  }
  columns(c, revs, x, 1, rh, peak)
  const wipes = revs.filter(r => r.move === 'wiped').length, last = revs[revs.length - 1], first = eras[0]
  // how much of the page a wipe left: its length after, against the length before
  const left = revs.map((r, i) => (r.move === 'wiped' && i ? r.body_len / revs[i - 1].body_len : null)).filter(v => v != null)
  return k.stack(
    k.beside(k.dial('zoom'), k.dial('filter'), k.text(filter === 'all' ? moves : '{bad:■} wiped {unseen:■} the other saves'), { gap: 3 }),
    c,
    k.text(filter === 'all'
      ? `Built up to **${size(first.peak)}** bytes in ${first.n} saves, then wiped **${wipes}** times in ${n - first.n} more; it ends at ${size(last.body_len)}`
      : `**${wipes}** of ${n} saves wiped the page; each left at most ${Math.round(Math.max(...left) * 100)}% of what was there`),
  )
}
// zoomed into one era: wider, taller columns, each save's number under it
const e = eras.find(x => x.era === zoom)
const rs = revs.filter(r => r.seq >= e.first && r.seq <= e.last)
const cw = Math.max(2, Math.min(6, Math.floor((k.w - 2) / rs.length))), x = i => i * cw
const rh = k.mode === 'detail' ? 8 : 4, top = Math.max(...rs.map(r => r.body_len))
const c = k.canvas(rs.length * cw, rh + 1)
columns(c, rs, x, 0, rh, top)
let free = 0
rs.forEach((r, i) => {
  const s = String(r.seq)
  if (x(i) >= free && (r.move === 'wiped' || i % Math.ceil((s.length + 1) / cw) === 0)) { c.text(x(i), rh, s, { tone: r.move === 'wiped' ? 'bad' : 'dim' }); free = x(i) + s.length + 1 }
})
const wiped = rs.filter(r => r.move === 'wiped'), lens = wiped.map(r => r.body_len)
return k.stack(
  k.beside(k.text(`{dim:overview ›} **${e.era}** · saves ${e.first}–${e.last} · tallest ${size(top)}${filter === 'all' ? '' : ' · {accent:wipes only}'}`), filter === 'all' && k.text(moves), { gap: 3 }),
  c,
  k.text(wiped.length
    ? `${wiped.length} of ${rs.length} saves wiped the page, each down to ${k.fmt(Math.min(...lens))}–${k.fmt(Math.max(...lens))} bytes`
    : 'no save in this era wiped the page'),
)
```

### Curves with a knob: a noisy rate, averaged over a window you choose

One curve per run and split: the training rate as a trailing mean, the held-out checks as they are; the window is a knob, and the sentence under the plot reads it, so the size of the rise changes as the person turns it. `data.steps`: rows of per-step metrics, `{run, split, step, n, win}`; `data.series`: rows of a tally by run and split, `{run, split, n, warm_start, games_per_step}`.

```js
// Curves with a knob: a noisy per-step rate drawn as a trailing mean, with the window as a knob inside the card, and
// the held-out checks beside it. The words under the plot read the knob, so the claim changes as the person turns it.
const win = k.knob('window', { values: [1, 5, 10, 20, 50], at: 20, label: 'mean over', fmt: v => (v === 1 ? 'each step' : `${v} steps`) })
const rowsOf = s => data.steps.filter(d => d.run === s.run && d.split === s.split).sort((a, b) => a.step - b.step)
const mean = rows => rows.reduce((t, d) => t + d.win, 0) / Math.max(1, rows.length)
const trailing = rows => rows.map((d, i) => [d.step, mean(rows.slice(Math.max(0, i - win + 1), i + 1))])
// the run with the most training steps leads; its held-out checks are drawn as they are, never smoothed
const lead = data.series.filter(s => s.split === 'train').sort((a, b) => b.n - a.n)[0]
const series = data.series.map(s => {
  const rows = rowsOf(s), held = s.split !== 'train', main = s.run === lead.run
  return {
    id: `${s.run}-${s.split}`,
    name: `${s.run} ${held ? 'held out' : 'training'}${s.warm_start ? '' : ', no warm start'}`,
    points: held ? rows.map(d => [d.step, d.win]) : trailing(rows),
    tone: !main ? 'dim' : held ? 'c2' : 'accent',
    meta: { row: s },
  }
})
// the claim: the lead run's first and last windows, and its first and last held-out checks; the colored words name
// the lines, so the plot needs no legend
const tr = rowsOf(lead), ho = rowsOf(data.series.find(s => s.run === lead.run && s.split !== 'train'))
const first = tr.slice(0, win), last = tr.slice(-win)
const others = data.series.filter(s => s.run !== lead.run && s.split === 'train')
const pct = x => `${Math.round(x)}%`
return k.stack(
  k.beside(k.text(`{dim:win rate, % of games}`), k.dial('window'), { gap: 4 }),
  k.plot(series, { h: k.mode === 'detail' ? 14 : 8, x: { label: 'training step' }, y: { min: 0, max: 100 }, legend: false }),
  k.region('start-end', { label: `${lead.run}: first and last ${win} training steps`, refs: k.rows([...first, ...last]) },
    k.text(`${win === 1 ? 'Step by step' : `With a ${win}-step mean`}, {accent:${lead.run} in training} wins **${pct(mean(first))}** of games at the start and **${pct(mean(last))}** at the end`)),
  k.region('held-out', { label: `${lead.run}: first and last held-out checks`, refs: k.rows([ho[0], ho[ho.length - 1]]) },
    k.text(`{c2:held out} (${ho[0].n} games a check): ${pct(ho[0].win)} at step ${ho[0].step}, ${pct(ho[ho.length - 1].win)} at step ${ho[ho.length - 1].step}`)),
  others.map(o => k.region(`${o.run}-flat`, { label: `${o.run} in training`, row: o },
    k.text(`{dim:${o.run}, with no warm start, averages ${pct(mean(rowsOf(o)))} over its ${o.n} steps · a training step plays only ${lead.games_per_step} games}`))),
)
```

### Region map of a diff: where one change touched each file

One strip per changed file, each hunk placed where it sits in the file and colored by what it did; a zoom knob opens one file's hunks with the code block each sits in, and a press picks a hunk to ask about. `data.hunks`: rows of a query that parsed one diff, one per hunk, `{file, kind, at, len, old_at, old_len, added, removed, context, first}`.

```js
// A region map of a diff: one strip per changed file, from line 1 to the last line the diff touches; each hunk sits
// where it is, colored by what it did. A zoom knob opens one file's hunks; a press picks a hunk and a key asks about it.
const files = [...new Set(data.hunks.map(h => h.file))].map(f => {
  const hs = data.hunks.filter(h => h.file === f)
  return { file: f, hunks: hs, kind: hs[0].kind, span: Math.max(...hs.map(h => h.at + h.len)),
    added: hs.reduce((s, h) => s + h.added, 0), removed: hs.reduce((s, h) => s + h.removed, 0) }
})
const tone = h => (h.added && h.removed ? 'warn' : h.added ? 'good' : 'bad')
const short = f => { const p = f.split('/'); return p.length > 2 ? '…/' + p.slice(-2).join('/') : f }
const hid = h => `h-${short(h.file).replace(/^…\//, '')}-${h.at}`.replace(/[^A-Za-z0-9_.-]+/g, '-').toLowerCase()
const zoom = k.knob('zoom', { values: ['overview', ...files.map(f => f.file)], at: 'overview', label: 'zoom', fmt: v => (v === 'overview' ? v : short(v)) })
const sel = k.state.sel || null
const picked = sel && data.hunks.find(h => hid(h) === sel)
k.on('a', () => { if (picked) k.ask({ label: `the hunk at ${short(picked.file)} line ${picked.at}`, rows: [picked] }) }, 'ask about the picked hunk')
const pick = h => () => ({ sel: hid(h) })
const added = files.reduce((s, f) => s + f.added, 0), removed = files.reduce((s, f) => s + f.removed, 0)
const testsAdded = files.filter(f => f.kind === 'tests').reduce((s, f) => s + f.added, 0)
const key = '{good:█} added  {bad:█} removed  {warn:█} both'
const LW = Math.min(30, Math.max(...files.map(f => k.len(short(f.file)))) + 1), NW = 13, W = Math.max(24, Math.min(k.w - LW - NW - 2, 90))
const said = picked
  ? `**${short(picked.file)}** line ${picked.at} · +${picked.added} −${picked.removed} · ${k.escape(picked.context || picked.first)} · a asks about it`
  : `**+${k.fmt(added)} −${k.fmt(removed)}** lines in ${files.length} files; ${Math.round(testsAdded / Math.max(1, added) * 100)}% of the added lines are tests`
if (zoom === 'overview') {
  const rows = files.map(f => {
    const c = k.canvas(W, k.mode === 'detail' ? 2 : 1)
    c.hline(0, 0, W, '─', 'unseen')
    let free = 0
    for (const h of f.hunks) {
      const x = Math.min(W - 1, Math.floor((h.at - 1) / f.span * W)), w = Math.max(1, Math.round(Math.max(h.len, h.old_len) / f.span * W))
      c.fill(x, 0, Math.min(w, W - x), 1, '█', hid(h) === sel ? 'accent' : tone(h))
      c.region(hid(h), x, 0, Math.min(w, W - x), 1, { label: `${short(h.file)} line ${h.at}: +${h.added} −${h.removed}`, row: h, onPress: pick(h) })
      // in the detail, each hunk's first line under it, where there is room for its number
      const n = String(h.at), nx = Math.min(x, W - n.length)
      if (k.mode === 'detail' && nx >= free) { c.text(nx, 1, n, { tone: 'dim' }); free = nx + n.length + 1 }
    }
    return k.beside(k.text(short(f.file), { w: LW, wrap: false }), c,
      k.text(`+${f.added} −${f.removed}${f.kind === 'code' ? '' : ' ' + f.kind}`, { w: NW, tone: 'dim' }), { gap: 1 })
  })
  return k.stack(k.text(`{dim:each strip runs from line 1 to the last line changed} · ${key}`), ...rows, k.text(said))
}
// zoomed into one file: a row per hunk, its size to scale, and the function or block it sits in
const f = files.find(x => x.file === zoom), most = Math.max(...f.hunks.map(h => h.added + h.removed))
return k.stack(
  k.text(`{dim:overview ›} **${short(f.file)}** · ${f.hunks.length} hunks · +${f.added} −${f.removed}`),
  ...f.hunks.map(h => k.region(hid(h), { label: `${short(h.file)} line ${h.at}: +${h.added} −${h.removed}`, row: h, onPress: pick(h) },
    k.beside(k.text(`line ${h.at}`, { w: 11, tone: 'dim', align: 'right' }),
      k.bar([{ value: h.added, tone: 'good' }, { value: h.removed, tone: 'bad' }], { max: most, w: 20 }),
      k.text(`+${h.added} −${h.removed}`, { w: 9, tone: 'dim' }),
      k.text(k.escape(h.first || h.context), { tone: hid(h) === sel ? 'accent' : 'ink', wrap: false }), { gap: 1 }))),
  k.text(said),
)
```

### Aligned strips: what each run was doing, at the same share of its work

One strip per run on a shared start-to-end axis, each cell one fortieth of the run's tool calls colored by what it did most; a press zooms into one run, where each activity gets its own row of heights, and a knob shows one activity alone. `data.runs`: rows of a tally by run, `{run, n, n_read, n_write, n_run, n_wait, n_delegate}`; `data.shares`: rows of a tally by run and share of its calls, `{run, share, n, n_read, ..., top}`.

```js
// Aligned strips: several runs on one axis, each scaled to its own length, so the same share of the work lines up.
// One strip per run, one cell per share of its tool calls, colored by what the run did most then; a press zooms into
// one run, where each activity gets its own row of heights.
const ACTS = ['read', 'write', 'run', 'wait', 'delegate']
const tone = { read: 'c4', write: 'c2', run: 'c1', wait: 'c5', delegate: 'c3' }
const runs = [...data.runs].sort((a, b) => b.n - a.n)
const zoom = k.knob('zoom', { values: ['overview', ...runs.map(r => r.run)], at: 'overview', label: 'zoom' })
const only = k.knob('only', { values: ['all', ...ACTS], at: 'all', label: 'show' })
const shares = run => data.shares.filter(d => d.run === run).sort((a, b) => a.share - b.share)
const S = Math.max(...data.shares.map(d => d.share)) + 1
const pc = s => Math.round(s / S * 100)
const LEVEL = '▁▂▃▄▅▆▇█'
const lw = 21, nw = 34
const level = f => (f > 0 ? LEVEL[Math.max(0, Math.round(f * 8) - 1)] : '·')
const pct = (r, a) => `{${tone[a]}:${a} ${Math.round(r['n_' + a] / r.n * 100)}%}`

if (zoom === 'overview') {
  const rh = k.mode === 'detail' ? 2 : 1
  const c = k.canvas(lw + S + 2 + nw, runs.length * rh + 1)
  runs.forEach((r, i) => {
    const y = i * rh, [task, cond] = r.run.split('__')
    c.text(0, y, task, { max: lw - 1 })
    shares(r.run).forEach(d => {
      if (only === 'all') c.put(lw + d.share, y, '█', tone[d.top])
      else c.put(lw + d.share, y, level(d['n_' + only] / d.n), d['n_' + only] ? tone[only] : 'unseen')
    })
    // in the detail, the activities are named in place, under each stretch long enough to hold the word
    if (rh > 1 && only === 'all') {
      const ss = shares(r.run)
      for (let j = 0, e; j < ss.length; j = e + 1) {
        e = j
        while (e + 1 < ss.length && ss[e + 1].top === ss[j].top) e++
        if (e - j + 1 > ss[j].top.length) c.text(lw + ss[j].share, y + 1, ss[j].top, { tone: tone[ss[j].top] })
      }
    }
    const top = only === 'all' ? ACTS.slice().sort((a, b) => r['n_' + b] - r['n_' + a])[0] : only
    c.text(lw + S + 2, y, `{dim:${cond || ''}, ${r.n}} ${pct(r, top)}`, { max: nw })
    c.region(`run-${r.run}`, 0, y, lw + S + 2 + nw, rh, { label: `${r.run}: ${r.n} tool calls`, row: r, onPress: () => ({ zoom: r.run }) })
  })
  c.text(lw, runs.length * rh, 'start', { tone: 'dim' })
  c.text(lw + S - 1, runs.length * rh, 'end', { tone: 'dim', align: 'right' })
  // the longest stretch of one activity in any run, and the longest of another activity, found in the data
  const stretches = []
  for (const r of runs) {
    const ss = shares(r.run)
    for (let j = 0, e; j < ss.length; j = e + 1) {
      e = j
      while (e + 1 < ss.length && ss[e + 1].top === ss[j].top) e++
      stretches.push({ run: r.run, act: ss[j].top, len: e - j + 1, from: ss[j].share, to: ss[e].share })
    }
  }
  stretches.sort((a, b) => b.len - a.len)
  const best = stretches[0], next = stretches.find(x => x.act !== best.act)
  const say = x => `**${x.run}** does mostly {${tone[x.act]}:${x.act}} from ${pc(x.from)}% to ${pc(x.to + 1)}%`
  const key = ACTS.map(a => `{${tone[a]}:${a}}`).join(' ')
  return k.stack(
    k.text(only === 'all' ? `{dim:what each run did most, from its first tool call to its last ·} ${key}` : `{dim:the share of each run's calls that were} {${tone[only]}:${only}}{dim:, start to end}`),
    c,
    k.text(`Longest stretches: ${say(best)} of its calls; ${say(next)}`),
  )
}

// zoomed into one run: a row of heights per activity, one column per share; a press on a column picks it
const r = runs.find(x => x.run === zoom), ss = shares(zoom), at = k.state.at ?? null
const W = Math.max(1, Math.floor((k.w - 28) / S))
const c = k.canvas(12 + S * W + 2 + 12, ACTS.length + 1)
ACTS.forEach((a, y) => {
  c.text(0, y, a, { tone: tone[a] })
  ss.forEach(d => { const f = d['n_' + a] / d.n; c.fill(12 + d.share * W, y, W, 1, f ? level(f) : '▁', f ? (d.share === at ? 'warn' : tone[a]) : 'unseen') })
  c.text(12 + S * W + 2, y, `${r['n_' + a]} calls`, { tone: 'dim' })
})
ss.forEach(d => c.region(`${zoom}-s${d.share}`, 12 + d.share * W, 0, W, ACTS.length, { label: `${zoom}, ${pc(d.share)}–${pc(d.share + 1)}% of its calls (${d.n})`, row: d, onPress: () => ({ at: d.share }) }))
c.text(12, ACTS.length, 'start', { tone: 'dim' })
c.text(12 + S * W - 1, ACTS.length, 'end', { tone: 'dim', align: 'right' })
const p = at != null ? ss.find(d => d.share === at) : null
k.on('a', () => {
  if (p) k.ask({ label: `${zoom}: its calls ${pc(at)}–${pc(at + 1)}% of the way through`, rows: [p] })
  else k.ask({ label: `${zoom}: all ${r.n} tool calls`, rows: [r] })
}, 'ask about these calls')
return k.stack(
  k.beside(k.text(`{dim:overview ›} **${zoom}** {dim:· ${r.n} calls, ${Math.round(r.n / S)} a column}`), k.dial('only'), { gap: 3 }),
  c,
  k.text(p
    ? `${pc(at)}–${pc(at + 1)}% through: ${ACTS.filter(a => p['n_' + a]).map(a => `${p['n_' + a]} ${a}`).join(', ')} · a asks about these calls`
    : `Mostly ${pct(r, ACTS.slice().sort((a, b) => r['n_' + b] - r['n_' + a])[0])} · press a column to pick it, a asks about it`),
)
```

### Unfold a number: one total, taken apart one way at a time

One total drawn as bars, taken apart one way at a time by a knob, each piece a bar from its own row with its share, and a line that checks the pieces add up to the total; a press picks a piece to ask about. `data.parts`: rows of a tally by way and piece, `{way, key, n}` (every way adds up to the same total).

```js
// Unfold a number: one total, taken apart one way at a time. The way is a knob; each piece is a bar drawn from its
// row, the pieces add up to the total, and the card says so. A press picks a piece, and a key asks about its rows.
const ways = [...new Set(data.parts.map(p => p.way))]
const by = k.knob('by', { values: ways, at: ways[0], label: 'unfold by' })
const of = w => data.parts.filter(p => p.way === w)
const total = of(ways[0]).reduce((s, p) => s + p.n, 0)
const sel = k.state.sel || null
const slug = p => `${p.way}-${p.key}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')
const bars = w => k.bars(of(w).map((p, i) => ({ ...p, id: slug(p), label: p.key, value: p.n, tone: slug(p) === sel ? 'warn' : k.cat(i),
  note: `${Math.round(p.n / total * 100)}%` })), { max: total, labelW: 22 })
const sum = w => { const ps = of(w), s = ps.reduce((a, p) => a + p.n, 0)
  return k.text(s === total ? `{dim:${ps.map(p => k.fmt(p.n)).join(' + ')} = ${k.fmt(s)}}` : `{warn:the pieces add to ${k.fmt(s)}, not ${k.fmt(total)}}`) }
k.on('press', e => ({ sel: e.region }), 'pick a piece')
const picked = sel && data.parts.find(p => slug(p) === sel)
k.on('a', () => { if (picked) k.ask({ label: `merged PRs: ${picked.way}, ${picked.key}`, rows: [picked] }) }, 'ask about the picked piece')
const first = of(by).slice().sort((a, b) => b.n - a.n)[0]
return k.stack(
  k.beside(k.text(`**${k.fmt(total)}** PRs merged`), k.dial('by'), { gap: 3 }),
  bars(by),
  sum(by),
  // the detail has room for every way at once, the chosen one first
  k.mode === 'detail' && k.space(1, 1),
  k.mode === 'detail' && k.stack(...ways.filter(w => w !== by).map(w => k.stack(k.text(`{dim:by ${w}}`), bars(w))), { gap: 1 }),
  k.mode === 'detail' && k.space(1, 1),
  k.text(picked ? `**${k.fmt(picked.n)}** merged PRs: ${picked.key} · a asks about them`
    : `By ${by}, the largest piece is ${first.key}: **${k.fmt(first.n)}** of ${k.fmt(total)} (${Math.round(first.n / total * 100)}%)`),
)
```

### Small multiples: one histogram per group on the same axes

One small histogram of page length per wiki, side by side on the same axes; a knob switches the heights between each wiki's share and one page-count scale, and a press marks one length in every panel. `data.lengths`: rows of a tally by wiki and length in powers of ten of bytes, `{wiki, power, length, n}`.

```js
// Small multiples: one small histogram per group, all on the same axes, so the shapes compare at a glance. A knob sets
// what a column's height is; a press picks one length and marks it in every panel, and a asks about those pages.
const height = k.knob('height', { values: ['share of the wiki', 'page count'], at: 'share of the wiki', label: 'height' })
const P = [...new Set(data.lengths.map(d => d.power))].sort((a, b) => a - b)
const lo = P[0], hi = P[P.length - 1], nb = hi - lo + 1
const name = p => (data.lengths.find(d => d.power === p) || {}).length || ''
const groups = [...new Set(data.lengths.map(d => d.wiki))]
  .map(w => ({ wiki: w, rows: data.lengths.filter(d => d.wiki === w) }))
  .map(g => ({ ...g, total: g.rows.reduce((s, d) => s + d.n, 0) }))
  .sort((a, b) => b.total - a.total)
const value = (d, g) => (height === 'page count' ? d.n : d.n / g.total)
const top = Math.max(...groups.flatMap(g => g.rows.map(d => value(d, g))))
const detail = k.mode === 'detail'
const per = detail ? 2 : groups.length                       // panels per row: a 2 × 2 grid in the detail
const cw = Math.max(2, Math.min(detail ? 6 : 3, Math.floor((k.w / per - 3) / nb))), rh = detail ? 8 : 4
const LEVEL = '▁▂▃▄▅▆▇█'
const pick = k.state.pick ?? null
k.on('press', e => { const d = data.lengths.find(x => `${x.wiki}-${x.power}`.replace(/[^A-Za-z0-9_-]+/g, '-') === e.region); return d ? { pick: d.power } : null }, 'mark this length in every panel')
k.on('a', () => { if (pick != null) k.ask({ label: `pages of ${name(pick)} bytes, on every wiki`, rows: data.lengths.filter(d => d.power === pick) }) }, 'ask about the marked length')
const panel = g => {
  const c = k.canvas(nb * cw, rh + 2)
  c.text(0, 0, `**${g.wiki}** {dim:${k.fmt(g.total)} pages}`, { max: nb * cw })
  for (const d of g.rows) {
    const x = (d.power - lo) * cw
    const room = detail ? rh - 1 : rh                        // the detail keeps a row above the tallest for its share
    let e = Math.max(1, Math.round(value(d, g) / top * 8 * room))
    for (let y = rh; y >= 1 && e > 0; y--, e -= 8) for (let i = 0; i < cw - 1; i++) c.put(x + i, y, LEVEL[Math.min(8, e) - 1], pick == null || d.power === pick ? 'accent' : 'unseen')
    c.region(`${g.wiki}-${d.power}`.replace(/[^A-Za-z0-9_-]+/g, '-'), x, 1, cw, rh, { label: `${g.wiki}: ${k.fmt(d.n)} pages of ${d.length} bytes (${Math.round(d.n / g.total * 100)}%)`, row: d })
    if (detail && cw >= 4) c.text(x, Math.max(1, rh - Math.ceil(value(d, g) / top * room)), height === 'page count' ? k.fmt(d.n) : `${Math.round(d.n / g.total * 100)}%`, { tone: 'dim', max: cw })
  }
  // the axis: the powers of ten under their columns, as many as fit
  let free = 0
  for (const p of P) {
    const s = name(p).split('–')[0], x = (p - lo) * cw
    if (p % 2 === 1 && x >= free && x + k.len(s) <= nb * cw) { c.text(x, rh + 1, s, { tone: p === pick ? 'warn' : 'dim' }); free = x + k.len(s) + 1 }
  }
  return c
}
const rows = []
for (let i = 0; i < groups.length; i += per) rows.push(k.beside(...groups.slice(i, i + per).map(panel), { gap: 3 }))
const grid = k.stack(...rows, { gap: detail ? 1 : 0 })
// the takeaway: the group whose pages are most often short, against the largest group
const shortShare = g => g.rows.filter(d => d.power <= lo + 1).reduce((s, d) => s + d.n, 0) / g.total
const most = groups.filter(g => g.total >= 20).sort((a, b) => shortShare(b) - shortShare(a))[0], big = groups[0]
const pct = x => Math.round(x * 100) + '%'
return k.stack(
  k.beside(k.text(`{dim:pages by length in bytes, powers of ten}`), k.dial('height'), { gap: 4 }),
  grid,
  k.text(pick != null
    ? `**${name(pick)}** bytes: ${groups.map(g => { const d = g.rows.find(x => x.power === pick); return `${g.wiki} ${pct(d ? d.n / g.total : 0)}` }).join(' · ')} · a asks about them`
    : most === big
    ? `**${pct(shortShare(big))}** of ${big.wiki}'s pages are under ${name(lo + 2).split('–')[0]} bytes`
    : `**${pct(shortShare(most))}** of ${most.wiki}'s ${k.fmt(most.total)} pages are under ${name(lo + 2).split('–')[0]} bytes, against ${pct(shortShare(big))} of ${big.wiki}'s`),
)
```

### Two-sided flip: names to network ranges, and back

A card with two sides: names counted by how many /16 ranges each saved from, and ranges counted by how many names saved from each; each side has one strip of the whole spread and bars for the widest; space flips it, a press picks a bar, and a key asks about its rows. `data.names`: rows of a tally by account name, `{label, saves, ranges}` (the 30 widest); `data.ranges`: rows of a tally by /16 range, `{ip16, saves, names}` (the 30 widest); `data.spread`: rows of a tally of both sides by how far each spreads, `{side, spread, count}`.

```js
// A two-sided card: one side counts how many network ranges each name saved from, the other how many names saved from
// each range. space flips it; a press picks a bar, and a asks about the rows behind it.
const side = k.state.side || 'names'
const S = side === 'names'
  ? { rows: data.names, key: 'label', n: 'ranges', unit: 'ranges', each: 'name', of: 'names', other: 'ranges → names' }
  : { rows: data.ranges, key: 'ip16', n: 'names', unit: 'names', each: '/16 range', of: 'ranges', other: 'names → ranges' }
k.on('space', () => ({ side: side === 'names' ? 'ranges' : 'names', pick: null }), `flip to ${S.other}`)
k.on('press', e => ({ pick: e.region }), 'pick a bar')
const ORDER = ['1', '2–5', '6–20', '21 or more'], TONE = { '1': 'dim', '2–5': 'c4', '6–20': 'c2', '21 or more': 'accent' }
const spread = data.spread.filter(d => d.side === side).sort((a, b) => ORDER.indexOf(a.spread) - ORDER.indexOf(b.spread))
const total = spread.reduce((s, d) => s + d.count, 0)
// the spread: one strip as long as all names (or ranges), cut by how many of the other each one saw, named under it
const W = Math.min(k.w - 2, 96)
const short = d => (d.spread === '1' ? `1 ${S.unit.slice(0, -1)}` : d.spread === '21 or more' ? '21+' : d.spread)
let x = 0
const parts = spread.map(d => { const w = Math.max(1, Math.round(d.count / total * W)), p = { x, w: Math.min(w, W - x), d }; x += w; return p })
// each part's name on the first row under it that is free where it starts (moved left to fit the width)
const free = [0, 0]
for (const p of parts) {
  const len = k.len(`${short(p.d)} · ${k.fmt(p.d.count)}`), at = Math.max(0, Math.min(p.x, W - len))
  const row = free.findIndex(f => f <= at)
  if (row >= 0) { p.label = { at, row }; free[row] = at + len + 2 }
}
const c = k.canvas(W, 1 + (parts.some(p => p.label && p.label.row === 1) ? 2 : 1))
for (const p of parts) {
  c.fill(p.x, 0, p.w, 1, '█', TONE[p.d.spread])
  c.region('spread-' + side + '-' + ORDER.indexOf(p.d.spread), p.x, 0, p.w, 1, { label: `${k.fmt(p.d.count)} ${S.of} saw ${p.d.spread} ${S.unit}`, row: p.d })
  if (p.label) c.text(p.label.at, 1 + p.label.row, `${short(p.d)} {dim:· ${k.fmt(p.d.count)}}`)
}
const top = S.rows.slice().sort((a, b) => b[S.n] - a[S.n]).slice(0, k.mode === 'detail' ? 15 : 5)
const pick = k.state.pick || null
const items = top.map(d => ({ ...d, id: `${side}-${String(d[S.key]).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label: String(d[S.key]), value: d[S.n],
  tone: undefined, note: `${k.fmt(d.saves)} saves` }))
items.forEach(it => { if (it.id === pick) it.tone = 'warn' })
const picked = items.find(it => it.id === pick)
k.on('a', () => { if (picked) k.ask({ label: `the saves of ${S.each} ${picked.label}`, rows: [top.find(d => String(d[S.key]) === picked.label)] }) }, 'ask about the picked bar')
const many = spread.filter(d => d.spread !== '1').reduce((s, d) => s + d.count, 0), widest = top[0]
return k.stack(
  k.text(`**${S.of === 'names' ? 'names → ranges' : 'ranges → names'}** {dim:· how many ${S.unit} each ${S.each} saw · space flips to ${S.other}}`),
  c,
  k.text(`{dim:the most ${S.unit} per ${S.each}}`),
  k.bars(items, { labelW: Math.min(26, Math.max(...items.map(it => k.len(it.label))) + 2) }),
  k.text(picked
    ? `**${picked.label}**: ${k.fmt(picked.value)} ${S.unit} in ${picked.note} · a asks about them`
    : `**${k.fmt(many)}** of ${k.fmt(total)} ${S.of} saw more than one ${S.unit === 'ranges' ? 'range' : 'name'}; ${String(widest[S.key])} saw ${k.fmt(widest[S.n])}`),
)
```

### Heat strips: when in the day the saves land

One strip per wiki and one cell per hour of the day, each cell as tall as its count; the knob sets what a height is relative to, and a press picks an hour to ask about. `data.hours`: rows of a tally by wiki and hour, `{wiki, hour, n}`.

```js
// Heat strips: one strip per group, one cell per hour of the day, each cell as tall as its count. A knob sets what a
// height is relative to; a press picks an hour, and a key asks about the rows behind it.
const scale = k.knob('scale', { values: ['each wiki', 'all wikis'], at: 'each wiki', label: 'height against' })
const groups = [...new Set(data.hours.map(d => d.wiki))]
  .map(w => ({ wiki: w, rows: data.hours.filter(d => d.wiki === w) }))
  .map(g => ({ ...g, total: g.rows.reduce((s, d) => s + d.n, 0), max: Math.max(...g.rows.map(d => d.n)) }))
  .sort((a, b) => b.total - a.total)
const top = Math.max(...groups.map(g => g.max))
const cw = k.w >= 96 ? 3 : 2, lw = 10, rh = k.mode === 'detail' ? 3 : 1
const LEVEL = '▁▂▃▄▅▆▇█', gap = rh > 1 ? 1 : 0
const c = k.canvas(lw + 24 * cw + 9, groups.length * (rh + gap) + 1)
const sel = k.state.sel || null
groups.forEach((g, i) => {
  const y = i * (rh + gap)
  c.text(0, y + rh - 1, g.wiki, { max: lw - 1 })
  for (let h = 0; h < 24; h++) if (!g.rows.some(d => d.hour === h)) c.put(lw + h * cw, y + rh - 1, '·', 'unseen')
  for (const d of g.rows) {
    const id = `${g.wiki}-h${d.hour}`, x = lw + d.hour * cw, tone = id === sel ? 'warn' : 'accent'
    // the height in eighths of a cell: full cells from the bottom up, then the part that is left
    let e = Math.max(1, Math.round(d.n / (scale === 'each wiki' ? g.max : top) * 8 * rh))
    for (let r = rh - 1; r >= 0 && e > 0; r--, e -= 8) c.fill(x, y + r, cw - 1, 1, LEVEL[Math.min(8, e) - 1], tone)
    c.region(id, x, y, cw, rh, { label: `${g.wiki}, ${String(d.hour).padStart(2, '0')}:00–:59 UTC: ${k.fmt(d.n)} saves`, row: d, onPress: () => ({ sel: id }) })
  }
  c.text(lw + 24 * cw + 1, y + rh - 1, k.fmt(g.total), { tone: 'dim' })
})
for (const h of [0, 6, 12, 18, 23]) c.text(lw + h * cw, groups.length * (rh + gap) - gap, String(h).padStart(2, '0'), { tone: 'dim' })
// the takeaway: the busiest four hours of the busiest group, found in the data; or the hour the person picked
const big = groups[0]
const win = Array.from({ length: 21 }, (_, h0) => ({ h0, n: big.rows.filter(d => d.hour >= h0 && d.hour < h0 + 4).reduce((s, d) => s + d.n, 0) }))
  .sort((a, b) => b.n - a.n)[0]
const picked = sel && data.hours.find(d => `${d.wiki}-h${d.hour}` === sel)
k.on('a', () => { if (picked) k.ask({ label: `${picked.wiki} saves at ${picked.hour}:00 UTC`, rows: [picked] }) }, 'ask about the picked hour')
return k.stack(
  k.beside(k.text('{dim:hour of day, UTC}'), k.dial('scale'), { gap: 4 }),
  c,
  k.text(picked
    ? `**${k.fmt(picked.n)}** ${picked.wiki} saves at ${picked.hour}:00 · a asks about them`
    : `${big.wiki}: **${k.fmt(win.n)}** of ${k.fmt(big.total)} saves (${Math.round(win.n / big.total * 100)}%) land in four hours, ${win.h0}:00–${win.h0 + 4}:00 UTC`),
)
```

### Dumbbell: two groups compared under each condition

One line per condition with one dot per model on a shared scale, the gap drawn between them and the ratio at the end; a knob picks the measure, and a press picks a condition to ask about. `data.runs`: rows of a tally by run, `{run, model, condition, issues, workers, merges, reviews, pushes, comments}`.

```js
// Dumbbell: one line per condition with two dots, one per model, so the gap between them reads at a glance. A knob
// picks the measure; a press picks a condition, and a key asks about the rows behind both of its dots.
const metric = k.knob('metric', { values: ['merges', 'reviews', 'pushes', 'comments'], at: 'merges', label: 'per agent' })
const models = [...new Set(data.runs.map(r => r.model))]
const name = r => r.condition + (r.issues ? ' + issues' : '')
const conds = [...new Set(data.runs.map(name))]
const per = r => r[metric] / r.workers
const pairs = conds.map(c => models.map(m => data.runs.find(r => name(r) === c && r.model === m)))
const top = Math.max(...data.runs.map(per))
const lw = 20, vw = 6, rh = k.mode === 'detail' ? 2 : 1
const rw = 12, W = Math.max(20, k.w - lw - 2 * vw - rw), x0 = lw + vw
const X = v => x0 + Math.round(v / top * (W - 1))
const tone = [k.cat(0), k.cat(1)]
const sel = k.state.sel || null
const c = k.canvas(x0 + W + vw + rw, conds.length * rh + 2)
pairs.forEach(([a, b], i) => {
  const y = i * rh + 1, id = 'cond-' + conds[i].replace(/\W+/g, '-')
  const xa = X(per(a)), xb = X(per(b)), lo = Math.min(xa, xb), hi = Math.max(xa, xb)
  c.region(id, 0, y, lw - 1, rh, { label: `${conds[i]}: ${models[0]} ${per(a).toFixed(1)}, ${models[1]} ${per(b).toFixed(1)} ${metric} per agent`, onPress: () => ({ sel: id }) })
  c.text(0, y, conds[i], { tone: id === sel ? 'warn' : 'ink', bold: id === sel })
  if (hi - lo > 1) c.hline(lo + 1, y, hi - lo - 1, '─', 'dim')
  ;[[a, xa, 0], [b, xb, 1]].forEach(([r, x, j]) => {
    c.put(x, y, '●', tone[j])
    c.region(`${id}-${r.model}`, x, y, 1, 1, { label: `${r.model}, ${conds[i]}: ${k.fmt(r[metric])} ${metric} by ${r.workers} worker agents`, row: r, onPress: () => ({ sel: id }) })
  })
  // the values sit outside the dots: the smaller one left, the larger one right
  const [left, right] = per(a) <= per(b) ? [a, b] : [b, a]
  c.text(lo - 2, y, per(left).toFixed(1), { tone: 'dim', align: 'right' })
  c.text(hi + 2, y, per(right).toFixed(1), { tone: 'dim' })
  c.text(x0 + W + vw + 1, y, `×${(per(b) / per(a)).toFixed(1)}`, { tone: per(b) >= per(a) ? tone[1] : tone[0] })
  if (rh > 1) c.text(lw, y + 1, `{dim:${models[0]} ${k.fmt(a[metric])} · ${models[1]} ${k.fmt(b[metric])} ${metric} by ${a.workers === b.workers ? `${a.workers} worker agents each` : `${a.workers} and ${b.workers} worker agents`}}`)
})
// a quiet scale under the lines: zero and the largest value
const ya = conds.length * rh + 1
const topText = top.toFixed(1)
c.text(x0, ya, '0', { tone: 'dim' })
c.hline(x0 + 2, ya, W - topText.length - 4, '─', 'unseen')
c.text(x0 + W - 1, ya, topText, { tone: 'dim', align: 'right' })
// the model names in place, above the first line's dots
const [fa, fb] = pairs[0], xa0 = X(per(fa)), xb0 = X(per(fb))
c.text(xa0, 0, models[0], { tone: tone[0], align: xa0 <= xb0 ? 'right' : 'left' })
c.text(xb0, 0, models[1], { tone: tone[1], align: xa0 <= xb0 ? 'left' : 'right' })
c.text(x0 + W + vw + 1, 0, `${models[1]}/${models[0]}`, { tone: 'dim' })
const tot = models.map(m => data.runs.filter(r => r.model === m).reduce((s, r) => s + r[metric], 0))
const picked = sel && pairs[conds.findIndex(cn => 'cond-' + cn.replace(/\W+/g, '-') === sel)]
k.on('a', () => { if (picked) k.ask({ label: `${metric} in the ${name(picked[0])} runs, ${models.join(' vs ')}`, rows: picked }) }, 'ask about the picked condition')
return k.stack(
  k.beside(k.text(`{dim:${metric} per worker agent, in one run}`), k.dial('metric'), { gap: 4 }),
  c,
  k.text(`All ${conds.length} conditions: ${models[0]} **${k.fmt(tot[0])}** ${metric}, ${models[1]} **${k.fmt(tot[1])}** (×${(tot[1] / tot[0]).toFixed(1)})${picked ? ' · a asks about the picked condition' : ''}`),
)
```

### Sign grid: what each condition did with the same items

One row per item and one column per run, grouped by model, with a sign for what happened to the item in that run; a knob (or a press on a count) picks the rows to list, and a press on a cell picks it to ask about. `data.runs`: rows of a query, one per run, `{run, model, condition, issues, hours}`; `data.prs`: rows of a tally by PR, `{number, title, merged, states, cell_refs}` (states: one letter per run, in the order of runs).

```js
// Sign grid: items down, conditions across, one sign per cell for what happened to the item there. A knob picks which
// items to list (the ones every condition agreed on, or the ones that split them); a press picks a cell to ask about.
const runs = data.runs
const SIGN = { M: ['●', 'good', 'merged'], C: ['○', 'bad', 'closed'], O: ['·', 'dim', 'left open'] }
const n = runs.length
const sets = {
  // the most divided first: the items that half the runs merged
  'split runs': data.prs.filter(p => p.merged > 0 && p.merged < n).sort((a, b) => Math.abs(a.merged - n / 2) - Math.abs(b.merged - n / 2) || a.number - b.number),
  'merged in every run': data.prs.filter(p => p.merged === n),
  'merged in none': data.prs.filter(p => p.merged === 0),
}
const show = k.knob('show', { values: Object.keys(sets), at: 'split runs', label: 'show' })
const sel = k.state.sel || null
// columns: the runs grouped by model, each column one condition, labelled once above
const models = [...new Set(runs.map(r => r.model))]
const code = r => r.condition[0].toUpperCase() + (r.issues ? '+i' : '')
const cw = 4, gap = 2, rw = 7
const lw = Math.max(20, Math.min(40, k.w - models.length * (4 * cw + gap) - rw - 2))
const colX = runs.map(r => {
  const g = models.indexOf(r.model), i = runs.filter(x => x.model === r.model).indexOf(r)
  return lw + g * (4 * cw + gap) + i * cw
})
const list = sets[show]
const room = k.mode === 'detail' ? Math.max(8, k.h - 9) : 7
const shown = list.slice(0, room)
const c = k.canvas(lw + models.length * (4 * cw + gap) + rw, shown.length + 2)
models.forEach((m, g) => c.text(lw + g * (4 * cw + gap), 0, m, { bold: true }))
runs.forEach((r, j) => c.text(colX[j], 1, code(r), { tone: 'dim' }))
shown.forEach((p, i) => {
  const y = i + 2
  c.region(`pr-${p.number}`, 0, y, lw - 1, 1, { label: `#${p.number} ${p.title}`, row: p })
  const name = `#${p.number} ${p.title}`
  c.text(0, y, k.len(name) > lw - 2 ? name.slice(0, lw - 3) + '…' : name)
  ;[...p.states].forEach((s, j) => {
    const id = `pr-${p.number}-${j}`, [glyph, tone] = SIGN[s]
    c.put(colX[j], y, glyph, id === sel ? 'warn' : tone)
    c.region(id, colX[j], y, cw - 1, 1, { label: `#${p.number} in ${runs[j].model}, ${runs[j].condition}${runs[j].issues ? ' with issues' : ''}: ${SIGN[s][2]}`,
      ref: p.cell_refs[j], onPress: () => ({ sel: id }) })
  })
  c.text(lw + models.length * (4 * cw + gap), y, `${p.merged}/${n}`, { tone: 'dim' })
})
// the three sets as words that switch the list
const count = (name, words) => k.region(`set-${name.replace(/\W+/g, '-')}`, { label: `${sets[name].length} PRs ${name}`, onPress: () => ({ show: name }) },
  k.text(`${name === show ? '**' : ''}${sets[name].length}${name === show ? '**' : ''} ${words}`, { tone: name === show ? 'ink' : 'dim' }))
const picked = sel && (() => { const [, num, j] = sel.split('-'); const p = data.prs.find(x => String(x.number) === num); return p && { p, j: +j } })()
k.on('a', () => { if (picked) k.ask({ label: `PR #${picked.p.number} in the ${runs[picked.j].model} ${runs[picked.j].condition}${runs[picked.j].issues ? ' with issues' : ''} run`, refs: [picked.p.cell_refs[picked.j]] }) }, 'ask about the picked cell')
const conds = [...new Set(runs.map(r => r.condition))]
return k.stack(
  k.beside(k.text(`{good:●} merged  {bad:○} closed  {dim:·} left open`), k.dial('show'), { gap: 4 }),
  c,
  list.length > shown.length ? k.text(`{dim:${list.length - shown.length} more ${show}}`) : false,
  k.beside(count('merged in every run', 'merged in every run'), count('split runs', 'split the runs'), count('merged in none', 'merged in none'), { gap: 3 }),
  k.text(picked
    ? `#${picked.p.number}: ${SIGN[picked.p.states[picked.j]][2]} in ${runs[picked.j].model} · ${runs[picked.j].condition} · a asks about it`
    : `The ${n} runs of ${runs[0].hours} hours agree on **${sets['merged in every run'].length + sets['merged in none'].length}** of the ${data.prs.length} open PRs. {dim:${conds.map(x => `${x[0].toUpperCase()} ${x}`).join(' · ')} · +i with issues}`),
)
```

### Brushable timeline: when the work happened, and a window to ask about

One strip per kind of action on a shared clock, each bin as tall as its count; a drag across the clock in the browser, or [ and ] in the terminal, moves a window, the counts at the right follow it, and a key asks about the rows in it. `data.bins`: rows of a tally by action and 10-minute bin, `{action, minute, n, span}` (span: the run's length in minutes).

```js
// A brushable timeline: one strip per kind of action on one shared clock, each bin as tall as its count. A drag on the
// clock (in the browser) or [ and ] (in the terminal) picks a window; the counts follow it, and a key asks about it.
const rows = data.bins
const step = 10, span = Math.max(rows[0].span, ...rows.map(d => d.minute + step)), nb = Math.ceil(span / step)
const kinds = [...new Set(rows.map(d => d.action))]
  .map(a => ({ a, rows: rows.filter(d => d.action === a) }))
  .map(g => ({ ...g, total: g.rows.reduce((s, d) => s + d.n, 0), max: Math.max(...g.rows.map(d => d.n)) }))
  .sort((x, y) => y.total - x.total)
// the quiet stretches: bins where the whole swarm did almost nothing, joined when they touch
const per = Array.from({ length: nb }, (_, b) => rows.filter(d => d.minute === b * step).reduce((s, d) => s + d.n, 0))
const med = [...per].sort((x, y) => x - y)[Math.floor(nb / 2)]
const quiet = []
per.forEach((n, b) => { if (n < med * 0.1 && b > 0 && b < nb - 1) { const q = quiet[quiet.length - 1]; if (q && q.to === b * step) q.to += step; else quiet.push({ from: b * step, to: (b + 1) * step }) } })
const win = k.state.win || quiet[0] || { from: 0, to: 60 }
const hm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
const lw = 9, rw = 15, rh = k.mode === 'detail' ? 3 : 1
const W = Math.max(nb, k.w - lw - rw), X = m => lw + Math.floor(m / span * W)
const LEVEL = '▁▂▃▄▅▆▇█'
const c = k.canvas(lw + W + rw, kinds.length * rh + 2)
kinds.forEach((g, i) => {
  const y = i * rh, tone = k.cat(i)
  c.text(0, y + rh - 1, g.a, { tone })
  for (const d of g.rows) {
    const x = X(d.minute), w = Math.max(1, X(d.minute + step) - x)
    let e = Math.max(1, Math.round(d.n / g.max * 8 * rh))
    for (let r = rh - 1; r >= 0 && e > 0; r--, e -= 8) c.fill(x, y + r, w, 1, LEVEL[Math.min(8, e) - 1], tone)
    c.region(`${g.a}-m${d.minute}`, x, y, w, rh, { label: `${k.fmt(d.n)} ${g.a} actions, ${hm(d.minute)}–${hm(d.minute + step)} from the start`, row: d })
  }
  const inW = g.rows.filter(d => d.minute >= win.from && d.minute < win.to).reduce((s, d) => s + d.n, 0)
  c.text(lw + W + 1, y + rh - 1, `${k.fmt(inW)} of ${k.fmt(g.total)}`, { tone: 'dim' })
})
// the clock, the window under it, and the brush across all strips
const yc = kinds.length * rh
for (let h = 0; h * 60 <= span; h++) c.text(Math.min(X(h * 60), lw + W - 2), yc, `${h}h`, { tone: 'dim' })
c.hline(X(win.from), yc + 1, Math.max(1, X(win.to) - X(win.from)), '━', 'warn')
c.text(X(win.to) + 1, yc + 1, `${hm(win.from)}–${hm(win.to)}`, { tone: 'warn' })
c.brush('clock', lw, 0, W, kinds.length * rh + 1, { min: 0, max: span })
const move = d => () => { const len = win.to - win.from, from = Math.max(0, Math.min(span - len, win.from + d)); return { win: { from, to: from + len } } }
k.on('brush', e => { const from = Math.floor(e.from / step) * step, to = Math.max(from + step, Math.ceil(e.to / step) * step); return { win: { from, to } } }, 'pick a window')
k.on('[', move(-step), 'window earlier')
k.on(']', move(step), 'window later')
const inWin = rows.filter(d => d.minute >= win.from && d.minute < win.to)
// an empty window asks about the bins on either side of it, where the work stopped and started again
const edges = rows.filter(d => d.minute === win.from - step || d.minute === win.to)
k.on('a', () => { k.ask({ label: `write actions ${hm(win.from)}–${hm(win.to)} from the start${inWin.length ? '' : ' (none in it: the bins on either side)'}`, rows: inWin.length ? inWin : edges }) }, 'ask about the window')
const nWin = inWin.reduce((s, d) => s + d.n, 0), all = per.reduce((s, n) => s + n, 0)
return k.stack(
  k.text(`{dim:write actions per ${step} minutes, each strip on its own scale · [ ] or a drag moves the window}`),
  c,
  k.text(`${quiet.length ? `Quiet ${['', 'once', 'twice'][quiet.length] || quiet.length + ' times'}: ${quiet.map(q => `${hm(q.from)}–${hm(q.to)}`).join(', ')} · ` : ''}window ${hm(win.from)}–${hm(win.to)}: **${k.fmt(nWin)}** of ${k.fmt(all)} actions · a asks`),
)
```

### Flow between two sides: who reviewed whose work

Reviewers in groups on the left and whose claim each reviewed pull request was under on the right, each flow a line whose weight shows its count, written at its end with its share of the group; a knob regroups the reviewers, and a press picks a flow to ask about. `data.reviews`: rows of a tally of reviews by model, condition and whose claim, `{model, condition, whose, n, changes}`.

```js
// A flow between two sides: reviewers in groups on the left, whose claim the reviewed pull request was under on the
// right. Each flow is a line whose weight shows its count, written at its end. A knob regroups the left side; a press
// picks a flow, and a key asks about its rows.
const by = k.knob('group', { values: ['model', 'condition'], at: 'model', label: 'reviewers by' })
const sum = (rs, f) => rs.reduce((s, d) => s + d[f], 0)
const order = key => [...new Set(data.reviews.map(d => d[key]))]
  .map(v => ({ v, n: sum(data.reviews.filter(d => d[key] === v), 'n') })).sort((a, b) => b.n - a.n)
const lefts = order(by), rights = order('whose'), L = lefts.length, R = rights.length
const gap = k.mode === 'detail' ? 1 : 0
const flows = lefts.flatMap((l, gi) => rights.map((r, ri) => {
  const rows = data.reviews.filter(d => d[by] === l.v && d.whose === r.v)
  // each left group is a band of one row per flow, in the right side's order; each right node a band of one row per
  // left group: the lines fan out and in
  return { id: `flow-${l.v}-${r.v}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-'), l, r, gi, ri, rows,
    n: sum(rows, 'n'), changes: sum(rows, 'changes'), yl: gi * (R + gap) + ri, yr: ri * (L + gap) + gi }
}))
const max = Math.max(...flows.map(f => f.n))
const sel = k.state.sel || null
const picked = flows.find(f => f.id === sel)
k.on('a', () => { if (picked) k.ask({ label: `${picked.l.v} reviewers, pull requests under ${picked.r.v}`, rows: picked.rows }) }, 'ask about the picked flow')

// where each flow turns: one column per flow, in an order that keeps a flow's left run clear of the right run that
// shares its row (follow each chain of shared rows, a column between turns; a loop closes with a short overlap)
const bends = flows.filter(f => f.yl !== f.yr), cols = []
const prevOf = f => bends.find(a => a.yl === f.yr), nextOf = f => bends.find(b => b.yr === f.yl)
const done = new Set()
for (const start of [...bends.filter(f => !prevOf(f)), ...bends]) {
  if (done.has(start)) continue
  for (let f = start; f && !done.has(f); f = nextOf(f)) { done.add(f); cols.push(f, null) }
}
const LW = Math.max(...lefts.map(l => k.len(l.v))) + 8, RW = Math.max(...rights.map(r => k.len(r.v))) + 1
const x0 = LW + 1, x1 = k.w - RW - 13, zone = cols.length, xs = Math.max(x0 + 2, Math.floor((x0 + x1 - zone) / 2))
const xm = new Map(cols.map((f, i) => [f, xs + i]))
const H = Math.max(L * (R + gap), R * (L + gap)) - gap
const c = k.canvas(x1 + 12 + RW, H)
const G = [{ h: '╌', v: '╎', c: '┐┘└┌' }, { h: '─', v: '│', c: '┐┘└┌' }, { h: '━', v: '┃', c: '┓┛┗┏' }]
// the runs across first, then the turns down or up, which cross the runs they pass with a crossing mark, then the corners
const look = f => ({ g: G[f.n >= max * 0.4 ? 2 : f.n >= max * 0.1 ? 1 : 0], t: f.id === sel ? 'warn' : k.cat(f.gi), x: xm.get(f), down: f.yr > f.yl })
const drawn = [...flows.filter(f => f.id !== sel), ...flows.filter(f => f.id === sel)].map(f => ({ f, ...look(f) }))
const across = new Map()   // "x,y" -> the weight of the run across that cell
const run = (x, y, w, d) => { for (let i = 0; i < w; i++) across.set(`${x + i},${y}`, d.g) }
for (const d of drawn) {
  const { f, g, t, x } = d
  if (f.yl === f.yr) { c.hline(x0, f.yl, x1 - x0, g.h, t); run(x0, f.yl, x1 - x0, d); continue }
  c.hline(x0, f.yl, x - x0, g.h, t); run(x0, f.yl, x - x0, d)
  c.hline(x + 1, f.yr, x1 - x - 1, g.h, t); run(x + 1, f.yr, x1 - x - 1, d)
}
for (const { f, g, t, x } of drawn) {
  if (f.yl === f.yr) continue
  for (let y = Math.min(f.yl, f.yr) + 1; y < Math.max(f.yl, f.yr); y++) {
    const h = across.get(`${x},${y}`)
    c.put(x, y, !h ? g.v : h === G[2] && g === G[2] ? '╋' : '┼', t)
  }
}
for (const { f, g, t, x, down } of drawn) {
  if (f.yl === f.yr) continue
  c.put(x, f.yl, down ? g.c[0] : g.c[1], t)
  c.put(x, f.yr, down ? g.c[2] : g.c[3], t)
}
lefts.forEach((l, gi) => {
  const top = gi * (R + gap), mid = top + Math.floor((R - 1) / 2)
  c.text(0, mid, `**${l.v}**`, { max: LW - 7 })
  c.text(LW - 1, mid, k.fmt(l.n), { tone: 'dim', align: 'right' })
  c.vline(LW, top, R, '┃', k.cat(gi))
})
rights.forEach((r, ri) => {
  const top = ri * (L + gap), mid = top + Math.floor((L - 1) / 2)
  c.vline(x1, top, L, '┃', 'ink')
  c.text(x1 + 12, mid, `**${r.v}**`, { max: RW })
  c.text(x1 + 12, mid + 1, `${k.fmt(r.n)} reviews`, { tone: 'dim', max: RW })
})
for (const f of flows) {
  const share = Math.round(f.n / f.l.n * 100)
  c.text(x1 + 1, f.yr, `${k.fmt(f.n)} {dim:${share}%}`, { tone: f.id === sel ? 'warn' : k.cat(f.gi) })
  c.region(f.id, x1 + 1, f.yr, 10, 1, { label: `${f.l.v} → ${f.r.v}: ${k.fmt(f.n)} reviews, ${share}% of the group's`, refs: k.rows(f.rows), onPress: () => ({ sel: f.id }) })
}
// the takeaway: the right-hand node whose share differs most between the groups
const pct = p => Math.round(p * 100) + '%'
const spread = rights.map(r => {
  const sh = lefts.map(l => ({ l, p: flows.find(f => f.l === l && f.r === r).n / l.n })).sort((a, b) => b.p - a.p)
  return { r, hi: sh[0], lo: sh[sh.length - 1], d: sh[0].p - sh[sh.length - 1].p }
}).sort((a, b) => b.d - a.d)[0]
return k.stack(
  k.beside(k.text('{dim:reviews: the reviewer → whose claim the pull request was under}'), k.dial('group'), { gap: 3 }),
  c,
  k.text(picked
    ? `**${k.fmt(picked.n)}** reviews by ${picked.l.v} reviewers under ${picked.r.v}; ${k.fmt(picked.changes)} asked for changes · a asks about them`
    : `**${spread.r.v}**: ${pct(spread.hi.p)} of the reviews by ${spread.hi.l.v} reviewers, ${pct(spread.lo.p)} by ${spread.lo.l.v} reviewers`),
)
```

### A number with its denominator: how many runs did a thing

The count as the headline, and under it one sign per run, filled when the run counts, each group named in place; a knob sets how many commits count, a press picks a run to ask about, and the detail lists every run with its count to scale. `data.runs`: rows of a tally by run, `{run, n, commits}`; `data.commits`: rows of a tally of the commit commands by run, `{run, n}`.

```js
// A number with its denominator: how many runs did a thing, as one sign per run, the ones that count filled. A knob
// sets what counts; each group of signs, and each sign, opens the rows behind it.
const least = k.knob('least', { values: [1, 2, 5, 10], at: 1, label: 'counts from', fmt: v => `${v} commit${v === 1 ? '' : 's'}` })
const runs = [...data.runs].sort((a, b) => b.commits - a.commits || (a.run < b.run ? -1 : 1))
const yes = runs.filter(r => r.commits >= least), no = runs.filter(r => r.commits < least)
const commitsOf = r => data.commits.find(c => c.run === r.run)
const sel = k.state.sel || null, picked = sel && runs.find(r => r.run === sel)
k.on('a', () => { if (picked) k.ask({ label: `${picked.run}: its ${picked.commits} git commits`, rows: [commitsOf(picked) || picked] }) }, 'ask about the picked run')
const total = yes.reduce((s, r) => s + r.commits, 0)
const head = k.beside(k.text(`**${yes.length}** of ${runs.length} runs committed their work to git`), k.dial('least'), { gap: 4 })
const foot = k.text(picked
  ? `**${picked.run}**: ${picked.commits} commit commands in ${picked.n} shell commands · a asks about them`
  : yes.length ? `{dim:Those ${yes.length} ran ${total} commit commands, the most (${yes[0].commits}) in ${yes[0].run}}` : '{dim:no run reaches this many}')

if (k.mode === 'detail') {
  // the detail: one line per run, its commits drawn to scale, the runs that count first
  const max = Math.max(1, ...runs.map(r => r.commits))
  return k.stack(head, k.bars(runs.map(r => ({ ...r, id: 'run-' + r.run, label: `${r.commits >= least ? '●' : '○'} ${r.run}`, value: r.commits, tone: r.commits >= least ? 'accent' : 'dim', note: `of ${r.n} shell commands` })), { max, labelW: 46 }), foot)
}
// under a reply: one sign per run, filled when it counts, each group named under its signs
const c = k.canvas(runs.length * 2 + 2, 2)
runs.forEach((r, i) => {
  const x = i * 2 + (r.commits >= least ? 0 : 2)
  c.put(x, 0, r.commits >= least ? '●' : '○', r.run === sel ? 'warn' : r.commits >= least ? 'accent' : 'dim')
  c.region('run-' + r.run, x, 0, 1, 1, { label: `${r.run}: ${r.commits} commits`, row: commitsOf(r) || r, onPress: () => ({ sel: r.run }) })
})
const gap = yes.length * 2 + 2
c.region('counted', 0, 1, Math.max(1, gap - 2), 1, { label: `${yes.length} runs with ${least}+ commits`, refs: k.rows(yes.map(r => commitsOf(r) || r)) })
c.region('not-counted', gap, 1, Math.max(1, no.length * 2), 1, { label: `${no.length} runs with fewer`, refs: k.rows(no) })
if (yes.length) c.text(0, 1, 'committed', { tone: 'accent', max: Math.max(1, gap - 1) })
if (no.length) c.text(gap, 1, least === 1 ? 'never committed' : `fewer than ${least}`, { tone: 'dim', max: no.length * 2 })
return k.stack(head, c, foot)
```
