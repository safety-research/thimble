// ask.ts: the card runner (runner.mjs) from the hooks. One runner per session, started the first time a card needs it,
// in Anthropic's sandbox runtime (srt; argv.mjs says how), and reached over a Unix socket ($.http.fetch with
// socketPath: a round trip takes a millisecond or two). The runner has a folder of its own, mode 700, which holds only
// its socket and is the one folder it may write: `cards-<hash>` in the first of these folders whose path is short
// enough for a socket (at most about 100 bytes: 108 on Linux, 104 on macOS): <THIMBLE_HOME>/run,
// $XDG_RUNTIME_DIR/thimble, <temp folder>/thimble-<user>, /tmp/thimble-<user>; each is made with mode 700 and used only
// when it is a folder this user owns, not a link. The hash is of THIMBLE_HOME and the conversation, so a reload of the
// module finds the runner again, and two homes or two conversations never share one. A runner that is not there (it
// never started, it stopped, the session was resumed) is started again, and a card it does not hold is loaded again
// from its copy on disk (draw.ts).
//
//   sandbox($)         the sandbox, from sandbox/setup.mjs, which installs srt the first time (it runs at each session
//                      start, register.ts): {ok, node, srt, platform, why, fix}; kept once it works, asked again until then
//   ask($, op, body)   the runner's answer to one request (runner.mjs lists them), or {ok: false, error}: with `down`
//                      when the runner cannot start, so no card can draw (the error says why and how to fix it);
//                      without it when the runner stopped while it answered, which the request itself most likely
//                      caused (a view that took all the memory), so the request is not sent again and the next one
//                      starts a new runner
//
// Cards run only in the sandbox: when it cannot start, no card draws, and the card tool's answer and the failure line
// say why (tool.ts). The runner is started from a timer, so its life is the hooks module's and not the life of the hook
// that first needed it: it ends when the session ends or the module reloads, or when the conversation changes
// (/clear), whose cards a new runner reads.
import type { EngineInterface } from 'claude-code'

import { tempDir, thimbleHome } from '../core/home'
import { runDir, shortHash } from '../core/layout.mjs'
import { sessionKey } from '../hooks/conversation'
import { runnerArgv } from './argv.mjs'
import { cardsDir } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type Sandbox = { ok: boolean; node: string; srt: string; platform: string; why: string; fix: string }

const START_MS = 10000
// npm installs srt the first time: seconds, longer on a slow network
const SETUP_MS = 300000
const SOCKET_MAX = 100
const runner = { up: false, starting: null as Promise<string | null> | null, exit: '', sock: '', stop: null as null | (() => void), current: null as object | null }
let ready: Promise<Sandbox> | null = null

// the socket's path, once found for a home and conversation
const found = new Map<string, string>()

/** sandbox/setup.mjs's answer; with `probe` it also starts a runner in the sandbox, to say why one does not start. */
async function setup($: Engine, probe = false): Promise<Sandbox> {
  const home = await thimbleHome($)
  const path = String((await $.env.get('PATH')) || '/usr/bin:/bin')
  const r = await $.process.run(['node', `${$.plugin.root}/sandbox/setup.mjs`, '--home', home, '--json', ...(probe ? ['--probe'] : [])], { env: { PATH: path }, timeoutMs: SETUP_MS })
  try {
    const s = JSON.parse(String(r.stdout).trim().split('\n').pop() || '')
    if (s && typeof s.ok === 'boolean') return s
  } catch { /* said below */ }
  const said = String(r.stderr).trim().split('\n').filter(l => l.trim()).slice(-2).join(' ').slice(0, 200)
  const noNode = r.exitCode === 127 || /ENOENT|not found/i.test(said)
  return {
    ok: false, node: '', srt: '', platform: '',
    why: noNode ? 'Node is not on the PATH, and the card runner and its sandbox run on it' : `thimble could not set up its sandbox (${said || `exit ${r.exitCode}`})`,
    fix: noNode ? 'Install Node 22.18 or later' : '',
  }
}

/** The sandbox the runner runs in, installed and checked once per session; one that does not work yet is asked again
 *  at the next card, so cards draw as soon as the person fixed it, with no new session. */
export function sandbox($: Engine): Promise<Sandbox> {
  if (!ready) {
    const p: Promise<Sandbox> = setup($).catch(err => ({ ok: false, node: '', srt: '', platform: '', why: String((err as Error)?.message || err), fix: '' }))
    ready = p
    void p.then(s => { if (!s.ok && ready === p) ready = null })
  }
  return ready
}

/** Why the sandbox does not work, and its fix. */
export const sandboxWhy = (s: Pick<Sandbox, 'why' | 'fix'>) => `cards run only in Anthropic's sandbox runtime, which cannot start here: ${String(s.why).replace(/\.$/, '')}${s.fix ? `. ${s.fix.replace(/\.$/, '')}` : ''}`

/** The runner's socket in its own folder: its path, or why no folder can hold it. */
async function socketPath($: Engine): Promise<{ sock?: string; error?: string }> {
  const home = await thimbleHome($)
  const id = `${home}\0${await sessionKey($)}`
  const known = found.get(id)
  if (known) return { sock: known }
  const name = `cards-${shortHash(id)}`
  const user = String((await $.env.get('USER')) || (await $.env.get('LOGNAME')) || 'user').replace(/[^A-Za-z0-9_-]/g, '')
  const xdg = String((await $.env.get('XDG_RUNTIME_DIR')) || '').replace(/\/+$/, '')
  const dirs = [runDir(home), xdg && `${xdg}/thimble`, `${await tempDir($)}/thimble-${user}`, `/tmp/thimble-${user}`].filter(Boolean) as string[]
  // the folder, then the runner's own folder in it: each made with mode 700, a folder this user owns and no link
  const own = 'for d in "$1" "$1/$2"; do mkdir -p -m 700 "$d" && test ! -L "$d" && test -d "$d" && test -O "$d" && chmod 700 "$d" || exit 1; done'
  for (const dir of dirs) {
    const sock = `${dir}/${name}/cards.sock`
    if (sock.length > SOCKET_MAX) continue
    const made = await $.process.run(['sh', '-c', own, 'sh', dir, name])
    if (made.exitCode !== 0) continue
    found.set(id, sock)
    return { sock }
  }
  return { error: `no folder this user owns has a path short enough for the card runner's socket (tried ${dirs.join(', ')})` }
}

async function post($: Engine, sock: string, op: string, body: unknown): Promise<Any> {
  const r = await $.http.fetch(`http://runner/${op}`, { method: 'POST', body: JSON.stringify(body ?? {}), socketPath: sock })
  return JSON.parse(r.text)
}

/** Start the runner in the sandbox and wait until it answers; null when it answers, else why it did not. */
async function start($: Engine, sock: string): Promise<string | null> {
  const s = await sandbox($)
  if (!s.ok) return sandboxWhy(s)
  const cards = await cardsDir($)
  const made = await $.process.run(['mkdir', '-p', '-m', '700', cards])
  if (made.exitCode !== 0) return `thimble could not make its folder ${cards} (${String(made.stderr).trim().slice(0, 160)})`
  runner.exit = ''
  runner.stop?.()
  runner.sock = sock
  const argv = runnerArgv({
    plugin: $.plugin.root, node: s.node, srt: s.srt, platform: s.platform, cards, run: sock.slice(0, sock.lastIndexOf('/')), sock,
    home: String((await $.env.get('HOME')) || ''), thimbleHome: await thimbleHome($), path: String((await $.env.get('PATH')) || '/usr/bin:/bin'),
  })
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
  runner.stop?.()
  // what kept it from starting: setup.mjs starts a runner of its own in the sandbox, and says why that one does not start
  const probed = await setup($, true)
  if (!probed.ok) return sandboxWhy(probed)
  const why = runner.exit.split('\n').filter(l => l.trim()).slice(-2).join(' ').slice(0, 300)
  return `the card runner did not start in its sandbox${why ? ` (${why})` : ''}`
}

/** The answer when the runner stopped while it answered this request. */
function stopped(): Any {
  runner.up = false
  return { ok: false, error: `the card stopped the card runner${runner.exit ? ` (${runner.exit.slice(0, 200)})` : ''}, most likely by using too much memory: draw fewer rows or elements` }
}

/** One request to the runner, starting it when it is not there. */
export async function ask($: Engine, op: string, body: unknown): Promise<Any> {
  const where = await socketPath($)
  if (!where.sock) return { ok: false, error: where.error, down: true }
  const sock = where.sock
  if (runner.sock && runner.sock !== sock) runner.up = false
  if (runner.up) {
    try { return await post($, sock, op, body) } catch { return stopped() }
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
    return stopped()
  }
}
