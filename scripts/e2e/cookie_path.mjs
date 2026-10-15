#!/usr/bin/env node
// The browser's sign-in reaches thimble alone, in Chromium, Firefox and WebKit (backend/app/hook_auth.py, the cookie's
// path; frontend/src/lib/browserKey.ts). A cookie is bound to a host and a path but not to a port, so the cookie is
// scoped to /b/<key>/api/, a path of the browser's own, which the page keeps the key of. This starts thimble's server
// from this checkout, with the built UI, on one free loopback port, and on another a stand-in for any other program's
// server, which logs the Cookie header of every request it gets. In each browser it opens thimble's link (the app opens,
// signed in, and its reads answer), opens a link into the app in a new tab (no sign-in again) and a new link there (the
// key stays), opens the other server's page by 127.0.0.1 and by localhost, which asks for its own /api/ paths, an
// image, an event stream and a guessed /b/<key>/api/ path (no request it gets carries thimble's cookie), then takes the
// page's key away (the sign-in line shows) and opens a new link (signed in again, with a new key). It prints one JSON
// line per browser and exits 1 when a check fails.
//
//   node scripts/e2e/cookie_path.mjs [--browsers chromium,firefox,webkit] [--dist DIR] [--port N] [--other-port N]
//
// Needs backend/.venv, a built UI (frontend/dist, or --dist DIR) and Playwright's browsers for frontend/'s Playwright
// (cd frontend && npx playwright install chromium firefox webkit; PLAYWRIGHT_BROWSERS_PATH is honored). Everything it
// starts runs in a temporary folder of its own (thimble's home, data, workspaces, HOME and Claude Code's config folder)
// and stops at the end. The two ports are free ones unless --port (thimble's) and --other-port name them.
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const BROWSERS = opt('--browsers', 'chromium,firefox,webkit').split(',').map((b) => b.trim()).filter(Boolean)
const DIST = resolve(opt('--dist', join(REPO, 'frontend', 'dist')))
const PYTHON = join(REPO, 'backend', '.venv', 'bin', 'python')
const require = createRequire(join(REPO, 'frontend', 'package.json'))
const pw = require('playwright')
// the one line a browser that is not signed in sees (frontend shell/SignIn), its span in backticks drawn as code
const SIGN_IN_LINE = "This browser isn't signed in. Open the link /thimble shows in your terminal, or run `thimble up` in a shell."
const KEY_ITEM = 'thimble-browser-key'
const WAIT_MS = 30_000

function freePort() {
  return new Promise((ok, fail) => {
    const s = net.createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

/** The proof thimble's CLI sends with a request to the server on `port` (backend hook_auth.headers). */
function proof(token, port) {
  const nonce = `${Math.floor(Date.now() / 1000)}.${randomBytes(16).toString('hex')}`
  return { 'x-thimble-nonce': nonce, 'x-thimble-auth': createHmac('sha256', token).update(`hook@${port}:${nonce}`).digest('hex') }
}

/** The other program's page: it asks its own server for thimble's API paths, as any page on 127.0.0.1 or localhost
 * may, and says when it is done in its title. */
const probePage = (ws) => `<!doctype html><title>probe</title><script>
const paths = ['/api/ui/paired', '/api/ws/${ws}/canvas', '/api/corpora', '/b/a-guessed-browser-key-0123/api/ui/paired']
Promise.all(paths.map((p) => fetch(p).then((r) => r.status, () => 0)))
  .then(() => fetch('/api/ws/${ws}/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => 0))
  .then(() => new Promise((ok) => { const img = new Image(); img.onload = img.onerror = ok; img.src = '/api/ws/${ws}/media?path=a.png' }))
  .then(() => new Promise((ok) => { const es = new EventSource('/api/ws/${ws}/events'); const end = () => { es.close(); ok() }; es.onmessage = end; es.onerror = end; setTimeout(end, 2000) }))
  .then(() => { document.title = 'probe:done' })
</script>`

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`no built UI at ${DIST}: run npm run build in frontend/, or pass --dist`)
  if (!existsSync(PYTHON)) throw new Error(`no ${PYTHON}: run scripts/check.sh install`)
  const tmp = mkdtempSync(join(tmpdir(), 'thimble-cookie-path-'))
  const home = join(tmp, 'home')
  for (const d of ['home', 'data', 'workspaces', 'user', 'cc', 'corpus/agents']) mkdirSync(join(tmp, d), { recursive: true })
  const token = randomBytes(24).toString('hex')
  writeFileSync(join(home, 'server.json'), JSON.stringify({ token }), { mode: 0o600 })
  writeFileSync(join(tmp, 'corpus', 'agents', 'agent-01.jsonl'), ['hello', 'world', 'again'].map((text, i) => JSON.stringify({ i, text })).join('\n') + '\n')
  const port = Number(opt('--port', 0)) || (await freePort())
  const otherPort = Number(opt('--other-port', 0)) || (await freePort())
  const origin = `http://127.0.0.1:${port}`
  const serverLog = []
  const server = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], {
    cwd: join(REPO, 'backend'),
    env: {
      PATH: '/usr/bin:/bin',
      HOME: join(tmp, 'user'),
      LANG: 'C.UTF-8',
      CLAUDE_CONFIG_DIR: join(tmp, 'cc'),
      THIMBLE_HOME: home,
      THIMBLE_DATA_DIR: join(tmp, 'data'),
      THIMBLE_WORKSPACES_DIR: join(tmp, 'workspaces'),
      THIMBLE_FRONTEND_DIST: DIST,
      THIMBLE_PORT: String(port),
      THIMBLE_CARD_CHECK: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (b) => serverLog.push(String(b)))
  server.stderr.on('data', (b) => serverLog.push(String(b)))
  const seen = [] // what the other server got: {host, path, cookie}
  const other = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, method: req.method, path: req.url, cookie: req.headers.cookie || '' })
    const path = (req.url || '').split('?')[0]
    if (path === '/probe') return res.writeHead(200, { 'content-type': 'text/html' }).end(probePage(wsName))
    if (path.endsWith('/events') && req.method === 'GET') return res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {}\n\n')
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  let wsName = ''
  const results = []
  let failed = false
  try {
    await new Promise((ok) => other.listen(otherPort, '127.0.0.1', ok))
    const until = Date.now() + WAIT_MS
    for (;;) {
      const up = await fetch(`${origin}/api/health`).then((r) => r.ok, () => false)
      if (up) break
      if (Date.now() > until || server.exitCode != null) throw new Error(`thimble's server did not start:\n${serverLog.join('').slice(-2000)}`)
      await sleep(250)
    }
    const signed = (path, body) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...proof(token, port) }, body: JSON.stringify(body) })
    const reg = await (await signed('/api/corpora/register', { path: join(tmp, 'corpus') })).json()
    wsName = String(reg.name || '')
    if (!wsName) throw new Error(`the corpus was not registered: ${JSON.stringify(reg)}`)
    const link = async () => {
      const r = await (await signed('/api/ui/pair', { ws: wsName })).json()
      if (!r.code) throw new Error(`no sign-in code: ${JSON.stringify(r)}`)
      return `${origin}/?ws=${encodeURIComponent(wsName)}#p=${r.code}`
    }
    for (const name of BROWSERS) {
      const type = pw[name]
      const row = { browser: name, checks: [] }
      const check = (ok, what) => {
        row.checks.push(`${ok ? 'ok' : 'FAILED'}: ${what}`)
        if (!ok) failed = true
      }
      const browser = await type.launch()
      row.browser = `${name} ${browser.version()}`
      try {
        const ctx = await browser.newContext()
        const page = await ctx.newPage()
        const signInShown = async (p) => (await p.locator('.signin-line').count()) > 0
        const shell = (p) => p.getByRole('tab', { name: 'Files', exact: true }).waitFor({ timeout: WAIT_MS })
        // 1. the link signs the browser in, and the app works
        await page.goto(await link())
        await shell(page)
        const key = await page.evaluate((item) => localStorage.getItem(item) || '', KEY_ITEM)
        check(/^[A-Za-z0-9_-]{32}$/.test(key) && !(await signInShown(page)), `the link signs in and the app opens (key ${key ? 'kept' : 'missing'})`)
        const jar = (await ctx.cookies()).filter((c) => c.name.startsWith('thimble-ui-'))
        check(jar.length === 1 && jar[0].path === `/b/${key}/api/` && jar[0].httpOnly && jar[0].sameSite === 'Strict',
          `the cookie is scoped to the browser's own path, HttpOnly and SameSite=Strict (${jar.map((c) => `${c.name} ${c.path} httpOnly=${c.httpOnly} sameSite=${c.sameSite}`).join(', ')})`)
        const reads = await page.evaluate(async ([k, ws]) => ({
          under: (await fetch(`/b/${k}/api/ws/${ws}/canvas`)).status,
          plain: (await fetch(`/api/ws/${ws}/canvas`)).status,
        }), [key, wsName])
        check(reads.under === 200 && reads.plain === 401, `reads answer under the browser's path (${reads.under}) and not on /api/ itself (${reads.plain})`)
        // 2. a link into the app in a new tab of the same browser needs no sign-in
        const tab = await ctx.newPage()
        await tab.goto(`${origin}/?ws=${encodeURIComponent(wsName)}&ref=${encodeURIComponent('agents/agent-01.jsonl#L2')}`)
        await shell(tab)
        check(!(await signInShown(tab)), 'a link into the app opens in a new tab, signed in')
        // a new link with a code, in a browser that is signed in: it spends the code and keeps its key
        await tab.goto(await link())
        await shell(tab)
        const kept = await tab.evaluate((item) => localStorage.getItem(item) || '', KEY_ITEM)
        check(kept === key && !(await signInShown(tab)) && (await ctx.cookies()).filter((c) => c.name.startsWith('thimble-ui-')).length === 1,
          'a new link opened in the signed-in browser changes nothing: same key, one cookie')
        await tab.close()
        // 3. another program's page, by 127.0.0.1 and by localhost, gets no cookie of thimble's
        for (const host of [`127.0.0.1:${otherPort}`, `localhost:${otherPort}`]) {
          const from = seen.length
          const probe = await ctx.newPage()
          await probe.goto(`http://${host}/probe`)
          await probe.waitForFunction(() => document.title === 'probe:done', null, { timeout: WAIT_MS })
          await probe.close()
          const got = seen.slice(from).filter((s) => s.path !== '/probe')
          const leaked = got.filter((s) => s.cookie.includes('thimble-ui-'))
          check(got.length >= 6 && !leaked.length,
            `the page of another server at ${host} gets no cookie of thimble's on ${got.length} requests (${got.map((s) => `${s.method} ${s.path.split('?')[0]}`).join(', ')})${leaked.length ? `; LEAKED on ${leaked.map((s) => s.path).join(', ')}` : ''}`)
        }
        // 4. a browser that lost its key shows the sign-in line, and a new link signs it in again
        await page.evaluate((item) => localStorage.removeItem(item), KEY_ITEM)
        await page.goto(`${origin}/?ws=${encodeURIComponent(wsName)}`)
        await page.locator('.signin-line').waitFor({ timeout: WAIT_MS })
        const line = (await page.locator('.signin-line').innerText()).replace(/\s+/g, ' ').trim()
        check(line === SIGN_IN_LINE.replace(/`/g, ''), `without its key the page shows the sign-in line ("${line}")`)
        await page.goto(await link())
        await shell(page)
        const again = await page.evaluate((item) => localStorage.getItem(item) || '', KEY_ITEM)
        check(!!again && again !== key && !(await signInShown(page)), 'a new link signs it in again, with a new key')
        await ctx.close()
      } catch (e) {
        check(false, `the run stopped: ${String(e?.message || e).split('\n')[0]}`)
      } finally {
        await browser.close()
      }
      results.push(row)
      console.log(JSON.stringify(row))
    }
  } finally {
    other.close()
    server.kill('SIGTERM')
    await new Promise((ok) => (server.exitCode != null ? ok() : server.once('exit', ok)))
    rmSync(tmp, { recursive: true, force: true })
  }
  if (!results.length) failed = true
  console.log(failed ? 'cookie_path: a check FAILED' : `cookie_path: every check passed in ${results.map((r) => r.browser).join(', ')}`)
  return failed ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`cookie_path: ${e?.stack || e}`)
    process.exit(1)
  },
)
