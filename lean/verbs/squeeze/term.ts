// term.ts: Squeeze in the terminal: the one call per change that rewrites the message in place, the new text writing
// itself in from the top, the stretch typed in the prompt, and the long message that arrives squeezed. The chips
// themselves, their keys and presses, are a pane program (panes/chips.js) that both surfaces run; what it asks for
// (k.do('squeeze', {at | reset | stretch})) is done here. The shell (shell/shell.tsx) calls it; it imports the message
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
import type { EngineInterface } from 'claude-code'

import type { MsgRecord, SqzUi, Tray } from '../../types'
import { promptText as registryText } from '../../prompts/prompts'
import { remark as remarkAny } from '../../shell/message.js'
import { tracked } from '../../telemetry/telemetry'
import { FEATURES } from '../../prompts/registry.mjs'
import { claimsStore, questionBefore, recordNow, saveRecord } from '../../shell/shell'
import { ARRIVE, applyRewrite, checkRewrite, chipsOf, endsOf, fromVersions, isLong, isOriginal, keepCorrections, mustKeep, noteFor, noteOf, readReply, request, restore, revealStep, rowsOf, stretchChip, termsOf, withStretch } from './chips.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Theme = 'dark' | 'light'
type At = Record<string, number>

const PICK = { plugin: 'thimble-lean', key: 'pick' } as const
const TRAY = { plugin: 'thimble-lean', key: 'tray' } as const

const SQZ = { plugin: 'thimble-lean', key: 'sqz' } as const
const SQZNOTE = { plugin: 'thimble-lean', key: 'sqznote' } as const
const remark = (rec: MsgRecord) => remarkAny(rec) as MsgRecord
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const DEFAULTS = { model: 'sonnet', effort: 'low', maxTokens: 4000, timeoutMs: 90000 }
const TICK = 50
const BLANK: SqzUi = { focus: 'length', adding: false, running: null, error: null, tick: 0 }

// the module's memory: the call running per row and the one wanted after it; the text writing in per row; the
// prompt's text; the last screen size
const inflight = new Map<string, { want: Want | null }>()
const revealing = new Map<string, number>()
type Want = { at: At }
let cfg: Record<string, unknown> = {}
let view = { cols: 100, rows: 48 }

/** The screen the transcript draws on, as the last message drawn saw it: a long message takes more than half of it. */
export function seeView(cols: number, rows: number): void {
  if (cols > 0 && rows > 0) view = { cols, rows }
}
// half a screen, the room an object under a reply takes before the rest waits in its detail view (lean's calm rule)
const roomNow = () => ({ cols: Math.max(20, view.cols - 3), room: Math.max(16, Math.floor(view.rows * 0.55)) })

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
    try { cfg = JSON.parse(String(await $.fs.read(`${dir}/verbs/squeeze/verb.json`))) } catch { cfg = {} }
  }
}

// ------------------------------------------------------------------------------------------------ the verb row

/** What the verb row shows for s: lit with `6 of 33 lines` while the message is squeezed, `33 lines` for a long
 *  original; else what the observer gave (dim when nothing). */
export function sLit(rec: MsgRecord, _ui: SqzUi | null): { lit: boolean; note: string } | null {
  const cols = view.cols
  if (typeof rec.shown === 'string') return { lit: true, note: noteOf(rec, cols) }
  if ((rec as Any).squeeze?.auto || isLong(rec.text, roomNow())) return { lit: true, note: `${rowsOf(rec.text, cols)} lines` }
  const own = rec.verbs?.s
  return own?.lit && own.note ? { lit: true, note: String(own.note) } : null
}

/** Whether the message is drawn dim with a turning glyph: a rewrite of it is running. */
export function busyGlyph(ui: SqzUi | null): string | null {
  return ui?.running ? SPIN[(ui.tick || 0) % SPIN.length]! : null
}

/** How much of the shown text is drawn now: all of it (null), or the first `n` characters while it writes itself in. */
export function revealedOf(ui: SqzUi | null): number | null {
  return ui?.reveal ? ui.reveal.n : null
}

/** The squeeze amber of the stretch typed in the prompt, per theme. */
const amber = (theme: Theme) => (theme === 'light' ? '#9a6412' : '#e0a43a')

/** After an edit of the prompt while the person types a stretch: it is still being typed while the prompt starts with
 *  +. Returns the decorations that color it and show what is left to type (` between … and …`, then ` and …`). */
export async function afterEdit($: Engine, row: string | null, text: string, theme: Theme = 'dark'): Promise<Any[] | null> {
  if (!row) return null
  const ui = (await $.state.get({ ...SQZ, id: row })).value as SqzUi | null | undefined
  if (!ui?.adding) return null
  if (!text.startsWith('+')) { await setUi($, row, { adding: false, typing: '' }); return null }
  await setUi($, row, { typing: text })
  const out: Any[] = [{ start: 0, end: text.length, color: amber(theme) }]
  const ends = endsOf(text)
  if (!ends) out.push({ start: text.length, end: text.length, virtualText: ' between … and …', dimColor: true })
  else if (ends.from === 'as written' && !/\s$/.test(text)) out.push({ start: text.length, end: text.length, virtualText: ' and …', dimColor: true })
  return out
}

/** The person starts a stretch (the chips' + asked for it): the + they pressed stays in the prompt, and they type the
 *  two ends after it; afterEdit colors it, and ↵ makes the stretch (addStretch). */
export async function startStretch($: Engine, row: string): Promise<void> {
  await setUi($, row, { adding: true, error: null, typing: '+' })
}

/** The person stopped typing a stretch, or closed the chips. */
export async function stopStretch($: Engine, row: string): Promise<void> {
  await setUi($, row, { adding: false, typing: '' })
}

/**
 * A stretch's two ends, as the person typed them after the + (in the prompt here, in a field in the browser): a chip
 * that stands at the original, so the next < > rewrites the text toward an end; no call is made now. Returns what the
 * prompt's drop line says, or a problem.
 */
export async function addStretch($: Engine, row: string, text: string): Promise<{ said?: string; problem?: string }> {
  const rec = await recordNow($, row)
  if (!rec) return { problem: 'that message is not in this session' }
  const chip = stretchChip(rec, text)
  if (!chip) { await stopStretch($, row); return { problem: 'a stretch needs two ends, such as "+engineer and manager"' } }
  const squeeze = withStretch(rec, chip)
  await saveRecord($, { ...rec, squeeze } as MsgRecord)
  await setUi($, row, { adding: false, typing: '', error: null })
  return { said: `stretch ${chip.from} ↔ ${chip.to}` }
}

// ------------------------------------------------------------------------------------------------ the rewrite

/** Set the chips of a row to `at` and show that version: from the record when it was written before, else one call.
 *  Changes made while a call runs wait, and only the latest of them runs next. */
export async function setLevels($: Engine, row: string, at: At): Promise<void> {
  // the chips show where they go at once (here, and in the browser from the record); the text follows
  await setUi($, row, { want: at, error: null })
  await markRecord($, row, { want: at, error: null })
  const job = inflight.get(row)
  if (job) {
    job.want = { at }
    return
  }
  inflight.set(row, { want: null })
  try {
    let next: Want | null = { at }
    while (next) {
      await once($, row, next)
      const j = inflight.get(row)!
      next = j.want
      j.want = null
    }
  } finally {
    inflight.delete(row)
    await setUi($, row, { running: null, want: null })
    await markRecord($, row, { want: null, error: (await uiOf($, row)).error ?? null })
  }
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
  const probe = { ...rec, squeeze: { ...s, at: want.at } } as MsgRecord
  const chips = chipsOf(probe)
  const hit = isOriginal(chips) ? restore(probe, remark) : fromVersions(rec, want.at, remark)
  if (hit) { await settled($, row, hit as MsgRecord); return }
  await ensure($)
  // a short wait before a call, so keys pressed in a row are written once, at the last level (verb.json settleMs)
  const wait = Number(cfg.settleMs || 0)
  if (wait > 0) {
    await new Promise<void>(done => { $.clock.after(wait, () => done()) })
    if (inflight.get(row)?.want) return
  }
  revealing.delete(row)
  await setUi($, row, { running: { since: await $.clock.now() }, error: null, reveal: null })
  const ticker = tick($, row)
  try {
    const question = await questionBefore($, row).catch(() => '')
    const sp = await registryText($, 'squeeze')
    // a version that keeps corrections (squeeze:v4): the corrections in the original are named in the request, and one
    // the rewrite left out is put back after it
    const keeps = !!(FEATURES.squeeze.versions as Any)?.[sp.version]?.keep
    const keep: string[] = keeps ? mustKeep(rec.text, { claims: await claimsStore($).catch(() => null), row }) : []
    // a version that keeps the terms of the explain marks (squeeze:v5): the terms are named in the request
    const terms: string[] = (FEATURES.squeeze.versions as Any)?.[sp.version]?.terms ? termsOf(rec) : []
    const req = request(probe, {
      system: sp.text, question, keep, terms,
      model: String(cfg.model || DEFAULTS.model), effort: String(cfg.effort || DEFAULTS.effort),
      maxTokens: Number(cfg.maxTokens || DEFAULTS.maxTokens), timeoutMs: Number(cfg.timeoutMs || DEFAULTS.timeoutMs),
    })
    const t0 = await $.clock.now()
    const r = await tracked($, { feature: 'squeeze', prompt: sp.id, model: req.model, extra: { row, key: Object.entries(want.at).map(([k, v]) => `${k}=${v}`).join(',') } }, () => $.model.complete(req as Any))
    const ms = (await $.clock.now()) - t0
    if (!r.isAnswered) {
      const why = r.reason === 'api-error' ? `the API answered ${(r as Any).status ?? ''} ${(r as Any).error ?? ''}`.trim() : r.reason
      await setUi($, row, { error: `the rewrite did not come back (${why}) · press the key again to retry · 0 original` })
      await log($, { row, ok: false, why, ms })
      return
    }
    const reply = readReply(r.text)
    if (!reply.text.trim()) {
      await setUi($, row, { error: 'the rewrite came back empty · press the key again to retry · 0 original' })
      return
    }
    const back = keeps ? keepCorrections(reply.text, keep) : { text: reply.text, back: [] }
    const checked = checkRewrite(rec.text, back.text)
    // the record as it is now (the observer may have written its verbs and glosses meanwhile)
    const fresh = (await recordNow($, row)) || rec
    const fs = ((fresh as Any).squeeze ?? {}) as Any
    const next = applyRewrite({ ...fresh, squeeze: { ...fs, own: fs.own ?? s.own } } as MsgRecord, {
      text: checked.text, at: want.at,
      made: { ms, model: req.model, usage: (r as Any).usage, at: new Date(t0).toISOString(), prompt: sp.id }, problems: checked.problems,
    }, remark) as MsgRecord
    ticker.stop()
    await setUi($, row, { running: null })
    await settled($, row, next)
    await log($, { row, ok: true, ms, model: req.model, prompt: sp.id, usage: (r as Any).usage, key: Object.entries(want.at).map(([k, v]) => `${k}=${v}`).join(','), problems: checked.problems, rows: rowsOf(checked.text, view.cols), of: rowsOf(rec.text, view.cols), ...(keep.length ? { keep: keep.length, put_back: back.back.length } : {}), ...(terms.length ? { terms: terms.length } : {}) })
  } finally {
    ticker.stop()
  }
}

/** A version shown: the record kept, the new text writing itself in from the top, the tray off this row's moved marks,
 *  and Claude told which version the person reads. */
async function settled($: Engine, row: string, rec: MsgRecord): Promise<void> {
  const before = await recordNow($, row)
  await saveRecord($, rec)
  await closeTrayOn($, row)
  const notes = (((await $.state.get(SQZNOTE)).value ?? {}) as Record<string, string>)
  await $.state.set(SQZNOTE, { ...notes, [row]: noteFor(rec) })
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

/** The tray closes when it stands on a mark of this row: the marks moved. */
async function closeTrayOn($: Engine, row: string): Promise<void> {
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const b = tray?.stack?.[0]
  if (b && b.row === row) await $.state.set(TRAY, null)
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

/** The notes for Claude of every version the person changed to since its last reply: given with the next prompt. */
export async function takeNotes($: Engine): Promise<string[]> {
  const notes = (((await $.state.get(SQZNOTE)).value ?? {}) as Record<string, string>)
  const out = Object.values(notes).filter(Boolean)
  if (out.length) await $.state.set(SQZNOTE, {})
  return out
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

// ------------------------------------------------------------------------------------------------ arriving squeezed

/** The turn's answer, once the turn has ended: a message taller than half the screen arrives squeezed, at Length short. */
export async function arrive($: Engine, row: string): Promise<void> {
  const rec = await recordNow($, row)
  if (!rec || rec.shown != null || (rec as Any).squeeze) return
  if (!isLong(rec.text, roomNow())) return
  await saveRecord($, { ...rec, squeeze: { at: {}, auto: true } } as MsgRecord)
  await setLevels($, row, { length: ARRIVE })
}

/** For tests: the module's memory, cleared. */
export function resetSqueeze(): void {
  inflight.clear()
  revealing.clear()
  cfg = {}
  view = { cols: 100, rows: 48 }
}
