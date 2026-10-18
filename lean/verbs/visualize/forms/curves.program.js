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
