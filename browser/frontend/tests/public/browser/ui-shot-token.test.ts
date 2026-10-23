// What scripts/ui_shot.mjs sends, the page screenshots of main's `screenshot` tool and of the dev agent (backend
// tools._shot_page, dev.run_shot). The headless page holds no sign-in cookie, so its reads of thimble's API carry the
// shot token the server hands the script in THIMBLE_SHOT_TOKEN (backend hook_auth.mint_shot): only reads of /api/ on the
// page's own origin, never a write (answered 204 in the script) and never another origin. --offline and --own-origin
// still refuse what they refuse for /api/ paths, which a read handler that continued every GET once let through.
// The pages come from two small servers on the loopback, since the script drives a browser of its own.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, test } from 'vitest'
import { FRONTEND } from './page.ts'

type Seen = { method: string; path: string; headers: IncomingHttpHeaders }
const dir = mkdtempSync(path.join(tmpdir(), 'thimble-ui-shot-'))
const TOKEN = 'shot-token-of-the-test'
let own: { server: Server; origin: string; seen: Seen[] }
let other: { server: Server; origin: string; seen: Seen[] }

/** A server on the loopback that records each request and answers `page` at / and an empty 200 elsewhere. */
async function serve(page: () => string, port: number): Promise<{ server: Server; origin: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers })
    if (req.url === '/' || req.url === '/own') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(page())
    } else {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

// UI_SHOT_TEST_PORT pins the first server's port (the second takes the next), for a machine that keeps tests to a range
const PORT = Number(process.env.UI_SHOT_TEST_PORT || 0)

beforeAll(async () => {
  other = await serve(() => '<!doctype html><p>other</p>', PORT ? PORT + 1 : 0)
  own = await serve(
    () => `<!doctype html><html><body><img src="/api/img.png"><script>
      fetch('/api/read')
        .then(() => fetch('/api/write', { method: 'POST', body: '{}' }))
        .then(() => fetch('${other.origin}/api/other', { mode: 'no-cors' }))
        .finally(() => { document.body.dataset.done = '1' })
    </script></body></html>`,
    PORT,
  )
})

afterAll(async () => {
  for (const s of [own, other]) await new Promise((resolve) => s?.server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

/** Run the script (asynchronously: the servers answer from this process) and wait for it to exit 0. */
async function shoot(args: string[], token = TOKEN): Promise<void> {
  const child = spawn('node', [path.join(FRONTEND, '..', 'scripts', 'ui_shot.mjs'), '--out', path.join(dir, 'shot.png'), '--wait', '0', ...args], {
    env: { ...process.env, THIMBLE_SHOT_TOKEN: token },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += String(d)))
  const timer = setTimeout(() => child.kill(), 45_000)
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  clearTimeout(timer)
  assert.equal(code, 0, stderr)
}

const reqs = (s: { seen: Seen[] }, p: string) => s.seen.filter((r) => r.path === p)

test('the page\'s reads of its own API carry the shot token, and nothing else does', async () => {
  own.seen.length = 0
  other.seen.length = 0
  await shoot(['--url', `${own.origin}/`])
  const [read] = reqs(own, '/api/read')
  const [img] = reqs(own, '/api/img.png')
  assert.equal(read?.headers['x-thimble-shot'], TOKEN, 'a fetch of the page\'s own API')
  assert.equal(read?.headers['x-thimble-peek'], '1')
  assert.equal(img?.headers['x-thimble-shot'], TOKEN, 'an image of the page\'s own API')
  assert.equal(reqs(own, '/api/write').length, 0, 'a write never reaches the server')
  assert.equal(reqs(own, '/')[0]?.headers['x-thimble-shot'], undefined, 'the page itself is no API read')
  const [elsewhere] = reqs(other, '/api/other')
  assert.ok(elsewhere, 'the other origin is reached')
  assert.equal(elsewhere.headers['x-thimble-shot'], undefined, 'another origin never gets the token')
})

test('--offline reaches no server at all, /api/ paths included, and sends no token', async () => {
  own.seen.length = 0
  const file = path.join(dir, 'figure.html')
  writeFileSync(file, `<!doctype html><img src="${own.origin}/api/img.png"><script>fetch('${own.origin}/api/read', { mode: 'no-cors' })</script>`)
  await shoot(['--url', pathToFileURL(file).href, '--offline'])
  assert.deepEqual(own.seen, [])
})

test('--own-origin keeps the page to its own server, /api/ paths included', async () => {
  own.seen.length = 0
  other.seen.length = 0
  await shoot(['--url', `${own.origin}/own`, '--own-origin'])
  assert.equal(reqs(own, '/api/read')[0]?.headers['x-thimble-shot'], TOKEN)
  assert.deepEqual(reqs(other, '/api/other'), [], 'another port of the loopback is another origin')
})
