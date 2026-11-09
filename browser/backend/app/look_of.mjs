// look_of.mjs: the terminal's look after an answer (plugin/observer), for the workbench's Heads up and Explainers on
// Claude's answers (look.py): its prompt from the terminal's own texts (as the workbench reads them, plugin/prompts/
// node.mjs textOf) and code, and what its reply places on the answer's words, as the terminal places it
// (plugin/explain/place.mjs). Pure but for reading the texts.
//
//   stdin   {"prompt": {lenses, msgs, state}}                          the lenses ("explain", "heads") of the look, the
//           answers it reads (observer/messages.mjs), the digests' state ({glossed, headsGiven}). The workbench has no
//           coverage, so the turn leaves that section out
//   stdout  {"prompt": "<the frame with the lenses, then the turn>"}
//   stdin   {"place": {lenses, rows: [{row, text}], reply, state}}     the answers' texts, the fork's reply
//   stdout  {"items": [{row, kind, start, end, term, body, here, title, bullets}]}  each explainer and the heads-up, on
//           the words of its row where the terminal would draw it
import { mergeLook, placeGlosses } from '../../../plugin/explain/place.mjs'
import { composeSystem, composeTurn, skeletonOf } from '../../../plugin/observer/compose.mjs'
import { LENSES } from '../../../plugin/observer/lenses.mjs'
import { messagesText } from '../../../plugin/observer/messages.mjs'
import { parseAnswer } from '../../../plugin/observer/reply.mjs'
import { textOf } from '../../../plugin/prompts/node.mjs'

const MODE = 'browser'  // whose words the texts' slots take (plugin/prompts/slots.json)

async function prompt({ lenses, msgs, state }) {
  const parts = await Promise.all(LENSES.filter(l => lenses.includes(l.name)).map(async lens => ({ lens, text: await textOf(lens.feature, MODE) })))
  const system = composeSystem(await textOf('observer', MODE), parts)
  const vals = { MESSAGES: messagesText(msgs), SHOWN: '', COVERAGE: '', SKELETON: skeletonOf(parts.map(p => p.lens)) }
  return `${system.text}\n\n${composeTurn(await textOf('observer-turn', MODE), vals, parts, state).text}`
}

function place({ lenses, rows, reply, state }) {
  const got = parseAnswer(reply)
  if (!got) return null
  // a lens that is not in the look gives nothing to place
  const out = { ...got, glosses: lenses.includes('explain') ? got.glosses : [], heads: lenses.includes('heads') ? got.heads : null }
  const { parts } = mergeLook(rows.map(r => ({ row: r.row, text: r.text, part: null })), out, { glossed: state?.glossed ?? [] })
  const items = []
  for (const r of rows) {
    const part = parts[r.row]
    if (!part) continue
    for (const p of placeGlosses(r.text, part)) {
      const g = part.items[p.id]
      items.push({ row: r.row, kind: g.kind === 'heads' ? 'heads' : 'explain', start: p.start, end: p.end, term: g.term, body: g.body ?? '', here: g.here ?? '', title: g.title ?? '', bullets: g.bullets ?? [] })
    }
  }
  return items
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { input += d })
process.stdin.on('end', async () => {
  const req = JSON.parse(input || '{}')
  if (req.prompt) process.stdout.write(JSON.stringify({ prompt: await prompt(req.prompt) }))
  else if (req.place) process.stdout.write(JSON.stringify({ items: place(req.place) }))
  else process.exit(2)
})
