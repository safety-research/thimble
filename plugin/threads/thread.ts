// thread.ts: side threads (0.10's shell/thread.ts). What the side pane shows has a thread: a citation's evidence, a
// label, coverage, the claims (core/pane.ts draws the thread under those panes), and a card or an explainer the tray's
// `a` asks about (the pane `thread`). The person asks it in the pane's input bar; it answers about that thing, with
// turns of its own, and can read and compute over the data. Main reads each question in one line (core/engaged.ts),
// and no answer unless the person sends it there (m in the pane).
//
// The mechanism: one fork of main per thread (core/forks.ts spawnFork, kind `thread`), started inside the hook of the
// person's ↵, no turn of main.
//   - A fork has main's conversation as context and main's tools (Bash, Read, the card tool), and its calls go through
//     the same permission checks as main's: Manual mode asks, auto mode classifies.
//   - Its end never reaches main: its task notification or hand-back is dropped (core/forks.ts). Where no fork starts,
//     the thread's own agent type runs (`thimble:thread`: the thread prompt, Bash, Read, Grep and Glob, no CLAUDE.md),
//     registered on the first question and offered to no model except while a question is asked, since Claude Code
//     checks the offer again when it resumes an agent; its reports are dropped as a fork's are.
//   - A later question asked while the fork still works joins its run ($.session.send). Once it has ended, a later
//     question starts a new fork, told the thread's earlier turns: Claude Code resumes an ended agent in the
//     background, and the resumed run's end would reach main as a task notification.
//   - Each thread is kept in the conversation's kept folder, `<kept>/threads/<id>.json` (core/env.ts), at each turn:
//     {id, key, agentId, scope, subject, root, status, asks: [{text, scope, sent, at, cards}], turns: [{role: 'person'
//     | 'claude', text, at, about?, calls?, cards?}], error?, at}. A resumed session reads them back.
//   - The cards its fork draws (the card tool) are kept with the question they answer, and drawn under that answer in
//     the pane (threadCardAnchor: cards/tool.ts anchors them at `thread:<key>`).
//   - The bar counts the session's threads (`t 2 threads`); t or a click on the count lists them (pane `threads`), and
//     opening one shows it again with its conversation.
// Nothing here runs unless the person asked a question.
import type { EngineInterface, Register } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { failNotice, noticeLine } from '../bar/notice'
import { cardText } from '../cards/draw'
import { metaOf } from '../cards/store'
import { partOf } from '../core/answers'
import { tellAsked } from '../core/engaged'
import { readKept, rootHere, startDir, writeKept, keptDir } from '../core/env'
import { forkOf, spawnFork } from '../core/forks'
import { openPane, paneNow } from '../core/pane'
import { tellAtNextPrompt } from '../core/tell'
import { rowMarks } from '../marks/store'
import { promptText } from '../prompts/prompts'
import type { ThreadScope } from './seam'
import { aboutOf, display, firstMessage, forkDirective, nextMessage, sentNote, shownAbout, subjectOf, threadKey, turnsOf } from './threads.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type Turn = { role: 'person' | 'claude'; text: string; at: string; about?: string; calls?: string[]; cards?: string[] }
export type Ask = { text: string; scope: ThreadScope; sent: string; at: string; cards?: string[] }
export type Thread = {
  id: string; key: string; agentId: string | null; scope: ThreadScope; subject: string; root: string
  status: 'running' | 'done' | 'failed'; asks: Ask[]; turns: Turn[]; sent?: number; error?: string; at: string
}

export const TYPE = 'thimble:thread'
const THREAD = { plugin: 'thimble', key: 'thread' } as const
const GEN = { plugin: 'thimble', key: 'threadsGen' } as const
const EARLIER_CHARS = 3000
const DETAIL_CHARS = 3000

// the module's memory: this conversation's threads by key, and which agent is whose
const threads = new Map<string, Thread>()
const byAgent = new Map<string, string>()
// the threads whose question is on its way, so a second ↵ before the fork started asks nothing more
const sending = new Set<string>()
let registered = false
// how many questions are being asked: the thread's own type is offered only then
let inFlight = 0
// while a thread answers, its turns are read again every few seconds, so its steps show as they come
let poll: (() => void) | null = null
let restoredFor = ''

/** This conversation's side threads that were asked, the newest first (a thread opened with no question yet is
 *  not listed). */
export function threadList(): Thread[] {
  return [...threads.values()].filter(t => t.asks.length).sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

export function threadCount(): number {
  return threadList().length
}

export function threadOf(key: string): Thread | null {
  return threads.get(key) ?? null
}

export function threadFor(scope: ThreadScope): Thread | null {
  return threads.get(threadKey(scope)) ?? null
}

/** Whether a question of this thread is on its way to its fork now. */
export function isSending(key: string): boolean {
  return sending.has(key)
}

/** This conversation's threads, read back from its kept folder once per conversation (a resumed session, a reload of
 *  the hooks module). */
export async function restoreThreads($: Engine): Promise<void> {
  const dir = `${await keptDir($)}/threads`
  if (restoredFor === dir) return
  restoredFor = dir
  let names: string[] = []
  try { names = ((await $.fs.list(dir)) as { name: string }[]).map(x => x.name).filter(n => n.endsWith('.json')) } catch { names = [] }
  let got = 0
  for (const n of names) {
    const t = await readKept<Thread>($, `threads/${n}`)
    if (!t?.key || threads.has(t.key)) continue
    // a thread left answering when its session ended answers no more
    threads.set(t.key, t.status === 'running' ? { ...t, status: 'failed', error: 'the session ended before the thread answered' } : t)
    if (t.agentId) byAgent.set(t.agentId, t.key)
    got++
  }
  if (got) await bump($)
}

/** The list and the bar draw again. */
// when the count of threads last changed: the bar's count is bold for a moment after, as in 0.10
const BRIGHT_MS = 1600
let lastCount = -1
let brightAt = 0

async function bump($: Engine): Promise<void> {
  const n = threadCount()
  if (lastCount >= 0 && n !== lastCount) {
    brightAt = Date.now()
    $.clock.after(BRIGHT_MS + 50, () => { void (async () => { await $.state.set(GEN, Date.now()) })().catch(() => undefined) })
  }
  lastCount = n
  try { await $.state.set(GEN, Date.now()) } catch { /* drawn at the next change */ }
  $.ui.invalidate('ui.render')
}

/** Whether the bar's count is bold now: for a moment after it changed. */
export function threadsBright(): boolean {
  return Date.now() - brightAt < BRIGHT_MS
}

async function keep($: Engine, t: Thread): Promise<void> {
  t.at = new Date().toISOString()
  threads.set(t.key, t)
  if (t.agentId) byAgent.set(t.agentId, t.key)
  try { await $.state.set({ ...THREAD, id: t.key }, { ...t }) } catch { /* drawn from the module's memory */ }
  await writeKept($, `threads/${t.id}.json`, t).catch(() => undefined)
  await bump($)
}

/** The folder of the data, for the fork's first message. */
async function rootOf($: Engine): Promise<string> {
  return (await rootHere($).catch(() => null)) || (await startDir($).catch(() => '')) || String(await $.session.cwd())
}

const cutChars = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…` : s)

/** What the thing a question is about holds, in lines for the fork: a citation's sentence, its check and its
 *  evidence; an explainer's words; a card's text as it draws now; a pane's arguments. */
async function detailOf($: Engine, scope: ThreadScope): Promise<string> {
  const lines: string[] = []
  const m = scope.mark ?? (scope.pane?.kind === 'evidence' ? { row: String((scope.pane.args as Any)?.row ?? ''), kind: 'citation' as const, n: Number((scope.pane.args as Any)?.n) } : null)
  if (m && m.kind === 'citation') {
    const it = (await rowMarks($, m.row).catch(() => null))?.items.find(x => x.n === m.n)
    if (it) {
      lines.push(`Its sentence: "${it.sentence.replace(/\s+/g, ' ').trim()}"`)
      lines.push(`thimble's check: ${it.status}${it.reason ? ` (${it.reason})` : ''}${it.status === 'corrected' && it.shown ? `; the analyst reads "${it.shown}"` : ''}.`)
      const ev = it.evidence as Any
      if (ev?.kind === 'computed') lines.push(`Its evidence, code that was run:\n${cutChars(String(ev.code), 1200)}\nIt printed:\n${cutChars(String(ev.output), 1200)}`)
      else if (ev?.file) lines.push(`Its evidence: ${ev.file}:${ev.line}${(ev.more ?? []).length ? ` and ${(ev.more as Any[]).map(x => `${x.file}:${x.line}`).join(', ')}` : ''}.`)
    }
  } else if (m) {
    const g = (await partOf<Any>($, m.row, 'explain').catch(() => null))?.items?.[m.id]
    if (g) {
      if (g.title) lines.push(`thimble's heads-up: ${g.title}`)
      if (g.body) lines.push(`What thimble said of it: ${g.body}`)
      if (g.here) lines.push(`Where it mattered here: ${g.here}`)
      for (const b of (g.bullets ?? []) as string[]) lines.push(`- ${b}`)
    }
  }
  if (scope.card) {
    const text = await cardText($, scope.card).catch(() => '')
    if (text.trim()) lines.push(`What the card draws now, as text:\n${cutChars(text, DETAIL_CHARS)}`)
  }
  if (scope.pane && scope.pane.kind !== 'evidence') {
    const a = (scope.pane.args ?? {}) as Record<string, unknown>
    const shown = Object.entries(a).filter(([, v]) => v != null && v !== '' && typeof v !== 'object').map(([k, v]) => `${k} ${v}`)
    if (shown.length) lines.push(`The panel shows: ${shown.join(', ')}.`)
  }
  return lines.join('\n')
}

/** The thread's own agent type, registered once: where no fork starts. Null when it is ready, else why not. */
async function ensureType($: Engine, prompt: string): Promise<string | null> {
  if (registered) return null
  try {
    await $.agent.register({
      name: 'thread',
      description: "Answers the analyst's questions about one thing on their screen, in a side thread of the thimble plugin. Only the plugin starts it.",
      prompt,
      tools: ['Bash', 'Read', 'Grep', 'Glob'],
      omitClaudeMd: true,
    } as Any)
    registered = true
    return null
  } catch (err) {
    return String((err as Error)?.message || err).slice(0, 240)
  }
}

/**
 * Ask a side thread: the pane's input bar. A first question starts the thread's fork; a later one joins its run while
 * it works, else starts a new fork told the earlier turns. Never throws: a question that cannot be asked comes back
 * with `problem`, which the caller shows in one line with its fix.
 */
export async function askThread($: Engine, ask: { text: string; scope: ThreadScope }): Promise<{ thread: Thread | null; problem?: string }> {
  const text = String(ask.text || '').trim()
  if (!text) return { thread: null, problem: 'an empty question' }
  const scope = ask.scope
  const key = threadKey(scope)
  if (sending.has(key)) return { thread: threads.get(key) ?? null }
  sending.add(key)
  if (askNext === key) askNext = null
  inFlight++
  try {
    await restoreThreads($)
    const now = new Date().toISOString()
    const root = threads.get(key)?.root || (await rootOf($))
    let t: Thread = threads.get(key) ?? { id: key, key, agentId: null, scope, subject: aboutOf(scope), root, status: 'done', asks: [], turns: [], at: now }
    const last = t.asks.at(-1)?.scope ?? null
    // the thread as it was before this question, which a new fork is told
    const was = t
    // the question is in the thread at once, and the thread is listed as answering, while its fork starts
    t = { ...t, scope, status: 'running', error: undefined, asks: [...was.asks, { text, scope, sent: '', at: now }], turns: [...was.turns, { role: 'person', text, about: shownAbout(scope), at: now }] }
    await keep($, t)
    let sent = ''
    let delivered = false
    if (was.agentId && await stillWorking($, was)) {
      sent = nextMessage({ text, scope, last })
      const r = await $.session.send({ to: { agentId: was.agentId }, text: sent } as Any).catch((err: unknown) => ({ isDelivered: false, reason: String((err as Error)?.message || err) }))
      delivered = !!(r as Any)?.isDelivered
    }
    if (!delivered) {
      // a first question, or a thread whose fork has ended: a new fork, told the earlier turns
      const earlier = was.turns.map(x => `${x.role === 'person' ? 'Q' : 'A'}: ${x.text}`).join('\n').slice(-EARLIER_CHARS)
      sent = firstMessage({ text, scope, detail: await detailOf($, scope), root }) + (earlier ? `\n\nEarlier in this thread:\n${earlier}` : '')
      const description = `thread · ${aboutOf(scope)}`.slice(0, 60)
      const guide = await promptText($, 'thread').catch(() => '')
      let r = await spawnFork($, { kind: 'thread', prompt: forkDirective(guide, sent), description })
      if (r.deny !== undefined) {
        // where no fork starts, the thread's own type
        const bad = await ensureType($, guide)
        if (!bad) r = await spawnFork($, { kind: 'thread', prompt: sent, description, type: TYPE })
        else r = { deny: `${r.deny}; ${bad}` }
      }
      if (r.deny !== undefined || !r.agentId) {
        t = { ...t, status: 'failed', error: String(r.deny || 'no agent started').slice(0, 300) }
        await keep($, t)
        return { thread: t, problem: `The side thread did not start (${t.error}). Ask Claude at the prompt instead.` }
      }
      if (was.agentId) byAgent.delete(was.agentId)
      t = { ...t, agentId: r.agentId }
    }
    t = { ...t, asks: [...was.asks, { text, scope, sent, at: now }] }
    await keep($, t)
    // the bar shows the answer on its way until the thread's fork ends its turn (busy.ts), by what the thread is on,
    // so two threads at once say which is which
    const on = subjectOf(t).replace(/\s+/g, ' ').trim()
    void busyWhile($, `answering: ${[...on].length > 24 ? `${[...on].slice(0, 23).join('')}…` : on}`, () => threads.get(key)?.status === 'running')
    follow($)
    // the question, not its answer, reaches main: what the analyst asks about is what they care about
    await tellAsked($, { text, about: aboutOf(scope) }).catch(() => undefined)
    return { thread: t }
  } finally {
    sending.delete(key)
    inFlight--
  }
}

/** Whether the thread's fork still works, so a question joins its run. An ended fork is not resumed: its resumed run
 *  would end with a task notification in main's queue. */
async function stillWorking($: Engine, t: Thread): Promise<boolean> {
  const a = ((await $.agent.list().catch(() => [])) as Any[]).find(x => x?.id === t.agentId)
  return a ? ['pending', 'running', 'waiting'].includes(String(a.status)) : t.status === 'running'
}

/** Read the thread's turns again from its fork's transcript. */
async function refresh($: Engine, agentId: string, status: Thread['status']): Promise<void> {
  const key = byAgent.get(agentId)
  const t = key ? threads.get(key) : null
  if (!t || (status === 'running' && t.status !== 'running')) return
  let turns = t.turns
  try {
    const m = await $.session.messages({ agentId, as: 'api' } as Any)
    if (Array.isArray(m)) {
      const got = display(t, turnsOf(m as Any), new Date().toISOString()) as Turn[]
      // a transcript not written yet keeps the question asked
      if (got.length >= t.turns.length || status !== 'running') turns = got.length ? got : t.turns
    }
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
    if (!running.length) { poll?.(); poll = null; return }
    for (const t of running) void refresh($, t.agentId!, 'running').catch(() => undefined)
  }) as unknown as () => void
}

/** A card a thread's fork drew (cards/tool.ts asks): kept with the question it answers, and drawn under that answer.
 *  The anchor the card tool keeps for it, `thread:<key>`, or null when the agent is no thread's. */
export async function threadCardAnchor($: Engine, agentId: string | undefined, cardId: string): Promise<string | null> {
  if (!agentId || forkOf(agentId)?.kind !== 'thread') return null
  const key = byAgent.get(agentId)
  const t = key ? threads.get(key) : null
  if (!t) return null
  if (t.asks.length) {
    const asks = t.asks.slice()
    const last = asks[asks.length - 1]!
    if (!(last.cards ?? []).includes(cardId)) asks[asks.length - 1] = { ...last, cards: [...(last.cards ?? []), cardId] }
    await keep($, { ...t, asks })
  }
  return `thread:${t.key}`
}

/** The cards a thread's fork drew, by the answer they stand under (for the pane). */
export async function cardsOfTurn($: Engine, ids: string[] | undefined): Promise<Any[]> {
  const out: Any[] = []
  for (const id of ids ?? []) { const m = await metaOf($, id).catch(() => null); if (m && m.version > 0) out.push(m) }
  return out
}

/** m in a thread's pane: its last answer goes to main with the person's next prompt. False when it has none. */
export async function sendToMain($: Engine, key: string): Promise<boolean> {
  const t = threads.get(key)
  const note = t ? sentNote(t) : ''
  if (!t || !note) return false
  await tellAtNextPrompt($, `thread:${t.id}`, note)
  await keep($, { ...t, sent: t.turns.length })
  return true
}

/** Where a thread opens again: a pane it was asked under (a citation's evidence, a label, coverage, the claims), else
 *  the pane `thread`. `ask`: the input bar takes the keys. False when Claude Code did not place the pane. */
export async function showThread($: Engine, key: string, o: { from?: string; ask?: boolean } = {}): Promise<boolean> {
  const t = threads.get(key)
  if (!t) return false
  if (o.ask) askNext = key
  const p = t.scope.pane
  if (p && p.kind !== 'thread' && p.kind !== 'threads') return openPane($, p.kind, p.args, paneTitle(p.kind, p.args, t), { focus: true })
  // a citation's thread stands under its evidence
  const m = t.scope.mark
  if (m && m.kind === 'citation') return openPane($, 'evidence', { row: m.row, n: m.n }, paneTitle('evidence', { n: m.n }), { focus: true })
  return openPane($, 'thread', { key, ...(o.from ? { from: o.from } : {}) }, t.subject.slice(0, 60) || 'Side thread', { focus: true })
}

/** The title of a pane a thread opens again: the pane's own. */
export function paneTitle(kind: string, args: unknown, t?: Thread | null): string {
  const a = (args ?? {}) as Record<string, unknown>
  if (kind === 'evidence') return `citation ${a.n ?? ''}`.trim()
  if (kind === 'labels') return a.label ? `Label ${a.label}` : 'Labels'
  if (kind === 'coverage') return 'Coverage'
  if (kind === 'claims') return 'Claims'
  return (t?.subject || kind).slice(0, 60)
}

// the thread whose input bar takes the keys when its pane is drawn next (openThread, the tray's a)
let askNext: string | null = null

/** Whether the input bar of this thread takes the keys when its pane takes them: the thread opened to be asked, until
 *  it is asked or another opens. */
export function takeAskNext(key: string): boolean {
  return askNext === key
}

/** The thread about `scope`: an existing one, or a new one with no turns yet, opened in the side pane, its input bar
 *  taking the keys. */
export async function openThreadOn($: Engine, scope: ThreadScope): Promise<boolean> {
  await restoreThreads($)
  const key = threadKey(scope)
  if (!threads.has(key)) {
    const now = new Date().toISOString()
    // kept in memory only until its first question
    threads.set(key, { id: key, key, agentId: null, scope, subject: aboutOf(scope), root: await rootOf($), status: 'done', asks: [], turns: [], at: now })
  }
  const placed = await showThread($, key, { ask: true })
  if (!placed) {
    pendingKey = key
    noticeLine($, 'Claude Code opens the side pane from a key only in a wider terminal. Type /threads to open it here.', 'pane:threads')
  }
  return placed
}

/** The thread list in the side pane (t, a click on the bar's count, /threads). */
export async function listThreads($: Engine, o: { fromKey?: boolean } = {}): Promise<boolean> {
  await restoreThreads($)
  const placed = await openPane($, 'threads', {}, 'Threads', { focus: true })
  if (!placed && o.fromKey) {
    pendingKey = ''
    noticeLine($, `Claude Code opens the side pane from a key only in a wider terminal. Click “${threadCount() === 1 ? '1 thread' : `${threadCount()} threads`}” in the bar below, or type /threads, to open it here.`, 'pane:threads')
  }
  return placed
}

// what a key could not open (a narrow terminal), which /threads opens: a thread's key, '' for the list
let pendingKey: string | null = null

export const registerThreads: Register = on => {
  // a resumed conversation's threads, so the bar counts them and t lists them; /threads
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try { await restoreThreads($) } catch { /* the next question reads them */ }
    try {
      await $.command.register({ name: 'threads', description: "List this session's side threads in the side pane, or open the one a key could not open", immediate: true })
    } catch {
      // t and the bar's count still list them
    }
    return r
  }).catch(($, e, next) => next(e))

  // /threads: the side pane on what a key could not open there (the terminal too narrow for it then), else the list of
  // the session's side threads. A command's pane is placed at any width.
  on('command.run', { command: 'threads' }, async $ => {
    await restoreThreads($).catch(() => undefined)
    const p = pendingKey
    pendingKey = null
    if (p && threads.has(p)) { await showThread($, p, { ask: true }); return {} }
    if (!threadCount()) return { text: 'No side threads yet.' }
    await listThreads($)
    return {}
  })

  // the thread's own type is offered only while a question is asked (a resume checks the offer again)
  on('agent.offer', { agent: TYPE }, async () => ({ isOffered: inFlight > 0 })).catch(($, e, next) => next(e))

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
      if (!e.agentId || forkOf(e.agentId)?.kind !== 'thread' || !byAgent.has(e.agentId)) return r
      await refresh($, e.agentId, (e as Any).reason === 'error' || (e as Any).isAborted ? 'failed' : 'done')
      const t = threads.get(byAgent.get(e.agentId)!)
      if (t && t.status === 'failed' && !t.error) await keep($, { ...t, error: (e as Any).isAborted ? 'the thread was stopped' : 'the thread ended with an error' })
      if (t && (e as Any).reason === 'refusal') failNotice($, `The model's safeguards refused to answer the side thread about ${t.subject}. Another model may answer it: /model.`, 'thread')
    } catch {
      // the thread shows its last state
    }
    return r
  }).catch(($, e, next) => next(e))
}

/** Whether the side pane shows this thread now (the input bar's pane, or the pane `thread`). */
export async function paneShowsThread($: Engine, key: string): Promise<boolean> {
  const now = await paneNow($)
  return !!now && now.kind === 'thread' && (now.args as Any)?.key === key
}

/** For tests: the module's memory, cleared. */
export function resetThreads(): void {
  lastCount = -1
  brightAt = 0
  threads.clear()
  byAgent.clear()
  sending.clear()
  registered = false
  inFlight = 0
  poll?.()
  poll = null
  restoredFor = ''
  askNext = null
  pendingKey = null
}
