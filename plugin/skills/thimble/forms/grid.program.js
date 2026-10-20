// Small multiples: one run per cell of a grid of the two settings, each its own loss curve on one shared scale.
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
