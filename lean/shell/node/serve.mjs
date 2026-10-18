// serve.mjs: the browser's side. A small HTTP server on 127.0.0.1 only, for one session's pages. The shell starts it
// only while browser mode is on and a page is asked for; it stops on its own once no page has been open for a while,
// and the hooks module ends it with the session.
//
//   node serve.mjs --root <folder> --session <id> [--lean <bin/lean>] [--idle <seconds>] [--first <seconds>]
//
//   prints {"ready": {"port", "token"}} once listening, then one line for each thing the person does on a page:
//     {"ask": "<text>", "scope": {row?, object?, v?, region?, label?, mark?}}   a question, which becomes a prompt
//     {"verb": "v", "row": "<row key>", "proposal"?: "<words>"}                a verb pressed under a message
//     {"back": {object, v, region, state?}}                                    a selection handed back (the old page)
//   and {"stopped": "<why>"} when it ends on its own.
//
// What it serves, every path behind the token:
//   /<token>/<page>/...        a file of shell/browser/<page>/ (index.html for the folder): every folder there is a
//                              page, so a new page is a new folder and this file does not change
//   /<token>/draw/...          the drawing contract's modules (draw/), which the pages import as ES modules
//   /<token>/lib/object.js     shell/object.js, what both views say of an object
//   /<token>/api/session       this session: its id, folder, first prompt and what it read (lean coverage)
//   /<token>/api/messages      this session's rows (thimble/messages/<session>/index.jsonl), each of Claude's with its
//                              record (CONTRACT 1); an ETag, so a page that polls gets 304 while nothing changed
//   /<token>/api/message/<row> one record
//   /<token>/api/object/<id>   an object (?v=<k> for a version) and the list of its versions
//   /<token>/api/objects       the objects this session saved
//   /<token>/api/from/<id>     where an object's values come from: sources, rows, coverage and labels
//   /<token>/api/resolve?ref=  `lean resolve <ref> --json`: where a value came from, down to its rows
//   /<token>/api/verbs         the verbs of the row under each message (verb.json `row: true`)
//   /<token>/api/asks          what pages of this session asked (for a card's thread)
//   /<token>/api/events        server-sent events: `change` when the messages or objects change. An open stream is
//                              an open page: the server lives while one is open, and a while after the last closes
//   POST /<token>/api/back     what the person did, printed on stdout as one line (above)
//
// It starts no `claude`, holds no credential, and reads only <folder>/thimble/. The token in every path keeps other
// pages and other users of this machine out; the Host check keeps a rebound DNS name out; a POST must come from its
// own origin.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, extname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRef } from '../object.js'
import { listVerbs } from './registry.mjs'

const LEAN_DIR = fileURLToPath(new URL('../../', import.meta.url))
const PAGES = join(LEAN_DIR, 'shell', 'browser')
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/
const REGION = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,95}$/
const ROW = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' }
// the row a page shows when no verb carries `row: true` yet (CONTRACT 3)
const ROW_VERBS = [{ key: 'v', name: 'visualize', order: 0 }, { key: 's', name: 'squeeze', order: 1 }, { key: 'a', name: 'atlas', order: 2 }]
// pages: the sandbox runs programs in a srcdoc iframe and a blob worker (draw/browser/sandbox.js), which this allows;
// nothing on a page can connect anywhere but this server (and the fonts)
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src 'self' blob: data:; base-uri 'none'; form-action 'none'"

/** The object file for id (and version), or null. */
export function objectFile(root, id, v) {
  if (!ID.test(id)) return null
  const latest = join(root, 'thimble', 'objects', `${id}.json`)
  if (!existsSync(latest)) return null
  if (v == null) return latest
  const cur = readJson(latest)
  if (cur && Number(cur.version) === Number(v)) return latest
  const old = join(root, 'thimble', 'objects', '.versions', id, `v${Number(v)}.json`)
  return existsSync(old) ? old : latest
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** The file a page path names, inside `base` and nowhere else (no dot-files, no `..`, no link out), or null. */
export function fileUnder(base, rel) {
  const parts = String(rel || '').split('/').filter(Boolean)
  if (parts.some(p => p.startsWith('.') || p.includes('\\') || p.includes('\0'))) return null
  let f = join(base, ...parts)
  try {
    if (statSync(f).isDirectory()) f = join(f, 'index.html')
    const real = realpathSync(f)
    const top = realpathSync(base)
    if (real !== top && !real.startsWith(top + sep)) return null
    return statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

/** The rows of a session's messages: index.jsonl in order, each of Claude's rows with its record. */
export function readMessages(root, session) {
  const dir = join(root, 'thimble', 'messages', session)
  const rows = []
  const seen = new Map()
  let text = ''
  try { text = readFileSync(join(dir, 'index.jsonl'), 'utf8') } catch { return { rows, dir } }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (!r || typeof r.row !== 'string' || !ROW.test(r.row)) continue
    // a row is drawn once; a second line for it (a redraw) keeps its first place
    if (seen.has(r.row)) { Object.assign(rows[seen.get(r.row)], r); continue }
    seen.set(r.row, rows.length)
    rows.push({ row: r.row, kind: r.kind === 'user' ? 'user' : 'assistant', at: r.at || null, ...(r.kind === 'user' ? { text: String(r.text ?? '') } : {}) })
  }
  for (const r of rows) {
    if (r.kind !== 'assistant') continue
    const rec = readJson(join(dir, `${r.row}.json`))
    if (rec) r.record = rec
  }
  return { rows, dir }
}

/** A cheap signature of what the pages show: the messages folder and the objects folder, by size and time. */
function signature(root, session) {
  const parts = []
  const dirs = [join(root, 'thimble', 'objects')]
  if (session) dirs.unshift(join(root, 'thimble', 'messages', session))
  for (const dir of dirs) {
    let names = []
    try { names = readdirSync(dir) } catch { parts.push('-'); continue }
    for (const n of names.sort()) {
      if (!n.endsWith('.json') && !n.endsWith('.jsonl')) continue
      try { const s = statSync(join(dir, n)); parts.push(`${n}:${s.size}:${s.mtimeMs}`) } catch { /* written now */ }
    }
  }
  let h = 0
  const s = parts.join('|')
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return `"${(h >>> 0).toString(36)}-${parts.length}"`
}

/** What a page posted, checked and reduced to one line of CONTRACT 5 (or the old selection), or {error}. */
export function backLine(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'not an object' }
  if (typeof body.ask === 'string') {
    const text = body.ask.trim().slice(0, 4000)
    if (!text) return { error: 'an empty question' }
    return { ask: text, scope: scopeOf(body.scope) }
  }
  if (typeof body.verb === 'string') {
    if (!/^[a-z0-9]$/.test(body.verb)) return { error: 'a verb is one key' }
    if (typeof body.row !== 'string' || !ROW.test(body.row)) return { error: 'no row' }
    const out = { verb: body.verb, row: body.row }
    if (typeof body.proposal === 'string' && body.proposal.trim()) out.proposal = body.proposal.trim().slice(0, 300)
    return out
  }
  const sel = { object: String(body.object || ''), v: body.v == null ? null : Number(body.v), region: body.region && REGION.test(String(body.region)) ? String(body.region) : null }
  if (!ID.test(sel.object)) return { error: 'no object' }
  if (body.state && typeof body.state === 'object' && !Array.isArray(body.state) && Object.keys(body.state).length) sel.state = JSON.parse(JSON.stringify(body.state))
  return { back: sel }
}

/** An ask's scope as plain checked data: the row, the object and its part, the mark. Anything else is dropped. */
export function scopeOf(s) {
  const out = {}
  if (!s || typeof s !== 'object') return out
  if (typeof s.row === 'string' && ROW.test(s.row)) out.row = s.row
  if (typeof s.object === 'string' && ID.test(s.object)) {
    out.object = s.object
    if (s.v != null && Number.isInteger(Number(s.v))) out.v = Number(s.v)
    if (typeof s.region === 'string' && REGION.test(s.region)) out.region = s.region
  }
  if (typeof s.label === 'string' && s.label.trim()) out.label = s.label.trim().slice(0, 200)
  const m = s.mark
  if (m && typeof m === 'object' && ['cite', 'gloss', 'spark'].includes(m.kind)) {
    const mark = { kind: m.kind }
    if (typeof m.ref === 'string' && isRef(m.ref)) mark.ref = m.ref
    if (typeof m.gloss === 'string' && /^[\w.-]{1,64}$/.test(m.gloss)) mark.gloss = m.gloss
    for (const k of ['label', 'term']) if (typeof m[k] === 'string' && m[k].trim()) mark[k] = m[k].trim().slice(0, 200)
    out.mark = mark
  }
  return out
}

/** Where an object's values come from, in the few facts the "from" line shows. `cov` is `lean coverage <id> --json`. */
export function fromFacts(object, cov) {
  const lin = object?.lineage || {}
  const rows = lin.rows || {}
  const sources = Object.entries(rows).map(([path, x]) => ({ path, rows: Number(x?.count) || 0 }))
  for (const q of Object.values(lin.queries || {})) {
    for (const x of q?.inputs || []) if (x?.path && !sources.some(s => s.path === x.path)) sources.push({ path: x.path, rows: null })
  }
  // a label is a query's kept column (CONTRACT: a label is a query that keeps a column), named where it is used
  const labels = []
  for (const q of Object.values(lin.queries || {})) {
    for (const u of q?.uses || []) if (u?.name && !/^q\d+$/.test(u.name) && !labels.includes(u.name)) labels.push(u.name)
    for (const k of q?.kept || []) if (k && !labels.includes(k)) labels.push(k)
  }
  const out = { sources, rows: sources.reduce((n, s) => n + (s.rows || 0), 0), labels }
  if (cov && !cov.error && Array.isArray(cov.feeding)) {
    const all = cov.feeding.length + (cov.not_feeding || []).length
    out.coverage = { feeding: cov.feeding.length, files: all, notFeeding: (cov.not_feeding || []).slice(0, 12) }
    for (const f of cov.feeding) { const s = out.sources.find(x => x.path === f.path); if (s && f.of != null) s.of = f.of }
  }
  const t = lin.coverage?.total
  if (t) out.session = { files: t.files, notReadFiles: t.not_read_files, notReadRows: t.not_read_rows }
  return out
}

function run(cmd, args, { cwd, env, timeout = 60000 } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 32 << 20, timeout }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || String(err?.message || '') })
    })
  })
}

async function leanJson(lean, root, args, env) {
  const r = await run(lean, [...args, '--json'], { cwd: root, env: { LEAN_ROOT: root, ...env } })
  try { return JSON.parse(r.stdout) } catch { return { error: (r.stdout + r.stderr).trim().slice(0, 600) || `lean ${args[0]} gave nothing` } }
}

/**
 * Start the server (`pages`: the folder of page folders, shell/browser/). `onLine(line)` gets each line for the
 * terminal (`onBack(selection)`, the old name, gets the selections); `onStop(why)` once, when it stops on its own:
 * no page connected within `first` seconds of starting, or none open for `idle` seconds.
 */
export function startServer({ root, session = '', lean = join(LEAN_DIR, 'bin/lean'), pages = PAGES, port = 0, token = randomBytes(18).toString('base64url'), onLine, onBack, onStop = () => {}, idle = 20, first = 180, poll = 700 } = {}) {
  const emit = onLine || (line => { if (line.back && onBack) onBack(line.back) })
  const sess = SESSION.test(session) ? session : ''
  const hosts = new Set()
  const clients = new Set()
  // the person's own reads (a resolve from a page) are never counted as what Claude read
  const personEnv = { LEAN_SESSION: `person-${(sess || 'page').slice(0, 8)}` }
  let sig = signature(root, sess)
  let stopTimer = null
  let coverage = { at: '', value: null }
  const asksFile = sess ? join(root, 'thimble', 'web', `${sess}.asks.jsonl`) : null

  const server = createServer((req, res) => {
    const send = (code, type, body, extra = {}) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra })
      res.end(body)
    }
    const json = (v, code = 200, extra = {}) => send(code, 'application/json', JSON.stringify(v), extra)
    if (!hosts.has(String(req.headers.host || ''))) return send(421, 'text/plain', 'wrong host')
    const url = new URL(req.url, 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p) } catch { return '\0' } })
    if (parts[0] !== token) return send(404, 'text/plain', 'not found')
    const base = `/${token}`
    const [, head, ...rest] = parts
    try {
      if (!head) return send(302, 'text/plain', '', { location: `${base}/mirror/` })
      // the old handoff link: an object's page is now its card detail
      if (head === 'o' && rest.length === 1 && req.method === 'GET') {
        if (!objectFile(root, rest[0], url.searchParams.get('v'))) return send(404, 'text/plain', `no object ${rest[0]}`)
        const v = url.searchParams.get('v')
        return send(302, 'text/plain', '', { location: `${base}/card/?o=${encodeURIComponent(rest[0])}${v ? `&v=${Number(v)}` : ''}` })
      }
      const api = head === 'api' ? rest[0] : head === 'resolve' || head === 'back' ? head : null
      const args = head === 'api' ? rest.slice(1) : rest
      if (api) return apiRoute(req, res, api, args, url, json, send)
      if (req.method !== 'GET') return send(405, 'text/plain', 'GET only')
      // files: the drawing modules, object.js, or a page's folder
      const file = head === 'draw' ? fileUnder(join(LEAN_DIR, 'draw'), rest.join('/'))
        : head === 'lib' ? (rest.length === 1 && rest[0] === 'object.js' ? join(LEAN_DIR, 'shell', 'object.js') : null)
        : fileUnder(pages, [head, ...rest].join('/'))
      if (!file) return send(404, 'text/plain', 'not found')
      // a page's folder needs its trailing slash, so its relative links resolve inside it
      if (!url.pathname.endsWith('/') && !rest.length && file.endsWith(`${sep}index.html`)) return send(302, 'text/plain', '', { location: `${url.pathname}/${url.search}` })
      const type = TYPES[extname(file)] || 'application/octet-stream'
      return send(200, type, readFileSync(file), type.startsWith('text/html') ? { 'content-security-policy': CSP } : {})
    } catch (e) {
      return send(500, 'text/plain', String(e && e.message || e).slice(0, 400))
    }
  })

  function apiRoute(req, res, api, args, url, json, send) {
    if (api === 'back') {
      if (req.method !== 'POST') return send(405, 'text/plain', 'POST only')
      const origin = req.headers.origin
      if (origin && !hosts.has(origin.replace(/^https?:\/\//, ''))) return send(403, 'text/plain', 'wrong origin')
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(415, 'text/plain', 'json only')
      let body = ''
      req.on('data', c => { body += c; if (body.length > 20000) req.destroy() })
      req.on('end', () => {
        let v
        try { v = JSON.parse(body) } catch { return json({ error: 'not json' }, 400) }
        const line = backLine(v)
        if (line.error) return json(line, 400)
        if (line.ask && asksFile) {
          try { mkdirSync(join(root, 'thimble', 'web'), { recursive: true }); appendFileSync(asksFile, JSON.stringify({ at: new Date().toISOString(), text: line.ask, scope: line.scope }) + '\n') } catch { /* the line still goes */ }
        }
        emit(line)
        json({ ok: true, ...line })
      })
      return
    }
    if (req.method !== 'GET') return send(405, 'text/plain', 'GET only')
    if (api === 'events') return events(req, res)
    if (api === 'session') return sessionInfo().then(v => json(v), e => json({ error: String(e) }, 500))
    if (api === 'messages') {
      const now = signature(root, sess)
      if (req.headers['if-none-match'] === now) { res.writeHead(304, { etag: now, 'cache-control': 'no-store' }); return res.end() }
      const { rows } = sess ? readMessages(root, sess) : { rows: [] }
      return json({ session: sess, rows }, 200, { etag: now })
    }
    if (api === 'message' && args.length === 1) {
      if (!sess || !ROW.test(args[0])) return json({ error: 'no row' }, 404)
      const rec = readJson(join(root, 'thimble', 'messages', sess, `${args[0]}.json`))
      return rec ? json(rec) : json({ error: `no record ${args[0]}` }, 404)
    }
    if (api === 'object' && args.length === 1) {
      const file = objectFile(root, args[0], url.searchParams.get('v'))
      if (!file) return json({ error: `no object ${args[0]}` }, 404)
      const object = readJson(file)
      const latest = readJson(join(root, 'thimble', 'objects', `${args[0]}.json`)) || object
      const versions = (latest.history || []).map(h => ({ v: h.v, at: h.at, change: h.change || null }))
      if (!versions.length) versions.push({ v: latest.version, at: latest.updated || null, change: null })
      return json({ object, versions, latest: latest.version })
    }
    if (api === 'objects') {
      let names = []
      try { names = readdirSync(join(root, 'thimble', 'objects')).filter(n => n.endsWith('.json')).sort() } catch { names = [] }
      const list = names.map(n => readJson(join(root, 'thimble', 'objects', n))).filter(Boolean)
        // this session's: saved by Claude, or by a verb the person ran in it (the person's reads go as person-<id>)
        .filter(o => !sess || !o.session || o.session === sess || o.session === personEnv.LEAN_SESSION)
        .map(o => ({ id: o.id, version: o.version, title: o.title || o.id, updated: o.updated || null }))
      return json({ objects: list })
    }
    if (api === 'from' && args.length === 1) {
      const file = objectFile(root, args[0], url.searchParams.get('v'))
      if (!file) return json({ error: `no object ${args[0]}` }, 404)
      const object = readJson(file)
      return leanJson(lean, root, ['coverage', args[0]], personEnv).then(cov => json(fromFacts(object, cov)))
    }
    if (api === 'resolve') {
      const ref = url.searchParams.get('ref') || ''
      if (!ref || ref.length > 2000 || /[\n\r\0]/.test(ref)) return json({ error: 'no ref' }, 400)
      const n = Math.max(1, Math.min(20, Number(url.searchParams.get('n')) || 5))
      return leanJson(lean, root, ['resolve', ref, '-n', String(n)], personEnv).then(r => json(r.error ? { ref, ...r } : r))
    }
    if (api === 'verbs') {
      const { verbs } = listVerbs()
      const row = verbs.filter(v => v.row === true && v.key).map(v => ({ key: v.key, name: v.name, line: v.line || '', order: v.order ?? null }))
      return json({ verbs: row.length ? row : ROW_VERBS })
    }
    if (api === 'asks') {
      const asks = []
      try {
        for (const l of readFileSync(asksFile, 'utf8').split('\n')) { try { if (l.trim()) asks.push(JSON.parse(l)) } catch { /* a line being written */ } }
      } catch { /* none yet */ }
      return json({ asks })
    }
    return json({ error: 'not found' }, 404)
  }

  async function sessionInfo() {
    const { rows } = sess ? readMessages(root, sess) : { rows: [] }
    const firstPrompt = rows.find(r => r.kind === 'user' && r.text)
    // what Claude's session read, as `lean coverage` counts it, once per change of the folder
    if (coverage.at !== sig) {
      const c = sess ? await leanJson(lean, root, ['coverage'], { LEAN_SESSION: sess }) : { error: 'no session' }
      coverage = { at: sig, value: c.error ? null : { total: c.total, groups: (c.groups || []).slice(0, 4).map(g => ({ group: g.group, files: g.files, rows: g.rows, byStatus: g.by_status })) } }
    }
    return { session: sess, root, folder: basename(root), title: firstPrompt ? firstPrompt.text : '', started: rows[0]?.at || null, rows: rows.length, coverage: coverage.value }
  }

  function events(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' })
    res.write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ sig })}\n\n`)
    clients.add(res)
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null }
    req.on('close', () => {
      clients.delete(res)
      if (!clients.size) armStop(idle, 'no page open')
    })
  }

  function armStop(seconds, why) {
    if (stopTimer) clearTimeout(stopTimer)
    stopTimer = setTimeout(() => { if (!clients.size) stop(why) }, seconds * 1000)
  }

  let stopped = false
  function stop(why) {
    if (stopped) return
    stopped = true
    if (stopTimer) clearTimeout(stopTimer)
    for (const c of clients) c.end()
    server.close()
    onStop(why)
  }

  // while a page is open, look for changes and tell the pages; with none open, look at nothing
  const watcher = setInterval(() => {
    if (!clients.size) return
    const now = signature(root, sess)
    if (now === sig) return
    sig = now
    for (const c of clients) c.write(`event: change\ndata: ${JSON.stringify({ sig })}\n\n`)
  }, poll)
  const beat = setInterval(() => { for (const c of clients) c.write(': beat\n\n') }, 15000)
  server.on('close', () => { clearInterval(beat); clearInterval(watcher); if (stopTimer) clearTimeout(stopTimer) })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port
      for (const h of [`127.0.0.1:${p}`, `localhost:${p}`]) hosts.add(h)
      armStop(first, 'no page came')
      resolve({ server, port: p, token, stop, clients })
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const root = flag('--root') || process.cwd()
  const out = line => process.stdout.write(JSON.stringify(line) + '\n')
  const { port, token } = await startServer({
    root, session: flag('--session') || '', lean: flag('--lean') || undefined, port: Number(flag('--port') || 0),
    idle: Number(flag('--idle') || 20), first: Number(flag('--first') || 180),
    onLine: out,
    onStop: why => { out({ stopped: why }); setTimeout(() => process.exit(0), 50) },
  })
  out({ ready: { port, token } })
  // the session's end: the hooks module ends this process with it; should it be left behind, its parent is gone
  const parent = process.ppid
  setInterval(() => { if (process.ppid !== parent) process.exit(0) }, 2000).unref()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1) })
