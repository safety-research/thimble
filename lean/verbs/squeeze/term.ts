// term.ts: Squeeze in the terminal. The chips under a message, their keys, the one call per change that rewrites the
// message in place, the new text writing itself in from the top, and the long message that arrives squeezed. The
// shell (shell/shell.tsx) calls it; it imports the message layer's record functions from the shell (a cycle the module
// system resolves at call time).
//
//   s            opens the chips under the message the keys act on, in place of its verb row (s again closes them)
//   1-9          picks a chip                 < >  (or , .)  the picked chip one level down, one up
//   +            starts a stretch: the person types its two ends after the + in the prompt ("engineer and manager")
//                and presses ↵; the chip stands at the original until they step it
//   0            the original again (with the chips at the original: closes them)
// Claude Code hands a plugin only the keys that edit the prompt, so these are the keys (tab, arrows, ↵ and esc never
// reach a plugin). They are named once, in the hint line under the prompt (squeezeHint), not under the chips.
//
// A rewrite: one $.model.complete call (prompt.md, the question, the original, every chip's level); the record's
// `shown` holds the result and its marks are placed again on it, citations kept; a state seen before comes back from
// the record with no call. While a call runs the old text dims and its first glyph turns; when the new text is there
// it writes itself in from the top at a model's pace, and nothing else is drawn for it.
import type { EngineInterface } from 'claude-code'

import type { MsgRecord, SqzUi, Tray } from '../../types'
import { remark as remarkAny } from '../../shell/message.js'
import { questionBefore, recordNow, saveRecord } from '../../shell/shell'
import { ARRIVE, applyRewrite, checkRewrite, chipsOf, endsOf, fromVersions, glyph, isLong, isOriginal, noteFor, noteOf, readReply, request, restore, revealStep, rowsOf, stepAt, stretchChip, withStretch } from './chips.mjs'

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
let promptText = ''
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
  if (!promptText) promptText = String(await $.fs.read(`${dir}/verbs/squeeze/prompt.md`))
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

// ------------------------------------------------------------------------------------------------ the chips

/** The chips' colors, per theme: the squeeze amber, the picked chip's fill, ink and dim. */
function colors(theme: Theme) {
  return theme === 'light'
    ? { sq: '#9a6412', picked: '#f5e4bf', ink: '#2b2a27', dim: '#8a857c' }
    : { sq: '#e0a43a', picked: '#4a3b1d', ink: '#e8e4dc', dim: '#8f897f' }
}

export type ChipsOpts = {
  key: string
  rec: MsgRecord
  ui: SqzUi
  theme: Theme
  onPick: (id: string) => unknown
  onAdd: () => unknown
  onOriginal: () => unknown
}

/**
 * The chips under a message, on one row: each chip as its label, its dots and its level (`Length ○●○○ short`); a
 * stretch as its two ends around its dots (`engineer ●○○○ manager`). Only the picked chip has a fill. A `+` ends the
 * row; while the person types a stretch it reads `stretch between … and …` with what they typed. The keys are named
 * in the hint line under the prompt, so nothing else is drawn here.
 */
export function chipsEl(els: Any, o: ChipsOpts): Any {
  const { Box, Button, Text } = els
  const c = colors(o.theme)
  const chips = chipsOf(o.ui.want ? { ...o.rec, squeeze: { ...((o.rec as Any).squeeze || {}), at: o.ui.want } } : o.rec)
  const kids: Any[] = []
  chips.forEach((chip: Any, i: number) => {
    const picked = o.ui.focus === chip.id && !o.ui.adding
    const bg = picked ? c.picked : undefined
    const t = (children: string, p: Any = {}) => Text({ ...(bg ? { backgroundColor: bg } : {}), ...p, children })
    const dots = t(glyph(chip, chip.level), { color: picked ? c.sq : c.dim })
    const parts = chip.kind === 'stretch'
      ? [t(' '), t(chip.from, { color: picked && chip.level === 0 ? c.sq : c.dim, bold: picked && chip.level === 0 }), t(' '), dots, t(' '), t(chip.to, { color: picked ? c.sq : c.ink, bold: picked && chip.level === chip.levels.length - 1 }), t(' ')]
      : [t(' '), t(chip.name, { color: picked ? c.sq : c.dim, bold: picked }), t(' '), dots, t(' '), t(chip.levels[chip.level] ?? '', { color: c.ink, bold: picked }), t(' ')]
    if (i) kids.push(Text({ children: '   ' }))
    kids.push(Button({ key: i === 0 ? `${o.key}-opt-0` : `${o.key}-chip-${chip.id}`, plain: true, label: `${chip.name}: ${chip.levels[chip.level] ?? ''}`, onPress: () => o.onPick(chip.id), children: parts }))
  })
  kids.push(Text({ children: '   ' }))
  if (o.ui.adding) {
    // the stretch being typed, as the prompt holds it
    const ends = endsOf(o.ui.typing || '')
    const two = !!ends && ends.from !== 'as written'
    const a = two ? ends!.from : (ends?.to || '…')
    const b = two ? ends!.to : '…'
    const f = (children: string, p: Any = {}) => Text({ backgroundColor: c.picked, ...p, children })
    kids.push(Text({ children: [f(' stretch between ', { color: c.dim }), f(a, { color: c.ink, bold: true }), f(' and ', { color: c.dim }), f(b, { color: c.ink, bold: true }), f(' ')] }))
  } else {
    kids.push(Button({ key: `${o.key}-add`, plain: true, label: 'new stretch', onPress: o.onAdd, children: [Text({ color: c.dim, children: '+' })] }))
  }
  return Box({ flexDirection: 'row', flexWrap: 'wrap', marginLeft: 2, marginTop: 1, children: kids })
}

/**
 * The hint line under the prompt while the chips are open: the keys that work now, once; a stretch being typed says
 * how to finish it; a rewrite that failed or said something the original does not is said here, with its fix.
 */
export function squeezeHint(rec: MsgRecord, ui: SqzUi | null): string {
  const u = ui ?? BLANK
  if (u.adding) {
    const ends = endsOf(u.typing || '')
    if (!ends) return 'type two ends, such as engineer and manager · ↵ makes the stretch · ⌫ cancels'
    return ends.from === 'as written' ? 'then and, and the other end · ↵ makes the stretch' : `↵ makes ${ends.from} ↔ ${ends.to} · ⌫ the + cancels`
  }
  const chips = chipsOf(rec)
  if (u.error) return `× ${u.error}`
  const problems = ((rec as Any).squeeze?.problems ?? []) as string[]
  if (problems.length && typeof rec.shown === 'string') return `! ${problems[0]} · 0 original`
  const orig = isOriginal(chips)
  return `${chips.length > 1 ? `1–${Math.min(9, chips.length)}` : '1'} chip · < > change · + stretch · ${orig ? '0 close' : '0 original · s done'}`
}

// ------------------------------------------------------------------------------------------------ keys

/**
 * A key with the prompt empty while the chips are open: 'consume' when it acted, 'type' when it lets the key into the
 * prompt and keeps the chips open (the + of a stretch), null for a key it leaves to the shell.
 */
export async function squeezeKey($: Engine, row: string, k: string): Promise<'consume' | 'type' | null> {
  const rec = await recordNow($, row)
  if (!rec) return null
  const chips = chipsOf(rec)
  const ui = await uiOf($, row)
  if (/^[1-9]$/.test(k)) {
    const chip = chips[Number(k) - 1]
    if (chip) await setUi($, row, { focus: chip.id, adding: false })
    return 'consume'
  }
  if (k === '<' || k === ',' || k === '>' || k === '.') {
    const chip = chips.find((x: Any) => x.id === ui.focus) || chips[0]
    // keys pressed while a change is on its way step from where it goes, so three presses are three levels
    const at = stepAt(ui.want ? { ...rec, squeeze: { ...((rec as Any).squeeze || {}), at: ui.want } } : rec, chip.id, k === '<' || k === ',' ? -1 : 1)
    if (at) {
      await setUi($, row, { focus: chip.id, error: null })
      void setLevels($, row, at)
    }
    return 'consume'
  }
  if (k === '+') {
    await setUi($, row, { adding: true, error: null, typing: '+' })
    return 'type'
  }
  if (k === '0') {
    if (isOriginal(chips) && !inflight.has(row)) { await setUi($, row, { adding: false }); await $.state.set(PICK, null); return 'consume' }
    void setLevels($, row, {})
    return 'consume'
  }
  return null
}

/** A press on a chip: it is picked, and a press on the picked one steps it up (back to its first level after its last). */
export async function pressChip($: Engine, row: string, id: string): Promise<void> {
  const rec = await recordNow($, row)
  if (!rec) return
  const ui = await uiOf($, row)
  if (ui.focus !== id) { await setUi($, row, { focus: id, adding: false }); return }
  const chip = chipsOf(rec).find((x: Any) => x.id === id)
  if (!chip || !chip.levels.length) return
  const at = stepAt(rec, id, 1) ?? { ...((rec as Any).squeeze?.at || {}), [id]: 0 }
  void setLevels($, row, at)
}

/** After an edit of the prompt while the person types a stretch: it is still being typed while the prompt starts with
 *  +. Returns the decorations that color it and show what is left to type (` between … and …`, then ` and …`). */
export async function afterEdit($: Engine, row: string | null, text: string, theme: Theme = 'dark'): Promise<Any[] | null> {
  if (!row) return null
  const ui = (await $.state.get({ ...SQZ, id: row })).value as SqzUi | null | undefined
  if (!ui?.adding) return null
  if (!text.startsWith('+')) { await setUi($, row, { adding: false, typing: '' }); return null }
  await setUi($, row, { typing: text })
  const c = colors(theme)
  const out: Any[] = [{ start: 0, end: text.length, color: c.sq }]
  const ends = endsOf(text)
  if (!ends) out.push({ start: text.length, end: text.length, virtualText: ' between … and …', dimColor: true })
  else if (ends.from === 'as written' && !/\s$/.test(text)) out.push({ start: text.length, end: text.length, virtualText: ' and …', dimColor: true })
  return out
}

/**
 * A prompt submitted while the chips are open and the prompt starts with +: its words are a stretch's two ends. The
 * chip stands at the original, picked, so the next < > rewrites the text toward an end; no call is made now. Returns
 * the reason the prompt is dropped (it is no prompt for Claude), or null for any other prompt.
 */
export async function chipFromPrompt($: Engine, row: string | null, text: string): Promise<string | null> {
  if (!row || !/^\s*\+/.test(text)) return null
  const rec = await recordNow($, row)
  if (!rec) return null
  const chip = stretchChip(rec, text)
  if (!chip) { await setUi($, row, { adding: false, typing: '' }); return 'a stretch needs two ends, such as "+engineer and manager"' }
  const squeeze = withStretch(rec, chip)
  await saveRecord($, { ...rec, squeeze } as MsgRecord)
  await setUi($, row, { focus: chip.id, adding: false, typing: '', error: null })
  // the prompt box keeps a dropped prompt: it is emptied once the drop is done
  $.clock.after(50, () => { void $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined) })
  return `stretch ${chip.from} ↔ ${chip.to}`
}

/**
 * A squeeze pressed in the browser, as the page server's line names it: a chip at a level, a stretch in the person's
 * words, or the original again. It acts as the same press in the terminal does, so the message is rewritten in place
 * here and the page reads the record. Returns one plain line when it cannot act, else null.
 */
export async function fromBrowser($: Engine, q: { row: string; chip?: string; level?: number; custom?: string; reset?: boolean }): Promise<string | null> {
  const rec = await recordNow($, q.row)
  if (!rec) return 'Squeeze from the browser did nothing: that message is not in this session. Press s under it here instead.'
  if (q.reset) { void setLevels($, q.row, {}); return null }
  if (typeof q.custom === 'string') {
    const chip = stretchChip(rec, q.custom)
    if (!chip) return 'Squeeze from the browser did nothing: a stretch needs two ends, such as "engineer and manager".'
    const squeeze = withStretch(rec, chip)
    await saveRecord($, { ...rec, squeeze } as MsgRecord)
    await setUi($, q.row, { focus: chip.id, adding: false, error: null })
    return null
  }
  const chip = chipsOf(rec).find((x: Any) => x.id === q.chip)
  if (!chip || !Number.isInteger(q.level)) return `Squeeze from the browser did nothing: the message has no chip "${q.chip ?? ''}". Press s under it here instead.`
  await setUi($, q.row, { focus: chip.id, error: null })
  void setLevels($, q.row, { ...((rec as Any).squeeze?.at || {}), [chip.id]: Number(q.level) })
  return null
}

// ------------------------------------------------------------------------------------------------ the rewrite

/** Set the chips of a row to `at` and show that version: from the record when it was written before, else one call.
 *  Changes made while a call runs wait, and only the latest of them runs next. */
export async function setLevels($: Engine, row: string, at: At): Promise<void> {
  // the chips show where they go at once; the text follows
  await setUi($, row, { want: at })
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
  }
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
  revealing.delete(row)
  await setUi($, row, { running: { since: await $.clock.now() }, error: null, reveal: null })
  const ticker = tick($, row)
  try {
    const question = await questionBefore($, row).catch(() => '')
    const req = request(probe, {
      system: promptText, question,
      model: String(cfg.model || DEFAULTS.model), effort: String(cfg.effort || DEFAULTS.effort),
      maxTokens: Number(cfg.maxTokens || DEFAULTS.maxTokens), timeoutMs: Number(cfg.timeoutMs || DEFAULTS.timeoutMs),
    })
    const t0 = await $.clock.now()
    const r = await $.model.complete(req as Any)
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
    const checked = checkRewrite(rec.text, reply.text)
    // the record as it is now (the observer may have written its verbs and glosses meanwhile)
    const fresh = (await recordNow($, row)) || rec
    const fs = ((fresh as Any).squeeze ?? {}) as Any
    const next = applyRewrite({ ...fresh, squeeze: { ...fs, own: fs.own ?? s.own } } as MsgRecord, {
      text: checked.text, at: want.at,
      made: { ms, model: req.model, usage: (r as Any).usage, at: new Date(t0).toISOString() }, problems: checked.problems,
    }, remark) as MsgRecord
    ticker.stop()
    await setUi($, row, { running: null })
    await settled($, row, next)
    await log($, { row, ok: true, ms, model: req.model, usage: (r as Any).usage, key: Object.entries(want.at).map(([k, v]) => `${k}=${v}`).join(','), problems: checked.problems, rows: rowsOf(checked.text, view.cols), of: rowsOf(rec.text, view.cols) })
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
  promptText = ''
  cfg = {}
  view = { cols: 100, rows: 48 }
}
