// A diagram of a code path: the steps a request passes through, the one that goes wrong in red, and the two lines
// of code that show why under it. Each box and each quoted line opens its lines of code.
const quote = q => k.region(q.id, { label: q.where, ref: q.ref }, k.frame(k.text(k.escape(q.code)), { title: q.where, tone: q.tone }))
return k.stack(
  k.text('Every request passes **is_expired()**, which reads the timeout as seconds; the config gives it in minutes'),
  k.graph(data),
  k.stack(...data.quotes.map(quote)),
  { gap: 1 })
