// A region map of a diff: one strip per file, as long as the file; each hunk sits where it is, colored by what it did.
// A hunk is a part: its ref opens its lines in the diff. Files with no change stay, dim, so the map shows what was not touched.
const W = Math.max(20, Math.min(k.w - 40, 70))
const tone = h => (h.added && h.removed ? 'warn' : h.added ? 'good' : 'bad')
const rows = data.files.map(f => {
  const c = k.canvas(W, 1)
  c.fill(0, 0, W, 1, '─', 'unseen')
  f.hunks.forEach((h, i) => {
    const x = Math.min(W - 1, Math.floor(h.at / f.lines * W)), w = Math.max(1, Math.round(h.len / f.lines * W))
    c.fill(x, 0, Math.min(w, W - x), 1, '█', tone(h))
    c.region(`${f.path}:${h.at}`.replace(/[^A-Za-z0-9_.:-]/g, '-'), x, 0, Math.min(w, W - x), 1,
      { label: `${f.path} line ${h.at}: ${h.why}`, ref: `${data.diff}#L${h.line}`, note: `+${h.added} −${h.removed}` })
  })
  const n = f.hunks.reduce((s, h) => s + h.added + h.removed, 0)
  return k.beside(k.text(f.path, { w: 24, tone: f.hunks.length ? 'ink' : 'dim', wrap: false }), c, k.text(n ? `${n} lines` : '{dim:untouched}', { w: 10 }), { gap: 1 })
})
return k.stack(
  k.text(`${data.files.filter(f => f.hunks.length).length} of ${data.files.length} files changed · {good:█} added {bad:█} removed {warn:█} both`),
  ...rows,
)
