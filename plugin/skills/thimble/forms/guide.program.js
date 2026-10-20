// A guide in pages: one idea per page, each a picture whose parts open the lines behind them, and a few sentences that
// walk through it. The page knob holds the chapters; the dial and the bar turn them.
const n = data.chapters.length
const ch = k.knob('chapter', { values: data.chapters.map((_, i) => i + 1), label: 'chapter', fmt: v => `${v} of ${n}`, pages: true })
const c = data.chapters[ch - 1]
const w = Math.max(14, Math.min(24, Math.floor((k.w - 3 * (c.steps?.length || 1)) / (c.steps?.length || 1))))
const picture = c.sizes
  ? k.bars(c.sizes.map(s => ({ id: 'size-' + s.id, label: s.label, value: s.lines, meta: { label: s.label, ref: s.ref } })))
  : k.beside(...c.steps.map((s, i) => k.region('step-' + s.id, { label: s.label, ref: s.ref },
      k.frame(k.text(s.does, { wrap: true, w: w - 2 }), { title: `${i + 1} ${s.label}`, tone: s.tone }))), { gap: 1 })
return k.stack(k.text(`**${c.title}**`), picture, k.text(c.text, { wrap: true }), { gap: 1 })
