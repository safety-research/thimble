// A timeline for a story: the events in order on one axis, each label on its own row under its tick, so the order and
// the gaps read at a glance. Each event is a part that opens the record behind it.
const W = Math.max(30, Math.min(k.w, 96)), n = data.events.length
const x = day => Math.round((day - data.from) / (data.to - data.from) * (W - 1))
const c = k.canvas(W, n + 2)
c.hline(0, 0, W, '─', 'dim')
c.text(0, n + 1, data.start, { tone: 'dim' })
c.text(W - 1, n + 1, data.end, { tone: 'dim', align: 'right' })
// the ticks and their stems first, then the labels over them, so no stem cuts a label
data.events.forEach((e, i) => { c.put(x(e.day), 0, '●', e.tone); if (i) c.vline(x(e.day), 1, i, '│', 'dim') })
data.events.forEach((e, i) => {
  const left = Math.max(0, Math.min(x(e.day), W - e.label.length))
  c.text(left, i + 1, e.label, { tone: e.tone === 'dim' ? 'ink' : e.tone })
  c.region('event-' + i, left, i + 1, e.label.length, 1, { label: e.label, ref: e.ref })
})
return c
