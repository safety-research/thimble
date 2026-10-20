// Unfold a number: one total, taken apart one way at a time. The way is a knob inside the card; each piece is a part
// whose ref opens its rows, and the pieces add up to the total, which the card says.
const by = k.knob('by', { values: Object.keys(data.splits), at: 'purpose', label: 'unfold by' })
const parts = data.splits[by]
const sum = parts.reduce((s, p) => s + p.n, 0)
return k.stack(
  k.beside(k.text(`**${k.fmt(data.total)}** ${data.what}`), k.dial('by'), { gap: 3 }),
  k.bars(parts.map(p => ({ id: `${by}-${p.key}`.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').slice(0, 60), label: p.key, value: p.n,
    note: `${Math.round(p.n / data.total * 100)}%`,
    meta: { ref: p.ref, examples: data.examples[p.key] && k.examples('ex-' + p.key, { label: `saves that ${p.key}`, records: data.examples[p.key], fmt: '“{text}”\n{user}' }) } }))),
  k.text(sum === data.total ? `{dim:${parts.map(p => k.fmt(p.n)).join(' + ')} = ${k.fmt(sum)}}` : `{warn:the pieces add to ${k.fmt(sum)}, not ${k.fmt(data.total)}}`),
)
