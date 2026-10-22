// ask.ts: the card runner (runner.mjs) from the hooks. One runner per session, started the first time a card needs it,
// reached over a Unix socket in <THIMBLE_HOME>/run/ ($.http.fetch with socketPath: a round trip takes a millisecond or
// two). A runner that is not there (it never started, it stopped, the session was resumed) is started again, and a
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
const runner = { up: false, starting: null as Promise<string | null> | null, exit: '', sock: '', stop: null as null | (() => void), current: null as object | null }

async function socketPath($: Engine): Promise<string> {
  const key = (await sessionKey($)).replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'session'
  return `${await thimbleHome($)}/run/cards-${key}.sock`
}

async function post($: Engine, sock: string, op: string, body: unknown): Promise<Any> {
  const r = await $.http.fetch(`http://runner/${op}`, { method: 'POST', body: JSON.stringify(body ?? {}), socketPath: sock })
  return JSON.parse(r.text)
}

/** Start the runner and wait until it answers; null when it answers, else why it did not. */
async function start($: Engine, sock: string): Promise<string | null> {
  const home = await thimbleHome($)
  const cards = await cardsDir($)
  const here = `${$.plugin.root.replace(/\/+$/, '')}/cards`
  if (sock.length > 100) return `the runner's socket path is longer than 100 characters (${sock.length}); set THIMBLE_HOME to a shorter folder`
  const made = await $.process.run(['mkdir', '-p', '-m', '700', `${home}/run`, cards])
  if (made.exitCode !== 0) return `thimble could not make its folders under ${home} (${String(made.stderr).trim().slice(0, 160)})`
  runner.exit = ''
  runner.stop?.()
  runner.sock = sock
  const argv = ['node', '--permission', `--allow-fs-read=${here}`, `--allow-fs-read=${cards}`, `--allow-fs-write=${home}/run`, '--max-old-space-size=1024', `${here}/runner.mjs`, sock]
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
    ? `Node 22 or later is needed to draw cards (${why})`
    : `the card runner did not start${why ? ` (${why})` : ''}`
}

/** One request to the runner, starting it when it is not there. */
export async function ask($: Engine, op: string, body: unknown): Promise<Any> {
  const sock = await socketPath($)
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
