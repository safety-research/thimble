// The anatomy of one run: the whole run as one strip, one cell per stretch of steps, and numbered notes on the
// moments that explain it, each quoting the line of the transcript it opens.
const W = Math.max(40, Math.min(k.w, 110)), n = data.steps.length
const x = s => Math.min(W - 1, Math.floor(s / n * W))
const tone = Object.fromEntries(data.kinds.map(d => [d.key, d.tone]))
const c = k.canvas(W, 3)
// the run, one cell per stretch of steps: red where a test failed, else what it did most
for (let i = 0; i < W; i++) {
  const bin = data.steps.slice(Math.floor(i * n / W), Math.floor((i + 1) * n / W))
  const most = [...new Set(bin)].sort((a, b) => bin.split(b).length - bin.split(a).length)[0]
  c.put(i, 1, '▆', tone[bin.includes('f') ? 'f' : most])
}
// each note's number over the step it marks, or over the stretch it spans
data.notes.forEach((m, i) => {
  if (m.to) { c.hline(x(m.at), 0, x(m.to) - x(m.at), '─', 'dim'); c.put(x(m.to), 0, '┤', 'dim') }
  c.text(x(m.at), 0, `**${i + 1}**`, { tone: 'accent' })
})
c.text(0, 2, '{dim:step 0}'); c.text(W - 1, 2, `{dim:${n}}`, { align: 'right' })
const spans = data.notes.map(m => `${m.at}${m.to ? '–' + m.to : ''}`)
return k.stack(
  k.text(`Run ${data.run} took **${n}** steps, three times the median of ${data.median}; 410 of them went to one test`),
  k.stack(c, k.legend(data.kinds)),
  k.stack(...data.notes.map((m, i) => k.region(m.id, { label: `step ${spans[i]}: ${m.text}`, ref: m.ref },
    k.beside(k.text(`{accent:**${i + 1}**}`, { w: 2 }), k.text(`{dim:${spans[i]}}`, { w: Math.max(...spans.map(s => s.length)) }),
      k.text(k.escape(m.text) + (m.quote ? `  {dim:“${k.escape(m.quote)}”}` : ''), { wrap: true }), { gap: 1 })))),
  { gap: 1 })
