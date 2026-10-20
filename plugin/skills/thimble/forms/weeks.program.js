// Refunds per week, split by product: each week a part that opens its refunds, each piece named where it stands.
const P = data.products
return k.stack(
  k.text(`The jump is all **X200**: from about ${data.before} a week to ${data.after} after Mar 3`),
  k.bars(data.weeks.map(w => ({ id: 'week-' + w.week.toLowerCase().replace(' ', '-'), label: w.week, parts: P.map(([p, tone]) => ({ value: w[p], tone, label: p })), meta: { label: `refunds in the week of ${w.week}`, ref: `r4#week=${w.week}@n` } }))),
)
