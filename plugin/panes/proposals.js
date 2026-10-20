// proposals.js: the line v opens under a message (its proposed views), a program on the card runtime (draw/kit.js)
// over the message's record. The terminal draws it under the message. Picking an option asks the host to ask Claude
// for that view (k.do('pick')).
//
//   args: {row, verb}            the message and the verb whose line it is (v)
//   reads: record:<row>          its lit verbs: v's proposals, as the post-turn pass named them
//   keys: 1–9 pick · 0 close     presses: an option picks it
// With no proposal, v's one option is "another view of this answer": visualize then picks the form itself.

/** v's one option when the pass proposed none. */
export const ANOTHER_VIEW = 'another view of this answer'

/** The options a verb's line offers for a message. */
export function optionsOf(verb, rec) {
  const lit = (rec && rec.verbs && rec.verbs[verb]) || null
  if (verb === 'v') {
    const props = lit && lit.lit && Array.isArray(lit.proposals) && lit.proposals.length ? lit.proposals : [ANOTHER_VIEW]
    return props.map(p => String(p))
  }
  return [`run ${verb}`]
}

export default {
  name: 'proposals',
  title: 'Views',
  reads: args => [`record:${args.row}`],
  stateKey: args => `proposals-${String(args.row || '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64)}`,
  data(stores, args) {
    const rec = stores[`record:${args.row}`] || null
    return { row: args.row, verb: String(args.verb || 'v'), options: rec ? optionsOf(String(args.verb || 'v'), rec) : [] }
  },
  program,
}

export function program(k, data) {
  const opts = (data.options || []).slice(0, 9)
  if (!opts.length) return k.text('{dim:This message has no record here, so nothing can be drawn from it.}')
  const pick = i => () => {
    k.do('pick', { row: data.row, verb: data.verb, choice: opts[i], i })
    k.do('close')
    return null
  }
  opts.forEach((_, i) => k.on(String(i + 1), pick(i), 'pick'))
  k.on('0', () => { k.do('close') }, 'close')
  k.on('esc', () => { k.do('close') })
  k.on('press', e => {
    const m = /^opt-(\d+)$/.exec(String(e.region || ''))
    return m ? pick(Number(m[1]))() : null
  })
  // one row of options, wrapped to the width: the first picked by ↵ in words, each a press
  const items = opts.map((o, i) => k.region(`opt-${i}`, { label: o }, k.text(`${i ? '{dim:' : '{accent:'}▸ ${i + 1}} ${i ? k.escape(o) : `**${k.escape(o)}**`}`, { wrap: false })))
  if (k.len(opts.map((o, i) => `▸ ${i + 1} ${o}`).join('   ')) <= k.w) return k.beside(...items, { gap: 3 })
  return k.stack(items)
}
