// Visualize (v): another view of one of Claude's answers, as a card. Claude adds a card to an answer whenever the answer
// is best seen, without being asked; v asks for an additional view of it. This module writes no program and calls no
// model: it asks Claude, in the main conversation, to make the card, with the card guidance (`lean guide cards`: the
// registry's active version of `forms`), which Claude reads only when it draws a card, so it is never in its context at
// rest. The observer's proposals for the message ride along, and the one the person picked leads.
//
//   ctx.message   the message's record (CONTRACT 1): its text, the cards it carries (objects) and the verbs the observer
//                 lit, with v's proposals in verbs.v.proposals
//   ctx.object    the card v was pressed on, when it was pressed on one (or the message as an object, {id, text, row})
//   ctx.args      the proposal the person picked, in words ('' for none)
//   ctx.verb.dir  this folder
//   run(ctx) -> {text, ask}

const firstWords = s => {
  const t = String(s || '').replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  return t.length > 80 ? t.slice(0, 79) + '…' : t
}

/** The request that asks Claude for the card. */
export function request(ctx) {
  const msg = ctx.message || null
  const obj = ctx.object && ctx.object.program ? ctx.object : null
  const choice = String(ctx.args || '').trim()
  const proposals = (msg?.verbs?.v?.proposals || []).filter(p => typeof p === 'string' && p.trim())
  const what = msg
    ? `your answer that begins "${firstWords(msg.shown ?? msg.text)}"`
    : obj ? `the card ${obj.id}${obj.title ? ` ("${obj.title}")` : ''}` : 'your last answer'
  const has = [...new Set([...(msg?.objects || []).map(x => String(x).split('@')[0]), ...(obj ? [obj.id] : [])])].filter(Boolean)
  const lines = [`The person pressed v (visualize) on ${what}. They want another view of it: a card in the form that shows what it says${choice ? `, as "${choice}"` : ''}.`]
  if (has.length) lines.push(`It has the card${has.length > 1 ? 's' : ''} ${has.join(', ')} already: make a different view, not a copy.`)
  const others = proposals.filter(p => p !== choice)
  if (others.length) lines.push(`${choice ? 'Also proposed' : 'Proposed'} for it: ${others.join('; ')}.`)
  lines.push('Run `lean guide cards` first, unless you read it earlier in this session: the card guidance. Reuse the queries you ran, and run a new `lean q` only for values you have not kept, so each part keeps its ref.')
  lines.push('Save it with `lean save <name> --from FILE`. Then say in one line what it shows. Do not repeat the answer.')
  return lines.join(' ')
}

export async function run(ctx) {
  return { text: 'Claude is making another view of this answer.', ask: request(ctx) }
}
