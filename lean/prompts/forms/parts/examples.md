## Worked examples

Each example below is a card made on real data with this runtime: what it draws, the rows its data holds, and its program. Together they show what a program can do: layouts, marks, knobs, keys, presses, a brush, and asking about a selection. They are not templates. Choose the form from this claim and this data.

### Heat strips: when in the day the saves land

One strip per wiki and one cell per hour of the day, each cell as tall as its count; the knob sets what a height is relative to, and a press picks an hour to ask about. `data.hours`: rows of a tally by wiki and hour, `{wiki, hour, n}`.

```js
// Heat strips: one strip per group, one cell per hour of the day, each cell as tall as its count. A knob sets what a
// height is relative to; a press picks an hour, and a key asks about the rows behind it.
const scale = k.knob('scale', { values: ['each wiki', 'all wikis'], at: 'each wiki', label: 'height against' })
const groups = [...new Set(data.hours.map(d => d.wiki))]
  .map(w => ({ wiki: w, rows: data.hours.filter(d => d.wiki === w) }))
  .map(g => ({ ...g, total: g.rows.reduce((s, d) => s + d.n, 0), max: Math.max(...g.rows.map(d => d.n)) }))
  .sort((a, b) => b.total - a.total)
const top = Math.max(...groups.map(g => g.max))
const cw = k.w >= 96 ? 3 : 2, lw = 10, rh = k.mode === 'detail' ? 3 : 1
const LEVEL = '▁▂▃▄▅▆▇█', gap = rh > 1 ? 1 : 0
const c = k.canvas(lw + 24 * cw + 9, groups.length * (rh + gap) + 1)
const sel = k.state.sel || null
groups.forEach((g, i) => {
  const y = i * (rh + gap)
  c.text(0, y + rh - 1, g.wiki, { max: lw - 1 })
  for (let h = 0; h < 24; h++) if (!g.rows.some(d => d.hour === h)) c.put(lw + h * cw, y + rh - 1, '·', 'unseen')
  for (const d of g.rows) {
    const id = `${g.wiki}-h${d.hour}`, x = lw + d.hour * cw, tone = id === sel ? 'warn' : 'accent'
    // the height in eighths of a cell: full cells from the bottom up, then the part that is left
    let e = Math.max(1, Math.round(d.n / (scale === 'each wiki' ? g.max : top) * 8 * rh))
    for (let r = rh - 1; r >= 0 && e > 0; r--, e -= 8) c.fill(x, y + r, cw - 1, 1, LEVEL[Math.min(8, e) - 1], tone)
    c.region(id, x, y, cw, rh, { label: `${g.wiki}, ${String(d.hour).padStart(2, '0')}:00–:59 UTC: ${k.fmt(d.n)} saves`, row: d, onPress: () => ({ sel: id }) })
  }
  c.text(lw + 24 * cw + 1, y + rh - 1, k.fmt(g.total), { tone: 'dim' })
})
for (const h of [0, 6, 12, 18, 23]) c.text(lw + h * cw, groups.length * (rh + gap) - gap, String(h).padStart(2, '0'), { tone: 'dim' })
// the takeaway: the busiest four hours of the busiest group, found in the data; or the hour the person picked
const big = groups[0]
const win = Array.from({ length: 21 }, (_, h0) => ({ h0, n: big.rows.filter(d => d.hour >= h0 && d.hour < h0 + 4).reduce((s, d) => s + d.n, 0) }))
  .sort((a, b) => b.n - a.n)[0]
const picked = sel && data.hours.find(d => `${d.wiki}-h${d.hour}` === sel)
k.on('a', () => { if (picked) k.ask({ label: `${picked.wiki} saves at ${picked.hour}:00 UTC`, rows: [picked] }) }, 'ask about the picked hour')
return k.stack(
  k.beside(k.text('{dim:hour of day, UTC}'), k.dial('scale'), { gap: 4 }),
  c,
  k.text(picked
    ? `**${k.fmt(picked.n)}** ${picked.wiki} saves at ${picked.hour}:00 · a asks about them`
    : `${big.wiki}: **${k.fmt(win.n)}** of ${k.fmt(big.total)} saves (${Math.round(win.n / big.total * 100)}%) land in four hours, ${win.h0}:00–${win.h0 + 4}:00 UTC`),
)
```
