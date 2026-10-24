// term.ts: Squeeze in the terminal: the records of the versions the chips wrote, the one call per change that rewrites
// an answer in place, the new text writing itself in from the top, the catch-up of replies that piled up, and what
// Claude hears of the version the person settled on. The chips themselves, their keys and their drawing, are
// draw.ts's; the seam (seam.ts) hands it to the hosts.
//
// A record is a message's own (its id is the row) or a catch-up's (its id is `<host row>#cu`, kept on the newest of
// the replies it covers). Both live in the message's part `squeeze` (core/answers.ts setPart), which a resumed session
// reads back with its turn:
//   {own: {shown, squeeze}, cu: {text, at, shown, squeeze, catchup}, inCatchUp: <host row>}
// chips.mjs says the fields. While a change is on its way, the module's state says where the chips go (want), and a
// failed call says why (error).
//
// A rewrite: one $.model.complete call (the registry's squeeze prompt, the question, the original, every chip's level),
// recorded in the session's events with the prompt it used (telemetry `squeeze`, the bar's busy line `rewriting` or
// `writing a catch-up`); `shown` holds the result; a state seen before comes back from the record with no call. A call
// waits 1 s after the last change (settings.json settleMs), and one record has one call that shows at a time: a change
// while a call runs makes its result go unshown. While a call runs the old text dims; when the new text is there it
// writes itself in from the top at a model's pace.
//
// The chips belong to the whole answer, so with the squeeze switch for cards on, the request also shows the cards
// drawn in the answer's turn (cards.ts), and a change of a card the reply asks for is made through the card runner as
// the person's version. Each version keeps its cards, so a version seen before and the original (0) come back with
// theirs.
//
// What Claude hears: once a version shows, the version the person reads waits for their next prompt (core/tell.ts,
// one text per record, the latest wins), so a later turn knows what they read.
import { update, type EngineInterface } from 'claude-code'

import { failNotice } from '../bar/notice'
import { messageOf, partOf, questionOf, setPart, sinceLast } from '../core/answers'
import { keptDir } from '../core/env'
import { tellAtNextPrompt } from '../core/tell'
import { modelWhy } from '../core/why.js'
import type { ExplainPart } from '../explain/seam'
import { rewritesIn, withCorrections } from '../marks/message.js'
import { rowMarks } from '../marks/store'
import { promptText } from '../prompts/prompts'
import { featureOn } from '../settings/features.mjs'
import { tracked } from '../telemetry/telemetry'
import { trayOffRow } from '../tray/seam'
import { answerCards, applyCards, showCards, type Answer } from './cards'
import {
  ARRIVE, SCALE, answerText, applyRewrite, cardsAfter, catchUpStands, catchUpText, checkRewrite, chipsOf, dropOrphanHeads,
  fromVersions, isCatchUp, isOriginal, keepCorrections, mustKeep, readReply, request, restore, revealStep, rowsOf,
  setWords, settledNote, shownKey, termsOf,
} from './chips.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type At = Record<string, number>

export type CatchUp = { host: string; rows: string[]; replies: number; question: string; prompt: string | null; dismissed?: boolean }
/** A record the chips act on: a message's own (`id` = its row) or a catch-up's (`id` = `<host>#cu`). */
export type Rec = { id: string; row: string; text: string; at: string; shown: string | null; squeeze: Any; catchup?: CatchUp }
/** A message's part `squeeze`. */
export type SqPart = { own?: { shown: string | null; squeeze: Any }; cu?: { text: string; at: string; shown: string | null; squeeze: Any; catchup: CatchUp }; inCatchUp?: string }
/** A record's state beside its text: a call running, where the chips go while it runs, why the last call failed, and
 *  how much of a new text has written itself in. */
export type SqzUi = { running: { since: number } | null; want?: At | null; asked?: number | null; error: string | null; reveal?: { n: number; total: number } | null }

const UI = { plugin: 'thimble', key: 'squeezeUi' } as const
const TOLD = { plugin: 'thimble', key: 'squeezeTold' } as const
const DEFAULTS = { model: 'sonnet', effort: 'low', maxTokens: 4000, timeoutMs: 90000 }
const TICK = 50
const BLANK: SqzUi = { running: null, error: null }
/** The wait before a call, when settings.json does not say (settleMs). */
const SETTLE_MS = 1000

// the module's memory: per record, the number of its latest change while one is on its way, and the change whose call
// runs; the text writing in per record; the settings; the last screen width
const latest = new Map<string, number>()
const inflight = new Map<string, number>()
const revealing = new Map<string, number>()
// `key`: the key the bar names for it ([ or ]), which presses it again after a failure
type Want = { at: At; key?: string | null }
let cfg: Record<string, unknown> = {}
let viewCols = 100

/** The screen's width the transcript draws at, as the last answer drawn saw it (the log's row counts). */
export function seeView(cols: number): void {
  if (cols > 0) viewCols = cols
}

export const cuId = (host: string) => `${host}#cu`
export const rowOfId = (id: string) => (id.endsWith('#cu') ? id.slice(0, -3) : id)

// ------------------------------------------------------------------------------------------------ the records

export async function partNow($: Engine, row: string): Promise<SqPart> {
  return ((await partOf<SqPart>($, row, 'squeeze')) ?? {}) as SqPart
}

/** The record of `id`: a message's own (as written, with its versions), or a catch-up's; null when there is none. */
export async function recOf($: Engine, id: string): Promise<Rec | null> {
  const row = rowOfId(id)
  const msg = await messageOf($, row)
  if (!msg) return null
  const part = (msg.parts?.squeeze ?? {}) as SqPart
  if (id.endsWith('#cu')) return part.cu ? { id, row, ...part.cu } : null
  return { id, row, text: msg.text, at: new Date(msg.at).toISOString(), shown: part.own?.shown ?? null, squeeze: part.own?.squeeze ?? {} }
}

/** A record kept in its message's part. */
export async function saveRec($: Engine, rec: Rec): Promise<void> {
  await setPart<SqPart>($, rec.row, 'squeeze', cur => (rec.id.endsWith('#cu')
    ? { ...(cur ?? {}), cu: { text: rec.text, at: rec.at, shown: rec.shown, squeeze: rec.squeeze, catchup: rec.catchup! } }
    : { ...(cur ?? {}), own: { shown: rec.shown, squeeze: rec.squeeze } }))
}

export async function uiOf($: Engine, id: string): Promise<SqzUi> {
  return (((await $.state.get({ ...UI, id })).value ?? null) as SqzUi | null) ?? { ...BLANK }
}
async function setUi($: Engine, id: string, change: Partial<SqzUi>): Promise<SqzUi> {
  const out = await update($, { ...UI, id }, cur => ({ ...BLANK, ...((cur as SqzUi | undefined) ?? {}), ...change }))
  return out as SqzUi
}

async function ensure($: Engine): Promise<void> {
  if (Object.keys(cfg).length) return
  try { cfg = JSON.parse(String(await $.fs.read(`${$.plugin.root.replace(/\/+$/, '')}/squeeze/settings.json`))) } catch { cfg = {} }
}

/** The text a record shows now: its version, or what Claude wrote. */
export const shownOf = (rec: Rec) => (typeof rec.shown === 'string' ? rec.shown : rec.text)

/** Whether a call runs for the record now. */
export const running = (id: string) => inflight.has(id)

// ------------------------------------------------------------------------------------------------ the rewrite

/** What a failed rewrite says: what failed and why, then the key that tries again. */
export function failedWords(why: string, key?: string | null): string {
  return `The rewrite failed: ${why}. ${key ? `Press ${key} to try again` : 'Pick the level again to try again'}`
}

/** Where the chips of a record go, said at once (the chips read it), before the rewrite is asked: a key pressed right
 *  after reads the levels this one set. */
export async function wantLevels($: Engine, id: string, at: At): Promise<void> {
  await setUi($, id, { want: at, error: null })
}

/** Set the chips of a record to `at` and show that version: from the record when it was written before, at once,
 *  else one call after a short wait (settings.json settleMs, 1 s). Each change restarts the wait, so keys pressed in a
 *  row are written once, at the last level; and one call at a time shows: a change that comes while a call runs makes
 *  that call's result go unshown. `key`: the key that asked for it. */
export async function setLevels($: Engine, id: string, at: At, key: string | null = null): Promise<void> {
  const gen = (latest.get(id) ?? 0) + 1
  latest.set(id, gen)
  await setUi($, id, { want: at, error: null })
  if (!(await uiOf($, id)).asked) await setUi($, id, { asked: Number(await $.clock.now()) })
  const rec = await recOf($, id)
  if (!rec) { await done($, id, gen); return }
  const probe: Rec = { ...rec, squeeze: { ...(rec.squeeze ?? {}), at, scale: SCALE } }
  const hit = isOriginal(chipsOf(probe)) ? restore(probe) : fromVersions(rec, at)
  if (hit) { await settled($, id, hit as Rec, { written: false }); await done($, id, gen); return }
  await ensure($)
  const wait = Number(cfg.settleMs ?? SETTLE_MS)
  if (wait > 0) await new Promise<void>(go => { $.clock.after(wait, () => go()) })
  if (latest.get(id) !== gen) return
  // a catch-up undone meanwhile (its s began a word) is written by no call
  const now = await recOf($, id)
  if (!now || now.catchup?.dismissed) { await done($, id, gen); return }
  inflight.set(id, gen)
  try {
    await once($, id, { at, key }, gen)
  } finally {
    if (inflight.get(id) === gen) inflight.delete(id)
    await done($, id, gen)
  }
}

/** The latest change of a record ended: its chips stand where it shows, and Claude hears of the version. A change
 *  that a later one replaced ends nothing. */
async function done($: Engine, id: string, gen: number): Promise<void> {
  if (latest.get(id) !== gen) return
  latest.delete(id)
  await setUi($, id, { running: null, want: null, asked: null })
  await noteSettled($, id)
}

/** A message's words as the person reads them: each sentence a check rewrote in place of Claude's, and each corrected
 *  citation's words in place of its own (as marks/register.ts draws them), so a rewrite starts from the corrected
 *  values and never sees the wrong ones beside them. */
async function asRead($: Engine, row: string, text: string): Promise<string> {
  const items = (await rowMarks($, row))?.items ?? []
  if (!items.some(it => it.status === 'corrected')) return text
  return withCorrections(rewritesIn(text, items).text, items)
}

/** The original a record's rewrite starts from: its message as the person reads it (asRead), or, for a catch-up, each
 *  of its messages so, one after another. */
async function originalOf($: Engine, rec: Rec): Promise<string> {
  if (!rec.catchup) return asRead($, rec.row, rec.text)
  const texts: string[] = []
  for (const r of rec.catchup.rows) {
    const m = await messageOf($, r)
    if (m?.text?.trim()) texts.push(await asRead($, r, m.text))
  }
  return texts.length ? catchUpText(texts) : rec.text
}

/** One call for a change; its result shows only while no later change came (`gen`, the change's number). */
async function once($: Engine, id: string, want: Want, gen: number): Promise<void> {
  const rec = await recOf($, id)
  if (!rec) return
  const s = (rec.squeeze ?? {}) as Any
  // the original as the person reads it: the citations the check corrected stand corrected in it
  const original = await originalOf($, rec).catch(() => rec.text)
  const probe: Rec = { ...rec, text: original, squeeze: { ...s, at: want.at, scale: SCALE } }
  const stale = () => latest.get(id) !== gen
  revealing.delete(id)
  await setUi($, id, { running: { since: Number(await $.clock.now()) }, error: null, reveal: null })
  const rows = rec.catchup ? [...rec.catchup.rows] : [rec.row]
  // a catch-up answers the person's last prompt, whatever notification or hand-back came after it
  const question = rec.catchup ? String(rec.catchup.question || '') : await questionOf($, rec.row).catch(() => '')
  const system = await promptText($, 'squeeze')
  // Claude's own corrections in the original are named in the request, and one the rewrite left out is put back after it
  const keep: string[] = mustKeep(original).slice(0, 6)
  // the terms of the explainers on its words are named in the request
  const terms: string[] = []
  for (const r of rows) for (const t of termsOf(await partOf<ExplainPart>($, r, 'explain'))) if (!terms.includes(t)) terms.push(t)
  // the answer's cards, which a version may change (with the switch on)
  const answer: Answer | null = featureOn('squeezeCards') ? await answerCards($, rec).catch(() => null) : null
  const req = request(probe, {
    system, toolkit: answer?.guide ?? '', question, keep, terms: terms.slice(0, 8), cards: answer?.cards ?? [],
    // a request that shows the cards asks for more thought: whether a card changes, and its view, if one does
    // (settings.json cardsEffort; at low effort the model kept every card as it was)
    model: String(cfg.model || DEFAULTS.model), effort: String((answer && cfg.cardsEffort) || cfg.effort || DEFAULTS.effort),
    maxTokens: Number(cfg.maxTokens || DEFAULTS.maxTokens), timeoutMs: Number(cfg.timeoutMs || DEFAULTS.timeoutMs),
  })
  const keyWords = Object.entries(want.at).map(([k, v]) => `${k}=${v}`).join(',')
  const t0 = Number(await $.clock.now())
  const r = await tracked($, { feature: 'squeeze', prompt: 'squeeze', model: req.model, doing: rec.catchup ? 'writing a catch-up' : 'rewriting', extra: { row: rec.row, key: keyWords, ...(answer ? { cards: answer.cards.length } : {}) } }, () => $.model.complete(req as Any))
  const ms = Number(await $.clock.now()) - t0
  // a later change came while it ran: its result is not shown (the latest change makes its own call)
  if (stale()) { await log($, { row: id, ok: r.isAnswered, dropped: 'a later change came', ms }); return }
  if (!r.isAnswered) {
    const why = modelWhy(r)
    await setUi($, id, { error: failedWords(why, want.key) })
    await log($, { row: id, ok: false, why, reason: r.reason, ms })
    return
  }
  const reply = readReply(r.text)
  if (!reply.text.trim()) {
    await setUi($, id, { error: failedWords('the model wrote no text', want.key) })
    return
  }
  // a heading the rewrite ends on, with nothing under it, promises what the text does not give: dropped before a
  // correction is put back after it, and after
  const bare = dropOrphanHeads(reply.text)
  const back = keepCorrections(bare.text, keep, original)
  const whole = dropOrphanHeads(back.text)
  whole.dropped.unshift(...bare.dropped)
  // held to the whole answer it was shown: the message, and its cards' words and rows when the request had them
  const checked = checkRewrite(answerText(original, answer?.cards ?? []), whole.text)
  // the cards this version changes, made as the person's; one that does not draw is left out, said why
  // (a card a catch-up adds stands under the catch-up, at the row it draws at)
  const changed = answer && reply.cards.length ? await applyCards($, answer, reply.cards, rec.catchup ? drawnAt(rec) : rec.row, setWords(probe) || 'as written') : null
  const cardProblems = answer ? [...reply.cardProblems, ...(changed?.problems ?? [])] : []
  const cards = answer && changed?.done.length ? cardsAfter(answer.orig, rec.row, changed.done) : null
  if (stale()) return
  // the record as it is now (the person may have added a chip meanwhile)
  const fresh = (await recOf($, id)) || rec
  const fs = (fresh.squeeze ?? {}) as Any
  const next = applyRewrite({ ...fresh, squeeze: { ...fs, own: fs.own ?? s.own } }, {
    text: checked.text, at: want.at,
    made: { ms, model: req.model, usage: (r as Any).usage, at: new Date(t0).toISOString(), prompt: 'squeeze' }, problems: [...checked.problems, ...cardProblems],
    cards, origCards: answer ? answer.orig : null,
  }) as Rec
  await setUi($, id, { running: null })
  await settled($, id, next, { written: true })
  await log($, {
    row: id, ok: true, ms, model: req.model, effort: req.effort, prompt: 'squeeze', usage: (r as Any).usage, key: keyWords, problems: checked.problems,
    rows: rowsOf(checked.text, viewCols), of: rowsOf(original, viewCols), ...(original !== rec.text ? { corrected: true } : {}),
    ...(keep.length ? { keep: keep.length, put_back: back.back.length } : {}), ...(whole.dropped.length ? { orphan_heads: whole.dropped.length } : {}),
    ...(terms.length ? { terms: terms.length } : {}), ...(rec.catchup ? { catchup: rec.catchup.replies } : {}),
    ...(answer ? { cards: answer.cards.length, asked: reply.cards.map((c: Any) => `${c.op} ${c.id}`), did: (cards?.did ?? []).map((d: Any) => `${d.did} ${d.id}`), card_problems: cardProblems, ...(changed?.unknown.length ? { unknown_cards: changed.unknown } : {}) } : {}),
  })
}

/** A version shown: the record kept, its cards set to the ones it shows, the tray off this row's moved marks, and the
 *  version marked for Claude to hear of with the person's next prompt. Text a call just `written` writes itself in from
 *  the top; a version that comes back from the record (the original at 0, or a level seen before) shows whole at once,
 *  since nothing is being written. */
async function settled($: Engine, id: string, rec: Rec, o: { written: boolean }): Promise<void> {
  const before = await recOf($, id)
  await saveRec($, rec)
  const stale = await showCards($, rec)
  if (stale.length) failNotice($, `A card could not be drawn at the version shown: ${stale.join('; ')}. Press 0 or pick the level again to try again.`, 'squeeze')
  await trayOffRow($, id.replace(/#cu$/, ''))
  const was = before ? shownOf(before) : ''
  const now = shownOf(rec)
  if (now !== was && o.written) { await writeIn($, id, now.length); return }
  // a write-in still running for the version before stops: this one shows whole
  if (revealing.has(id) || (await uiOf($, id)).reveal) { revealing.delete(id); await setUi($, id, { reveal: null }) }
}

/** The new text writes itself in from the top: a few characters more at each tick, at a model's pace, until it is
 *  whole. A later change starts its own. */
async function writeIn($: Engine, id: string, total: number): Promise<void> {
  const token = (revealing.get(id) ?? 0) + 1
  revealing.set(id, token)
  const step = revealStep(total, TICK)
  await setUi($, id, { reveal: { n: Math.min(total, step), total } })
  const next = () => {
    void (async () => {
      if (revealing.get(id) !== token) return
      const ui = await uiOf($, id)
      const n = (ui.reveal?.n ?? total) + step
      if (n >= total) { revealing.delete(id); await setUi($, id, { reveal: null }); return }
      await setUi($, id, { reveal: { n, total } })
      $.clock.after(TICK, next)
    })()
  }
  $.clock.after(TICK, next)
}

// ------------------------------------------------------------------------------------------------ what Claude hears

type Told = Record<string, { told: string; pending: string | null }>

/**
 * The version the person reads of a record, kept for Claude to read beside their next prompt (core/tell.ts, under
 * `squeeze:<id>`, the latest wins): the version whole, so a later turn knows what they read (chips.mjs settledNote).
 * A version back at the one Claude was last told of says nothing. A rewrite still on its way is told when it lands.
 */
export async function noteSettled($: Engine, id: string): Promise<void> {
  if (latest.has(id)) return
  const rec = await recOf($, id)
  if (!rec) return
  const told = ((await $.state.get(TOLD)).value ?? {}) as Told
  const was = told[id]?.told ?? 'orig'
  const text = settledNote(rec, was)
  await tellAtNextPrompt($, `squeeze:${id}`, text)
  await update($, TOLD, cur => ({ ...((cur as Told | undefined) ?? {}), [id]: { told: was, pending: text ? shownKey(rec) : null } }))
}

/** A prompt that carries thimble's report went: the versions waiting in it are the ones Claude knows now. */
export async function promptSent($: Engine): Promise<void> {
  await update($, TOLD, cur => Object.fromEntries(Object.entries((cur as Told | undefined) ?? {}).map(([id, t]) => [id, t.pending ? { told: t.pending, pending: null } : t])))
}

// ------------------------------------------------------------------------------------------------ the log

/** One line per call in the conversation's kept folder, squeeze.jsonl: its time, its tokens, what it wrote. */
async function log($: Engine, row: Record<string, unknown>): Promise<void> {
  try {
    const file = `${await keptDir($)}/squeeze.jsonl`
    const old = (await $.fs.exists(file)) ? String(await $.fs.read(file)) : ''
    await $.fs.write(file, old + JSON.stringify({ at: new Date(Number(await $.clock.now())).toISOString(), ...row }) + '\n')
  } catch {
    // the log is for measuring; the rewrite stands without it
  }
}

// ------------------------------------------------------------------------------------------------ the catch-up

export type Pile = { n: number; prompt: { row: string | null; text: string } | null; rows: string[]; replies: string[] }

/**
 * Replies piled up: two or more of Claude's replies (turns it ended with words) came since the person's last prompt
 * and since the newest catch-up of them the person read. Then s offers to catch up on all the replies since that
 * prompt (`n`). A catch-up dismissed after it showed counts as read; one undone or never written does not.
 */
export async function pileUp($: Engine, on: (key: string) => boolean = featureOn): Promise<Pile | null> {
  if (!on('squeeze')) return null
  const since = await sinceLast($)
  let from = 0
  for (let i = since.replies.length - 1; i >= 0; i--) {
    if ((await partNow($, since.replies[i]!)).cu) { from = i + 1; break }
  }
  return since.replies.length - from >= 2 ? { n: since.replies.length, ...since } : null
}

/** The catch-up on a reply, while it stands (not dismissed), or null. */
export async function catchUpOn($: Engine, row: string): Promise<Rec | null> {
  const rec = await recOf($, cuId(row))
  return rec && catchUpStands(rec) ? rec : null
}

/** The row a catch-up draws at: the newest of the messages it covers, so it stands last above the prompt. Its record
 *  stays on the newest reply (its host), where the keys find it. */
export const drawnAt = (rec: Rec): string => rec.catchup?.rows.at(-1) ?? rec.row

/** The catch-up drawn at `row` while it stands (whether or not a version of it is written yet), or null. */
export async function catchUpAt($: Engine, row: string): Promise<Rec | null> {
  const own = await catchUpOn($, row)
  if (own && drawnAt(own) === row) return own
  const host = (await partNow($, row)).inCatchUp
  const cu = host ? await catchUpOn($, host) : null
  return cu && drawnAt(cu) === row && cu.catchup?.rows.includes(row) ? cu : null
}

/**
 * A catch-up of Claude's messages `rows` (oldest first) since the person's last prompt: a record whose original is
 * those messages as written, one after another, first written at Length short (one call, as any chip change is). The
 * newest reply (`host`) keeps it; each other message names the host. It draws at the newest of the messages (drawnAt),
 * the last above the prompt, and every other message it covers draws no text while its version shows. Returns its id;
 * the first version is on its way.
 */
export async function catchUp($: Engine, o: { host: string; rows: string[]; replies: number; question: string; prompt: string | null }): Promise<string | null> {
  const texts: string[] = []
  for (const r of o.rows) {
    const m = await messageOf($, r)
    if (m?.text?.trim()) texts.push(m.text)
  }
  if (!texts.length || !(await messageOf($, o.host))) return null
  const id = cuId(o.host)
  const now = Number(await $.clock.now())
  await saveRec($, { id, row: o.host, text: catchUpText(texts), at: new Date(now).toISOString(), shown: null, squeeze: { at: {} }, catchup: { host: o.host, rows: [...o.rows], replies: o.replies, question: o.question, prompt: o.prompt } })
  for (const r of o.rows) if (r !== o.host) await setPart<SqPart>($, r, 'squeeze', cur => ({ ...(cur ?? {}), inCatchUp: o.host }))
  await setUi($, id, { running: null, error: null, reveal: null, want: null, asked: null })
  void setLevels($, id, { length: ARRIVE }).catch(() => undefined)
  return id
}

/**
 * A catch-up dismissed: drawn no more. One that never showed a version (`undo`: its key began a word; or its call
 * failed) is as if never made, so the replies it would have covered still count as not caught up on; one the person
 * read keeps its note for Claude unless `quiet`.
 */
export async function dismissCatchUp($: Engine, id: string, o: { undo?: boolean; quiet?: boolean } = {}): Promise<void> {
  const rec = await recOf($, id)
  if (!rec?.catchup) return
  const read = typeof rec.shown === 'string' && !o.undo
  const gone: Rec = { ...rec, catchup: { ...rec.catchup, dismissed: true } }
  // the cards back as the replies had them
  await showCards($, gone)
  for (const r of rec.catchup.rows) {
    if (r !== rec.row) await setPart<SqPart>($, r, 'squeeze', cur => {
      if (!cur || cur.inCatchUp !== rec.row) return cur
      const { inCatchUp: _gone, ...rest } = cur
      return Object.keys(rest).length ? rest : null
    })
  }
  if (!read) {
    await setPart<SqPart>($, rec.row, 'squeeze', cur => {
      if (!cur) return cur
      const { cu: _gone, ...rest } = cur
      return Object.keys(rest).length ? rest : null
    })
  } else await saveRec($, gone)
  // one Claude was told of: it hears the person went back to the replies; one never told: nothing (unless quiet,
  // as when a newer catch-up of the same replies takes its place)
  if (o.quiet) await tellAtNextPrompt($, `squeeze:${id}`, '')
  else if (read) await noteSettled($, id)
}

/** For tests: the module's memory, cleared. */
export function resetSqueeze(): void {
  latest.clear()
  inflight.clear()
  revealing.clear()
  cfg = {}
  viewCols = 100
}
