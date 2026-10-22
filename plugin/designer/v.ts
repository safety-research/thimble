// v.ts: the designer step. At an empty prompt, v starts a fork of the conversation in the background (core/forks.ts,
// kind `designer`, with prompts/designer.md). The fork lists a few forms for main's last answer, picks one, draws it
// with the `card` tool and fixes it from the card's text copy. Its cards draw under the answer v was pressed on; the
// busy line says `drawing a card`, then `improving the card` once one is on screen; its last message never reaches
// main, but main reads the cards it drew
// with the person's next prompt.
//
// v is a letter too (hooks/keys.ts holds the word window: a letter typed right after v means the person types a word,
// "very"). The fork is spawned inside the keys' prompt.edit hook, so Claude Code skips only that hook for the fork and
// this plugin's other hooks serve it (its card calls, its end). This module's agent.spawn hook holds the spawn until the
// word window closes, and refuses it when a letter came: so a word typed after v starts nothing at all.
//
// v starts a design only when there is an answer to draw (main's last text row, as session.append stored it), main is
// not working, Cards is on, and no other design runs. Otherwise v types as any letter. A design whose fork Claude Code
// no longer runs (its end was missed, say in a reload of the plugin) ends as failed: at session start, with a notice,
// and when v is pressed again.
//
// The fork may read, run code and draw cards; its Write tool writes only into the temp folder, where its rows go
// (cards/register.ts lets it read and write there without a dialog in front of the person). Its Bash calls are the
// person's permission mode's to decide, as main's are.
//
//   vKey($, key, until)    what v does at an empty prompt now (hooks/keys.ts asks), or null when it types
//   designAnchor($, id)    the answer row the cards of that designer fork draw under (the card tool asks it)
//   vReady($)              whether v would start a design now (the bar names v only then)
//
//   state: designs (each design, by key), designNow (the key of the design that runs), answerRow (main's last answer
//   row, kept on disk too, so v works in a resumed session)
import type { EngineInterface, Register } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { failCleared, failNotice, noticeLine } from '../bar/notice'
import { cardText } from '../cards/draw'
import { anchoredAt, type CardMeta, inTemp, metaOf } from '../cards/store'
import { readKept, writeKept } from '../core/env'
import { forkOf, spawnFork } from '../core/forks'
import { tempDir } from '../core/home'
import { tellAtNextPrompt } from '../core/tell'
import { cut, fenced } from '../core/text.js'
import { mainRuns } from '../core/turn'
import { replyOf } from '../marks/store'
import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
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
  /** when the word window closes: the spawn waits until then */
  until: number
  error?: string
  /** the cards the design drew */
  cards: string[]
}

/** The words the fork shows as in /tasks, and how this module's agent.spawn hook knows the spawn as v's. */
const DESCRIPTION = 'card of the last answer (v)'
/** The most of a card's text copy main reads. */
const TELL_CHARS = 3000
/** The tools the fork may call; Write only into the temp folder. */
const TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'mcp__thimble__card'])

const DESIGNS = { plugin: 'thimble', key: 'designs' } as const
const NOW = { plugin: 'thimble', key: 'designNow' } as const
const ANSWER = { plugin: 'thimble', key: 'answerRow' } as const
const ANSWER_FILE = 'answer.json'

/** The design that runs (one at a time), as this load of the module holds it; its state is in $.state too. */
let current: Design | null = null

const firstLine = (s: string) => String(s || '').split('\n').map(l => l.trim()).find(Boolean) || ''
const reason = (err: unknown) => cut(String((err as Error)?.message || err), 200)
const running = () => current?.status === 'held' || current?.status === 'running'

async function save($: Engine, d: Design): Promise<void> {
  await $.state.set({ ...DESIGNS, id: d.key }, d)
}

async function answerNow($: Engine): Promise<string | null> {
  return ((await $.state.get(ANSWER)).value ?? null) as string | null
}

export async function designNow($: Engine): Promise<Design | null> {
  const key = (await $.state.get(NOW)).value
  return key ? (((await $.state.get({ ...DESIGNS, id: key })).value ?? null) as Design | null) : null
}

export async function designAnchor($: Engine, agentId: string | undefined): Promise<string | null> {
  const d = await designNow($)
  return agentId && d?.agentId === agentId && d.status === 'running' ? d.anchorRow : null
}

/** Whether v would draw a card now: an answer exists and no design runs (the bar's `v card`). Read from the state, so a
 *  drawing that asks draws again when it changes. */
export async function vReady($: Engine): Promise<boolean> {
  if (!(await answerNow($))) return false
  const d = await designNow($)
  return d?.status !== 'held' && d?.status !== 'running'
}

/** The design's end: its state, the bar, and the failure line when it failed; one that drew takes away the line an
 *  earlier v left. */
async function end($: Engine, d: Design, status: Design['status'], error?: string): Promise<void> {
  d.status = status
  if (error) d.error = error
  if (current === d) current = null
  await save($, d)
  await $.state.set(NOW, null)
  if (status === 'failed' && error) failNotice($, error, 'v')
  if (status === 'done') await failCleared($, 'v')
}

/** Whether Claude Code still runs the design's fork. */
async function forkAlive($: Engine, d: Design): Promise<boolean> {
  if (d.status === 'held' || !d.agentId) return true
  const a = (await $.agent.list()).find(x => x.id === d.agentId)
  return !!a && !['completed', 'failed', 'killed'].includes(a.status)
}

/** What the check of the answer's marks changed since main wrote it, for the fork, whose copy of the conversation
 *  ends at that answer: a card must not repeat a value the check corrected or flagged. */
async function checkedSince($: Engine, row: string): Promise<string> {
  const reply = await replyOf($, row)
  const changed = (reply?.items ?? []).filter(m => m.status === 'corrected' || m.status === 'failed')
  if (!changed.length) return ''
  const lines = changed.map(m => (m.status === 'corrected' ? `- "${m.was ?? m.words}" is wrong; it is "${m.shown}"`
    : m.failedBy === 'check' ? `- "${m.words}" is wrong${m.reason ? `: ${m.reason}` : ''}` : `- "${m.words}" is not confirmed${m.reason ? `: ${m.reason}` : ''}`))
  return `\n\nSince that answer, thimble checked its marks against the data. The check found (its words quote the records):\n${fenced(lines.join('\n'))}\nThe card shows the corrected values, computed from the records.`
}

/** The card an earlier v drew under this answer, for the fork to draw a new version of: v again on the same answer
 *  changes that card rather than adding a second one. */
async function earlierCard($: Engine, row: string): Promise<string> {
  for (const id of [...(await anchoredAt($, row))].reverse()) {
    const meta = await metaOf($, id)
    if (meta && meta.version > 0 && meta.anchorRow === row) {
      return `\n\nAn earlier press of v drew the card “${meta.title}” under this answer. Draw your card as a new version of it, with \`id\` "${meta.id}", so the answer keeps one card.`
    }
  }
  return ''
}

/** The busy line's step while a design runs: `drawing a card` until its first card is on screen, then `improving the
 *  card`, since the fork reads the card's copy and may draw a new version; false once it ended. */
async function designStep($: Engine, d: Design): Promise<string | false> {
  if (current !== d) return false
  for (const id of await anchoredAt($, d.anchorRow)) if ((await metaOf($, id))?.agentId === d.agentId) return 'improving the card'
  return 'drawing a card'
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
    await busyWhile($, 'drawing a card', () => designStep($, d))
  } catch (err) {
    await end($, d, 'failed', `× v could not start drawing a card: ${reason(err)}`)
  }
}

/** The fork ended: main reads the cards it drew, or the person reads why it drew none. */
async function finish($: Engine, d: Design, e: { reason: string; answer: string }): Promise<void> {
  if (e.reason === 'aborted') return end($, d, 'cancelled')
  if (e.reason === 'refusal') {
    // not thimble's failure, so the line offers no fix of thimble: only the way out
    await end($, d, 'failed')
    return noticeLine($, "The model's safeguards refused to draw this card. Another model may draw it: /model.", 'v')
  }
  const said = cut(firstLine(e.answer), 160)
  if (e.reason === 'error') return end($, d, 'failed', `× v could not draw a card: the model call failed${said ? ` (${said})` : ''}.`)
  const drawn: CardMeta[] = []
  for (const id of await anchoredAt($, d.anchorRow)) {
    const meta = await metaOf($, id)
    if (meta && meta.agentId === d.agentId) drawn.push(meta)
  }
  d.cards = drawn.map(m => m.id)
  if (!drawn.length) return end($, d, 'failed', `× v drew no card.${said ? ` The copy that drew it ended with: “${said}”` : ''}`)
  const copies: string[] = []
  for (const m of drawn) copies.push(`“${m.title}” (id "${m.id}"), as drawn now:\n${fenced(cut(await cardText($, m.id), TELL_CHARS))}`)
  const what = drawn.length === 1 ? 'a card' : `${drawn.length} cards`
  await tellAtNextPrompt($, `v:${d.key}`, `The analyst pressed v on your last answer, and a copy of you drew ${what} under it. To change one, call card with its id. The text of a card shows the records' own words.\n\n${copies.join('\n\n')}`)
  await end($, d, 'done')
}

/** v at an empty prompt: a design of the last answer, or null when v types (hooks/keys.ts). Its prompt is made here,
 *  before anything starts, so a prompt that cannot be made starts nothing. `until`: when the word window closes. */
export async function vKey($: Engine, key: string, until: number): Promise<{ now: () => Promise<unknown>; undo: () => Promise<unknown> } | null> {
  if (key !== 'v' || !featureOn('cards')) return null
  const row = await answerNow($)
  if (!row || (await mainRuns($))) return null
  if (current && running()) {
    if (await forkAlive($, current)) return null
    await end($, current, 'failed')
  }
  const prompt = `${fill(await promptText($, 'designer'), { TMPDIR: await tempDir($) })}${await checkedSince($, row)}${await earlierCard($, row)}`
  const at = Number(await $.clock.now())
  const d: Design = { key: `d${at.toString(36)}`, anchorRow: row, agentId: null, status: 'held', at, until, cards: [] }
  return {
    now: async () => {
      current = d
      await save($, d)
      await $.state.set(NOW, d.key)
      void start($, d, prompt)
    },
    undo: async () => {
      if (d.status === 'held') await end($, d, 'cancelled')
    },
  }
}

/** Why the designer fork may not make this call, or null when it may: it reads, runs code, draws cards, and writes
 *  only in the temp folder. */
async function denial($: Engine, e: { tool: string; file_path?: unknown }): Promise<string | null> {
  const tool = String(e.tool)
  if (!TOOLS.has(tool)) return `The card's copy uses ${[...TOOLS].join(', ')} only.`
  if (tool !== 'Write') return null
  return (await inTemp($, e.file_path)) ? null : `The card's copy writes only in the temp folder, ${await tempDir($)}.`
}

export const registerDesigner: Register = on => {
  // a reload of the plugin, or a resumed session: the answer and the design that runs are known again; a design whose
  // fork is gone ends as failed, and says so
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (!(await answerNow($))) {
        // a resumed session: the conversation's last answer, as the session that wrote it kept it
        const kept = (await readKept<{ row?: string }>($, ANSWER_FILE))?.row
        if (kept) await $.state.set(ANSWER, kept)
      }
      const d = await designNow($)
      if (d && (d.status === 'held' || d.status === 'running')) {
        current = d
        if (d.status === 'held' || !(await forkAlive($, d))) await end($, d, 'failed', '× v stopped drawing its card: thimble lost the copy that drew it. Press v to draw it again.')
        else await busyWhile($, 'drawing a card', () => designStep($, d))
      }
    } catch {
      // v waits for the next answer
    }
    return r
  }).catch(($, e, next) => next(e))

  // main's text rows: the last one is the answer v draws under (the row ui.render AssistantMessage names). A row the
  // engine wrote in place of a response (an API error) names the model `<synthetic>`, and is no answer
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const r = await next(e)
    const synthetic = e.origin.kind === 'model' && e.origin.model === '<synthetic>'
    if (e.agentId === undefined && !synthetic && r.uuid && e.message.content.some(b => b.type === 'text' && String(b.text || '').trim())) {
      void $.state.set(ANSWER, r.uuid).catch(() => undefined)
      void writeKept($, ANSWER_FILE, { row: r.uuid }).catch(() => undefined)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', { agentId: /\S/ }, async ($, e, next) => {
    const r = await next(e)
    if (current && current.agentId === e.agentId && forkOf(e.agentId)?.kind === 'designer') {
      const d = current
      try {
        await finish($, d, e)
      } catch (err) {
        await end($, d, 'failed', `× v could not finish the card: ${reason(err)}`)
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  // the fork's calls: it reads, runs code, draws cards, and writes only in the temp folder
  on('tool.call', { agentId: /\S/ }, async ($, e, next) => {
    if (forkOf(e.agentId)?.kind !== 'designer') return next(e)
    const no = await denial($, e as never)
    return no ? { deny: no } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : forkOf(e.agentId)?.kind === 'designer' ? { deny: "thimble could not check this call of the card's copy" } : next(e)))

  // v's spawn waits out the word window, and is refused when a letter came in it
  on('agent.spawn', { description: DESCRIPTION }, async ($, e, next) => {
    const d = current
    if (next.origin.plugin !== 'thimble' || !d || d.status !== 'held') return next(e)
    const left = d.until - Number(await $.clock.now())
    if (left > 0) await $.clock.sleep(left)
    // a word typed after v ended the design (end() lets go of it)
    if (current !== d) return { deny: 'the person typed a word that starts with v' }
    return next(e)
  }).catch(($, e, next) => next(e))
}
