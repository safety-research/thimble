// The shell of lean thimble: it puts the kernel's objects in front of the person, in the terminal and the browser.
//
//   inline     when Claude saves an object (`lean save` in Bash), the object is drawn under the turn's last reply, in
//              cells (draw/term.js, draw/paint.js), with one quiet row under it: the 2-3 verbs picked for it, `? all`,
//              and `open`. A click on a verb runs it, and what it makes is drawn under the same reply.
//   detail     one pane, the card detail (detail.tsx): header, the card with its parts, one "from" line, the
//              examples of the selected part, the program behind p, and a side thread (thread.ts): while it is open,
//              a prompt is a question for the card's thread, which main does not see.
//   verbs      found by folder (lean/verbs/<name>/, shell/node/registry.mjs) and run in a Node child
//              (shell/node/verb.mjs) by a press, a key or /verb. What a verb makes is drawn where the person pressed;
//              what it says for Claude goes with the next prompt; a call it makes to the model is made here, with
//              $.model, and handed back to it; a request it has for Claude (`ask`) goes as a prompt, drawn as one line.
//   browser    off by default: the plugin's `browser` setting (/config) turns it on. While it is off nothing of it
//              shows and no server starts. While it is on, `o` (the detail view's key, a press on `o browser` under a
//              card or a reply) and /browser open this session's pages: a server on 127.0.0.1 with a token
//              (shell/node/serve.mjs), alive while a page is open and ended with the session. What the person does
//              on a page comes back as one line: an `ask` goes to Claude as a prompt that carries its scope, a `verb`
//              presses that verb on the message's card.
//   claims     the session's claims (thimble/claims/<session>.json), which the observer's look adds each turn's to:
//              c opens the Claims pane, focused (panes/claims.js, a program on the card runtime): the clusters with their claims as a graph; the
//              claim the ring is on (arrow keys, or a click) shows what it means and its links; r replays the graph
//              in the order the claims were made.
//   resume     where each object is drawn is kept per session in $THIMBLE_HOME/lean/shown/<session>.json, so
//              `claude -c` and `--resume` draw the objects under the same replies again.
//
// What it never does: it registers no model tool (a plugin's tool skips the asks of Manual mode), starts no
// `claude`, and allows nothing on anyone's behalf. Everything it runs is the person's press or command, or a pure
// drawing of what Claude saved. The Node helpers run as child processes: a hooks module has no Node, and an
// object's program runs only in the drawing contract's sandbox.
import type { EngineInterface, Register } from 'claude-code'

import type { LineCounts, MsgRecord, ObjRef, Ran, Said, Sel, SqzUi, Tray, TrayFrame } from '../types'
import { knobOf, toHash, turn as turnKnob } from '../draw/handoff.js'
import { gridText, renderTerm } from '../draw/term.js'
import { paintRegions, selectable } from './cells'
import { citeCard, explainerCard } from './cards.js'
import { cardStore, detailAction, detailIsOpen, detailKeys, detailPane, followDetail, markOpen, noteDock, noteViewport, openDetailPane, paneColumns, registerDetail } from './detail'
import { linkMarks, newRecord, placeMarks, recordFor, remark, seriesRef, shownOf, withObserver } from './message.js'
import { fromFacts, isRef, objectRefs, rankRow, recordRefs, refsKey, regionMeta, regionRefs } from './object.js'
import { askThread, registerThreads, restoreThreads, threadCount, threadFor, threadList, threadOf } from './thread'
import type { Scope as ThreadScope } from './thread'
import { cardEvent, cardKey as cardTakesKey, cardStateNow, pressTaken, readCardState, writeCardState } from './runtime'
import { threadKey as threadKeyOf } from './threads.js'
import { back as trayBack, base as trayBase, open as trayOpen, order as markOrder, push as trayPush, step as trayStep, top as trayTop } from './tray.js'
import { markColors, messageEl, verbColor } from './view'
import { markNextTurn, record as recordEvent, tracked } from '../telemetry/telemetry'
import { ownTurn } from '../observer/observer'
import type { RowVerb } from './view'
import { addStretch as sqAddStretch, afterEdit as sqAfterEdit, arrive as sqArrive, busyGlyph, revealedOf, seeView, setLevels as sqSetLevels, sLit, startStretch as sqStartStretch, stopStretch as sqStopStretch, takeNotes as sqNotes } from '../verbs/squeeze/term'
import { endsOf, revealCut } from '../verbs/squeeze/chips.mjs'
import { HEAD_ROWS } from '../panes/claims.js'
import { barText, fitBar, hostKeys, keyEvent, keysOf } from '../panes/host.js'
import { act, instance, paneClosed, paneDrawing, paneEl, paneFire, paneFocus, paneNow, paneOf, paneState, patchPaneState, setPaneState, setTheme } from './panes'
import { frameOf as trayFrameOf } from '../panes/tray.js'
import { ANOTHER_VIEW } from '../panes/proposals.js'
import { mix } from '../draw/palette.js'
import { emptyStore, readStore } from '../verbs/claims/claims.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Verb = { key: string | null; name: string; line: string; phrase: string | null; picked: boolean; hint?: string | null; extra?: Record<string, unknown> }
type Prepared = { object: Any; drawing: Any; grid: Any; verbs: Verb[]; problems: string[]; error?: string; check?: { line: string | null; tried: number; total: number; failed: number; cut: number; ms: number } }
type Placed = ObjRef & { from?: string }

export const PANE = 'object'
const UNDER = { plugin: 'thimble-lean', key: 'under' } as const
const SEL = { plugin: 'thimble-lean', key: 'sel' } as const
const LAST = { plugin: 'thimble-lean', key: 'last' } as const
const ASKED = { plugin: 'thimble-lean', key: 'asked' } as const
const ROWS = { plugin: 'thimble-lean', key: 'rows' } as const
const WEB = { plugin: 'thimble-lean', key: 'web' } as const
const READY = { plugin: 'thimble-lean', key: 'ready' } as const
const SAID = { plugin: 'thimble-lean', key: 'said' } as const
const NOTES = { plugin: 'thimble-lean', key: 'notes' } as const
const WHERE = { plugin: 'thimble-lean', key: 'where' } as const
const RANKED = { plugin: 'thimble-lean', key: 'ranked' } as const
const MSG = { plugin: 'thimble-lean', key: 'msg' } as const
const MSGROWS = { plugin: 'thimble-lean', key: 'msgrows' } as const
const TRAY = { plugin: 'thimble-lean', key: 'tray' } as const
const PICK = { plugin: 'thimble-lean', key: 'pick' } as const
const SELROW = { plugin: 'thimble-lean', key: 'selrow' } as const
const ANSWER = { plugin: 'thimble-lean', key: 'answer' } as const
const CARDFOCUS = { plugin: 'thimble-lean', key: 'cardfocus' } as const
const RUNNING = { plugin: 'thimble-lean', key: 'running' } as const
const ROWVERBS = { plugin: 'thimble-lean', key: 'rowverbs' } as const
const SQZ = { plugin: 'thimble-lean', key: 'sqz' } as const
const LINE = { plugin: 'thimble-lean', key: 'line' } as const
const COUNTS = { plugin: 'thimble-lean', key: 'counts' } as const
const CLAIMS = { plugin: 'thimble-lean', key: 'claims' } as const
const TURNS = { plugin: 'thimble-lean', key: 'turns' } as const
const CLAIMPANE = { plugin: 'thimble-lean', key: 'claimpane' } as const
export const CPANE = 'claims'

const ID =/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/
const REGION = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,95}$/
const EVENTS = { plugin: 'thimble-lean', key: 'events' } as const
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
let turn: { unplaced: ObjRef[]; lastRow: string; calls: string[]; placed: string[]; rows: string[]; oriented: number } | null = null
let theme: 'dark' | 'light' = 'dark'
let pendingAsk: { text: string; about: { id: string; v: number | null; region: string | null; label: string }; scope?: Record<string, unknown> } | null = null
let server: { base: string; root: string } | null = null
let serverStarting: Promise<{ base: string } | { problem: string }> | null = null
// the server's stream: leaving it (return()) ends the server
let serverStream: { return?: (v?: unknown) => unknown } | null = null
// browser mode: the `browser` setting as the module loaded with it, then as /config changes it
let browserFlag = false

let shown: { file: string; under: Record<string, Placed[]> } | null = null
// the message layer's memory: the records' folder and index, the tray's drawn cards, the verb key that opened a line
let msgFiles: { session: string; dir: string | null; index: Any[]; pending: Set<string>; loaded: boolean } | null = null
let keyOpened: { key: string; at: number } | null = null
// the card key pressed last from the empty prompt, with the card's state before it (a word it began gives it back)
let cardKeyed: { key: string; at: number; ref: ObjRef; undo: { state: Record<string, unknown>; region: string | null } | null } | null = null
let keyChain: Promise<unknown> = Promise.resolve()

// ------------------------------------------------------------------------------------------------ objects

/** The folder under analysis that holds object `id`: LEAN_ROOT, a `cd` the command made, the session's folder or a
 *  folder above it. */
async function findRoot($: Engine, id: string, hints: string[] = []): Promise<string | null> {
  const env = await $.env.get('LEAN_ROOT')
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

const prepKey = (ref: ObjRef, w: number, state?: Record<string, unknown> | null, mode = 'inline', h = 24) => `${ref.root}|${ref.id}|${ref.v ?? ''}|${w}|${stateKey(state)}|${mode}${h === 24 ? '' : '|' + h}|${browserFlag ? 'web' : ''}`

/** The object drawn at `w` columns (with the knobs at `state`), with its verbs: the program runs in a Node child, in the
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
      return { object: null, drawing: null, grid: null, verbs: [], problems: [], error: `its file could not be read (${String((err as Error)?.message || err).slice(0, 160)}); an object over 4 MiB cannot be drawn, so bind query outputs (q3) in its data rather than writing rows out` }
    }
    if (!object) return { object: null, drawing: null, grid: null, verbs: [], problems: [], error: `no object ${ref.id} in ${ref.root}/thimble/objects` }
    const dir = $.plugin.root.replace(/\/+$/, '')
    const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `${dir}/shell/node/prep.mjs`], { stdin: JSON.stringify({ object, w, h, state: { ...(state || {}), browser: browserFlag }, mode, ...(check ? { check: true } : {}) }), timeoutMs: 30000 })
    if (r.exitCode !== 0) return { object, drawing: null, grid: null, verbs: [], problems: [], error: (r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 300) || `exit ${r.exitCode}` }
    const out = JSON.parse(r.stdout)
    // under a reply a card is its title, its chart and its takeaway: the words at the right of its frame (its sources)
    // wait in the detail's from line
    const root = out.drawing?.root
    const bare = mode === 'inline' && root && root.t === 'frame' && root.right && !out.drawing.error ? { ...out.drawing, root: { ...root, right: undefined } } : out.drawing
    return { object, drawing: out.drawing, grid: renderTerm(bare, { w }), verbs: out.verbs || [], problems: out.problems || [], ...(out.check ? { check: out.check } : {}) }
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

/** The verbs for an object as the registry's rule picks them, each with its hint.mjs phrase (what the observer reads). */
export async function verbsOf($: Engine, ref: ObjRef): Promise<Verb[]> {
  return (await prepared($, ref, 96)).verbs
}

/** The object as the person sees it under a reply, as plain text at 96 columns (what the observer reads). */
export async function drawnTextOf($: Engine, ref: ObjRef): Promise<string> {
  const p = await prepared($, ref, 96)
  if (p.error || !p.grid) return `(it cannot be drawn: ${p.error || 'no drawing'})`
  const err = p.drawing?.error ? `\n(its program failed: ${p.drawing.error.name}: ${p.drawing.error.message})` : ''
  return gridText(p.grid) + err
}

/** The state key of an object version's ranking. */
export const rankedId = (ref: ObjRef) => `${ref.root}|${ref.id}|${ref.v ?? ''}`

/** The verbs as the hint row shows them: as the observer ranked them for this version, once it has, else the rule's. A
 *  drawing that reads it redraws when the ranking comes. */
async function rankedVerbs($: Engine, ref: ObjRef, verbs: Verb[]): Promise<Verb[]> {
  const r = (await $.state.get({ ...RANKED, id: rankedId(ref) })).value
  return r ? (rankRow(verbs, r) as Verb[]) : verbs
}

// ------------------------------------------------------------------------------------------------ where objects are drawn

async function shownFile($: Engine): Promise<string> {
  const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  return `${home.replace(/\/+$/, '')}/lean/shown/${safe(String(await $.session.id()))}.json`
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

/** The saves the kernel wrote to this session's change feed since the feed was last read: one JSON line per save in
 *  $THIMBLE_HOME/lean/events/<session>.jsonl, each naming its object, version and folder. Read from the feed, a save
 *  is seen however the command was written (`lean save … | tail -3`, a script that saves, a `cd` first). */
async function newSaves($: Engine): Promise<ObjRef[]> {
  const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  const file = `${home.replace(/\/+$/, '')}/lean/events/${safe(String(await $.session.id()))}.jsonl`
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
      if (ev?.kind !== 'save' || typeof ev.object !== 'string' || !ID.test(ev.object) || typeof ev.root !== 'string' || !(Number(ev.t) >= since)) continue
      const ref = { id: ev.object, v: Number(ev.version) || null, root: String(ev.root).replace(/\/+$/, '') }
      out.push(ref)
    } catch {
      // a line that does not parse is skipped; the feed's later lines still count
    }
  }
  // an object saved twice in one call is drawn once, at its latest version
  return out.filter((x, i) => !out.slice(i + 1).some(y => y.id === x.id && y.root === x.root))
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

/** One object under a row: a new version of one already there takes its place; a verb's object goes after the
 *  object it came from (and after what came from it before). */
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

/** The env of the shell's own `lean` calls: the person's, never counted as what Claude read (coverage). */
export async function leanEnv($: Engine, root: string): Promise<Record<string, string>> {
  // the prompt versions in use (prompts/prompts.ts set LEAN_PROMPTS), so a verb's child reads the same ones
  const prompts = String((await $.env.get('LEAN_PROMPTS')) || '')
  return { LEAN_ROOT: root, LEAN_SESSION: `person-${String(await $.session.id()).slice(0, 8)}`, ...(prompts ? { LEAN_PROMPTS: prompts } : {}) }
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
    const r = await $.process.run([`${dir}/bin/lean`, 'resolve', ...set, '-n', '8', '--json'], { cwd: root, env: await leanEnv($, root), timeoutMs: 60000 })
    let v: unknown
    try { v = JSON.parse(r.stdout) } catch { v = { ref, error: (r.stdout + r.stderr).trim().slice(0, 400) || 'lean resolve gave nothing' } }
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
  const env = await $.env.get('LEAN_ROOT')
  if (env) return env
  let d = String(await $.session.cwd()).replace(/\/+$/, '')
  while (d) {
    if ((await $.fs.exists(`${d}/thimble/objects`)) || (await $.fs.exists(`${d}/thimble/queries`))) return d
    d = d.slice(0, d.lastIndexOf('/'))
  }
  return null
}

/** One call a verb made to the model, made here: the verb's Node child has no $. It is a line in the session's events,
 *  under the feature and prompt version the verb named (`request.telemetry`), else under the verb. */
async function modelCall($: Engine, need: { kind: string; request: Any }, word = 'verb'): Promise<unknown> {
  const { telemetry: tag, ...req } = (need.request && typeof need.request === 'object' ? need.request : {}) as Any
  try {
    const r = await tracked($, { feature: String(tag?.feature || word), prompt: tag?.prompt ?? null, model: need.kind === 'fork' ? 'fork' : String(req.model ?? '') }, () =>
      need.kind === 'fork' ? $.model.fork({ prompt: String(req.prompt ?? '') }) : $.model.complete(req))
    return r ?? { isAnswered: false, reason: 'empty-reply' }
  } catch (err) {
    return { isAnswered: false, reason: 'refused', error: String((err as Error)?.message || err).slice(0, 300) }
  }
}

/** Run a verb on an object (and region): its run.mjs in a Node child (shell/node/verb.mjs), again after each call to
 *  the model it needs, with the answers so far. What it made is saved by the kernel. */
async function execVerb($: Engine, word: string, ref: ObjRef, region: string | null, cols: number, o: { state?: Record<string, unknown> | null; args?: string; extra?: Record<string, unknown> } = {}): Promise<Ran> {
  const p = await prepared($, ref, 96, o.state)
  const on = `${refText(ref)}${region ? ' ▸ ' + region : ''}`
  if (!p.object) return { verb: word, on, error: `no object ${refText(ref)}: ${p.error}` }
  const { refs } = region ? regionRefs(p.object, p.drawing, region) : { refs: objectRefs(p.object).map((c: Any) => c.ref) }
  const dir = $.plugin.root.replace(/\/+$/, '')
  const input = {
    object: p.object, region, regionMeta: region ? regionMeta(p.drawing, region) : null, refs, drawing: p.drawing,
    state: o.state || {}, args: o.args || '', root: ref.root, w: Math.max(40, Math.min(120, cols)), ...(o.extra || {}),
  }
  const answers: Record<string, unknown> = {}
  let out: Any = null
  for (let round = 0; round < 8; round++) {
    const r = await $.process.run(['node', `${dir}/shell/node/verb.mjs`, 'run', word], { stdin: JSON.stringify({ ...input, answers }), cwd: ref.root, env: await leanEnv($, ref.root), timeoutMs: 600000 })
    try { out = JSON.parse(r.stdout) } catch { out = { verb: word, error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400) || `exit ${r.exitCode}` } }
    if (!out.need) break
    answers[String(out.need.key)] = await modelCall($, out.need, word)
  }
  if (out?.need) out = { verb: out.verb || word, error: 'it asked the model more than eight times' }
  const ran: Ran = { verb: String(out.verb || word), text: out.text, note: out.note, ask: out.ask, error: out.error, on, saved: out.saved ? { id: out.saved.id, v: out.saved.v ?? null, root: ref.root } : null }
  if (ran.saved) await $.state.set(LAST, ran.saved)
  return ran
}

/** What Claude reads of a verb the person ran, with their next prompt. */
function ranNote(r: Ran): string {
  const said = r.error ? ` It failed: ${r.error}` : r.text ? ` It said: ${cut(r.text, 1200)}` : ''
  return `The person ran the verb ${r.verb} on ${r.on}.${r.saved ? ` It shows them ${refText(r.saved)}.` : ''}${said}${r.note ? ' ' + r.note : ''}`
}

/** Words for Claude alone, given with the next prompt (prompt.submit's context): no row of the transcript. */
async function noteForClaude($: Engine, text: string): Promise<void> {
  const cur = ((await $.state.get(NOTES)).value ?? []) as string[]
  await $.state.set(NOTES, [...cur, text].slice(-12))
}

/** A turn this plugin starts: `rows` (what verbs said since Claude's last reply, the request, what the observer has for
 *  Claude) go just before it as a row the person does not see, for Claude alone; the prompt is `t.text`, as the person
 *  would type it. Claude Code labels its row as the plugin's. */
async function startTurn($: Engine, rows: string[], t: { text: string; typed: boolean; verb: string }): Promise<void> {
  const notes = ((await $.state.get(NOTES)).value ?? []) as string[]
  await $.state.set(NOTES, [])
  // the observer hears of the turn (its own prompt.submit hook may never see this plugin's prompt): its notes come back
  const heard = await ownTurn($, t).catch(() => null)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: [...notes, ...rows, ...(heard ? [heard] : [])].join('\n\n') }] } })
  await $.prompt.submit({ text: t.text, asUser: true })
}

/** A verb's request to Claude, as a turn the person started: its row is the person's press in a few words (`explore
 *  01-saves`), as they would type it; the request itself goes just before it, for Claude alone (startTurn). */
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

// ------------------------------------------------------------------------------------------------ the browser

/** Whether browser mode is on: the plugin's `browser` setting, false at install. */
export function browserOn(): boolean {
  return browserFlag
}

/** The theme the person picked (dark or light): the cards' palette follows it. */
export function currentTheme(): 'dark' | 'light' {
  return theme
}

/** The folder whose thimble/ the pages read: the latest object's, else the nearest with a thimble/ folder, else the
 *  session's own. */
async function webRoot($: Engine): Promise<string> {
  return (await rootHere($)) || String(await $.session.cwd()).replace(/\/+$/, '')
}

async function startServer($: Engine, root: string): Promise<{ base: string } | { problem: string }> {
  if (server && server.root === root) return { base: server.base }
  if (serverStarting) return serverStarting
  if (server) stopServer()
  const dir = $.plugin.root.replace(/\/+$/, '')
  const session = String(await $.session.id())
  serverStarting = new Promise(resolve => {
    void (async () => {
      let buf = ''
      let ready = false
      let why = ''
      try {
        const child = $.process.spawn({ argv: ['node', `${dir}/shell/node/serve.mjs`, '--root', root, '--session', session, '--lean', `${dir}/bin/lean`], env: await leanEnv($, root) })
        serverStream = child as unknown as { return?: (v?: unknown) => unknown }
        for await (const piece of child) {
          if (piece.stream !== 'stdout') continue
          buf += piece.text
          let nl = buf.indexOf('\n')
          while (nl >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            nl = buf.indexOf('\n')
            let msg: Any
            try { msg = JSON.parse(line) } catch { continue }
            if (msg.ready) {
              server = { base: `http://127.0.0.1:${msg.ready.port}/${msg.ready.token}`, root }
              ready = true
              await $.state.set(WEB, { base: server.base, root, on: true })
              resolve({ base: server.base })
            } else if (typeof msg.ask === 'string') {
              void askFromBrowser($, root, msg.ask, msg.scope || {})
            } else if (typeof msg.verb === 'string') {
              void verbFromBrowser($, root, String(msg.verb), String(msg.row || ''), typeof msg.proposal === 'string' ? msg.proposal : null)
            } else if (msg.squeeze && typeof msg.squeeze === 'object') {
              // a squeeze chip pressed under a message in the browser: the same rewrite in place as a press here
              void paneActFromBrowser($, { ...msg.squeeze, pane: 'chips', args: { row: msg.squeeze.row }, do: 'squeeze', ...(msg.squeeze.custom ? { stretch: msg.squeeze.custom } : {}), ...(msg.squeeze.chip != null ? { at: { [msg.squeeze.chip]: msg.squeeze.level } } : {}) })
            } else if (msg.cardstate) {
              await stateFromBrowser($, root, msg.cardstate)
            } else if (msg.panestate && typeof msg.panestate === 'object') {
              // the browser's run of a pane's program answered with a state: the same pane here shows it
              await paneFromBrowser($, msg.panestate)
            } else if (msg.act && typeof msg.act === 'object') {
              // an action the browser's run of a pane's program asked for, done here as the terminal's run would
              void paneActFromBrowser($, msg.act)
            } else if (msg.back) {
              await backFromBrowser($, root, msg.back)
            } else if (msg.stopped) {
              why = String(msg.stopped)
            }
          }
        }
      } catch (err) {
        if (!ready) resolve({ problem: String((err as Error)?.message || err).slice(0, 200) })
      }
      server = null
      serverStarting = null
      serverStream = null
      if (!ready) resolve({ problem: 'the page server stopped before it was ready' })
      // it stops on its own once no page is open (`why`), or with the module: the next `o` starts it again
      await $.state.set(WEB, { on: browserFlag, ...(why ? { stopped: why } : {}) })
    })()
  })
  const r = await serverStarting
  if ('problem' in r) serverStarting = null
  return r
}

/** End the page server, if one runs (browser mode turned off). */
function stopServer(): void {
  try { serverStream?.return?.() } catch { /* it ends with the module anyway */ }
  serverStream = null
  server = null
  serverStarting = null
}

/** The old page's "back to terminal": the detail view opens on the object and part the page had selected. */
async function backFromBrowser($: Engine, root: string, back: { object: string; v: number | null; region: string | null; state?: Record<string, unknown> }): Promise<void> {
  if (!ID.test(back.object)) return
  const region = back.region && REGION.test(back.region) ? back.region : null
  const ref = await withVersion($, { id: back.object, v: back.v ?? null, root })
  const state = back.state && typeof back.state === 'object' && !Array.isArray(back.state) ? back.state : undefined
  await select($, { id: ref.id, v: ref.v, root: ref.root, region, ex: 0, all: false, ...(state ? { state } : {}) })
  const o = await loadObject($, ref)
  await openDetailPane($, o?.title ? cut(String(o.title), 40) : ref.id)
}

/** A card's interaction state the browser's program answered with: kept where both surfaces read it, and the open
 *  detail here follows it (the same selection in the terminal and the browser). */
async function stateFromBrowser($: Engine, root: string, c: { object: string; region: string | null; state: Record<string, unknown> }): Promise<void> {
  if (!ID.test(c.object)) return
  await writeCardState($, root, c.object, { state: c.state, region: c.region }, 'browser')
  const sel = (await $.state.get(SEL)).value as Sel | null
  if (sel && sel.id === c.object && sel.root === root && !sel.cite && !sel.cites) await $.state.set(SEL, { ...sel, state: c.state, region: c.region ?? sel.region })
}

/** A pane's state from the browser's run of its program: kept and drawn here (the same pane, the same state). */
async function paneFromBrowser($: Engine, q: { pane: string; args?: Record<string, unknown>; state: Record<string, unknown> }): Promise<void> {
  try {
    paneOf(q.pane)
  } catch {
    return
  }
  await setPaneState($, q.pane, q.args || {}, q.state || {}, 'browser')
  if (q.pane === 'detail' && typeof q.args?.id === 'string' && ID.test(q.args.id)) {
    // the part selected in the browser's detail is the card's selection everywhere: its card under the reply marks it
    const root = await webRoot($)
    const kept = await readCardState($, root, q.args.id)
    if (typeof q.state?.region === 'string') await writeCardState($, root, q.args.id, { state: kept?.state ?? {}, region: q.state.region }, 'browser')
    await followDetail($, q.args.id)
  }
}

/** An action a pane's program asked for in the browser (k.do), done as the terminal's run would do it. */
async function paneActFromBrowser($: Engine, q: Record<string, unknown>): Promise<void> {
  const pane = String(q.pane || '')
  try {
    paneOf(pane)
  } catch {
    return
  }
  await act($, instance(pane, (q.args as Record<string, unknown>) || {}), q)
}

/** The record of one of Claude's messages in this session (CONTRACT 1), or null. */
async function recordOf($: Engine, root: string, row: string): Promise<Any | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(row)) return null
  const file = `${root}/thimble/messages/${String(await $.session.id())}/${row}.json`
  try { return (await $.fs.exists(file)) ? JSON.parse(String(await $.fs.read(file))) : null } catch { return null }
}

type WebScope = { row?: string; object?: string; v?: number; region?: string; label?: string; thread?: string; claim?: string; refs?: string[]; mark?: { kind?: string; ref?: string; gloss?: string; label?: string; term?: string } }

/** What Claude reads beside a question asked in the browser: what it was asked about, and where its rows are. */
export async function webContext($: Engine, root: string, scope: WebScope): Promise<string> {
  const lines = ['The person asked this in the browser page of this session, not in the terminal.']
  if (scope.object && ID.test(scope.object)) {
    const ref = await withVersion($, { id: scope.object, v: scope.v ?? null, root })
    const p = await prepared($, ref, 96)
    const o = p.object
    const region = scope.region && REGION.test(scope.region) ? scope.region : null
    const label = region ? String(regionMeta(p.drawing, region)?.label || scope.label || region) : ''
    lines.push(`They asked it on the page of ${ref.id}@${o?.version ?? ref.v} "${o?.title || ''}" (${root}/thimble/objects/${ref.id}.json)${region ? `, with its part ${region} ("${label}") selected. "This" may mean that part.` : '.'}`)
    const refs = o && region ? regionRefs(o, p.drawing, region).refs : o ? objectRefs(o).map((c: Any) => c.ref) : []
    if (refs.length) lines.push(`${region ? 'That part rests' : 'Its words rest'} on ${refs.slice(0, 3).join(', ')}; \`lean resolve <ref>\` opens the rows, \`lean list ${ref.id}\` the object's lineage.`)
  }
  if (scope.claim && /^c\d{1,6}$/.test(scope.claim)) {
    const store = await claimsStore($)
    const c = store.claims.find((x: Any) => x.id === scope.claim)
    if (c) {
      const first = (c.said || [])[0]
      const refs = (c.sources || []).map((x: Any) => x.ref).slice(0, 4)
      lines.push(`They asked it about the claim ${c.id} "${c.text}" on the page of this session's claims${c.revised_by ? ` (since revised by ${c.revised_by})` : ''}${first?.quote ? `, first said as "${first.quote}"` : ''}.${refs.length ? ` It rests on ${refs.join(', ')}.` : ''} "This" may mean that claim.`)
    }
  }
  const m = scope.mark
  if (m && m.kind === 'gloss') {
    lines.push(`They asked about the term "${m.term || m.label || ''}", which the page explains under your message.`)
  } else if (m && m.ref && isRef(m.ref)) {
    lines.push(`They asked about your citation "${m.label || m.ref}" (${m.ref}). \`lean resolve ${m.ref}\` shows its rows.`)
  }
  if (scope.row) {
    const rec = await recordOf($, root, scope.row)
    const text = rec ? String(rec.shown ?? rec.text ?? '') : ''
    if (text && !scope.object) lines.push(`It is about your message that begins: "${cut(text.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1').replace(/\s+/g, ' '), 240)}"`)
  }
  return lines.join('\n')
}

/** A question asked in the browser. About a card or a mark it is a side thread (thread.ts), which main does not see;
 *  about a message as a whole it is a turn the person started, their words as the prompt, what it was asked about
 *  just before it as a row for Claude alone (as a verb's request is). Claude Code labels that prompt's row as the
 *  plugin's. */
async function askFromBrowser($: Engine, root: string, text: string, scope: WebScope): Promise<void> {
  try {
    // a question asked in a thread the page shows (its tree, its column): that thread again, on the part it is about
    if (scope.thread) {
      await restoreThreads($, root)
      const t = threadOf(scope.thread)
      if (t) {
        const r = await askThread($, { text, root: t.root || root, scope: t.scope as ThreadScope, card: t.scope.object ? { id: t.scope.object, v: t.scope.v ?? null, title: t.card || undefined, file: `${t.root || root}/thimble/objects/${t.scope.object}.json` } : null })
        if (r.problem) $.ui.toast(`A question from the browser: ${r.problem}.`)
        return
      }
    }
    if ((scope.object && ID.test(scope.object)) || scope.mark) {
      const card = scope.object && ID.test(scope.object) ? await withVersion($, { id: scope.object, v: scope.v ?? null, root }) : null
      const p = card ? await prepared($, card, 96) : null
      const region = scope.region && REGION.test(scope.region) ? scope.region : null
      // a selection the card's program asked about (k.ask) names its own rows
      const picked = Array.isArray(scope.refs) ? scope.refs.filter(x => isRef(x)) : []
      const refs = picked.length ? picked : p?.object ? (region ? regionRefs(p.object, p.drawing, region).refs : objectRefs(p.object).map((c: Any) => c.ref)) : undefined
      const r = await askThread($, {
        text, root, ...(refs ? { refs } : {}),
        scope: { ...(card ? { object: card.id, v: card.v } : {}), ...(region ? { region, label: scope.label || String(regionMeta(p?.drawing, region)?.label || region) } : picked.length && scope.label ? { label: scope.label } : {}), ...(scope.row ? { row: scope.row } : {}), ...(scope.mark ? { mark: scope.mark } : {}) },
        card: p?.object ? { id: p.object.id, v: p.object.version, title: p.object.title, file: `${root}/thimble/objects/${p.object.id}.json` } : null,
      })
      if (r.problem) $.ui.toast(`A question from the browser: ${r.problem}.`)
      return
    }
    // the person's own question, typed in the page
    await startTurn($, [await webContext($, root, scope)], { text, typed: true, verb: '' })
  } catch (err) {
    $.ui.toast(`A question from the browser did not reach Claude${plainWhy(err) ? ` (${plainWhy(err)})` : ''}. Type it here instead.`)
  }
}

/** A verb pressed under a message in the browser: run here as the terminal's verb row runs it, on the message. */
async function verbFromBrowser($: Engine, root: string, key: string, row: string, proposal: string | null): Promise<void> {
  if (key === 'c') {
    // the claims are the browser's own tab; pressed on a message there, the list opens under it here too
    if (await recordNow($, row)) await pressRowVerb($, row, 'c')
    return
  }
  const verb = (await rowVerbs($)).find(v => v.key === key)
  if (!verb) { $.ui.toast(`The browser pressed ${key}, but no verb of the row is on that key, so nothing ran.`); return }
  const rec = (await recordNow($, row)) ?? ((await recordOf($, root, row)) as MsgRecord | null)
  if (!rec) { $.ui.toast(`${verb.name}: the message pressed in the browser is not in this session's records. Press ${key} under it here.`); return }
  $.clock.after(0, () => { void runOnMessage($, verb.name, key, rec, proposal || '') })
}

/** Open a page of this session in the browser: the mirror (at a row), or a card's detail (on a part). */
export async function openBrowser($: Engine, at: { id?: string; v?: number | null; region?: string | null; row?: string | null; root?: string; view?: string; claim?: string | null } = {}): Promise<string> {
  if (!browserFlag) return 'Browser mode is off. Turn on Browser in /config (thimble-lean), then press o or type /browser.'
  const root = at.root || (await webRoot($))
  const s = await startServer($, root)
  if ('problem' in s) {
    await $.state.set(WEB, { on: true, problem: s.problem })
    return `No page: ${s.problem}. Try /browser again; if it fails twice, turn Browser off and on in /config.`
  }
  const q = (o: Record<string, unknown>) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
  // the page opens where the person is: a card's detail on its part, the Claims graph on the claim the ring is on, or
  // the session at the message the keys act on
  const url = at.id
    ? `${s.base}/card/?${q({ o: at.id, v: at.v, from: at.row })}${at.region ? `#r=${encodeURIComponent(at.region)}` : ''}`
    : at.view
      ? `${s.base}/app/?${q({ view: at.view, claim: at.claim })}`
      : `${s.base}/mirror/${at.row ? `#row=${encodeURIComponent(at.row)}` : ''}`
  const what = at.id ? `${at.id}${at.region ? ' ▸ ' + at.region : ''}` : at.view === 'claims' ? `the claims${at.claim ? ` at ${at.claim}` : ''}` : 'this session'
  const browser = await $.env.get('BROWSER')
  const tries = browser ? [[browser, url]] : [['xdg-open', url], ['open', url]]
  for (const argv of tries) {
    const r = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => null)
    if (r && r.exitCode === 0) {
      await $.state.set(WEB, { on: true, base: s.base, root, opened: url })
      return `Opened ${what} in the browser.`
    }
  }
  await $.state.set(WEB, { on: true, base: s.base, root, opened: url, problem: 'no browser opened here; open the link yourself' })
  return `No browser opened here. The page: ${url}`
}

/** Browser mode turned on or off in /config: on, /browser is there; off, the server ends and nothing of it shows. */
async function setBrowser($: Engine, on: boolean): Promise<void> {
  const was = browserFlag
  browserFlag = on
  if (on && !was) await registerBrowserCommand($)
  if (!on) stopServer()
  await $.state.set(WEB, { on })
}

async function registerBrowserCommand($: Engine): Promise<void> {
  await $.command.register({ name: 'browser', description: "Open this session in the browser: /browser · /browser <object> [region] opens a card's page", argumentHint: '[object] [region]', immediate: true })
}

/** `o browser`, a press that opens a page: under a card (its detail page) or under a reply (the mirror at it). */
function browserChip(els: Any, key: string, onPress: () => unknown) {
  const { Button, Text } = els
  return Button({ key, plain: true, label: 'open in the browser', children: [Text({ color: 'suggestion', children: 'o' }), Text({ dimColor: true, children: ' browser' })], onPress })
}

// ------------------------------------------------------------------------------------------------ the message layer
//
// Every row the shell draws has a line in thimble/messages/<session>/index.jsonl, and each of Claude's messages a
// record, <row>.json (CONTRACT 1): its words, the marks in them, the verbs the observer lit and the objects drawn under
// it. The records live in the folder under analysis, so the browser's page server reads the same; a session whose
// folder has no thimble/ yet keeps them in memory and writes them once lean has made one.

/** The records' folder of this session: <root>/thimble/messages/<session>, or null while there is no root. */
async function messagesDir($: Engine): Promise<{ session: string; dir: string | null }> {
  const session = String(await $.session.id())
  const root = await rootHere($)
  return { session, dir: root ? `${root.replace(/\/+$/, '')}/thimble/messages/${safe(session)}` : null }
}

/** The index and folder of this session, read once per load of the module (a resumed session finds its own). A
 *  folder that appears later (lean made thimble/, or the session's root became known) is read then, and what was kept
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
  return recordFor(kept, { row: at, session: String(await $.session.id()), text }) as MsgRecord
}

/** The verbs of the row, as the registry lists them: those whose verb.json says `"row": true`, in their `order`. */
async function rowVerbs($: Engine): Promise<RowVerb[]> {
  const held = (await $.state.get(ROWVERBS)).value as RowVerb[] | null | undefined
  if (held) return held
  return [{ key: 'v', name: 'visualize' }, { key: 's', name: 'squeeze' }]
}

async function loadRowVerbs($: Engine): Promise<void> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run(['node', `${dir}/shell/node/verb.mjs`, 'list'], { timeoutMs: 30000 })
  const list = JSON.parse(r.stdout).verbs as Any[]
  const row = list.filter(v => v.row === true && v.key).sort((a, b) => (Number(a.order ?? 1e6) - Number(b.order ?? 1e6))).map(v => ({ key: String(v.key), name: String(v.name), ...(v.color ? { color: v.color } : {}) }))
  await $.state.set(ROWVERBS, row)
}

/** The rows that draw a verb row, oldest first, and the message the keys act on: the one picked, else the latest. */
async function actingRow($: Engine): Promise<string | null> {
  const sel = (await $.state.get(SELROW)).value as string | null | undefined
  if (sel) return sel
  const answer = (await $.state.get(ANSWER)).value as string | null | undefined
  if (answer) return answer
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
  const answer = (await $.state.get(ANSWER)).value
  await $.state.set(SELROW, row === answer ? null : row)
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
  for (const row of await messageRows($)) {
    const rec = await recordNow($, row)
    ;(rec?.marks || []).forEach((_, i) => out.push({ row, i }))
    for (const card of ((await $.state.get({ ...UNDER, id: row })).value ?? []) as ObjRef[]) out.push({ row, card })
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
  const answer = (await $.state.get(ANSWER)).value
  await $.state.set(SELROW, row === answer ? null : row)
  await quietly($.ui.scroll({ to: { key: `row-${row}-card-${card.id}` }, block: 'nearest' }))
}

async function closeTray($: Engine): Promise<void> {
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

/** The card a tray frame shows, as the tray program wants it (panes/tray.js): its parts drawn in the sandbox at `w`. */
async function trayCard($: Engine, req: Any, w: number, h: number): Promise<Any> {
  let spec: Any
  if (req?.kind === 'gloss') spec = explainerCard({ gloss: req.gloss || {} })
  else if (typeof req?.ref === 'string' && req.ref) spec = await sourceSpec($, req.ref, req.kind === 'spark' ? 'sparkline' : String(req.label || req.ref), h)
  else return { problem: 'this mark names no ref, so there are no rows to show', drawings: [], links: [] }
  if (spec.problem) return { title: spec.title, right: spec.right, problem: spec.problem, drawings: [], links: [] }
  const drawings: Any[] = []
  for (const part of spec.parts || []) {
    try {
      const d = await drawPart($, part, w, h)
      if (d.drawing?.error && part.pic) continue // a gloss's drawing that fails: its words stand alone
      drawings.push(d.drawing)
    } catch (err) {
      if (!part.pic) return { title: spec.title, right: spec.right, problem: `the card could not be drawn: ${String((err as Error)?.message || err).slice(0, 160)}`, drawings: [], links: [] }
    }
  }
  return { title: spec.title, right: spec.right, drawings, links: spec.links || [], ...(spec.why ? { why: spec.why } : {}) }
}

/** `lean resolve <ref> --json`, as the person's own read (never counted as Claude's coverage). */
async function resolveJson($: Engine, root: string, ref: string, n = 6, label?: string): Promise<Any> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  // with the citation's words, a citation of a whole query opens the row that holds the value it shows
  const words = label && label !== ref ? ['--label', label] : []
  const r = await $.process.run([`${dir}/bin/lean`, 'resolve', ref, '-n', String(n), ...words, '--json'], { cwd: root, env: await leanEnv($, root), timeoutMs: 60000 })
  try { return JSON.parse(r.stdout) } catch { return { ref, error: (r.stdout + r.stderr).trim().slice(0, 300) || 'lean resolve gave nothing' } }
}

/** One part of a card drawn: its program in the drawing contract's sandbox, then as terminal cells. */
async function drawPart($: Engine, part: { program: string; data: unknown }, w: number, h: number): Promise<Any> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `${dir}/shell/node/prep.mjs`], { stdin: JSON.stringify({ object: { id: 'card', program: part.program, data: part.data }, w, h, mode: 'inline', noVerbs: true }), timeoutMs: 30000 })
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 200) || `exit ${r.exitCode}`)
  const out = JSON.parse(r.stdout)
  return { drawing: out.drawing, grid: renderTerm(out.drawing, { w }) }
}

/** A citation's card spec (cards.js citeCard): the ref resolved, the query's record or the code file's lines read, as
 *  the person's own reads. */
async function sourceSpec($: Engine, ref: string, label: string, room: number): Promise<Any> {
  const root = await rootHere($)
  if (!root) return { title: label, right: 'cite', problem: `no thimble/ folder here to read ${ref} from; run lean in the data folder first` }
  return citeCard({ ref, label, root, room }, { resolve: (r: string, n: number, l?: string) => resolveJson($, root, r, n, l), read: (p: string) => $.fs.read(p) })
}

/** The message as an object a verb reads: its words as shown, its row and its session. */
function messageObject(rec: MsgRecord): Any {
  const text = shownOf(rec)
  const first = text.replace(/\s+/g, ' ').trim()
  return { id: `msg-${rec.row.slice(0, 8)}`, version: 1, kind: 'message', row: rec.row, session: rec.session, title: first.length > 60 ? first.slice(0, 59) + '…' : first, text }
}

/** A verb key under a message: its line opens (a press on the open one closes it). */
async function pressRowVerb($: Engine, row: string, key: string): Promise<void> {
  const cur = (await $.state.get(PICK)).value as Any
  if (cur && cur.row === row && cur.verb === key) { await setPick($, null); return }
  // c: the Claims pane, read again (the orientation may have added claims), opened or closed
  // what the person pressed, with whether the post-turn pass had lit it (lean stats: how often a lit verb is used)
  const lit = !!((await recordNow($, row))?.verbs as Record<string, Any> | undefined)?.[key]?.lit
  void recordEvent($, { kind: 'press', verb: key, row, lit })
  if (key === 'c') { await toggleClaims($, row); return }
  await setTray($, null)
  await setCardFocus($, null)
  await setPick($, { row, verb: key })
  const answer = (await $.state.get(ANSWER)).value
  await $.state.set(SELROW, row === answer ? null : row)
  // the line in view, when a key opened it under a message above the screen
  await quietly($.ui.scroll({ to: { key: `vl-${row}-opt-0` }, block: 'nearest' }))
}

/** An option of the open line picked (the proposals program's k.do('pick')): the verb runs on the message, outside the
 *  press. */
async function pickOption($: Engine, row: string, verbKey: string, choice: string): Promise<boolean> {
  const rec = await recordNow($, row)
  if (!rec) return false
  await setPick($, null)
  const verb = (await rowVerbs($)).find(v => v.key === verbKey)
  if (!verb) return false
  $.clock.after(0, () => { void runOnMessage($, verb.name, verbKey, rec, choice) })
  return true
}

/** Run a verb of the row on a message: its run.mjs in a Node child, with the message record in its ctx. What it made is
 *  drawn under the message, what it asks of Claude goes as a turn, what it says shows as a toast. */
async function runOnMessage($: Engine, word: string, key: string, rec: MsgRecord, choice: string): Promise<void> {
  const at = { ...RUNNING, id: rec.row }
  if ((await $.state.get(at)).value) return
  await $.state.set(at, key)
  try {
    const root = (await rootHere($)) || String(await $.session.cwd())
    const dir = $.plugin.root.replace(/\/+$/, '')
    const input = {
      object: messageObject(rec), message: rec, row: rec.row, session: rec.session, root, region: null, regionMeta: null,
      refs: rec.marks.filter(m => m.ref).map(m => m.ref), drawing: null, state: {}, args: key === 'v' && choice !== ANOTHER_VIEW ? choice : '', w: 96,
    }
    const answers: Record<string, unknown> = {}
    let out: Any = null
    for (let round = 0; round < 8; round++) {
      const r = await $.process.run(['node', `${dir}/shell/node/verb.mjs`, 'run', word], { stdin: JSON.stringify({ ...input, answers }), cwd: root, env: await leanEnv($, root), timeoutMs: 600000 })
      try { out = JSON.parse(r.stdout) } catch { out = { verb: word, error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400) || `exit ${r.exitCode}` } }
      if (!out.need) break
      answers[String(out.need.key)] = await modelCall($, out.need, word)
    }
    if (out?.need) out = { verb: word, error: 'it asked the model more than eight times' }
    const on = `the message ${messageObject(rec).title ? `"${messageObject(rec).title}"` : rec.row}`
    if (out.saved) {
      const saved = { id: String(out.saved.id), v: out.saved.v ?? null, root }
      await place($, rec.row, saved)
      await $.state.set(LAST, { id: saved.id, v: saved.v, root: saved.root })
      const cur = (await recordNow($, rec.row)) || rec
      if (!cur.objects.includes(saved.id)) await saveRecord($, { ...cur, objects: [...cur.objects, saved.id] })
    }
    if (out.error) failed($, `${word} did not run`, out.error, `Press ${key} under the message again, or ask Claude`)
    else if (out.ask) void ask($, String(out.ask), word, choice || on)
    else if (out.text && !out.saved) $.ui.toast(cut(String(out.text).split('\n')[0] || '', 200))
    if (!out.ask && !out.error) await noteForClaude($, `The person ran the verb ${word} on ${on}.${out.saved ? ` It shows them ${out.saved.id}.` : ''}${out.text ? ` It said: ${cut(String(out.text), 600)}` : ''}${out.note ? ' ' + out.note : ''}`)
    else if (out.note) await noteForClaude($, String(out.note))
  } catch (err) {
    failed($, `${word} did not run`, err, `Press ${key} under the message again, or ask Claude`)
  } finally {
    await $.state.set(at, null)
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
  // the observer's look may have kept this turn's claims: the thimble line counts them again
  $.clock.after(0, () => { void recount($) })
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
  if (t) await $.state.get({ plugin: 'thimble-lean', key: 'thread', id: threadKeyOf(t.scope) })
  const { Box } = $.ui.resolve(e) as Any
  return Box({ marginLeft: 2, children: [await paneEl($, e, 'tray', {}, { w, h: 14 })] })
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

// ------------------------------------------------------------------------------------------------ claims
//
// The session's claims (CONTRACT 7) are kept in <root>/thimble/claims/<session>.json, beside its messages, so the
// browser's page server reads the same. The observer's one look adds each turn's claims (observer.ts); `lean verb
// claims save` adds the corpus orientation's. c under a message opens the list there; a claim opens in the tray.

type ClaimsStore = ReturnType<typeof emptyStore> & Record<string, Any>
type Place = { row: string; by: 'person' | 'claude'; turn: number | null; text: string; sparks?: Record<string, number[]> }

/** The claims file of this session, or null while there is no folder under analysis. */
async function claimsFile($: Engine): Promise<string | null> {
  const root = await rootHere($)
  return root ? `${root.replace(/\/+$/, '')}/thimble/claims/${safe(String(await $.session.id()))}.json` : null
}

/** This session's claims: as held, else as on disk, else none yet. A copy: the caller may change it. */
export async function claimsStore($: Engine): Promise<ClaimsStore> {
  const session = String(await $.session.id())
  const held = (await $.state.get(CLAIMS)).value as ClaimsStore | null | undefined
  if (held && held.session === session) return JSON.parse(JSON.stringify(held))
  return reloadClaims($)
}

/** The claims read again from disk (the orientation's CLI wrote them, or a resumed session), and held. */
async function reloadClaims($: Engine): Promise<ClaimsStore> {
  const session = String(await $.session.id())
  const file = await claimsFile($)
  let store = emptyStore(session) as ClaimsStore
  try {
    if (file && (await $.fs.exists(file))) store = readStore(String(await $.fs.read(file)), session) as ClaimsStore
    else {
      const held = (await $.state.get(CLAIMS)).value as ClaimsStore | null | undefined
      if (held && held.session === session) store = held
    }
  } catch {
    // a file it cannot read: the claims start again, and the next save writes a whole one
  }
  await $.state.set(CLAIMS, store)
  return JSON.parse(JSON.stringify(store))
}

/** The claims kept: held for the drawing, and written for the browser and a resumed session. With no folder yet they
 *  are held only, and the next save writes them. */
export async function saveClaims($: Engine, store: ClaimsStore): Promise<void> {
  await $.state.set(CLAIMS, store)
  const file = await claimsFile($)
  if (file) await $.fs.write(file, JSON.stringify(store, null, 1))
  // the thimble line counts the claims again
  $.clock.after(0, () => { void recount($) })
}

/** A turn's prompt row, its turn number (the person's prompts so far) and Claude's message rows. */
async function turnOf($: Engine, rows: string[]): Promise<{ prompt: { row: string; text: string } | null; rows: string[]; turn: number | null }> {
  const idx = (await msgFilesNow($)).index
  const first = rows.length ? idx.findIndex(x => x.row === rows[0]) : -1
  let p = -1
  for (let i = (first < 0 ? idx.length : first) - 1; i >= 0; i--) if (idx[i].kind === 'user') { p = i; break }
  const prompt = p >= 0 ? { row: String(idx[p].row), text: String(idx[p].text || '') } : null
  return { prompt, rows: [...rows], turn: p >= 0 ? idx.slice(0, p + 1).filter(x => x.kind === 'user').length : null }
}

/** Where a turn's claims can have been said: the person's prompt, then each of Claude's messages in the turn. */
export async function turnPlaces($: Engine, turnId: string): Promise<{ turn: number | null; rows: string[]; places: Place[] }> {
  const t = (await $.state.get({ ...TURNS, id: turnId })).value as { prompt: { row: string; text: string } | null; rows: string[]; turn: number | null } | null | undefined
  if (!t) return { turn: null, rows: [], places: [] }
  const places: Place[] = []
  if (t.prompt?.text) places.push({ row: t.prompt.row, by: 'person', turn: t.turn, text: t.prompt.text })
  for (const row of t.rows) {
    const rec = await recordNow($, row)
    // each sparkline's values ride along, so a claim that rests on one draws it in its card with no lookup
    const sparks = Object.fromEntries((rec?.marks || []).filter(m => m.kind === 'spark' && Array.isArray(m.values) && m.ref).map(m => [m.ref!, (m.values as number[]).slice(0, 48)]))
    if (rec?.text) places.push({ row, by: 'claude', turn: t.turn, text: rec.text, ...(Object.keys(sparks).length ? { sparks } : {}) })
  }
  return { turn: t.turn, rows: t.rows, places }
}

/** One verb of a message's row lit (or dimmed, with null), its other verbs kept. */
export async function setVerb($: Engine, row: string, key: string, v: Record<string, unknown> | null): Promise<void> {
  const rec = await recordNow($, row)
  if (!rec) return
  const verbs = { ...(rec.verbs || {}) } as Record<string, Any>
  if (v) verbs[key] = v
  else delete verbs[key]
  await saveRecord($, { ...rec, verbs })
}

/** The claims the list marks as new under a message: those the observer counted for it. */
function freshOf(rec: MsgRecord | null): string[] {
  const c = (rec?.verbs as Any)?.c
  return Array.isArray(c?.claims) ? c.claims.map(String) : []
}

/** The Claims pane is open, from the message it was opened from (its new claims are marked). What the person does in
 *  it (the claim hovered, a replay) is the pane program's state (panes/claims.js, shell/panes.ts). */
type ClaimPane = { row: string }

/** Open the Claims pane, focused, from a message; a second c closes it. */
async function toggleClaims($: Engine, row: string): Promise<void> {
  if ((await $.state.get(CLAIMPANE)).value) { await closeClaims($); return }
  await reloadClaims($)
  await $.state.set(CLAIMPANE, { row } as ClaimPane)
  await pushFocus($, 'claims')
  // after the key that asked for it is done, so the pane takes the keyboard from the prompt
  $.clock.after(0, () => { void openClaimsPane($) })
}

/** The pane takes the keyboard. */
async function openClaimsPane($: Engine): Promise<void> {
  // docked beside the conversation, leaving it its share of the terminal (as the detail does)
  const r = await $.ui.open({ id: CPANE, title: 'Claims', focus: true, closeOnEscape: true, columns: paneColumns() })
  if (r && (r as Any).isPlaced === false) $.ui.toast(`Claims: ${(r as Any).reason || 'the pane was not placed'}. Widen the terminal, then press c again.`)
}

async function closeClaims($: Engine): Promise<void> {
  await $.state.set(CLAIMPANE, null)
  await popFocus($, 'claims')
  paneClosed('claims')
  await quietly($.ui.close({ id: CPANE }))
}

/** The Claims pane: the claims program (panes/claims.js) on the session's store, in the room the pane has. */
async function claimsPaneNow($: Engine, e: Any): Promise<Any> {
  noteDock(e)
  const st = ((await $.state.get(CLAIMPANE)).value as ClaimPane | null) ?? { row: '' }
  const w = Math.max(30, (e.props.bodyColumns ?? 120) - 1)
  const h = Math.max(6 + HEAD_ROWS, e.props.scroll?.bodyRows ?? 40)
  return paneEl($, e, 'claims', { row: st.row || '' }, { w, h }, { painted: true })
}

/** A question asked with the ring on a claim of the Claims pane: what it carries for Claude, and the row's few words. */
async function claimScope($: Engine): Promise<{ context: string; label: string; scope: Record<string, unknown> } | null> {
  if (!(await $.state.get(CLAIMPANE)).value) return null
  const id = (await paneState($, 'claims')).hover as string | null | undefined
  if (!id) return null
  const store = await claimsStore($)
  const c = store.claims.find((x: Any) => x.id === id)
  if (!c) return null
  const first = (c.said || [])[0]
  const where = first ? (first.by === 'orientation' ? 'from the corpus orientation' : `said in turn ${first.turn ?? '?'} by ${first.by === 'person' ? 'the person' : 'you'}: "${first.quote}"`) : ''
  const refs = (c.sources || []).map((x: Any) => x.ref).slice(0, 4)
  return {
    label: `claim: ${c.text}`, scope: { claim: c.id, ...(first?.row ? { row: first.row } : {}) },
    context: `The person asked this with the ring on a claim of this session in the Claims pane: ${c.id} "${c.text}"${c.revised_by ? ` (since revised by ${c.revised_by})` : ''}, ${where}.${refs.length ? ` It rests on ${refs.join(', ')}; \`lean resolve <ref>\` shows the rows.` : ''} "This" or "it" may mean that claim.`,
  }
}

/** A question asked with the tray open: what it carries for Claude, and the row's few words for the person. */
async function trayScope($: Engine): Promise<{ context: string; label: string; scope: Record<string, unknown>; refs: string[] } | null> {
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const frame = trayTop(tray) as TrayFrame | null
  if (!frame) return null
  if (frame.row == null) {
    return {
      label: frame.label || frame.ref!, scope: { mark: { kind: 'cite', ref: frame.ref, label: frame.label } }, refs: [frame.ref!],
      context: `The person asked this with a citation open in the tray: ${frame.label || ''} (${frame.ref}). "This" may mean that value. \`lean resolve ${frame.ref}\` shows its rows.`,
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
      context: `The person asked this with a gloss of your reply open in the tray: the term "${g.term}" in your reply that begins "${begins}". The gloss said: ${g.body || g.title || ''}${g.here ? ' ' + g.here : ''} "This" or "it" may mean that term.`,
    }
  }
  const label = m.kind === 'spark' ? `the sparkline of ${m.ref}` : String(m.label)
  return {
    label, scope: { row: rec.row, mark: { kind: m.kind, ref: m.ref, label } }, refs: [seriesRef(m.ref!)?.query ?? m.ref!],
    context: `The person asked this with a ${m.kind === 'spark' ? 'sparkline' : 'citation'} of your reply open in the tray: ${label} (${m.ref}), in your reply that begins "${begins}". "This" may mean that value. \`lean resolve ${seriesRef(m.ref!)?.query ?? m.ref}\` shows its rows.`,
  }
}

// ------------------------------------------------------------------------------------------------ the thimble line
//
// One bar above the prompt, where thimble 0.9 puts its line; the area under the prompt stays Claude Code's own.
//
//   thimble  v visualize · s ● 6 of 24 lines · c claims · ] cite & explain · 1 open detail      2 cards · 11 cites · coverage 34%
//
// At its left, what the keys do now, in words as Claude Code says its own keys: at rest the verbs of the message the
// keys act on (a lit one with its note in place of its name), `] cite & explain` when that message has marks, `1 open
// detail` when a card is under it, `o browser` in browser mode. While a pane, the tray or the chips have focus, the
// left side is their keys instead, and it comes back after. At its right, the session's counts that are not zero: a
// count that changed is drawn bright for a moment, then dims. Inside a thread (the card detail, a mark's thread) its
// label names the thread the prompt goes to, `thimble:main/<it>`.

const BRIGHT_MS = 1600

/** The read share of a file as `lean coverage` reports it: rows computed over, or lines read, or rows shown, of its
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

/** This session's counts for the thimble line, counted again: the cards drawn, the side threads, the citations in
 *  Claude's words, the claims kept, and (with `coverage`) the share of the folder's data Claude has read, by rows. A
 *  count that changed is stamped, so it brightens. */
export async function recount($: Engine, o: { coverage?: boolean } = {}): Promise<void> {
  try {
    const old = ((await $.state.get(COUNTS)).value ?? null) as LineCounts | null
    const now = await $.clock.now()
    const s = await shownNow($)
    const cards = new Set(Object.values(s.under).flat().map(x => `${x.root}|${x.id}`)).size
    let cites = 0
    for (const row of await messageRows($)) {
      const rec = await recordNow($, row)
      if (rec) cites += linkMarks(rec.text).length
    }
    const root = await rootHere($)
    let claims = old?.claims ?? 0
    if (root) {
      const file = `${root.replace(/\/+$/, '')}/thimble/claims/${safe(String(await $.session.id()))}.json`
      try { claims = (await $.fs.exists(file)) ? (JSON.parse(String(await $.fs.read(file))).claims || []).length : 0 } catch { /* a file being written: the last count stands */ }
    }
    let cov = old?.cov ?? 0
    if (o.coverage && root) {
      const dir = $.plugin.root.replace(/\/+$/, '')
      try {
        const r = await $.process.run([`${dir}/bin/lean`, 'coverage', '--json'], { cwd: root, env: { LEAN_ROOT: root, LEAN_SESSION: String(await $.session.id()) }, timeoutMs: 60000 })
        const files = (JSON.parse(r.stdout).files || []) as Any[]
        const rows = files.reduce((n, f) => n + (Number(f.rows) || 0), 0)
        if (rows > 0) cov = files.reduce((n, f) => n + readShare(f) * (Number(f.rows) || 0), 0) / rows
      } catch {
        // the line keeps the last share it had
      }
    }
    const next: LineCounts = { cards, threads: threadCount(), cites, claims, cov, at: now, changed: { ...(old?.changed || {}) } }
    const keys = ['cards', 'threads', 'cites', 'claims', 'cov'] as const
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
 *  Claims pane, the squeeze chips, v's proposals, the tray, a card under a reply). The thimble line says the keys of
 *  the top one alone, read from this one state, so it redraws whenever the stack changes. */
type FocusKind = 'detail' | 'claims' | 'chips' | 'proposals' | 'tray' | 'card'
const FSTACK = { plugin: 'thimble-lean', key: 'focus' } as const
const FOCUS_ORDER: FocusKind[] = ['card', 'proposals', 'tray', 'chips', 'claims', 'detail']

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
  if (kind === 'claims') {
    // the Claims pane's own keys, as its program names them (panes/claims.js)
    if (!(await $.state.get(CLAIMPANE)).value) return undefined
    return { keys: [barText([await paneNow($, 'claims')]) || 'esc close', ...(browserFlag ? ['o browser'] : [])].join(' · ') }
  }
  const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
  if (kind === 'chips') {
    if (pick?.verb !== 's') return undefined
    // the chips' own keys, as their program names them (panes/chips.js), after what it says of the message now
    const ui = ((await $.state.get({ ...SQZ, id: pick.row })).value ?? null) as SqzUi | null
    if (ui?.adding) {
      const ends = endsOf(String(ui.typing || '+'))
      if (!ends) return { keys: 'type two ends, such as engineer and manager · ↵ makes the stretch · ⌫ cancels' }
      return { keys: ends.from === 'as written' ? 'then and, and the other end · ↵ makes the stretch' : `↵ makes ${ends.from} ↔ ${ends.to} · ⌫ the + cancels` }
    }
    const d = await paneNow($, 'chips', { row: pick.row })
    return { status: status(d), keys: barText([d]) }
  }
  if (kind === 'tray') {
    const tray = (await $.state.get(TRAY)).value as Tray | null
    if (!tray) return undefined
    // the tray program's keys (panes/tray.js), after what it says while the person asks its thread
    const d = paneDrawing('tray') ?? (await paneNow($, 'tray'))
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
  const taken = new Set(Object.keys(hostKeys('inline', 'terminal')))
  const own = keysOf(d).filter(g => !g.key.split(' ').some(x => taken.has(x === '↵' ? 'return' : x === '↑' ? 'up' : x === '↓' ? 'down' : x)))
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
 *  token and any symbols after it (`< >`, `] [`, `↑ ↓`); a lit verb's `s ● note` keeps its color. */
function keySegments(keys: string): { key: string; words: string; color?: string; short?: string; onPress?: () => unknown }[] {
  return keys.split(' · ').map(seg => {
    const lit = /^([a-z]) ● (.*)$/.exec(seg)
    if (lit) return { key: lit[1]!, words: `● ${lit[2]}`, color: verbColor(lit[1]!, theme), short: `● ${lit[2]!.split(/\s+/)[0]}` }
    const t = seg.split(' ')
    // a phrase with no key (`type to ask`): words alone
    if (t[0]!.length > 3 && /^[a-z]+$/.test(t[0]!)) return { key: '', words: seg }
    let n = 1
    while (n < t.length && /^[^\p{L}\p{N}]+$/u.test(t[n]!)) n++
    return { key: t.slice(0, n).join(' '), words: t.slice(n).join(' ') }
  })
}

/** One key of the bar: its key, its words (and their first word, `short`, for a narrow bar), its colors, and a press. */
type BarSeg = { key: string; words: string; short?: string; color?: string; wordsColor?: string | null; tone?: 'error' | 'warning'; status?: boolean; label?: string; onPress?: () => unknown }

/** The thimble line: its label, what the keys do now at its left, the counts at its right. Null with nothing to say.
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
      const verbs = await rowVerbs($)
      const running = ((await $.state.get({ ...RUNNING, id: row })).value ?? null) as string | null
      const sqUi = ((await $.state.get({ ...SQZ, id: row })).value ?? null) as SqzUi | null
      const lit: Record<string, { lit?: boolean; note?: string }> = { ...(rec.verbs || {}) }
      const sv = sLit(rec, sqUi)
      if (sv) lit.s = sv
      else delete lit.s
      for (const v of verbs) {
        const color = verbColor(v.key, theme, v.color)
        const on = lit[v.key]
        const more = running === v.key ? '…' : ''
        if (on?.lit && on.note) left.push({ key: v.key, words: `● ${on.note}${more}`, short: `● ${v.name}`, color, wordsColor: color, label: v.name, onPress: () => pressRowVerb($, row, v.key) })
        else left.push({ key: v.key, words: `${v.name}${more}`, color, label: v.name, onPress: () => pressRowVerb($, row, v.key) })
      }
      // ] steps through what the answer holds: its marks, then its cards (a card focused takes its own keys)
      const cardsHere = ((await $.state.get({ ...UNDER, id: row })).value ?? []) as ObjRef[]
      if (rec.marks.length) left.push({ key: ']', words: 'cite & explain', color: markColors(theme).cite, onPress: () => stepMark($, 1) })
      else if (cardsHere.length) left.push({ key: ']', words: 'card', color: FOCUS[theme], onPress: () => stepMark($, 1) })
      const ref = await focusedCard($)
      if (ref) left.push({ key: '1', words: 'open detail', color: FOCUS[theme], onPress: () => openDetail($, ref) })
      if (browserFlag) left.push({ key: 'o', words: 'browser', color: FOCUS[theme], onPress: async () => $.ui.toast(await openBrowser($, { row })) })
    }
  }
  const c = ((await $.state.get(COUNTS)).value ?? null) as LineCounts | null
  const now = await $.clock.now()
  const items: [string, number, string][] = c ? [
    ['cards', c.cards, c.cards === 1 ? '1 card' : `${fmtN(c.cards)} cards`],
    ['threads', c.threads, c.threads === 1 ? '1 thread' : `${fmtN(c.threads)} threads`],
    ['cites', c.cites, c.cites === 1 ? '1 cite' : `${fmtN(c.cites)} cites`],
    ['claims', c.claims, c.claims === 1 ? '1 claim' : `${fmtN(c.claims)} claims`],
    ['cov', c.cov, `coverage ${percent(c.cov)}`],
  ] : []
  const counts = items.filter(([, n]) => n > 0).map(([id, , text]) => ({ id, text, bright: now - (c!.changed[id] ?? 0) < BRIGHT_MS }))
  const where = await threadInFront($)
  if (!left.length && !counts.length && !where) return null
  const fit = fitBar({ label: where ?? 'thimble', left, counts }, w) as { label: string; left: BarSeg[]; counts: { id: string; text: string; bright: boolean }[]; cut: boolean }
  const label = fit.label ? [Text({ key: 'bar-label', color: FOCUS[theme], underline: !where, children: fit.label }), Text({ key: 'bar-gap', children: '  ' })] : []
  const segText = (g: BarSeg, i: number) => [
    ...(i ? [Text({ key: `ks${i}`, dimColor: true, children: ' · ' })] : []),
    ...(g.tone ? [Text({ key: `kt${i}`, color: g.tone, children: g.words })] : [
      ...(g.key ? [Text({ key: `kk${i}`, ...(g.color && g.wordsColor ? { color: g.color } : {}), children: g.key })] : []),
      ...(g.words ? [Text({ key: `kw${i}`, ...(g.wordsColor ? { color: g.wordsColor } : { dimColor: true }), children: `${g.key ? ' ' : ''}${g.words}` })] : []),
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

/** A key pressed while the prompt is empty: the box as it should stand when the shell took the key, or null to let
 *  it through. */
async function emptyPromptKey($: Engine, e: { key?: { key: string; ctrl?: true; meta?: true }; text: string; cursor: number; inputText: string }): Promise<{ text: string; cursor: number } | null> {
  const key = e.key
  if (!key || key.ctrl || key.meta || e.text !== '') {
    keyOpened = null
    // typing while a replay runs: the whole graph at once (the program's any-key), and the key types
    if (key && !key.ctrl && !key.meta && (await $.state.get(CLAIMPANE)).value && (await paneState($, 'claims')).replay) await paneFire($, 'claims', {}, { type: 'key', key: key.key })
    return null
  }
  // the open detail takes its own keys (detail.tsx), and a letter there types the question for the card's thread
  if (detailIsOpen()) return null
  const k = key.key
  const now = await $.clock.now()
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
  const verbs = await rowVerbs($)
  const consume = { text: e.text, cursor: e.cursor }
  // a letter typed straight after a card's own key: that key began a word; the card goes back to where it was
  const keyed = cardKeyed
  cardKeyed = null
  if (keyed && now - keyed.at < 700 && /^\p{L}$/u.test(k)) {
    await writeCardState($, keyed.ref.root, keyed.ref.id, { state: keyed.undo?.state ?? {}, region: keyed.undo?.region ?? null }, 'terminal')
    return { text: `${keyed.key}${e.inputText}`, cursor: keyed.key.length + e.inputText.length }
  }
  // the Claims pane open: the keys a focused pane does not take come through here (its own are the arrow keys, ↵ and
  // esc): r replays the graph, and any key stops a replay; c (the verb key, below) closes the pane
  // the Claims pane open: the keys a focused pane does not take come through here (its own are the arrow keys, ↵ and
  // esc) and go to its program (r replays, any key stops a replay); c (the verb key, below) closes the pane
  if ((await $.state.get(CLAIMPANE)).value) {
    const opened = keyOpened
    keyOpened = null
    const replaying = !!(await paneState($, 'claims')).replay
    // a letter typed straight after r: the r was the start of a word (a question about the claim the ring is on)
    if (replaying && opened?.key === 'r' && now - opened.at < 700 && /^\S$/.test(k)) {
      await paneFire($, 'claims', {}, { type: 'key', key: k })
      return { text: `r${e.inputText}`, cursor: 1 + e.inputText.length }
    }
    if (k !== 'c' && (await paneFire($, 'claims', {}, { type: 'key', key: k }))) {
      if (k === 'r' && !replaying) keyOpened = { key: 'r', at: now }
      return consume
    }
  }
  // the squeeze chips open under a message: their program's keys first (panes/chips.js: 1-9 pick, < > change, + a
  // stretch, 0 original, s done); a key it asks to type with (the + of a stretch) goes into the prompt
  if (pick && pick.verb === 's' && !tray) {
    typedKey = k
    const taken = await paneFire($, 'chips', { row: pick.row }, { type: 'key', key: k })
    const typed = typedKey === null
    typedKey = null
    if (taken) { keyOpened = null; return typed ? null : consume }
  }
  // the tray open: its program's keys (panes/tray.js: 1 ask, 2–9 open a citation in it, 0 back, ] [ step); a letter
  // types the question for the mark's thread
  if (tray) {
    keyOpened = null
    if (k === 'backspace' && !tray.asking) return (await paneFire($, 'tray', {}, keyEvent('0'))) ? consume : null
    if (k.length === 1 && (await paneFire($, 'tray', {}, keyEvent(k)))) return consume
    return null
  }
  // v's line open under a message: the proposals program's keys (1–9 pick, 0 close)
  if (pick && pick.verb !== 's') {
    if (k === 'backspace' || /^[0-9]$/.test(k)) {
      keyOpened = null
      if (await paneFire($, 'proposals', { row: pick.row, verb: pick.verb }, keyEvent(k === 'backspace' ? '0' : k))) return consume
      if (/^[0-9]$/.test(k)) return null
    }
  }
  // a card with the focus: its own keys win over the verbs (the bar names them); 1 opens its detail, ] [ step on, 0 and
  // ⌫ give the keys back; a key it does not take gives the keys back and types
  const cf = (await $.state.get(CARDFOCUS)).value as (ObjRef & { row: string }) | null
  if (cf && !pick) {
    keyOpened = null
    if (k === '0' || k === 'backspace') { await setCardFocus($, null); return consume }
    if (k === '1') { await setCardFocus($, null); await openDetail($, cf); return consume }
    if (k === ']' || k === '[') { await stepMark($, k === ']' ? 1 : -1); return consume }
    const d = await inlineDrawing($, cf)
    const own = d ? cardTakesKey(d, k) : null
    if (own && !(own in hostKeys('inline', 'terminal'))) {
      const before = await readCardState($, cf.root, cf.id)
      await inlineCardAct($, cf, { type: 'key', key: own })
      cardKeyed = { key: k, at: now, ref: cf, undo: before }
      return consume
    }
    await setCardFocus($, null)
    return null
  }
  if (k === ']' || k === '[') {
    keyOpened = null
    await setPick($, null)
    await stepMark($, k === ']' ? 1 : -1)
    return consume
  }
  if (k === '0' || k === 'backspace') {
    keyOpened = null
    if (pick) { await setPick($, null); return consume }
    return null
  }
  if (/^[1-9]$/.test(k)) {
    keyOpened = null
    // 1 under a card: its detail view (the bar says `1 open detail`)
    if (k === '1') {
      const ref = await focusedCard($)
      if (ref) { await openDetail($, ref); return consume }
    }
    return null
  }
  // at rest the verbs win: a card's own keys reach it once it has the focus (] or its detail)
  if (k.length === 1 && verbs.some(v => v.key === k)) {
    const row = await actingRow($)
    if (row) {
      await pressRowVerb($, row, k)
      keyOpened = { key: k, at: now }
      return consume
    }
  }
  // o: this session in the browser, at the message the keys act on (browser mode only; `o browser` on the verb row)
  if (k === 'o' && browserFlag && !(pick && keyOpened && now - keyOpened.at < 700)) {
    keyOpened = null
    if (pick) await setPick($, null)
    const row = await actingRow($)
    // from the Claims pane: the graph in the browser, on the claim the ring is on here
    const claims = (await $.state.get(CLAIMPANE)).value ? { view: 'claims', claim: String((await paneState($, 'claims')).hover || '') || null } : {}
    $.clock.after(0, () => { void openBrowser($, { row, ...claims }).then(said => $.ui.toast(said)) })
    return consume
  }
  if (pick && k.length === 1) {
    await setPick($, null)
    const opened = keyOpened
    keyOpened = null
    // typed straight after the verb key: the letter was the start of a word
    if (opened && now - opened.at < 700) return { text: `${opened.key}${e.inputText}`, cursor: opened.key.length + e.inputText.length }
  }
  keyOpened = null
  return null
}

// ------------------------------------------------------------------------------------------------ drawing

/** The one quiet row under an object while a verb runs on it (`map…`); nothing at rest. Its keys (`1 open detail`)
 *  are in the hint line under the prompt, and the card the keys act on shows it by its frame. */
function runningRow(els: Any, said: Said | null) {
  return said?.running ? els.Text({ dimColor: true, children: `${said.verb}…` }) : null
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
  const got = await cardEvent($, o, { ...ref, region, ex: 0, all: false, state: kept?.state || {} } as Sel, { ...event, ...(region && !event.region ? { region } : {}) }, { w: inlineCols, h: 24, browser: browserFlag }, 'inline')
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
  if (p.error || !p.grid) return `The person cannot see ${refText(ref)}: ${p.error || 'it drew nothing'}. Fix it and save it again under the same name; the new version takes its place.`
  const d = p.drawing
  const parts = selectable(p.grid)
  const lines = [`${refText(ref)} is drawn for the person under your reply: ${p.grid.h} rows by ${p.grid.w} columns, ${parts.length} part${parts.length === 1 ? '' : 's'} they can select.`]
  if (d.error) lines.push(`Its program failed: ${d.error.name}: ${d.error.message}${d.error.line ? ` (line ${d.error.line})` : ''}. They see the error in its place. Fix the program and save it again under the same name now; the new version takes its place under your reply.`)
  if (p.check?.line) lines.push(p.check.line)
  for (const w of (d.warnings || []).slice(0, 5)) lines.push(`Warning: ${w}`)
  const empty = Object.entries(d.examples || {}).filter(([, x]: [string, Any]) => !x?.records?.length).map(([id]) => id)
  if (empty.length) lines.push(`${empty.length} example set${empty.length === 1 ? ' has' : 's have'} no records, so the person sees none for ${empty.length === 1 ? 'it' : 'them'}: ${empty.slice(0, 4).join(', ')}${empty.length > 4 ? ', …' : ''}.`)
  const bare = parts.filter((r: Any) => !regionRefs(p.object, d, r.id).refs.length && !recordRefs(d, r.id).length)
  if (bare.length) lines.push(`${bare.length} of ${parts.length} parts name no ref and match no data row, so selecting one shows no source rows: ${bare.slice(0, 4).map((r: Any) => r.id).join(', ')}${bare.length > 4 ? ', …' : ''}.`)
  return lines.join('\n')
}

/** The words a /verb run leaves in the transcript and for Claude. */
function ranText(r: Ran): string {
  if (r.error) return `${r.verb}: ${r.error}`
  const lines = [r.text || `${r.verb} ran${r.on ? ' on ' + r.on : ''}.`]
  if (r.saved) lines.push(`It shows ${refText(r.saved)}.`)
  if (r.ask) lines.push('It asked Claude to do the rest.')
  return lines.join('\n')
}

/** "<id>[@v] [region]" → the object and region, the id matched as the kernel does (with or without its number). */
async function parseTarget($: Engine, words: string[]): Promise<{ ref: ObjRef | null; region: string | null; problem?: string }> {
  const [first, region] = words
  const sel = (await $.state.get(SEL)).value
  const last = (await $.state.get(LAST)).value
  if (!first) {
    const ref = sel && !sel.cite ? sel : last
    return ref ? { ref: { id: ref.id, v: ref.v, root: ref.root }, region: sel && ref === sel ? sel.region : null } : { ref: null, region: null, problem: 'no object yet' }
  }
  const m = /^([^@\s]+)(?:@(\d+))?$/.exec(first)
  if (!m || !m[1] || !ID.test(m[1])) return { ref: null, region: null, problem: `"${first}" is not an object id` }
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
  if (!root) return { ref: null, region: null, problem: `no object ${first} here` }
  return { ref: await withVersion($, { id, v: m[2] ? Number(m[2]) : null, root }), region: region && REGION.test(region) ? region : null }
}

/** /verb's words after the verb: an object and a region when they name one, and the rest as the verb's own words
 *  (`/verb squeeze fuller` moves the open squeeze). */
async function verbTarget($: Engine, rest: string[]): Promise<{ ref: ObjRef | null; region: string | null; args: string; problem?: string }> {
  const t = await parseTarget($, rest.slice(0, 1))
  if (rest.length && t.ref) {
    const p = await prepared($, t.ref, 96)
    const region = rest[1] && p.drawing && regionMeta(p.drawing, rest[1]) ? rest[1] : null
    return { ref: t.ref, region, args: rest.slice(region ? 2 : 1).join(' ') }
  }
  const here = await parseTarget($, [])
  return { ref: here.ref, region: here.region, args: rest.join(' '), problem: here.problem }
}

// ------------------------------------------------------------------------------------------------ hooks

// ------------------------------------------------------------------------------------------------ what panes read and do
// The panes (shell/panes.ts) are programs on the card runtime: these are the stores they read by name, the folder their
// state is kept in, and the actions their programs ask for with k.do and k.want.

/** The session's folder and id, where a pane's state is kept (thimble/panes/<session>/). */
export async function paneWhere($: Engine): Promise<{ root: string | null; session: string }> {
  return { root: await rootHere($), session: String(await $.session.id()) }
}

/** One store a pane reads: `claims`, `index` (the session's rows in order), `record` (record:<row>) and the rest. */
export async function paneStore($: Engine, kind: string, arg: string): Promise<unknown> {
  switch (kind) {
    case 'claims': return claimsStore($)
    case 'index': return (await msgFilesNow($)).index.map(x => ({ row: String(x.row), kind: x.kind }))
    case 'record': return arg ? await recordNow($, arg) : null
    // the squeeze's own state of a message (a stretch being typed, a call running, a failure): the terminal's alone
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
  // where a card's values come from: its sources, rows, labels and the files read (the from line)
  if (typeof request?.facts === 'string' && ID.test(request.facts) && root) {
    const dir = $.plugin.root.replace(/\/+$/, '')
    let cov: Any = null
    try {
      const r = await $.process.run([`${dir}/bin/lean`, 'coverage', request.facts, '--json'], { cwd: root, env: await leanEnv($, root), timeoutMs: 60000 })
      cov = JSON.parse(r.stdout)
    } catch {
      cov = null
    }
    return fromFacts(await loadObject($, { id: request.facts, v: null, root }), cov)
  }
  return { error: 'the terminal cannot read that' }
}

/** The key the chips' program is answering now, set while it runs: an input it asks for with the key's own letter
 *  (the + of a stretch) leaves the key in the prompt (null here then). */
let typedKey: string | null = null
/** What the last stretch made says, for the prompt's drop line. */
let stretchSaid: string | null = null

/** What the squeeze chips' program asks for: a rewrite at levels, the original, a stretch, the prompt for a stretch's
 *  ends, a line said, or closing the chips. */
async function chipsAction($: Engine, row: string, a: Record<string, unknown>): Promise<string | boolean | void> {
  const name = String(a.do || '')
  if (!row || !(await recordNow($, row))) return '× That message is not in this session, so the chips cannot change it. Press s under a message here.'
  if (name === 'squeeze') {
    if (a.reset === true) { void sqSetLevels($, row, {}); return }
    if (typeof a.stretch === 'string') {
      const r = await sqAddStretch($, row, a.stretch)
      stretchSaid = r.said ?? null
      return r.problem ? `× ${r.problem}` : undefined
    }
    if (a.at && typeof a.at === 'object') {
      const at: Record<string, number> = {}
      for (const [k, v] of Object.entries(a.at as Record<string, unknown>)) if (Number.isInteger(v)) at[k] = v as number
      void sqSetLevels($, row, at)
      return
    }
    return '× The chips asked for a squeeze with no levels.'
  }
  if (name === 'input') {
    await sqStartStretch($, row)
    // pressed as the + key, the + is typed into the prompt by the key itself; pressed with the pointer, it is put there
    if (typedKey === '+') typedKey = null
    else await $.prompt.fill({ text: '+', mode: 'replace' })
    return
  }
  if (name === 'close') {
    await sqStopStretch($, row)
    await setPick($, null)
    return
  }
  if (name === 'say') return typeof a.text === 'string' ? a.text : undefined
  return false
}

/** An action a pane's program asked for (k.do). False: the terminal has none by that name. */
export async function paneAction($: Engine, pane: string, _args: Record<string, unknown>, a: Record<string, unknown>): Promise<string | boolean | void> {
  const name = String(a.do || '')
  if (pane === 'claims' && name === 'close') { await closeClaims($); return }
  if (pane === 'tray') {
    if (name === 'close') { await setTray($, null); return }
    if (name === 'step') { await stepMark($, Number(a.dir) < 0 ? -1 : 1); return }
    if (name === 'ask' && typeof a.text === 'string') {
      // a question typed in the browser's tray: the mark's side thread, as one typed here would be
      const t = await trayScope($)
      if (!t) return '× The tray has no mark open to ask about.'
      const r = await askThread($, { text: a.text, root: (await rootHere($)) || String(await $.session.cwd()), scope: t.scope as ThreadScope, refs: t.refs, card: null })
      return r.problem ? `× ${r.problem}` : undefined
    }
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
  browserFlag = (options as Any)?.browser === true

  // the side threads and the card detail first: their hooks sit outside the shell's, so a question for a thread and a
  // thread's report never reach the shell's prompt hooks (or main)
  registerThreads(on, options)
  registerDetail(on)

  // /config turns browser mode on or off: on, /browser is there and `o` shows; off, the server ends
  on('config.set', { key: /^thimble-lean(@[\w.-]+)?\.browser$/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (!(r as Any)?.deny) await setBrowser($, (r as Any)?.value === true || ((r as Any)?.value === undefined && e.value === true))
    } catch {
      // the setting is stored whatever the shell makes of it
    }
    return r
  })

  // (a matcher, as the kernel's module hooks session.start without one and the engine takes one bare hook per event)
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'obj', description: browserFlag ? 'Open an object in the detail view: /obj [object] [region] · /obj browser opens it in the browser' : 'Open an object in the detail view: /obj [object] [region]', argumentHint: '[object] [region]', immediate: true })
      await $.command.register({ name: 'verb', description: 'Run a verb on an object: /verb <verb> [object] [region] [words] · /verb ? lists the verbs', argumentHint: '<verb> [object] [region] [words]' })
      if (browserFlag) await registerBrowserCommand($)
      const row = (await $.config.list()).find(x => x.key === 'theme')
      theme = String(row?.value ?? 'dark').startsWith('light') ? 'light' : 'dark'
    } catch {
      // the shell draws nothing it cannot; the session goes on
    }
    try {
      // a resumed session: its objects drawn under the same rows again, and its earlier saves never placed twice
      await restoreShown($)
      await newSaves($)
    } catch {
      // a session that cannot read its placements draws its new objects only
    }
    try {
      // the verbs of the message row (verbs/*/verb.json with "row": true), and a resumed session's message index
      await loadRowVerbs($)
      await msgFilesNow($)
      $.clock.after(0, () => { void recount($, { coverage: true }) })
    } catch (err) {
      failed($, 'thimble: the verb row could not read its verbs', err, 'v and s still work; start the session again to get the rest')
    }
    return r
  })

  // a turn of main's: the objects it saved, and its last text row, under which they are drawn
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turn = { unplaced: [], lastRow: '', calls: [], placed: [], rows: [], oriented: 0 }
      // a new turn: the keys act on its answer again, and a verb's open line closes
      try {
        await $.state.set(SELROW, null)
        await setPick($, null)
        await setCardFocus($, null)
      } catch {
        // the turn starts whatever the shell makes of it
      }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    let notes: string[] = []
    try {
      const input = e as unknown as { command?: string; agentId?: string; tool_use_id?: string }
      const text = typeof r.text === 'string' ? r.text : typeof r.result === 'string' ? r.result : ''
      // the corpus orientation's claims went into the store: the list reads it again, and c lights under the answer
      if (r.deny === undefined && !r.isError && !input.agentId && /\blean\s+verb\s+claims\s+save\b/.test(String(input.command))) {
        const m = /(\d+) new claims? from the corpus/.exec(text)
        if (m && turn) turn.oriented += Number(m[1])
        await reloadClaims($)
      }
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
        if (turn.unplaced.length) await placeTurn($, rowKey(e.uuid))
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
          await indexRow($, { row, kind: 'user', at, text, ...(scope ? { scope } : {}) })
          await flushMessages($)
        } else if (e.door === 'response' && msg.type === 'assistant' && text.trim()) {
          // one of Claude's messages: its record, with the marks in its words and each sparkline's values
          const made = newRecord({ row, session: String(await $.session.id()), text, at }) as MsgRecord
          made.uuid = String(stored.uuid)
          made.objects = (((await $.state.get({ ...UNDER, id: row })).value ?? []) as Placed[]).map(x => x.id)
          const rec = await withSparkValues($, made)
          const rows = ((await $.state.get(MSGROWS)).value ?? []) as string[]
          if (!rows.includes(row)) await $.state.set(MSGROWS, [...rows, row])
          await indexRow($, { row, kind: 'assistant', at })
          await saveRecord($, rec)
          $.clock.after(0, () => { void recount($) })
          // the turn's messages, where its claims are found
          if (turn && !turn.rows.includes(row)) turn.rows.push(row)
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
        const at = turn.lastRow ? rowKey(turn.lastRow) : turn.calls.at(-1)
        if (at) await placeTurn($, at)
      }
    } catch {
      // nothing drawn is better than a turn that does not end
    }
    try {
      // the turn's answer: its last words, under which the verb row is drawn
      if (e.agentId === undefined && turn?.lastRow) {
        const row = rowKey(turn.lastRow)
        const rec = await recordNow($, row)
        if (rec && !rec.final) await saveRecord($, { ...rec, final: true })
        await $.state.set(ANSWER, row)
        // a message taller than the screen arrives squeezed (one call, outside the turn's end)
        $.clock.after(0, () => { void sqArrive($, row).catch(() => undefined) })
        // the thimble line: what this turn read, saved and cited
        $.clock.after(0, () => { void recount($, { coverage: true }) })
        // claims the corpus orientation saved in this turn light c under its answer
        if (turn.oriented) await setVerb($, row, 'c', { lit: true, note: `${turn.oriented} claims from the corpus` })
      }
    } catch {
      // a turn with no verb row is better than one that does not end
    }
    try {
      // the turn's prompt and messages, for the observer's claims
      if (e.agentId === undefined && turn) await $.state.set({ ...TURNS, id: e.turnId }, await turnOf($, turn.rows))
    } catch {
      // the claims of this turn are then read from its answer alone
    }
    if (e.agentId === undefined) turn = null
    return done
  })

  // one of Claude's messages drawn from its record: its marks inline (a citation underlined, a gloss on a teal fill, a
  // sparkline in place, each a press that opens the tray), while a squeeze rewrites it its new text writing in from the
  // top, the line a verb opened under it (squeeze's chips, v's proposals), then the objects its turn saved. Its verbs
  // and keys are in the thimble line above the prompt. A message with none of these is Claude Code's own drawing.
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
      await $.state.get(WEB)
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
      if (!rec.marks.length && !open && !list.length && rec.shown == null && !busy && n == null) return next(e)
      const tray = (await $.state.get(TRAY)).value as Tray | null
      await $.state.get(CARDFOCUS)
      const base = trayBase(tray) as TrayFrame | null
      const cols = Math.max(20, (e.viewport?.columns ?? 100) - 3)
      const parts: Any[] = []
      parts.push(rec.marks.length || rec.shown != null || busy || n != null
        ? messageEl(els, { rec: shownNow, key: `msg-${at}`, cols, first: !!e.props.isFirstOfReply, theme, focus: base && base.row === at ? base.i ?? null : null, onMark: (i: number) => openMark($, at, i, rec), dim: !!busy, lead: busy })
        : await next(e))
      if (open === 's') {
        // the chips under the message (panes/chips.js, the browser draws the same program); their keys are in the
        // thimble line
        parts.push(Box({ marginLeft: 2, marginTop: 1, children: [await paneEl($, e, 'chips', { row: at }, { w: Math.max(30, cols - 2), h: 3 })] }))
      } else if (open) {
        // v's proposals (panes/proposals.js, the browser draws the same program); their keys are in the thimble line
        parts.push(Box({ key: `vl-${at}`, marginLeft: 2, marginTop: 1, children: [await paneEl($, e, 'proposals', { row: at, verb: open }, { w: Math.max(30, cols - 2), h: 3 })] }))
      }
      if (list.length) {
        // the card with the focus (] reached it) has its frame in the keys' color; at rest the newest card under the
        // message the keys act on (the one 1 opens) has it faint
        const cf = (await $.state.get(CARDFOCUS)).value as (ObjRef & { row: string }) | null
        const rest = !tray && !pick && !cf && (await actingRow($)) === at
        parts.push(...(await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `row-${at}-${i}`, at, cf && cf.row === at && cf.id === ref.id && cf.root === ref.root ? 'focus' : rest && i === list.length - 1 ? 'rest' : null)))))
      }
      return parts.length === 1 ? parts[0] : Box({ flexDirection: 'column', children: parts })
    } catch {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })

  // the band above the prompt: the tray when it is open (one small panel, a fixed number of rows, so the transcript
  // scrolls above it; it shows the card on top of its stack: a citation's source card or a gloss's explainer card),
  // else the observer's line when one is open; then the thimble line, the one bar: what the keys do now at its left,
  // the session's counts at its right. While Claude works, a blank row stands between its spinner and the bar; at rest
  // there is none, so Claude Code's [-] never stands alone on a blank row.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const els = $.ui.resolve(e) as Any
      const { Box, Text } = els
      if (!(await $.state.get(CLAIMPANE)).value) noteViewport(e.viewport)
      const bw = Math.max(20, (e.props.bodyColumns ?? 100) - 1)
      const line = await barEl($, els, bw, !!e.props.isWorking)
      const tray = (await $.state.get(TRAY)).value as Tray | null
      const above = trayTop(tray) ? await trayBand($, e, tray!) : null
      // the observer's line (observer.ts, inside this hook): drawn by its own hook when it has one open
      const own = above ?? ((await $.state.get(LINE)).value ? await next(e) : null)
      if (!line) return own ?? next(e)
      const rows: Any[] = []
      if (own) rows.push(own, Text({ key: 'bar-gap', children: ' ' }))
      else if (e.props.isWorking) rows.push(Text({ key: 'bar-gap', children: ' ' }))
      rows.push(line)
      return Box({ flexDirection: 'column', children: rows })
    } catch {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })

  // keys while the prompt is empty: v and s open their line under the message the keys act on, and c the claims list;
  // ] and [ move through the marks, opening the tray (through the claims while the list or a claim is open); a digit
  // picks in the open line, opens a cluster of the list, or opens a mark or a source inside the card; 0 closes the
  // card, then the line or list. Claude Code hands a plugin only the keys that edit the prompt (tab, ↵, esc and a ⌫ with nothing
  // to delete stay its own), so these are the keys. A verb key that began a word being typed (`visualize …`, `so …`)
  // gives its letter back to the prompt. Keys are read one at a time, in the order pressed.
  on('prompt.edit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    const mine = keyChain.then(() => emptyPromptKey($, e)).catch(() => null)
    keyChain = mine
    const r = await mine
    if (r) return r
    const out = await next(e)
    try {
      const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
      const dec = await sqAfterEdit($, pick?.verb === 's' ? pick.row : null, out.text, theme)
      if (dec) return { ...out, decorations: [...(out.decorations ?? []), ...dec] }
    } catch {
      // the edit lands whatever the chips make of it
    }
    return out
  }).catch(($, e, next) => next(e))

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
    if (e.command) return next(e)
    try {
      const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
      if (pick?.verb === 's' && !e.isMeta && (e.origin as { kind?: string } | undefined)?.kind !== 'plugin' && /^\s*\+/.test(String(e.text || ''))) {
        // the two ends of a stretch, typed after the chips' +: the chips' program makes it (no prompt for Claude)
        await paneFire($, 'chips', { row: pick.row }, { type: 'stretch', text: String(e.text) })
        const said = stretchSaid
        stretchSaid = null
        $.clock.after(50, () => { void $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined) })
        return { drop: said || 'stretch' }
      }
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
      const notes = ((await $.state.get(NOTES)).value ?? []) as string[]
      if (notes.length) {
        context.push(notes.join('\n'))
        await $.state.set(NOTES, [])
      }
      const sel = (await $.state.get(SEL)).value
      // a question asked with the tray open is about its card's mark (CONTRACT 6: a prompt to main carrying the scope)
      // a source card in the tray first, then the claim the Claims pane has the ring on
      const mine = !e.isMeta && (e.origin as { kind?: string } | undefined)?.kind !== 'plugin'
      const scoped = mine ? (await trayScope($)) ?? (await claimScope($)) : null
      await setPick($, null)
      const open = !scoped && !e.isMeta && (await $.ui.panes()).some(x => x.id === PANE && x.isPlaced)
      if (scoped) {
        context.push(scoped.context)
        pendingAsk = { text: e.text, about: { id: scoped.label, v: null, region: null, label: scoped.label }, scope: scoped.scope }
        await closeTray($)
      } else if (sel && open && sel.cite) {
        pendingAsk = { text: e.text, about: { id: sel.cite, v: null, region: null, label: citeLabels.get(sel.cite) || sel.cite } }
        context.push(`The person asked this with a citation of yours open in the detail view: ${citeLabels.get(sel.cite) || ''} (${sel.cite}). "This" may mean that value. \`lean resolve ${sel.cite}\` shows its rows.`)
      } else if (sel && open && (e.origin as { kind?: string } | undefined)?.kind !== 'plugin') {
        const p = await prepared($, sel, 96, sel.state)
        const meta = sel.region ? regionMeta(p.drawing, sel.region) : null
        const { refs } = await refsOf($, sel)
        const label = sel.region ? String(meta?.label || sel.region) : ''
        const knobs = stateKey(sel.state) ? ` Its knobs are at ${Object.entries(sel.state || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}.` : ''
        context.push([
          `The person asked this with an object open in the detail view: ${p.object?.id}@${p.object?.version} "${p.object?.title || ''}" (${sel.root}/thimble/objects/${sel.id}.json).${knobs}`,
          sel.region ? `They had selected its part ${sel.region} ("${label}"). "This", "here" or "it" may mean that part.` : 'No part of it was selected.',
          refs.length ? `${sel.region ? 'That part' : 'Its words'} rest${sel.region ? 's' : ''} on ${refs.slice(0, 3).join(', ')}; \`lean resolve <ref>\` opens the rows, \`lean list ${sel.id}\` the object's lineage.` : `\`lean list ${sel.id}\` shows the object's lineage.`,
        ].join('\n'))
        pendingAsk = { text: e.text, about: { id: sel.id, v: p.object?.version ?? sel.v, region: sel.region, label } }
      }
    } catch {
      // a prompt goes in as typed when the shell cannot say what it carries
    }
    return context.length ? next({ ...e, context: [...(e.context ?? []), ...context] }) : next(e)
  }).catch(($, e, next) => next(e))

  // /obj [object] [region] · /obj browser [object] [region]
  on('command.run', { command: 'obj' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const toWeb = words[0] === 'browser'
    const t = await parseTarget($, toWeb ? words.slice(1) : words)
    if (!t.ref) return { text: `Nothing to open: ${t.problem}. An object Claude saves with \`lean save\` shows under its reply.` }
    if (toWeb) {
      const cur = (await $.state.get(SEL)).value
      const sel: Sel = cur && cur.id === t.ref.id && !words[2] ? cur : { ...t.ref, region: t.region, ex: 0, all: false }
      return { text: await openBrowser($, { id: sel.id, v: sel.v, region: sel.region, root: sel.root }) }
    }
    await openDetail($, t.ref, t.region)
    return {}
  })

  // /browser: this session's mirror page · /browser <object> [region]: a card's detail page (browser mode only)
  on('command.run', { command: 'browser' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (!browserFlag) return { text: await openBrowser($) }
    if (!words.length) return { text: await openBrowser($) }
    const t = await parseTarget($, words)
    if (!t.ref) return { text: `Nothing to open: ${t.problem}. /browser alone opens this session.` }
    return { text: await openBrowser($, { id: t.ref.id, v: t.ref.v, region: t.region, root: t.ref.root }) }
  })

  // /verb <verb> [object] [region] [words] · /verb ? (or /verb alone) lists the verbs for the object
  on('command.run', { command: 'verb' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (!word || word === '?' || word === 'all') {
      const t = await parseTarget($, rest)
      if (!t.ref) return { text: 'No object yet: the verbs work on an object Claude saved.' }
      const verbs = await rankedVerbs($, t.ref, await verbsOf($, t.ref))
      const lines = verbs.map(v => `${v.picked ? '●' : ' '} ${v.key || ' '}  ${v.name.padEnd(10)} ${v.phrase || v.line}`)
      return { text: verbs.length ? `The verbs for ${refText(t.ref)} (● picked for it):\n${lines.join('\n')}` : 'No verbs yet: a verb is a folder in lean/verbs/.' }
    }
    const t = await verbTarget($, rest)
    if (!t.ref) return { text: `No object to run ${word} on: ${t.problem}.` }
    const sel = (await $.state.get(SEL)).value
    const ran = await execVerb($, word, t.ref, t.region, (e.presentation?.columns ?? 100) - 4, { args: t.args, state: sel && sel.id === t.ref.id ? sel.state : null })
    const at = `cmd|${e.args.trim().slice(0, 300)}`
    if (ran.saved) await setUnder($, at, [ran.saved])
    if (ran.ask) {
      const request = ran.ask
      const what = ran.on || refText(t.ref)
      // the request is a turn of its own, which can start only once this command is done
      $.clock.after(50, () => { void ask($, request, ran.verb, what) })
    }
    return { text: ranText(ran), context: [ranNote(ran)] }
  })

  // a verb's row: its words, then the object it made, drawn with its own hint row
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    try {
      if (e.props.command !== 'verb' || e.props.isErrored) return next(e)
      const at = `cmd|${e.props.args.trim().slice(0, 300)}`
      const list = ((await $.state.get({ ...UNDER, id: at })).value ?? []) as ObjRef[]
      if (!list.length) return next(e)
      const { Box } = $.ui.resolve(e) as Any
      const own = await next(e)
      const drawn = await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `verb-${e.requestId.slice(-10)}-${i}`, at)))
      return Box({ flexDirection: 'column', children: [own, ...drawn] })
    } catch (err) {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
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

  // the Claims pane (c), and its close by the person (esc, the close mark)
  on('ui.render', { component: 'Pane', requestId: CPANE }, async ($, e) => {
    try {
      await $.state.get(CLAIMS)
      await $.state.get(CLAIMPANE)
      return await claimsPaneNow($, e)
    } catch (err) {
      // a graph that cannot draw says so in one plain line
      return paneProblem($, e, 'The claims', err)
    }
  })
  on('ui.close', { id: CPANE }, async ($, e, next) => {
    try {
      await $.state.set(CLAIMPANE, null)
      await popFocus($, 'claims')
      paneClosed('claims')
    } catch {
      // the pane closes whatever the shell makes of it
    }
    return next(e)
  })


  // the Claims pane: the ring on a claim shows its card and its links (the detail's own ring is detail.tsx's); an
  // arrow key during a replay stops it, as any key does
  on('ui.focus', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.requestId === CPANE && !r.deny && typeof e.element === 'string' && (await $.state.get(CLAIMPANE)).value) {
        // the ring on a claim is the program's focus event (its card shows); off the claims (the close mark), none
        if (!(await paneFocus($, 'claims', {}, e.element)) && (await paneState($, 'claims')).hover) await paneFire($, 'claims', {}, { type: 'focus', region: null })
      }
    } catch {
      // the ring moves whatever the shell makes of it
    }
    return r
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetShell(): void {
  objects.clear()
  preps.clear()
  pending.clear()
  turn = null
  pendingAsk = null
  server = null
  serverStarting = null
  serverStream = null
  shown = null
  msgFiles = null
  keyOpened = null
  keyChain = Promise.resolve()
  graphLayout = null
}

export { isRef }
