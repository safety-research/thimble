// answers.ts: the record of each of main's turns and of each text row Claude wrote in it, for the features that act on
// Claude's answers: squeeze and catch-up, the explainers and important details, the claims, the tray, the label rows.
// It only watches; it never changes a prompt, a row or a call.
//
//   a turn     {turnId, n, prompt: {text, by, row}, rows, answer, reason, startedAt, endedAt, labels, cards, seq}:
//              the prompt that started it and who sent it (prompt.submit's origin kind: composer, bridge, plugin,
//              task-notification, peer, ...), its text rows in order, its answer (its last text row; none for a turn
//              that ended in an error), the `thimble label` commands its Bash calls ran and the cards its card calls
//              drew, each with its place in the turn (`seq`, shared by both lists; a card also with the number of text
//              rows above it, `after`)
//   a message  {row, turnId, text, at, parts}: one text row of Claude's, by its id (session.append's uuid, which is
//              the AssistantMessage's requestId and the marks' row). `parts` holds what each feature keeps of the
//              message, by the feature's name (partOf, setPart): one feature never writes another's part
//
// Only main's turns are kept: a fork's (the checker, v's designer, a side thread) and a subagent's are not answers of
// the conversation. The records live in $.state (a reload of the plugin keeps them) and in the conversation's kept
// folder (core/env.ts), answers/<turn>.json, so a resumed session finds its answers, their parts and their labels.
//
//   turnsNow($), turnOf($, id), turnOfRow($, row), messageOf($, row), textRows($)   the records
//   answerRows($), latestAnswer($)    each answered turn's answer row, oldest first; the newest
//   actingRow($), pickAnswer($, row), stepAnswer($, dir)   the answer the keys act on: the one the person picked with
//                                     { and } (answerStepKey), else the newest; a new turn of main's gives the keys
//                                     back to its answer
//   sinceLast($)                      since the person's last prompt: the prompt, Claude's text rows, the answers
//   questionOf($, row)                the words of the prompt the row's turn answers
//   partOf($, row, feature), setPart($, row, feature, value)   a feature's own part of a message
//   labelsOf($, turnId, beforeSeq?)   the labels the turn's `thimble label` commands ran, before a step of the turn
import { update, type EngineInterface, type Register } from 'claude-code'

import { callOf, metaOf } from '../cards/store'
import { keptDir } from './env'
import { safeName } from './layout.mjs'
import { mainTurn } from './turn'
import { labelCommands, sinceLastPrompt, stepFrom } from './answers.mjs'

type Engine = EngineInterface

export type Prompt = { text: string; by: string; row: string | null }
export type LabelUse = { name: string; args: string[]; toolUseId: string; seq: number; ok: boolean }
/** A card a card call of the turn drew: `after`, how many of the turn's text rows stand above it (the card draws at
 *  its call; a version drawn in an earlier call's place keeps that place). */
export type CardUse = { id: string; toolUseId: string; seq: number; after?: number }
export type TurnRec = {
  turnId: string; n: number; prompt: Prompt; rows: string[]; answer: string | null; reason: string | null
  startedAt: number; endedAt: number | null; labels: LabelUse[]; cards: CardUse[]; seq: number
}
export type Msg = { row: string; turnId: string; text: string; at: number; parts?: Record<string, unknown> }

const TURN = { plugin: 'thimble', key: 'answerTurn' } as const
const TURNS = { plugin: 'thimble', key: 'answerTurns' } as const
const MSG = { plugin: 'thimble', key: 'answerMsg' } as const
const ROWTURN = { plugin: 'thimble', key: 'answerRowTurn' } as const
const SEL = { plugin: 'thimble', key: 'answerSel' } as const

const PROMPT_MAX = 4000

/** The prompt that will start main's next turn, as prompt.submit and session.append saw it. */
let pending: Prompt | null = null

// ------------------------------------------------------------------------------------------------ reads

export async function turnIds($: Engine): Promise<string[]> {
  return (((await $.state.get(TURNS)).value ?? []) as string[]).filter(x => typeof x === 'string')
}

export async function turnOf($: Engine, turnId: string): Promise<TurnRec | null> {
  return ((await $.state.get({ ...TURN, id: turnId })).value ?? null) as TurnRec | null
}

/** Every turn kept, oldest first. */
export async function turnsNow($: Engine): Promise<TurnRec[]> {
  const out: TurnRec[] = []
  for (const id of await turnIds($)) {
    const t = await turnOf($, id)
    if (t) out.push(t)
  }
  return out
}

export async function messageOf($: Engine, row: string): Promise<Msg | null> {
  return ((await $.state.get({ ...MSG, id: row })).value ?? null) as Msg | null
}

export async function turnOfRow($: Engine, row: string): Promise<TurnRec | null> {
  const id = (await $.state.get({ ...ROWTURN, id: row })).value as string | undefined
  return id ? turnOf($, id) : null
}

/** Claude's text rows in this conversation, oldest first. */
export async function textRows($: Engine): Promise<string[]> {
  return (await turnsNow($)).flatMap(t => t.rows)
}

/** Each answered turn's answer row, oldest first. */
export async function answerRows($: Engine): Promise<string[]> {
  return (await turnsNow($)).map(t => t.answer).filter((r): r is string => !!r)
}

export async function latestAnswer($: Engine): Promise<string | null> {
  return (await answerRows($)).at(-1) ?? null
}

/** The answer the keys act on: the one the person picked ({ }), while it is an answer, else the newest. */
export async function actingRow($: Engine): Promise<string | null> {
  const sel = (await $.state.get(SEL)).value as string | null | undefined
  const all = await answerRows($)
  return sel && all.includes(sel) ? sel : all.at(-1) ?? null
}

/** Whether the person picked an answer other than the newest for the keys. */
export async function pickedRow($: Engine): Promise<string | null> {
  const sel = (await $.state.get(SEL)).value as string | null | undefined
  return sel && sel !== (await latestAnswer($)) && (await answerRows($)).includes(sel) ? sel : null
}

/** The keys act on `row` (null: the newest answer again). */
export async function pickAnswer($: Engine, row: string | null): Promise<void> {
  await $.state.set(SEL, row && row !== (await latestAnswer($)) ? row : null)
}

/** The keys act on the answer before (-1) or after (1) the one they act on now; the row now, or null when there is
 *  none that way (nothing changes then). */
export async function stepAnswer($: Engine, dir: number): Promise<string | null> {
  const next = stepFrom(await answerRows($), await actingRow($), dir)
  if (!next) return null
  await pickAnswer($, next)
  return next
}

/** Since the person's last prompt: that prompt, Claude's text rows after it, and the answers among them. */
export async function sinceLast($: Engine): Promise<{ prompt: { row: string | null; text: string } | null; rows: string[]; replies: string[] }> {
  return sinceLastPrompt(await turnsNow($))
}

/** The words of the prompt that the row's turn answers ('' when it is not known). */
export async function questionOf($: Engine, row: string): Promise<string> {
  return (await turnOfRow($, row))?.prompt.text ?? ''
}

export async function partOf<T = unknown>($: Engine, row: string, feature: string): Promise<T | null> {
  return ((await messageOf($, row))?.parts?.[feature] ?? null) as T | null
}

/** A feature's part of a message, set (a value), or changed from what it is now (a function of it). The message must
 *  be kept already; answers whether it was. */
export async function setPart<T>($: Engine, row: string, feature: string, value: T | ((cur: T | null) => T | null)): Promise<boolean> {
  let kept = false
  const out = await update($, { ...MSG, id: row }, cur => {
    const m = cur as Msg | null | undefined
    if (!m) return cur
    kept = true
    const was = (m.parts?.[feature] ?? null) as T | null
    const next = typeof value === 'function' ? (value as (c: T | null) => T | null)(was) : value
    const parts = { ...(m.parts ?? {}) }
    if (next === null || next === undefined) delete parts[feature]
    else parts[feature] = next
    return { ...m, parts }
  })
  if (kept && out) await persist($, (out as Msg).turnId)
  return kept
}

/** The labels the turn's `thimble label` commands ran, in order, each once (its latest command); with `beforeSeq`,
 *  only those run before that step of the turn (a card's call). */
export async function labelsOf($: Engine, turnId: string, beforeSeq?: number): Promise<LabelUse[]> {
  const t = await turnOf($, turnId)
  const list = (t?.labels ?? []).filter(l => beforeSeq === undefined || l.seq < beforeSeq)
  const byName = new Map<string, LabelUse>()
  for (const l of list) { byName.delete(l.name); byName.set(l.name, l) }
  return [...byName.values()]
}

// ------------------------------------------------------------------------------------------------ writes

async function fileOf($: Engine, turnId: string): Promise<string> {
  return `${await keptDir($)}/answers/${safeName(turnId)}.json`
}

// the disk follows the state: one write at a time, each of the turn as it stands then
let writing: Promise<unknown> = Promise.resolve()
function persist($: Engine, turnId: string): Promise<unknown> {
  writing = writing.then(async () => {
    const turn = await turnOf($, turnId)
    if (!turn) return
    const msgs: Msg[] = []
    for (const row of turn.rows) { const m = await messageOf($, row); if (m) msgs.push(m) }
    await $.fs.write(await fileOf($, turnId), JSON.stringify({ v: 1, turn, msgs }))
  }).catch(() => undefined)
  return writing
}

async function editTurn($: Engine, turnId: string, edit: (t: TurnRec) => TurnRec): Promise<TurnRec | null> {
  const out = await update($, { ...TURN, id: turnId }, cur => (cur ? edit(cur as TurnRec) : cur) as unknown)
  if (out) await persist($, turnId)
  return (out ?? null) as TurnRec | null
}

/** Whether a turn's text is the words of a prompt submitted for it. */
const sameText = (a: string, b: string) => a.trim() === b.trim()

/** A prompt whose turn started before its prompt.submit hook ran (turn.start found no prompt waiting): the newest turn,
 *  recorded with its words and no sender, is given this prompt's sender, and the prompt waits no more. */
async function senderOfStarted($: Engine, prompt: Prompt): Promise<void> {
  const newest = (await turnIds($)).at(-1)
  const t = newest ? await turnOf($, newest) : null
  if (!t || t.prompt.by !== 'unknown' || !sameText(t.prompt.text, prompt.text)) return
  if (pending === prompt) pending = null
  await editTurn($, t.turnId, x => ({ ...x, prompt: { ...x.prompt, by: prompt.by } }))
}

async function newTurn($: Engine, turnId: string, prompt: Prompt): Promise<void> {
  const ids = await turnIds($)
  if (ids.includes(turnId)) return
  const at = Number(await $.clock.now())
  const t: TurnRec = { turnId, n: ids.length + 1, prompt, rows: [], answer: null, reason: null, startedAt: at, endedAt: null, labels: [], cards: [], seq: 0 }
  await $.state.set({ ...TURN, id: turnId }, t)
  await update($, TURNS, cur => [...((cur as string[] | undefined) ?? []).filter(x => x !== turnId), turnId])
  await persist($, turnId)
}

/** The turn a row of main's belongs to: main's turn that runs, else the newest kept. */
async function turnNow($: Engine): Promise<string | null> {
  return (await mainTurn($)) || (await turnIds($)).at(-1) || null
}

/** One text row of main's, kept in its turn. */
export async function noteText($: Engine, row: string, text: string): Promise<void> {
  const turnId = await turnNow($)
  if (!turnId || !row || !text.trim()) return
  if (await messageOf($, row)) return
  await $.state.set({ ...MSG, id: row }, { row, turnId, text, at: Number(await $.clock.now()) } satisfies Msg)
  await $.state.set({ ...ROWTURN, id: row }, turnId)
  await editTurn($, turnId, t => (t.rows.includes(row) ? t : { ...t, rows: [...t.rows, row] }))
}

/** The turns this conversation kept that the state does not hold (a resumed session), back in it. */
export async function restoreAnswers($: Engine): Promise<void> {
  const dir = `${await keptDir($)}/answers`
  let entries: { name: string; kind: string }[] = []
  try { entries = (await $.fs.list(dir)) as { name: string; kind: string }[] } catch { return }
  const got: TurnRec[] = []
  for (const x of entries) {
    if (x.kind !== 'file' || !x.name.endsWith('.json')) continue
    let kept: { turn?: TurnRec; msgs?: Msg[] }
    try { kept = JSON.parse(String(await $.fs.read(`${dir}/${x.name}`))) } catch { continue }
    const t = kept?.turn
    if (!t?.turnId || (await turnOf($, t.turnId))) continue
    // a turn the session ended in: it ended with it
    const turn = t.endedAt == null ? { ...t, endedAt: t.startedAt, reason: t.reason ?? 'aborted' } : t
    await $.state.set({ ...TURN, id: t.turnId }, turn)
    for (const m of Array.isArray(kept.msgs) ? kept.msgs : []) {
      if (!m?.row) continue
      await $.state.set({ ...MSG, id: m.row }, m)
      await $.state.set({ ...ROWTURN, id: m.row }, t.turnId)
    }
    got.push(turn)
  }
  if (!got.length) return
  await update($, TURNS, cur => {
    const have = new Set((cur as string[] | undefined) ?? [])
    const all = [...got.filter(t => !have.has(t.turnId))]
    return [...all.sort((a, b) => a.n - b.n).map(t => t.turnId), ...have]
  })
}

// ------------------------------------------------------------------------------------------------ the keys { }

/** { and } at an empty prompt, while there are two answers or more: the keys act on the answer before or after the one
 *  they act on now (the newest gives them back to the latest turn). (hooks/keys.ts asks.) */
export async function answerStepKey($: Engine, key: string): Promise<{ now: () => Promise<unknown>; undo: () => Promise<unknown> } | null> {
  if (key !== '{' && key !== '}') return null
  if ((await answerRows($)).length < 2) return null
  const was = (await $.state.get(SEL)).value as string | null | undefined
  return {
    now: async () => {
      const row = await stepAnswer($, key === '{' ? -1 : 1)
      if (row) await $.ui.scroll({ to: { key: `ans-${row}` }, block: 'nearest' }).catch(() => undefined)
    },
    undo: () => $.state.set(SEL, was ?? null),
  }
}

// ------------------------------------------------------------------------------------------------ hooks

// main's rows as they are stored: the prompt's row, and each text row of Claude's. Its hooks take each door by name: where an
// organization manages Claude Code, its security default sends some doors (a hook's context, an attachment) past the
// plugins a person installs, and a hook whose door is a pattern would be counted as skipped there, with a notice
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function keepRow($: Engine, e: any, next: (e: any) => Promise<any>): Promise<any> {
  const stored = await next(e)
  try {
    if (e.agentId !== undefined) return stored
    const msg = e.message as { type?: string; content?: unknown; isMeta?: boolean }
    const blocks = Array.isArray(msg.content) ? (msg.content as { type?: string; text?: string }[]) : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []
    const text = blocks.filter(b => b.type === 'text').map(b => String(b.text || '')).join('\n')
    const row = String(stored?.uuid || e.uuid || '')
    if (!row || !text.trim()) return stored
    if (e.door === 'response' && msg.type === 'assistant') await noteText($, row, text)
    else if (e.door === 'prompt' && msg.type === 'user' && !msg.isMeta) {
      if (pending && !pending.row) pending.row = row
      const now = await mainTurn($)
      if (now) await editTurn($, now, t => (t.prompt.row ? t : { ...t, prompt: { ...t.prompt, row } }))
    }
  } catch {
    // the row is stored whatever the record makes of it
  }
  return stored
}

export const registerAnswers: Register = on => {
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try { await restoreAnswers($) } catch { /* the answers start with this session's */ }
    return r
  }).catch(($, e, next) => next(e))

  // the prompt of main's next turn and who sent it (a slash command and a meta prompt start no answer of their own).
  // Claude Code can start the turn while the hooks beneath this one still run, so the prompt waits before `next`; and
  // a turn that started before this hook ran is given its sender after
  on('prompt.submit', { origin: { kind: /./ } }, async ($, e, next) => {
    let mine: Prompt | null = null
    if (!e.command && !e.isMeta) {
      mine = { text: String(e.text ?? '').slice(0, PROMPT_MAX), by: String((e.origin as { kind?: string } | undefined)?.kind ?? ''), row: null }
      pending = mine
    }
    const r = await next(e)
    try {
      if (mine && (r as { drop?: unknown }).drop) {
        if (pending === mine) pending = null
      } else if (mine) {
        mine.text = String((r as { text?: string }).text ?? mine.text).slice(0, PROMPT_MAX)
        if (pending === mine) await senderOfStarted($, mine)
      }
    } catch {
      // the turn keeps its own text
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', { turnId: /\S/ }, async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        const text = String(e.text || '').slice(0, PROMPT_MAX)
        const p = pending && (!text || sameText(pending.text, text)) ? pending : { text, by: text ? 'unknown' : 'continuation', row: null }
        pending = null
        await newTurn($, e.turnId, p)
        // a new turn of main's: the keys act on its answer
        await $.state.set(SEL, null)
      } catch {
        // the turn runs whatever the record makes of it
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // main's rows as they are stored: the prompt's row, and each text row of Claude's, each door by its name (keepRow)
  on('session.append', { door: 'prompt' }, keepRow).catch(($, e, next) => next(e))
  on('session.append', { door: 'response' }, keepRow).catch(($, e, next) => next(e))

  // main's Bash calls that ran `thimble label`, and its card calls: each with its place in the turn
  on('tool.call', { tool: /^(Bash|mcp__thimble__card)$/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId !== undefined) return r
      const turnId = await mainTurn($)
      if (!turnId) return r
      const input = e as unknown as { tool: string; tool_use_id?: string; command?: string }
      const toolUseId = String(input.tool_use_id ?? '')
      const ok = !('deny' in r && r.deny !== undefined) && !r.isError
      if (input.tool === 'Bash') {
        const found = labelCommands(String(input.command ?? ''))
        if (found.length) await editTurn($, turnId, t => ({ ...t, seq: t.seq + 1, labels: [...t.labels, ...found.map((l: { name: string; args: string[] }) => ({ ...l, toolUseId, seq: t.seq + 1, ok }))] }))
      } else if (ok) {
        const id = await callOf($, toolUseId)
        const here = id ? (await metaOf($, id))?.toolUseId === toolUseId : false
        if (id) await editTurn($, turnId, t => {
          const was = t.cards.find(c => c.id === id)?.after
          const after = !here && was !== undefined ? was : t.rows.length
          return { ...t, seq: t.seq + 1, cards: [...t.cards.filter(c => c.id !== id), { id, toolUseId, seq: t.seq + 1, after }] }
        })
      }
    } catch {
      // the call's result is the same whatever the record makes of it
    }
    return r
  }).catch(($, e, next) => next(e))

  // main's turn ends: its answer is its last text row (set before the modules inside this one hear the end, so they
  // read it); a turn that ended in an error answered nothing
  on('turn.complete', { turnId: /\S/ }, async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        const at = Number(await $.clock.now())
        await editTurn($, e.turnId, t => ({ ...t, reason: e.reason, endedAt: at, answer: e.reason === 'error' ? null : t.rows.at(-1) ?? null }))
      } catch {
        // the turn ends whatever the record makes of it
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetAnswers(): void {
  pending = null
  writing = Promise.resolve()
}
