// Bars: one row per day, split by what the saves were for. Each day is a part: its ref opens its rows, and its
// examples are real saves, labelled with what they are examples of.
const P = [['ask', 'c1'], ['instruct', 'c3'], ['share', 'c2'], ['test', 'c5']]
const items = data.days.map(d => ({
  id: 'day-' + d.day, label: d.day.slice(5), parts: P.map(([p, tone]) => ({ value: d[p], tone, label: p })),
  meta: { ref: `q1#day=${d.day}@n`,
    examples: k.examples('ex-' + d.day, { label: `saves to other agents on ${d.day}`, records: d.examples, total: d.n, fmt: '“{text}”\n{user} · {purpose}' }) },
}))
return k.stack(
  k.text(`**${k.fmt(data.total)}** saves to other agents · ${P.map(([p, t]) => `{${t}:■} ${p}`).join('  ')}`),
  k.bars(items),
)
