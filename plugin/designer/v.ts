// v.ts: the designer step. At an empty prompt, v starts a fork of the conversation in the background (core/forks.ts,
// kind `designer`, with prompts/designer.md). The fork lists a few forms for main's last answer, picks one, draws it
// with the `card` tool and fixes it from the card's text copy. Its cards draw under the answer v was pressed on; the
// busy line says `drawing a card` while it works; its last message never reaches main, but main reads the cards it drew
// with the person's next prompt.
//
// v is a letter too. A letter typed within WORD_MS after v means the person types a word that starts with v ("very"):
// the prompt gets v and that letter back, and no fork starts. The fork is spawned inside v's own prompt.edit hook, so
// Claude Code skips only that hook for the fork and this plugin's other hooks serve it (its card calls, its end). The
// spawn waits out the word window in this module's agent.spawn hook, which runs for the spawn like any other hook, and
// refuses the spawn when a letter came. So a word typed after v starts nothing at all.
//
// v starts a design only when there is an answer to draw (main's last text row, as session.append stored it), main is
// not working, Cards is on, and no other design runs. Otherwise v types as any letter.
//
//   designAnchor(agentId)  the answer row the cards of that designer fork draw under (the card tool asks it)
//   designNow($)           the design that runs now, or null
//
//   state: designs (each design, by key), designNow (the key of the design that runs), answerRow (main's last answer row)
import type { EngineInterface, Register } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { failNotice } from '../bar/fix'
import { WORD_MS } from '../bar/register'
import { cardsUnder, cardText } from '../cards/draw'
import { type CardMeta, metaOf } from '../cards/store'
import { forkOf, spawnFork } from '../core/forks'
import { tellAtNextPrompt } from '../core/tell'
import { promptText } from '../prompts/prompts'
import { featureOn } from '../settings/features.mjs'

type Engine = EngineInterface

export type Design = {
  key: string
  /** the answer row the design draws under */
  anchorRow: string
  agentId: string | null
  /** held: the word window is open; running: the fork works; the rest: it ended */
  status: 'held' | 'running' | 'done' | 'failed' | 'cancelled'
  at: number
  error?: string
  /** the cards the design drew */
  cards: string[]
}

/** The words the fork shows as in /tasks, and how this module's agent.spawn hook knows the spawn as v's. */
const DESCRIPTION = 'card of the last answer (v)'
/** The most of a card's text copy main reads. */
const TELL_CHARS = 3000

const DESIGNS = { plugin: 'thimble', key: 'designs' } as const
const NOW = { plugin: 'thimble', key: 'designNow' } as const
const ANSWER = { plugin: 'thimble', key: 'answerRow' } as const

/** Main's last answer row, and whether main works now. */
let answerRow: string | null = null
let mainWorks = false
/** The design that runs (one at a time). */
let current: Design | null = null
/** The word window of the last v: open until WORD_MS has passed or a letter came. */
let wordWindow: { at: number; cancelled: boolean } | null = null

const cut = (s: string, n: number) => ([...s].length <= n ? s : `${[...s].slice(0, n - 1).join('')}…`)
const firstLine = (s: string) => String(s || '').split('\n').map(l => l.trim()).find(Boolean) || ''
const reason = (err: unknown) => cut(String((err as Error)?.message || err), 200)

async function save($: Engine, d: Design): Promise<void> {
  await $.state.set({ ...DESIGNS, id: d.key }, d)
}

export function designAnchor(agentId: string | undefined): string | null {
  return agentId && current?.agentId === agentId ? current.anchorRow : null
}

export async function designNow($: Engine): Promise<Design | null> {
  const key = (await $.state.get(NOW)).value
  return key ? (((await $.state.get({ ...DESIGNS, id: key })).value ?? null) as Design | null) : null
}

const running = () => current?.status === 'held' || current?.status === 'running'

/** The design's end: its state, the bar, and the failure line when it failed. */
async function end($: Engine, d: Design, status: Design['status'], error?: string): Promise<void> {
  d.status = status
  if (error) d.error = error
  if (current === d) current = null
  await save($, d)
  await $.state.set(NOW, null)
  if (status === 'failed' && error) failNotice($, error)
}

/** v's fork, spawned while the key's own hook runs (the agent.spawn hook below holds it for the word window). */
async function start($: Engine, d: Design, prompt: string): Promise<void> {
  try {
    const r = await spawnFork($, { kind: 'designer', prompt, description: DESCRIPTION })
    if (d.status === 'cancelled') return
    if (!r.agentId) return await end($, d, 'failed', `× v could not start drawing a card: ${cut(r.deny || 'Claude Code started no agent', 200)}`)
    d.agentId = r.agentId
    d.status = 'running'
    await save($, d)
    await busyWhile($, 'drawing a card', () => current === d)
  } catch (err) {
    await end($, d, 'failed', `× v could not start drawing a card: ${reason(err)}`)
  }
}

/** The fork ended: main reads the cards it drew, or the person reads why it drew none. */
async function finish($: Engine, d: Design, e: { reason: string; answer: string }): Promise<void> {
  if (e.reason === 'aborted') return end($, d, 'cancelled')
  if (e.reason === 'refusal') return end($, d, 'failed', "× The model's safeguards refused to draw this card. /model can switch to Opus 4.8, which may draw it.")
  const said = cut(firstLine(e.answer), 160)
  if (e.reason === 'error') return end($, d, 'failed', `× v could not draw a card: the model call failed${said ? ` (${said})` : ''}.`)
  const drawn: CardMeta[] = []
  for (const id of cardsUnder(d.anchorRow)) {
    const meta = await metaOf($, id)
    if (meta && meta.agentId === d.agentId) drawn.push(meta)
  }
  d.cards = drawn.map(m => m.id)
  if (!drawn.length) return end($, d, 'failed', `× v drew no card${said ? `: ${said}` : '.'}`)
  const copies: string[] = []
  for (const m of drawn) copies.push(`“${m.title}”\n${cut(await cardText($, m.id), TELL_CHARS)}`)
  const what = drawn.length === 1 ? 'a card' : `${drawn.length} cards`
  await tellAtNextPrompt($, `v:${d.key}`, `The person pressed v on your last answer, and a copy of you drew ${what} under it. As drawn now:\n\n${copies.join('\n\n')}`)
  await end($, d, 'done')
}

export const registerDesigner: Register = on => {
  // a reload of the plugin: the answer and the design that runs are known again
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      answerRow = ((await $.state.get(ANSWER)).value ?? null) as string | null
      const d = await designNow($)
      if (d && (d.status === 'held' || d.status === 'running')) {
        current = d
        if (d.status === 'running') await busyWhile($, 'drawing a card', () => current === d)
      }
    } catch {
      // v waits for the next answer
    }
    return r
  }).catch(($, e, next) => next(e))

  // main's text rows: the last one is the answer v draws under (the row ui.render AssistantMessage names)
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.uuid && e.message.content.some(b => b.type === 'text' && String(b.text || '').trim())) {
      answerRow = r.uuid
      void $.state.set(ANSWER, r.uuid).catch(() => undefined)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', { turnId: /./ }, async ($, e, next) => {
    if (e.agentId === undefined) mainWorks = true
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) mainWorks = false
    else if (current && current.agentId === e.agentId && forkOf(e.agentId)?.kind === 'designer') {
      const d = current
      try {
        await finish($, d, e)
      } catch (err) {
        await end($, d, 'failed', `× v could not finish the card: ${reason(err)}`)
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.edit', { origin: { kind: 'composer' }, text: '' }, async ($, e, next) => {
    const k = e.key
    if (!k || k.ctrl || k.meta) return next(e)
    const now = Number(await $.clock.now())
    // a letter straight after v: the person types a word, and the design that waited is cancelled
    const w = wordWindow
    if (w && !w.cancelled && now - w.at < WORD_MS && /^\p{L}$/u.test(k.key)) {
      w.cancelled = true
      wordWindow = null
      if (current?.status === 'held') await end($, current, 'cancelled')
      return { text: `v${e.inputText}`, cursor: 1 + e.inputText.length }
    }
    if (k.key !== 'v' || !answerRow || mainWorks || running() || !featureOn('cards')) return next(e)
    const d: Design = { key: `d${now.toString(36)}`, anchorRow: answerRow, agentId: null, status: 'held', at: now, cards: [] }
    current = d
    wordWindow = { at: now, cancelled: false }
    const { text: prompt } = await promptText($, 'designer')
    await save($, d)
    await $.state.set(NOW, d.key)
    void start($, d, prompt)
    return { text: '', cursor: 0 }
  }).catch(($, e, next) => next(e))

  // v's spawn waits out the word window, and is refused when a letter came in it
  on('agent.spawn', { description: DESCRIPTION }, async ($, e, next) => {
    const w = wordWindow
    if (next.origin.plugin !== 'thimble' || !w) return next(e)
    const left = w.at + WORD_MS - Number(await $.clock.now())
    if (left > 0) await $.clock.sleep(left)
    if (w.cancelled) return { deny: 'the person typed a word that starts with v' }
    if (wordWindow === w) wordWindow = null
    return next(e)
  }).catch(($, e, next) => next(e))
}
