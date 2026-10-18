// cli.mjs: `lean verb atlas`, the commands the subagent and main run with the Bash tool (so Manual mode asks first).
//
//   lean verb atlas check FILE      the atlas JSON the subagent wrote, checked: what drawing needs (shape.mjs) and every
//                                   evidence ref and quote, by the kernel's own citation check (check.py). Saves nothing.
//   lean verb atlas save FILE       saves it as the folder's atlas object (`lean save atlas`, with the atlas program):
//                                   main runs this, so the atlas is drawn under main's reply
//   lean verb atlas show [FILE|NAME] [--w 100] [--detail] [--plain] [--light] [--browser on|off]
//                                   draws an atlas in this terminal as the shell does (the newest atlas by default)
//   lean verb atlas estimate [ROOT] [--json]
//                                   what pressing a would map here, with its time and tokens
//
// FILE is the atlas as JSON: {title, data: {scope, clusters, claims, relations}} or the data alone (SKILL.md).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hex } from '../../draw/palette.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'
import { estimate } from './estimate.mjs'
import { PROGRAM } from './run.mjs'
import { check, isAtlas, specFor, summary } from './shape.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LEAN = join(HERE, '..', '..', 'bin', 'lean')
const VALUED = ['--w', '--browser', '--name']

/** The folder under analysis for a file: the folder that holds its thimble/ folder, else LEAN_ROOT, else here. */
export function rootFor(file) {
  const abs = resolve(file)
  const i = abs.split(sep).lastIndexOf('thimble')
  if (i > 0) return abs.split(sep).slice(0, i).join(sep) || sep
  return resolve(process.env.LEAN_ROOT || process.cwd())
}

function readSpec(file) {
  if (!existsSync(file)) return { error: `no file ${file}` }
  const text = readFileSync(file, 'utf8')
  try { return { json: JSON.parse(text) } } catch (e) {
    const m = /position (\d+)/.exec(e.message)
    const at = m ? text.slice(0, Number(m[1])).split('\n').length : null
    return { error: `${file} is not valid JSON${at ? ` (line ${at})` : ''}: ${e.message}` }
  }
}

function python() {
  if (process.env.LEAN_PYTHON) return process.env.LEAN_PYTHON
  const venv = join(HERE, '..', '..', '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python3'
}

/** The kernel's citation check of a spec, run in the folder `root`: {cites, hold, problems, other} or {error}. */
export function citations(spec, root) {
  const r = spawnSync(python(), [join(HERE, 'check.py'), '-'], { input: JSON.stringify(spec), cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, LEAN_ROOT: root }, timeout: 600000 })
  try { return JSON.parse(r.stdout) } catch { return { error: (r.stderr || r.stdout || String(r.error || '')).trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'the check gave nothing' } }
}

export function cmdCheck(file, out = console.log) {
  const got = readSpec(file)
  if (got.error) { out(got.error); out('Fix the file and run the check again.'); return 1 }
  const spec = specFor(got.json, PROGRAM)
  const shape = check(spec)
  for (const p of shape.problems) out(`problem: ${p}`)
  for (const w of shape.warnings.slice(0, 12)) out(`note: ${w}`)
  const root = rootFor(file)
  const t0 = Date.now()
  const c = shape.counts.claims ? citations(spec, root) : { cites: 0, hold: 0, problems: [], other: [] }
  if (c.error) { out(`the citation check failed: ${c.error}`); return 1 }
  const named = p => p.replace(/^\/claims\/(\d+)\/(\S*?):/, (m, i, rest) => `claim "${spec.data.claims[Number(i)]?.id ?? i}" (${rest || 'evidence'}):`)
  for (const p of c.problems) out(`citation: ${named(p)}`)
  for (const p of c.other || []) out(`problem: ${p}`)
  const name = file.split('/').pop()
  const n = shape.problems.length + c.problems.length + (c.other || []).length
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  if (n) out(`${name}: ${n} problem${n === 1 ? '' : 's'} (above). ${c.hold} of ${c.cites} citations hold. Fix them in the file and run the check again.`)
  else out(`${name} holds: ${summary(spec)} · ${c.hold} of ${c.cites} citations hold (checked in ${secs}s)`)
  return n ? 1 : 0
}

export function cmdSave(file, name = 'atlas', out = console.log) {
  const got = readSpec(file)
  if (got.error) { out(got.error); return 1 }
  const spec = specFor(got.json, PROGRAM)
  const shape = check(spec)
  if (!shape.counts.claims) { out(`nothing to save: ${shape.problems[0] || 'the atlas has no claims'}`); return 1 }
  const root = rootFor(file)
  const r = spawnSync(LEAN, ['save', name, '--change', `the atlas: ${shape.counts.claims} claims`], { input: JSON.stringify(spec), cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, LEAN_ROOT: root } })
  out((r.stdout || '').trimEnd())
  if (r.status !== 0) { out((r.stderr || '').trim().slice(0, 600) || `lean save ended with ${r.status}`); return r.status || 1 }
  out(`the atlas holds ${summary(spec)}${shape.problems.length ? ` · ${shape.problems.length} shape problem${shape.problems.length === 1 ? '' : 's'}: ${shape.problems.slice(0, 2).join('; ')}` : ''}`)
  return 0
}

/** The newest atlas object in the folder (or above it), or null. */
export function newestAtlas(start) {
  for (let d = resolve(start); ; d = dirname(d)) {
    const dir = join(d, 'thimble', 'objects')
    if (existsSync(dir)) {
      const list = readdirSync(dir).filter(f => /(^|-)atlas\.json$/.test(f)).map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { return null } }).filter(isAtlas)
      list.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
      if (list.length) return list[0]
    }
    if (d === dirname(d)) return null
  }
}

/** An atlas drawn at `w` columns: {drawing, grid}. */
export function drawAtlas(object, { w = 100, mode = 'inline', browser } = {}) {
  const o = { program: object.program || PROGRAM, data: object.data }
  const drawing = runProgram(o, { w, mode, state: browser == null ? undefined : { browser } })
  return { drawing, grid: renderTerm(drawing, { w }) }
}

export function toAnsi(grid, theme = 'dark') {
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(';')
  return grid.rows.map(row => {
    let s = ''
    let last = ''
    for (const c of row) {
      if (c.cont) continue
      const st = `\x1b[${c.b ? '1;' : '0;'}38;2;${rgb(hex(c.tone, theme))}m`
      s += (st === last ? '' : st) + c.ch
      last = st
    }
    return s + '\x1b[0m'
  }).join('\n')
}

function cmdShow(target, o, out = console.log) {
  let object
  if (target && existsSync(target)) {
    const got = readSpec(target)
    if (got.error) { out(got.error); return 1 }
    object = got.json.program && got.json.data ? got.json : specFor(got.json, PROGRAM, { keepAdded: true })
  } else {
    object = newestAtlas(process.env.LEAN_ROOT || process.cwd())
    if (target && object && !String(object.id).endsWith(target.replace(/^obj:/, ''))) object = null
    if (!object) { out(`no atlas${target ? ' named ' + target : ''} here: press a under a message, or ask for one`); return 1 }
  }
  const { drawing, grid } = drawAtlas(object, o)
  out(o.plain ? gridText(grid) : toAnsi(grid, o.light ? 'light' : 'dark'))
  if (drawing.error) out(`program error: ${drawing.error.message}`)
  for (const w of drawing.warnings || []) out(`warning: ${w}`)
  return drawing.error ? 1 : 0
}

function cmdEstimate(root, json, out = console.log) {
  const e = estimate(resolve(root || process.env.LEAN_ROOT || process.cwd()))
  if (json) { out(JSON.stringify(e)); return 0 }
  out(`${e.note} · ~${Math.round(e.tokens / 1000)}k tokens (price-weighted)`)
  out(`${e.detail}${e.atlas ? ` · an atlas is saved: ${e.atlas.id} v${e.atlas.version}, ${e.atlas.claims} claims` : ''}`)
  return 0
}

function main(argv) {
  const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const has = n => argv.includes(n)
  const words = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.includes(argv[i - 1])))
  const [cmd, arg] = words
  if (cmd === 'check' && arg) return cmdCheck(arg)
  if (cmd === 'save' && arg) return cmdSave(arg, flag('--name') || 'atlas')
  if (cmd === 'show' || cmd === 'draw') {
    const b = flag('--browser')
    return cmdShow(arg, { w: Number(flag('--w')) || Math.min(140, process.stdout.columns || 110), mode: has('--detail') ? 'detail' : 'inline', plain: has('--plain'), light: has('--light'), browser: b == null ? undefined : b === 'on' })
  }
  if (cmd === 'estimate') return cmdEstimate(arg, has('--json'))
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
  return cmd ? 2 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)))
