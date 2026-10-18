// sync.mjs: copy the renderer files the demo plugin imports into hooks/lib/. A hooks module may import only files
// inside its own plugin folder, and this demo plugin sits inside lean/draw/. The lean plugin itself (root lean/)
// imports ../draw/*.js directly and needs no copies. A test checks the copies are current.
import { copyFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DRAW = fileURLToPath(new URL('..', import.meta.url))
const LIB = DRAW + 'demo-plugin/hooks/lib/'
const FILES = ['term.js', 'paint.js', 'palette.js', 'flex.js', 'handoff.js']
for (const f of FILES) copyFileSync(DRAW + f, LIB + f)
writeFileSync(LIB + 'README', 'Copies of lean/draw/' + FILES.join(', lean/draw/') + ', written by ../../sync.mjs. Edit the originals.\n')
console.log('copied ' + FILES.join(', '))
