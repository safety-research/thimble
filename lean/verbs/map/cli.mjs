// cli.mjs: draw a map in a plain terminal, as the shell would under a reply (mini) and in the detail view (full).
//
//   node cli.mjs SPEC.json [--w 100] [--full] [--both] [--program FILE.js] [--plain] [--light] [--select REGION] [--regions]
//
// SPEC.json is an object as `lean save` keeps it ({title, program, data, ...}) or a bare map spec (its data). With no
// program, the map verb's own (PROGRAM in run.mjs) draws it. --both draws the mini form, then the full one.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { hex } from '../../draw/palette.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'
import { PROGRAM } from './run.mjs'

export function toAnsi(grid, { theme = 'dark', select } = {}) {
  const sel = new Set()
  const r = grid.regions.find(x => x.id === select)
  if (r) for (const q of r.rects) for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) sel.add(y * grid.w + x)
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(';')
  const bgOf = theme === 'light' ? '#ffffff' : '#1e1e1e'
  return grid.rows.map((row, y) => {
    let s = ''
    let last = ''
    row.forEach((c, x) => {
      if (c.cont) return
      const bg = sel.has(y * grid.w + x) ? hex('select', theme) : c.bg ? hex(c.bg, theme) : bgOf
      const style = `\x1b[${c.b ? '1;' : '0;'}${c.ref ? '4;' : ''}38;2;${rgb(hex(c.tone, theme))};48;2;${rgb(bg)}m`
      s += (style === last ? '' : style) + c.ch
      last = style
    })
    return s + '\x1b[0m'
  }).join('\n')
}

/** The object to draw: an object file as given, or a bare spec with the verb's program. */
export function objectOf(json) {
  if (json && typeof json === 'object' && typeof json.program === 'string' && json.data !== undefined) return json
  return { title: json && json.title, program: PROGRAM, data: json || {} }
}

export function draw(object, { w = 100, full = false, mode } = {}) {
  const data = full ? { ...(object.data || {}), full: true } : object.data
  const drawing = runProgram({ ...object, data }, { w, mode })
  return { drawing, grid: renderTerm(drawing, { w }) }
}

function main(argv) {
  const flag = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d }
  const has = name => argv.includes(name)
  const file = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--w', '--program', '--select'].includes(argv[i - 1])))
  if (!file) { console.error('usage: node cli.mjs SPEC.json [--w 100] [--full] [--both] [--program FILE.js]'); return 2 }
  let object = objectOf(JSON.parse(readFileSync(file, 'utf8')))
  if (flag('--program')) object = { ...object, program: readFileSync(flag('--program'), 'utf8') }
  const w = Number(flag('--w', 100))
  const forms = has('--both') ? [false, true] : [has('--full')]
  for (const full of forms) {
    const { drawing, grid } = draw(object, { w, full })
    console.log(has('--plain') ? gridText(grid) : toAnsi(grid, { theme: has('--light') ? 'light' : 'dark', select: flag('--select') }))
    for (const x of drawing.warnings || []) console.error('warning ' + x)
    if (drawing.error) console.error(`program error: ${drawing.error.message} (line ${drawing.error.line})`)
    if (has('--regions')) for (const r of grid.regions) console.log(`  ${r.id}  ${JSON.stringify(r.meta.label)} ref=${JSON.stringify(r.meta.ref || null)} rects=${r.rects.length}`)
    if (forms.length > 1) console.log('')
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)))
