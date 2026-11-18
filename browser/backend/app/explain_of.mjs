// explain_of.mjs: the terminal's explainer on demand (plugin/explain/expand.ts), for the workbench's e (explain.py):
// what its call reads, from the terminal's own text (the registry's `explain-expand`, as the workbench reads it,
// plugin/prompts/node.mjs textOf) and code (plugin/explain/ask.mjs), and the explainer its reply gives. Pure but for
// reading the text and the cited files, each only inside the folders it is given.
//
//   stdin   {"prompt": {term, question, answer, items, roots}}   the words, the analyst's question, the answer as the
//           terminal reads it (its files cited as Markdown links), the marks of its check (their evidence names the
//           cited places), and the folders a cited file may lie in (main's and the corpus's)
//   stdout  {"prompt": "<the text, then the words, the question, the answer and the cited files' lines>"}
//   stdin   {"reply": "<the fork's answer>"}
//   stdout  {"explainer": {"body", "here"} or null}
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { askText, citedFiles, evidencePlaces, explainerOf } from '../../../plugin/explain/ask.mjs'
import { filePlaces } from '../../../plugin/explain/place.mjs'
import { textOf } from '../../../plugin/prompts/node.mjs'

const MODE = 'browser' // whose words the texts' slots take (plugin/prompts/slots.json)
const FILE_MAX = 4 * 1024 * 1024 // bytes of a cited file it reads, as the terminal's one read of a file takes

/** A cited file's text: a relative path in each of `roots` in turn, an absolute one as it is, and only a file whose
 *  real path lies in one of them; null for any other. */
function reader(roots) {
  const real = roots.flatMap(r => { try { return [realpathSync(r)] } catch { return [] } })
  return async path => {
    for (const base of isAbsolute(path) ? [''] : real) {
      try {
        const file = realpathSync(base ? join(base, path) : path)
        if (!real.some(r => file === r || file.startsWith(r + sep)) || statSync(file).size > FILE_MAX) continue
        return readFileSync(file, 'utf8')
      } catch { /* the next folder */ }
    }
    return null
  }
}

async function prompt({ term, question, answer, items, roots }) {
  const places = [...evidencePlaces(items), ...filePlaces(answer)]
  const files = await citedFiles(places, reader(Array.isArray(roots) ? roots : []))
  return `${await textOf('explain-expand', MODE)}\n\n${askText({ term, question, answer, files })}`
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { input += d })
process.stdin.on('end', async () => {
  const req = JSON.parse(input || '{}')
  if (req.prompt) process.stdout.write(JSON.stringify({ prompt: await prompt(req.prompt) }))
  else if ('reply' in req) process.stdout.write(JSON.stringify({ explainer: explainerOf(req.reply) }))
  else process.exit(2)
})
