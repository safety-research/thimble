// Real records, quoted: the passage of each ticket that makes the point, with what the analyst needs to place it. Each
// ticket is a part that opens the record itself.
return k.stack(
  k.text(`**${k.fmt(data.n)}** of the ${k.fmt(data.total)} March refund tickets name the X200 charger. Three of them:`),
  ...data.tickets.map(t => k.region('ticket-' + t.id, { label: `ticket ${t.id}, ${t.date}`, ref: t.ref },
    k.beside(k.text('{c1:▎}', { w: 1 }), k.stack(k.text(`“${k.escape(t.quote)}”`, { wrap: true }), k.text(`{dim:${t.id} · ${t.date} · ${t.outcome}}`)), { gap: 1 }))),
  { gap: 1 })
