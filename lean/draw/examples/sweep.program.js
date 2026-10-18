// The whole sweep on one grid: 4 configs × 7 learning rates. Each cell is one run: val_acc over its 10 epochs as a
// spark, then the final value. Below the grid, one line per finding; every line cites the rows behind it.
// Value helpers only: the spark keeps the 10 numbers, so the browser draws the curve, not the glyphs.
const runs = data.runs, LRS = [0.0001, 0.001, 0.01, 0.1, 1, 5.7, 10]
const CONF = [['SGD', 32], ['SGD', 256], ['Adam', 32], ['Adam', 256]]
const LW = 10, GAP = 1
const CW = Math.max(6, Math.floor((k.w - 4 - LW - GAP * LRS.length) / LRS.length))
const run = (o, b, lr) => runs.find(r => r.opt === o && r.batch === b && r.lr === lr)
const toneOf = r => r.nan_from ? 'bad' : r.final >= 95 ? 'good' : r.final < 50 ? 'warn' : 'accent'
const epochs = r => r.acc.map((a, i) => ({ run: r.run, epoch: i + 1, val_acc: a.toFixed(1), loss: r.loss[i] }))
const name = r => `${r.opt} b${r.batch} lr ${r.lr}`
const winner = runs.reduce((a, b) => b.final > a.final ? b : a)

k.cite('file', {
  text: `${data.meta.rows} rows: ${runs.length} runs (4 configs × 7 learning rates), 10 epochs each`, source: 'sweep.csv',
  query: 'select * from sweep.csv', rows: data.head, more: data.meta.rows - data.head.length,
})

const cell = r => {
  const t = toneOf(r)
  const rows = epochs(r), from = r.nan_from ? r.nan_from - 3 : 5
  const final = r.nan_from ? (CW >= 11 ? `✗ NaN ep${r.nan_from}` : '✗ NaN') : r.final.toFixed(1) + (r === winner ? ' ★' : '')
  return k.region(r.run, {
    label: name(r),
    cite: k.cite(r.run, {
      text: r.nan_from ? `${name(r)}: val_acc falls to 10.0; loss is NaN from epoch ${r.nan_from}` : `${name(r)}: val_acc ${r.acc[0]} at epoch 1, ${r.final} at epoch 10`,
      source: 'sweep.csv', query: `select epoch, val_acc, loss where run = '${r.run}'`, rows: rows.slice(from, from + 5), more: 5,
    }),
    examples: k.examples('epochs-' + r.run, { label: `${r.run}, epoch by epoch`, records: rows, fmt: 'epoch **{epoch}** · val_acc {val_acc} · loss {loss}' }),
  }, k.stack(
    k.spark(r.acc, { min: 0, max: 100, tone: t, w: Math.min(10, CW - 1) }),
    k.text(final, { tone: r.nan_from ? 'bad' : t === 'good' ? 'good' : 'ink', bold: r === winner || !!r.nan_from, wrap: false }),
    { w: CW },
  ))
}

const head = k.beside(k.text('lr', { tone: 'dim', w: LW }), LRS.map(lr => k.text(String(lr), { tone: 'dim', w: CW })), { gap: GAP })
const grid = CONF.map(([o, b]) => k.beside(
  k.text(`**${o}** {dim:b${b}}`, { w: LW }),
  LRS.map(lr => cell(run(o, b, lr))),
  { gap: GAP },
))

// ── the findings ────────────────────────────────────────
const worked = runs.filter(r => r.final >= 95).sort((a, b) => b.final - a.final)
const broke = runs.filter(r => r.nan_from)
const stalled = runs.filter(r => r.opt === 'Adam' && r.lr >= 0.1)
const best = b => runs.filter(r => r.opt === 'SGD' && r.batch === b).reduce((p, q) => q.final > p.final ? q : p)
const finals = rs => rs.map(r => epochs(r)[9])
const findings = [
  { key: 'Worked', tone: 'good', text: `${worked.length} runs reach 95%+; best is ${name(winner)} at ${winner.final}%`,
    cite: { rows: finals(worked), query: 'final epoch where val_acc >= 95' },
    ex: { label: `the ${worked.length} runs that reached 95%+, final epoch`, records: finals(worked) } },
  { key: 'Broke', tone: 'bad', text: `SGD b32 at lr 5.7 and 10: val_acc drops to 10.0, loss NaN from epoch ${broke.map(r => r.nan_from).join(' / ')}`,
    cite: { rows: broke.flatMap(r => epochs(r).slice(r.nan_from - 2, r.nan_from)), more: 16, query: "epochs where run in ('sgd-b32-lr5.7', 'sgd-b32-lr10')" },
    ex: { label: 'the 2 diverged runs, epoch by epoch', records: data.diverged_epochs } },
  { key: 'Why', tone: 'ink', text: `b32 makes 8× the updates of b256, so its best lr is ${best(256).lr / best(32).lr}× lower (${best(32).lr} vs ${best(256).lr})`,
    cite: { rows: [best(32), best(256)].map(r => epochs(r)[9]), query: 'best final val_acc per SGD batch size', note: data.meta.updates_note } },
  { key: 'Stalled', tone: 'warn', text: `Adam at lr ≥ 0.1 never diverges, but ends at ${Math.min(...stalled.map(r => r.final))}–${Math.max(...stalled.map(r => r.final))}%`,
    cite: { rows: finals(stalled), query: "final epoch where optimizer = 'Adam' and lr >= 0.1" },
    ex: { label: `the ${stalled.length} stalled Adam runs, final epoch`, records: finals(stalled) } },
]
const lines = findings.map(f => {
  const id = 'finding-' + f.key.toLowerCase()
  return k.region(id, {
    label: f.key,
    cite: k.cite(id, Object.assign({ text: f.text, source: 'sweep.csv' }, f.cite)),
    examples: f.ex && k.examples('ex-' + f.key.toLowerCase(), Object.assign({ fmt: '{run} · epoch {epoch} · val_acc {val_acc} · loss **{loss}**' }, f.ex)),
  }, k.beside(k.text(f.key, { tone: f.tone, bold: true, w: LW }), k.text(f.text), { gap: GAP }))
})

return k.frame(k.stack(
  k.text('each cell: val_acc by epoch, then the final %', { tone: 'dim' }),
  k.stack(head, grid, { gap: 1 }),
  k.stack(lines),
  { gap: 1 },
), { title: `Sweep: ${runs.length} runs × 10 epochs`, right: `[sweep.csv · ${data.meta.rows} rows](#file)`, grow: 1 })
