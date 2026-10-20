// thread.ts: side threads (CONTRACT 6). Whatever opens in the side panel is a thread (side.ts): a card's detail, a
// citation or an explainer, the thread list, any pane of thimble's. The person asks it in the panel's input bar; it
// answers about the part they selected, with turns of its own, and can query the data with `thimble`. Main's
// conversation reads each question in one row (engaged.ts), and no answer unless the person sends it there (`m` in the
// panel).
//
// The mechanism: one subagent of the session per thread, started by this module with $.agent.spawn, no turn of main.
//   - It is the lightest thing that can query the data. $.model.complete and $.model.fork have no tools; a loop of our
//     own around them would run Bash on the model's behalf, outside Claude Code's permission checks. A subagent's Bash
//     calls go through the same checks as main's: Manual mode asks, auto mode classifies.
//   - Its type is registered once, on the first question (`thimble:thread`: a short system prompt, Bash, Read,
//     Grep and Glob, no CLAUDE.md), and is offered to no model except while a thread is asked or the panel is open,
//     since Claude Code checks the offer again when it resumes an agent. So main's agent listing does not name it.
//   - Its end never reaches main. It runs as a fork of main (subagentType 'fork', with the thread's instructions and the
//     question as its directive): a fork ends quietly, with no hand-back and no task notification in main's queue, so
//     main's transcript shows no row for it. Where no fork starts, the thread's own type runs, and its hand-back (auto
//     mode) and task notifications are dropped as they enter main's queue (Claude Code then shows a row saying so).
//   - A later question asked while the agent still works joins its run ($.session.send). Once the agent has ended, a
//     later question starts a new fork, told the thread's earlier turns: Claude Code resumes an ended agent in the
//     background, and the resumed run's end reaches main as a task notification. The answers show in the panel, under
//     what the thread is on, never in the main column.
//   - It is written to <root>/thimble/threads/<session>/<id>.json at each turn, which the browser reads:
//     {id, session, scope, title (its first question, short), at, turns: [{role: 'person' | 'claude', text, at}], ...}
//     with the agent, the status, the card's title, the questions as asked, and its anchor (what to open to show it
//     again: a card, or a pane with its arguments) beside them. The cards its agent saved are kept with the question
//     they answer, and drawn under that answer.
//   - The part the person has selected now is kept in threads/<session>/sel/<id>.json, which the agent reads for a
//     message that names no part.
//   - The bar above the prompt (shell.tsx) counts the session's threads, again at each change; `t` or a click on the
//     count lists them (side.ts), and opening one shows its panel again with its conversation.
// The plugin's server never starts `claude`; nothing here runs unless the person asked a question.
import type { EngineInterface, Register } from 'claude-code'

import { recount } from './shell'
import { promptText } from '../prompts/prompts'
import { claimAgent } from '../telemetry/telemetry'
import { aboutOf, firstMessage, forkDirective, nameOf, nextMessage, ownReport, samePart, threadKey, toMain, turnsOf } from './threads.js'
import { sessionKey } from '../hooks/conversation'
import { tellAsked } from './engaged'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type Scope = { object?: string; v?: number | null; region?: string | null; label?: string; row?: string; mark?: { kind?: string; ref?: string; gloss?: string; label?: string; term?: string }; pane?: string; key?: string; title?: string }
export type CardRef = { id: string; v: number | null; root: string }
/** What to open to show a thread again: a card's detail (on a part), or a pane of thimble's with its arguments. */
export type Anchor = { kind: 'card'; id: string; v: number | null; root: string; region?: string | null } | { kind: 'pane'; pane: string; args: Record<string, unknown>; title?: string }
export type Ask = { text: string; scope: Scope; refs?: string[]; root?: string; card?: { id: string; v: number | null; title?: string; file?: string } | null; anchor?: Anchor | null; about?: string }
export type Turn = { role: 'person' | 'claude'; text: string; at: string; calls?: string[]; about?: string; cards?: CardRef[] }
export type Thread = {
  id: string; key: string; session: string; agentId: string | null; scope: Scope; title: string; card: string; root: string
  status: 'asking' | 'running' | 'done' | 'failed'
  asks: { text: string; scope: Scope; sent: string; at: string; refs?: string[]; cards?: CardRef[] }[]
  turns: Turn[]
  anchor?: Anchor | null
  info?: { card?: Ask['card']; about?: string }
  error?: string; at: string
}
/** A thread as a pane reads it (the thread list, the panel's conversation). */
export type ThreadRow = { key: string; name: string; scope: Scope; status: string; asks: number; at: string; anchor: Anchor | null; turns: { role: string; text: string; about?: string; calls?: string[]; cards?: CardRef[] }[]; error?: string }

export const TYPE = 'thimble:thread'
const THREAD = { plugin: 'thimble', key: 'thread' } as const
const EARLIER_CHARS = 3000

// the module's memory: the threads of this session by key, and which agent is whose
const threads = new Map<string, Thread>()
const byAgent = new Map<string, string>()
let registered = false
let promptId: string | null = null
// how many asks are in flight, and whether the detail is open: the type is offered only then
let inFlight = 0
let windowOpen = false
// while a thread answers, its turns are read again every few seconds, so its steps show as they come
let poll: { cancel: () => void } | null = null

/** This session's side threads, as a pane reads them, the newest first: key, name, scope, status, the questions asked,
 *  the anchor, the turns and the error. */
export function threadList(): ThreadRow[] {
  return [...threads.values()]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map(t => ({ key: t.key, name: nameOf(t), scope: t.scope, status: t.status, asks: t.asks.length, at: t.at, anchor: t.anchor ?? null, turns: t.turns.map(x => ({ role: x.role, text: x.text, ...(x.about ? { about: x.about } : {}), ...(x.calls?.length ? { calls: x.calls } : {}), ...(x.cards?.length ? { cards: x.cards } : {}) })), ...(t.error ? { error: t.error } : {}) }))
}

/** How many side threads this session has. */
export function threadCount(): number {
  return threads.size
}

/** The side panel tells the module when it opens and closes: while it is open a thread can be resumed. */
export function setThreadWindow(open: boolean): void {
  windowOpen = open
}

// the folders whose threads this module has read back (a reload of the module, or a resumed session, keeps the files)
const restored = new Set<string>()

/** This session's threads, read back from their files once per folder: after a reload of the hooks module the agents'
 *  reports must still be told from main's own, and the detail must still show each card's thread. */
export async function restoreThreads($: Engine, root?: string): Promise<void> {
  const where = (root || String(await $.session.cwd())).replace(/\/+$/, '')
  const session = await sessionKey($)
  const dir = `${where}/thimble/threads/${session.replace(/[^A-Za-z0-9_-]/g, '-')}`
  if (restored.has(dir)) return
  restored.add(dir)
  let names: string[] = []
  try { names = (await $.fs.list(dir)).filter(x => x.name.endsWith('.json')).map(x => x.name) } catch { names = [] }
  let got = 0
  for (const n of names) {
    try {
      const t = JSON.parse(String(await $.fs.read(`${dir}/${n}`))) as Thread
      if (!t?.key || threads.has(t.key)) continue
      threads.set(t.key, t)
      if (t.agentId) byAgent.set(t.agentId, t.key)
      got++
    } catch {
      // a file being written: the next question writes it whole again
    }
  }
  // the bar counts them
  if (got) $.clock.after(0, () => { void recount($) })
}

export function threadOf(key: string): Thread | null {
  return threads.get(key) ?? null
}

export function threadFor(scope: Scope): Thread | null {
  return threads.get(threadKey(scope)) ?? null
}

const dirOf = (t: Thread) => `${t.root.replace(/\/+$/, '')}/thimble/threads/${t.session.replace(/[^A-Za-z0-9_-]/g, '-')}`

async function keep($: Engine, t: Thread): Promise<void> {
  t.at = new Date().toISOString()
  threads.set(t.key, t)
  if (t.agentId) byAgent.set(t.agentId, t.key)
  await $.state.set({ ...THREAD, id: t.key }, { ...t })
  try {
    await $.fs.write(`${dirOf(t)}/${t.id}.json`, JSON.stringify(t, null, 1))
  } catch {
    // the browser misses this thread; the terminal draws it from $.state
  }
  // the bar counts the threads
  $.clock.after(0, () => { void recount($) })
  $.ui.invalidate('ui.render')
}

/** The part the person has selected now, for the thread's agent: a message typed in its own view names no part. */
export async function noteSelection($: Engine, key: string, sel: { region: string; label: string; refs: string[] }): Promise<void> {
  const t = threads.get(key)
  if (!t) return
  try {
    await $.fs.write(`${dirOf(t)}/sel/${t.id}.json`, JSON.stringify({ ...sel, ...(t.scope.object ? { card: t.scope.object } : { pane: t.scope.pane ?? null }), at: new Date().toISOString() }, null, 1))
  } catch {
    // the agent reads the part of the last question instead
  }
}

/** The thread's turns as the person reads them: each question they asked, with its part, in place of the prompt the
 *  agent got; a message they typed in the agent's own view as it is. A resumed agent's transcript may begin where it
 *  was resumed, or a new agent's where it started again: the turns before the first question it holds are kept as the
 *  thread had them. */
function display(t: Thread, turns: { role: 'person' | 'claude'; text: string; calls?: string[] }[]): Turn[] {
  let a = 0
  let first = -1
  const now = new Date().toISOString()
  const matches = (x: { text: string }, ask: Thread['asks'][number]) => x.text === ask.sent || (!!ask.sent && x.text.endsWith(ask.sent)) || x.text.startsWith(ask.text.trim())
  const fresh: Turn[] = turns.map((x, i) => {
    const at = t.turns[i]?.at ?? now
    if (x.role !== 'person') {
      // the cards its agent saved while it answered the question before
      const cards = t.asks[a - 1]?.cards
      return { ...x, at, ...(cards?.length ? { cards } : {}) }
    }
    let j = a
    while (j < t.asks.length && !matches(x, t.asks[j]!)) j++
    if (j < t.asks.length) {
      const ask = t.asks[j]!
      if (first < 0) first = j
      a = j + 1
      return { role: 'person', text: ask.text, about: aboutOf(ask.scope), at: ask.at }
    }
    return { ...x, at }
  })
  if (first <= 0) return fresh
  // the turns before the question the transcript begins with: the thread's own, up to that question's
  let seen = 0
  const upTo = t.turns.findIndex(x => x.role === 'person' && seen++ === first)
  return [...(upTo < 0 ? t.turns : t.turns.slice(0, upTo)), ...fresh]
}

/** A card a thread's agent saved (`thimble save` in its Bash): kept with the question it answers, and drawn under that
 *  answer as a card under a reply is (side.ts). */
export async function noteThreadSaves($: Engine, agentId: string, saves: CardRef[]): Promise<void> {
  const key = byAgent.get(agentId)
  const t = key ? threads.get(key) : null
  if (!t || !t.asks.length || !saves.length) return
  const asks = t.asks.slice()
  const last = asks[asks.length - 1]!
  const cards = [...(last.cards ?? []).filter(c => !saves.some(x => x.id === c.id && x.root === c.root)), ...saves.map(x => ({ id: x.id, v: x.v ?? null, root: x.root }))]
  asks[asks.length - 1] = { ...last, cards }
  const turns = t.turns.slice()
  const answer = turns.length && turns[turns.length - 1]!.role === 'claude' ? turns.length - 1 : -1
  if (answer >= 0) turns[answer] = { ...turns[answer]!, cards }
  await keep($, { ...t, asks, turns })
}

async function ensureType($: Engine): Promise<string | null> {
  if (registered) return null
  try {
    // its instructions: the registry's thread prompt (prompts/thread/)
    const p = await promptText($, 'thread')
    promptId = p.id
    await $.agent.register({
      name: 'thread',
      description: "Answers the analyst's questions about one part of a card, in a side thread of the thimble plugin. Only the plugin starts it.",
      prompt: p.text,
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
 * Ask a side thread: the side panel's input bar, a card's own ask, the browser page's question. A first question
 * starts the thread's agent; a later one resumes it, naming its part again when the part changed. Never throws: a
 * question that cannot be asked comes back with `problem`, which the caller shows in one line with its fix.
 */
export async function askThread($: Engine, ask: Ask): Promise<{ thread: Thread | null; problem?: string }> {
  const text = String(ask.text || '').trim()
  if (!text) return { thread: null, problem: 'an empty question' }
  const scope = ask.scope || {}
  const key = threadKey(scope)
  const root = ask.root || threads.get(key)?.root || String(await $.session.cwd())
  await restoreThreads($, root)
  inFlight++
  try {
    const bad = await ensureType($)
    if (bad) return { thread: null, problem: `the side thread could not start (${bad}); ask Claude here instead` }
    const now = new Date().toISOString()
    const session = await sessionKey($)
    const title = text.replace(/\s+/g, ' ').slice(0, 60)
    let t: Thread = threads.get(key) ?? { id: key, key, session, agentId: null, scope, title, card: ask.card?.title || '', root, status: 'asking', asks: [], turns: [], at: now }
    // what it is on, to open it again from the list, and what its agent is told when it starts again
    if (ask.anchor) t = { ...t, anchor: ask.anchor }
    if (ask.card || ask.about) t = { ...t, info: { card: ask.card ?? t.info?.card ?? null, about: ask.about ?? t.info?.about ?? '' } }
    const last = t.asks.at(-1)?.scope ?? null
    let sent = ''
    let delivered = false
    if (t.agentId && await stillWorking($, t)) {
      sent = nextMessage({ text, scope, last })
      const r = await $.session.send({ to: { agentId: t.agentId }, text: sent }).catch((err: unknown) => ({ isDelivered: false, reason: String((err as Error)?.message || err) }))
      delivered = !!(r as Any)?.isDelivered
    }
    if (!delivered) {
      // a first question, or a thread whose agent has ended: a new agent, told the earlier turns
      const earlier = t.turns.map(x => `${x.role === 'person' ? 'Q' : 'A'}: ${x.text}`).join('\n').slice(-EARLIER_CHARS)
      const refs = ask.refs ?? t.asks.at(-1)?.refs ?? (scope.mark?.ref ? [scope.mark.ref] : [])
      const selFile = scope.object || scope.pane ? `${dirOf(t)}/sel/${t.id}.json` : ''
      sent = firstMessage({ text, scope, card: ask.card || t.info?.card || null, refs, root, selFile, about: ask.about || t.info?.about || '' }) + (earlier ? `\n\nEarlier in this thread:\n${earlier}` : '')
      const description = `thread · ${aboutOf(scope)}`.slice(0, 60)
      const spawn = (subagentType: string, prompt: string) => $.agent.spawn({ subagentType, prompt, description, cwd: root } as Any).catch((err: unknown) => ({ deny: String((err as Error)?.message || err) }))
      // a fork first (it ends quietly: nothing of it reaches main's transcript), else the thread's own type
      const guide = await promptText($, 'thread').catch(() => null)
      let r = await spawn('fork', forkDirective(guide?.text ?? '', sent))
      if ((r as Any)?.deny || !(r as Any)?.model) r = await spawn(TYPE, sent)
      if ((r as Any)?.deny || !(r as Any)?.model) {
        t = { ...t, status: 'failed', error: String((r as Any)?.deny || 'no agent started').slice(0, 300) }
        await keep($, t)
        return { thread: t, problem: `the side thread did not start (${t.error}); ask Claude here instead` }
      }
      if (t.agentId) byAgent.delete(t.agentId)
      // the engine names the agent it started; failing that, the newest agent of the thread's type
      let id = (r as Any).agentId ? String((r as Any).agentId) : null
      if (!id) id = (await $.agent.list().catch(() => [] as Any[])).filter((x: Any) => (x.type === TYPE || x.description === description) && !byAgent.has(x.id)).at(-1)?.id ?? null
      t = { ...t, agentId: id }
      // its turns are filed under the thread in the session's events
      if (id) claimAgent(id, 'thread', promptId)
    }
    t = { ...t, scope, status: 'running', error: undefined, asks: [...t.asks, { text, scope, sent, at: now, ...(ask.refs?.length ? { refs: ask.refs.slice(0, 50) } : {}) }], turns: [...t.turns, { role: 'person', text, about: aboutOf(scope), at: now }] }
    await keep($, t)
    if (scope.region) await noteSelection($, key, { region: scope.region, label: aboutOf(scope), refs: ask.refs || [] })
    follow($)
    // the question, not its answer, reaches main's session: what the analyst asks about is what they care about
    await tellAsked($, { ...ask, text }).catch(() => undefined)
    return { thread: t }
  } finally {
    inFlight--
  }
}

/** Whether the thread's agent is still working, so a message joins its run. An ended agent is not resumed: its resumed
 *  run would end with a task notification in main's queue. */
async function stillWorking($: Engine, t: Thread): Promise<boolean> {
  const a = ((await $.agent.list().catch(() => [])) as Any[]).find(x => x?.id === t.agentId)
  return a ? ['pending', 'running', 'waiting'].includes(String(a.status)) : t.status === 'running'
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
  if (!t || (status === 'running' && t.status !== 'running')) return
  let turns = t.turns
  try {
    const m = await $.session.messages({ agentId, as: 'api' } as Any)
    if (Array.isArray(m)) turns = display(t, turnsOf(m as Any))
  } catch {
    // the turns stay as they were; the status still moves
  }
  await keep($, { ...t, turns, status })
}

/** Read the running threads' turns again every few seconds until none runs: only after a question the person asked. */
function follow($: Engine): void {
  if (poll) return
  poll = $.clock.every(2500, () => {
    const running = [...threads.values()].filter(t => t.status === 'running' && t.agentId)
    if (!running.length) { poll?.cancel(); poll = null; return }
    for (const t of running) void refresh($, t.agentId!, 'running').catch(() => undefined)
  }) as unknown as { cancel: () => void }
}

export function scopesEqual(a: Scope, b: Scope): boolean {
  return samePart(a, b)
}

export const registerThreads: Register = on => {
  // the type is offered only while a thread is asked or the detail is open (a resume checks the offer again)
  on('agent.offer', { agent: TYPE }, async () => ({ isOffered: inFlight > 0 || windowOpen }))

  // a thread's hand-back (auto mode) and its task notifications never enter main's conversation. Claude Code queues
  // them as prompts of its own, and dropping one is the only way to keep it out, which Claude Code shows as one row
  // (each hook has a matcher: a plugin takes one bare hook per event, and the shell has the bare ones)
  on('prompt.submit', { origin: { kind: /^(peer|task-notification)$/ } }, async ($, e, next) => {
    await restoreThreads($)
    const id = ownReport(e.text, [...byAgent.keys()])
    if (!id) return next(e)
    const t = threads.get(byAgent.get(id)!)
    return { drop: `the thread of ${t ? aboutOf(t.scope) : 'a card'} answered` }
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
      await restoreThreads($)
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
  restored.clear()
  registered = false
  promptId = null
  inFlight = 0
  windowOpen = false
  poll?.cancel()
  poll = null
}
