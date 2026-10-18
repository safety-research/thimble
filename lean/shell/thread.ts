// thread.ts: side threads (CONTRACT 6). A thread answers the person's questions about one part of a card, or one mark
// of a message, with turns of its own, and can query the data with `lean`. Main's conversation learns nothing of it
// unless the person sends the result there (`m` in the detail).
//
// The mechanism: one subagent of the session per thread, started by this module with $.agent.spawn, no turn of main.
//   - It is the lightest thing that can query the data. $.model.complete and $.model.fork have no tools; a loop of our
//     own around them would run Bash on the model's behalf, outside Claude Code's permission checks. A subagent's Bash
//     calls go through the same checks as main's: Manual mode asks, auto mode classifies.
//   - Its type is registered once, on the first question (`thimble-lean:thread`: a short system prompt, Bash, Read,
//     Grep and Glob, no CLAUDE.md), and is offered to no model except while a thread is asked or the detail is open,
//     since Claude Code checks the offer again when it resumes an agent. So main's agent listing does not name it.
//   - A later question resumes the same agent ($.session.send), so a thread keeps its context; asked in the terminal,
//     the thread's transcript takes the main view ($.ui.view), and the prompt then writes to it directly.
//   - Its end never reaches main: Claude Code's hand-back of it (auto mode) and its task notifications are dropped as
//     they enter main's queue.
//   - Its turns are written to <root>/thimble/threads/<session>/<key>.json, which the browser page reads.
// The plugin's server never starts `claude`; nothing here runs unless the person asked a question.
import type { EngineInterface, Register } from 'claude-code'

import { aboutOf, firstMessage, nextMessage, ownReport, samePart, threadKey, THREAD_PROMPT, toMain, turnsOf } from './threads.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type Scope = { object?: string; v?: number | null; region?: string | null; label?: string; row?: string; mark?: { kind?: string; ref?: string; gloss?: string; label?: string; term?: string } }
export type Ask = { text: string; scope: Scope; refs?: string[]; root?: string; card?: { id: string; v: number | null; title?: string; file?: string } | null }
export type Thread = {
  key: string; agentId: string | null; scope: Scope; title: string; root: string; status: 'asking' | 'running' | 'done' | 'failed'
  asks: { text: string; scope: Scope; sent: string; at: string }[]
  turns: { role: 'user' | 'assistant'; text: string; calls?: string[]; about?: string }[]
  error?: string; at: string
}

export const TYPE = 'thimble-lean:thread'
const THREAD = { plugin: 'thimble-lean', key: 'thread' } as const
const EARLIER_CHARS = 3000

// the module's memory: the threads of this session by key, and which agent is whose
const threads = new Map<string, Thread>()
const byAgent = new Map<string, string>()
let registered = false
// how many asks are in flight, and whether the detail is open: the type is offered only then
let inFlight = 0
let windowOpen = false

/** The detail tells the module when it opens and closes: while it is open a thread can be resumed from its view. */
export function setThreadWindow(open: boolean): void {
  windowOpen = open
}

export function threadOf(key: string): Thread | null {
  return threads.get(key) ?? null
}

export function threadFor(scope: Scope): Thread | null {
  return threads.get(threadKey(scope)) ?? null
}

async function fileOf($: Engine, t: Thread): Promise<string> {
  return `${t.root.replace(/\/+$/, '')}/thimble/threads/${String(await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '-')}/${t.key}.json`
}

async function keep($: Engine, t: Thread): Promise<void> {
  t.at = new Date().toISOString()
  threads.set(t.key, t)
  if (t.agentId) byAgent.set(t.agentId, t.key)
  await $.state.set({ ...THREAD, id: t.key }, { ...t })
  try {
    await $.fs.write(await fileOf($, t), JSON.stringify(t, null, 1))
  } catch {
    // the browser page misses this thread; the terminal draws it from $.state
  }
  $.ui.invalidate('ui.render')
}

/** The thread's turns as the person reads them: each question they asked, with its part, in place of the prompt the
 *  agent got; a message they typed in the agent's own view as it is. */
function display(t: Thread, turns: { role: 'user' | 'assistant'; text: string; calls?: string[] }[]): Thread['turns'] {
  let a = 0
  return turns.map(x => {
    if (x.role !== 'user') return x
    const ask = t.asks[a]
    if (ask && (x.text === ask.sent || x.text.startsWith(ask.text.trim()))) { a++; return { role: 'user', text: ask.text, about: aboutOf(ask.scope) } }
    return x
  })
}

async function ensureType($: Engine): Promise<string | null> {
  if (registered) return null
  try {
    await $.agent.register({
      name: 'thread',
      description: "Answers the person's questions about one part of a card, in a side thread of the thimble-lean plugin. Only the plugin starts it.",
      prompt: THREAD_PROMPT,
      tools: ['Bash', 'Read', 'Grep', 'Glob'],
      omitClaudeMd: true,
    })
    registered = true
    return null
  } catch (err) {
    return String((err as Error)?.message || err).slice(0, 240)
  }
}

/**
 * Ask a side thread: the tray's `↵ ask`, the detail's prompt, the browser page's question. A first question starts the
 * thread's agent; a later one resumes it, naming its part again when the part changed. `view`: show the thread's
 * transcript in the main view (only while answering the person's own prompt or press). Never throws: a question that
 * cannot be asked comes back with `problem`, which the caller shows in one line with its fix.
 */
export async function askThread($: Engine, ask: Ask, o: { view?: boolean } = {}): Promise<{ thread: Thread | null; problem?: string }> {
  const text = String(ask.text || '').trim()
  if (!text) return { thread: null, problem: 'an empty question' }
  const scope = ask.scope || {}
  const key = threadKey(scope)
  const root = ask.root || threads.get(key)?.root || String(await $.session.cwd())
  inFlight++
  try {
    const bad = await ensureType($)
    if (bad) return { thread: null, problem: `the side thread could not start (${bad}); ask Claude here instead` }
    const now = new Date().toISOString()
    let t: Thread = threads.get(key) ?? { key, agentId: null, scope, title: ask.card?.title || '', root, status: 'asking', asks: [], turns: [], at: now }
    const last = t.asks.at(-1)?.scope ?? null
    let sent = ''
    let delivered = false
    if (t.agentId) {
      sent = nextMessage({ text, scope, last })
      const r = await $.session.send({ to: { agentId: t.agentId }, text: sent }).catch((err: unknown) => ({ isDelivered: false, reason: String((err as Error)?.message || err) }))
      delivered = !!(r as Any)?.isDelivered
    }
    if (!delivered) {
      // a first question, or a thread whose agent is gone: a new agent, told the earlier turns
      const earlier = t.turns.map(x => `${x.role === 'user' ? 'Q' : 'A'}: ${x.text}`).join('\n').slice(-EARLIER_CHARS)
      const refs = ask.refs ?? (scope.mark?.ref ? [scope.mark.ref] : [])
      sent = firstMessage({ text, scope, card: ask.card || null, refs, root }) + (earlier ? `\n\nEarlier in this thread:\n${earlier}` : '')
      const r = await $.agent.spawn({ subagentType: TYPE, prompt: sent, description: `thread · ${aboutOf(scope)}`.slice(0, 60), cwd: root } as Any).catch((err: unknown) => ({ deny: String((err as Error)?.message || err) }))
      if ((r as Any)?.deny || !(r as Any)?.model) {
        t = { ...t, status: 'failed', error: String((r as Any)?.deny || 'no agent started').slice(0, 300) }
        await keep($, t)
        return { thread: t, problem: `the side thread did not start (${t.error}); ask Claude here instead` }
      }
      if (t.agentId) byAgent.delete(t.agentId)
      // the engine names the agent it started; failing that, the newest agent of the thread's type
      let id = (r as Any).agentId ? String((r as Any).agentId) : null
      if (!id) id = (await $.agent.list().catch(() => [] as Any[])).filter((x: Any) => x.type === TYPE && !byAgent.has(x.id)).at(-1)?.id ?? null
      t = { ...t, agentId: id }
    }
    t = { ...t, scope, status: 'running', error: undefined, asks: [...t.asks, { text, scope, sent, at: now }], turns: [...t.turns, { role: 'user', text, about: aboutOf(scope) }] }
    await keep($, t)
    if (o.view && t.agentId) await $.ui.view({ agentId: t.agentId }).catch(() => undefined)
    return { thread: t }
  } finally {
    inFlight--
  }
}

/** The thread's last answer, for main: appended as a row Claude reads with the next prompt (no turn of its own). */
export async function sendToMain($: Engine, key: string): Promise<string> {
  const t = threads.get(key)
  const text = t ? toMain(t) : ''
  if (!text) return 'The thread has no answer yet to send.'
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  return 'Sent the thread’s answer to Claude: it reads it with your next prompt.'
}

/** Read the thread's turns again from its agent's transcript. */
async function refresh($: Engine, agentId: string, status: Thread['status']): Promise<void> {
  const key = byAgent.get(agentId)
  const t = key ? threads.get(key) : null
  if (!t) return
  let turns = t.turns
  try {
    const m = await $.session.messages({ agentId, as: 'api' } as Any)
    if (Array.isArray(m)) turns = display(t, turnsOf(m as Any))
  } catch {
    // the turns stay as they were; the status still moves
  }
  await keep($, { ...t, turns, status })
}

export function scopesEqual(a: Scope, b: Scope): boolean {
  return samePart(a, b)
}

export const registerThreads: Register = on => {
  // the type is offered only while a thread is asked or the detail is open (a resume checks the offer again)
  on('agent.offer', { agent: TYPE }, async () => ({ isOffered: inFlight > 0 || windowOpen }))

  // a thread's hand-back (auto mode) and its task notifications never enter main's conversation
  // (each hook has a matcher: a plugin takes one bare hook per event, and the shell has the bare ones)
  on('prompt.submit', { origin: { kind: /^(peer|task-notification)$/ } }, async ($, e, next) => {
    const id = ownReport(e.text, [...byAgent.keys()])
    if (!id) return next(e)
    const t = threads.get(byAgent.get(id)!)
    return { drop: `the side thread about ${t ? aboutOf(t.scope) : 'a card'} answered there; Claude here does not see it` }
  }).catch(($, e, next) => next(e))

  on('turn.start', { agentId: /./ }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId && byAgent.has(e.agentId)) {
        const t = threads.get(byAgent.get(e.agentId)!)
        if (t && t.status !== 'running') await keep($, { ...t, status: 'running' })
      }
    } catch {
      // the thread shows its last state
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', { agentId: /./ }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId && byAgent.has(e.agentId)) await refresh($, e.agentId, 'done')
    } catch {
      // the thread shows its last state
    }
    return r
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetThreads(): void {
  threads.clear()
  byAgent.clear()
  registered = false
  inFlight = 0
  windowOpen = false
}
