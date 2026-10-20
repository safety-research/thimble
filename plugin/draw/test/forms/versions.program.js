// the two versions side by side, a section on each row it kept; what moved is joined across the rows between
const tone = Object.fromEntries(data.kinds.map(d => [d.key, d.tone]))
const longest = Math.max(...data.rows.flatMap(r => [r.old, r.new]).filter(Boolean).map(s => k.len(s.title))) + 4
const tw = Math.max(16, Math.min(longest, Math.floor((k.w - 16) / 2))), gx = tw + 1, gw = 14, bx = gx + gw + 1
const c = k.canvas(bx + tw, data.rows.length + 1)
c.text(0, 0, `**${data.old}**`); c.text(bx, 0, `**${data.new}**`)
const section = (s, x, y, change, name) => {
  c.text(x, y, `{dim:${s.n}} ${k.escape(s.title)}`, { tone: change === 'removed' || change === 'added' ? tone[change] : 'ink', max: tw })
  c.region(`${name.toLowerCase()}-${s.n}`, x, y, tw, 1, { label: `${name} §${s.n} ${s.title} (${change})`, ref: s.ref })
}
data.rows.forEach((r, i) => {
  const y = i + 1
  if (r.old) section(r.old, 0, y, r.change, data.old)
  if (r.new) section(r.new, bx, y, r.change, data.new)
  if (r.old && r.new) c.hline(gx, y, gw, r.change === 'reworded' ? '╌' : '─', tone[r.change])
  if (r.change === 'removed') c.text(gx + 1, y, '✕ removed', { tone: 'bad' })
  if (r.change === 'added') c.text(gx + gw - 6, y, 'new +', { tone: 'good' })
})
data.moves.forEach(m => {
  const y0 = m.from + 1, y1 = m.to + 1, lx = gx + Math.floor(gw / 2), t = tone.moved
  for (let y = Math.min(y0, y1) + 1; y < Math.max(y0, y1); y++) c.put(lx, y, '┼', t)
  c.hline(gx, y0, lx - gx, '─', t); c.hline(lx + 1, y1, gx + gw - lx - 1, '─', t)
  c.put(lx, y0, y1 > y0 ? '╮' : '╯', t); c.put(lx, y1, y1 > y0 ? '╰' : '╭', t)
})
const same = data.rows.filter(r => r.change === 'same').length, total = data.rows.filter(r => r.old).length
return k.stack(
  k.text(`${data.new} drops the 30-day deletion rule, adds a section on training models, and moves consent to the front; ${same} of the ${total} ${data.old} sections are unchanged`, { wrap: true }),
  c, k.legend(data.kinds), { gap: 1 })
