// term.ts: Squeeze in the terminal: the one call per change that rewrites the message in place, the new text writing
// itself in from the top, and the catch-up of replies that piled up. The chips
// themselves, their keys and presses, are a pane program (panes/chips.js) that both surfaces run; what it asks for
// (k.do('squeeze', {at | reset})) is done here. The shell (shell/shell.tsx) calls it; it imports the message
// layer's record functions from the shell (a cycle the module system resolves at call time).
//
// While a change is on its way the record says where the chips go (squeeze.want), and a failed call says why
// (squeeze.error), so the browser's chips show the same as the terminal's.
//
// A rewrite: one $.model.complete call (the registry's squeeze prompt, the question, the original, every chip's level),
// recorded in the session's events with the prompt version it used; the record's
// `shown` holds the result and its marks are placed again on it, citations kept; a state seen before comes back from
// the record with no call. While a call runs the old text dims and its first glyph turns; when the new text is there
// it writes itself in from the top at a model's pace, and nothing else is drawn for it.
//
// The chips belong to the whole answer, so with the squeeze switch for cards on (and a prompt version that knows
// cards), the request also shows the cards under the original and the query outputs they and the text draw on. A
// change of a card the reply asks for is saved through the kernel as the person's (`thimble save`): an edit is a new
// version of the same card, marked as an edit the analyst asked for; an add is a new card under the answer; a drop
// leaves one out of this version. A change that does not save or draw is left out, and the hint line says why. Each
// version keeps its cards, so a version seen before and the original (0) come back with theirs (showCards).
import type { EngineInterface } from 'claude-code'

import type { MsgRecord, ObjRef, SqzUi, Tray } from '../types'
import { promptText as registryText } from '../prompts/prompts'
import { newRecord, remark as remarkAny } from '../shell/message.js'
import { modelWhy } from '../shell/why.js'
import { tracked } from '../telemetry/telemetry'
import { FEATURES } from '../prompts/registry.mjs'
import { featureOn } from '../settings/features.mjs'
import { lookPending } from '../observer/observer'
import { answerRow, cardsUnder, closeTray, drawnTextOf, leanEnv, loadObject, prepared, questionBefore, recordNow, rootHere, saveRecord, setCardsUnder, tellMain } from '../shell/shell'
import { noteEdit } from '../shell/runtime'
import { sessionKey } from '../hooks/conversation'
import { ARRIVE, SCALE, answerText, applyRewrite, cardListsAt, cardSpec, cardsAfter, cardsKnown, catchUpText, checkRewrite, chipsOf, drawnOf, dropOrphanHeads, fromVersions, isCatchUp, isOriginal, keepCorrections, mustKeep, queryIdsOf, readReply, setWords, settledNote, shownKey, rebaseAt, request, restore, revealStep, rowsOf, termsOf, toolkitOf, unplacedMoves, withLater } from './chips.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Theme = 'dark' | 'light'
type At = Record<string, number>

const PICK = { plugin: 'thimble', key: 'pick' } as const
const TRAY = { plugin: 'thimble', key: 'tray' } as const

const SQZ = { plugin: 'thimble', key: 'sqz' } as const
// the rows whose shown version changed since Claude was told (tellSettled), and the version it was told of, by row
const SQZNOTE = { plugin: 'thimble', key: 'sqznote' } as const
const SQZTOLD = { plugin: 'thimble', key: 'sqztold' } as const
const remark = (rec: MsgRecord) => remarkAny(rec) as MsgRecord
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const DEFAULTS = { model: 'sonnet', effort: 'low', maxTokens: 4000, timeoutMs: 90000 }
const TICK = 50
// the longest a step on Interpretation or Background waits for the observer's look to say where the original stands
const LEVELS_WAIT_MS = 30000
const BLANK: SqzUi = { focus: 'length', running: null, error: null, tick: 0 }

// the module's memory: the call running per row and the one wanted after it; the text writing in per row; the
// prompt's text; the last screen size
const inflight = new Map<string, { want: Want | null }>()
const revealing = new Map<string, number>()
// `key`: the key the bar names for it ([ or ]), which presses it again after a failure; none for a press of the
// pointer or a catch-up's first version
type Want = { at: At; key?: string | null }
let cfg: Record<string, unknown> = {}
let view = { cols: 100, rows: 48 }

/** The screen the transcript draws on, as the last message drawn saw it: `6 of 33 lines` counts at its width. */
export function seeView(cols: number, rows: number): void {
  if (cols > 0 && rows > 0) view = { cols, rows }
}

async function uiOf($: Engine, row: string): Promise<SqzUi> {
  return (((await $.state.get({ ...SQZ, id: row })).value ?? null) as SqzUi | null) ?? { ...BLANK }
}
async function setUi($: Engine, row: string, change: Partial<SqzUi>): Promise<SqzUi> {
  const next = { ...(await uiOf($, row)), ...change }
  await $.state.set({ ...SQZ, id: row }, next)
  return next
}

async function ensure($: Engine): Promise<void> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  if (!Object.keys(cfg).length) {
    try { cfg = JSON.parse(String(await $.fs.read(`${dir}/squeeze/settings.json`))) } catch { cfg = {} }
  }
}

// ------------------------------------------------------------------------------------------------ the bar

/** What the bar shows for s: lit with the levels set (`short · interpret`) while the person has the message squeezed;
 *  else what the observer gave (dim when nothing), so a message as Claude wrote it reads `s squeeze`, however long. No
 *  line counts: the levels say what the person chose. A catch-up is squeezed by what it is. */
export function sLit(rec: MsgRecord, _ui: SqzUi | null): { lit: boolean; note: string } | null {
  if (isCatchUp(rec)) return null
  if (typeof rec.shown === 'string') return { lit: true, note: setWords(rec) || 'squeezed' }
  // (a record from before lit s with a count of lines: no line counts are said)
  const own = rec.verbs?.s
  return own?.lit && own.note && !/\blines?\b/.test(String(own.note)) ? { lit: true, note: String(own.note) } : null
}

/** Whether the message is drawn dim with a turning glyph: a rewrite of it is running. */
export function busyGlyph(ui: SqzUi | null): string | null {
  return ui?.running ? SPIN[(ui.tick || 0) % SPIN.length]! : null
}

/** How much of the shown text is drawn now: all of it (null), or the first `n` characters while it writes itself in. */
export function revealedOf(ui: SqzUi | null): number | null {
  return ui?.reveal ? ui.reveal.n : null
}

// ------------------------------------------------------------------------------------------------ the rewrite

/** What a failed rewrite says: what failed and why, then the key that tries again. */
export function failedWords(why: string, key?: string | null): string {
  return `The rewrite failed: ${why}. ${key ? `Press ${key} to try again` : 'Pick the level again to try again'}`
}

/** Where the chips of a row go, recorded at once (the chips and the browser read it), before the rewrite is asked:
 *  a key pressed right after reads the levels this one set. */
export async function wantLevels($: Engine, row: string, at: At): Promise<void> {
  await setUi($, row, { want: at, error: null })
  await markRecord($, row, { want: at, error: null })
}

/** Set the chips of a row to `at` and show that version: from the record when it was written before, else one call.
 *  Changes made while a call runs wait, and only the latest of them runs next. `key`: the key that asked for it. */
export async function setLevels($: Engine, row: string, at: At, key: string | null = null): Promise<void> {
  // the chips show where they go at once (here, and in the browser from the record), and the message says it is being
  // rewritten (asked: since when, from the first key of a run of them); the text follows
  await setUi($, row, { want: at, error: null })
  await markRecord($, row, { want: at, error: null })
  if (!(await uiOf($, row)).asked) await setUi($, row, { asked: await $.clock.now() })
  const job = inflight.get(row)
  if (job) {
    job.want = { at, key }
    return
  }
  inflight.set(row, { want: null })
  try {
    let next: Want | null = { at, key }
    while (next) {
      next = { at: await fromObserved($, row, next.at), key: next.key }
      await once($, row, next)
      const j = inflight.get(row)!
      next = j.want
      j.want = null
      // a change pressed while that call ran: the chips show where it goes again, since the call may have read the
      // record before the press and saved it without
      if (next) {
        await setUi($, row, { want: next.at })
        await markRecord($, row, { want: next.at, error: null })
      }
    }
  } finally {
    inflight.delete(row)
    await setUi($, row, { running: null, want: null, asked: null })
    await markRecord($, row, { want: null, error: (await uiOf($, row)).error ?? null })
  }
}

/**
 * A step on Interpretation or Background of the latest answer, made before the observer said where the original
 * stands on it, while its look still runs: it waits for that look (at most LEVELS_WAIT_MS) and then counts from the
 * level the look gave, so a change never starts from the chip's middle when the look is about to say otherwise. A
 * change of Length alone, or of a chip already placed, goes at once. Returns the levels to write.
 */
async function fromObserved($: Engine, row: string, at: At): Promise<At> {
  const rec = await recordNow($, row)
  if (!rec || !unplacedMoves(rec, at).length) return at
  const look = row === (await answerRow($)) ? lookPending() : null
  if (!look) return at
  await Promise.race([look, new Promise<void>(done => { $.clock.after(LEVELS_WAIT_MS, () => done()) })])
  const now = (await recordNow($, row)) || rec
  const to = rebaseAt(rec, now, at) as At
  // a change pressed while this one waited counted from the middle too; the chips show the latest, as counted now
  const j = inflight.get(row)
  if (j?.want) j.want = { at: rebaseAt(rec, now, j.want.at) as At }
  const shows = j?.want?.at ?? to
  await setUi($, row, { want: shows })
  await markRecord($, row, { want: shows, error: null })
  return to
}

/** The record's squeeze with `want` (where the chips go) and `error` (why the last call failed) set or cleared. */
async function markRecord($: Engine, row: string, m: { want: At | null; error: string | null }): Promise<void> {
  const rec = await recordNow($, row)
  if (!rec) return
  const s = { ...(((rec as Any).squeeze ?? {}) as Any) }
  const was = JSON.stringify({ w: s.want ?? null, e: s.error ?? null })
  if (m.want) s.want = m.want
  else delete s.want
  if (m.error) s.error = m.error
  else delete s.error
  if (JSON.stringify({ w: s.want ?? null, e: s.error ?? null }) === was) return
  await saveRecord($, { ...rec, squeeze: s } as MsgRecord)
}

async function once($: Engine, row: string, want: Want): Promise<void> {
  const rec = await recordNow($, row)
  if (!rec) return
  const s = ((rec as Any).squeeze ?? {}) as Any
  // (want.at is on the chips' scales now)
  const probe = { ...rec, squeeze: { ...s, at: want.at, scale: SCALE } } as MsgRecord
  const chips = chipsOf(probe)
  const hit = isOriginal(chips) ? restore(probe, remark) : fromVersions(rec, want.at, remark)
  if (hit) { await settled($, row, hit as MsgRecord); return }
  await ensure($)
  // a short wait before a call, so keys pressed in a row are written once, at the last level (settings.json settleMs)
  const wait = Number(cfg.settleMs || 0)
  if (wait > 0) {
    await new Promise<void>(done => { $.clock.after(wait, () => done()) })
    if (inflight.get(row)?.want) return
    // a catch-up undone meanwhile (its s began a word) is written by no call
    if ((await recordNow($, row))?.catchup?.dismissed) return
  }
  revealing.delete(row)
  await setUi($, row, { running: { since: await $.clock.now() }, error: null, reveal: null })
  const ticker = tick($, row)
  try {
    // a catch-up answers the person's last prompt, whatever notification or hand-back came after it
    const question = isCatchUp(rec) ? String(rec.catchup!.question || '') : await questionBefore($, row).catch(() => '')
    const sp = await registryText($, 'squeeze')
    // a version that keeps corrections (squeeze:v4): the corrections in the original are named in the request, and one
    // the rewrite left out is put back after it
    const keeps = !!(FEATURES.squeeze.versions as Any)?.[sp.version]?.keep
    const keep: string[] = keeps ? mustKeep(rec.text) : []
    // a version that keeps the terms of the explain marks (squeeze:v5): the terms are named in the request
    const terms: string[] = (FEATURES.squeeze.versions as Any)?.[sp.version]?.terms ? termsOf(rec) : []
    // the answer's cards and the outputs they draw on, for a version that may change them (squeeze:v8, and the switch)
    const answer = featureOn('squeezeCards') && (FEATURES.squeeze.versions as Any)?.[sp.version]?.cards ? await answerCards($, rec).catch(() => null) : null
    const toolkit = answer ? toolkitOf((await registryText($, 'forms').catch(() => ({ text: '' }))).text) : ''
    const req = request(probe, {
      system: sp.text, toolkit, question, keep, terms, cards: answer?.cards ?? [], outputs: answer?.outputs ?? [],
      model: String(cfg.model || DEFAULTS.model), effort: String(cfg.effort || DEFAULTS.effort),
      maxTokens: Number(cfg.maxTokens || DEFAULTS.maxTokens), timeoutMs: Number(cfg.timeoutMs || DEFAULTS.timeoutMs),
    })
    const t0 = await $.clock.now()
    const r = await tracked($, { feature: 'squeeze', prompt: sp.id, model: req.model, extra: { row, key: Object.entries(want.at).map(([k, v]) => `${k}=${v}`).join(','), ...(answer ? { cards: answer.cards.length } : {}) } }, () => $.model.complete(req as Any))
    const ms = (await $.clock.now()) - t0
    if (!r.isAnswered) {
      const why = modelWhy(r)
      await setUi($, row, { error: failedWords(why, want.key) })
      await log($, { row, ok: false, why, reason: r.reason, ...(r.reason === 'api-error' ? { status: (r as Any).status ?? null, error: (r as Any).error ?? null } : {}), ms })
      return
    }
    const reply = readReply(r.text)
    if (!reply.text.trim()) {
      await setUi($, row, { error: failedWords('the model wrote no text', want.key) })
      return
    }
    // a heading the rewrite ends on, with nothing under it, promises what the text does not give: dropped before a
    // correction is put back after it, and after
    const bare = dropOrphanHeads(reply.text)
    const back = keeps ? keepCorrections(bare.text, keep, rec.text) : { text: bare.text, back: [] }
    const whole = dropOrphanHeads(back.text)
    whole.dropped.unshift(...bare.dropped)
    // held to the whole answer it was shown: the message, and its cards' words and values when the request had them
    const checked = checkRewrite(answerText(rec.text, answer?.cards ?? []), whole.text)
    // the cards this version changes, saved as the person's; one that does not save or draw is left out, said why
    const changed = answer && reply.cards.length ? await applyCards($, answer, reply.cards, setWords(probe) || 'as written') : null
    const cardProblems = answer ? [...reply.cardProblems, ...(changed?.problems ?? [])] : []
    const cards = answer && changed?.done.length ? cardsAfter(answer.orig, row, changed.done) : null
    // the record as it is now (the observer may have written its verbs and glosses meanwhile)
    const fresh = (await recordNow($, row)) || rec
    const fs = ((fresh as Any).squeeze ?? {}) as Any
    const next = applyRewrite({ ...fresh, squeeze: { ...fs, own: fs.own ?? s.own } } as MsgRecord, {
      text: checked.text, at: want.at,
      made: { ms, model: req.model, usage: (r as Any).usage, at: new Date(t0).toISOString(), prompt: sp.id }, problems: [...checked.problems, ...cardProblems],
      cards, origCards: answer ? answer.orig : null,
    }, remark) as MsgRecord
    ticker.stop()
    await setUi($, row, { running: null })
    await settled($, row, next)
    await log($, { row, ok: true, ms, model: req.model, effort: req.effort, chars: { system: req.system.reduce((n, b) => n + b.text.length, 0), prompt: req.prompt.reduce((n, b) => n + b.text.length, 0) }, prompt: sp.id, usage: (r as Any).usage, key: Object.entries(want.at).map(([k, v]) => `${k}=${v}`).join(','), problems: checked.problems, rows: rowsOf(checked.text, view.cols), of: rowsOf(rec.text, view.cols), ...(keep.length ? { keep: keep.length, put_back: back.back.length } : {}), ...(whole.dropped.length ? { orphan_heads: whole.dropped.length } : {}), ...(terms.length ? { terms: terms.length } : {}), ...(isCatchUp(rec) ? { catchup: rec.catchup!.replies } : {}), ...(answer ? { cards: answer.cards.length, outputs: answer.outputs.length, asked: reply.cards.map(c => `${c.op} ${c.id}`), did: (cards?.did ?? []).map(d => `${d.did} ${d.id}`), card_problems: cardProblems, ...(changed?.unknown.length ? { unknown_cards: changed.unknown } : {}) } : {}) })
  } finally {
    ticker.stop()
  }
}

/** A version shown: the record kept, the new text writing itself in from the top, the tray off this row's moved marks,
 *  and the row marked for Claude to hear of once the person settles on a version (tellSettled). */
async function settled($: Engine, row: string, rec: MsgRecord): Promise<void> {
  const before = await recordNow($, row)
  await saveRecord($, rec)
  await showCards($, rec)
  await closeTrayOn($, row)
  await markChanged($, row)
  const was = before ? (typeof before.shown === 'string' ? before.shown : before.text) : ''
  const now = typeof rec.shown === 'string' ? rec.shown : rec.text
  if (now !== was) await writeIn($, row, now.length)
}

/** The new text writes itself in from the top: a few characters more at each tick, at a model's pace, until it is
 *  whole. A later change starts its own. */
async function writeIn($: Engine, row: string, total: number): Promise<void> {
  const token = (revealing.get(row) ?? 0) + 1
  revealing.set(row, token)
  const step = revealStep(total, TICK)
  await setUi($, row, { reveal: { n: Math.min(total, step), total } })
  const next = () => {
    void (async () => {
      if (revealing.get(row) !== token) return
      const ui = await uiOf($, row)
      const n = (ui.reveal?.n ?? total) + step
      if (n >= total) { revealing.delete(row); await setUi($, row, { reveal: null }); return }
      await setUi($, row, { reveal: { n, total } })
      $.clock.after(TICK, next)
    })()
  }
  $.clock.after(TICK, next)
}

/** The tray closes when it stands on a mark of this row: the marks moved. It closes as esc closes it, so the focus
 *  stack and the browser's tray follow. */
async function closeTrayOn($: Engine, row: string): Promise<void> {
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const b = tray?.stack?.[0]
  if (b && b.row === row) await closeTray($)
}

/** The glyph that turns while a call runs: the row redraws a few times a second, and only while it runs. */
function tick($: Engine, row: string): { stop: () => void } {
  let on = true
  const step = () => {
    if (!on) return
    void (async () => {
      const ui = await uiOf($, row)
      if (!on || !ui.running) return
      await $.state.set({ ...SQZ, id: row }, { ...ui, tick: (ui.tick || 0) + 1 })
      $.clock.after(160, step)
    })()
  }
  $.clock.after(160, step)
  return { stop: () => { on = false } }
}

/** A row whose shown version changed: Claude hears of it once the person settles (tellSettled). */
export async function markChanged($: Engine, row: string): Promise<void> {
  const rows = (((await $.state.get(SQZNOTE)).value ?? {}) as Record<string, true>)
  if (!rows[row]) await $.state.set(SQZNOTE, { ...rows, [row]: true })
}

/**
 * The versions the person settled on, told to Claude: for each row whose shown version changed since Claude was last
 * told (or only `row`), one row of main's transcript that Claude reads and the person never sees, holding the version
 * they read whole (chips.mjs settledNote). Called when the chips close and before the person's next prompt, so a
 * version is told once, not at each key. A version back at the original is told only after another was.
 */
export async function tellSettled($: Engine, row: string | null = null): Promise<void> {
  const rows = (((await $.state.get(SQZNOTE)).value ?? {}) as Record<string, true>)
  const which = row ? (rows[row] ? [row] : []) : Object.keys(rows)
  if (!which.length) return
  const told = { ...(((await $.state.get(SQZTOLD)).value ?? {}) as Record<string, string>) }
  const left = { ...rows }
  for (const r of which) {
    delete left[r]
    // a rewrite still on its way: told when it lands and the person settles again
    if (inflight.has(r)) { left[r] = true; continue }
    const rec = await recordNow($, r)
    if (!rec) continue
    const text = settledNote(rec, told[r] ?? 'orig')
    told[r] = shownKey(rec)
    if (text) await tellMain($, text)
  }
  await $.state.set(SQZNOTE, left)
  await $.state.set(SQZTOLD, told)
}

// ------------------------------------------------------------------------------------------------ the cards

type CardIn = { id: string; title: string; text: string; data: unknown; program: string; drawn: string; ref: ObjRef; source: Any }
type Answer = { orig: Record<string, ObjRef[]>; cards: CardIn[]; outputs: { id: string; about: string; text: string }[]; root: string }

/** At most this many query outputs go with a request, each cut to this many characters. */
const MAX_OUTPUTS = 6
const OUTPUT_CHARS = 2400

/**
 * The cards of an answer as its original has them, by row (the message's own row; a catch-up's replies and its own
 * row), each at the version it had, and the query outputs they bind and the text cites, as Claude read them when it ran
 * each one. Null when the answer has neither: then the request shows no cards.
 */
async function answerCards($: Engine, rec: MsgRecord): Promise<Answer | null> {
  const s = ((rec as Any).squeeze ?? {}) as Any
  const rows = isCatchUp(rec) ? [...rec.catchup!.rows, rec.row] : [rec.row]
  const orig: Record<string, ObjRef[]> = {}
  if (s.orig?.cards && typeof s.orig.cards === 'object') Object.assign(orig, s.orig.cards)
  else for (const r of rows) { const l = await cardsUnder($, r); if (l.length) orig[r] = l }
  const cards: CardIn[] = []
  const binds: string[] = []
  for (const ref of Object.values(orig).flat()) {
    const o = await loadObject($, ref).catch(() => null)
    if (!o || o.label) continue
    const src = (o.source && typeof o.source === 'object' ? o.source : {}) as Any
    cards.push({ id: String(o.id), title: String(o.title ?? src.title ?? ''), text: String(src.text ?? o.text ?? ''), data: src.data ?? {}, program: String(src.program ?? o.program ?? ''), drawn: `${drawnOf(o)}\n${await drawnTextOf($, ref).catch(() => '')}`, ref, source: src })
    for (const b of (o.lineage?.bindings ?? []) as Any[]) if (typeof b?.ref === 'string') binds.push(b.ref)
  }
  const root = Object.values(orig).flat()[0]?.root ?? (await rootHere($))
  if (!root) return null
  const outputs: Answer['outputs'] = []
  for (const id of queryIdsOf([rec.text, ...cards.map(c => c.text)], binds).slice(0, MAX_OUTPUTS)) {
    try {
      const q = JSON.parse(String(await $.fs.read(`${root}/thimble/queries/${id}.json`)))
      const out = String(q?.stdout ?? '').replace(/^\s*\n|\s+$/g, '')
      if (out) outputs.push({ id, about: String(q.about ?? ''), text: out.length > OUTPUT_CHARS ? `${out.slice(0, OUTPUT_CHARS)}\n(cut here; the output has more)` : out })
    } catch {
      // a query the kernel no longer has: its cards still show
    }
  }
  if (!cards.length && !outputs.length) return null
  return { orig, cards, outputs, root }
}

/** A name for a new card that no card of the folder has yet: the reply's name as the kernel spells it, with -2, -3
 *  after it when taken. */
async function freshName($: Engine, root: string, name: string): Promise<string> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card'
  const have = new Set(((await $.fs.list(`${root}/thimble/objects`).catch(() => [])) as { name: string }[]).map(x => x.name.replace(/\.json$/, '').replace(/^\d+-/, '')))
  let out = slug
  for (let i = 2; have.has(out); i++) out = `${slug}-${i}`
  return out
}

/**
 * The card changes of a reply, made as the person's: each edit saved as a new version of its card (the original's
 * spec with the new parts laid over it), and marked as a change the analyst asked for (its detail says "edited"); each
 * add saved as a new card; each drop only noted. A save that fails, or a card that does not draw after it, is left out
 * with a problem that says why. Returns what held, in order, and the problems.
 */
async function applyCards($: Engine, answer: Answer, changes: Any[], levels: string): Promise<{ done: Any[]; problems: string[]; unknown: string[] }> {
  const done: Any[] = []
  const problems: string[] = []
  const unknown: string[] = []
  const bin = `${$.plugin.root.replace(/\/+$/, '')}/bin/thimble`
  for (const c of changes) {
    const card = answer.cards.find(x => x.id === c.id) ?? null
    // a card the request never showed: nothing to change, and nothing the person asked for failed (the log keeps it)
    if (c.op !== 'add' && !card) { unknown.push(String(c.id).slice(0, 60)); continue }
    if (c.op === 'drop') { done.push({ op: 'drop', id: card!.id, title: card!.title }); continue }
    const spec = cardSpec(c, card?.source ?? {})
    const name = c.op === 'edit' ? card!.id : await freshName($, answer.root, String(c.id))
    const what = c.op === 'edit' ? `the change to "${card!.title}"` : `the new card "${String(spec.title || c.id).slice(0, 50)}"`
    let saved: { id: string; v: number } | null = null
    let out = ''
    try {
      // the spec in a file of thimble's own (the kernel reads stdin only when something waits on it)
      const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
      const file = `${home.replace(/\/+$/, '')}/lean/squeeze-cards/${name}.json`
      await $.fs.write(file, JSON.stringify(spec, null, 1))
      const r = await $.process.run([bin, 'save', name, '--from', file, '--change', `squeeze: ${levels}`], { cwd: answer.root, env: await leanEnv($, answer.root), timeoutMs: 90000 })
      out = String(r.stdout || '')
      const m = /^saved (\S+) v(\d+):/m.exec(out)
      if (r.exitCode === 0 && m) saved = { id: m[1]!, v: Number(m[2]) }
      else out = (out + String(r.stderr || '')).trim()
    } catch (err) {
      out = String((err as Error)?.message || err)
    }
    if (!saved) { problems.push(`${what} could not be saved (${out.split('\n')[0]!.slice(0, 120) || 'no answer from thimble'}), so ${c.op === 'edit' ? 'the card stays as it was' : 'it was left out'}`); continue }
    const ref = { id: saved.id, v: saved.v, root: answer.root }
    const p = await prepared($, ref, 96).catch(err => ({ error: String((err as Error)?.message || err) }) as Any)
    const broke = p.error || !p.grid ? String(p.error || 'no drawing') : p.drawing?.error ? `${p.drawing.error.name}: ${p.drawing.error.message}` : null
    if (broke) { problems.push(`${what} did not draw (${broke.slice(0, 120)}), so ${c.op === 'edit' ? 'the card stays as it was' : 'it was left out'}`); continue }
    for (const m of out.matchAll(/^\s+problem: (.+)$/gm)) problems.push(`card ${saved.id}: ${m[1]!.slice(0, 160)}`)
    if (c.op === 'edit') await noteEdit($, answer.root, saved.id, saved.v)
    done.push({ op: c.op, id: c.op === 'edit' ? card!.id : saved.id, ref, title: c.op === 'edit' ? card!.title : String(spec.title || saved.id) })
  }
  return { done, problems, unknown }
}

/** The cards a record's version shows, drawn under their rows: the version's when it changed one, else the
 *  original's, with any card drawn there since that the squeeze never touched kept after them. Nothing for a record
 *  no rewrite ever changed a card of. */
export async function showCards($: Engine, rec: MsgRecord): Promise<void> {
  const want = cardListsAt(rec) as Record<string, ObjRef[]> | null
  if (!want) return
  const s = ((rec as Any).squeeze ?? {}) as Any
  const rows = new Set<string>([...Object.keys(s.orig?.cards ?? {}), ...Object.values((s.cards ?? {}) as Record<string, Any>).flatMap(v => Object.keys(v?.rows ?? {}))])
  const known = cardsKnown(rec) as ObjRef[]
  for (const r of rows) await setCardsUnder($, r, withLater(await cardsUnder($, r), want[r] ?? [], known) as ObjRef[])
}

/** One line per call in $THIMBLE_HOME/lean/squeeze.jsonl: its time, its tokens, what it wrote. */
async function log($: Engine, row: Record<string, unknown>): Promise<void> {
  try {
    const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
    const file = `${home.replace(/\/+$/, '')}/lean/squeeze.jsonl`
    const old = (await $.fs.exists(file)) ? String(await $.fs.read(file)) : ''
    await $.fs.write(file, old + JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), ...row }) + '\n')
  } catch {
    // the log is for measuring; the rewrite stands without it
  }
}

// ------------------------------------------------------------------------------------------------ the catch-up

/**
 * A catch-up of Claude's messages `rows` (oldest first) since the person's last prompt, drawn in their place: a record
 * of its own whose original is those messages as written, one after another, first written at Length short (one call,
 * as any chip change is). The newest reply (`host`) names it and draws it; each other message names it as the one it
 * is in, and draws no text of its own while its version shows. A resumed session finds it the same way. Returns its
 * row; the first version is on its way (the host says it is being written).
 */
export async function catchUp($: Engine, o: { host: string; rows: string[]; replies: number; question: string; prompt: string | null }): Promise<string | null> {
  const texts: string[] = []
  for (const r of o.rows) {
    const rec = await recordNow($, r)
    if (rec?.text?.trim()) texts.push(rec.text)
  }
  const host = await recordNow($, o.host)
  if (!texts.length || !host) return null
  const now = await $.clock.now()
  const row = `cu-${o.host.slice(0, 8)}-${Math.floor(now).toString(36)}`
  const made = newRecord({ row, session: await sessionKey($), text: catchUpText(texts), at: new Date(now).toISOString() }) as MsgRecord
  await saveRecord($, { ...made, catchup: { host: o.host, rows: [...o.rows], replies: o.replies, question: o.question, prompt: o.prompt }, squeeze: { at: {} } } as MsgRecord)
  await saveRecord($, { ...host, caughtUp: row } as MsgRecord)
  for (const r of o.rows) {
    if (r === o.host) continue
    const rec = await recordNow($, r)
    if (rec) await saveRecord($, { ...rec, inCatchUp: row } as MsgRecord)
  }
  void setLevels($, row, { length: ARRIVE }).catch(() => undefined)
  return row
}

/**
 * A catch-up dismissed: drawn no more. One that never showed a version (`undo`: its key began a word; or its call
 * failed) is as if never made, so the replies it would have covered still count as not caught up on; one the person
 * read keeps its note for Claude unless `quiet`.
 */
export async function dismissCatchUp($: Engine, row: string, o: { undo?: boolean; quiet?: boolean } = {}): Promise<void> {
  const rec = await recordNow($, row)
  if (!rec || !isCatchUp(rec)) return
  const read = typeof rec.shown === 'string' && !o.undo
  const gone = { ...rec, catchup: { ...rec.catchup!, dismissed: true } } as MsgRecord
  await saveRecord($, gone)
  // the cards back as the replies had them
  await showCards($, gone)
  if (!read) {
    const host = await recordNow($, rec.catchup!.host)
    if (host && host.caughtUp === row) {
      const { caughtUp: _gone, ...rest } = host
      await saveRecord($, rest as MsgRecord)
    }
  }
  // one Claude was told of: it hears the person went back to the replies; one never told: nothing (unless quiet,
  // as when a newer catch-up of the same replies takes its place)
  if (o.quiet) {
    const notes = (((await $.state.get(SQZNOTE)).value ?? {}) as Record<string, true>)
    const { [row]: _drop, ...keep } = notes
    await $.state.set(SQZNOTE, keep)
  } else await markChanged($, row)
}

/** For tests: the module's memory, cleared. */
export function resetSqueeze(): void {
  inflight.clear()
  revealing.clear()
  cfg = {}
  view = { cols: 100, rows: 48 }
}
