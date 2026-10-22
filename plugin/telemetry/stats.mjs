// stats.mjs: `thimble dev stats`, a session's cost and time per feature, from its events (events.mjs), and against a plain
// Claude Code transcript when given one. Cost is price-weighted tokens: input 1, cache write 1.25, cache read 0.1,
// output 5.
//
//   thimble dev stats                         the newest session under $THIMBLE_HOME/events
//   thimble dev stats SESSION|FILE            that session (an id, or its events file)
//   thimble dev stats ... --against PLAIN     beside a plain Claude Code transcript (.jsonl) of the same questions
//   thimble dev stats ... --json              the numbers as JSON
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eventsFile, safeName } from '../core/layout.mjs'
import { parseLines, plainTurns, summarize, weighted } from './events.mjs'

const k = n => `${(n / 1000).toFixed(1)}k`
const sec = ms => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)

export function eventsDir(env = process.env) {
  return dirname(eventsFile(env.THIMBLE_HOME || join(env.HOME || '.', '.thimble'), 'x'))
}

/** The events file a word names: a file, a session id, or (none) the newest. */
export function findEvents(word, env = process.env) {
  if (word && existsSync(word) && statSync(word).isFile()) return word
  const dir = eventsDir(env)
  if (word) {
    const f = join(dir, `${safeName(word)}.jsonl`)
    if (existsSync(f)) return f
    const hit = existsSync(dir) ? readdirSync(dir).find(x => x.startsWith(safeName(word))) : null
    if (hit) return join(dir, hit)
    throw new Error(`no events for "${word}" in ${dir}`)
  }
  if (!existsSync(dir)) throw new Error(`no events yet: ${dir} does not exist`)
  const files = readdirSync(dir).filter(x => x.endsWith('.jsonl') && !x.startsWith('person-')).map(x => join(dir, x))
  if (!files.length) throw new Error(`no events yet in ${dir}`)
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

/** The report as lines (and the numbers, for --json). */
export function report(events, { plain = null, file = '' } = {}) {
  const s = summarize(events)
  const rows = Object.values(s.features)
  const main = rows.filter(r => r.main)
  const side = rows.filter(r => !r.main)
  const order = ['checker', 'designer', 'labels']
  side.sort((a, b) => (order.indexOf(a.feature) + 1 || 99) - (order.indexOf(b.feature) + 1 || 99) || b.w - a.w)
  const session = events.find(e => e.session)?.session || ''
  const lines = []
  lines.push(`thimble · session ${session.slice(0, 8) || '?'}${file ? ` · ${file}` : ''}`)
  if (s.prompts?.plugin) lines.push(`thimble ${s.prompts.plugin}`)
  lines.push('')
  lines.push(`${pad('feature', 30)}${lpad('calls', 6)}${lpad('tokens (price-weighted)', 25)}${lpad('time', 9)}  blocked the main turn`)
  let totalW = 0
  let totalMs = 0
  const line = (name, r, extra = '') => lines.push(`${pad(name, 30)}${lpad(r.calls ?? '', 6)}${lpad(k(r.w), 25)}${lpad(sec(r.ms), 9)}  ${extra}`)
  for (const r of main) {
    line(r.feature, r, '(the turn itself)')
    totalW += r.w
    totalMs += r.ms
    if (r.hook_ms != null) lines.push(`${pad('  thimble hooks inside them', 30)}${lpad('', 6)}${lpad('', 25)}${lpad(sec(r.hook_ms), 9)}  (added to the turns)`)
  }
  for (const r of side) {
    const blocked = r.turn ? '-' : `${r.blocked} of ${r.calls}`
    line(r.feature, r, `${blocked}${r.failed ? ` · ${r.failed} failed` : ''}${r.prompts?.size ? ` · ${[...r.prompts].join(', ')}` : ''}`)
    totalW += r.w
  }
  lines.push(`${pad('all', 30)}${lpad('', 6)}${lpad(k(totalW), 25)}${lpad(sec(totalMs), 9)}  (time: the main turns; forks and label reads run beside them)`)
  // per main turn: all of thimble's cost
  const turnsN = main.reduce((n, r) => n + (r.calls || 0), 0)
  if (turnsN && totalW) lines.push(`${pad('per main turn', 30)}${k(totalW / turnsN)} in all`)
  const out = { session, features: rows.map(r => ({ ...r, prompts: [...(r.prompts || [])] })), total_w: totalW, main_ms: totalMs }
  if (plain) {
    const pt = plainTurns(plain)
    const mainTurns = s.turns.filter(t => !t.agent)
    const pw = pt.reduce((a, t) => a + t.w, 0)
    const pms = pt.reduce((a, t) => a + t.ms, 0)
    const mw = mainTurns.reduce((a, t) => a + weighted(t.usage).total, 0)
    const mms = mainTurns.reduce((a, t) => a + (t.ms || 0), 0)
    const hook = mainTurns.reduce((a, t) => a + (t.hook_ms || 0), 0)
    const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round((100 * (a - b)) / b)}%` : '')
    lines.push('')
    lines.push(`against plain Claude Code (${pt.length} turns in the transcript, ${mainTurns.length} main turns here)`)
    lines.push(`${pad('', 30)}${lpad('tokens', 12)}${lpad('time', 10)}`)
    lines.push(`${pad('plain Claude Code', 30)}${lpad(k(pw), 12)}${lpad(sec(pms), 10)}`)
    lines.push(`${pad('thimble: main turns', 30)}${lpad(k(mw), 12)}${lpad(sec(mms), 10)}  ${pct(mw, pw)} tokens, ${pct(mms, pms)} time`)
    lines.push(`${pad('thimble: all features', 30)}${lpad(k(totalW), 12)}${lpad(sec(mms), 10)}  ${pct(totalW, pw)} tokens; thimble's hooks took ${sec(hook)} of the main turns' time`)
    const n = Math.max(pt.length, mainTurns.length)
    if (n) {
      lines.push('')
      lines.push(`${pad('turn', 6)}${lpad('plain tokens', 14)}${lpad('time', 8)}${lpad('thimble tokens', 16)}${lpad('time', 8)}${lpad('hooks', 8)}  feature`)
      for (let i = 0; i < n; i++) {
        const p = pt[i]
        const t = mainTurns[i]
        lines.push(`${pad(`q${i + 1}`, 6)}${lpad(p ? k(p.w) : '', 14)}${lpad(p ? sec(p.ms) : '', 8)}${lpad(t ? k(weighted(t.usage).total) : '', 16)}${lpad(t ? sec(t.ms) : '', 8)}${lpad(t && t.hook_ms != null ? sec(t.hook_ms) : '', 8)}  ${t ? t.feature : ''}`)
      }
    }
    out.plain = { turns: pt, w: pw, ms: pms, main_w: mw, main_ms: mms, hook_ms: hook }
  }
  return { lines, out }
}

function main(argv) {
  const json = argv.includes('--json')
  const i = argv.indexOf('--against')
  const against = i >= 0 ? argv[i + 1] : null
  const word = argv.filter((a, j) => !a.startsWith('--') && (i < 0 || j !== i + 1))[0] || null
  const file = findEvents(word)
  const events = parseLines(readFileSync(file, 'utf8'))
  const plain = against ? parseLines(readFileSync(against, 'utf8')) : null
  const r = report(events, { plain, file })
  if (json) console.log(JSON.stringify(r.out, null, 1))
  else console.log(r.lines.join('\n'))
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (err) { console.error(`thimble dev stats: ${err.message}`); process.exitCode = 1 }
}
