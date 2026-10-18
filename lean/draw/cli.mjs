// cli.mjs: draw an example (or an object file) in this terminal, the way the mod's renderer lays it out.
//
//   node cli.mjs <example id | object.json> [--w 100] [--h 24] [--select <region id>] [--light] [--text] [--json]
//                [--state '{"view":"model"}'] [--event '{"type":"key","key":"f"}'] [--check]
//
// --state and --event run the card as the person would leave it and act on it: the cells it then draws, and the state
// and ask its handlers answered with. --check tries every interaction it declares once (each knob value, key, press
// and brush), as a save does, and prints what fails.
//
// --text prints plain cells, --json the drawing. Colors are the palette's, in 24-bit escapes.
import { readFileSync } from 'node:fs'
import { loadExample } from './examples/load.mjs'
import { hex } from './palette.js'
import { exercise, exerciseLine } from './exercise.mjs'
import { runProgram } from './sandbox-node.mjs'
import { gridText, renderTerm } from './term.js'

const args = process.argv.slice(2)
const flag = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d }
const has = name => args.includes(name)
const what = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--w', '--h', '--select', '--state', '--event', '--budget'].includes(args[i - 1])))
if (!what) { console.error('usage: node cli.mjs <example id | object.json> [--w 100] [--select id] [--light] [--text] [--json]'); process.exit(2) }
const object = what.endsWith('.json') ? JSON.parse(readFileSync(what, 'utf8')) : loadExample(what)
const w = Number(flag('--w', 100)), h = Number(flag('--h', 24))
const parse = s => { try { return s ? JSON.parse(s) : undefined } catch (e) { console.error(`not JSON: ${s}`); process.exit(2) } }
const drawing = runProgram(object, { w, h, state: parse(flag('--state')), event: parse(flag('--event')) })
if (has('--check')) {
  const r = exercise(object, { w, h, state: parse(flag('--state')) }, drawing.error ? null : drawing, Number(flag('--budget', 2000)))
  console.log(drawing.error ? `it does not draw: ${drawing.error.name}: ${drawing.error.message}` : exerciseLine(r) || `all ${r.tried} interaction${r.tried === 1 ? '' : 's'} ran (${r.ms} ms)`)
  process.exit(drawing.error || r.failed.length ? 1 : 0)
}
if (has('--json')) { console.log(JSON.stringify(drawing, null, 1)); process.exit(0) }
const grid = renderTerm(drawing, { w })
if (has('--text')) { console.log(gridText(grid)); process.exit(0) }
console.log(toAnsi(grid, { theme: has('--light') ? 'light' : 'dark', select: flag('--select') }))
for (const x of drawing.warnings || []) console.log('\x1b[33mwarning\x1b[0m ' + x)
if (drawing.on) console.log('\x1b[2mtakes: ' + drawing.on.map(o => o.name + (o.label ? ` (${o.label})` : '')).join(' · ') + '\x1b[0m')
if (drawing.handled) console.log('\x1b[2m' + drawing.handled + ' → state ' + JSON.stringify(drawing.state) + (drawing.ask ? ' · ask ' + JSON.stringify(drawing.ask).slice(0, 200) : '') + '\x1b[0m')
if (grid.cut.length) console.log('\x1b[2mcut: ' + JSON.stringify(grid.cut) + '\x1b[0m')
console.log(`\x1b[2m${grid.w}×${grid.h} cells · ${grid.regions.length} regions · program ${drawing.ms} ms\x1b[0m`)

function toAnsi(grid, { theme, select }) {
  const sel = new Set()
  const r = grid.regions.find(x => x.id === select)
  if (r) for (const q of r.rects) for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) sel.add(y * grid.w + x)
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(';')
  const bgOf = theme === 'light' ? '#ffffff' : '#1e1e1e'
  return grid.rows.map((row, y) => {
    let s = '', last = ''
    row.forEach((c, x) => {
      if (c.cont) return
      const fg = hex(c.tone, theme)
      const bg = sel.has(y * grid.w + x) ? hex('select', theme) : c.bg ? hex(c.bg, theme) : bgOf
      const style = `\x1b[${c.b ? '1;' : '0;'}${c.ref ? '4;' : ''}38;2;${rgb(fg)};48;2;${rgb(bg)}m`
      s += (style === last ? '' : style) + c.ch
      last = style
    })
    return s + '\x1b[0m'
  }).join('\n')
}
