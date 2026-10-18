// sync.mjs: copy the files the demo's hooks module imports into hooks/lib/. A hooks module may import only files
// inside its own plugin folder, and the demo sits inside lean/verbs/squeeze/. A test checks the copies are current.
import { copyFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const VERB = fileURLToPath(new URL('..', import.meta.url))
const DRAW = fileURLToPath(new URL('../../../draw/', import.meta.url))
const LIB = VERB + 'demo/hooks/lib/'
export const COPIES = [
  ...['run.mjs', 'spans.mjs', 'program.mjs'].map(f => [VERB + f, f]),
  ...['term.js', 'paint.js', 'palette.js', 'flex.js', 'handoff.js'].map(f => [DRAW + f, f]),
]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [from, to] of COPIES) copyFileSync(from, LIB + to)
  writeFileSync(LIB + 'README', 'Copies written by ../../sync.mjs from lean/verbs/squeeze/ and lean/draw/. Edit the originals.\n')
  console.log('copied ' + COPIES.map(c => c[1]).join(', '))
}
