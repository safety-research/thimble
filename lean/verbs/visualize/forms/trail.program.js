// The trail of one run: its stations in order on one line, the long ones wide, and the run's steps as a strip under it.
const tone = { read: 'c4', search: 'c3', edit: 'c2', test: 'c1', revert: 'bad', rerun: 'c5' }
const map = k.map({
  title: `run ${data.run}`, unit: 'steps',
  threads: [{ id: data.run, stops: data.stations.map(s => ({ station: s.id, from: s.from, to: s.to })) }],
  stations: data.stations.map(s => ({ id: s.id, label: s.label, note: s.note || `${s.from}–${s.to}`, ref: `q3#station=${s.id}@n`,
    examples: data.examples[s.id] && k.examples('ex-' + s.id, { label: `${s.label.toLowerCase()}, steps ${s.from}–${s.to}`, records: data.examples[s.id], total: s.to - s.from + 1 }) })),
})
// the strip: one cell per bucket of steps, its color what the run was doing then
const W = Math.min(k.w - 2, 100), per = data.steps / W
const c = k.canvas(W, 2)
for (let x = 0; x < W; x++) {
  const step = Math.floor(x * per) + 1
  const s = data.stations.find(t => step >= t.from && step <= t.to)
  c.put(x, 0, '▆', tone[s.activity])
}
c.text(0, 1, '1', { tone: 'dim' })
c.text(W - 1, 1, k.fmt(data.steps), { tone: 'dim', align: 'right' })
return k.stack(map, c, k.legend(Object.entries(tone).map(([a, t]) => [a, t])), { gap: 1 })
