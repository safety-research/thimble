// cli.mjs: `thimble verb claims`, the commands the orientation's subagent and main run with the Bash tool (so Manual mode
// asks first), and a way to read a session's claims in a terminal.
//
//   thimble verb claims check FILE      the orientation's claims JSON, checked: what the store needs (shape.mjs) and every
//                                       evidence ref and quote, by the kernel's own citation check (check.py). Saves nothing.
//   thimble verb claims save FILE       puts them in this session's claims (thimble/claims/<THIMBLE_SESSION>.json), each
//                                       marked as the orientation's; main runs this, so c lights under its reply
//   thimble verb claims show [--session ID] [--json]
//                                       the session's claims as the list shows them: clusters, claims, ×N, revisions
//   thimble verb claims estimate [ROOT] [--json]
//                                       what the corpus orientation would map here, with its time and tokens
//
// FILE is {title, data: {scope, clusters, claims, relations}} or the data alone (SKILL.md).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeOrientation, readStore, viewOf } from './claims.js'
import { estimate } from './estimate.mjs'
import { loadStore, storeFile, summary } from './run.mjs'
import { check, specFor } from './shape.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const VALUED = ['--session']

/** The folder under analysis for a file: the folder that holds its thimble/ folder, else THIMBLE_ROOT, else here. */
export function rootFor(file) {
  const abs = resolve(file)
  const i = abs.split(sep).lastIndexOf('thimble')
  if (i > 0) return abs.split(sep).slice(0, i).join(sep) || sep
  return resolve(process.env.THIMBLE_ROOT || process.cwd())
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
  if (process.env.THIMBLE_PYTHON) return process.env.THIMBLE_PYTHON
  const venv = join(HERE, '..', '..', '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python3'
}

/** The kernel's citation check of a spec, run in the folder `root`: {cites, hold, problems, other} or {error}. */
export function citations(spec, root) {
  const r = spawnSync(python(), [join(HERE, 'check.py'), '-'], { input: JSON.stringify(spec), cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, THIMBLE_ROOT: root }, timeout: 600000 })
  try { return JSON.parse(r.stdout) } catch { return { error: (r.stderr || r.stdout || String(r.error || '')).trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'the check gave nothing' } }
}

const shapeLine = c => `${c.claims} claim${c.claims === 1 ? '' : 's'} in ${c.clusters} cluster${c.clusters === 1 ? '' : 's'} · ${c.refs} evidence ref${c.refs === 1 ? '' : 's'}`

export function cmdCheck(file, out = console.log) {
  const got = readSpec(file)
  if (got.error) { out(got.error); out('Fix the file and run the check again.'); return 1 }
  const spec = specFor(got.json)
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
  else out(`${name} holds: ${shapeLine(shape.counts)} · ${c.hold} of ${c.cites} citations hold (checked in ${secs}s)`)
  return n ? 1 : 0
}

/** The orientation's claims into this session's claims (THIMBLE_SESSION, which the plugin sets for the session's
 *  commands), each marked as the orientation's; a claim the session already holds word for word is said again. */
export function cmdSave(file, { session = process.env.THIMBLE_SESSION || '', out = console.log, now = new Date().toISOString() } = {}) {
  const got = readSpec(file)
  if (got.error) { out(got.error); return 1 }
  const spec = specFor(got.json)
  const shape = check(spec)
  if (!shape.counts.claims) { out(`nothing to save: ${shape.problems[0] || 'the file has no claims'}`); return 1 }
  if (!session) { out('No session to save into: run this in the Claude Code session (the plugin sets THIMBLE_SESSION for its commands), or pass --session ID.'); return 1 }
  const root = rootFor(file)
  const store = loadStore(root, session)
  const turns = store.claims.map(c => c.turn).filter(t => typeof t === 'number')
  const res = mergeOrientation(store, spec.data, { at: now, turn: turns.length ? Math.max(...turns) : null })
  const f = storeFile(root, session)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(store, null, 1))
  out(`${res.added.length} new claims from the corpus${res.restated.length ? ` (${res.restated.length} the session had said already)` : ''} · this session's claims: ${summary(store)}`)
  if (shape.problems.length) out(`${shape.problems.length} shape problem${shape.problems.length === 1 ? '' : 's'}: ${shape.problems.slice(0, 2).join('; ')}`)
  return 0
}

/** The newest claims file under root's thimble/claims/, for `show` with no session. */
function newestSession(root) {
  const dir = join(root, 'thimble', 'claims')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'orientation.json').map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  return files.length ? files[0].f.replace(/\.json$/, '') : null
}

/** The session's claims as lines: each cluster, then its claims with ×N, the turn, and → the claim that revised it. */
export function showLines(store) {
  const v = viewOf(store)
  const out = [`${summary(store)}${v.turns ? ` · turns ${v.turns[0]}–${v.turns[1]}` : ''}`]
  for (const g of v.groups) {
    out.push('', `${g.name}${g.from === 'orientation' ? ' (from the corpus)' : ''} · ${g.claims.length}`)
    for (const c of g.claims) {
      const rep = c.replacement ? ` → ${c.replacement.id}` : ''
      const meta = [c.kind, c.n > 1 ? `×${c.n}` : '', c.by === 'orientation' ? 'corpus' : c.turn != null ? `t${c.turn}` : '', c.by === 'person' ? 'you' : ''].filter(Boolean).join(' ')
      out.push(`  ${c.id} ${c.revised_by ? `~~${c.text}~~` : c.text}${rep}  [${meta}]${c.sources.length ? `  ${c.sources.map(s => s.ref).join(', ')}` : ''}`)
    }
  }
  for (const g of v.gaps) out.push('', `turn ${g.turn} was not read: ${g.why}`)
  return out
}

function cmdShow(session, json, out = console.log) {
  const root = resolve(process.env.THIMBLE_ROOT || process.cwd())
  const id = session || process.env.THIMBLE_SESSION || newestSession(root)
  if (!id) { out(`no claims here yet (${root}/thimble/claims/)`); return 1 }
  const store = loadStore(root, id)
  if (json) { out(JSON.stringify(store)); return 0 }
  for (const l of showLines(store)) out(l)
  return 0
}

function cmdEstimate(root, json, out = console.log) {
  const e = estimate(resolve(root || process.env.THIMBLE_ROOT || process.cwd()))
  if (json) { out(JSON.stringify(e)); return 0 }
  out(`${e.note} · ~${Math.round(e.tokens / 1000)}k tokens (price-weighted)`)
  out(e.detail)
  return 0
}

function main(argv) {
  const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const has = n => argv.includes(n)
  const words = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.includes(argv[i - 1])))
  const [cmd, arg] = words
  if (cmd === 'check' && arg) return cmdCheck(arg)
  if (cmd === 'save' && arg) return cmdSave(arg, { session: flag('--session') || process.env.THIMBLE_SESSION || '' })
  if (cmd === 'show') return cmdShow(flag('--session'), has('--json'))
  if (cmd === 'estimate') return cmdEstimate(arg, has('--json'))
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
  return cmd ? 2 : 0
}

export { readStore }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)))
