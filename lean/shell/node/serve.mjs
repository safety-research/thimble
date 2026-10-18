// serve.mjs: the browser's side of the handoff. A small HTTP server on 127.0.0.1 only, for this session's objects:
//
//   node serve.mjs --root <folder> [--lean <bin/lean>]
//   prints {"ready": {"port", "token"}} once listening, then one line {"back": {object, v, region}} each time the
//   person sends a selection back to the terminal from the page
//
//   GET  /<token>/o/<id>[?v=<k>]   the object's page: the same program, drawn as SVG (draw/svg.js) in the browser's
//                                  sandbox, with the selection in the URL hash (#o=<id>@<v>&r=<region>&w=<cols>)
//   GET  /<token>/resolve?ref=…    `lean resolve <ref> -n 5 --json`: where a value came from, down to its rows
//   POST /<token>/back             {object, v, region, state?}: the selection (and the knobs' values), handed to the
//                                  terminal on stdout
//
// It serves the browser and nothing else: it starts no `claude`, holds no credential and reads only the objects
// under <folder>/thimble/objects. The token in every path keeps other pages and other users of this machine out; the
// Host check keeps a rebound DNS name out. The terminal's hooks module starts it and it ends with that module.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atlasRoute } from '../browser/atlas/route.mjs'

const LEAN_DIR = fileURLToPath(new URL('../../', import.meta.url))
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/
const REGION = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,95}$/

/** The object file for id (and version), or null. */
export function objectFile(root, id, v) {
  if (!ID.test(id)) return null
  const latest = join(root, 'thimble', 'objects', `${id}.json`)
  if (!existsSync(latest)) return null
  if (v == null) return latest
  const cur = JSON.parse(readFileSync(latest, 'utf8'))
  if (Number(cur.version) === Number(v)) return latest
  const old = join(root, 'thimble', 'objects', '.versions', id, `v${Number(v)}.json`)
  return existsSync(old) ? old : latest
}

// the page: the renderer modules joined into one module script, as draw/browser/build.mjs does, then the shell's page
const strip = src => src.replace(/^import [^\n]*\n/gm, '').replace(/^export (?=(async )?function|const|let|class)/gm, '')
const MODULES = ['draw/flex.js', 'draw/palette.js', 'draw/svg.js', 'draw/handoff.js', 'draw/browser/sandbox.js', 'shell/object.js', 'shell/browser/page.js']
const safe = s => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')

export function pageHtml(object, { base }) {
  const bundle = MODULES.map(f => `// ---- ${f}\n` + strip(readFileSync(join(LEAN_DIR, f), 'utf8'))).join('\n')
  const css = readFileSync(join(LEAN_DIR, 'shell/browser/page.css'), 'utf8')
  const title = String(object.title || object.id).replace(/[<&>]/g, '')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style></head>
<body><main><header id="head"></header><div id="stage"></div><section id="words"></section><section id="detail"></section></main>
<script id="kit-src" type="text/plain">${safe(readFileSync(join(LEAN_DIR, 'draw/kit.js'), 'utf8'))}</script>
<script id="object" type="application/json">${safe(JSON.stringify(object))}</script>
<script id="base" type="application/json">${safe(JSON.stringify(base))}</script>
<script type="module">
${safe(bundle)}
</script>
</body></html>
`
}

export function startServer({ root, lean = join(LEAN_DIR, 'bin/lean'), port = 0, token = randomBytes(18).toString('base64url'), onBack = () => {} } = {}) {
  const hosts = new Set()
  const server = createServer((req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
      res.end(body)
    }
    if (!hosts.has(String(req.headers.host || ''))) return send(421, 'text/plain', 'wrong host')
    const url = new URL(req.url, 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== token) return send(404, 'text/plain', 'not found')
    try {
      // the Atlas page, its files and objects as JSON (shell/browser/atlas/route.mjs)
      if (atlasRoute(req, url, parts, { root, token, objectFile, send: (code, type, body, extra) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra }); res.end(body) } })) return
      if (req.method === 'GET' && parts[1] === 'o' && parts[2] && parts.length === 3) {
        const file = objectFile(root, decodeURIComponent(parts[2]), url.searchParams.get('v'))
        if (!file) return send(404, 'text/plain', `no object ${parts[2]} in ${root}`)
        const object = JSON.parse(readFileSync(file, 'utf8'))
        return send(200, 'text/html; charset=utf-8', pageHtml(object, { base: `/${token}` }))
      }
      if (req.method === 'GET' && parts[1] === 'resolve') {
        const ref = url.searchParams.get('ref') || ''
        if (!ref || ref.length > 2000 || /[\n\r\0]/.test(ref)) return send(400, 'application/json', '{"error":"no ref"}')
        const n = Math.max(1, Math.min(20, Number(url.searchParams.get('n')) || 5))
        const r = spawnSync(lean, ['resolve', ref, '-n', String(n), '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 32 << 20, env: { ...process.env, LEAN_ROOT: root }, timeout: 60000 })
        let body = r.stdout
        try { JSON.parse(body) } catch { body = JSON.stringify({ ref, error: (r.stdout + r.stderr).trim().slice(0, 600) || 'lean resolve gave nothing' }) }
        return send(200, 'application/json', body)
      }
      if (req.method === 'POST' && parts[1] === 'back') {
        const origin = req.headers.origin
        if (origin && !hosts.has(origin.replace(/^https?:\/\//, ''))) return send(403, 'text/plain', 'wrong origin')
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(415, 'text/plain', 'json only')
        let body = ''
        req.on('data', c => { body += c; if (body.length > 10000) req.destroy() })
        req.on('end', () => {
          let sel
          try { sel = JSON.parse(body) } catch { return send(400, 'application/json', '{"error":"not json"}') }
          const out = { object: String(sel.object || ''), v: sel.v == null ? null : Number(sel.v), region: sel.region && REGION.test(String(sel.region)) ? String(sel.region) : null }
          // the knobs' values, as plain data
          if (sel.state && typeof sel.state === 'object' && !Array.isArray(sel.state) && Object.keys(sel.state).length) out.state = JSON.parse(JSON.stringify(sel.state))
          if (!ID.test(out.object)) return send(400, 'application/json', '{"error":"no object"}')
          onBack(out)
          send(200, 'application/json', JSON.stringify({ ok: true, ...out }))
        })
        return
      }
      return send(404, 'text/plain', 'not found')
    } catch (e) {
      return send(500, 'text/plain', String(e && e.message || e).slice(0, 400))
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port
      for (const h of [`127.0.0.1:${p}`, `localhost:${p}`]) hosts.add(h)
      resolve({ server, port: p, token })
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const root = flag('--root') || process.cwd()
  const { port, token } = await startServer({
    root, lean: flag('--lean') || undefined, port: Number(flag('--port') || 0),
    onBack: sel => process.stdout.write(JSON.stringify({ back: sel }) + '\n'),
  })
  process.stdout.write(JSON.stringify({ ready: { port, token } }) + '\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1) })
