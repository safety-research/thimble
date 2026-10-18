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
