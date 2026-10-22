// ask.ts: the card runner (runner.mjs) from the hooks. One runner per session, started the first time a card needs it,
// reached over a Unix socket ($.http.fetch with socketPath: a round trip takes a millisecond or two). A socket's path
// holds at most about 100 bytes (108 on Linux, 104 on macOS), so the socket goes in the first of these folders whose
// path fits: <THIMBLE_HOME>/run, $XDG_RUNTIME_DIR/thimble, <temp folder>/thimble-<user>, /tmp/thimble-<user>; each is
// made with mode 700 and used only when this user owns it. Its name is a hash of THIMBLE_HOME and the conversation, so
// a reload of the module finds the runner again, and two homes or two conversations never share one. A runner that is not there (it never started, it stopped, the session was resumed) is started again, and a
// card it does not hold is loaded again from its copy on disk (draw.ts).
//
//   ask($, op, body)   the runner's answer to one request (runner.mjs lists them); {ok: false, error} when the runner
//                      cannot start or stopped while it answered
//
// The runner is started from a timer, so its life is the hooks module's and not the life of the hook that first needed
// it: it ends when the session ends or the module reloads, or when the conversation changes (/clear), whose cards a new
// runner reads.
import type { EngineInterface } from 'claude-code'

import { thimbleHome } from '../core/env'
import { sessionKey } from '../hooks/conversation'
import { cardsDir } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const START_MS = 5000
const SOCKET_MAX = 100
const runner = { up: false, starting: null as Promise<string | null> | null, exit: '', sock: '', stop: null as null | (() => void), current: null as object | null }

function hash(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x9747b28c
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x5bd1e995) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0').slice(0, 4)}`
}

// the socket's path, once found for a home and conversation
const found = new Map<string, string>()

/** The runner's socket: its path, or why no folder can hold it. */
async function socketPath($: Engine): Promise<{ sock?: string; error?: string }> {
  const home = await thimbleHome($)
  const id = `${home}\0${await sessionKey($)}`
  const known = found.get(id)
  if (known) return { sock: known }
  const name = `cards-${hash(id)}.sock`
  const user = String((await $.env.get('USER')) || (await $.env.get('LOGNAME')) || 'user').replace(/[^A-Za-z0-9_-]/g, '')
  const tmp = String((await $.env.get('TMPDIR')) || '').replace(/\/+$/, '')
  const xdg = String((await $.env.get('XDG_RUNTIME_DIR')) || '').replace(/\/+$/, '')
  const dirs = [`${home}/run`, xdg && `${xdg}/thimble`, tmp && `${tmp}/thimble-${user}`, `/tmp/thimble-${user}`].filter(Boolean) as string[]
  for (const dir of dirs) {
    if (`${dir}/${name}`.length > SOCKET_MAX) continue
    const made = await $.process.run(['sh', '-c', 'mkdir -p -m 700 "$1" && test -O "$1" && chmod 700 "$1"', 'sh', dir])
    if (made.exitCode !== 0) continue
    found.set(id, `${dir}/${name}`)
    return { sock: `${dir}/${name}` }
  }
  return { error: `no folder this user owns has a path short enough for the card runner's socket (tried ${dirs.join(', ')})` }
}

async function post($: Engine, sock: string, op: string, body: unknown): Promise<Any> {
  const r = await $.http.fetch(`http://runner/${op}`, { method: 'POST', body: JSON.stringify(body ?? {}), socketPath: sock })
  return JSON.parse(r.text)
}

/** Start the runner and wait until it answers; null when it answers, else why it did not. */
async function start($: Engine, sock: string): Promise<string | null> {
  const cards = await cardsDir($)
  const here = `${$.plugin.root.replace(/\/+$/, '')}/cards`
  const dir = sock.slice(0, sock.lastIndexOf('/'))
  const made = await $.process.run(['mkdir', '-p', '-m', '700', cards])
  if (made.exitCode !== 0) return `thimble could not make its folder ${cards} (${String(made.stderr).trim().slice(0, 160)})`
  runner.exit = ''
  runner.stop?.()
  runner.sock = sock
  const argv = ['node', '--permission', `--allow-fs-read=${here}`, `--allow-fs-read=${cards}`, `--allow-fs-write=${dir}`, '--max-old-space-size=1024', `${here}/runner.mjs`, sock]
  const mine = {}
  runner.current = mine
  $.clock.after(0, () => {
    void (async () => {
      let said = ''
      try {
        const child = $.process.spawn({ argv })
        runner.stop = () => { void child.return?.(undefined as never) }
        for await (const piece of child) if (piece.stream === 'stderr') said = `${said}${piece.text}`.slice(-600)
      } catch (err) {
        said = String((err as Error)?.message || err)
      }
      if (runner.current !== mine) return
      runner.up = false
      runner.exit = said.trim() || 'it stopped'
    })()
  })
  const t0 = Number(await $.clock.now())
  while (Number(await $.clock.now()) - t0 < START_MS) {
    try {
      if ((await post($, sock, 'ping', {})).ok) return null
    } catch {
      // not listening yet
    }
    if (runner.exit) break
    await $.clock.sleep(20)
  }
  const why = runner.exit.split('\n').filter(l => l.trim()).slice(-2).join(' ').slice(0, 300)
  return /permission|bad option/i.test(why)
    ? `Node 22.18 or later is needed to draw cards (${why})`
    : `the card runner did not start${why ? ` (${why})` : ''}`
}

/** One request to the runner, starting it when it is not there. */
export async function ask($: Engine, op: string, body: unknown): Promise<Any> {
  const where = await socketPath($)
  if (!where.sock) return { ok: false, error: where.error, down: true }
  const sock = where.sock
  if (runner.sock && runner.sock !== sock) runner.up = false
  if (runner.up) {
    try { return await post($, sock, op, body) } catch { runner.up = false }
  }
  if (!runner.starting) {
    runner.starting = (async () => {
      // a runner another load of the module started may still listen
      try { if ((await post($, sock, 'ping', {})).ok) return null } catch { /* none */ }
      return start($, sock)
    })().finally(() => { runner.starting = null })
  }
  const why = await runner.starting
  if (why) return { ok: false, error: why, down: true }
  runner.up = true
  try {
    return await post($, sock, op, body)
  } catch {
    runner.up = false
    return { ok: false, error: `the card runner stopped while it drew${runner.exit ? ` (${runner.exit.slice(0, 200)})` : ''}; the view may use too much memory`, down: true }
  }
}
