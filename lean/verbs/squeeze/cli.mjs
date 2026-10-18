// cli.mjs: `lean verb squeeze`, the way main makes or shows a squeeze with the Bash tool (so Manual mode asks first).
//
//   lean verb squeeze <original>                     the original's spans with their ids, to cite in `from`
//   lean verb squeeze <original> --from FILE         a squeeze from the JSON main wrote (SKILL.md, run.mjs FORMAT):
//                                                    checked (unknown spans, numbers not in the cited spans), drawn
//   lean verb squeeze <squeeze.json>                 draws a squeeze made earlier
//     --save NAME     keeps it as a kernel object (`lean save NAME --from ...`) in the folder's thimble/objects/
//     --out FILE      writes the object as JSON
//     --at length=0,story=1   draws another version;  --focus line-2   one line and where it came from
//     --w 100   --text (plain cells)   --json (the object)
//
// <original> is a Markdown or text file, a JSON object with `text` (or `units`), or a kernel object's name.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hex } from '../../draw/palette.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'
import { build, isSqueeze, normalize, originalOf, shownText } from './run.mjs'
import { numbered } from './spans.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const VALUED = ['--from', '--save', '--out', '--at', '--focus', '--w']
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const has = name => args.includes(name)
const what = args.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.includes(args[i - 1])))

function usage(code) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 15).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(code)
}

/** A kernel object by name: thimble/objects/<nn>-<name>.json in this folder or the nearest one above that has it. */
function kernelObject(name) {
  for (let d = resolve(process.env.LEAN_ROOT || process.cwd()); ; d = resolve(d, '..')) {
    const dir = join(d, 'thimble', 'objects')
    if (existsSync(dir)) {
      const f = readdirSync(dir).find(x => x === `${name}.json` || x.replace(/^\d+-/, '') === `${name}.json`)
      if (f) return JSON.parse(readFileSync(join(dir, f), 'utf8'))
    }
    if (d === resolve(d, '..')) return null
  }
}

function load(target) {
  if (existsSync(target)) {
    const text = readFileSync(target, 'utf8')
    if (/\.json$/i.test(target)) {
      const o = JSON.parse(text)
      return { ...o, ref: o.ref || (o.id ? undefined : `file:${target}`) }
    }
    return { ref: target, title: target.split('/').pop(), text }
  }
  const o = kernelObject(target.replace(/^obj:/, ''))
  if (!o) { console.error(`lean verb squeeze: no file and no object named ${target}`); process.exit(2) }
  return o
}

function toAnsi(grid, select) {
  const sel = new Set()
  const r = grid.regions.find(x => x.id === select)
  if (r) for (const q of r.rects) for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) sel.add(y * grid.w + x)
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(';')
  return grid.rows.map((row, y) => row.map((c, x) => {
    if (c.cont) return ''
    const bg = sel.has(y * grid.w + x) ? `48;2;${rgb(hex('select', 'dark'))};` : ''
    return `\x1b[0;${c.b ? '1;' : ''}${c.ref ? '4;' : ''}${bg}38;2;${rgb(hex(c.tone, 'dark'))}m${c.ch}`
  }).join('') + '\x1b[0m').join('\n')
}

if (!what || has('--help')) usage(what ? 0 : 2)
const o = load(what)
let sq
if (isSqueeze(o)) sq = o
else {
  const orig = originalOf(o)
  if (!flag('--from')) {
    console.log(`${o.title || what}: ${orig.lines} lines, ${orig.spans.length} spans. Cite them by id or range in "from".\n`)
    console.log(numbered(orig.spans))
    console.log(`\nWrite the squeeze as JSON (${HERE}SKILL.md) and run: lean verb squeeze ${what} --from FILE`)
    process.exit(0)
  }
  const answer = JSON.parse(readFileSync(flag('--from'), 'utf8'))
  const norm = normalize(answer, orig.spans)
  if (!norm.versions.length) { console.error(`lean verb squeeze: no usable version${norm.problems.length ? ': ' + norm.problems[0] : ''}`); process.exit(1) }
  sq = build(o, orig, norm, { by: 'main', at: new Date().toISOString(), from: flag('--from') })
}
const at = flag('--at')
if (at) {
  const want = Object.fromEntries(at.split(',').map(p => p.split('=')).map(([k, v]) => {
    const dim = sq.data.dims.find(d => d.id === k || d.name === k)
    const i = dim ? (/^\d+$/.test(v) ? Number(v) : dim.levels.indexOf(v)) : -1
    return [dim ? dim.id : k, i]
  }))
  sq = { ...sq, data: { ...sq.data, at: { ...sq.data.at, ...want } } }
  sq.text = shownText(sq)
}
if (flag('--focus')) sq = { ...sq, data: { ...sq.data, focus: flag('--focus') } }
if (flag('--out')) writeFileSync(flag('--out'), JSON.stringify(sq, null, 1))
if (has('--json')) { console.log(JSON.stringify(sq, null, 1)); process.exit(0) }

const w = Number(flag('--w') || 100)
const drawing = runProgram(sq, { w })
const grid = renderTerm(drawing, { w })
console.log(has('--text') ? gridText(grid) : toAnsi(grid, flag('--focus')))
const problems = sq.lineage?.problems || []
if (problems.length) console.log(`\n${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}:\n` + problems.map(p => '- ' + p).join('\n'))
if (drawing.error) console.log(`the program failed: ${drawing.error.message}`)

if (flag('--save')) {
  // the kernel keeps its own lineage; the squeeze's links ride along as what was declared
  const { lineage, ...rest } = sq
  const spec = { ...rest, declared: { squeeze: lineage } }
  const tmp = join(mkdtempSync(join(tmpdir(), 'lean-squeeze-')), 'spec.json')
  writeFileSync(tmp, JSON.stringify(spec))
  const out = execFileSync(join(HERE, '..', '..', 'bin', 'lean'), ['save', flag('--save'), '--from', tmp], { encoding: 'utf8' })
  console.log('\n' + out.trim())
}
