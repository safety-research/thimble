// feed.ts: the kernel's change feed, $THIMBLE_HOME/events/<conversation>.jsonl (core/layout.mjs), one JSON line per change the plugin
// acts on: a `label` whose records wait for the model (labels/labels.ts), a `fix_ask` whose share waits for the person
// (bar/fix.ts). The feed is read after each Bash call (main's or a subagent's), each second while one runs (`thimble label … --prompt … && thimble label … --wait` waits on the
// model's reads, which start from the feed), and at the end of each turn. Lines the kernel wrote before this session
// started are not acted on. The telemetry's lines share the file, and nothing acts on their kinds.
import type { EngineInterface, Register } from 'claude-code'

import { fixAskFromFeed } from '../bar/fix'
import { sessionKey } from '../hooks/conversation'
import { labelFromFeed } from '../labels/labels'
import { thimbleHome } from './home'
import { eventsFile } from './layout.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const READ = { plugin: 'thimble', key: 'feed' } as const
let reading: Promise<void> | null = null

async function feedFile($: Engine): Promise<string> {
  return eventsFile(await thimbleHome($), await sessionKey($))
}

async function size($: Engine, file: string): Promise<number> {
  return $.fs.stat(file).then(x => (x.kind === 'file' ? x.size : 0), () => 0)
}

/** UTF-8 bytes of a text (the feed's offsets are bytes). */
function utf8Bytes(t: string): number {
  let n = 0
  for (const ch of t) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** The feed from byte `from` on: the whole file when that is its start, else only its new bytes (`tail -c`). */
async function tail($: Engine, file: string, from: number): Promise<string> {
  if (from <= 0) return String(await $.fs.read(file))
  const r = await $.process.run(['tail', '-c', `+${from + 1}`, file], { timeoutMs: 10000 })
  if (r.exitCode !== 0) throw new Error(`tail could not read the feed: ${String(r.stderr || '').trim().slice(0, 120)}`)
  return String(r.stdout)
}

async function readOnce($: Engine): Promise<void> {
  const file = await feedFile($)
  const now = await size($, file)
  const was = (await $.state.get(READ)).value as { file: string; bytes: number } | null | undefined
  // a new session (or a feed that shrank) starts from its end: what was written before is not this session's to act on
  if (!was || was.file !== file || now < was.bytes) {
    await $.state.set(READ, { file, bytes: now })
    return
  }
  if (now === was.bytes) return
  const text = await tail($, file, was.bytes)
  // whole lines only: a line being written is read whole by the next read
  const whole = text.slice(0, text.lastIndexOf('\n') + 1)
  await $.state.set(READ, { file, bytes: was.bytes + utf8Bytes(whole) })
  for (const line of whole.split('\n').filter(Boolean)) {
    let ev: Any
    try { ev = JSON.parse(line) } catch { continue }
    try {
      if (ev?.kind === 'label') labelFromFeed($, ev)
      else if (ev?.kind === 'fix_ask') await fixAskFromFeed($, ev)
    } catch {
      // each module says its own failure
    }
  }
}

/** Read what the feed holds since it was last read, one read at a time. */
export function readFeed($: Engine): Promise<void> {
  reading ??= readOnce($).catch(() => undefined).finally(() => { reading = null })
  return reading
}

export const registerFeed: Register = on => {
  on('session.start', { cwd: /^\/.*/ }, async ($, e, next) => {
    const r = await next(e)
    try { await readFeed($) } catch { /* read at the next call */ }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let tick: { cancel?: () => void } | null = null
    try { tick = $.clock.every(1000, () => { void readFeed($) }) as unknown as { cancel?: () => void } } catch { tick = null }
    try {
      return await next(e)
    } finally {
      tick?.cancel?.()
      await readFeed($)
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: /./ }, async ($, e, next) => {
    const r = await next(e)
    await readFeed($)
    return r
  }).catch(($, e, next) => next(e))
}
