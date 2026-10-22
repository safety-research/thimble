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
//                      start, register.ts): {ok, node, srt, platform, why, fix}; kept once it works, asked again until
//                      then. Each hook that asks runs setup.mjs itself: a hook's own time is bounded (10 s) while a `$`
//                      call it makes is not, so a card called while the session start installs srt waits in its own
//                      setup.mjs, which waits for that install, and not on the session start's promise
//   stopRunner($)      the session ends: the runner stops and its folder goes
//   ask($, op, body)   the runner's answer to one request (runner.mjs lists them), or {ok: false, error}: with `down`
//                      when the runner cannot start, so no card can draw (the error says why and how to fix it, and
//                      `machine` says the fix is the machine's, such as a package to install, not thimble's);
//                      without it when the runner stopped while it answered, which the request itself most likely
//                      caused (a view that took all the memory), so the request is not sent again and the next one
//                      starts a new runner
//
// Cards run only in the sandbox: when it cannot start, no card draws, and the card tool's answer and the failure line
// say why (tool.ts). The runner's folder is made only when the sandbox works, and goes when the runner stops or the
// session ends. The runner is started from a timer, so its life is the hooks module's and not the life of the hook
// that first needed it: it ends when the session ends or the module reloads, or when the conversation changes
// (/clear), whose cards a new runner reads.
import type { EngineInterface } from 'claude-code'

import { failNotice, noticeLine } from '../bar/notice'
import { tempDir, thimbleHome } from '../core/home'
import { runDir, shortHash } from '../core/layout.mjs'
import { sessionKey } from '../hooks/conversation'
import { runnerArgv } from './argv.mjs'
import { cardsDir } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type Sandbox = { ok: boolean; node: string; srt: string; platform: string; why: string; fix: string }
/** Why the runner cannot start; `machine` when the fix is the machine's (a package, a setting), not thimble's. */
type Down = { why: string; machine?: boolean }
const downOf = (s: Sandbox): Down => ({ why: sandboxWhy(s), machine: !!s.fix })

// how long the runner may take to answer at its start (about 0.3 s): the waits between tries count in the hook's own
// 10 s, which must leave time to say why it did not start
const START_MS = 5000
// npm installs srt the first time: seconds, longer on a slow network
const SETUP_MS = 300000
const SOCKET_MAX = 100
const runner = { up: false, starting: null as Promise<Down | null> | null, exit: '', sock: '', stop: null as null | (() => void), current: null as object | null }
let works: Sandbox | null = null

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

/** The sandbox the runner runs in, kept once it works; one that does not work yet is asked again at the next card, so
 *  cards draw as soon as the person fixed it, with no new session. */
export async function sandbox($: Engine): Promise<Sandbox> {
  if (works) return works
  const s = await setup($).catch(err => ({ ok: false, node: '', srt: '', platform: '', why: String((err as Error)?.message || err), fix: '' }))
  if (s.ok) works = s
  return s
}

/** Why the sandbox does not work, and its fix. */
export const sandboxWhy = (s: Pick<Sandbox, 'why' | 'fix'>) => `cards run only in Anthropic's sandbox runtime, which cannot start here: ${String(s.why).replace(/\.$/, '')}${s.fix ? `. ${s.fix.replace(/\.$/, '')}` : ''}`

/** The line above the prompt when cards cannot draw: a notice with no keys when the fix is the machine's (a package to
 *  install, a setting: `f fix this` would hand Claude a fix that needs the person's sudo), else a failure line, which
 *  the person can report. */
export function sandboxNotice($: Engine, text: string, machine: boolean): void {
  if (machine) noticeLine($, text, 'sandbox')
  else failNotice($, text, 'sandbox')
}

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
  for (const dir of dirs) {
    const sock = `${dir}/${name}/cards.sock`
    if (sock.length > SOCKET_MAX) continue
    if (!(await ownFolder($, sock))) continue
    found.set(id, sock)
    return { sock }
  }
  return { error: `no folder this user owns has a path short enough for the card runner's socket (tried ${dirs.join(', ')})` }
}

const folderOf = (sock: string) => sock.slice(0, sock.lastIndexOf('/'))

/** Make the socket's folder and the one it is in, each with mode 700, a folder this user owns and no link: whether
 *  they are. A runner that stopped took its folder with it, so a new one makes it again. */
async function ownFolder($: Engine, sock: string): Promise<boolean> {
  const run = folderOf(sock)
  const own = 'for d in "$1" "$2"; do mkdir -p -m 700 "$d" && test ! -L "$d" && test -d "$d" && test -O "$d" && chmod 700 "$d" || exit 1; done'
  return (await $.process.run(['sh', '-c', own, 'sh', folderOf(run), run])).exitCode === 0
}

/** Remove the runner's folder (its socket), when no other runner uses it. */
async function removeFolder($: Engine, sock: string): Promise<void> {
  await $.process.run(['rm', '-rf', '--', folderOf(sock)]).catch(() => undefined)
}

/** How Claude Code words a `$.http.fetch` it refuses; the rest of the line is why. */
const REFUSED = /\$\.http\.fetch: refused: (.+)/

async function post($: Engine, sock: string, op: string, body: unknown): Promise<Any> {
  const r = await $.http.fetch(`http://runner/${op}`, { method: 'POST', body: JSON.stringify(body ?? {}), socketPath: sock })
  return JSON.parse(r.text)
}

/** Start the runner in the sandbox and wait until it answers; null when it answers, else why it did not. */
async function start($: Engine, sock: string): Promise<Down | null> {
  const s = await sandbox($)
  if (!s.ok) return downOf(s)
  if (!(await ownFolder($, sock))) return { why: `thimble could not make the card runner's folder ${folderOf(sock)}` }
  const cards = await cardsDir($)
  const made = await $.process.run(['mkdir', '-p', '-m', '700', cards])
  if (made.exitCode !== 0) return { why: `thimble could not make its folder ${cards} (${String(made.stderr).trim().slice(0, 160)})` }
  runner.exit = ''
  runner.stop?.()
  // a runner of another conversation (/clear) takes its folder with it
  if (runner.sock && runner.sock !== sock) await removeFolder($, runner.sock)
  runner.sock = sock
  const argv = runnerArgv({
    plugin: $.plugin.root, node: s.node, srt: s.srt, platform: s.platform, cards, run: folderOf(sock), sock,
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
      // its folder goes with it; a runner started after it (current) makes the folder again
      await removeFolder($, sock)
    })()
  })
  const t0 = Number(await $.clock.now())
  let refused = ''
  while (Number(await $.clock.now()) - t0 < START_MS) {
    try {
      if ((await post($, sock, 'ping', {})).ok) return null
    } catch (err) {
      // not listening yet; or Claude Code refuses the plugin's requests (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
      // refuses a Unix socket's too), which no wait changes
      refused = REFUSED.exec(String((err as Error)?.message || err))?.[1]?.trim() ?? ''
      if (refused) break
    }
    if (runner.exit) break
    await $.clock.sleep(20)
  }
  runner.stop?.()
  if (refused) return { why: `Claude Code refuses thimble's requests to its card runner in this session: ${refused}`, machine: true }
  // what kept it from starting: setup.mjs starts a runner of its own in the sandbox, and says why that one does not start
  const probed = await setup($, true)
  if (!probed.ok) return downOf(probed)
  const why = runner.exit.split('\n').filter(l => l.trim()).slice(-2).join(' ').slice(0, 300)
  return { why: `the card runner did not start in its sandbox${why ? ` (${why})` : ''}` }
}

/** The session ends: the runner stops, and its folder goes. */
export async function stopRunner($: Engine): Promise<void> {
  const sock = runner.sock
  if (!sock) return
  runner.current = null
  runner.up = false
  runner.stop?.()
  runner.stop = null
  await removeFolder($, sock)
}

/** The answer when the runner stopped while it answered this request. */
function stopped(): Any {
  runner.up = false
  return { ok: false, error: `the card stopped the card runner${runner.exit ? ` (${runner.exit.slice(0, 200)})` : ''}, most likely by using too much memory: draw fewer rows or elements` }
}

/** One request to the runner, starting it when it is not there. */
export async function ask($: Engine, op: string, body: unknown): Promise<Any> {
  if (!runner.up) {
    // no folder, and no runner, while the sandbox does not work
    const s = await sandbox($)
    if (!s.ok) return { ok: false, error: sandboxWhy(s), down: true, machine: !!s.fix }
  }
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
  const down = await runner.starting
  if (down) return { ok: false, error: down.why, down: true, machine: !!down.machine }
  runner.up = true
  // also a runner another load of the module started: its folder goes at the session's end
  runner.sock = sock
  try {
    return await post($, sock, op, body)
  } catch {
    return stopped()
  }
}
