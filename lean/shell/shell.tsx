// The shell of thimble: it puts the kernel's objects in front of the person, in the terminal.
//
//   inline     when Claude saves an object (`thimble save` in Bash), the object is drawn under the turn's last reply, in
//              cells (draw/term.js, draw/paint.js); a click on a part opens it in the detail.
//   detail     one pane, the card detail (detail.tsx): header, the card with its parts, one "from" line, the
//              examples of the selected part, the program behind p, and a side thread (thread.ts): while it is open,
//              a prompt is a question for the card's thread, which main does not see.
//   keys       the bar under the prompt names them: v asks Claude for another view of the answer (visualize.js), as
//              a turn whose row reads as the press; s opens the squeeze chips (squeeze/); ] steps through the marks
//              and cards; 1 opens the card in focus.
//   resume     where each object is drawn is kept per session in $THIMBLE_HOME/lean/shown/<session>.json, so
//              `claude -c` and `--resume` draw the objects under the same replies again. <session> is the
//              conversation's key (hooks/conversation.ts): a conversation Claude Code continues under a new session id
//              (moved to the background, `--fork-session`) finds its cards, records and squeezes again.
//
// What it never does: it registers no model tool (a plugin's tool skips the asks of Manual mode), starts no
// `claude`, and allows nothing on anyone's behalf. Everything it runs is the person's press or command, or a pure
// drawing of what Claude saved. The Node helpers run as child processes: a hooks module has no Node, and an
// object's program runs only in the drawing contract's sandbox.
import type { EngineInterface, Register } from 'claude-code'

import type { LineCounts, MsgRecord, ObjRef, Said, Sel, SqzUi, Tray, TrayFrame } from '../types'
import { knobOf, turn as turnKnob } from '../draw/handoff.js'
import { gridText, renderTerm } from '../draw/term.js'
import { paintRegions, selectable } from './cells'
import { citeCard, drawnCard, explainerCard, fileLink } from './cards.js'
import { cardStore, detailAction, detailIsOpen, detailKey, detailKeys, detailPane, detailTyped, markOpen, noteViewport, openDetailPane, registerDetail } from './detail'
import { newRecord, recordFor, seriesRef, shownOf, withObserver } from './message.js'
import { fromFacts, isRef, objectRefs, recordRefs, refsKey, regionMeta, regionRefs } from './object.js'
import { askThread, registerThreads, restoreThreads, threadCount, threadList } from './thread'
import type { Scope as ThreadScope } from './thread'
import { cardEvent, cardKey as cardTakesKey, cardStateNow, pressTaken, readCardState, writeCardState } from './runtime'
import { threadKey as threadKeyOf } from './threads.js'
import { base as trayBase, open as trayOpen, order as markOrder, top as trayTop } from './tray.js'
import { catchUpEl, keyColor, markColors, messageEl } from './view'
import { markNextTurn, record as recordEvent } from '../telemetry/telemetry'
import { ownTurn } from '../observer/observer'


import { busyGlyph, catchUp as sqCatchUp, dismissCatchUp as sqDismiss, revealedOf, seeView, setLevels as sqSetLevels, sLit, takeNotes as sqNotes } from '../squeeze/term'
import { catchUpStands, isCatchUp, revealCut } from '../squeeze/chips.mjs'
import { barText, fitBar, hostKeys, keyEvent, keysOf } from '../panes/host.js'
import { keyAnswered, type KeyEdit, keySlot, keyTake, type KeyTurn, resetKeys } from './keys'
import { act, paneDrawing, paneEl, paneFire, paneNow, paneTakes, paneTry, patchPaneState, setTheme } from './panes'
import { frameOf as trayFrameOf } from '../panes/tray.js'
import { ANOTHER_VIEW } from '../panes/proposals.js'
import { mix } from '../draw/palette.js'
import { noteConversation, sessionKey } from '../hooks/conversation'

import { checksDone, checksPending, labelFromFeed, labelsOf } from './labels'
import { viewRequest } from './visualize.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Prepared = { object: Any; drawing: Any; grid: Any; error?: string; check?: { line: string | null; tried: number; total: number; failed: number; cut: number; ms: number } }
type Placed = ObjRef & { from?: string }

export const PANE = 'object'
const UNDER = { plugin: 'thimble', key: 'under' } as const
const SEL = { plugin: 'thimble', key: 'sel' } as const
const LAST = { plugin: 'thimble', key: 'last' } as const
const ASKED = { plugin: 'thimble', key: 'asked' } as const
const ROWS = { plugin: 'thimble', key: 'rows' } as const
const READY = { plugin: 'thimble', key: 'ready' } as const
const SAID = { plugin: 'thimble', key: 'said' } as const
const NOTES = { plugin: 'thimble', key: 'notes' } as const
const WHERE = { plugin: 'thimble', key: 'where' } as const
const MSG = { plugin: 'thimble', key: 'msg' } as const
const MSGROWS = { plugin: 'thimble', key: 'msgrows' } as const
const TRAY = { plugin: 'thimble', key: 'tray' } as const
const PICK = { plugin: 'thimble', key: 'pick' } as const
const SELROW = { plugin: 'thimble', key: 'selrow' } as const
const ANSWER = { plugin: 'thimble', key: 'answer' } as const
const ANSWERS = { plugin: 'thimble', key: 'answers' } as const
const CARDFOCUS = { plugin: 'thimble', key: 'cardfocus' } as const
const SQZ = { plugin: 'thimble', key: 'sqz' } as const
const COUNTS = { plugin: 'thimble', key: 'counts' } as const

const ID =/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/
const REGION = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,95}$/
const EVENTS = { plugin: 'thimble', key: 'events' } as const
// when this module loaded, in the kernel's seconds: the change feed's saves before it were placed by an earlier load
const LOADED = Date.now() / 1000
const rowKey = (id: string) => String(id).slice(0, 24)
const refText = (r: { id: string; v: number | null }) => (r.v != null ? `${r.id}@${r.v}` : r.id)
const cut = (s: string, n: number) => ([...s].length <= n ? s : [...s].slice(0, Math.max(0, n - 1)).join('') + '…')
const fmtN = (x: unknown) => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x))
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'
const stateKey = (state?: Record<string, unknown> | null) => (state && Object.keys(state).length ? JSON.stringify(state) : '')

// the module's own memory: lost on a reload, rebuilt from $.state and the object files
const objects = new Map<string, Any>()
export const citeLabels = new Map<string, string>()
const preps = new Map<string, Prepared>()
const pending = new Map<string, Promise<Prepared>>()
let turn: { unplaced: ObjRef[]; lastRow: string; calls: string[]; placed: string[]; at?: string | null } | null = null
let theme: 'dark' | 'light' = 'dark'
let pendingAsk: { text: string; about: { id: string; v: number | null; region: string | null; label: string }; scope?: Record<string, unknown> } | null = null

let shown: { file: string; under: Record<string, Placed[]> } | null = null
// the message layer's memory: the records' folder and index, the tray's drawn cards, the verb key that opened a line
let msgFiles: { session: string; dir: string | null; index: Any[]; pending: Set<string>; loaded: boolean } | null = null
let keyOpened: { key: string; at: number; undo?: () => unknown } | null = null
// the card key pressed last from the empty prompt, with the card's state before it (a word it began gives it back)
let cardKeyed: { key: string; at: number; ref: ObjRef; undo: { state: Record<string, unknown>; region: string | null } | null } | null = null
// the tray's letter key pressed last from the empty prompt (r rows, c code): a letter typed straight after it began a word
let trayKeyed: { key: string; at: number } | null = null
// the row the next turn's cards are drawn under, when v asked about a catch-up: under the catch-up,
// not under the turn's own last words
let placeNext: string | null = null

// ------------------------------------------------------------------------------------------------ objects

/** The folder under analysis that holds object `id`: THIMBLE_ROOT, a `cd` the command made, the session's folder or a
 *  folder above it. */
async function findRoot($: Engine, id: string, hints: string[] = []): Promise<string | null> {
  const env = await $.env.get('THIMBLE_ROOT')
  const cwd = String(await $.session.cwd())
  const tries: string[] = []
  for (const h of [env, ...hints, cwd]) {
    if (!h) continue
    const abs = h.startsWith('/') ? h : `${cwd.replace(/\/+$/, '')}/${h}`
    let d = abs.replace(/\/+$/, '')
    while (d) {
      tries.push(d)
      d = d.slice(0, d.lastIndexOf('/'))
    }
  }
  for (const d of [...new Set(tries)]) if (await $.fs.exists(`${d}/thimble/objects/${id}.json`)) return d
  return null
}

export async function loadObject($: Engine, ref: ObjRef): Promise<Any | null> {
  const key = `${ref.root}|${ref.id}|${ref.v ?? ''}`
  if (ref.v != null && objects.has(key)) return objects.get(key)
  const latest = `${ref.root}/thimble/objects/${ref.id}.json`
  if (!(await $.fs.exists(latest))) return null
  let o = JSON.parse(String(await $.fs.read(latest)))
  if (ref.v != null && Number(o.version) !== ref.v) {
    const old = `${ref.root}/thimble/objects/.versions/${ref.id}/v${ref.v}.json`
    if (await $.fs.exists(old)) o = JSON.parse(String(await $.fs.read(old)))
  }
  if (ref.v != null) objects.set(key, o)
  return o
}

const prepKey = (ref: ObjRef, w: number, state?: Record<string, unknown> | null, mode = 'inline', h = 24) => `${ref.root}|${ref.id}|${ref.v ?? ''}|${w}|${stateKey(state)}|${mode}${h === 24 ? '' : '|' + h}`

/** The object drawn at `w` columns (with the knobs at `state`): the program runs in a Node child, in the
 *  contract's sandbox. `mode` is where it is drawn (k.mode): 'inline' under a reply, 'detail' in the detail view, where
 *  a program may show more, in the `h` rows the detail gives it (k.h). Kept per object version, width, state, mode and
 *  rows; a failed one stays failed until the module reloads. `check` (a save) also tries the card's interactions once
 *  (draw/exercise.mjs), in the same child. */
export function prepared($: Engine, ref: ObjRef, w: number, state?: Record<string, unknown> | null, mode = 'inline', h = 24, check = false): Promise<Prepared> {
  const key = prepKey(ref, w, state, mode, h)
  const hit = preps.get(key)
  if (hit && (!check || hit.check || hit.error || hit.drawing?.error)) return Promise.resolve(hit)
  const running = pending.get(key)
  if (running && !check) return running
  const p = (async (): Promise<Prepared> => {
    let object: Any | null
    try {
      object = await loadObject($, ref)
    } catch (err) {
      // a file over the 4 MiB one read takes, or one that is not JSON: Claude hears it at once, so the turn fixes it
      return { object: null, drawing: null, grid: null, error: `its file could not be read (${String((err as Error)?.message || err).slice(0, 160)}); an object over 4 MiB cannot be drawn, so bind query outputs (r3) in its data rather than writing rows out` }
    }
    if (!object) return { object: null, drawing: null, grid: null, error: `no card ${ref.id} in ${ref.root}/thimble/objects` }
    const dir = $.plugin.root.replace(/\/+$/, '')
    const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `${dir}/shell/node/prep.mjs`], { stdin: JSON.stringify({ object, w, h, state: { ...(state || {}) }, mode, ...(check ? { check: true } : {}) }), timeoutMs: 30000 })
    if (r.exitCode !== 0) return { object, drawing: null, grid: null, error: (r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 300) || `exit ${r.exitCode}` }
    const out = JSON.parse(r.stdout)
    // under a reply a card is its title, its chart and its takeaway: the words at the right of its frame (its sources)
    // wait in the detail's from line
    const root = out.drawing?.root
    const bare = mode === 'inline' && root && root.t === 'frame' && root.right && !out.drawing.error ? { ...out.drawing, root: { ...root, right: undefined } } : out.drawing
    return { object, drawing: out.drawing, grid: renderTerm(bare, { w }), ...(out.check ? { check: out.check } : {}) }
  })()
  pending.set(key, p)
  void p.then(x => { preps.set(key, x); pending.delete(key) }, () => pending.delete(key))
  return p
}

/** For a drawing hook: the object if it is ready; else null, with the work started outside the drawing (a render's
 *  dispatch may be abandoned, which would stop the child) and the drawing subscribed to its end. */
export async function preparedNow($: Engine, ref: ObjRef, w: number, state?: Record<string, unknown> | null, mode = 'inline', h = 24): Promise<Prepared | null> {
  const key = prepKey(ref, w, state, mode, h)
  const hit = preps.get(key)
  if (hit) return hit
  await $.state.get({ ...READY, id: key })
  if (!pending.has(key)) $.clock.after(0, () => { void prepared($, ref, w, state, mode, h).then(() => $.state.set({ ...READY, id: key }, Date.now())) })
  return null
}

/** The ref with its version: the latest when none is named. */
async function withVersion($: Engine, ref: ObjRef): Promise<ObjRef> {
  if (ref.v != null) return ref
  const o = await loadObject($, ref)
  return { ...ref, v: o?.version != null ? Number(o.version) : null }
}

/** The object as the person sees it under a reply, as plain text at 96 columns (what the observer reads). */
export async function drawnTextOf($: Engine, ref: ObjRef): Promise<string> {
  const p = await prepared($, ref, 96)
  if (p.error || !p.grid) return `(it cannot be drawn: ${p.error || 'no drawing'})`
  const err = p.drawing?.error ? `\n(its program failed: ${p.drawing.error.name}: ${p.drawing.error.message})` : ''
  return gridText(p.grid) + err
}

// ------------------------------------------------------------------------------------------------ where objects are drawn

async function shownFile($: Engine): Promise<string> {
  const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  return `${home.replace(/\/+$/, '')}/lean/shown/${safe(await sessionKey($))}.json`
}

/** This session's placements as kept on disk (read once per load of the module). */
async function shownNow($: Engine): Promise<{ file: string; under: Record<string, Placed[]> }> {
  const file = await shownFile($)
  if (shown && shown.file === file) return shown
  let under: Record<string, Placed[]> = {}
  try {
    if (await $.fs.exists(file)) under = JSON.parse(String(await $.fs.read(file))).under || {}
  } catch {
    under = {}
  }
  shown = { file, under }
  return shown
}

/** The objects drawn under a row: kept in $.state for the drawing and on disk for a resumed session. */
async function setUnder($: Engine, at: string, list: Placed[]): Promise<void> {
  await $.state.set({ ...UNDER, id: at }, list)
  for (const r of list) await $.state.set({ ...WHERE, id: r.id }, at)
  try {
    // the message's record names the objects drawn under it
    const rec = (await $.state.get({ ...MSG, id: at })).value as MsgRecord | null | undefined
    const ids = list.map(r => r.id)
    if (rec && JSON.stringify(rec.objects) !== JSON.stringify(ids)) await saveRecord($, { ...rec, objects: ids })
  } catch {
    // the drawing holds; the record catches up at its next write
  }
  try {
    const s = await shownNow($)
    s.under[at] = list
    await $.fs.write(s.file, JSON.stringify({ under: s.under }))
  } catch {
    // the drawing holds for this session; only a resume would miss it
  }
  $.clock.after(0, () => { void recount($) })
}

/** The newest version shown of each object (by folder and id): a save of an older one, read from the feed later, is
 *  drawn at this one. */
const newestVersion = new Map<string, number>()

/** The saves the kernel wrote to this session's change feed since the feed was last read: one JSON line per save in
 *  $THIMBLE_HOME/lean/events/<session>.jsonl, each naming its object, version and folder. Read from the feed, a save
 *  is seen however the command was written (`thimble save … | tail -3`, a script that saves, a `cd` first). */
async function newSaves($: Engine): Promise<ObjRef[]> {
  const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  const file = `${home.replace(/\/+$/, '')}/lean/events/${safe(await sessionKey($))}.jsonl`
  const seen = (await $.state.get(EVENTS)).value as { file: string; n: number; bytes?: number } | undefined
  const mine = seen && seen.file === file ? seen : null
  // the feed's size: a call that saved nothing reads no bytes at all; where a surface cannot say, the whole feed is read
  const size = await $.fs.stat(file).then(x => (x.kind === 'file' ? x.size : -1), () => null)
  if (size === -1 || (size === null && !(await $.fs.exists(file)))) {
    if (!mine) await $.state.set(EVENTS, { file, n: 0, bytes: 0 })
    return []
  }
  // with no mark yet (the first read since this module loaded), the saves made since it loaded are new: a resumed
  // session's earlier saves are drawn from its placements, never placed twice
  const since = mine ? 0 : LOADED - 2
  let lines: string[]
  if (size !== null && mine && typeof mine.bytes === 'number') {
    if (size === mine.bytes) return []
    // only the bytes after the last read (a feed that shrank, a new file under the same name, from its start)
    const from = size > mine.bytes ? mine.bytes : 0
    const text = await feedTail($, file, from)
    // whole lines only: a line being written is read whole by the next call
    const whole = text.slice(0, text.lastIndexOf('\n') + 1)
    lines = whole.split('\n').filter(Boolean)
    await $.state.set(EVENTS, { file, n: (from ? mine.n : 0) + lines.length, bytes: from + utf8Bytes(whole) })
  } else {
    const text = String(await $.fs.read(file))
    const whole = text.slice(0, text.lastIndexOf('\n') + 1)
    const all = whole.split('\n').filter(Boolean)
    lines = all.slice(mine ? mine.n : 0)
    await $.state.set(EVENTS, { file, n: all.length, ...(size !== null ? { bytes: utf8Bytes(whole) } : {}) })
  }
  const out: ObjRef[] = []
  for (const line of lines) {
    try {
      const ev = JSON.parse(line)
      // a --prompt label's records, for the model to read beside the session
      if (ev?.kind === 'label' && Number(ev.t) >= since) { labelFromFeed($, ev); continue }
      if (ev?.kind !== 'save' || typeof ev.object !== 'string' || !ID.test(ev.object) || typeof ev.root !== 'string' || !(Number(ev.t) >= since)) continue
      const ref = { id: ev.object, v: Number(ev.version) || null, root: String(ev.root).replace(/\/+$/, '') }
      out.push(ref)
    } catch {
      // a line that does not parse is skipped; the feed's later lines still count
    }
  }
  // an object saved twice in one call is drawn once, at its latest version; one saved again meanwhile (a label's card,
  // as the model's reads of it ended while the command still ran) is drawn at that version
  return out.filter((x, i) => !out.slice(i + 1).some(y => y.id === x.id && y.root === x.root))
    .map(x => { const v = newestVersion.get(`${x.root}|${x.id}`); return v != null && x.v != null && v > x.v ? { ...x, v } : x })
}


/** How far the look for labels in the feed has read it, while a command runs (newSaves reads it after). */
let labelScan: { file: string; bytes: number } | null = null

/** The labels the kernel wrote in the feed since it was last read, for the model to read now (each once:
 *  labelFromFeed). The saves are left for newSaves, which places them after the command. */
async function labelsInFeed($: Engine): Promise<void> {
  const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  const file = `${home.replace(/\/+$/, '')}/lean/events/${safe(await sessionKey($))}.jsonl`
  const size = await $.fs.stat(file).then(x => (x.kind === 'file' ? x.size : -1), () => -1)
  if (size < 0) return
  const read = (await $.state.get(EVENTS)).value as { file: string; bytes?: number } | undefined
  const from = Math.max(labelScan?.file === file ? labelScan.bytes : 0, read?.file === file ? read.bytes ?? 0 : 0)
  if (size <= from) return
  const text = await feedTail($, file, from)
  const whole = text.slice(0, text.lastIndexOf('\n') + 1)
  labelScan = { file, bytes: from + utf8Bytes(whole) }
  for (const line of whole.split('\n').filter(Boolean)) {
    try {
      const ev = JSON.parse(line)
      if (ev?.kind === 'label' && Number(ev.t) >= LOADED - 2) labelFromFeed($, ev)
    } catch {
      // a line that does not parse is skipped
    }
  }
}

/** UTF-8 bytes of a text (the feed's offsets are bytes). */
function utf8Bytes(t: string): number {
  let n = 0
  for (const ch of t) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** The feed from byte `from` on: the whole file when that is its start, else only its new bytes (`tail -c`). */
async function feedTail($: Engine, file: string, from: number): Promise<string> {
  if (from <= 0) return String(await $.fs.read(file))
  const r = await $.process.run(['tail', '-c', `+${from + 1}`, file], { timeoutMs: 10000 })
  if (r.exitCode !== 0) throw new Error(`tail could not read the feed: ${String(r.stderr || '').trim().slice(0, 120)}`)
  return String(r.stdout)
}

/** One object under a row: a new version of one already there takes its place; one placed `from` another goes after
 *  it (and after what came from it before). */
async function place($: Engine, at: string, ref: Placed): Promise<void> {
  const cur = ((await $.state.get({ ...UNDER, id: at })).value ?? []) as Placed[]
  const i = cur.findIndex(x => x.id === ref.id && x.root === ref.root)
  let next: Placed[]
  if (i >= 0) next = cur.map((x, j) => (j === i ? { ...ref, from: x.from ?? ref.from } : x))
  else {
    let j = -1
    if (ref.from) cur.forEach((x, k) => { if (x.id === ref.from || x.from === ref.from) j = k })
    next = j >= 0 ? [...cur.slice(0, j + 1), ref, ...cur.slice(j + 1)] : [...cur, ref]
  }
  await setUnder($, at, next)
}

/** The objects this turn saved, under row `at`: an object saved again in the same turn is drawn once, under the
 *  latest words, so a fix within a turn leaves no second copy above. */
async function placeTurn($: Engine, at: string): Promise<void> {
  if (!turn) return
  const moved = turn.unplaced
  for (const before of turn.placed) {
    if (before === at) continue
    const cur = ((await $.state.get({ ...UNDER, id: before })).value ?? []) as Placed[]
    const kept = cur.filter(x => !moved.some(y => y.id === x.id && y.root === x.root))
    if (kept.length !== cur.length) await setUnder($, before, kept)
  }
  const cur = ((await $.state.get({ ...UNDER, id: at })).value ?? []) as Placed[]
  await setUnder($, at, [...cur.filter(x => !moved.some(y => y.id === x.id)), ...moved])
  if (!turn.placed.includes(at)) turn.placed.push(at)
  turn.unplaced = []
}

/** A resumed session: its placements back in $.state, so the rows draw their objects again. */
async function restoreShown($: Engine): Promise<void> {
  const s = await shownNow($)
  for (const [at, list] of Object.entries(s.under)) {
    if (!Array.isArray(list) || !list.length) continue
    await $.state.set({ ...UNDER, id: at }, list)
    for (const r of list) await $.state.set({ ...WHERE, id: r.id }, at)
  }
  const last = Object.values(s.under).flat().at(-1)
  if (last) await $.state.set(LAST, { id: last.id, v: last.v, root: last.root })
}

// ------------------------------------------------------------------------------------------------ running things

/** The env of the shell's own `thimble` calls: the person's, never counted as what Claude read (coverage). */
export async function leanEnv($: Engine, root: string): Promise<Record<string, string>> {
  // the prompt versions in use (prompts/prompts.ts set THIMBLE_PROMPTS), so a child reads the same ones
  const prompts = String((await $.env.get('THIMBLE_PROMPTS')) || '')
  return { THIMBLE_ROOT: root, THIMBLE_SESSION: `person-${(await sessionKey($)).slice(0, 8)}`, ...(prompts ? { THIMBLE_PROMPTS: prompts } : {}) }
}

async function resolveRefs($: Engine, root: string, refs: string[]): Promise<void> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  // a part with several refs (a selection, a group of rows) is one set of rows: resolved together, kept under them all
  const sets = refs.length > 1 ? [refs.slice(0, 500)] : refs.map(r => [r])
  for (const set of sets) {
    const ref = refsKey(set)
    const at = { ...ROWS, id: `${root}|${ref}` }
    if ((await $.state.get(at)).value !== undefined) continue
    // a few rows spread across the part's rows (the kernel's default), enough to flip through as its examples
    const r = await $.process.run([`${dir}/bin/thimble`, 'resolve', ...set, '-n', '8', '--json'], { cwd: root, env: await leanEnv($, root), timeoutMs: 60000 })
    let v: unknown
    try { v = JSON.parse(r.stdout) } catch { v = { ref, error: (r.stdout + r.stderr).trim().slice(0, 400) || 'thimble resolve gave nothing' } }
    await $.state.set(at, v)
  }
}

/** The kernel refs behind the selection: the region's, or the object's citations with no region. */
async function refsOf($: Engine, sel: Sel): Promise<{ refs: string[]; how: string }> {
  const p = await prepared($, sel, 96, sel.state)
  if (!p.object) return { refs: [], how: '' }
  if (sel.region) return regionRefs(p.object, p.drawing, sel.region)
  return { refs: objectRefs(p.object).map((c: Any) => c.ref), how: 'cited in its words' }
}

export async function select($: Engine, sel: Sel): Promise<void> {
  await $.state.set(SEL, sel)
  const { refs } = await refsOf($, sel)
  await resolveRefs($, sel.root, refs)
}

export async function openDetail($: Engine, at: ObjRef, region: string | null = null): Promise<void> {
  const ref = await withVersion($, at)
  const cur = (await $.state.get(SEL)).value
  // the knobs stay where the person turned them while it is the same object
  const state = cur && cur.id === ref.id && cur.root === ref.root ? cur.state : undefined
  await select($, { id: ref.id, v: ref.v, root: ref.root, region, ex: 0, all: false, ...(state ? { state } : {}) })
  const o = await loadObject($, ref)
  await openDetailPane($, o?.title ? cut(String(o.title), 40) : ref.id)
}

/** The folder under analysis for a ref that names no object: the latest object's, else the nearest folder at or above
 *  the session's that holds a thimble/ record folder. */
async function rootHere($: Engine): Promise<string | null> {
  const last = (await $.state.get(LAST)).value
  if (last) return last.root
  const env = await $.env.get('THIMBLE_ROOT')
  if (env) return env
  let d = String(await $.session.cwd()).replace(/\/+$/, '')
  while (d) {
    if ((await $.fs.exists(`${d}/thimble/objects`)) || (await $.fs.exists(`${d}/thimble/queries`))) return d
    d = d.slice(0, d.lastIndexOf('/'))
  }
  return null
}

/** A new version of an object: drawn where the object is drawn now, in its place; one the turn has not placed yet is
 *  placed at the new version. */
export async function showVersion($: Engine, ref: ObjRef): Promise<void> {
  if (ref.v != null) newestVersion.set(`${ref.root}|${ref.id}`, Math.max(ref.v, newestVersion.get(`${ref.root}|${ref.id}`) ?? 0))
  const where = (await $.state.get({ ...WHERE, id: ref.id })).value as string | undefined
  if (where) { await place($, where, ref); return }
  if (turn) turn.unplaced = turn.unplaced.map(x => (x.id === ref.id && x.root === ref.root ? { ...x, v: ref.v } : x))
}

/** Words for Claude alone, given with the next prompt (prompt.submit's context): no row of the transcript. */
export async function noteForClaude($: Engine, text: string): Promise<void> {
  const cur = ((await $.state.get(NOTES)).value ?? []) as string[]
  await $.state.set(NOTES, [...cur, text].slice(-12))
}

/** A turn this plugin starts: `rows` (what the shell has for Claude since its last reply, the request, what the
 *  observer has for Claude) go just before it as a row the person does not see, for Claude alone; the prompt is `t.text`, as the person
 *  would type it. Claude Code labels its row as the plugin's. */
async function startTurn($: Engine, rows: string[], t: { text: string; typed: boolean; verb: string }): Promise<void> {
  // with what the person reads now (a squeeze's version, a catch-up), as a prompt of theirs carries it
  const notes = [...(await sqNotes($)), ...(((await $.state.get(NOTES)).value ?? []) as string[])]
  await $.state.set(NOTES, [])
  // the observer hears of the turn (its own prompt.submit hook may never see this plugin's prompt): its notes come back
  const heard = await ownTurn($, t).catch(() => null)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: [...notes, ...rows, ...(heard ? [heard] : [])].join('\n\n') }] } })
  await $.prompt.submit({ text: t.text, asUser: true })
}

/** A request to Claude, as a turn the person started: its row is the person's press in a few words (`visualize
 *  another view of this answer`), as they would type it; the request itself goes just before it, for Claude alone
 *  (startTurn). */
export async function ask($: Engine, request: string, verb: string, on: string): Promise<void> {
  // the turn it starts is filed under the verb in the session's events (v's card is a turn of main's)
  markNextTurn(verb)
  await startTurn($, [request], { text: `${verb} ${on}`, typed: false, verb })
}

// ------------------------------------------------------------------------------------------------ failures, in words

// refusals the engine gives that need nothing from the person: a key in the prompt may not scroll the transcript, and
// a mark far above the screen has no element drawn to scroll to. The tray shows the mark anyway.
const QUIET = /not person-initiated|no element of its own|nothing drawn under|not scrollable|nothing around that site scrolls|not this plugin's site|does not hold the keyboard/

/** Why something failed, in its own plain words: never JSON, never a stack. Null for a refusal that needs nothing from
 *  the person. */
export function plainWhy(err: unknown): string | null {
  const o = err && typeof err === 'object' && !(err instanceof Error) ? (err as Any) : null
  let s = o ? String(o.deny ?? o.error ?? o.message ?? o.reason ?? '') : String((err as Error)?.message ?? err ?? '')
  // a refusal or an error written as JSON inside the text reads as its words
  s = s.replace(/\{[^{}]*\}/g, j => { try { const v = JSON.parse(j); return String(v.deny ?? v.error ?? v.message ?? v.reason ?? '') } catch { return j } })
  s = s.replace(/^[\w.-]+: \$\.[\w.]+: /, '').split('\n').map(l => l.trim()).find(Boolean) ?? ''
  if (!s || QUIET.test(s)) return null
  return cut(s.replace(/\s+/g, ' ').replace(/[.\s]+$/, ''), 160)
}

/** A failure the person should know of: one line with what did not happen, why, and the fix. A refusal that needs
 *  nothing from them shows nothing. */
function failed($: Engine, what: string, err: unknown, fix: string): void {
  const why = plainWhy(err)
  if (why != null) $.ui.toast(`${what}: ${why}. ${fix}`)
}

/** A pane that cannot draw: one plain line that says so and how to get it back, never the error itself. */
function paneProblem($: Engine, e: Any, what: string, err: unknown): Any {
  const { Text } = $.ui.resolve(e) as Any
  const why = plainWhy(err)
  return Text({ color: 'error', wrap: 'wrap', children: `${what} could not be drawn${why ? ` (${why})` : ''}. Press esc, then open it again.` })
}

/** An engine call whose refusal needs nothing from the person (a scroll a key asked for): it is dropped quietly. */
async function quietly(p: Promise<unknown>): Promise<void> {
  try { await p } catch { /* a refusal: the tray shows the mark anyway */ }
}

// ------------------------------------------------------------------------------------------------ the theme

/** The theme the person picked (dark or light): the cards' palette follows it. */
export function currentTheme(): 'dark' | 'light' {
  return theme
}

// ------------------------------------------------------------------------------------------------ the message layer
//
// Every row the shell draws has a line in thimble/messages/<session>/index.jsonl, and each of Claude's messages a
// record, <row>.json (CONTRACT 1): its words, the marks in them, the verbs the observer lit and the objects drawn under
// it. The records live in the folder under analysis, so the browser's page server reads the same; a session whose
// folder has no thimble/ yet keeps them in memory and writes them once thimble has made one.

/** The records' folder of this session: <root>/thimble/messages/<session>, or null while there is no root. */
async function messagesDir($: Engine): Promise<{ session: string; dir: string | null }> {
  const session = await sessionKey($)
  const root = await rootHere($)
  return { session, dir: root ? `${root.replace(/\/+$/, '')}/thimble/messages/${safe(session)}` : null }
}

/** The index and folder of this session, read once per load of the module (a resumed session finds its own). A
 *  folder that appears later (thimble made thimble/, or the session's root became known) is read then, and what was kept
 *  in memory meanwhile is written there. */
async function msgFilesNow($: Engine): Promise<NonNullable<typeof msgFiles>> {
  const { session, dir } = await messagesDir($)
  if (msgFiles && msgFiles.session === session && (msgFiles.dir === dir || !dir)) return msgFiles
  if (!msgFiles || msgFiles.session !== session) msgFiles = { session, dir: null, index: [], pending: new Set(), loaded: false }
  const f = msgFiles
  f.dir = dir
  if (!dir) return f
  try {
    if (await $.fs.exists(`${dir}/index.jsonl`)) {
      const kept = String(await $.fs.read(`${dir}/index.jsonl`)).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      f.index = [...kept, ...f.index.filter(x => !kept.some((k: Any) => k.row === x.row))]
    }
  } catch {
    // an index it cannot read: this session's rows start a new one
  }
  // (no write to $.state here: a drawing reads this; messageRows joins the index's rows and this load's)
  const held = ((await $.state.get(MSGROWS)).value ?? []) as string[]
  // everything kept in memory while there was no folder is written now
  f.pending.add('index')
  for (const row of held) f.pending.add(row)
  f.loaded = true
  return f
}

/** Writes what waits: the index and each record that changed. A failure leaves them waiting for the next write. */
async function flushMessages($: Engine): Promise<void> {
  const f = await msgFilesNow($)
  if (!f.dir || !f.pending.size) return
  const todo = [...f.pending]
  f.pending.clear()
  for (const what of todo) {
    try {
      if (what === 'index') await $.fs.write(`${f.dir}/index.jsonl`, f.index.map(x => JSON.stringify(x)).join('\n') + '\n')
      else {
        const rec = (await $.state.get({ ...MSG, id: what })).value
        if (rec) await $.fs.write(`${f.dir}/${safe(what)}.json`, JSON.stringify(rec, null, 1))
      }
    } catch {
      f.pending.add(what)
    }
  }
}

/** One row of the transcript in the index, once. */
async function indexRow($: Engine, line: Record<string, unknown>): Promise<void> {
  const f = await msgFilesNow($)
  if (f.index.some(x => x.row === line.row)) return
  f.index.push(line)
  f.pending.add('index')
}

/** A record kept: in $.state for the drawing, and on disk for the browser and a resumed session. */
export async function saveRecord($: Engine, rec: MsgRecord): Promise<void> {
  await $.state.set({ ...MSG, id: rec.row }, rec)
  const f = await msgFilesNow($)
  f.pending.add(rec.row)
  await flushMessages($)
}

/** A record: this session's, else the one a resumed session left on disk. */
export async function recordNow($: Engine, row: string): Promise<MsgRecord | null> {
  const held = (await $.state.get({ ...MSG, id: row })).value as MsgRecord | null | undefined
  if (held) return held
  const f = await msgFilesNow($)
  if (!f.dir) return null
  try {
    const file = `${f.dir}/${safe(row)}.json`
    if (await $.fs.exists(file)) return JSON.parse(String(await $.fs.read(file))) as MsgRecord
  } catch {
    // a record it cannot read: the message is drawn from its words
  }
  return null
}

/** The values of each sparkline: the column of the query's output, read from its record, in its row order. */
async function withSparkValues($: Engine, rec: MsgRecord): Promise<MsgRecord> {
  if (!rec.marks.some(m => m.kind === 'spark' && !Array.isArray(m.values))) return rec
  const root = await rootHere($)
  if (!root) return rec
  const marks = []
  for (const m of rec.marks) {
    if (m.kind !== 'spark' || Array.isArray(m.values)) { marks.push(m); continue }
    const s = seriesRef(m.ref)
    let values: number[] | null = null
    let problem: string | undefined
    try {
      const q = JSON.parse(String(await $.fs.read(`${root}/thimble/queries/${s!.query}.json`)))
      const table = Array.isArray(q.table) ? q.table : []
      if (!table.length || !(s!.col in table[0])) problem = `${s!.query}'s output has no column ${s!.col}`
      else values = table.map((r: Any) => (typeof r[s!.col] === 'number' ? r[s!.col] : Number(r[s!.col]))).map((x: number) => (Number.isFinite(x) ? x : 0))
    } catch (err) {
      problem = `no query ${s?.query} to draw: ${String((err as Error)?.message || err).slice(0, 120)}`
    }
    marks.push({ ...m, values, ...(problem ? { problem } : {}) })
  }
  return { ...rec, marks }
}

/** The message's record at this row, as a drawing reads it: kept, else made from its words (no write here). */
async function drawnRecord($: Engine, at: string, text: string): Promise<MsgRecord> {
  const kept = await recordNow($, at)
  return recordFor(kept, { row: at, session: await sessionKey($), text }) as MsgRecord
}

/** The keys of the row: v and s. */
const ROW_KEYS = [{ key: 'v', name: 'visualize' }, { key: 's', name: 'squeeze' }]

/** Whether a person is at this session: `now` (an interactive session), `later` (one Claude Code's background service
 *  runs, a pre-warmed spare or a background job, until the person's first prompt), `never` (a `-p` run, the SDK). */
let person: 'now' | 'later' | 'never' = 'now'

/** Whether a person is at this session now (the observer looks only then). */
export function personHere(): 'now' | 'later' | 'never' {
  return person
}

/** The work of a person's session that starts a child: the bar's counts with the share of the data Claude read. */
async function startForPerson($: Engine): Promise<void> {
  person = 'now'
  $.clock.after(0, () => { void recount($, { coverage: true }) })
}

// ------------------------------------------------------------------------------------------------ the answers
//
// The keys act on one of Claude's answers: the last words of a turn that answered (a turn that ended in an error
// answers nothing: its last row is Claude Code's error). By default the newest; { and } pick an earlier or a later one,
// so a long answer stays in reach when short replies came after it (a subagent's report, a follow-up), and the
// bar says which reply the keys act on whenever more than one came since the person's last prompt.

/** The session's answers, oldest first: held for this load, rebuilt from the records at a resume. */
async function answerRows($: Engine): Promise<string[]> {
  return (((await $.state.get(ANSWERS)).value ?? []) as string[]).filter(r => typeof r === 'string')
}

/** A resumed session's answers, from its records (each answer's record says it is one), and the newest is the
 *  message the keys act on. */
async function restoreAnswers($: Engine): Promise<void> {
  if ((await answerRows($)).length) return
  const rows: string[] = []
  for (const row of await messageRows($)) if ((await recordNow($, row))?.final) rows.push(row)
  if (!rows.length) return
  await $.state.set(ANSWERS, rows)
  if (!(await $.state.get(ANSWER)).value) await $.state.set(ANSWER, rows[rows.length - 1]!)
}

/** Whether an index row is a prompt the person sent (not a task's notification or another agent's message, which
 *  start a turn of their own): typed, sent from a phone or the SDK, or a key of theirs that asked Claude (a verb's
 *  ask, this plugin's prompt). A row an older index kept with no sender is told by its words. */
const personPrompt = (x: Any) => x.kind === 'user' && (x.by ? /^(composer|bridge|sdk|plugin|auto-continuation)$/.test(String(x.by)) : !/^\s*(<task-notification>|<agent-message|Another Claude session sent a message)/.test(String(x.text || '')))

/** Since the person's last prompt: that prompt, Claude's messages after it in order (`rows`), and those of them that
 *  ended a turn (`replies`): the answer to the prompt, and each answer to an agent's hand-back, a task's notification
 *  or another session's message. A turn that ended in an error answered nothing. */
async function sinceLastPrompt($: Engine): Promise<{ prompt: { row: string; text: string } | null; rows: string[]; replies: string[] }> {
  const idx = (await msgFilesNow($)).index
  let last = -1
  for (let i = idx.length - 1; i >= 0; i--) if (personPrompt(idx[i])) { last = i; break }
  const rows = idx.slice(last + 1).filter(x => x.kind === 'assistant').map(x => String(x.row))
  const replies = (await answerRows($)).filter(r => rows.includes(r))
  return { prompt: last >= 0 ? { row: String(idx[last].row), text: String(idx[last].text || '') } : null, rows, replies }
}

/**
 * Replies piled up: two or more of Claude's replies (turns it ended with words) came since the person's last prompt
 * and since the newest catch-up of them the person read. Then s offers to catch up on all the replies since that
 * prompt (`n`). A catch-up dismissed after it showed counts as read; one undone or never written does not.
 */
async function pileUp($: Engine): Promise<{ n: number; prompt: { row: string; text: string } | null; rows: string[]; replies: string[] } | null> {
  const since = await sinceLastPrompt($)
  let from = 0
  for (let i = since.replies.length - 1; i >= 0; i--) {
    if ((await recordNow($, since.replies[i]!))?.caughtUp) { from = i + 1; break }
  }
  return since.replies.length - from >= 2 ? { n: since.replies.length, ...since } : null
}

/** The catch-up under a reply, while it stands (not dismissed), or null. */
async function catchUpUnder($: Engine, row: string): Promise<MsgRecord | null> {
  const cu = (await recordNow($, row))?.caughtUp
  const rec = cu ? await recordNow($, cu) : null
  return rec && catchUpStands(rec) ? rec : null
}

/** The message the keys act on when the person picked none: the catch-up under the newest answer while it stands,
 *  else the newest answer. */
async function restRow($: Engine): Promise<string | null> {
  const answer = ((await $.state.get(ANSWER)).value as string | null | undefined) ?? null
  if (!answer) return null
  return (await catchUpUnder($, answer))?.row ?? answer
}

/** What { and } step through, oldest first: the answers, each standing catch-up right after the reply it is under. */
async function keyRows($: Engine): Promise<string[]> {
  const out: string[] = []
  for (const r of await answerRows($)) {
    out.push(r)
    const cu = await catchUpUnder($, r)
    if (cu) out.push(cu.row)
  }
  return out
}

/** s with replies piled up: one catch-up of every message since the person's last prompt, under the newest reply, with
 *  the chips open on it while its first version is written; a catch-up of the same replies written before goes. The
 *  keys act on it. Returns its row. */
async function catchUpNow($: Engine): Promise<string | null> {
  const pile = await pileUp($)
  if (!pile) return null
  for (const r of pile.replies) {
    const old = (await recordNow($, r))?.caughtUp
    if (old) await sqDismiss($, old, { quiet: true })
  }
  const row = await sqCatchUp($, { host: pile.replies[pile.replies.length - 1]!, rows: pile.rows, replies: pile.n, question: pile.prompt?.text ?? '', prompt: pile.prompt?.row ?? null })
  if (!row) return null
  await setTray($, null)
  await setCardFocus($, null)
  await $.state.set(SELROW, null)
  await setPick($, { row, verb: 's' })
  await quietly($.ui.scroll({ to: { key: `cu-${row}` }, block: 'nearest' }))
  return row
}

/** A catch-up dismissed (its chips' 0): the chips close, and the keys go back to the newest reply. */
async function dismissNow($: Engine, row: string, undo = false): Promise<void> {
  await sqDismiss($, row, { undo })
  const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
  if (pick?.row === row) await setPick($, null)
  if ((await $.state.get(SELROW)).value === row) await $.state.set(SELROW, null)
}

/** The answers since the person's last prompt, and where the message the keys act on stands among all answers. */
async function answerPlace($: Engine, row: string): Promise<{ all: string[]; at: number; since: number }> {
  const all = await answerRows($)
  const idx = (await msgFilesNow($)).index
  let last = -1
  for (let i = idx.length - 1; i >= 0; i--) if (personPrompt(idx[i])) { last = i; break }
  const after = new Set(idx.slice(last + 1).filter(x => x.kind === 'assistant').map(x => String(x.row)))
  return { all, at: all.indexOf(row), since: all.filter(r => after.has(r)).length }
}

/** { and }: the keys act on the answer before or after the one they act on now; the newest gives the keys back to the
 *  latest turn. Returns false when there is none that way. */
async function stepAnswer($: Engine, dir: number): Promise<boolean> {
  const all = await keyRows($)
  const row = await actingRow($)
  const i = row ? all.indexOf(row) : -1
  const to = i < 0 ? (dir < 0 ? all.length - 1 : -1) : i + dir
  const next = to >= 0 && to < all.length ? all[to]! : null
  if (!next) return false
  const rest = await restRow($)
  await setTray($, null)
  await setCardFocus($, null)
  await $.state.set(SELROW, next === (rest ?? all[all.length - 1]) ? null : next)
  // the answer in view, where the transcript draws it now
  const cu = isCatchUp(await recordNow($, next))
  await quietly($.ui.scroll({ to: { key: cu ? `cu-${next}` : `msg-${next}-b0` }, block: 'nearest' }))
  return true
}

/** The rows that draw a verb row, oldest first, and the message the keys act on: the one picked, else the latest. */
async function actingRow($: Engine): Promise<string | null> {
  const sel = (await $.state.get(SELROW)).value as string | null | undefined
  if (sel) return sel
  const rest = await restRow($)
  if (rest) return rest
  // a resumed session: the latest answer its records name
  const rows = await messageRows($)
  for (const row of [...rows].reverse()) if ((await recordNow($, row))?.final) return row
  return null
}

/** The card `1` opens in the detail view: the newest one drawn under the message the keys act on, or null. */
async function focusedCard($: Engine): Promise<ObjRef | null> {
  const row = await actingRow($)
  if (!row) return null
  const list = ((await $.state.get({ ...UNDER, id: row })).value ?? []) as ObjRef[]
  return list.length ? list[list.length - 1]! : null
}

/** The rows of Claude's messages in this session, oldest first: the index's (a resumed session's too) and this load's. */
async function messageRows($: Engine): Promise<string[]> {
  const f = await msgFilesNow($)
  const held = ((await $.state.get(MSGROWS)).value ?? []) as string[]
  return [...new Set([...f.index.filter(x => x.kind === 'assistant').map(x => String(x.row)), ...held])]
}

async function allMarks($: Engine): Promise<{ row: string; i: number }[]> {
  const rows = await messageRows($)
  const msgs: { row: string; marks: unknown[] }[] = []
  for (const row of rows) {
    const rec = await recordNow($, row)
    if (rec?.marks?.length) msgs.push({ row, marks: rec.marks })
  }
  return markOrder(msgs)
}

/** Open the tray on a mark of a message (a press on it, or ] and [): its message becomes the one the keys act on. */
async function openMark($: Engine, row: string, i: number, drawn?: MsgRecord): Promise<void> {
  let rec = await recordNow($, row)
  if (rec && !rec.uuid && drawn?.uuid) {
    rec = { ...rec, uuid: drawn.uuid }
    await saveRecord($, rec)
  }
  if (!rec && drawn) {
    // a message drawn from its words alone (a resumed session with no record): its record is kept now
    rec = drawn
    await saveRecord($, drawn)
    const rows = ((await $.state.get(MSGROWS)).value ?? []) as string[]
    if (!rows.includes(row)) await $.state.set(MSGROWS, [...rows, row])
  }
  const m = rec?.marks?.[i]
  if (!m) return
  // a resumed session's side threads, read back once (outside any drawing), so the panel knows a mark's thread
  await restoreThreads($, (await rootHere($)) || undefined).catch(() => undefined)
  await setPick($, null)
  await setCardFocus($, null)
  await setTray($, trayOpen(trayFrameOf(rec, i)) as Tray)
  await $.state.set(SELROW, row === (await restRow($)) ? null : row)
  // a gloss opened: the observer's backoff for glosses starts over
  if (m.kind === 'gloss') await $.store.set('observer.glossUnopened', 0)
  // the mark in view, when a key opened it (it may be in a message above the screen)
  await revealMark($, rec!, i)
}

/** A mark brought into view where the transcript draws it now (a row far above the screen is not drawn, and the
 *  engine moves the transcript only for a press, not for a key in the prompt, so then the tray's title names it). */
async function revealMark($: Engine, rec: MsgRecord, i: number): Promise<void> {
  await quietly($.ui.scroll({ to: { key: `mk-${rec.row}-${i}` }, block: 'nearest' }))
}

/** What ] and [ move through, in reading order: each message's marks, then the cards drawn under it. */
async function focusOrder($: Engine): Promise<{ row: string; i?: number; card?: ObjRef }[]> {
  const out: { row: string; i?: number; card?: ObjRef }[] = []
  for (const host of await messageRows($)) {
    // a reply, then the catch-up under it
    const cu = await catchUpUnder($, host)
    for (const row of cu ? [host, cu.row] : [host]) {
      const rec = await recordNow($, row)
      ;(rec?.marks || []).forEach((_, i) => out.push({ row, i }))
      for (const card of ((await $.state.get({ ...UNDER, id: row })).value ?? []) as ObjRef[]) out.push({ row, card })
    }
  }
  return out
}

async function stepMark($: Engine, dir: number): Promise<void> {
  const list = await focusOrder($)
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const base = trayBase(tray) as TrayFrame | null
  const cf = (await $.state.get(CARDFOCUS)).value as (ObjRef & { row: string }) | null
  const at = base && base.row != null ? list.findIndex(p => p.row === base.row && p.i === base.i) : cf ? list.findIndex(p => p.row === cf.row && p.card?.id === cf.id && p.card?.root === cf.root) : -1
  let next: { row: string; i?: number; card?: ObjRef } | null = null
  if (at >= 0) next = list[(at + (dir > 0 ? 1 : -1) + list.length) % list.length] ?? null
  else {
    // from rest: what the message the keys act on holds (] its first mark, [ its last card), else the latest message's
    const row = await actingRow($)
    const here = list.filter(p => p.row === row)
    const pool = here.length ? here : list.filter(p => p.row === list[list.length - 1]?.row)
    next = (dir > 0 ? pool[0] : pool[pool.length - 1]) ?? null
  }
  if (!next) { $.ui.toast('Nothing to step to yet: each cite, explain and card in Claude\'s replies opens here.'); return }
  if (next.card) await focusCard($, next.row, next.card)
  else await openMark($, next.row, next.i!)
}

/** A card under a message takes the keys (] reached it): its own keys win while it has the focus, and the bar names
 *  them; 0 gives the keys back. */
async function focusCard($: Engine, row: string, card: ObjRef): Promise<void> {
  await setTray($, null)
  await setPick($, null)
  await setCardFocus($, { id: card.id, v: card.v, root: card.root, row })
  await $.state.set(SELROW, row === (await restRow($)) ? null : row)
  await quietly($.ui.scroll({ to: { key: `row-${row}-card-${card.id}` }, block: 'nearest' }))
}

/** The tray closes as esc closes it: it leaves the focus stack, and the browser's tray closes with it. */
export async function closeTray($: Engine): Promise<void> {
  await setTray($, null)
}

/** The tray as it stands now, on both surfaces: $.state for the terminal's own reads, and the tray program's state,
 *  kept where the browser reads it (panes/tray.js). */
async function setTray($: Engine, tray: Tray | null): Promise<void> {
  const next = tray && tray.stack && tray.stack.length ? tray : null
  await $.state.set(TRAY, next)
  if (next) await pushFocus($, 'tray')
  else await popFocus($, 'tray')
  await patchPaneState($, 'tray', {}, { stack: next?.stack ?? [], asking: !!next?.asking })
}

/** A pane's shared state changed (here, or in the browser): the terminal's own copies follow it. */
export async function paneStateChanged($: Engine, name: string, _args: Record<string, unknown>, state: Record<string, unknown>): Promise<void> {
  if (name !== 'tray') return
  const stack = Array.isArray(state.stack) ? (state.stack as TrayFrame[]) : []
  const now = (await $.state.get(TRAY)).value as Tray | null
  const next = stack.length ? { stack, asking: !!state.asking } : null
  if (JSON.stringify(now ?? null) !== JSON.stringify(next)) await $.state.set(TRAY, next)
  if (next) { await setCardFocus($, null); await pushFocus($, 'tray') } else await popFocus($, 'tray')
}

/** The card a tray frame shows, as the tray program wants it (panes/tray.js): its parts and its sections' parts drawn
 *  in the sandbox at `w` (cards.js drawnCard). */
async function trayCard($: Engine, req: Any, w: number, h: number): Promise<Any> {
  let spec: Any
  if (req?.kind === 'gloss') spec = explainerCard({ gloss: req.gloss || {} })
  else if (typeof req?.ref === 'string' && req.ref) spec = await sourceSpec($, req.ref, req.kind === 'spark' ? 'sparkline' : String(req.label || req.ref), h)
  else return { problem: 'this mark names no ref, so there are no rows to show', drawings: [], links: [] }
  return drawnCard(spec, async (part: Any) => (await drawPart($, part, w, h)).drawing)
}

/** `thimble resolve <ref> --json`, as the person's own read (never counted as Claude's coverage). */
async function resolveJson($: Engine, root: string, ref: string, n = 6, label?: string): Promise<Any> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  // with the citation's words, a citation of a whole query opens the row that holds the value it shows
  const words = label && label !== ref ? ['--label', label] : []
  const r = await $.process.run([`${dir}/bin/thimble`, 'resolve', ref, '-n', String(n), ...words, '--json'], { cwd: root, env: await leanEnv($, root), timeoutMs: 60000 })
  try { return JSON.parse(r.stdout) } catch { return { ref, error: (r.stdout + r.stderr).trim().slice(0, 300) || 'thimble resolve gave nothing' } }
}

/** One part of a card drawn: its program in the drawing contract's sandbox, then as terminal cells. */
async function drawPart($: Engine, part: { program: string; data: unknown; id?: string }, w: number, h: number): Promise<Any> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  // a card drawn whole (a value of a card) keeps its id, so its rows' refs read as the card's own
  const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `${dir}/shell/node/prep.mjs`], { stdin: JSON.stringify({ object: { id: part.id || 'card', program: part.program, data: part.data }, w, h, mode: 'inline' }), timeoutMs: 30000 })
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 200) || `exit ${r.exitCode}`)
  const out = JSON.parse(r.stdout)
  return { drawing: out.drawing, grid: renderTerm(out.drawing, { w }) }
}

/** A citation's card spec (cards.js citeCard): the ref resolved, the query's record or the code file's lines read, as
 *  the person's own reads. */
async function sourceSpec($: Engine, ref: string, label: string, room: number): Promise<Any> {
  const root = await rootHere($)
  if (!root) return { title: label, right: 'cite', problem: `no thimble/ folder here to read ${ref} from; run thimble in the data folder first` }
  return citeCard({ ref, label, root, room }, { resolve: (r: string, n: number, l?: string) => resolveJson($, root, r, n, l), read: (p: string) => $.fs.read(p) })
}

/** How long v waits before it asks: a letter typed within it makes the key the start of a word. */
const WORD_MS = 700
/** v pressed with nothing proposed, waiting out WORD_MS before it asks Claude (a letter typed meanwhile cancels it). */
let pendingV: { row: string; cancelled: boolean } | null = null

/** A key of the row under a message, v or s: its line opens (a press on the open one closes it). v with no view
 *  proposed asks Claude for another view at once, once the moment in which it could begin a word has passed. */
async function pressRowVerb($: Engine, row: string, key: string): Promise<void> {
  const cur = (await $.state.get(PICK)).value as Any
  if (cur && cur.row === row && cur.verb === key) { await setPick($, null); return }
  // what the person pressed, with whether the post-turn pass had lit it (thimble stats: how often a lit verb is used)
  const rec = await recordNow($, row)
  const v = (rec?.verbs as Record<string, Any> | undefined)?.[key]
  void recordEvent($, { kind: 'press', verb: key, row, lit: !!v?.lit })
  await setTray($, null)
  await setCardFocus($, null)
  if (key === 'v' && rec && !(v?.lit && Array.isArray(v.proposals) && v.proposals.length)) {
    await setPick($, null)
    const wait = { row, cancelled: false }
    pendingV = wait
    $.clock.after(WORD_MS, () => {
      if (wait.cancelled || pendingV !== wait) return
      pendingV = null
      void (async () => { const now = (await recordNow($, row)) ?? rec; await askForView($, now, ANOTHER_VIEW) })()
    })
    return
  }
  await setPick($, { row, verb: key })
  await $.state.set(SELROW, row === (await restRow($)) ? null : row)
  // the line in view, when a key opened it under a message above the screen
  await quietly($.ui.scroll({ to: { key: `vl-${row}-opt-0` }, block: 'nearest' }))
}

/** An option of the open line picked (the proposals program's k.do('pick')): v asks for that view, outside the
 *  press. */
async function pickOption($: Engine, row: string, key: string, choice: string): Promise<boolean> {
  const rec = await recordNow($, row)
  if (!rec || key !== 'v') return false
  await setPick($, null)
  $.clock.after(0, () => { void askForView($, rec, choice) })
  return true
}

/** v on a message: Claude is asked for another view of it (visualize.js), as a turn whose row reads as the press. What
 *  Claude makes for a catch-up is drawn under the catch-up, not under the words of the turn it asks for. */
async function askForView($: Engine, rec: MsgRecord, choice: string): Promise<void> {
  try {
    const guide = `${$.plugin.root.replace(/\/+$/, '')}/skills/thimble/cards.md`
    const request = viewRequest({ message: rec, choice: choice !== ANOTHER_VIEW ? choice : '', guide })
    placeNext = isCatchUp(rec) ? rec.row : null
    await ask($, request, 'visualize', choice || 'another view of this answer')
  } catch (err) {
    failed($, 'v did not ask for a view', err, 'Press v under the message again, or ask Claude')
  }
}

/** The person's prompt that a message of Claude's answers: the nearest user row before it in the index. */
export async function questionBefore($: Engine, row: string): Promise<string> {
  const f = await msgFilesNow($)
  const i = f.index.findIndex(x => x.row === row)
  for (let j = (i < 0 ? f.index.length : i) - 1; j >= 0; j--) if (f.index[j].kind === 'user' && f.index[j].text) return String(f.index[j].text)
  return ''
}

/** What the observer gave for the turn's answer: its lit verbs and glosses, in the answer's record. */
export async function applyObserver($: Engine, row: string, out: { verbs: Record<string, unknown>; glosses: Record<string, unknown> }): Promise<MsgRecord | null> {
  const rec = await recordNow($, row)
  if (!rec) return null
  const next = withObserver(rec, out) as MsgRecord
  await saveRecord($, next)
  return next
}

/** A message's record, for the observer. */
export async function messageRecord($: Engine, row: string): Promise<MsgRecord | null> {
  return recordNow($, row)
}

/** The row of the latest turn's answer: the message its verb row is drawn under. */
export async function answerRow($: Engine): Promise<string | null> {
  return ((await $.state.get(ANSWER)).value as string | null | undefined) ?? null
}

/** The tray as the band draws it: the tray program (panes/tray.js) on its state, the card on top of its stack, or the
 *  mark's side thread once 1 was pressed. Its keys are in the bar. */
async function trayBand($: Engine, e: Any, tray: Tray): Promise<Any | null> {
  if (!trayTop(tray)) return null
  const w = Math.max(40, Math.min(104, (e.props.bodyColumns ?? 100) - 3))
  // the mark's thread, as it answers, draws again
  const t = await trayScope($)
  if (t) await $.state.get({ plugin: 'thimble', key: 'thread', id: threadKeyOf(t.scope) })
  const { Box } = $.ui.resolve(e) as Any
  const link = tray.asking ? null : await trayFileLink($, e, trayTop(tray) as TrayFrame)
  return Box({ marginLeft: 2, flexDirection: 'column', children: [await paneEl($, e, 'tray', {}, { w, h: 14 }), ...(link ? [link] : [])] })
}

/** Under a citation of rows of a file, the file as a link that opens it, the way Claude Code links a file in a reply:
 *  Claude Code's own Markdown draws `[revisions.jsonl:41](file:///…/revisions.jsonl#L41)`, an OSC 8 hyperlink where
 *  the terminal takes one (else the words, then the address). Null for any other frame, or a file not there. */
async function trayFileLink($: Engine, e: Any, top: TrayFrame | null): Promise<Any | null> {
  if (!top || top.kind === 'gloss' || typeof top.ref !== 'string') return null
  const link = fileLink(top.ref, await rootHere($))
  if (!link || !(await $.fs.exists(link.path).catch(() => false))) return null
  const { Markdown } = $.ui.resolve(e) as Any
  if (!Markdown) return null
  const words = link.label.replace(/[[\]\\]/g, c => '\\' + c)
  return Markdown({ key: 'tray-file', text: `↗ [${words}](${link.href})` })
}

/** A question asked with the tray open: the side thread of its mark (thread.ts), which main does not see. The tray
 *  then shows that thread. Returns the reason Claude Code shows for the dropped prompt. */
async function askTrayThread($: Engine, text: string): Promise<string | null> {
  const t = await trayScope($)
  if (!t) return null
  const root = (await rootHere($)) || String(await $.session.cwd())
  const r = await askThread($, { text, root, scope: t.scope as ThreadScope, refs: t.refs, card: null })
  if (r.problem) return `${r.problem}. Your words are back in the prompt; 0 closes the panel, and the prompt then goes to Claude here.`
  const tray = (await $.state.get(TRAY)).value as Tray | null
  if (tray) await setTray($, { ...tray, asking: true })
  $.clock.after(30, () => { void $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined) })
  return `asked the thread of ${cut(t.label, 40)}`
}

/** A question asked with the tray open: what it carries for Claude, and the row's few words for the person. */
async function trayScope($: Engine): Promise<{ context: string; label: string; scope: Record<string, unknown>; refs: string[] } | null> {
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const frame = trayTop(tray) as TrayFrame | null
  if (!frame) return null
  if (frame.row == null) {
    return {
      label: frame.label || frame.ref!, scope: { mark: { kind: 'cite', ref: frame.ref, label: frame.label } }, refs: [frame.ref!],
      context: `The analyst asked this with a citation open in the tray: ${frame.label || ''} (${frame.ref}). "This" may mean that value. \`thimble rows ${frame.ref}\` shows its rows.`,
    }
  }
  const rec = await recordNow($, frame.row)
  const m = rec?.marks?.[frame.i!]
  if (!rec || !m) return null
  const begins = shownOf(rec).replace(/\s+/g, ' ').trim().slice(0, 80)
  if (m.kind === 'gloss') {
    const g = rec.glosses?.[m.gloss!] ?? { term: '' }
    return {
      label: g.term, scope: { row: rec.row, mark: { kind: 'gloss', term: g.term } }, refs: (g.refs || []).slice(0, 3),
      context: `The analyst asked this with an explainer of your reply open in the tray: the term "${g.term}" in your reply that begins "${begins}". The explainer said: ${g.body || g.title || ''}${g.here ? ' ' + g.here : ''} "This" or "it" may mean that term.`,
    }
  }
  const label = m.kind === 'spark' ? `the sparkline of ${m.ref}` : String(m.label)
  return {
    label, scope: { row: rec.row, mark: { kind: m.kind, ref: m.ref, label } }, refs: [seriesRef(m.ref!)?.query ?? m.ref!],
    context: `The analyst asked this with a ${m.kind === 'spark' ? 'sparkline' : 'citation'} of your reply open in the tray: ${label} (${m.ref}), in your reply that begins "${begins}". "This" may mean that value. \`thimble rows ${seriesRef(m.ref!)?.query ?? m.ref}\` shows its rows.`,
  }
}

// ------------------------------------------------------------------------------------------------ the bar
//
// One bar above the prompt, where thimble 0.9 puts its line; the area under the prompt stays Claude Code's own.
//
//   thimble  v visualize · s squeeze · ] cite & explain · 1 open detail                     2 threads · coverage 34%
//
// At its left, what the keys do now, in words as Claude Code says its own keys: at rest the verbs of the message the
// keys act on (a lit one with its note in place of its name), `] cite & explain` when that message has marks, `1 open
// detail` when a card is under it. While a pane, the tray or the chips have focus, the
// left side is their keys instead, and it comes back after. At its right, the session's counts that are not zero: a
// count that changed is drawn bright for a moment, then dims. Inside a thread (the card detail, a mark's thread) its
// label names the thread the prompt goes to, `thimble:main/<it>`.

const BRIGHT_MS = 1600

/** The read share of a file as `thimble coverage` reports it: rows computed over, or lines read, or rows shown, of its
 *  rows; a file searched or named counts as not read. */
function readShare(f: Any): number {
  if (!f || !f.rows) return 0
  if (f.computed) return Math.min(1, f.computed / f.rows)
  if (f.read_lines) return Math.min(1, f.read_lines / Math.max(1, f.lines || f.rows))
  if (f.shown) return Math.min(1, f.shown / f.rows)
  return 0
}

/** A share as the line says it: `34%`, a decimal under 1%, `<0.01%`, and 100% only when all was read. */
export function percent(part: number): string {
  if (!(part > 0)) return '0%'
  if (part >= 1) return '100%'
  const p = 100 * part
  if (p < 0.01) return '<0.01%'
  if (p < 0.1) return `${(Math.floor(p * 100) / 100).toFixed(2)}%`
  if (p < 1) return `${(Math.floor(p * 10) / 10).toFixed(1)}%`
  return `${Math.min(99, Math.round(p))}%`
}

/** This session's counts for the bar, counted again: the side threads, and (with `coverage`) the share of the
 *  folder's data Claude has read. A count that changed is stamped, so it brightens. */
export async function recount($: Engine, o: { coverage?: boolean } = {}): Promise<void> {
  try {
    const old = ((await $.state.get(COUNTS)).value ?? null) as LineCounts | null
    const now = await $.clock.now()
    const root = await rootHere($)
    let cov = old?.cov ?? 0
    if (o.coverage && root && person === 'now') {
      const dir = $.plugin.root.replace(/\/+$/, '')
      try {
        const r = await $.process.run([`${dir}/bin/thimble`, 'coverage', '--json'], { cwd: root, env: { THIMBLE_ROOT: root, THIMBLE_SESSION: await sessionKey($) }, timeoutMs: 60000 })
        const got = JSON.parse(r.stdout)
        const files = (got.files || []) as Any[]
        const rows = files.reduce((n, f) => n + (Number(f.rows) || 0), 0)
        // the kernel's own share, by the rule its text says (a search, a listing or a count is not a read)
        if (typeof got.total?.read_share === 'number') cov = got.total.read_share
        else if (rows > 0) cov = files.reduce((n, f) => n + readShare(f) * (Number(f.rows) || 0), 0) / rows
      } catch {
        // the line keeps the last share it had
      }
    }
    const next: LineCounts = { threads: threadCount(), cov, at: now, changed: { ...(old?.changed || {}) } }
    const keys = ['threads', 'cov'] as const
    for (const k of keys) if (old ? next[k] !== old[k] : next[k] > 0) next.changed[k] = now
    if (old && JSON.stringify({ ...old, at: 0 }) === JSON.stringify({ ...next, at: 0 })) return
    await $.state.set(COUNTS, next)
    // the brightened counts dim again
    $.clock.after(BRIGHT_MS + 50, () => { void (async () => { const cur = (await $.state.get(COUNTS)).value as LineCounts | null; if (cur) await $.state.set(COUNTS, { ...cur, at: await $.clock.now() }) })() })
  } catch {
    // the line keeps the counts it had
  }
}

/** The thread the prompt goes to now, as `thimble:main/<it>`: the open card's, or the tray's mark's. Null in main. */
async function threadInFront($: Engine): Promise<string | null> {
  if (detailIsOpen()) {
    const sel = (await $.state.get(SEL)).value as Sel | null
    return sel && !sel.cite && !sel.cites ? `thimble:main/${sel.id}` : null
  }
  const tray = (await $.state.get(TRAY)).value as Tray | null
  if (tray?.asking) {
    const t = await trayScope($)
    if (t) return `thimble:main/${cut(t.label, 32)}`
  }
  return null
}

// ------------------------------------------------------------------------------------------------ the focus stack

/** What takes the keys, newest last: each surface pushes itself as it opens and leaves as it closes (the detail, the
 *  squeeze chips, v's proposals, the tray, a card under a reply). The bar says the keys of
 *  the top one alone, read from this one state, so it redraws whenever the stack changes. */
type FocusKind = 'detail' | 'chips' | 'proposals' | 'tray' | 'card'
const FSTACK = { plugin: 'thimble', key: 'focus' } as const
const FOCUS_ORDER: FocusKind[] = ['card', 'proposals', 'tray', 'chips', 'detail']

export async function pushFocus($: Engine, kind: FocusKind): Promise<void> {
  const now = ((await $.state.get(FSTACK)).value ?? []) as FocusKind[]
  const next = [...now.filter(k => k !== kind), kind]
  if (next.join() !== now.join()) await $.state.set(FSTACK, next)
}

export async function popFocus($: Engine, ...kinds: FocusKind[]): Promise<void> {
  const now = ((await $.state.get(FSTACK)).value ?? []) as FocusKind[]
  const next = now.filter(k => !kinds.includes(k))
  if (next.join() !== now.join()) await $.state.set(FSTACK, next)
}

/** v's line or the chips, the PICK state, with the stack kept beside it. */
async function setPick($: Engine, pick: { row: string; verb: string } | null): Promise<void> {
  await $.state.set(PICK, pick)
  if (!pick) await popFocus($, 'chips', 'proposals')
  else { await popFocus($, pick.verb === 's' ? 'proposals' : 'chips'); await pushFocus($, pick.verb === 's' ? 'chips' : 'proposals') }
}

/** A card under a reply with the keys (] reached it), or none. */
async function setCardFocus($: Engine, cf: (ObjRef & { row: string }) | null): Promise<void> {
  await $.state.set(CARDFOCUS, cf)
  if (cf) await pushFocus($, 'card')
  else await popFocus($, 'card')
}

type FocusWords = { status?: { text: string; tone: 'error' | 'warning' } | null; keys: string }

/** What the surface on top of the focus stack says now: what it shows (a status) and its keys, as words. Undefined
 *  when that surface has gone (its state cleared), so the next one down speaks. */
async function focusWords($: Engine, kind: FocusKind): Promise<FocusWords | undefined> {
  const status = (d: Any) => (d?.status?.text ? { text: String(d.status.text), tone: (String(d.status.text).startsWith('×') ? 'error' : 'warning') as 'error' | 'warning' } : null)
  if (kind === 'detail') {
    const d = await detailKeys($)
    return d ? { keys: d } : undefined
  }
  const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
  if (kind === 'chips') {
    if (pick?.verb !== 's') return undefined
    // the chips' own keys, as their program names them (panes/chips.js), after what it says of the message now
    const d = await paneNow($, 'chips', { row: pick.row })
    return { status: status(d), keys: barText([d]) }
  }
  if (kind === 'tray') {
    const tray = (await $.state.get(TRAY)).value as Tray | null
    if (!tray) return undefined
    // the tray program's keys (panes/tray.js), after what it says while the person asks its thread: run now, so the
    // line names the keys of a card that arrived after the tray was last drawn (its sections', its citations')
    const d = await paneNow($, 'tray')
    return { status: status(d), keys: barText([d]) || '0 close' }
  }
  if (kind === 'proposals') {
    if (!pick || pick.verb === 's') return undefined
    const d = paneDrawing('proposals', { row: pick.row, verb: pick.verb }) ?? (await paneNow($, 'proposals', { row: pick.row, verb: pick.verb }))
    return { keys: barText([d]) || '0 close' }
  }
  // a card under a reply with the focus (] reached it): its own keys, those that reach it here, then the host's
  const cf = (await $.state.get(CARDFOCUS)).value as (ObjRef & { row: string }) | null
  if (!cf) return undefined
  const d = await inlineDrawing($, cf)
  // a key the host keeps never reaches the card here (Claude Code's ← → ↑ ↓ ↵ among them), so the bar never names it
  const taken = hostKeys('inline', 'terminal')
  const own = keysOf(d ? { ...d, on: (d.on || []).filter((h: Any) => !(String(h?.name) in taken)) } : d)
  return { keys: [...own.map(g => `${g.key} ${g.words}`), '1 open detail', '] next', '0 back'].join(' · ') }
}

/** The keys of what has focus now: the top of the focus stack that is still there; a surface whose state is set but
 *  that never pushed itself (a reload while it was open) comes after, in the shell's own order. Null at rest. */
async function focusKeys($: Engine): Promise<FocusWords | null> {
  const stack = ((await $.state.get(FSTACK)).value ?? []) as FocusKind[]
  for (const kind of [...stack].reverse()) {
    const w = await focusWords($, kind)
    if (w) return w
  }
  for (const kind of [...FOCUS_ORDER].reverse()) {
    if (stack.includes(kind)) continue
    const w = await focusWords($, kind)
    if (w) return w
  }
  return null
}

/** Keys as the bar says them, `1 ask · 0 close · ] next`, cut into each key and its words: the key is the first
 *  token and any symbols after it (`[ ]`, `{ }`, `↑ ↓`); a lit verb's `s ● note` keeps its color. */
function keySegments(keys: string): { key: string; words: string; color?: string; short?: string; onPress?: () => unknown }[] {
  return keys.split(' · ').map(seg => {
    const lit = /^([a-z]) ● (.*)$/.exec(seg)
    if (lit) return { key: lit[1]!, words: `● ${lit[2]}`, color: keyColor(lit[1]!, theme), short: `● ${lit[2]!.split(/\s+/)[0]}` }
    const t = seg.split(' ')
    // a phrase with no key (`type to ask`): words alone
    if (t[0]!.length > 3 && /^[a-z]+$/.test(t[0]!)) return { key: '', words: seg }
    let n = 1
    while (n < t.length && /^[^\p{L}\p{N}]+$/u.test(t[n]!)) n++
    return { key: t.slice(0, n).join(' '), words: t.slice(n).join(' ') }
  })
}

/** One key of the bar: its key, its words (and their first word, `short`, for a narrow bar), its colors, and a press. */
type BarSeg = { key: string; words: string; short?: string; color?: string; wordsColor?: string | null; bold?: boolean; tone?: 'error' | 'warning'; status?: boolean; label?: string; onPress?: () => unknown }

/** The keys each bar named, oldest first, with when it first showed them. A key the line named a moment ago
 *  is taken, never typed, even when what it named has gone meanwhile (a squeeze that arrived closed the tray the
 *  person was closing): the person pressed what the line said. */
const barSeen: { at: number; keys: Set<string> }[] = []
/** How long a key stays the line's after the line stopped naming it: about the time to see that it changed. */
const BAR_SEEN_MS = 1000

/** The keys a line names, as keys come to prompt.edit: `1–4` is 1 to 4, `[ ]` is two keys, ⌫ is backspace. */
function namedKeys(left: BarSeg[]): Set<string> {
  const out = new Set<string>()
  for (const g of left) {
    for (const k of g.key.split(' ')) {
      const range = /^(\d)–(\d)$/.exec(k)
      if (range) for (let d = Number(range[1]); d <= Number(range[2]); d++) out.add(String(d))
      else if (k === '⌫') out.add('backspace')
      else if ([...k].length === 1) out.add(k)
    }
  }
  return out
}

function noteBar(at: number, left: BarSeg[]): void {
  const keys = namedKeys(left)
  const last = barSeen[barSeen.length - 1]
  if (last && last.keys.size === keys.size && [...keys].every(k => last.keys.has(k))) return
  barSeen.push({ at, keys })
  if (barSeen.length > 8) barSeen.shift()
}

/** Whether the line named key `k` a moment ago: one drawn after the key before this one was decided (`since`), on
 *  screen now or until less than BAR_SEEN_MS ago. */
function barNamed(k: string, now: number, since: number): boolean {
  for (let i = barSeen.length - 1; i >= 0; i--) {
    const until = barSeen[i + 1]?.at ?? now
    if (until < since || now - until > BAR_SEEN_MS) break
    if (barSeen[i]!.keys.has(k)) return true
  }
  return false
}

/** The bar: its label, what the keys do now at its left, the counts at its right. Null with nothing to say.
 *  It is always one line: with less room it drops the counts (coverage last), then says each key's words by their
 *  first word, then drops its label, then cuts its end (panes/host.js fitBar). Beside a docked pane Claude Code gives
 *  the band only the transcript's column, so there it is the narrow form. */
async function barEl($: Engine, els: Any, w: number, working = false): Promise<Any | null> {
  const { Box, Button, Text } = els
  const left: BarSeg[] = []
  const focus = await focusKeys($)
  if (focus) {
    // what the focused surface says now, cut at its end when the line is short (never to its first word), then its keys
    if (focus.status) left.push({ key: '', words: focus.status.text, tone: focus.status.tone, status: true })
    for (const g of keySegments(focus.keys)) {
      if (g.key || g.words) left.push({ key: g.key, words: g.words, ...(g.color ? { color: g.color, wordsColor: g.color } : {}), ...(g.short ? { short: g.short } : {}), ...(g.onPress ? { onPress: g.onPress } : {}) })
    }
  } else if (!working) {
    // (while Claude works the verbs wait: they act on its answer, which is not there yet)
    const row = await actingRow($)
    const rec = row ? await recordNow($, row) : null
    if (row && rec) {
      const verbs = ROW_KEYS
      const sqUi = ((await $.state.get({ ...SQZ, id: row })).value ?? null) as SqzUi | null
      const lit: Record<string, { lit?: boolean; note?: string }> = { ...(rec.verbs || {}) }
      const sv = sLit(rec, sqUi)
      if (sv) lit.s = sv
      else delete lit.s
      // replies piled up since the person's last prompt, and the keys on the newest: s catches up on them, lit and bold
      const pile = !(await $.state.get(SELROW)).value ? await pileUp($) : null
      for (const v of verbs) {
        const color = keyColor(v.key, theme)
        const on = lit[v.key]
        if (v.key === 's' && pile) left.push({ key: 's', words: `catch up on ${pile.n} replies`, short: 'catch up', color, wordsColor: color, bold: true, label: 'catch up', onPress: () => catchUpNow($) })
        else if (on?.lit && on.note) left.push({ key: v.key, words: `● ${on.note}`, short: `● ${v.name}`, color, wordsColor: color, label: v.name, onPress: () => pressRowVerb($, row, v.key) })
        else left.push({ key: v.key, words: v.name, color, label: v.name, onPress: () => pressRowVerb($, row, v.key) })
      }
      // ] steps through what the answer holds: its marks, then its cards (a card focused takes its own keys)
      const cardsHere = ((await $.state.get({ ...UNDER, id: row })).value ?? []) as ObjRef[]
      if (rec.marks.length) left.push({ key: ']', words: 'cite & explain', color: markColors(theme).cite, onPress: () => stepMark($, 1) })
      else if (cardsHere.length) left.push({ key: ']', words: 'card', color: FOCUS[theme], onPress: () => stepMark($, 1) })
      const ref = await focusedCard($)
      if (ref) left.push({ key: '1', words: 'open detail', color: FOCUS[theme], onPress: () => openDetail($, ref) })
      // which reply the keys act on, once more than one came since the person's last prompt or an earlier one is
      // picked: { and } pick another (as ] and [ step through the marks; never < >, which read as the arrow keys)
      const place = await answerPlace($, row)
      if (isCatchUp(rec)) {
        const n = Number(rec.catchup!.replies) || 0
        left.push({ key: '{ }', words: `catch-up of ${n} replies`, short: 'catch-up', color: FOCUS[theme], label: 'another reply', onPress: async () => { if (!(await stepAnswer($, -1))) await $.state.set(SELROW, null) } })
      } else if (place.all.length > 1 && place.at >= 0 && (place.at < place.all.length - 1 || place.since > 1)) {
        // an earlier reply picked: its first words too, since a key cannot scroll the transcript to it
        const which = `reply ${place.at + 1} of ${place.all.length}`
        const begins = place.at < place.all.length - 1 ? cut(shownOf(rec).replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim(), 36) : ''
        left.push({ key: '{ }', words: begins ? `${which}: ${begins}` : which, short: which, color: FOCUS[theme], label: 'another reply', onPress: async () => { if (!(await stepAnswer($, -1))) await $.state.set(SELROW, null) } })
      }
    }
  }
  const c = ((await $.state.get(COUNTS)).value ?? null) as LineCounts | null
  const now = await $.clock.now()
  noteBar(now, left)
  const items: [string, number, string][] = c ? [
    ['threads', c.threads, c.threads === 1 ? '1 thread' : `${fmtN(c.threads)} threads`],
    ['cov', c.cov, `coverage ${percent(c.cov)}`],
  ] : []
  const counts = items.filter(([, n]) => n > 0).map(([id, , text]) => ({ id, text, bright: now - (c!.changed[id] ?? 0) < BRIGHT_MS }))
  const where = await threadInFront($)
  if (!left.length && !counts.length && !where) return null
  const fit = fitBar({ label: where ?? 'thimble', left, counts }, w) as { label: string; left: BarSeg[]; counts: { id: string; text: string; bright: boolean }[]; cut: boolean }
  // the label names whose keys these are; it is no link and no press, so it is drawn plain (an underline is a
  // citation's look)
  const label = fit.label ? [Text({ key: 'bar-label', color: FOCUS[theme], bold: !where, children: fit.label }), Text({ key: 'bar-gap', children: '  ' })] : []
  const segText = (g: BarSeg, i: number) => [
    ...(i ? [Text({ key: `ks${i}`, dimColor: true, children: ' · ' })] : []),
    ...(g.tone ? [Text({ key: `kt${i}`, color: g.tone, children: g.words })] : [
      ...(g.key ? [Text({ key: `kk${i}`, ...(g.color && g.wordsColor ? { color: g.color } : {}), ...(g.bold ? { bold: true } : {}), children: g.key })] : []),
      ...(g.words ? [Text({ key: `kw${i}`, ...(g.wordsColor ? { color: g.wordsColor } : { dimColor: true }), ...(g.bold ? { bold: true } : {}), children: `${g.key ? ' ' : ''}${g.words}` })] : []),
    ]),
  ]
  const countEls = fit.counts.flatMap((x, i) => [...(i ? [Text({ key: `csep-${x.id}`, dimColor: true, children: ' · ' })] : []), Text({ key: `count-${x.id}`, ...(x.bright ? { bold: true } : { dimColor: true }), children: x.text })])
  if (fit.cut) {
    // narrower than the shortest form: one line, cut at its end (no presses: the keys still work)
    return Box({ width: w, children: [Text({ key: 'bar-cut', wrap: 'truncate-end', children: [...label, ...fit.left.flatMap(segText), ...(countEls.length ? [Text({ children: '   ' }), ...countEls] : [])] })] })
  }
  // one row: each key a press, the counts at its right
  const leftEls = fit.left.flatMap((g, i) => g.onPress
    ? [...(i ? [Text({ key: `ks${i}`, dimColor: true, children: ' · ' })] : []), Button({ key: `bar-${g.key || i}-${i}`, plain: true, label: g.label || g.words, onPress: g.onPress, children: segText(g, 0) })]
    : segText(g, i))
  return Box({ flexDirection: 'row', justifyContent: 'space-between', width: w, children: [
    Box({ key: 'bar-left', flexDirection: 'row', flexShrink: 1, children: [...label, ...leftEls] }),
    ...(countEls.length ? [Box({ key: 'bar-counts', flexShrink: 0, children: [Text({ key: 'bar-right', wrap: 'truncate-end', children: countEls })] })] : []),
  ] })
}

/** A key that types whatever the shell holds: one with ctrl or meta, an edit with no one key (a paste, keys sent
 *  faster than one by one), and any key in a prompt with words in it. */
const typesAnyway = (e: KeyEdit) => !e.key || !!e.key.ctrl || !!e.key.meta || e.text !== ''

/** A key that types: the edit as Claude Code made it. */
async function keyTyped($: Engine, e: Any, next: (e: Any) => Promise<Any>): Promise<Any> {
  const out = await next(e)
  if (detailIsOpen()) detailTyped($, e, out)
  return out
}

/** The key the message layer holds (keys.ts). */
const shellKey = keySlot()

/** One key pressed in the prompt, answered: by the prompt.edit hook (`fresh`), or past its budget by its .catch, with
 *  the decision the hook began. A key taken is answered at once, and its work runs after (keys.ts). */
async function answerKey($: Engine, e: Any, next: Any, fresh: boolean): Promise<Any> {
  // when the key came: a letter typed straight after a verb key counts from here, however long the verb's work takes
  const at = await $.clock.now()
  // a paste while the detail is open begins a question there, so it waits its turn like a key
  const now = (on: KeyEdit) => typesAnyway(on) && !(detailIsOpen() && !on.key && !!on.inputText)
  const k = keyTake(shellKey, e, fresh, now, on => keyTurn($, on, at))
  const t = await k.turn
  const inTime = !next.signal.aborted
  keyAnswered(shellKey, k, t, inTime)
  // a key thimble took is a line in the session's events, with what had the keys: what people use, for measuring
  if (t.box && inTime && e.key?.key && !e.key.ctrl && !e.key.meta) {
    const key = String(e.key.key)
    $.clock.after(0, () => { void (async () => { const stack = ((await $.state.get(FSTACK)).value ?? []) as FocusKind[]; await recordEvent($, { kind: 'key', key, on: detailIsOpen() ? 'detail' : stack.at(-1) ?? 'rest' }) })().catch(() => undefined) })
  }
  if (t.box || !inTime) return t.box ?? { text: e.text, cursor: e.cursor }
  return keyTyped($, e, next)
}

/** What a key pressed in the prompt comes to (keys.ts): decided from reads alone, its work run after the answer. `at`:
 *  when the key came. */
async function keyTurn($: Engine, e: KeyEdit, at: number): Promise<KeyTurn> {
  const key = e.key
  // the open detail takes its own keys first (detail.tsx), and a letter there begins the question for the card's thread
  const d = detailIsOpen() ? await detailKey($, e) : null
  if (d?.box) return d
  if (!key || typesAnyway(e)) {
    return { box: null, work: async () => {
      await d?.work?.()
      keyOpened = null
    } }
  }
  if (d) return d
  const now = await $.clock.now()
  const since = keyDecided
  keyDecided = now
  const t = await emptyPromptKey($, key.key, e, at)
  // a key the bar named a moment ago is the line's, even when what it named has gone meanwhile: it does
  // nothing then, and never lands in the prompt
  if (!t.box && barNamed(key.key, now, since)) return { box: { text: e.text, cursor: e.cursor }, work: () => { keyOpened = null; cardKeyed = null } }
  // a key from the empty prompt ends what the key before it began (a word after v, or after a card's key)
  return { ...t, work: async () => { keyOpened = null; cardKeyed = null; trayKeyed = null; await t.work?.() } }
}

/** When the key before this one was decided (keyTurn): a line drawn before it is not what this key answers. */
let keyDecided = 0

/** The person moved the keys without a key in the prompt (closed a pane with esc or a click): no line drawn before
 *  that is what their next key answers, so a word they start typing then is typed. */
export function keysMoved(at: number): void {
  keyDecided = Math.max(keyDecided, at)
  barSeen.length = 0
}

/** A key pressed while the prompt is empty: the box as it should stand when the shell takes the key (null: it types),
 *  and what the key does. `now` is when the key came, which a key typed straight after another counts from. */
async function emptyPromptKey($: Engine, k: string, e: KeyEdit, now: number): Promise<KeyTurn> {
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
  const consume = { text: e.text, cursor: e.cursor }
  // the verb key or card key pressed just before, as this key reads it
  let opened = keyOpened
  const keyed = cardKeyed
  // a letter typed straight after a card's own key: that key began a word; the card goes back to where it was
  if (keyed && now - keyed.at < 700 && /^\p{L}$/u.test(k)) {
    return { box: { text: `${keyed.key}${e.inputText}`, cursor: keyed.key.length + e.inputText.length }, work: () => writeCardState($, keyed.ref.root, keyed.ref.id, { state: keyed.undo?.state ?? {}, region: keyed.undo?.region ?? null }, 'terminal') }
  }
  // a letter typed straight after v, while v waits to ask: v began a word, so it comes back and asks nothing
  if (pendingV && opened && opened.key === 'v' && now - opened.at < WORD_MS && /^\p{L}$/u.test(k)) {
    return { box: { text: `v${e.inputText}`, cursor: 1 + e.inputText.length }, work: () => { if (pendingV) { pendingV.cancelled = true; pendingV = null } } }
  }
  // the squeeze chips open under a message: their program's keys first (panes/chips.js: [ ] change, 1-3 chip,
  // 0 original, s done)
  if (pick && pick.verb === 's' && !tray && (await paneTry($, 'chips', { row: pick.row }, { type: 'key', key: k }))) {
    return { box: consume, work: () => paneFire($, 'chips', { row: pick.row }, { type: 'key', key: k }).then(() => undefined) }
  }
  // the tray open: its program's keys (panes/tray.js: 1 ask, r and c a section of the card, 2–9 open a citation in it,
  // 0 back, ] [ step); any other letter types the question for the mark's thread
  if (tray) {
    // a letter typed straight after a section's letter: that letter began a word, so its section closes again and both
    // letters are typed
    const was = trayKeyed
    if (was && now - was.at < 700 && /^\p{L}$/u.test(k)) {
      return { box: { text: `${was.key}${e.inputText}`, cursor: was.key.length + e.inputText.length }, work: () => paneFire($, 'tray', {}, keyEvent(was.key)) }
    }
    const ev = k === 'backspace' ? (tray.asking ? null : keyEvent('0')) : k.length === 1 ? keyEvent(k) : null
    if (ev && (await paneTakes($, 'tray', {}, ev))) {
      const letter = /^\p{L}$/u.test(k)
      return { box: consume, work: async () => { await paneFire($, 'tray', {}, ev); if (letter) trayKeyed = { key: k, at: now } }, ...(letter ? { word: () => paneFire($, 'tray', {}, ev) } : {}) }
    }
    return { box: null }
  }
  // v's line open under a message: the proposals program's keys (1–9 pick, 0 close)
  if (pick && pick.verb !== 's' && (k === 'backspace' || /^[0-9]$/.test(k))) {
    opened = null
    const ev = keyEvent(k === 'backspace' ? '0' : k)
    const args = { row: pick.row, verb: pick.verb }
    if (await paneTakes($, 'proposals', args, ev)) return { box: consume, work: () => paneFire($, 'proposals', args, ev) }
    if (/^[0-9]$/.test(k)) return { box: null }
  }
  // a card with the focus: its own keys win over the verbs (the bar names them); 1 opens its detail, ] [ step on, 0 and
  // ⌫ give the keys back; a key it does not take gives the keys back and types
  const cf = (await $.state.get(CARDFOCUS)).value as (ObjRef & { row: string }) | null
  if (cf && !pick) {
    if (k === '0' || k === 'backspace') return { box: consume, work: () => setCardFocus($, null) }
    if (k === '1') return { box: consume, work: async () => { await setCardFocus($, null); await openDetail($, cf) } }
    if (k === ']' || k === '[') return { box: consume, work: () => stepMark($, k === ']' ? 1 : -1) }
    const d = await inlineDrawing($, cf)
    const own = d ? cardTakesKey(d, k) : null
    if (own && !(own in hostKeys('inline', 'terminal'))) {
      return { box: consume, work: async () => {
        const before = await readCardState($, cf.root, cf.id)
        await inlineCardAct($, cf, { type: 'key', key: own })
        cardKeyed = { key: k, at: now, ref: cf, undo: before }
      } }
    }
    return { box: null, work: () => setCardFocus($, null) }
  }
  if (k === ']' || k === '[') return { box: consume, work: async () => { await setPick($, null); await stepMark($, k === ']' ? 1 : -1) } }
  // { and } at rest: the answer before or after the one the keys act on (a letter typed at once after it: a word)
  if ((k === '{' || k === '}') && !pick && (await keyRows($)).length > 1) {
    const was = (await $.state.get(SELROW)).value as string | null | undefined
    return { box: consume, work: () => stepAnswer($, k === '{' ? -1 : 1), word: () => $.state.set(SELROW, was ?? null) }
  }
  if (k === '0' || k === 'backspace') return pick ? { box: consume, work: () => setPick($, null) } : { box: null }
  if (/^[1-9]$/.test(k)) {
    // 1 under a card: its detail view (the bar says `1 open detail`)
    const ref = k === '1' ? await focusedCard($) : null
    return ref ? { box: consume, work: () => openDetail($, ref) } : { box: null }
  }
  // s with replies piled up (the bar says `s catch up on N replies`): the catch-up, its chips open; a letter typed at once
  // after it makes s the start of a word, and the catch-up is undone
  if (k === 's' && !pick && !(await $.state.get(SELROW)).value && (await pileUp($))) {
    let made: string | null = null
    const undo = async () => { keyOpened = null; if (made) await dismissNow($, made, true) }
    return { box: consume, work: async () => { made = await catchUpNow($); keyOpened = { key: k, at: now, undo } }, word: undo }
  }
  // at rest the verbs win: a card's own keys reach it once it has the focus (] or its detail)
  if (k.length === 1 && ROW_KEYS.some(v => v.key === k)) {
    const row = await actingRow($)
    // a letter typed at once after it (before its answer came) makes it the start of a word: its line closes again
    const word = { word: async () => { keyOpened = null; if (pendingV) { pendingV.cancelled = true; pendingV = null }; await setPick($, null) } }
    if (row) return { box: consume, work: async () => { await pressRowVerb($, row, k); keyOpened = { key: k, at: now } }, ...word }
  }
  if (pick && k.length === 1) {
    // typed straight after the verb key: the letter was the start of a word, and the line closes (a catch-up s began is
    // undone)
    const word = opened && now - opened.at < 700 ? { text: `${opened.key}${e.inputText}`, cursor: opened.key.length + e.inputText.length } : null
    return { box: word, work: () => (word && opened?.undo ? opened.undo() : setPick($, null)) }
  }
  return { box: null }
}

// ------------------------------------------------------------------------------------------------ drawing

/** The one quiet row under a label's card while the model reads its records (`label… 120 of 412 records`); nothing at
 *  rest. Its keys (`1 open detail`) are in the hint line under the prompt, and the card the keys act on shows it by
 *  its frame. */
function runningRow(els: Any, said: Said | null) {
  return said?.running ? els.Text({ dimColor: true, children: `${said.verb}…${said.text ? ` ${said.text}` : ''}` }) : null
}

/** One object inline: its cells, or one red line saying why it cannot be drawn. The card the keys act on (`1` opens
 *  it) has its frame in the keys' color. */
async function inlineEl($: Engine, e: Any, ref: ObjRef, key: string, at: string, focus: 'focus' | 'rest' | boolean | null = null): Promise<Any> {
  const els = $.ui.resolve(e)
  const { Box, Text } = els as Any
  const cols = Math.max(40, Math.min(120, (e.viewport?.columns ?? 100) - 4))
  inlineCols = cols
  // the card as the person left it, here or in the browser: its state (a flip, a zoom) and the part selected
  const kept = await cardStateNow($, ref.root, ref.id)
  const p = await preparedNow($, ref, cols, keptState(kept))
  if (!p) return Box({ marginTop: 1, marginLeft: 2, children: [Text({ dimColor: true, children: `drawing ${refText(ref)}…` })] })
  if (p.error || !p.grid) return Text({ color: 'error', children: `× ${refText(ref)} cannot be drawn: ${p.error || 'no drawing'}` })
  const fullscreen = e.viewport?.isFullscreen !== false
  const said = ((await $.state.get({ ...SAID, id: ref.id })).value ?? null) as Said | null
  // calm: under a reply an object takes at most about half a screen; the rest waits in the detail view
  const rows = Math.min(p.grid.h, inlineRows(e.viewport?.rows ?? 48))
  // a click on a part its program answers is the program's (k.on('press:<id>')), here as in the detail; on any other
  // part it opens the detail view on it; on a knob's ◂ ▸, opens it and turns the knob there
  const onPress = fullscreen ? (id: string, dir?: number) => (dir ? openTurned($, ref, id, dir) : pressTaken(p.drawing, id) ? inlineCardAct($, ref, { type: 'press', region: id }) : openDetail($, ref, knobOf(p.drawing, id) ? null : id)) : undefined
  const run = runningRow(els, said)
  const selected = kept?.region && (p.drawing?.regions || []).some((r: Any) => r.id === kept.region) ? kept.region : null
  return Box({
    flexDirection: 'column', marginTop: 1, marginLeft: 2, width: Math.max(p.grid.w, 40),
    children: [paintRegions(p.grid, els, { theme, key: `${key}-${ref.id}`, rows, onPress, selected, frame: focus === 'rest' ? mix(FOCUS[theme], theme === 'light' ? '#ffffff' : '#1e1e1e', 0.45) : focus ? FOCUS[theme] : null }), ...(run ? [run] : [])],
  })
}

/**
 * The catch-up under a reply (the reply's record names it), while it stands: a rule down its left side beside its head
 * line and its text (its first characters while a version writes itself in, dim while one is written), then the chips
 * or v's line when open on it, then the cards made for it. Its marks open the tray as any reply's do. Nothing for a
 * reply with none.
 */
async function catchUpParts($: Engine, e: Any, at: string, cols: number): Promise<Any[]> {
  const cu = await catchUpUnder($, at)
  if (!cu) return []
  const row = cu.row
  const els = $.ui.resolve(e) as Any
  const { Box } = els
  const sqUi = ((await $.state.get({ ...SQZ, id: row })).value ?? null) as SqzUi | null
  const busy = busyGlyph(sqUi)
  const n = revealedOf(sqUi)
  const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
  const open = pick && pick.row === row ? pick.verb : null
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const base = trayBase(tray) as TrayFrame | null
  const replies = Number(cu.catchup!.replies) || 0
  const head = `catch-up of ${replies} replies since your last message`
  // its first version on its way, or why it failed
  const why = sqUi?.error || ((cu.squeeze ?? {}) as Any).error || null
  const note = typeof cu.shown === 'string' ? null : why ? { text: `× ${why}`, error: true } : { text: `${busy ?? '…'} writing it from the messages above` }
  const shown = n == null || note ? cu : (() => {
    const part = revealCut(cu.shown, n) as string
    return { ...cu, shown: part, marks: cu.marks.filter(m => m.end <= part.length) } as MsgRecord
  })()
  const parts: Any[] = [catchUpEl(els, { rec: shown, key: `cu-${row}`, cols, first: false, theme, head, note, focus: base && base.row === row ? base.i ?? null : null, onMark: (i: number) => openMark($, row, i, cu), dim: !!busy })]
  if (open === 's') parts.push(Box({ marginLeft: 2, marginTop: 1, children: [await paneEl($, e, 'chips', { row }, { w: Math.max(30, cols - 2), h: 3 })] }))
  else if (open) parts.push(Box({ key: `vl-${row}`, marginLeft: 2, marginTop: 1, children: [await paneEl($, e, 'proposals', { row, verb: open }, { w: Math.max(30, cols - 2), h: 3 })] }))
  const list = ((await $.state.get({ ...UNDER, id: row })).value ?? []) as ObjRef[]
  if (list.length) {
    const cf = (await $.state.get(CARDFOCUS)).value as (ObjRef & { row: string }) | null
    const rest = !tray && !pick && !cf && (await actingRow($)) === row
    parts.push(...(await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `row-${row}-${i}`, row, cf && cf.row === row && cf.id === ref.id && cf.root === ref.root ? 'focus' : rest && i === list.length - 1 ? 'rest' : null)))))
  }
  return parts
}

/** The width cards under a reply were drawn at last: the bar reads a focused card's keys from the same drawing. */
let inlineCols = 96
const keptState = (kept: { state?: Record<string, unknown> } | null) => (kept?.state && Object.keys(kept.state).length ? kept.state : undefined)

/** A card under a reply, drawn as it stands now (with its kept state), for the bar's keys; null while it draws. */
async function inlineDrawing($: Engine, ref: ObjRef): Promise<Any | null> {
  const kept = await cardStateNow($, ref.root, ref.id)
  return (await preparedNow($, ref, inlineCols, keptState(kept)))?.drawing ?? null
}

/** What the person did on a card under a reply, as its program's event: its new state is kept for every surface (the
 *  detail and the browser open it so); an ask(selection) opens the card's detail with the question pointed there. */
async function inlineCardAct($: Engine, ref: ObjRef, event: Record<string, unknown>): Promise<void> {
  const o = await loadObject($, ref)
  if (!o) return
  const kept = await readCardState($, ref.root, ref.id)
  const region = typeof event.region === 'string' ? event.region : kept?.region ?? null
  const got = await cardEvent($, o, { ...ref, region, ex: 0, all: false, state: kept?.state || {} } as Sel, { ...event, ...(region && !event.region ? { region } : {}) }, { w: inlineCols, h: 24 }, 'inline')
  if (!got || got.drawing?.error) {
    $.ui.toast(`× ${o.title || ref.id} could not answer ${event.type === 'key' ? `the key ${event.key}` : 'that'}: ${got?.drawing?.error ? `${got.drawing.error.name} · fix: ${got.drawing.error.fix || 'its program'}` : 'its program did not run'}`)
    return
  }
  await writeCardState($, ref.root, ref.id, { state: got.state, region }, 'terminal')
  if (got.ask?.text) {
    const refs = got.ask.refs?.length ? got.ask.refs : got.ask.region ? regionRefs(o, got.drawing, got.ask.region).refs : []
    const r = await askThread($, { text: got.ask.text, scope: { object: ref.id, v: o.version ?? ref.v, ...(got.ask.region ? { region: got.ask.region } : {}), label: got.ask.label }, refs, root: ref.root, card: { id: o.id, v: o.version, title: o.title, file: `${ref.root}/thimble/objects/${o.id}.json` } })
    if (r.problem) $.ui.toast(`× ${r.problem}`)
  } else if (got.ask) {
    // a selection to ask about: the card's detail opens on it, and the next question goes to its thread with it
    await openDetail($, { ...ref, v: o.version ?? ref.v }, got.ask.region ?? region)
    const sel = (await $.state.get(SEL)).value as Sel | null
    if (sel) await $.state.set(SEL, { ...sel, ask: got.ask } as Sel)
  }
}

/** The rows a card takes under a reply: about half a screen, the rest in its detail view. */
const inlineRows = (screen: number) => Math.max(12, Math.min(30, Math.floor(screen * 0.55)))
const FOCUS = { dark: '#9a93ff', light: '#4f46e5' }

async function openTurned($: Engine, ref: ObjRef, knob: string, dir: number): Promise<void> {
  await openDetail($, ref)
  await turnSel($, knob, dir)
}

/** Turn a knob of the open object: `knob`, else the one turned last, else its first. */
async function turnSel($: Engine, knob: string | null, dir: number): Promise<void> {
  const cur = (await $.state.get(SEL)).value as Sel | null
  if (!cur || cur.cite) return
  const p = await prepared($, cur, 96, cur.state)
  if (!p.drawing?.controls?.length) return
  const id = knob && knobOf(p.drawing, knob) ? knob : cur.knob && knobOf(p.drawing, cur.knob) ? cur.knob : p.drawing.controls[0].id
  const state = turnKnob(p.drawing, cur.state || {}, id, dir)
  const now = (await $.state.get(SEL)).value as Sel | null
  if (now && now.id === cur.id) await $.state.set(SEL, { ...now, state, knob: id })
}

/** What the person sees of an object Claude just saved, in a few lines for Claude: how big it is, how many parts they
 *  can select, and what does not hold (a program that failed, the toolkit's warnings, example sets with no records,
 *  parts that rest on no rows). A program that failed is Claude's to fix now, in the same turn: a new version under
 *  the same name takes the failed one's place under the reply, so the person sees no second object and no new row. */
function drawnNote(p: Prepared, ref: ObjRef): string {
  if (p.error || !p.grid) return `The analyst cannot see the card ${refText(ref)}: ${p.error || 'it drew nothing'}. Fix it and save it again under the same name; the new version takes its place.`
  const d = p.drawing
  const parts = selectable(p.grid)
  const lines = [`The card ${refText(ref)} is drawn for the analyst under your reply: ${p.grid.h} rows by ${p.grid.w} columns, ${parts.length} part${parts.length === 1 ? '' : 's'} they can select.`]
  if (d.error) lines.push(`Its program failed: ${d.error.name}: ${d.error.message}${d.error.line ? ` (line ${d.error.line})` : ''}. They see the error in its place. Fix the program and save it again under the same name now; the new version takes its place under your reply.`)
  if (p.check?.line) lines.push(p.check.line)
  for (const w of (d.warnings || []).slice(0, 5)) lines.push(`Warning: ${w}`)
  const empty = Object.entries(d.examples || {}).filter(([, x]: [string, Any]) => !x?.records?.length).map(([id]) => id)
  if (empty.length) lines.push(`${empty.length} example set${empty.length === 1 ? ' has' : 's have'} no records, so the analyst sees none for ${empty.length === 1 ? 'it' : 'them'}: ${empty.slice(0, 4).join(', ')}${empty.length > 4 ? ', …' : ''}.`)
  const bare = parts.filter((r: Any) => !regionRefs(p.object, d, r.id).refs.length && !recordRefs(d, r.id).length)
  if (bare.length) lines.push(`${bare.length} of ${parts.length} parts name no ref and match no data row, so selecting one shows no source rows: ${bare.slice(0, 4).map((r: Any) => r.id).join(', ')}${bare.length > 4 ? ', …' : ''}.`)
  return lines.join('\n')
}

/** "<id>[@v] [region]" → the object and region, the id matched as the kernel does (with or without its number). */
async function parseTarget($: Engine, words: string[]): Promise<{ ref: ObjRef | null; region: string | null; problem?: string }> {
  const [first, region] = words
  const sel = (await $.state.get(SEL)).value
  const last = (await $.state.get(LAST)).value
  if (!first) {
    const ref = sel && !sel.cite ? sel : last
    return ref ? { ref: { id: ref.id, v: ref.v, root: ref.root }, region: sel && ref === sel ? sel.region : null } : { ref: null, region: null, problem: 'no card yet' }
  }
  const m = /^([^@\s]+)(?:@(\d+))?$/.exec(first)
  if (!m || !m[1] || !ID.test(m[1])) return { ref: null, region: null, problem: `"${first}" is not a card's id` }
  const here = await rootHere($)
  const hints = [...new Set([sel?.root, last?.root, here].filter(Boolean))] as string[]
  let id: string = m[1]
  let root = await findRoot($, id, hints)
  if (!root) {
    // the slug without its number (saves-per-day for 01-saves-per-day)
    for (const r of hints) {
      const list = await $.fs.list(`${r}/thimble/objects`).catch(() => [])
      const hit = list.find(x => x.name.endsWith('.json') && x.name.replace(/\.json$/, '').replace(/^\d+-/, '') === id)
      if (hit) { id = hit.name.replace(/\.json$/, ''); root = r; break }
    }
  }
  if (!root) return { ref: null, region: null, problem: `no card ${first} here` }
  return { ref: await withVersion($, { id, v: m[2] ? Number(m[2]) : null, root }), region: region && REGION.test(region) ? region : null }
}

// ------------------------------------------------------------------------------------------------ hooks

// ------------------------------------------------------------------------------------------------ what panes read and do
// The panes (shell/panes.ts) are programs on the card runtime: these are the stores they read by name, the folder their
// state is kept in, and the actions their programs ask for with k.do and k.want.

/** The session's folder and id, where a pane's state is kept (thimble/panes/<session>/). */
export async function paneWhere($: Engine): Promise<{ root: string | null; session: string }> {
  return { root: await rootHere($), session: await sessionKey($) }
}

/** One store a pane reads: `index` (the session's rows in order), `record` (record:<row>) and the rest. */
export async function paneStore($: Engine, kind: string, arg: string): Promise<unknown> {
  switch (kind) {
    case 'index': return (await msgFilesNow($)).index.map(x => ({ row: String(x.row), kind: x.kind }))
    case 'record': return arg ? await recordNow($, arg) : null
    // the squeeze's own state of a message (a call running, a failure): the terminal's alone
    case 'sqz': return arg ? ((await $.state.get({ ...SQZ, id: arg })).value ?? null) : null
    // the card the detail shows: its object, versions and drawing at the detail's room (detail.tsx)
    case 'card': return arg ? cardStore($, arg) : null
    // the session's side threads: the tray shows a mark's
    case 'threads': return threadList()
    default: return paneStoreMore($, kind, arg)
  }
}

/** Stores the squeeze chips and the card detail read (their modules add to this). */
async function paneStoreMore(_$: Engine, _kind: string, _arg: string): Promise<unknown> {
  return null
}

/** What a program wants that its data does not hold (k.want): {rows: [refs]} read through the kernel. */
export async function paneWant($: Engine, _name: string, _args: Record<string, unknown>, request: Any): Promise<unknown> {
  // a card a program shows inside itself (the tray's): its parts drawn in the sandbox at the room it gives
  if (request?.card && typeof request.card === 'object') return trayCard($, request.card, Math.max(20, Number(request.w) || 80), Math.max(3, Number(request.h) || 9))
  const root = await rootHere($)
  if (Array.isArray(request?.rows) && root) {
    const refs = request.rows.filter((r: unknown) => typeof r === 'string' && isRef(r)).slice(0, 200) as string[]
    if (!refs.length) return { records: [], count: 0 }
    // the rows the person flips through: read once per set, kept where the detail's own reads keep them
    await resolveRefs($, root, refs)
    return (await $.state.get({ ...ROWS, id: `${root}|${refsKey(refs.length > 1 ? refs.slice(0, 500) : refs)}` })).value ?? null
  }
  // the labels of the records a part shows (shell/labels.ts), read again after each check
  if (Array.isArray(request?.labels) && root) return labelsOf($, root, request.labels as string[], Number(request.gen) || 0)
  // where a card's values come from: its sources, rows, labels and the files read (the from line)
  if (typeof request?.facts === 'string' && ID.test(request.facts) && root) {
    const dir = $.plugin.root.replace(/\/+$/, '')
    let cov: Any = null
    try {
      const r = await $.process.run([`${dir}/bin/thimble`, 'coverage', request.facts, '--json'], { cwd: root, env: await leanEnv($, root), timeoutMs: 60000 })
      cov = JSON.parse(r.stdout)
    } catch {
      cov = null
    }
    return fromFacts(await loadObject($, { id: request.facts, v: null, root }), cov)
  }
  return { error: 'the terminal cannot read that' }
}

/** What the squeeze chips' program asks for: a rewrite at levels, the original, a line said, or closing the chips. */
async function chipsAction($: Engine, row: string, a: Record<string, unknown>): Promise<string | boolean | void> {
  const name = String(a.do || '')
  if (!row || !(await recordNow($, row))) return '× That message is not in this session, so the chips cannot change it. Press s under a message here.'
  if (name === 'squeeze') {
    if (a.reset === true) { void sqSetLevels($, row, {}); return }
    if (a.at && typeof a.at === 'object') {
      const at: Record<string, number> = {}
      for (const [k, v] of Object.entries(a.at as Record<string, unknown>)) if (Number.isInteger(v)) at[k] = v as number
      void sqSetLevels($, row, at, a.key === '[' || a.key === ']' ? a.key : null)
      return
    }
    return '× The chips asked for a squeeze with no levels.'
  }
  if (name === 'close') {
    await setPick($, null)
    return
  }
  if (name === 'dismiss') {
    await dismissNow($, row)
    return
  }
  if (name === 'say') return typeof a.text === 'string' ? a.text : undefined
  return false
}

/** An action a pane's program asked for (k.do). False: the terminal has none by that name. */
export async function paneAction($: Engine, pane: string, _args: Record<string, unknown>, a: Record<string, unknown>): Promise<string | boolean | void> {
  const name = String(a.do || '')
  if (pane === 'tray') {
    if (name === 'close') { await setTray($, null); return }
    if (name === 'step') { await stepMark($, Number(a.dir) < 0 ? -1 : 1); return }
    if (name === 'input') return
  }
  if (pane === 'proposals') {
    if (name === 'close') { await setPick($, null); return }
    if (name === 'pick' && typeof a.choice === 'string') {
      const row = String(_args.row || a.row || '')
      const verb = String(_args.verb || a.verb || 'v')
      return (await pickOption($, row, verb, a.choice)) ? undefined : '× That message is not in this session, so nothing ran. Press v under a message here.'
    }
  }
  if (pane === 'chips') return chipsAction($, String(_args.row || a.row || ''), a)
  if (pane === 'detail') return detailAction($, a)
  if (name === 'open') {
    // a place a program opens: a card (its detail), a message (the keys act on it now)
    if (typeof a.object === 'string' && ID.test(a.object)) {
      const root = await rootHere($)
      if (root) await openDetail($, { id: a.object, v: typeof a.v === 'number' ? a.v : null, root }, typeof a.region === 'string' ? a.region : null)
      return
    }
    if (typeof a.row === 'string' && (await recordNow($, a.row))) {
      await $.state.set(SELROW, a.row)
      return 'That message is the one the keys act on now.'
    }
    return '× There is nothing here to open for that.'
  }
  return false
}

export const registerShell: Register = (on, options) => {
  setTheme(() => theme)

  // the side threads and the card detail first: their hooks sit outside the shell's, so a question for a thread and a
  // thread's report never reach the shell's prompt hooks (or main)
  registerThreads(on, options)
  registerDetail(on)

  // (a matcher, as the kernel's module hooks session.start without one and the engine takes one bare hook per event)
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'card', description: "Open a card's detail: /card [card] [part] (no card: the newest)", argumentHint: '[card] [part]', immediate: true })
      const row = (await $.config.list()).find(x => x.key === 'theme')
      theme = String(row?.value ?? 'dark').startsWith('light') ? 'light' : 'dark'
    } catch {
      // the shell draws nothing it cannot; the session goes on
    }
    try {
      // a resumed session: its objects drawn under the same rows again, and its earlier saves never placed twice
      await restoreShown($)
      await newSaves($)
      // its message index, and the answers the keys can act on
      await msgFilesNow($)
      await restoreAnswers($)
    } catch {
      // a session that cannot read its placements draws its new objects only
    }
    // the work that starts Node children waits for a person: in a session Claude Code's background service runs (a
    // pre-warmed spare, a background job) it starts at the person's first prompt, and in a `-p` run never
    const kind = String((await $.env.get('CLAUDE_CODE_SESSION_KIND').catch(() => undefined)) ?? '').trim()
    person = e.isInteractive === false ? 'never' : kind ? 'later' : 'now'
    if (person === 'now') await startForPerson($)
    return r
  })

  // a turn of main's: the objects it saved, and its last text row, under which they are drawn
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turn = { unplaced: [], lastRow: '', calls: [], placed: [], at: placeNext }
      placeNext = null
      // a new turn: the keys act on its answer again, and a verb's open line closes
      try {
        await $.state.set(SELROW, null)
        await setPick($, null)
        await setCardFocus($, null)
        // the conversation's first turn: a later session that continues it finds its records (hooks/conversation.ts)
        await noteConversation($)
      } catch {
        // the turn starts whatever the shell makes of it
      }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // a label the kernel asks the model to read while the command still runs (`thimble label … --prompt … && thimble
    // label … --wait` waits on it): the feed is looked at each second until the command ends
    let watch: { cancel?: () => void } | null = null
    try { watch = $.clock.every(1000, () => { void labelsInFeed($).catch(() => undefined) }) as unknown as { cancel?: () => void } } catch { watch = null }
    let r: Awaited<ReturnType<typeof next>>
    try { r = await next(e) } finally { watch?.cancel?.() }
    let notes: string[] = []
    try {
      const input = e as unknown as { command?: string; agentId?: string; tool_use_id?: string }
      const text = typeof r.text === 'string' ? r.text : typeof r.result === 'string' ? r.result : ''
      if (r.deny !== undefined) return r
      // the saves this call made, from the kernel's change feed (never from what the call printed, which a pipe cuts);
      // a subagent's saves (a side thread's) are read and left where its card is
      const saves = await newSaves($)
      if (input.agentId || !saves.length) return r
      notes = []
      for (const ref of saves) {
        const id = ref.id
        const root = ref.root
        // a new version of an object that could not be drawn takes its place where it was: a fix, not a new object
        const where = (await $.state.get({ ...WHERE, id })).value as string | undefined
        const before = where ? (((await $.state.get({ ...UNDER, id: where })).value ?? []) as ObjRef[]).find(x => x.id === id && x.root === root) : undefined
        const prev = before ? await prepared($, before, 96) : null
        const broken = !!prev && (!!prev.error || !prev.grid || !!prev.drawing?.error)
        if (broken && !(turn && turn.unplaced.some(x => x.id === id))) await place($, where!, ref)
        else if (turn) {
          turn.unplaced = [...turn.unplaced.filter(x => !(x.id === ref.id && x.root === root)), ref]
          if (input.tool_use_id) turn.calls.push(input.tool_use_id)
        }
        await $.state.set(LAST, ref)
        // drawn as under the reply, and its interactions tried once, as the person would, so a failing one is fixed now
        const p = await prepared($, ref, 96, null, 'inline', 24, true)
        notes.push(drawnNote(p, ref))
        if (p.check) void recordEvent($, { kind: 'check', id, v: p.object?.version ?? null, tried: p.check.tried, total: p.check.total, failed: p.check.failed, cut: p.check.cut, ms: p.check.ms, chars: p.check.line ? p.check.line.length : 0 })
      }
    } catch {
      // watching never changes a call's result
    }
    // what the person sees of each object, for Claude alone, after the call's own output
    return notes.length && r.deny === undefined && !r.isError ? { ...r, context: [...(r.context ?? []), notes.join('\n')] } : r
  }).catch(($, e, next) => next(e))

  // the first text row after a save carries its objects: they are placed before the row is stored, so the main screen
  // (which prints a finished row once) draws them too
  on('session.append', async ($, e, next) => {
    try {
      const msg = e.message as { type?: string; content?: unknown }
      const blocks = Array.isArray(msg.content) ? (msg.content as { type?: string; text?: string }[]) : []
      if (e.agentId === undefined && turn && e.door === 'response' && e.uuid && blocks.some(b => b.type === 'text' && String(b.text || '').trim())) {
        turn.lastRow = e.uuid
        if (turn.unplaced.length) await placeTurn($, turn.at || rowKey(e.uuid))
      }
    } catch {
      // the row is stored whatever the shell makes of it
    }
    const stored = await next(e)
    try {
      if (e.agentId === undefined && stored.uuid) {
        const msg = e.message as { type?: string; content?: unknown; isMeta?: boolean }
        const blocks = Array.isArray(msg.content) ? (msg.content as { type?: string; text?: string }[]) : []
        const text = blocks.filter(b => b.type === 'text').map(b => String(b.text || '')).join('\n')
        const row = rowKey(stored.uuid)
        const at = new Date(await $.clock.now()).toISOString()
        let scope: Record<string, unknown> | undefined
        if (pendingAsk && e.door === 'prompt' && msg.type === 'user') {
          await $.state.set({ ...ASKED, id: row }, pendingAsk.about)
          scope = pendingAsk.scope
          pendingAsk = null
        }
        if (e.door === 'prompt' && msg.type === 'user' && !msg.isMeta && text.trim()) {
          // who sent it: the person (composer, bridge) or the session itself (a task's notification, a peer's message)
          const by = String((e.origin as { kind?: string } | undefined)?.kind ?? '')
          await indexRow($, { row, kind: 'user', at, text, ...(by ? { by } : {}), ...(scope ? { scope } : {}) })
          await flushMessages($)
        } else if (e.door === 'response' && msg.type === 'assistant' && text.trim()) {
          // one of Claude's messages: its record, with the marks in its words and each sparkline's values
          const made = newRecord({ row, session: await sessionKey($), text, at }) as MsgRecord
          made.uuid = String(stored.uuid)
          made.objects = (((await $.state.get({ ...UNDER, id: row })).value ?? []) as Placed[]).map(x => x.id)
          const rec = await withSparkValues($, made)
          const rows = ((await $.state.get(MSGROWS)).value ?? []) as string[]
          if (!rows.includes(row)) await $.state.set(MSGROWS, [...rows, row])
          await indexRow($, { row, kind: 'assistant', at })
          await saveRecord($, rec)
          $.clock.after(0, () => { void recount($) })
        }
      }
    } catch {
      // the row is stored whatever the shell makes of it
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      // a save the turn's last Bash call did not see (one run in the background): the feed read once more
      if (e.agentId === undefined && turn) for (const ref of await newSaves($)) turn.unplaced = [...turn.unplaced.filter(x => !(x.id === ref.id && x.root === ref.root)), ref]
    } catch {
      // the next call reads the feed again
    }
    try {
      // objects saved after the turn's last words: under those words (or the save's own row, with none)
      if (e.agentId === undefined && turn && turn.unplaced.length) {
        const at = turn.at || (turn.lastRow ? rowKey(turn.lastRow) : turn.calls.at(-1))
        if (at) await placeTurn($, at)
      }
    } catch {
      // nothing drawn is better than a turn that does not end
    }
    try {
      // the turn's answer: its last words, under which the verb row is drawn. A turn that ended in an error answered
      // nothing (its last row is Claude Code's error): the keys stay on the answer before it
      if (e.agentId === undefined && turn?.lastRow && e.reason !== 'error') {
        const row = rowKey(turn.lastRow)
        const rec = await recordNow($, row)
        if (rec && !rec.final) await saveRecord($, { ...rec, final: true })
        await $.state.set(ANSWER, row)
        const answers = await answerRows($)
        if (!answers.includes(row)) await $.state.set(ANSWERS, [...answers, row])
        // the bar: what this turn read, saved and cited
        $.clock.after(0, () => { void recount($, { coverage: true }) })
      }
    } catch {
      // a turn with no verb row is better than one that does not end
    }
    if (e.agentId === undefined) turn = null
    return done
  })

  // one of Claude's messages drawn from its record: its marks inline (a citation underlined, a gloss on a teal fill, a
  // sparkline in place, each a press that opens the tray), while a squeeze rewrites it its new text writing in from the
  // top, the line a verb opened under it (squeeze's chips, v's proposals), then the objects its turn saved. Its verbs
  // and keys are in the bar above the prompt. A message with none of these is Claude Code's own drawing.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    try {
      const at = rowKey(e.requestId)
      const list = ((await $.state.get({ ...UNDER, id: at })).value ?? []) as ObjRef[]
      const els = $.ui.resolve(e) as Any
      const { Box } = els
      if (e.props.isSummary) {
        if (!list.length) return next(e)
        const own = await next(e)
        const drawn = await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `row-${at}-${i}`, at)))
        return Box({ flexDirection: 'column', children: [own, ...drawn] })
      }
      const drawnRec = await drawnRecord($, at, e.props.text)
      const rec: MsgRecord = drawnRec.uuid ? drawnRec : { ...drawnRec, uuid: e.requestId }
      // the screen a long message is measured against (Squeeze), a rewrite of this message running, and its new text
      seeView(e.viewport?.columns ?? 100, e.viewport?.rows ?? 48)
      const sqUi = ((await $.state.get({ ...SQZ, id: at })).value ?? null) as SqzUi | null
      const busy = busyGlyph(sqUi)
      // a new version writing itself in from the top: the first `n` characters, cut where the markdown reads whole
      const n = revealedOf(sqUi)
      const shownNow = n == null ? rec : (() => {
        const part = revealCut(shownOf(rec), n) as string
        return { ...rec, shown: part, marks: rec.marks.filter(m => m.end <= part.length) } as MsgRecord
      })()
      const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
      const open = pick && pick.row === at ? pick.verb : null
      // a message the person picked for the keys ({ }, a mark of it) other than the latest answer: ▸ in place of its ●
      const picked = (await $.state.get(SELROW)).value === at
      const cols = Math.max(20, (e.viewport?.columns ?? 100) - 3)
      // the catch-up under it, when replies piled up and the person caught up on them here
      const caught = await catchUpParts($, e, at, cols)
      if (!picked && !rec.marks.length && !open && !list.length && rec.shown == null && !busy && n == null && !caught.length) return next(e)
      const tray = (await $.state.get(TRAY)).value as Tray | null
      await $.state.get(CARDFOCUS)
      const base = trayBase(tray) as TrayFrame | null
      const parts: Any[] = []
      parts.push(rec.marks.length || rec.shown != null || busy || n != null || picked
        ? messageEl(els, { rec: shownNow, key: `msg-${at}`, cols, first: !!e.props.isFirstOfReply, theme, focus: base && base.row === at ? base.i ?? null : null, onMark: (i: number) => openMark($, at, i, rec), dim: !!busy, lead: busy ?? (picked ? '▸' : null), leadColor: busy ? null : FOCUS[theme] })
        : await next(e))
      if (open === 's') {
        // the chips under the message (panes/chips.js, the browser draws the same program); their keys are in the
        // bar
        parts.push(Box({ marginLeft: 2, marginTop: 1, children: [await paneEl($, e, 'chips', { row: at }, { w: Math.max(30, cols - 2), h: 3 })] }))
      } else if (open) {
        // v's proposals (panes/proposals.js, the browser draws the same program); their keys are in the bar
        parts.push(Box({ key: `vl-${at}`, marginLeft: 2, marginTop: 1, children: [await paneEl($, e, 'proposals', { row: at, verb: open }, { w: Math.max(30, cols - 2), h: 3 })] }))
      }
      if (list.length) {
        // the card with the focus (] reached it) has its frame in the keys' color; at rest the newest card under the
        // message the keys act on (the one 1 opens) has it faint
        const cf = (await $.state.get(CARDFOCUS)).value as (ObjRef & { row: string }) | null
        const rest = !tray && !pick && !cf && (await actingRow($)) === at
        parts.push(...(await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `row-${at}-${i}`, at, cf && cf.row === at && cf.id === ref.id && cf.root === ref.root ? 'focus' : rest && i === list.length - 1 ? 'rest' : null)))))
      }
      parts.push(...caught)
      return parts.length === 1 ? parts[0] : Box({ flexDirection: 'column', children: parts })
    } catch {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })

  // the band above the prompt: the tray when it is open (one small panel, a fixed number of rows, so the transcript
  // scrolls above it; it shows the card on top of its stack: a citation's source card or a gloss's explainer card);
  // then the bar: what the keys do now at its left, the session's counts at its right. A blank row stands between the bar and what is above it, at rest as while
  // Claude works.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const els = $.ui.resolve(e) as Any
      const { Box, Text } = els
      noteViewport(e.viewport)
      // the conversation's width now, which a long message is measured against (Squeeze's `6 of 24 lines`): the band
      // draws first when a docked pane closes, so the verb row never counts at the width the pane left
      if (e.viewport?.columns) seeView(e.viewport.columns, e.viewport.rows ?? 48)
      const bw = Math.max(20, (e.props.bodyColumns ?? 100) - 1)
      const line = await barEl($, els, bw, !!e.props.isWorking)
      const tray = (await $.state.get(TRAY)).value as Tray | null
      const above = trayTop(tray) ? await trayBand($, e, tray!) : null
      if (!line) return above ?? next(e)
      // one blank row between what stands above (Claude Code's spinner or its last status row, the tray) and the bar
      const rows: Any[] = []
      if (above) rows.push(above)
      rows.push(Text({ key: 'bar-gap', children: ' ' }), line)
      return Box({ flexDirection: 'column', children: rows })
    } catch {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })

  // keys while the prompt is empty: v and s open their line under the message the keys act on; { and } pick the answer
  // the keys act on; ] and [ move through the marks, opening the tray; a digit picks in the open line, or opens a mark
  // or a source inside the card; 0 closes the card, then the line. Claude Code hands a plugin only the keys that edit the prompt (tab, ↵, esc and a ⌫ with nothing
  // to delete stay its own), so these are the keys. A verb key that began a word being typed (`visualize …`, `so …`)
  // gives its letter back to the prompt. While the detail is open its keys come first (detail.tsx detailKey). Keys are
  // read one at a time, in the order pressed. Each is answered from reads alone and its work runs after the answer
  // (keys.ts): the hook has 50 ms of its own time, and a late answer left the key in the prompt while its work ran.
  on('prompt.edit', { origin: { kind: 'composer' } }, async ($, e, next) => answerKey($, e, next, true))
    // past the hook's budget (the hooks worker busy drawing), the same decision answers within the .catch's grace
    .catch(async ($, e, next) => answerKey($, e, next, false))

  // a turn whose last word was a tool call: its objects under that call's row
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    try {
      const at = e.props.tool_use_id
      const list = ((await $.state.get({ ...UNDER, id: at })).value ?? []) as ObjRef[]
      if (!list.length || e.props.isErrored) return next(e)
      const { Box } = $.ui.resolve(e) as Any
      const own = await next(e)
      const drawn = await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `call-${at.slice(-10)}-${i}`, at)))
      return Box({ flexDirection: 'column', children: [own, ...drawn] })
    } catch (err) {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })

  // a prompt asked while the detail view was open: under it, what it carried
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    try {
      const about = (await $.state.get({ ...ASKED, id: rowKey(e.requestId) })).value
      if (!about) return next(e)
      const { Box, Text } = $.ui.resolve(e) as Any
      const own = await next(e)
      return Box({ flexDirection: 'column', children: [own, Text({ dimColor: true, wrap: 'truncate-end', children: `  ▸ about ${about.id}${about.v != null ? '@' + about.v : ''}${about.region ? ' ▸ ' + about.label : ''}` })] })
    } catch (err) {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })

  // the prompt carries what verbs said for Claude since its last reply, and the open object with its selected part
  on('prompt.submit', async ($, e, next) => {
    // the person's first prompt in a session whose start found no person (a pre-warmed spare, a background job)
    if (person === 'later' && /^(composer|bridge)$/.test(String((e.origin as { kind?: string } | undefined)?.kind ?? ''))) await startForPerson($)
    if (e.command) return next(e)
    try {
      // a question typed with the tray open asks the mark's side thread; it never reaches main
      const tray = (await $.state.get(TRAY)).value as Tray | null
      if (tray && !e.isMeta && (e.origin as { kind?: string } | undefined)?.kind === 'composer' && String(e.text || '').trim() && !detailIsOpen()) {
        const drop = await askTrayThread($, e.text)
        if (drop) return { drop }
      }
    } catch {
      // a prompt goes in as typed when the chips cannot take it
    }
    const context: string[] = []
    try {
      context.push(...(await sqNotes($)))
      // checks of label values the person made in a detail whose close was never heard: Claude hears of them now
      if (checksPending()) await checksDone($)
      const notes = ((await $.state.get(NOTES)).value ?? []) as string[]
      if (notes.length) {
        context.push(notes.join('\n'))
        await $.state.set(NOTES, [])
      }
      const sel = (await $.state.get(SEL)).value
      // a question asked with the tray open is about its card's mark (CONTRACT 6: a prompt to main carrying the scope)
      const mine = !e.isMeta && (e.origin as { kind?: string } | undefined)?.kind !== 'plugin'
      const scoped = mine ? await trayScope($) : null
      await setPick($, null)
      const open = !scoped && !e.isMeta && (await $.ui.panes()).some(x => x.id === PANE && x.isPlaced)
      if (scoped) {
        context.push(scoped.context)
        pendingAsk = { text: e.text, about: { id: scoped.label, v: null, region: null, label: scoped.label }, scope: scoped.scope }
        await closeTray($)
      } else if (sel && open && sel.cite) {
        pendingAsk = { text: e.text, about: { id: sel.cite, v: null, region: null, label: citeLabels.get(sel.cite) || sel.cite } }
        context.push(`The analyst asked this with a citation of yours open in the detail view: ${citeLabels.get(sel.cite) || ''} (${sel.cite}). "This" may mean that value. \`thimble rows ${sel.cite}\` shows its rows.`)
      } else if (sel && open && (e.origin as { kind?: string } | undefined)?.kind !== 'plugin') {
        const p = await prepared($, sel, 96, sel.state)
        const meta = sel.region ? regionMeta(p.drawing, sel.region) : null
        const { refs } = await refsOf($, sel)
        const label = sel.region ? String(meta?.label || sel.region) : ''
        const knobs = stateKey(sel.state) ? ` Its knobs are at ${Object.entries(sel.state || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}.` : ''
        context.push([
          `The analyst asked this with a card open in the detail view: ${p.object?.id}@${p.object?.version} "${p.object?.title || ''}" (${sel.root}/thimble/objects/${sel.id}.json).${knobs}`,
          sel.region ? `They had selected its part ${sel.region} ("${label}"). "This", "here" or "it" may mean that part.` : 'No part of it was selected.',
          refs.length ? `${sel.region ? 'That part' : 'Its words'} rest${sel.region ? 's' : ''} on ${refs.slice(0, 3).join(', ')}; \`thimble rows <ref>\` opens the rows, \`thimble rows card:${sel.id}\` the card's lineage.` : `\`thimble rows card:${sel.id}\` shows the card's lineage.`,
        ].join('\n'))
        pendingAsk = { text: e.text, about: { id: sel.id, v: p.object?.version ?? sel.v, region: sel.region, label } }
      }
    } catch {
      // a prompt goes in as typed when the shell cannot say what it carries
    }
    return context.length ? next({ ...e, context: [...(e.context ?? []), ...context] }) : next(e)
  }).catch(($, e, next) => next(e))

  // /card [card] [part]: a card's detail (no card: the one selected, else the newest)
  on('command.run', { command: 'card' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const t = await parseTarget($, words)
    if (!t.ref) return { text: `Nothing to open: ${t.problem}. A card Claude saves with \`thimble save\` shows under its reply.` }
    await openDetail($, t.ref, t.region)
    return {}
  })

  // the detail view (detail.tsx)
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
      markOpen(true)
      return await detailPane($, e)
    } catch (err) {
      // a detail that cannot draw says so in one plain line
      return paneProblem($, e, 'The card', err)
    }
  })
}

/** For tests: the module's memory, cleared. */
export function resetShell(): void {
  newestVersion.clear()
  objects.clear()
  preps.clear()
  pending.clear()
  turn = null
  pendingAsk = null
  shown = null
  msgFiles = null
  person = 'now'
  keyOpened = null
  pendingV = null
  cardKeyed = null
  trayKeyed = null
  placeNext = null
  keyDecided = 0
  barSeen.length = 0
  resetKeys(shellKey)
  graphLayout = null
}

export { isRef }
