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
