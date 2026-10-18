// term.ts: Squeeze in the terminal. The chips under a message, their keys, the one call per change that rewrites the
// message in place, and the long message that arrives squeezed. The shell (shell/shell.tsx) calls it and hands it
// it imports the message layer's record functions from the shell (a cycle the module system resolves at call time).
//
//   s            opens the chips under the message the keys act on, in place of its verb row (s again closes them)
//   1-9          picks a chip                 < >  (or , .)  the picked chip one level down, one up
//   +            starts the person's own chip: they type its words after the + in the prompt and press ↵
//   0            the original again (with the chips at the original: closes them)
// Claude Code hands a plugin only the keys that edit the prompt, so these are the keys (tab, arrows, ↵ and esc never
// reach a plugin); the footer under the chips always names them.
//
// A rewrite: one $.model.complete call (prompt.md, the question, the original, every chip's level); the record's
// `shown` holds the result and its marks are placed again on it, citations kept; a level seen before comes back from
// the record with no call. While a call runs, the message dims and its first glyph turns, and nothing else moves.
import type { EngineInterface } from 'claude-code'

import type { MsgRecord, SqzUi, Tray } from '../../types'
import { remark as remarkAny } from '../../shell/message.js'
import { questionBefore, recordNow, saveRecord } from '../../shell/shell'
import { ARRIVE, applyRewrite, checkRewrite, chipsOf, fromVersions, glyph, isLong, isOriginal, noteFor, noteOf, ownChip, readReply, request, restore, rowsOf, stepAt, withOwn } from './chips.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Theme = 'dark' | 'light'
type At = Record<string, number>
type Own = { id: string; name: string; words: string; levels: string[] }

const PICK = { plugin: 'thimble-lean', key: 'pick' } as const
const TRAY = { plugin: 'thimble-lean', key: 'tray' } as const

const SQZ = { plugin: 'thimble-lean', key: 'sqz' } as const
const SQZNOTE = { plugin: 'thimble-lean', key: 'sqznote' } as const
const remark = (rec: MsgRecord) => remarkAny(rec) as MsgRecord
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const DEFAULTS = { model: 'sonnet', effort: 'low', maxTokens: 4000, timeoutMs: 90000 }

// the module's memory: the call running per row and the one wanted after it; the prompt's text; the last screen size
const inflight = new Map<string, { want: Want | null }>()
type Want = { at: At; newOwn?: Own | null }
let promptText = ''
let cfg: Record<string, unknown> = {}
let view = { cols: 100, rows: 48 }

/** The screen the transcript draws on, as the last message drawn saw it: a long message is one taller than this. */
export function seeView(cols: number, rows: number): void {
  if (cols > 0 && rows > 0) view = { cols, rows }
}
const roomNow = () => ({ cols: view.cols, room: Math.max(16, view.rows - 14) })

async function uiOf($: Engine, row: string): Promise<SqzUi> {
  return (((await $.state.get({ ...SQZ, id: row })).value ?? null) as SqzUi | null) ?? { focus: 'length', adding: false, running: null, error: null, tick: 0 }
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
 *  original, `squeezing…` while a call runs; else what the observer gave (dim when nothing). */
export function sLit(rec: MsgRecord, ui: SqzUi | null): { lit: boolean; note: string } | null {
  const cols = view.cols
  if (ui?.running) return { lit: true, note: 'squeezing…' }
  if (typeof rec.shown === 'string') return { lit: true, note: noteOf(rec, cols) }
  if ((rec as Any).squeeze?.auto || isLong(rec.text, roomNow())) return { lit: true, note: `${rowsOf(rec.text, cols)} lines` }
  const own = rec.verbs?.s
  return own?.lit && own.note ? { lit: true, note: String(own.note) } : null
}

/** Whether the message is drawn dim with a turning glyph: a rewrite of it is running. */
export function busyGlyph(ui: SqzUi | null): string | null {
  return ui?.running ? SPIN[(ui.tick || 0) % SPIN.length]! : null
}

// ------------------------------------------------------------------------------------------------ the chips

/** The chips' colors, per theme: the squeeze amber, a tile's fill, the picked tile's fill, the + tile's. */
function colors(theme: Theme) {
  return theme === 'light'
    ? { sq: '#b7791f', tile: '#ece7dd', picked: '#f5e4bf', plus: '#f3f0e9', ink: '#2b2a27', dim: '#8a857c', warn: '#b45309' }
    : { sq: '#e0a43a', tile: '#2e2b26', picked: '#4a3b1d', plus: '#262421', ink: '#e8e4dc', dim: '#9a948a', warn: '#e0a43a' }
}

const width = (s: string) => [...s].length
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))

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
 * The chips under a message (B2): one tile per chip, two rows each (its number and name; its dots and level), the
 * picked one in amber with ◂ ▸; the + tile; then one footer row of the keys that work now. A chip being sized (the
 * person's, just typed) reads "sizing it…".
 */
export function chipsEl(els: Any, o: ChipsOpts): Any {
  const { Box, Button, Text } = els
  const c = colors(o.theme)
  const chips = chipsOf(o.rec)
  const tiles: Any[] = []
  chips.forEach((chip: Any, i: number) => {
    const picked = o.ui.focus === chip.id && !o.ui.adding
    const sizing = chip.kind === 'own' && !chip.levels.length
    const bg = picked ? c.picked : c.tile
    const val = sizing ? `${busyGlyph({ ...o.ui, running: o.ui.running ?? { since: 0 } }) || '…'} sizing it…` : `${glyph(chip, chip.level)} ${chip.levels[chip.level]}`
    const maxVal = sizing ? width(val) : Math.max(...chip.levels.map((l: string) => width(glyph(chip, 0)) + 1 + width(l)))
    const inner = Math.max(width(chip.name) + 2, maxVal)
    const top = [Text({ backgroundColor: bg, color: c.dim, children: ` ${i + 1} ` }), Text({ backgroundColor: bg, color: picked ? c.sq : c.dim, bold: picked, children: pad(chip.name, inner + 1) })]
    const left = picked && !sizing ? Text({ backgroundColor: bg, color: chip.level > 0 ? c.sq : c.dim, bold: true, children: '◂ ' }) : Text({ backgroundColor: bg, children: '  ' })
    const right = picked && !sizing ? Text({ backgroundColor: bg, color: chip.level < chip.levels.length - 1 ? c.sq : c.dim, bold: true, children: ' ▸' }) : Text({ backgroundColor: bg, children: '  ' })
    const mid = sizing
      ? Text({ backgroundColor: bg, color: c.sq, children: pad(val, inner) })
      : Text({ backgroundColor: bg, children: [Text({ backgroundColor: bg, color: picked ? c.sq : c.dim, children: glyph(chip, chip.level) + ' ' }), Text({ backgroundColor: bg, color: c.ink, bold: picked, children: pad(chip.levels[chip.level] ?? '', inner - width(glyph(chip, chip.level)) - 1) })] })
    // a Button holds only Text, so each of a tile's two rows is a press of its own
    const label = `${chip.name}: ${chip.levels[chip.level] ?? 'sizing'}`
    const id = i === 0 ? `${o.key}-opt-0` : `${o.key}-chip-${chip.id}`
    tiles.push(Box({ key: `${id}-tile`, flexDirection: 'column', marginRight: 1, children: [
      Button({ key: id, plain: true, label, onPress: () => o.onPick(chip.id), children: [Text({ children: top })] }),
      Button({ key: `${id}-v`, plain: true, label, onPress: () => o.onPick(chip.id), children: [Text({ children: [left, mid, right] })] }),
    ] }))
  })
  // the + tile: while the person types their chip, it says where the words go
  const adding = o.ui.adding
  const pbg = adding ? c.picked : c.plus
  tiles.push(Box({ key: `${o.key}-add-tile`, flexDirection: 'column', children: [
    Button({ key: `${o.key}-add`, plain: true, label: 'add your own chip', onPress: o.onAdd, children: [Text({ backgroundColor: pbg, color: adding ? c.sq : c.dim, bold: true, children: adding ? '  + your chip       ' : '  +    ' })] }),
    Button({ key: `${o.key}-add-v`, plain: true, label: 'add your own chip', onPress: o.onAdd, children: [Text({ backgroundColor: pbg, color: adding ? c.sq : c.dim, children: adding ? '  type it after +   ' : '  add  ' })] }),
  ] }))
  const k = (key: string) => Text({ color: c.ink, bold: true, children: key })
  const w = (words: string) => Text({ color: c.dim, children: words })
  const dot = () => Text({ color: c.dim, children: ' · ' })
  const n = chips.length
  const keys: Any[] = adding
    ? [w('type your chip after the '), k('+'), w(', then '), k('↵'), dot(), w('delete the + to cancel')]
    : [k(n > 1 ? `1–${Math.min(9, n)}` : '1'), w(' chip'), dot(), k('< >'), w(' change'), dot(), k('+'), w(' add'), dot(),
      Button({ key: `${o.key}-orig`, plain: true, label: isOriginal(chips) ? 'close' : 'original', onPress: o.onOriginal, children: [k('0'), w(isOriginal(chips) ? ' close' : ' original')] }),
      ...(isOriginal(chips) ? [] : [dot(), k('s'), w(' close')])]
  if (o.ui.running && !adding) keys.push(Text({ color: c.sq, children: `   ${busyGlyph(o.ui)} rewriting…` }))
  const rows: Any[] = [Box({ flexDirection: 'row', flexWrap: 'wrap', children: tiles }), Box({ flexDirection: 'row', children: keys })]
  const problems = ((o.rec as Any).squeeze?.problems ?? []) as string[]
  if (o.ui.error) rows.push(Text({ color: 'error', wrap: 'wrap', children: `× ${o.ui.error}` }))
  else if (problems.length && typeof o.rec.shown === 'string') rows.push(Text({ color: c.warn, wrap: 'wrap', children: `! ${problems[0]} · 0 shows the original` }))
  return Box({ flexDirection: 'column', marginLeft: 2, marginTop: 0, children: rows })
}

// ------------------------------------------------------------------------------------------------ keys

/**
 * A key with the prompt empty while the chips are open: 'consume' when it acted, 'type' when it lets the key into the
 * prompt and keeps the chips open (the + of the person's own chip), null for a key it leaves to the shell.
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
    const at = stepAt(rec, chip.id, k === '<' || k === ',' ? -1 : 1)
    if (at) {
      await setUi($, row, { focus: chip.id, error: null })
      void setLevels($, row, at)
    }
    return 'consume'
  }
  if (k === '+') {
    await setUi($, row, { adding: true, error: null })
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

/** After an edit of the prompt while the person types their chip: the chip is still being typed while the prompt
 *  starts with +. Returns the decorations that color it, and say where the words go while only + is typed. */
export async function afterEdit($: Engine, row: string | null, text: string, theme: Theme = 'dark'): Promise<Any[] | null> {
  if (!row) return null
  const ui = (await $.state.get({ ...SQZ, id: row })).value as SqzUi | null | undefined
  if (!ui?.adding) return null
  if (!text.startsWith('+')) { await setUi($, row, { adding: false }); return null }
  const c = colors(theme)
  const out: Any[] = [{ start: 0, end: text.length, color: c.sq }]
  if (text === '+') out.push({ start: 1, end: 1, virtualText: ' your chip in a few words, such as "for my manager", then ↵', dimColor: true })
  return out
}

/**
 * A prompt submitted while the chips are open and the prompt starts with +: the words become the person's own chip,
 * and the call that sizes it writes the message at it. Returns the reason the prompt is dropped (it is no prompt for
 * Claude), or null for any other prompt.
 */
export async function chipFromPrompt($: Engine, row: string | null, text: string): Promise<string | null> {
  if (!row || !/^\s*\+/.test(text)) return null
  const rec = await recordNow($, row)
  if (!rec) return null
  const own = ownChip(rec, text) as Own | null
  if (!own) return 'A chip needs a few words after the +, such as "+ for my manager".'
  const squeeze = withOwn(rec, own)
  await saveRecord($, { ...rec, squeeze } as MsgRecord)
  await setUi($, row, { focus: own.id, adding: false, error: null })
  void setLevels($, row, { ...(squeeze.at || {}) }, own)
  return `Your chip "${own.name}" is being sized; the message is rewritten at it.`
}

// ------------------------------------------------------------------------------------------------ the rewrite

/** Set the chips of a row to `at` and show that version: from the record when it was written before, else one call.
 *  Changes made while a call runs wait, and only the latest of them runs next. */
export async function setLevels($: Engine, row: string, at: At, newOwn: Own | null = null): Promise<void> {
  const job = inflight.get(row)
  if (job) {
    // a chip being sized stays in the next call, whatever changed meanwhile
    job.want = { at, newOwn: newOwn ?? job.want?.newOwn ?? null }
    return
  }
  inflight.set(row, { want: null })
  try {
    let next: Want | null = { at, newOwn }
    while (next) {
      await once($, row, next)
      const j = inflight.get(row)!
      next = j.want
      j.want = null
    }
  } finally {
    inflight.delete(row)
    await setUi($, row, { running: null })
  }
}

async function once($: Engine, row: string, want: Want): Promise<void> {
  const rec = await recordNow($, row)
  if (!rec) return
  const s = ((rec as Any).squeeze ?? {}) as Any
  const probe = { ...rec, squeeze: { ...s, at: want.at } } as MsgRecord
  const chips = chipsOf(probe)
  if (!want.newOwn) {
    const hit = isOriginal(chips) ? restore(probe, remark) : fromVersions(rec, want.at, remark)
    if (hit) { await settled($, row, hit as MsgRecord); return }
  }
  await ensure($)
  await setUi($, row, { running: { since: await $.clock.now() }, error: null })
  const ticker = tick($, row)
  try {
    const question = await questionBefore($, row).catch(() => '')
    const req = request(probe, {
      system: promptText, question, newOwn: want.newOwn ?? null,
      model: String(cfg.model || DEFAULTS.model), effort: String(cfg.effort || DEFAULTS.effort),
      maxTokens: Number(cfg.maxTokens || DEFAULTS.maxTokens), timeoutMs: Number(cfg.timeoutMs || DEFAULTS.timeoutMs),
    })
    const t0 = await $.clock.now()
    const r = await $.model.complete(req as Any)
    const ms = (await $.clock.now()) - t0
    if (!r.isAnswered) {
      const why = r.reason === 'api-error' ? `the API answered ${(r as Any).status ?? ''} ${(r as Any).error ?? ''}`.trim() : r.reason
      await setUi($, row, { error: `The rewrite did not come back (${why}). Press the same key again to retry, or 0 for the original.` })
      await log($, { row, ok: false, why, ms })
      return
    }
    const reply = readReply(r.text)
    if (!reply.text.trim()) {
      await setUi($, row, { error: 'The rewrite came back empty. Press the same key again to retry, or 0 for the original.' })
      return
    }
    const checked = checkRewrite(rec.text, reply.text)
    // the record as it is now (the observer may have written its verbs and glosses meanwhile)
    const fresh = (await recordNow($, row)) || rec
    const fs = ((fresh as Any).squeeze ?? {}) as Any
    const next = applyRewrite({ ...fresh, squeeze: { ...fs, own: fs.own ?? s.own } } as MsgRecord, {
      text: checked.text, at: want.at, newOwn: want.newOwn ?? null, chip: reply.chip,
      made: { ms, model: req.model, usage: (r as Any).usage, at: new Date(t0).toISOString() }, problems: checked.problems,
    }, remark) as MsgRecord
    await settled($, row, next)
    await log($, { row, ok: true, ms, model: req.model, usage: (r as Any).usage, key: Object.keys(want.at).join(','), own: want.newOwn?.words, problems: checked.problems, rows: rowsOf(checked.text, view.cols), of: rowsOf(rec.text, view.cols) })
  } finally {
    ticker.stop()
  }
}

/** A version shown: the record kept, the tray off this row's moved marks, and Claude told which version the person reads. */
async function settled($: Engine, row: string, rec: MsgRecord): Promise<void> {
  await saveRecord($, rec)
  await closeTrayOn($, row)
  const notes = (((await $.state.get(SQZNOTE)).value ?? {}) as Record<string, string>)
  await $.state.set(SQZNOTE, { ...notes, [row]: noteFor(rec) })
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

/** The turn's answer, once the turn has ended: a message taller than the screen arrives squeezed, at Length short. */
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
  promptText = ''
  cfg = {}
  view = { cols: 100, rows: 48 }
}
