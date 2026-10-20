// visualize.js: what v asks Claude for, another view of one of its answers as a card. Claude adds a card to an answer
// whenever the answer is best seen, without being asked; v asks for an additional view of it. This module writes no
// program and calls no model: the shell sends the request as a turn of the main conversation, with the card guide
// (skills/thimble/cards.md), which Claude reads only when it draws a card, so it is never in its context at rest. The
// observer's proposals for the message ride along, and the one the person picked leads. Pure: the shell and the tests
// import it.
//
//   viewRequest({message, choice, guide}) -> the request
//     message   the message's record (CONTRACT 1): its text, the cards it carries (objects) and what the observer lit,
//               with v's proposals in verbs.v.proposals
//     choice    the proposal the person picked, in words ('' for none)
//     guide     the card guide's file

const firstWords = s => {
  const t = String(s || '').replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  return t.length > 80 ? t.slice(0, 79) + '…' : t
}

/** The request that asks Claude for the card. */
export function viewRequest({ message, choice = '', guide, aside = false }) {
  const msg = message || null
  const picked = String(choice || '').trim()
  const proposals = (msg?.verbs?.v?.proposals || []).filter(p => typeof p === 'string' && p.trim())
  // a catch-up is no answer of Claude's: the squeeze chips wrote it of its replies since the person's last prompt
  const n = Number(msg?.catchup?.replies) || 0
  const what = msg?.catchup
    ? `the catch-up of your ${n} replies since their last prompt that the squeeze chips wrote, which begins "${firstWords(msg.shown ?? msg.text)}"`
    : msg ? `your answer that begins "${firstWords(msg.shown ?? msg.text)}"` : 'your last answer'
  const has = [...new Set((msg?.objects || []).map(x => String(x).split('@')[0]))].filter(Boolean)
  const lines = [`The analyst pressed v (visualize) on ${what}. They want another view of it: a card in the form that shows what it says${picked ? `, as "${picked}"` : ''}.`]
  if (has.length) lines.push(`It has the card${has.length > 1 ? 's' : ''} ${has.join(', ')} already: make a different view, not a copy.`)
  const others = proposals.filter(p => p !== picked)
  if (others.length) lines.push(`${picked ? 'Also proposed' : 'Proposed'} for it: ${others.join('; ')}.`)
  lines.push(`Read the card guide first, unless you have it from earlier in this session: ${guide}. Reuse the queries you ran, and use \`thimble run\` again only for values you have not kept, so each part keeps its ref.`)
  if (aside) lines.push('You work in the background, beside the conversation: the analyst sees none of your messages, only the card, drawn under that answer, so ask them nothing. Save it with `thimble save <name> --from FILE`. End with one line that names the card.')
  else lines.push('Save it with `thimble save <name> --from FILE`. Then say in one line what it shows; the analyst has read the answer, so do not repeat it.')
  return lines.join(' ')
}

/** What main reads once the fork in the background saved the card for v: the answer it is for, and each card, with its
 *  file, so a later turn knows the card exists and where the analyst sees it. */
export function viewMade({ about = '', cards = [] }) {
  const named = cards.map(c => `${c.id}${c.v != null ? `@${c.v}` : ''} (${String(c.root || '').replace(/\/+$/, '')}/thimble/objects/${c.id}.json)`)
  if (!named.length) return ''
  const what = about ? `your answer that begins "${firstWords(about)}"` : 'your last answer'
  return `The analyst pressed v (visualize) on ${what}. A copy of you that worked in the background made the card${named.length > 1 ? 's' : ''} ${named.join(', ')} for it, drawn under that answer. The analyst may ask about ${named.length > 1 ? 'them' : 'it'}.`
}
