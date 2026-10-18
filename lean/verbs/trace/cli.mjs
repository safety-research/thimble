// cli.mjs: the Trace verb in a plain terminal, until the shell's t key lands. It runs run.mjs with a ctx built here:
// the kernel is the `lean` command, programs run in the drawing sandbox, and the result is drawn by the terminal
// renderer.
//
//   node cli.mjs REF [--text WORDS] [--in GLOB] [--step REGION] [--w 100] [--light] [--plain] [--json]
//   node cli.mjs REF --program FILE.js [--claude FILE.json]    draw a full trace program Claude wrote, on the facts
//
// --step traces on from one step of the short path (as t on a selected step does). Run it in the folder under
// analysis; LEAN_PYTHON names a Python with pandas, as for `lean` itself.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { hex } from '../../draw/palette.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'
import { facts, run } from './run.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LEAN = HERE + '../../bin/lean'

export function kernel(args) {
  const r = spawnSync(LEAN, args, { encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status !== 0) throw new Error((r.stdout || r.stderr || `lean exited ${r.status}`).trim())
  return r.stdout
}

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

async function main(argv) {
  const flag = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d }
  const has = name => argv.includes(name)
  const takes = ['--text', '--in', '--step', '--w', '--program', '--claude', '--select']
  const ref = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && takes.includes(argv[i - 1])))
  const w = Number(flag('--w', 100))
  const ctx = { ref, text: flag('--text'), kernel, draw: { runProgram }, w }
  if (!ref && !ctx.text) { console.error('usage: node cli.mjs REF [--text WORDS] [--in GLOB] [--step REGION] [--program FILE]'); return 2 }
  let out
  if (flag('--program')) {
    const f = await facts(ctx, { ref, text: ctx.text, within: flag('--in') })
    const claude = flag('--claude') ? JSON.parse(readFileSync(flag('--claude'), 'utf8')) : {}
    const { slimFacts } = await import('./prompt.mjs')
    out = { object: { id: 'trace-full', verb: 'trace', program: readFileSync(flag('--program'), 'utf8'), data: { facts: slimFacts(f), claude } } }
  } else {
    out = await run(ctx)
    if (flag('--step') && out.object) {
      const drawing = runProgram(out.object, { w })
      out = await run({ ...ctx, ref: undefined, text: undefined, object: out.object, drawing, region: flag('--step') })
    }
  }
  if (has('--json')) { console.log(JSON.stringify(out, null, 1)); return 0 }
  if (out.text) console.log(out.text)
  if (out.object) {
    const drawing = runProgram(out.object, { w })
    const grid = renderTerm(drawing, { w })
    console.log(has('--plain') ? gridText(grid) : toAnsi(grid, { theme: has('--light') ? 'light' : 'dark', select: flag('--select') }))
    for (const x of drawing.warnings || []) console.error('warning ' + x)
    if (drawing.error) console.error(`program error: ${drawing.error.message}`)
  }
  if (out.note && has('--note')) console.log('\nnote to Claude: ' + out.note)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(String(e?.stack || e)); process.exit(1) })
}
