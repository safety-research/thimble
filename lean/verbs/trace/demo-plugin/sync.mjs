// sync.mjs: copy what the demo plugin imports into hooks/lib/, and the verb's skill into skills/trace/. A hooks module
// may import only files inside its own plugin folder, and this demo plugin sits inside lean/verbs/trace/. The verb's
// modules are copied as .js with their imports renamed to match. A test checks the copies are current. Edit the
// originals.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TRACE = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN = TRACE + 'demo-plugin/'
export const COPIES = [
  ['run.mjs', 'hooks/lib/run.js'], ['programs.mjs', 'hooks/lib/programs.js'], ['prompt.mjs', 'hooks/lib/prompt.js'],
  ['../../draw/term.js', 'hooks/lib/term.js'], ['../../draw/paint.js', 'hooks/lib/paint.js'],
  ['../../draw/palette.js', 'hooks/lib/palette.js'], ['../../draw/flex.js', 'hooks/lib/flex.js'], ['SKILL.md', 'skills/trace/SKILL.md'],
]
export const copyOf = src => readFileSync(TRACE + src, 'utf8').replace(/from '\.\/([a-z]+)\.mjs'/g, "from './$1.js'")
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [src, dst] of COPIES) {
    mkdirSync(dirname(PLUGIN + dst), { recursive: true })
    writeFileSync(PLUGIN + dst, copyOf(src))
  }
  writeFileSync(PLUGIN + 'hooks/lib/README', 'Copies written by ../../sync.mjs from lean/verbs/trace and lean/draw. Edit the originals.\n')
  console.log('copied ' + COPIES.map(c => c[1]).join(', '))
}
