// estimate.mjs: what pressing `a` would map in a folder, and about how long and how many tokens it would take. The
// observer reads it to light `a` as an offer ("map 40 runs · ~2 min"); it never starts anything.
//
//   node estimate.mjs ROOT        prints the estimate as JSON (the observer runs it as a Node child)
//   estimate(root) -> {kind, unit, n, what, detail, minutes, tokens, note, offer, atlas, ...}
//
// It looks only at the folder's file list and sizes, plus the first 16 KiB of each .jsonl file (to tell a chat
// transcript from other records). It reads no row in full and writes nothing, so it can run after every turn: a
// folder of 10,000 files takes about a tenth of a second.
//
// What it maps:
//   runs     the folder holds chat transcripts (an agent's run, a swarm's agents, a sweep). A run is the first folder
//            below the transcripts' common folder (runs/<run>/agents/*.jsonl), or each transcript when they sit in
//            one folder side by side. "map 16 runs" (768 transcripts).
//   dataset  no transcripts: the records files (jsonl, csv, json, databases), else every source file. "map 4 files".
//
// Time and tokens grow slowly with the size: the subagent reads a sample of a large folder and counts the rest in
// code. MODEL holds the rule, fitted to live builds (pandas-swarm, ml-tasks, collusion-wiki); tokens are
// price-weighted (input 1, cache write 1.25, cache read 0.1, output 5).
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.thimble', 'thimble', '.lite'])
const RECORDS = new Set(['.jsonl', '.ndjson', '.csv', '.tsv', '.json', '.db', '.sqlite', '.sqlite3'])
const SOURCE = new Set([...RECORDS, '.md', '.markdown', '.rst', '.diff', '.patch', '.txt', '.log', '.py', '.js', '.mjs', '.ts', '.tsx',
  '.sh', '.yaml', '.yml', '.toml', '.html', '.css', '.sql', '.r', '.ipynb', '.go', '.rs', '.java', '.c', '.cpp', '.h'])
const TRANSCRIPT_TYPES = /"type"\s*:\s*"(user|assistant|system|result|summary)"/
const TRANSCRIPT_KEYS = /"(message|subtype|session_id|sessionId)"\s*:/
const HEAD = 16 * 1024
const MAX_FILES = 50000

/** The rule for time and tokens: base + per unit (up to `cap` units) + per doubling of the size in MB. */
export const MODEL = {
  cap: 60,
  base: { minutes: 3, tokens: 260000 },
  unit: { minutes: 0.05, tokens: 2500 },
  log2mb: { minutes: 0.25, tokens: 9000 },
  add: { minutes: 0.3, tokens: 9000 },
}

const fmt = n => Number(n).toLocaleString('en-US')
const ext = name => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i).toLowerCase() : '' }

function head(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(HEAD)
    const n = readSync(fd, buf, 0, HEAD, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch { return '' } finally { if (fd != null) try { closeSync(fd) } catch { /* closed */ } }
}

/** Whether the start of a .jsonl file reads as chat records (Claude Code's transcripts and stream-json logs). */
export function looksLikeTranscript(text) {
  const lines = String(text).split('\n').slice(0, 5)
  return lines.some(l => TRANSCRIPT_TYPES.test(l) && TRANSCRIPT_KEYS.test(l))
}

/** Every source file under root: {path (relative, with /), size, ext}. Folders the kernel skips are skipped. */
export function listFiles(root, max = MAX_FILES) {
  const out = []
  const walk = dir => {
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of ents) {
      if (out.length >= max) return
      if (e.name.startsWith('.') && e.isDirectory()) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p) } else if (e.isFile() && SOURCE.has(ext(e.name))) {
        let size = 0
        try { size = statSync(p).size } catch { continue }
        out.push({ path: relative(root, p).split(sep).join('/'), size, ext: ext(e.name) })
      }
    }
  }
  walk(root)
  return out
}

/** The runs the transcripts make: {key, files} per run, and the folder they share. */
export function runsOf(transcripts) {
  if (!transcripts.length) return { common: '', runs: [] }
  const parts = transcripts.map(t => t.path.split('/'))
  const common = []
  for (let i = 0; ; i++) {
    const seg = parts[0][i]
    if (seg == null || parts.some(p => p.length - 1 <= i || p[i] !== seg)) break
    common.push(seg)
  }
  const by = new Map()
  transcripts.forEach((t, j) => {
    const key = parts[j][common.length]
    if (!by.has(key)) by.set(key, [])
    by.get(key).push(t)
  })
  return { common: common.join('/'), runs: [...by.entries()].map(([key, files]) => ({ key, files })) }
}

/** The unit word for runs: the shared folder's own name when it says what they are (agents, sessions), else runs. */
function unitOf(common, runs) {
  const last = common.split('/').pop() || ''
  const named = /^(agents|sessions|runs|episodes|trajectories|transcripts|trials)$/i.exec(last)
  if (named && runs.every(r => r.files.length === 1 && !r.key.includes('/'))) return named[1].toLowerCase()
  return 'runs'
}

function rowsOf(root, f) {
  if (!['.jsonl', '.ndjson', '.csv', '.tsv'].includes(f.ext)) return null
  if (f.size <= 64 * 1024 * 1024) {
    try {
      const b = readFileSync(join(root, f.path))
      let n = 0
      for (let i = 0; i < b.length; i++) if (b[i] === 10) n++
      if (b.length && b[b.length - 1] !== 10) n++
      return f.ext === '.csv' || f.ext === '.tsv' ? Math.max(0, n - 1) : n
    } catch { return null }
  }
  const lines = head(join(root, f.path)).split('\n').slice(0, -1)
  return lines.length ? Math.round(f.size / (HEAD / lines.length)) : null
}

/** Minutes and price-weighted tokens for mapping `n` units of `bytes`. */
export function cost(n, bytes, model = MODEL) {
  const u = Math.min(model.cap, Math.max(1, n))
  const l = Math.log2(1 + bytes / 1e6)
  const minutes = model.base.minutes + model.unit.minutes * u + model.log2mb.minutes * l
  const tokens = model.base.tokens + model.unit.tokens * u + model.log2mb.tokens * l
  return { minutes: Math.max(1, Math.round(minutes)), tokens: Math.round(tokens / 10000) * 10000 }
}

/** The atlas already saved in the folder, if any: {id, version, claims, clusters, updated}. */
export function atlasIn(root) {
  const dir = join(root, 'thimble', 'objects')
  if (!existsSync(dir)) return null
  let best = null
  for (const f of readdirSync(dir)) {
    if (!/(^|-)atlas\.json$/.test(f)) continue
    try {
      const o = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (!Array.isArray(o?.data?.claims)) continue
      const clusters = new Set(o.data.claims.map(c => c.cluster).filter(c => c != null && c !== ''))
      const a = { id: o.id, version: o.version, claims: o.data.claims.length, clusters: clusters.size, updated: o.updated }
      if (!best || String(a.updated) > String(best.updated)) best = a
    } catch { /* a file being written */ }
  }
  return best
}

/** The estimate for a folder (see the head of this file). */
export function estimate(root, { files } = {}) {
  const t0 = Date.now()
  const all = files || listFiles(root)
  const transcripts = all.filter(f => f.ext === '.jsonl' || f.ext === '.ndjson').map(f => ({ ...f, head: head(join(root, f.path)) })).filter(f => looksLikeTranscript(f.head))
  const atlas = atlasIn(root)
  let out
  if (transcripts.length) {
    const { common, runs } = runsOf(transcripts)
    const bytes = transcripts.reduce((s, t) => s + t.size, 0)
    const unit = unitOf(common, runs)
    const n = runs.length
    const read = common ? `${common}/` : ''
    const what = n === 1 ? `map this run` : `map ${fmt(n)} ${unit}`
    const per = transcripts.length > n ? `${fmt(transcripts.length)} transcripts · ` : `${fmt(n)} transcript${n === 1 ? '' : 's'} · `
    out = { kind: 'runs', unit, n, transcripts: transcripts.length, bytes, read, runs: runs.slice(0, 200).map(r => r.key), what,
      detail: `${per}${mb(bytes)}`, ...cost(n, bytes) }
  } else {
    const rec = all.filter(f => RECORDS.has(f.ext))
    const use = rec.length ? rec : all
    const bytes = use.reduce((s, f) => s + f.size, 0)
    const rows = use.reduce((s, f) => s + (rowsOf(root, f) || 0), 0)
    const n = use.length
    const what = n === 1 ? `map ${use[0].path}` : `map ${fmt(n)} files`
    out = { kind: 'dataset', unit: 'files', n, rows, bytes, read: '', what, detail: `${rows ? fmt(rows) + ' rows · ' : ''}${mb(bytes)}`, ...cost(n, bytes) }
  }
  out.files = all.length
  out.note = `${out.what} · ~${out.minutes} min`
  out.offer = { what: out.what, minutes: out.minutes, tokens: out.tokens }
  if (atlas) {
    out.atlas = atlas
    out.add = { what: 'add this message\'s claims to the map', minutes: MODEL.add.minutes, tokens: MODEL.add.tokens }
  } else out.atlas = null
  out.ms = Date.now() - t0
  return out
}

function mb(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(estimate(process.argv[2] || process.env.LEAN_ROOT || process.cwd())) + '\n')
}
