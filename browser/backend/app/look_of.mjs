// look_of.mjs: the terminal's look after an answer (plugin/observer), for the workbench's Heads up and Explainers on
// Claude's answers (look.py): its prompt from the terminal's own texts and code, and what its reply places on the
// answer's words, as the terminal places it (plugin/explain/place.mjs). Pure but for reading the texts.
//
//   stdin   {"prompt": {lenses, msgs, row, objects, coverage, state}}  the lenses ("explain", "heads") of the look, the
//           answers it reads (observer/messages.mjs), the values of the turn's template, the digests' state
//           ({glossed, headsGiven})
//   stdout  {"prompt": "<the frame with the lenses, then the turn>"}
//   stdin   {"place": {lenses, rows: [{row, text}], reply, state}}     the answers' texts, the fork's reply
//   stdout  {"items": [{row, kind, start, end, term, body, here, title, bullets}]}  each explainer and the heads-up, on
//           the words of its row where the terminal would draw it
import fs from 'node:fs'

import { mergeLook, placeGlosses } from '../../../plugin/explain/place.mjs'
import { composeSystem, composeTurn, skeletonOf } from '../../../plugin/observer/compose.mjs'
import { LENSES } from '../../../plugin/observer/lenses.mjs'
import { messagesText } from '../../../plugin/observer/messages.mjs'
import { parseAnswer } from '../../../plugin/observer/reply.mjs'

const text = name => fs.readFileSync(new URL(`../../../plugin/prompts/${name}.md`, import.meta.url), 'utf8')

function prompt({ lenses, msgs, row, objects, coverage, state }) {
  const parts = LENSES.filter(l => lenses.includes(l.name)).map(lens => ({ lens, text: text(lens.feature) }))
  const system = composeSystem(text('observer'), parts)
  const vals = { MESSAGES: messagesText(msgs), ROW: row, SHOWN: '', OBJECTS: objects, COVERAGE: coverage, SKELETON: skeletonOf(parts.map(p => p.lens)) }
  return `${system.text}\n\n${composeTurn(text('observer-turn'), vals, parts, state).text}`
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
process.stdin.on('end', () => {
  const req = JSON.parse(input || '{}')
  if (req.prompt) process.stdout.write(JSON.stringify({ prompt: prompt(req.prompt) }))
  else if (req.place) process.stdout.write(JSON.stringify({ items: place(req.place) }))
  else process.exit(2)
})
