// Messages to other agents: per day, who sent them, and what is not in hand.
// Value helpers only (bars, dots, unseen), so the browser draws every bar from its number.
// From 98 columns it adds a column of the saves in the sample; below 17 rows it leaves out "who sent them".
const n = k.fmt
const wide = k.w >= 98, who = k.h >= 17
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const dayName = d => d.includes('–') ? d : `${DOW[new Date(d + 'T12:00Z').getUTCDay()]} Jun ${+d.slice(8)}`
const total = data.days.reduce((s, r) => s + r.messages, 0)
const isMsg = s => s.label === 'message to agents'
const sampled = day => {
  const all = data.samples.filter(s => s.day === day)
  return all.filter(isMsg).concat(all.filter(s => !isMsg(s)))   // messages first
}
const LW = 18   // one label column for both sets of bars, so their bars line up

const msgRows = data.bylabel.filter(b => isMsg(b) && b.day.startsWith('2026') && b.saves).sort((a, b) => b.saves - a.saves)
k.cite('total', {
  text: `${n(total)} saves labelled 'message to agents', May 24 – Jun 22`, source: 'wiki_daily.csv',
  query: "select day, label, saves where label = 'message to agents' order by saves desc",
  rows: msgRows, more: 1,
})
k.cite('links-peak', {
  text: `links peaked at ${n(data.days[3].links)} saves on Thu Jun 18, the most of any day`, source: 'wiki_daily.csv',
  query: "select day, label, saves where label = 'links' order by saves desc limit 3",
  rows: data.bylabel.filter(b => b.label === 'links' && b.day.startsWith('2026')).sort((a, b) => b.saves - a.saves).slice(0, 3),
})

// ── per day ──────────────────────────────────────────────
const notes = {
  'May 24–Jun 15': '23 days, 1 save (Jun 14)',
  '2026-06-18': `[links peak at ${n(data.days[3].links)}](#links-peak)`,
  '2026-06-22': `all saves fall to ${n(data.days[7].saves)}`,
}
const days = data.days.map(r => {
  const before = r.day.includes('–'), name = dayName(r.day)
  const id = before ? 'before-jun-16' : 'day-' + r.day.slice(5)
  const msgs = sampled(r.day).filter(isMsg)
  k.cite(id, before ? {
    text: `1 save labelled 'message to agents' in the ${r.ndays} days before Jun 16`, source: 'wiki_daily.csv',
    query: "sum(saves) where label = 'message to agents' and day < '2026-06-16'",
    rows: [{ day: '2026-06-14', label: 'message to agents', saves: 1 }],
  } : {
    text: `${n(r.messages)} saves labelled 'message to agents' on ${name}`, source: 'wiki_daily.csv · wiki_samples.jsonl',
    query: `sum(saves) where day = '${r.day}' and label = 'message to agents'`,
    rows: msgs.slice(0, 5).map(s => ({ rev: s.rev, user: s.user, page: s.page, text: s.text })),
    more: r.messages - Math.min(5, msgs.length),
    note: `the sample holds ${msgs.length} of these ${n(r.messages)}`,
  })
  const ex = sampled(r.day).length ? k.examples('saves-' + r.day.slice(5), {
    label: `saves sampled on ${name}`, records: sampled(r.day), total: r.saves,
    fmt: '“{text}”\n{user} on {page} · rev {rev} · labelled **{label}**',
  }) : undefined
  return { id, label: name, value: r.messages, bold: true, note: notes[r.day], cite: id, examples: ex,
    labelTone: r.day === '2026-06-18' ? 'ink' : 'dim' }
})
const perDay = k.bars(days, { labelW: LW })
const sample = k.stack(
  k.text('sampled', { tone: 'dim' }),
  data.days.map(r => k.dots(sampled(r.day).map(s => isMsg(s) ? 'accent' : { tone: 'dim', on: false }))),
)
const top = wide ? k.beside(k.stack(k.space(1, 1), perDay), sample, { gap: 2 }) : perDay

// ── who sent them ────────────────────────────────────────
const named = data.named, nb = data.numbered
const groups = [
  { id: 'agents-many', label: 'agent-#### ×2–15', who: nb.n_many, sent: nb.sum_many, tone: 'c1', recs: nb.many, q: "messages > 1 and name like 'agent-%'" },
  { id: 'agents-once', label: 'agent-#### ×1', who: nb.n_once, sent: nb.n_once, tone: 'c1', recs: nb.once, q: "messages = 1 and name like 'agent-%'" },
  { id: 'named', label: 'named ×16–32', who: named.length, sent: named.reduce((s, r) => s + r.messages, 0), tone: 'c2', recs: named, q: "name not like 'agent-%'" },
]
const senders = k.bars(groups.map(g => {
  const pct = Math.round(100 * g.sent / total)
  return {
    id: g.id, label: g.label, value: g.sent, tone: g.tone, labelTone: 'dim',
    note: `${n(g.who).padStart(3)} accounts · ${String(pct).padStart(2)}%`,
    cite: k.cite(g.id, { text: `${n(g.who)} accounts (${g.label}) sent ${n(g.sent)} of the ${n(total)} messages, ${pct}%`,
      source: 'wiki_names.csv', query: `select name, messages where ${g.q}`, rows: g.recs.slice(0, 5), more: g.who - 5 }),
    examples: k.examples('who-' + g.id, { label: g.label, records: g.recs, total: g.who, fmt: '**{name}** sent {messages} message(s) to other agents' }),
  }
}), { max: total, labelW: LW })

// ── not in hand: drawn, not footnoted ────────────────────
const gaps = k.stack(
  k.region('unread-files', { label: '3 unread dump files', cite: k.cite('unread-files', {
    text: 'revisions.jsonl is 1 of 4 files in the dump', source: 'dump manifest',
    note: 'the other 3 files were never read, so none of their saves are in any count here' }) },
  k.beside(k.text('dump files', { tone: 'dim', w: LW }), k.size(k.bar(1, { max: 1, tone: 'dim' }), { w: 6 }), k.unseen({ label: '3 not read', w: 20 }), k.text('1 of 4 files read', { tone: 'dim' }), { gap: 1 })),
  k.region('deleted-pages', { label: 'deleted pages', cite: k.cite('deleted-pages', {
    text: `${n(data.missing[1].count)} deleted pages are listed in the manifest but missing from revisions.jsonl`, source: 'dump manifest',
    note: 'their saves are not counted and cannot be sampled' }) },
  k.beside(k.text('deleted pages', { tone: 'dim', w: LW }), k.unseen({ w: 27 }), k.text(`${n(data.missing[1].count)} pages`, { tone: 'dim' }), { gap: 1 })),
)

return k.frame(k.stack(
  top,
  who && k.stack(
    k.beside(k.text('**Who sent them**', { w: LW }), k.text(`share of all ${n(total)} messages`, { tone: 'dim' }), { gap: 1 }),
    senders,
  ),
  who && k.stack(k.text('**Not in hand**'), gaps),
  { gap: 1 },
), { title: 'Messages to other agents, per day', right: `[${n(total)}](#total) saves · wiki_daily.csv`, grow: 1 })
