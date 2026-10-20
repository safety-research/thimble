// A table kept small: six runs of a sweep in four columns, the best one marked. Each row is a part that opens its run.
const best = data.runs.reduce((a, b) => (b.acc > a.acc ? b : a))
return k.stack(
  k.text(`The best run, **${best.run}**, reached ${best.acc}% with Adam at learning rate ${best.lr}`),
  k.table(data.runs.map(r => ({ ...r, note: r === best ? 'best' : r.acc < 75 ? 'diverged' : '' })), {
    cols: [{ key: 'run' }, { key: 'lr', label: 'learning rate', fmt: v => String(v) }, { key: 'batch' },
      { key: 'acc', label: 'val acc %', fmt: v => v.toFixed(1) }, { key: 'note', label: '', tone: v => (v === 'best' ? 'good' : 'bad') }],
    id: r => 'run-' + r.run }),
)
