// sync.mjs: copy the modules the demo's hooks module imports into hooks/lib/, keeping their folders, so their own
// imports (../../draw/term.js) still resolve. A hooks module may import only files inside its own plugin folder.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LEAN = fileURLToPath(new URL('../../../', import.meta.url))
const LIB = fileURLToPath(new URL('./hooks/lib/', import.meta.url))
const FILES = ['draw/term.js', 'draw/handoff.js', 'draw/flex.js', 'draw/palette.js', 'verbs/explore/run.mjs', 'verbs/explore/view.mjs']
for (const f of FILES) { mkdirSync(dirname(LIB + f), { recursive: true }); copyFileSync(LEAN + f, LIB + f) }
console.log('copied ' + FILES.join(', '))
