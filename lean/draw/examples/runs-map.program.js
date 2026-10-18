// A map of 40 runs of one task: which theory each run held, and how it ended. The toolkit has no helper for a map
// of lines, so this one draws on a raw canvas: one row per (theory, ending) pair, a bracket where rows join, the
// line's weight from its count. Each theory, ending and line is a region with its own id and cite.
const W = Math.min(k.w - 4, 92)
const T = data.theories, E = data.endings
// one row per flow, ordered by theory then ending, so both ends group into neighboring rows
const flows = data.flows.slice().sort((a, b) => T.findIndex(t => t.id === a.from) - T.findIndex(t => t.id === b.from) || E.findIndex(e => e.id === a.to) - E.findIndex(e => e.id === b.to))
const H = flows.length + 2
const c = k.canvas(W, H)
const TX = 12, TW = 19, LX = TX + TW + 2, EX = W - 16, LW = EX - 6 - LX
const weight = n => n >= 10 ? '━' : n >= 5 ? '─' : '╌'
const rowsOf = key => flows.map((f, i) => [f, i]).filter(([f]) => f.from === key || f.to === key).map(([, i]) => i)
const span = rows => [Math.min(...rows), Math.max(...rows)]

// the root and its trunk to each theory
const firstRows = T.map(t => rowsOf(t.id)[0])
const mid = Math.round((firstRows[0] + firstRows[firstRows.length - 1]) / 2)
c.text(0, mid, `● **${data.runs} runs**`)
c.region('all-runs', 0, mid, 9, 1, { label: `${data.runs} runs`, cite: k.cite('all-runs', { text: `${data.runs} runs of "${data.task}"`, source: data.source, query: 'select run, theory, ending', rows: data.sample, more: data.runs - data.sample.length }) })
c.hline(9, mid, 1, '─', 'dim')
for (let y = firstRows[0]; y <= firstRows[firstRows.length - 1]; y++) {
  const at = firstRows.indexOf(y)
  const ch = y === firstRows[0] ? '┌' : y === firstRows[firstRows.length - 1] ? '└' : at >= 0 ? '├' : '│'
  c.put(10, y, y === mid ? (at >= 0 ? '┼' : '┤') : ch, 'dim')
  if (at >= 0) c.put(11, y, '─', 'dim')
}

// theories: a label on the first of their rows, a bracket over all of them
T.forEach(t => {
  const rows = rowsOf(t.id), [a, b] = span(rows)
  c.text(TX, a, `${t.label} {dim:${t.runs}}`, { max: TW })
  const end = TX + Math.min(TW, k.len(`${t.label} ${t.runs}`)) + 1
  if (end < LX - 1) c.hline(end, a, LX - 1 - end, '─', 'dim')
  for (let y = a; y <= b; y++) c.put(LX - 1, y, a === b ? '─' : y === a ? '┬' : y === b ? '└' : '├', 'dim')
  c.region('theory-' + t.id, TX, a, LX - TX, b - a + 1, { label: `${t.label}: ${t.runs} runs`, cite: k.cite('theory-' + t.id, { text: `${t.runs} runs held the theory "${t.label}"`, source: data.source, query: `select run where theory = '${t.id}'`, rows: data.sample.filter(r => r.theory === t.id) }) })
})

// flows: one line each, its weight from its count, the count at its end
flows.forEach((f, y) => {
  const tone = E.find(e => e.id === f.to).tone
  c.hline(LX, y, LW, weight(f.runs), tone)
  c.text(EX - 4, y, String(f.runs), { tone: 'dim', align: 'right' })
  c.region(`flow-${f.from}-${f.to}`, LX, y, EX - 3 - LX, 1, { label: `${f.runs} runs: ${f.from} → ${f.to}`, cite: k.cite(`flow-${f.from}-${f.to}`, { text: `${f.runs} runs held "${T.find(t => t.id === f.from).label}" and ended "${E.find(e => e.id === f.to).label}"`, source: data.source, query: `select run where theory = '${f.from}' and ending = '${f.to}'`, rows: data.sample.filter(r => r.theory === f.from && r.ending === f.to) }) })
})

// endings: a bracket joining their rows, the label at the middle
E.forEach(e => {
  const rows = rowsOf(e.id), [a, b] = span(rows), m = Math.floor((a + b) / 2)
  for (let y = a; y <= b; y++) c.put(EX - 2, y, a === b ? '─' : y === a ? '┐' : y === b ? '┘' : y === m ? '┤' : '│', e.tone)
  if (a !== b) c.put(EX - 1, m, '─', e.tone)
  c.text(EX, m, `{${e.tone}:${e.label}} **${e.runs}**`, { max: W - EX })
  c.region('ending-' + e.id, EX - 2, a, W - EX + 2, b - a + 1, { label: `${e.label}: ${e.runs} runs`, cite: k.cite('ending-' + e.id, { text: `${e.runs} runs ended "${e.label}"`, source: data.source, query: `select run where ending = '${e.id}'`, rows: data.sample.filter(r => r.ending === e.id) }) })
})

// the key to line weights, on the last row
const ky = H - 1
c.text(0, ky, 'line weight = runs', { tone: 'dim' })
c.hline(20, ky, 2, '━', 'dim'); c.text(23, ky, '10+', { tone: 'dim' })
c.hline(28, ky, 2, '─', 'dim'); c.text(31, ky, '5–9', { tone: 'dim' })
c.hline(36, ky, 2, '╌', 'dim'); c.text(39, ky, '1–4', { tone: 'dim' })

return k.frame(c, { title: 'map', right: `${data.runs} runs of "${data.task}"`, grow: 0 })
