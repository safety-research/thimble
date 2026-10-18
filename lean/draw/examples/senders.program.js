// Who sent the messages: the named accounts as a table, each row citing its own rows, and how many messages each
// account sent as a plot. A sentence on top links to the counts it states.
const n = k.fmt
const total = data.days.reduce((s, r) => s + r.messages, 0)
const named = data.named
const namedSent = named.reduce((s, r) => s + r.messages, 0)
const numbered = data.numbered.n_many + data.numbered.n_once
const bySender = name => data.samples.filter(s => s.user === name)

k.cite('named-total', {
  text: `${named.length} named accounts sent ${n(namedSent)} of the ${n(total)} messages`, source: 'wiki_names.csv',
  query: "select name, messages where name not like 'agent-%' order by messages desc", rows: named, more: 0,
})
k.cite('numbered', {
  text: `${n(numbered)} numbered accounts (agent-####) sent ${n(total - namedSent)} messages`, source: 'wiki_names.csv',
  query: "select count(*), sum(messages) where name like 'agent-%'",
  rows: [{ accounts: numbered, messages: total - namedSent }],
})

const table = k.table(named, {
  cols: [
    { key: 'name', label: 'account' },
    { key: 'messages', label: 'messages' },
    { key: 'share', label: 'share', fmt: (v, r) => (100 * r.messages / total).toFixed(1) + '%', align: 'right' },
    { key: 'sampled', label: 'in sample', fmt: (v, r) => String(bySender(r.name).length), align: 'right' },
  ],
  max: k.h >= 20 ? 12 : 6,
  id: r => 'sender-' + r.name,
  cite: r => k.cite('sender-' + r.name, {
    text: `${r.name} sent ${r.messages} messages to other agents`, source: 'wiki_names.csv',
    query: `select name, messages where name = '${r.name}'`, rows: [r],
  }),
  examples: r => bySender(r.name).length ? k.examples('by-' + r.name, {
    label: `saves by ${r.name} in the sample`, records: bySender(r.name), fmt: '“{text}”\n{page} · {day} · rev {rev}',
  }) : null,
})

const dist = k.region('distribution', {
  label: 'messages per account',
  cite: k.cite('distribution', {
    text: `how many accounts sent each number of messages, ${n(data.senders.reduce((s, r) => s + r.senders, 0))} accounts`,
    source: 'wiki_names.csv', query: 'select messages, count(*) as accounts group by messages order by messages',
    rows: data.senders.slice(0, 5), more: data.senders.length - 5,
  }),
}, k.plot([{ points: data.senders.map(s => [s.messages, s.senders]) }], {
  h: 11, x: { label: 'messages sent', log: true, ticks: [1, 2, 5, 10, 20, 32] }, y: { label: 'accounts', min: 0 }, dots: false,
}))

return k.frame(k.stack(
  k.text(`**${named.length} named accounts** sent [${n(namedSent)}](#named-total) of ${n(total)} messages; [${n(numbered)} numbered accounts](#numbered) sent the rest. Most accounts sent one or two.`),
  k.w >= 100 ? k.beside(table, dist, { gap: 4 }) : k.stack(table, dist, { gap: 1 }),
  { gap: 1 },
), { title: 'Who sent messages to other agents', right: 'wiki_names.csv', grow: 1 })
