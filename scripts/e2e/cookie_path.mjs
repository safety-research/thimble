#!/usr/bin/env node
// The browser's sign-in reaches thimble alone, in Chromium, Firefox and WebKit (backend/app/hook_auth.py, the cookie's
// path; frontend/src/lib/browserKey.ts). A cookie is bound to a host and a path but not to a port, so the cookie is
// scoped to /b/<key>/api/, a path of the browser's own, which the page keeps the key of. This starts thimble's server
// from this checkout, with the built UI, on one free loopback port, and on another a stand-in for any other program's
// server, which logs the Cookie header of every request it gets. In each browser it opens thimble's link (the app opens,
// signed in, and its reads answer), opens a link into the app in a new tab (no sign-in again) and a new link there (the
// key stays), opens the other server's page by 127.0.0.1 and by localhost, which asks for its own /api/ paths, an
// image, an event stream and a guessed /b/<key>/api/ path (no request it gets carries thimble's cookie), then takes the
// page's key away (the sign-in line shows) and opens a new link (signed in again, with a new key). The 0.9.0 sign-in:
// the press's way in (a 60 s code minted with an open id, in a redirect file the browser opens from disk: the claim
// deletes the file and writes its claim mark), the cookie's 30 days, and stale tabs: a server stopped for good ends the
// page's stream with `stopping` (the page stops), and after a server killed outright another program that binds its port
// gets the page's challenge on the plain path and no cookie or key (the page stops too). It prints one JSON line per
// browser and exits 1 when a check fails.
//
//   node scripts/e2e/cookie_path.mjs [--browsers chromium,firefox,webkit] [--dist DIR] [--port N] [--other-port N]
//
// Needs backend/.venv, a built UI (frontend/dist, or --dist DIR) and Playwright's browsers for frontend/'s Playwright
// (cd frontend && npx playwright install chromium firefox webkit; PLAYWRIGHT_BROWSERS_PATH is honored). Everything it
// starts runs in a temporary folder of its own (thimble's home, data, workspaces, HOME and Claude Code's config folder)
// and stops at the end. The two ports are free ones unless --port (thimble's) and --other-port name them.
import { spawn, spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const SIGN_IN_LINE = "This browser isn't signed in. Type `/thimble open` in your Claude Code terminal, or press o in thimble's panel."
// what a stopped page says (frontend shell/ServerDown STOPPED_LINE)
const STOPPED_LINE = "thimble's page stopped with the Claude Code session. Type /thimble open in the terminal to open it again."
const DAY_S = 24 * 3600
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
  const serverEnv = (p) => ({
    PATH: '/usr/bin:/bin',
    HOME: join(tmp, 'user'),
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: join(tmp, 'cc'),
    THIMBLE_HOME: home,
    THIMBLE_DATA_DIR: join(tmp, 'data'),
    THIMBLE_WORKSPACES_DIR: join(tmp, 'workspaces'),
    THIMBLE_FRONTEND_DIST: DIST,
    THIMBLE_PORT: String(p),
    THIMBLE_CARD_CHECK: 'off',
  })
  const startServer = (p) => {
    const proc = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(p), '--log-level', 'warning'], {
      cwd: join(REPO, 'backend'), env: serverEnv(p), stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', (b) => serverLog.push(String(b)))
    proc.stderr.on('data', (b) => serverLog.push(String(b)))
    return proc
  }
  const healthy = async (o, proc) => {
    const until = Date.now() + WAIT_MS
    for (;;) {
      if (await fetch(`${o}/api/health`).then((r) => r.ok, () => false)) return
      if (Date.now() > until || proc.exitCode != null) throw new Error(`thimble's server did not start:\n${serverLog.join('').slice(-2000)}`)
      await sleep(250)
    }
  }
  const exited = (proc) => new Promise((ok) => (proc.exitCode != null || proc.signalCode != null ? ok() : proc.once('exit', ok)))
  const server = startServer(port)
  const extra = [] // the servers the stale-tab checks start
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
    await healthy(origin, server)
    const signedAt = (o, p) => (path, body) => fetch(`${o}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...proof(token, p) }, body: JSON.stringify(body) })
    const signed = signedAt(origin, port)
    const reg = await (await signed('/api/corpora/register', { path: join(tmp, 'corpus') })).json()
    wsName = String(reg.name || '')
    if (!wsName) throw new Error(`the corpus was not registered: ${JSON.stringify(reg)}`)
    const link = async (o = origin, p = port) => {
      const r = await (await signedAt(o, p)('/api/ui/pair', { ws: wsName })).json()
      if (!r.code) throw new Error(`no sign-in code: ${JSON.stringify(r)}`)
      return `${o}/?ws=${encodeURIComponent(wsName)}#p=${r.code}`
    }
    // the press's way in: a 60 s code made with an open id, in the redirect file backend app/opener.py writes
    const pressed = async () => {
      const oid = randomBytes(12).toString('base64url')
      const r = await (await signed('/api/ui/pair', { ws: wsName, ttl: 60, open: oid })).json()
      if (!r.code || r.expires_s !== 60) throw new Error(`no 60 s code: ${JSON.stringify({ expires_s: r.expires_s })}`)
      const w = spawnSync(PYTHON, ['-c', 'import sys; from app import opener; print(opener.write_redirect(sys.argv[1], sys.argv[2]))',
        `${origin}/?ws=${encodeURIComponent(wsName)}#p=${r.code}`, oid], { cwd: join(REPO, 'backend'), env: serverEnv(port), encoding: 'utf8' })
      const file = (w.stdout || '').trim()
      if (!file || !existsSync(file)) throw new Error(`no redirect file: ${w.stderr.slice(0, 300)}`)
      return { file, claim: join(home, 'open', `${oid}.claimed`) }
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
        const cookieDays = (jar[0]?.expires ?? 0) > 0 ? (jar[0].expires - Date.now() / 1000) / DAY_S : 0
        check(cookieDays > 29 && cookieDays <= 30.01, `the cookie lasts 30 days (${cookieDays.toFixed(2)})`)
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
        // 3b. the press's way in, in a browser of its own: the redirect file, opened from disk, signs it in; the claim
        // deletes the file and writes its claim mark
        const own = await browser.newContext()
        try {
          const pr = await pressed()
          const pp = await own.newPage()
          await pp.goto(pathToFileURL(pr.file).href)
          await shell(pp)
          let marked = false
          for (let i = 0; i < 20 && !marked; i++) {
            marked = existsSync(pr.claim)
            if (!marked) await sleep(250)
          }
          check(marked && !existsSync(pr.file) && !(await signInShown(pp)), `the redirect file signs in (claim mark ${marked ? 'written' : 'missing'}, file ${existsSync(pr.file) ? 'left' : 'deleted'})`)
        } finally {
          await own.close()
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
        // 5. stale tabs, each against a server of its own on a port of its own
        const stale = await browser.newContext().catch(() => null)
        try {
          if (!stale) throw new Error('no browser context')
          // a server stopped for good ends the page's stream with `stopping`: the page stops
          const p1 = await freePort()
          const s1 = startServer(p1)
          extra.push(s1)
          const o1 = `http://127.0.0.1:${p1}`
          await healthy(o1, s1)
          const page1 = await stale.newPage()
          await page1.goto(await link(o1, p1))
          await shell(page1)
          await page1.waitForTimeout(1_000)
          s1.kill('SIGTERM')
          await exited(s1)
          const stopped1 = await page1.locator('.stopped-line').waitFor({ timeout: 10_000 }).then(() => true, () => false)
          const said = stopped1 ? (await page1.locator('.stopped-line').innerText()).replace(/\s+/g, ' ').trim() : ''
          check(stopped1 && said === STOPPED_LINE, `a server stopped for good stops the page ("${said}")`)
          await page1.close()
          // a server killed outright, and another program on its port: the page asks the challenge with no credential, gets
          // no answer it takes, and stops; the program gets no cookie and no key
          const p2 = await freePort()
          const s2 = startServer(p2)
          extra.push(s2)
          const o2 = `http://127.0.0.1:${p2}`
          await healthy(o2, s2)
          const page2 = await stale.newPage()
          await page2.goto(await link(o2, p2))
          await shell(page2)
          await page2.waitForTimeout(1_000)
          const key2 = await page2.evaluate((item) => localStorage.getItem(item) || '', KEY_ITEM)
          s2.kill('SIGKILL')
          await exited(s2)
          const got = []
          const impostor = http.createServer((req, res) => {
            got.push({ path: req.url || '', cookie: req.headers.cookie || '' })
            res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
          })
          await new Promise((ok) => impostor.listen(p2, '127.0.0.1', ok))
          try {
            const stopped2 = await page2.locator('.stopped-line').waitFor({ timeout: 20_000 }).then(() => true, () => false)
            const leaked = got.filter((g) => g.cookie.includes('thimble-ui-') || g.path.includes(key2) || g.path.startsWith('/b/'))
            const hello = got.filter((g) => g.path.startsWith('/api/hello?'))
            check(stopped2 && hello.length >= 1 && !leaked.length,
              `after the server died, the program on its port got ${got.length} requests (${[...new Set(got.map((g) => g.path.split('?')[0]))].join(', ')}): ${hello.length} challenges, ${leaked.length} with the cookie or the key; the page ${stopped2 ? 'stopped' : 'did not stop'}`)
          } finally {
            await new Promise((ok) => impostor.close(ok))
          }
        } catch (e) {
          check(false, `the stale-tab checks stopped: ${String(e?.message || e).split('\n')[0]}`)
        } finally {
          await stale?.close().catch(() => undefined)
        }
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
    for (const proc of [server, ...extra]) if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGTERM')
    await Promise.all([server, ...extra].map(exited))
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
