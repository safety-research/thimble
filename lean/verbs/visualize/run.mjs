// Visualize (v): make a card of one of Claude's messages. This module writes no program and calls no model: it asks
// Claude, in the main conversation, to make the card, the way explore asks for a view. The card's forms are Claude's
// to choose (a later card-forms skill teaches them); the observer's proposals for this message ride along.
//
//   ctx.message   the message's record (shell/message.js): its text, marks and the verbs the observer lit
//   ctx.object    the message as an object ({id, text, row}), or an object when v is pressed on one
//   ctx.args      the proposal the person picked, in words ('' for none)
//   ctx.verb.dir  this folder, which names the drawing toolkit beside it
//   run(ctx) -> {text, ask}

const firstWords = s => {
  const t = String(s || '').replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  return t.length > 80 ? t.slice(0, 79) + '…' : t
}

/** The request that asks Claude for the card. */
export function request(ctx) {
  const msg = ctx.message || null
  const obj = ctx.object || null
  const choice = String(ctx.args || '').trim()
  const proposals = (msg?.verbs?.v?.proposals || []).filter(p => typeof p === 'string' && p.trim())
  const toolkit = ctx.verb && ctx.verb.dir ? `${String(ctx.verb.dir).replace(/\/+$/, '')}/../../draw/TOOLKIT.md` : 'the drawing toolkit (draw/TOOLKIT.md)'
  const what = msg
    ? `your reply that begins "${firstWords(msg.shown ?? msg.text)}"`
    : obj ? `the object ${obj.id}${obj.title ? ` ("${obj.title}")` : ''}` : 'your last reply'
  const lines = [`The person pressed v (visualize) on ${what}. Make a card of it${choice && choice !== 'a card of this message' ? `: ${choice}` : ''}.`]
  const others = proposals.filter(p => p !== choice)
  if (others.length) lines.push(`Another card proposed for it: ${others.join('; ')}.`)
  lines.push(`A card is an object: read ${toolkit} first if you have not. Reuse the queries you already ran, and run a new \`lean q\` only for values you have not kept, so each part keeps its ref.`)
  lines.push('Save it with `lean save <name> --from FILE`. Then say in one line what the card shows. Do not repeat the answer.')
  return lines.join(' ')
}

export async function run(ctx) {
  return { text: 'Claude is making a card of this message.', ask: request(ctx) }
}
