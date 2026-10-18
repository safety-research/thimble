// The shell of lean thimble: it puts the kernel's objects in front of the person, in the terminal and the browser.
//
//   inline     when Claude saves an object (`lean save` in Bash), the object is drawn under the turn's last reply, in
//              cells (draw/term.js, draw/paint.js), with one quiet row under it: the 2-3 verbs picked for it, `? all`,
//              and `open`. A click on a verb runs it, and what it makes is drawn under the same reply.
//   detail     one pane, the object's detail view: the drawing with the selected region lit, the region's cite, its
//              source rows (`lean resolve`) and its examples, the object's citations when no region is selected, its
//              knobs (j k, or a click on ◂ ▸), and every verb on its key. The chat stays live beside it: while it is
//              open, a prompt carries the object and the region to Claude, and the prompt's row says so.
//   verbs      found by folder (lean/verbs/<name>/, shell/node/registry.mjs) and run in a Node child
//              (shell/node/verb.mjs) by a press, a key or /verb. What a verb makes is drawn where the person pressed;
//              what it says for Claude goes with the next prompt; a call it makes to the model is made here, with
//              $.model, and handed back to it; a request it has for Claude (`ask`) goes as a prompt, drawn as one line.
//   browser    `open in browser` starts a server on 127.0.0.1 (shell/node/serve.mjs) and opens the object's page on
//              the same selection; the page's "back to terminal" brings its selection back to the detail view.
//   resume     where each object is drawn is kept per session in $THIMBLE_HOME/lean/shown/<session>.json, so
//              `claude -c` and `--resume` draw the objects under the same replies again.
//
// What it never does: it registers no model tool (a plugin's tool skips the asks of Manual mode), starts no
// `claude`, and allows nothing on anyone's behalf. Everything it runs is the person's press or command, or a pure
// drawing of what Claude saved. The Node helpers run as child processes: a hooks module has no Node, and an
// object's program runs only in the drawing contract's sandbox.
import type { EngineInterface, Register } from 'claude-code'

import type { MsgRecord, ObjRef, Ran, Said, Sel, Tray, TrayFrame } from '../types'
import { knobOf, toHash, turn as turnKnob } from '../draw/handoff.js'
import { gridText, renderTerm } from '../draw/term.js'
import { paintRegions, regionOfKey, selectable } from './cells'
import { cardKind, explainerCard, sourceCard } from './cards.js'
import { newRecord, placeMarks, recordFor, remark, seriesRef, shownOf, withObserver } from './message.js'
import { chainWords, isRef, objectRefs, rankRow, recordRefs, regionMeta, regionRefs } from './object.js'
import { back as trayBack, base as trayBase, open as trayOpen, order as markOrder, push as trayPush, step as trayStep, top as trayTop } from './tray.js'
import { messageEl, trayEl, verbLineEl, verbRowEl } from './view'
import type { RowVerb } from './view'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Verb = { key: string | null; name: string; line: string; phrase: string | null; picked: boolean; hint?: string | null; extra?: Record<string, unknown> }
type Prepared = { object: Any; drawing: Any; grid: Any; verbs: Verb[]; problems: string[]; error?: string }
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
const CARDREADY = { plugin: 'thimble-lean', key: 'cardready' } as const
const RUNNING = { plugin: 'thimble-lean', key: 'running' } as const
const ROWVERBS = { plugin: 'thimble-lean', key: 'rowverbs' } as const

const ID =/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/
const REGION = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,95}$/
const SAVED = /^saved (\S+) v(\d+): \S+/gm
const rowKey = (id: string) => String(id).slice(0, 24)
const refText = (r: { id: string; v: number | null }) => (r.v != null ? `${r.id}@${r.v}` : r.id)
const cut = (s: string, n: number) => ([...s].length <= n ? s : [...s].slice(0, Math.max(0, n - 1)).join('') + '…')
const fmtN = (x: unknown) => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x))
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'
const stateKey = (state?: Record<string, unknown> | null) => (state && Object.keys(state).length ? JSON.stringify(state) : '')

// the module's own memory: lost on a reload, rebuilt from $.state and the object files
const objects = new Map<string, Any>()
const citeLabels = new Map<string, string>()
const preps = new Map<string, Prepared>()
const pending = new Map<string, Promise<Prepared>>()
let turn: { unplaced: ObjRef[]; lastRow: string; calls: string[]; placed: string[] } | null = null
let theme: 'dark' | 'light' = 'dark'
let pendingAsk: { text: string; about: { id: string; v: number | null; region: string | null; label: string }; scope?: Record<string, unknown> } | null = null
let server: { base: string; root: string } | null = null
let serverStarting: Promise<{ base: string } | { problem: string }> | null = null
let shown: { file: string; under: Record<string, Placed[]> } | null = null
// the message layer's memory: the records' folder and index, the tray's drawn cards, the verb key that opened a line
let msgFiles: { session: string; dir: string | null; index: Any[]; pending: Set<string>; loaded: boolean } | null = null
const cards = new Map<string, CardDrawn>()
const cardPending = new Map<string, Promise<CardDrawn>>()
let keyOpened: { key: string; at: number } | null = null
let keyChain: Promise<unknown> = Promise.resolve()
type CardDrawn = { title: string; right: string; kind: 'cite' | 'gloss' | 'spark'; grids: Any[] | null; links: { id: string; ref: string; label: string }[]; problem?: string | null }

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

async function loadObject($: Engine, ref: ObjRef): Promise<Any | null> {
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

const prepKey = (ref: ObjRef, w: number, state?: Record<string, unknown> | null, mode = 'inline') => `${ref.root}|${ref.id}|${ref.v ?? ''}|${w}|${stateKey(state)}|${mode}`

/** The object drawn at `w` columns (with the knobs at `state`), with its verbs: the program runs in a Node child, in the
 *  contract's sandbox. `mode` is where it is drawn (k.mode): 'inline' under a reply, 'detail' in the detail view, where
 *  a program may show more. Kept per object version, width, state and mode; a failed one stays failed until the module
 *  reloads. */
function prepared($: Engine, ref: ObjRef, w: number, state?: Record<string, unknown> | null, mode = 'inline'): Promise<Prepared> {
  const key = prepKey(ref, w, state, mode)
  const hit = preps.get(key)
  if (hit) return Promise.resolve(hit)
  const running = pending.get(key)
  if (running) return running
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
    const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `${dir}/shell/node/prep.mjs`], { stdin: JSON.stringify({ object, w, h: 24, state: state || undefined, mode }), timeoutMs: 30000 })
    if (r.exitCode !== 0) return { object, drawing: null, grid: null, verbs: [], problems: [], error: (r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 300) || `exit ${r.exitCode}` }
    const out = JSON.parse(r.stdout)
    return { object, drawing: out.drawing, grid: renderTerm(out.drawing, { w }), verbs: out.verbs || [], problems: out.problems || [] }
  })()
  pending.set(key, p)
  void p.then(x => { preps.set(key, x); pending.delete(key) }, () => pending.delete(key))
  return p
}

/** For a drawing hook: the object if it is ready; else null, with the work started outside the drawing (a render's
 *  dispatch may be abandoned, which would stop the child) and the drawing subscribed to its end. */
async function preparedNow($: Engine, ref: ObjRef, w: number, state?: Record<string, unknown> | null, mode = 'inline'): Promise<Prepared | null> {
  const key = prepKey(ref, w, state, mode)
  const hit = preps.get(key)
  if (hit) return hit
  await $.state.get({ ...READY, id: key })
  if (!pending.has(key)) $.clock.after(0, () => { void prepared($, ref, w, state, mode).then(() => $.state.set({ ...READY, id: key }, Date.now())) })
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
async function leanEnv($: Engine, root: string): Promise<Record<string, string>> {
  return { LEAN_ROOT: root, LEAN_SESSION: `person-${String(await $.session.id()).slice(0, 8)}` }
}

async function resolveRefs($: Engine, root: string, refs: string[]): Promise<void> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  for (const ref of refs.slice(0, 3)) {
    const at = { ...ROWS, id: `${root}|${ref}` }
    if ((await $.state.get(at)).value !== undefined) continue
    const r = await $.process.run([`${dir}/bin/lean`, 'resolve', ref, '-n', '3', '--json'], { cwd: root, env: await leanEnv($, root), timeoutMs: 60000 })
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

async function select($: Engine, sel: Sel): Promise<void> {
  await $.state.set(SEL, sel)
  const { refs } = await refsOf($, sel)
  await resolveRefs($, sel.root, refs)
}

async function openDetail($: Engine, at: ObjRef, region: string | null = null): Promise<void> {
  const ref = await withVersion($, at)
  const cur = (await $.state.get(SEL)).value
  // the knobs stay where the person turned them while it is the same object
  const state = cur && cur.id === ref.id && cur.root === ref.root ? cur.state : undefined
  await select($, { id: ref.id, v: ref.v, root: ref.root, region, ex: 0, all: false, ...(state ? { state } : {}) })
  const o = await loadObject($, ref)
  await $.ui.open({ id: PANE, title: o?.title ? cut(String(o.title), 40) : ref.id, focus: true })
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

/** A citation of Claude's words, opened in the detail view: where its value came from, down to its rows. */
async function openCite($: Engine, ref: string | null, label: string): Promise<void> {
  if (!ref) return
  const root = await rootHere($)
  if (!root) { $.ui.toast(`no thimble/ folder here to resolve ${ref}`); return }
  const last = (await $.state.get(LAST)).value
  await $.state.set(SEL, { id: last?.id ?? '', v: last?.v ?? null, root, region: null, ex: 0, all: false, cite: ref })
  citeLabels.set(ref, label)
  await $.ui.open({ id: PANE, title: 'citation', focus: true })
  await resolveRefs($, root, [ref])
}

/** One call a verb made to the model, made here: the verb's Node child has no $. */
async function modelCall($: Engine, need: { kind: string; request: Any }): Promise<unknown> {
  const req = need.request && typeof need.request === 'object' ? need.request : {}
  try {
    const r = need.kind === 'fork' ? await $.model.fork({ prompt: String(req.prompt ?? '') }) : await $.model.complete(req)
    return r ?? { isAnswered: false, reason: 'empty-reply' }
  } catch (err) {
    return { isAnswered: false, reason: 'refused', error: String((err as Error)?.message || err).slice(0, 300) }
  }
}

/** Run a verb on an object (and region): its run.mjs in a Node child (shell/node/verb.mjs), again after each call to
 *  the model it needs, with the answers so far. What it made is saved by the kernel. */
async function execVerb($: Engine, word: string, ref: ObjRef, region: string | null, cols: number, o: { state?: Record<string, unknown> | null; args?: string } = {}): Promise<Ran> {
  const p = await prepared($, ref, 96, o.state)
  const on = `${refText(ref)}${region ? ' ▸ ' + region : ''}`
  if (!p.object) return { verb: word, on, error: `no object ${refText(ref)}: ${p.error}` }
  const { refs } = region ? regionRefs(p.object, p.drawing, region) : { refs: objectRefs(p.object).map((c: Any) => c.ref) }
  const dir = $.plugin.root.replace(/\/+$/, '')
  const input = {
    object: p.object, region, regionMeta: region ? regionMeta(p.drawing, region) : null, refs, drawing: p.drawing,
    state: o.state || {}, args: o.args || '', root: ref.root, w: Math.max(40, Math.min(120, cols)),
  }
  const answers: Record<string, unknown> = {}
  let out: Any = null
  for (let round = 0; round < 8; round++) {
    const r = await $.process.run(['node', `${dir}/shell/node/verb.mjs`, 'run', word], { stdin: JSON.stringify({ ...input, answers }), cwd: ref.root, env: await leanEnv($, ref.root), timeoutMs: 600000 })
    try { out = JSON.parse(r.stdout) } catch { out = { verb: word, error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400) || `exit ${r.exitCode}` } }
    if (!out.need) break
    answers[String(out.need.key)] = await modelCall($, out.need)
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

/** After a verb ran: what it made is drawn where the person pressed (and opens in the detail view when they pressed
 *  it there), what it said goes to Claude with the next prompt, and a request for Claude goes as a prompt. */
async function settle($: Engine, ran: Ran, ref: ObjRef, at: string | null, inPane: boolean): Promise<void> {
  await $.state.set({ ...SAID, id: ref.id }, { verb: ran.verb, ...(ran.text ? { text: ran.text } : {}), ...(ran.error ? { error: ran.error } : {}) })
  if (!ran.ask) await noteForClaude($, ranNote(ran))
  else if (ran.note) await noteForClaude($, ran.note)
  if (ran.saved) {
    const where = at || ((await $.state.get({ ...WHERE, id: ref.id })).value as string | undefined) || null
    // a new version of the same object (a squeeze moved) takes its place; the same version (an explore view opened)
    // opens in the detail view, where its knobs turn
    const same = ran.saved.id === ref.id
    const unchanged = same && (ran.saved.v == null || ran.saved.v === ref.v)
    if (where && !unchanged) await place($, where, same ? ran.saved : { ...ran.saved, from: ref.id })
    if (inPane || !where || unchanged) await openDetail($, ran.saved)
  }
  if (ran.ask) void ask($, ran.ask, ran.verb, ran.on || refText(ref))
  if (ran.error) $.ui.toast(`${ran.verb}: ${cut(ran.error, 200)}`)
  else if (!ran.saved && !ran.ask && ran.text && !inPane) $.ui.toast(cut(ran.text.split('\n')[0] || '', 200))
}

/** A verb's request to Claude, as a turn the person started: its row is the person's press in a few words (`explore
 *  01-saves`), as they would type it; the request itself (with what verbs said since Claude's last reply) goes just
 *  before it as a row the person does not see, for Claude alone. */
async function ask($: Engine, request: string, verb: string, on: string): Promise<void> {
  const notes = ((await $.state.get(NOTES)).value ?? []) as string[]
  await $.state.set(NOTES, [])
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: [...notes, request].join('\n\n') }] } })
  await $.prompt.submit({ text: `${verb} ${on}`, asUser: true })
}

/** A verb the person pressed (a click under an object, a key in the detail view). It runs here, outside the press, and
 *  the hint row says so while it runs. */
function pressVerb($: Engine, verb: string, ref: ObjRef, region: string | null, at: string | null, inPane: boolean): void {
  $.clock.after(0, () => {
    void (async () => {
      const busy = (await $.state.get({ ...SAID, id: ref.id })).value
      if (busy?.running) return
      await $.state.set({ ...SAID, id: ref.id }, { verb, running: true })
      let ran: Ran
      try {
        const sel = inPane ? (await $.state.get(SEL)).value : null
        ran = await execVerb($, verb, ref, region, 96, { state: sel && sel.id === ref.id ? sel.state : null })
      } catch (err) {
        ran = { verb, on: refText(ref), error: String((err as Error)?.message || err).slice(0, 300) }
      }
      await settle($, ran, ref, at, inPane)
    })()
  })
}

// ------------------------------------------------------------------------------------------------ the browser

async function startServer($: Engine, root: string): Promise<{ base: string } | { problem: string }> {
  if (server && server.root === root) return { base: server.base }
  if (serverStarting) return serverStarting
  const dir = $.plugin.root.replace(/\/+$/, '')
  serverStarting = new Promise(resolve => {
    void (async () => {
      let buf = ''
      let ready = false
      try {
        const child = $.process.spawn({ argv: ['node', `${dir}/shell/node/serve.mjs`, '--root', root, '--lean', `${dir}/bin/lean`], env: await leanEnv($, root) })
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
              await $.state.set(WEB, { base: server.base, root })
              resolve({ base: server.base })
            } else if (msg.back) {
              await backFromBrowser($, root, msg.back)
            }
          }
        }
      } catch (err) {
        if (!ready) resolve({ problem: String((err as Error)?.message || err).slice(0, 200) })
      }
      server = null
      serverStarting = null
      if (!ready) resolve({ problem: 'the page server stopped before it was ready' })
      // a server that stopped (the module reloaded, say) starts again on the next `o`: nothing to say
      await $.state.set(WEB, {})
    })()
  })
  const r = await serverStarting
  if ('problem' in r) serverStarting = null
  return r
}

/** The page's "back to terminal": the detail view opens on the object and part the page had selected. */
async function backFromBrowser($: Engine, root: string, back: { object: string; v: number | null; region: string | null; state?: Record<string, unknown> }): Promise<void> {
  if (!ID.test(back.object)) return
  const region = back.region && REGION.test(back.region) ? back.region : null
  const ref = await withVersion($, { id: back.object, v: back.v ?? null, root })
  const state = back.state && typeof back.state === 'object' && !Array.isArray(back.state) ? back.state : undefined
  await select($, { id: ref.id, v: ref.v, root: ref.root, region, ex: 0, all: false, ...(state ? { state } : {}) })
  const o = await loadObject($, ref)
  await $.ui.open({ id: PANE, title: o?.title ? cut(String(o.title), 40) : ref.id })
}

async function openBrowser($: Engine, sel: Sel): Promise<string> {
  const s = await startServer($, sel.root)
  if ('problem' in s) {
    await $.state.set(WEB, { problem: s.problem })
    return `No page: ${s.problem}`
  }
  const url = `${s.base}/o/${encodeURIComponent(sel.id)}${sel.v != null ? `?v=${sel.v}` : ''}${toHash({ object: sel.id, v: sel.v ?? undefined, region: sel.region || undefined, state: sel.state })}`
  const browser = await $.env.get('BROWSER')
  const tries = browser ? [[browser, url]] : [['xdg-open', url], ['open', url]]
  for (const argv of tries) {
    const r = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => null)
    if (r && r.exitCode === 0) {
      await $.state.set(WEB, { base: s.base, root: sel.root, opened: url })
      return `Opened ${refText(sel)}${sel.region ? ' ▸ ' + sel.region : ''} in the browser.`
    }
  }
  await $.state.set(WEB, { base: s.base, root: sel.root, opened: url, problem: 'no browser opened here; open the link yourself' })
  return `No browser opened here. The page: ${url}`
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

/** The index and folder of this session, read once per load of the module (a resumed session finds its own). */
async function msgFilesNow($: Engine): Promise<NonNullable<typeof msgFiles>> {
  const { session, dir } = await messagesDir($)
  if (msgFiles && msgFiles.session === session) {
    if (!msgFiles.dir && dir) {
      // a root appeared (lean made thimble/): everything kept in memory is written now
      msgFiles.dir = dir
      msgFiles.pending.add('index')
      for (const row of ((await $.state.get(MSGROWS)).value ?? []) as string[]) msgFiles.pending.add(row)
    }
    return msgFiles
  }
  msgFiles = { session, dir, index: [], pending: new Set(), loaded: false }
  if (dir) {
    try {
      if (await $.fs.exists(`${dir}/index.jsonl`)) {
        msgFiles.index = String(await $.fs.read(`${dir}/index.jsonl`)).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        const rows = msgFiles.index.filter(x => x.kind === 'assistant').map(x => String(x.row))
        const held = ((await $.state.get(MSGROWS)).value ?? []) as string[]
        if (rows.length) await $.state.set(MSGROWS, [...new Set([...rows, ...held])])
      }
    } catch {
      // an index it cannot read: this session's rows start a new one
    }
  }
  msgFiles.loaded = true
  return msgFiles
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
async function recordNow($: Engine, row: string): Promise<MsgRecord | null> {
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
  return ((await $.state.get(ANSWER)).value as string | null | undefined) ?? null
}

/** Every mark position of this session's messages, in reading order. */
async function allMarks($: Engine): Promise<{ row: string; i: number }[]> {
  const rows = ((await $.state.get(MSGROWS)).value ?? []) as string[]
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
  await $.state.set(PICK, null)
  await $.state.set(TRAY, trayOpen({ row, i }) as Tray)
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
  await $.ui.scroll({ to: { key: `mk-${rec.row}-${i}` }, block: 'nearest' }).catch(() => undefined)
}

async function stepMark($: Engine, dir: number): Promise<void> {
  const list = await allMarks($)
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const next = trayStep(list, trayBase(tray), dir)
  if (next) await openMark($, next.row, next.i)
  else $.ui.toast('No marks yet: citations and glosses in Claude\'s replies open here.')
}

async function closeTray($: Engine): Promise<void> {
  await $.state.set(TRAY, null)
}

/** A mark inside the card shown (a nested citation): its card over this one. */
async function openLink($: Engine, id: string): Promise<boolean> {
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const frame = trayTop(tray) as TrayFrame | null
  if (!frame) return false
  const ck = await cardKey($, frame)
  const drawn = [...cards.entries()].find(([c]) => c.startsWith(`${ck}|`))?.[1]
  const link = drawn?.links.find(l => l.id === id)
  if (!link) return false
  await $.state.set(TRAY, trayPush(tray, { ref: link.ref, label: link.label, kind: 'cite' }) as Tray)
  return true
}

/** The cache key of a frame's card. */
async function cardKey($: Engine, frame: TrayFrame): Promise<string> {
  if (frame.row == null) return `ref|${frame.ref}`
  const rec = await recordNow($, frame.row)
  const m = rec?.marks?.[frame.i!]
  if (!m) return `none|${frame.row}|${frame.i}`
  if (m.kind === 'gloss') return `gloss|${JSON.stringify(rec!.glosses?.[m.gloss!] ?? {})}`
  return `ref|${m.ref}`
}

/** A frame's card as the tray draws it: ready, or null with the work started outside the drawing. */
async function cardNow($: Engine, frame: TrayFrame, w: number): Promise<CardDrawn | null> {
  const key = `${await cardKey($, frame)}|${w}`
  const hit = cards.get(key)
  if (hit) return hit
  await $.state.get({ ...CARDREADY, id: key })
  if (!cardPending.has(key)) {
    let done: (c: CardDrawn) => void = () => undefined
    cardPending.set(key, new Promise<CardDrawn>(r => { done = r }))
    // outside the drawing: a render's dispatch may be abandoned, which would stop the child
    $.clock.after(0, () => {
      void buildCard($, frame, w)
        .catch((err): CardDrawn => ({ title: '', right: '', kind: 'cite', grids: null, links: [], problem: `the card could not be drawn: ${String((err as Error)?.message || err).slice(0, 160)}` }))
        .then(async c => {
          cards.set(key, c)
          cardPending.delete(key)
          done(c)
          await $.state.set({ ...CARDREADY, id: key }, Date.now())
        })
    })
  }
  return null
}

/** `lean resolve <ref> --json`, as the person's own read (never counted as Claude's coverage). */
async function resolveJson($: Engine, root: string, ref: string, n = 6): Promise<Any> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run([`${dir}/bin/lean`, 'resolve', ref, '-n', String(n), '--json'], { cwd: root, env: await leanEnv($, root), timeoutMs: 60000 })
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

/** A frame's card: the mark's ref read through the kernel (or the gloss as the observer wrote it), drawn. */
async function buildCard($: Engine, frame: TrayFrame, w: number): Promise<CardDrawn> {
  const inner = w - 4
  const BODY = 9
  let spec: Any
  let kind: CardDrawn['kind'] = 'cite'
  if (frame.row != null) {
    const rec = await recordNow($, frame.row)
    const m = rec?.marks?.[frame.i!]
    if (!rec || !m) return { title: '', right: '', kind, grids: null, links: [], problem: 'this mark is no longer in the message' }
    if (m.kind === 'gloss') {
      kind = 'gloss'
      spec = explainerCard({ gloss: rec.glosses?.[m.gloss!] })
    } else {
      kind = m.kind === 'spark' ? 'spark' : 'cite'
      spec = await sourceSpec($, m.ref!, m.kind === 'spark' ? 'sparkline' : m.label || m.ref!, BODY)
    }
  } else spec = await sourceSpec($, frame.ref!, frame.label || frame.ref!, BODY)
  if (spec.problem) return { title: spec.title, right: spec.right || 'cite', kind, grids: null, links: [], problem: spec.problem }
  const grids: Any[] = []
  for (const part of spec.parts) {
    try {
      const d = await drawPart($, part, inner, BODY)
      if (d.drawing?.error && part.pic) continue // a gloss's drawing that fails: its words stand alone
      grids.push(d.grid)
    } catch (err) {
      if (!part.pic) throw err
    }
  }
  return { title: spec.title, right: spec.right, kind, grids, links: spec.links || [] }
}

/** A citation's card spec: the ref resolved, the query's record or the code file's lines read. */
async function sourceSpec($: Engine, ref: string, label: string, room: number): Promise<Any> {
  const root = await rootHere($)
  if (!root) return { title: label, right: 'cite', problem: `no thimble/ folder here to read ${ref} from; run lean in the data folder first` }
  const series = seriesRef(ref)
  const resolved = await resolveJson($, root, series ? series.query : ref)
  let query: Any = null
  const q = /^(q\d+)(?:[#@]|$)/.exec(ref)
  if (q) {
    try { query = JSON.parse(String(await $.fs.read(`${root}/thimble/queries/${q[1]}.json`))) } catch { query = null }
  }
  let lines: { n: number; text: string }[] | undefined
  const path = ref.split('#')[0]!
  if (cardKind(ref) === 'code') {
    const m = /#L(\d+)(?:-L?(\d+))?$/.exec(ref)
    const a = Number(m?.[1] || 1)
    const b = Number(m?.[2] || a)
    try {
      const all = String(await $.fs.read(path.startsWith('/') ? path : `${root}/${path}`)).split('\n')
      const from = Math.max(1, a - 2)
      const to = Math.min(all.length, Math.max(b + 2, from + room - 2))
      lines = []
      for (let n = from; n <= to; n++) lines.push({ n, text: all[n - 1] ?? '' })
    } catch {
      lines = undefined
    }
  }
  return sourceCard({ ref, label, resolved, query, lines, path, room })
}

/** The message as an object a verb reads: its words as shown, its row and its session. */
function messageObject(rec: MsgRecord): Any {
  const text = shownOf(rec)
  const first = text.replace(/\s+/g, ' ').trim()
  return { id: `msg-${rec.row.slice(0, 8)}`, version: 1, kind: 'message', row: rec.row, session: rec.session, title: first.length > 60 ? first.slice(0, 59) + '…' : first, text }
}

/** The options a verb's line offers for a message: v's proposals, squeeze's one press with its chips, atlas's offer. */
function lineOptions(key: string, rec: MsgRecord | null): { options: { label: string; note?: string }[]; note?: string } {
  const lit = (rec?.verbs || {})[key] as Any
  if (key === 'v') {
    const props = lit?.lit && Array.isArray(lit.proposals) && lit.proposals.length ? lit.proposals : ['a card of this message']
    return { options: props.map((p: string) => ({ label: p })) }
  }
  if (key === 's') {
    const chips = lit?.lit && Array.isArray(lit.chips) ? lit.chips : []
    return { options: [{ label: 'squeeze it' }], note: chips.map((c: Any) => `${c.name}: ${c.levels?.[c.level] ?? ''}`).join(' · ') }
  }
  if (key === 'a') {
    const o = lit?.offer || {}
    const cost = [o.minutes ? `about ${o.minutes} min` : '', o.tokens ? `${Math.round(o.tokens / 1000)}k tokens` : ''].filter(Boolean).join(' · ')
    return { options: [{ label: o.what || 'map the claims of this work', ...(cost ? { note: cost } : {}) }] }
  }
  return { options: [{ label: `run ${key}` }] }
}

/** A verb key under a message: its line opens (a press on the open one closes it). */
async function pressRowVerb($: Engine, row: string, key: string): Promise<void> {
  const cur = (await $.state.get(PICK)).value as Any
  if (cur && cur.row === row && cur.verb === key) { await $.state.set(PICK, null); return }
  await $.state.set(TRAY, null)
  await $.state.set(PICK, { row, verb: key })
  const answer = (await $.state.get(ANSWER)).value
  await $.state.set(SELROW, row === answer ? null : row)
  // the line in view, when a key opened it under a message above the screen
  await $.ui.scroll({ to: { key: `vl-${row}-opt-0` }, block: 'nearest' }).catch(() => undefined)
}

/** An option of the open line picked: the verb runs on the message, outside the press. */
async function pickOption($: Engine, i: number): Promise<boolean> {
  const cur = (await $.state.get(PICK)).value as { row: string; verb: string } | null
  if (!cur) return false
  const rec = await recordNow($, cur.row)
  const { options } = lineOptions(cur.verb, rec)
  const opt = options[i]
  if (!opt || !rec) return false
  await $.state.set(PICK, null)
  const verb = (await rowVerbs($)).find(v => v.key === cur.verb)
  if (!verb) return false
  $.clock.after(0, () => { void runOnMessage($, verb.name, cur.verb, rec, opt.label) })
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
      refs: rec.marks.filter(m => m.ref).map(m => m.ref), drawing: null, state: {}, args: key === 'v' ? choice : '', w: 96,
    }
    const answers: Record<string, unknown> = {}
    let out: Any = null
    for (let round = 0; round < 8; round++) {
      const r = await $.process.run(['node', `${dir}/shell/node/verb.mjs`, 'run', word], { stdin: JSON.stringify({ ...input, answers }), cwd: root, env: await leanEnv($, root), timeoutMs: 600000 })
      try { out = JSON.parse(r.stdout) } catch { out = { verb: word, error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400) || `exit ${r.exitCode}` } }
      if (!out.need) break
      answers[String(out.need.key)] = await modelCall($, out.need)
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
    if (out.error) $.ui.toast(`${word}: ${cut(String(out.error), 200)}`)
    else if (out.ask) void ask($, String(out.ask), word, choice || on)
    else if (out.text && !out.saved) $.ui.toast(cut(String(out.text).split('\n')[0] || '', 200))
    if (!out.ask && !out.error) await noteForClaude($, `The person ran the verb ${word} on ${on}.${out.saved ? ` It shows them ${out.saved.id}.` : ''}${out.text ? ` It said: ${cut(String(out.text), 600)}` : ''}${out.note ? ' ' + out.note : ''}`)
    else if (out.note) await noteForClaude($, String(out.note))
  } catch (err) {
    $.ui.toast(`${word}: ${cut(String((err as Error)?.message || err), 200)}`)
  } finally {
    await $.state.set(at, null)
  }
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

/** A question asked with the tray open: what it carries for Claude, and the row's few words for the person. */
async function trayScope($: Engine): Promise<{ context: string; label: string; scope: Record<string, unknown> } | null> {
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const frame = trayTop(tray) as TrayFrame | null
  if (!frame) return null
  if (frame.row == null) {
    return {
      label: frame.label || frame.ref!, scope: { mark: { kind: 'cite', ref: frame.ref, label: frame.label } },
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
      label: g.term, scope: { row: rec.row, mark: { kind: 'gloss', term: g.term } },
      context: `The person asked this with a gloss of your reply open in the tray: the term "${g.term}" in your reply that begins "${begins}". The gloss said: ${g.body || g.title || ''}${g.here ? ' ' + g.here : ''} "This" or "it" may mean that term.`,
    }
  }
  const label = m.kind === 'spark' ? `the sparkline of ${m.ref}` : String(m.label)
  return {
    label, scope: { row: rec.row, mark: { kind: m.kind, ref: m.ref, label } },
    context: `The person asked this with a ${m.kind === 'spark' ? 'sparkline' : 'citation'} of your reply open in the tray: ${label} (${m.ref}), in your reply that begins "${begins}". "This" may mean that value. \`lean resolve ${seriesRef(m.ref!)?.query ?? m.ref}\` shows its rows.`,
  }
}

/** A key pressed while the prompt is empty: the box as it should stand when the shell took the key, or null to let
 *  it through. */
async function emptyPromptKey($: Engine, e: { key?: { key: string; ctrl?: true; meta?: true }; text: string; cursor: number; inputText: string }): Promise<{ text: string; cursor: number } | null> {
  const key = e.key
  if (!key || key.ctrl || key.meta || e.text !== '') { keyOpened = null; return null }
  const k = key.key
  const now = await $.clock.now()
  const tray = (await $.state.get(TRAY)).value as Tray | null
  const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
  const verbs = await rowVerbs($)
  const consume = { text: e.text, cursor: e.cursor }
  if (k === ']' || k === '[') {
    keyOpened = null
    await $.state.set(PICK, null)
    await stepMark($, k === ']' ? 1 : -1)
    return consume
  }
  if (k === '0' || k === 'backspace') {
    keyOpened = null
    if (pick) { await $.state.set(PICK, null); return consume }
    if (tray) { await $.state.set(TRAY, trayBack(tray) as Tray | null); return consume }
    return null
  }
  if (/^[1-9]$/.test(k)) {
    keyOpened = null
    if (pick) return (await pickOption($, Number(k) - 1)) ? consume : null
    if (tray) {
      const frame = trayTop(tray) as TrayFrame | null
      const ck = frame ? await cardKey($, frame) : ''
      const drawn = frame ? [...cards.entries()].find(([c]) => c.startsWith(`${ck}|`))?.[1] : null
      const link = drawn?.links?.[Number(k) - 1]
      if (link && (await openLink($, link.id))) return consume
    }
    return null
  }
  // with the tray open the prompt is the tray's question: letters are typed
  if (!tray && k.length === 1 && verbs.some(v => v.key === k)) {
    const row = await actingRow($)
    if (row) {
      await pressRowVerb($, row, k)
      keyOpened = { key: k, at: now }
      return consume
    }
  }
  if (pick && k.length === 1) {
    await $.state.set(PICK, null)
    const opened = keyOpened
    keyOpened = null
    // typed straight after the verb key: the letter was the start of a word
    if (opened && now - opened.at < 700) return { text: `${opened.key}${e.inputText}`, cursor: opened.key.length + e.inputText.length }
  }
  keyOpened = null
  return null
}

// ------------------------------------------------------------------------------------------------ drawing

// a verb as a chip: its key and name. Where the key works (a focused pane) the Button carries it as its hotkey, and the
// engine draws the key itself, as `s: squeeze`; elsewhere (the transcript, where a click runs it) it reads `s squeeze`.
function verbChip(els: Any, key: string, v: Verb, onPress: () => unknown, o: { hotkey?: boolean; running?: boolean; dim?: boolean } = {}) {
  const { Button, Text } = els
  const name = o.running ? `${v.name}…` : v.name
  if (o.hotkey && v.key) return Button({ key, plain: true, hotkey: v.key, label: v.name, dimColor: o.dim || undefined, children: [Text({ dimColor: true, children: name })], onPress })
  const label = [v.key ? Text({ color: 'suggestion', children: v.key }) : null, Text({ dimColor: true, children: `${v.key ? ' ' : ''}${name}` })].filter(Boolean)
  return Button({ key, plain: true, label: v.name, children: label, onPress })
}

const sep = (els: Any) => els.Text({ dimColor: true, children: ' · ' })

/** The one quiet row under an object: what a verb on it runs now, and `open` (with how many rows wait there) at its
 *  right. The verbs live in the message's verb row (v, s, a); m, x and t are card forms now, still run by /verb. */
function hintRow($: Engine, els: Any, ref: ObjRef, key: string, o: { fullscreen: boolean; more: number; said: Said | null }) {
  const { Box, Button, Text } = els
  const left: Any[] = o.said?.running ? [Text({ dimColor: true, children: `${o.said.verb}…` })] : []
  const right: Any[] = o.fullscreen
    ? [Button({ key: `${key}:open`, plain: true, label: 'open', children: [Text({ dimColor: true, children: o.more ? `${o.more} more rows · open ` : 'open ' }), Text({ color: 'suggestion', children: '›' })], onPress: () => openDetail($, ref) })]
    : [Text({ dimColor: true, children: `/obj ${refText(ref)} opens it` })]
  return Box({ flexDirection: 'row', justifyContent: 'space-between', children: [Box({ flexDirection: 'row', children: left }), Box({ flexDirection: 'row', children: right })] })
}

/** One object inline: its cells and its hint row, or one red line saying why it cannot be drawn. */
async function inlineEl($: Engine, e: Any, ref: ObjRef, key: string, at: string): Promise<Any> {
  const els = $.ui.resolve(e)
  const { Box, Text } = els as Any
  const cols = Math.max(40, Math.min(120, (e.viewport?.columns ?? 100) - 4))
  const p = await preparedNow($, ref, cols)
  if (!p) return Box({ marginTop: 1, marginLeft: 2, children: [Text({ dimColor: true, children: `drawing ${refText(ref)}…` })] })
  if (p.error || !p.grid) return Text({ color: 'error', children: `× ${refText(ref)} cannot be drawn: ${p.error || 'no drawing'}` })
  const fullscreen = e.viewport?.isFullscreen !== false
  const said = ((await $.state.get({ ...SAID, id: ref.id })).value ?? null) as Said | null
  // calm: under a reply an object takes at most about half a screen; the rest waits in the detail view
  const most = Math.max(12, Math.min(30, Math.floor((e.viewport?.rows ?? 48) * 0.55)))
  const rows = p.grid.h > most ? most : p.grid.h
  const more = p.grid.h - rows
  // a click on a part opens the detail view on it; on a knob's ◂ ▸, opens it and turns the knob there
  const onPress = fullscreen ? (id: string, dir?: number) => (dir ? openTurned($, ref, id, dir) : openDetail($, ref, knobOf(p.drawing, id) ? null : id)) : undefined
  return Box({
    flexDirection: 'column', marginTop: 1, marginLeft: 2, width: Math.max(p.grid.w, 40),
    children: [
      paintRegions(p.grid, els, { theme, key: `${key}-${ref.id}`, rows, onPress }),
      hintRow($, els, ref, `${key}-${ref.id}`, { fullscreen, more, said }),
    ],
  })
}

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

/** The detail view: one pane. The drawing (each part pressable, the selected one lit), what the selection rests on,
 *  then two quiet rows: what a prompt carries, and the keys. A drawing taller than the pane shows the rows around
 *  the selection, with how many are above and below. */
async function detailEl($: Engine, e: Any): Promise<Any> {
  const els = $.ui.resolve(e) as Any
  const { Box, Text, Button, Link } = els
  const sel = (await $.state.get(SEL)).value as Sel | null
  if (!sel) return Text({ dimColor: true, children: 'No object is open. An object Claude saves shows under its reply; open it from there.' })
  const cols = Math.max(30, (e.props.bodyColumns ?? 80) - 1)
  if (sel.cites && !sel.cite) {
    const shown = sel.cites.slice(0, Math.max(5, (e.props.scroll?.bodyRows ?? 40) - 4))
    return Box({ flexDirection: 'column', children: [
      Text({ bold: true, children: `${sel.cites.length} values cited in the reply` }),
      Box({ flexDirection: 'column', marginTop: 1, children: shown.map((c, i) => Button({
        key: `cl-${i}`, plain: true, label: c.label, onPress: () => openCite($, c.ref, c.label),
        children: [Text({ children: cut(c.label, Math.max(10, Math.floor(cols / 2))) }), Text({ dimColor: true, children: `  ${cut(c.ref, Math.max(10, cols - Math.min([...c.label].length, Math.floor(cols / 2)) - 3))}` })],
      })) }),
      sel.cites.length > shown.length ? Text({ dimColor: true, children: `+ ${sel.cites.length - shown.length} more` }) : null,
      Box({ marginTop: 1, children: [Text({ dimColor: true, children: 'tab and enter open one, with the rows behind it' })] }),
    ].filter(Boolean) })
  }
  if (sel.cite) {
    const label = citeLabels.get(sel.cite) || sel.cite
    return Box({ flexDirection: 'column', children: [
      Box({ flexDirection: 'row', justifyContent: 'space-between', children: [Text({ bold: true, wrap: 'truncate-end', children: `where ${label} comes from` }), Text({ dimColor: true, children: ` ${cut(sel.cite, 40)}` })] }),
      Box({ flexDirection: 'column', marginTop: 1, children: await rowsEls($, els, sel.root, [sel.cite], '', cols) }),
      Box({ flexDirection: 'column', marginTop: 1, children: [Text({ dimColor: true, wrap: 'truncate-end', children: `ask  the next prompt carries this citation · esc to type it` })] }),
    ] })
  }
  const p = await preparedNow($, sel, Math.min(cols, 140), sel.state, 'detail')
  if (!p) return Text({ dimColor: true, children: `drawing ${refText(sel)}…` })
  if (p.error || !p.grid) return Text({ color: 'error', children: `× ${refText(sel)} cannot be drawn: ${p.error || 'no drawing'}` })
  const o = p.object
  const knobs: Any[] = p.drawing?.controls || []
  const verbs = await rankedVerbs($, sel, p.verbs)

  // what the selection rests on
  const section: Any[] = []
  if (sel.all) {
    section.push(Text({ children: [Text({ bold: true, children: 'all verbs' }), Text({ dimColor: true, children: ` on ${o.id}${sel.region ? ' ▸ ' + sel.region : ''} · ● picked for it` })] }))
    for (const v of verbs) {
      section.push(Button({
        key: `all:${v.name}`, plain: true, label: v.name, onPress: () => pressVerb($, v.name, sel, sel.region, null, true),
        children: [Text({ dimColor: true, children: v.picked ? '● ' : '  ' }), Text({ color: 'suggestion', children: v.key || ' ' }), Text({ children: `  ${v.name.padEnd(10)} ` }), Text({ dimColor: true, children: cut(v.phrase || v.line, Math.max(10, cols - 18)) })],
      }))
    }
    if (!verbs.length) section.push(Text({ dimColor: true, children: 'No verbs yet: a verb is a folder in lean/verbs/.' }))
  } else if (sel.region) {
    const meta = regionMeta(p.drawing, sel.region)
    if (!meta) section.push(Text({ dimColor: true, children: `no part "${sel.region}" in this version` }))
    else {
      section.push(Text({ wrap: 'truncate-end', children: [Text({ bold: true, children: `▸ ${meta.label || sel.region}` }), Text({ dimColor: true, children: `  ${sel.region}` })] }))
      const cite = typeof meta.cite === 'string' ? p.drawing.cites?.[meta.cite] : null
      if (cite?.text || cite?.source) section.push(Text({ wrap: 'wrap', children: [Text({ children: `  ${cite.text || ''}` }), Text({ dimColor: true, children: cite.source ? ` · ${cite.source}` : '' })] }))
      if (meta.note) section.push(Text({ dimColor: true, italic: true, wrap: 'wrap', children: `  ${meta.note}` }))
      const { refs, how } = regionRefs(o, p.drawing, sel.region)
      section.push(...(await rowsEls($, els, sel.root, refs, how, cols)))
      const own = recordRefs(p.drawing, sel.region)
      const ex = typeof meta.examples === 'string' ? p.drawing.examples?.[meta.examples] : null
      if (ex && ex.records?.length) {
        const i = ((sel.ex % ex.records.length) + ex.records.length) % ex.records.length
        section.push(Box({ flexDirection: 'row', children: [
          Text({ dimColor: true, children: `  example ${i + 1} of ${fmtN(ex.total ?? ex.records.length)}${ex.label ? ' · ' + ex.label : ''}  ` }),
          Button({ key: 'ex-prev', plain: true, hotkey: 'j', label: 'previous example', children: [Text({ dimColor: true, children: '‹' })], onPress: () => stepExample($, -1) }),
          Text({ children: '  ' }),
          Button({ key: 'ex-next', plain: true, hotkey: 'k', label: 'next example', children: [Text({ dimColor: true, children: '›' })], onPress: () => stepExample($, 1) }),
        ] }))
        section.push(Text({ wrap: 'wrap', children: `  ${cut(exampleText(ex.fmt, ex.records[i]), cols * 3)}` }))
      } else if (own.length) {
        for (const r of own.slice(0, 3)) section.push(Text({ wrap: 'truncate-end', children: [Text({ dimColor: true, children: `  ${r.ref}  ` }), Text({ children: String(r.text) })] }))
      }
    }
  } else {
    const cites = objectRefs(o)
    if (o.text) section.push(Text({ wrap: 'wrap', children: String(o.text).replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1') }))
    if (cites.length) section.push(...(await rowsEls($, els, sel.root, cites.map((c: Any) => c.ref), '', cols)))
    else if (!o.text) section.push(Text({ dimColor: true, children: selectable(p.grid).length ? 'Select a part to see its rows.' : 'It cites no rows and has no parts to select.' }))
  }

  // what the last verb on it said (or that one runs now)
  const said = ((await $.state.get({ ...SAID, id: sel.id })).value ?? null) as Said | null
  if (said?.running) section.push(Text({ dimColor: true, children: `${said.verb}…` }))
  else if (said?.error) section.push(Text({ color: 'error', wrap: 'wrap', children: `${said.verb}: ${cut(said.error, cols * 2)}` }))
  else if (said?.text) for (const [i, l] of said.text.split('\n').slice(0, 4).entries()) section.push(Text({ dimColor: true, wrap: 'truncate-end', children: `${i ? '  ' : said.verb + ': '}${l}` }))

  // the two quiet rows: what a prompt carries, and the keys
  const parts = selectable(p.grid)
  const ask = Text({ dimColor: true, wrap: 'truncate-end', children: `ask  the next prompt carries ${o.id}${sel.region ? ' ▸ ' + sel.region : ''} · esc to type it` })
  const row: Any[] = []
  if (parts.length) row.push(Text({ color: 'suggestion', children: 'tab' }), Text({ dimColor: true, children: ' parts' }), sep(els))
  const examples = !!(sel.region && typeof regionMeta(p.drawing, sel.region)?.examples === 'string')
  if (knobs.length && !examples) {
    const k = knobs.find(c => c.id === sel.knob) || knobs[0]
    row.push(Button({ key: 'knob-down', plain: true, hotkey: 'j', label: `turn ${k.label} down`, children: [Text({ dimColor: true, children: '◂' })], onPress: () => turnSel($, k.id, -1) }))
    row.push(Text({ children: ' ' }))
    row.push(Button({ key: 'knob-up', plain: true, hotkey: 'k', label: `turn ${k.label} up`, children: [Text({ dimColor: true, children: '▸' })], onPress: () => turnSel($, k.id, 1) }))
    row.push(Text({ dimColor: true, children: ` turn ${k.label}` }), sep(els))
  }
  // every verb works on its key here; those picked for the object read brighter
  const running = said?.running ? said.verb : null
  // the verbs of the message row work on their keys here too; m, x and t are card forms now (/verb and `all verbs` still run them)
  const onRow = new Set((await rowVerbs($)).map(v => v.name))
  for (const v of verbs) if (v.key && onRow.has(v.name)) row.push(verbChip(els, `k:${v.name}`, v, () => pressVerb($, v.name, sel, sel.region, null, true), { hotkey: true, running: running === v.name, dim: !v.picked }), sep(els))
  row.push(Button({ key: 'k:all', plain: true, hotkey: 'h', label: 'all verbs', children: [Text({ dimColor: true, children: sel.all ? 'fewer verbs' : 'all verbs' })], onPress: () => toggleAll($) }))
  row.push(sep(els))
  row.push(Button({ key: 'k:web', plain: true, hotkey: 'o', label: 'open in browser', children: [Text({ dimColor: true, children: 'browser' })], onPress: async () => $.ui.toast(await openBrowser($, (await $.state.get(SEL)).value ?? sel)) }))
  const keys = Box({ flexDirection: 'row', flexWrap: 'wrap', children: row })
  // the page's link only when no browser opened it (o opens it again otherwise)
  const web = (await $.state.get(WEB)).value
  const page = web?.problem
    ? Text({ dimColor: true, wrap: 'truncate-end', children: [web.opened && web.root === sel.root ? Link({ href: web.opened, children: 'the page ↗' }) : '', ` ${web.problem}`] })
    : null

  // the drawing's window: all of it when it fits, else the rows around the selection
  const head = 1 + (o.question ? 1 : 0)
  const fixed = head + 1 + rowsOf(section, cols) + 1 + 1 + 2 + (page ? 1 : 0)
  const room = Math.max(6, (e.props.scroll?.bodyRows ?? 40) - fixed)
  let from = 0
  let rows = p.grid.h
  if (p.grid.h > room) {
    rows = room - 2
    const r = sel.region ? p.grid.regions.find((x: Any) => x.id === sel.region && x.rects.length) : null
    const at = r ? r.rects[0].y : 0
    from = Math.max(0, Math.min(p.grid.h - rows, at - Math.floor(rows / 2)))
  }
  const above = from
  const below = p.grid.h - from - rows
  const onPress = (id: string, dir?: number) => {
    if (dir) return turnSel($, id, dir)
    if (knobOf(p.drawing, id)) return $.state.set(SEL, { ...sel, knob: id })
    return select($, { ...sel, region: id === sel.region ? null : id, ex: 0, all: false })
  }
  const drawing = Box({ flexDirection: 'column', marginTop: 1, children: [
    above ? Text({ dimColor: true, children: `↑ ${above} more row${above === 1 ? '' : 's'}` }) : null,
    paintRegions(p.grid, els, { theme, selected: sel.region, key: 'pane', from, rows, onPress }),
    below ? Text({ dimColor: true, children: `↓ ${below} more row${below === 1 ? '' : 's'}` }) : null,
  ].filter(Boolean) })

  return Box({ flexDirection: 'column', children: [
    Box({ flexDirection: 'row', justifyContent: 'space-between', children: [Text({ bold: true, wrap: 'truncate-end', children: String(o.title || o.id) }), Text({ dimColor: true, children: ` ${o.id}@${o.version}` })] }),
    o.question ? Text({ dimColor: true, wrap: 'truncate-end', children: String(o.question) }) : null,
    drawing,
    Box({ flexDirection: 'column', marginTop: 1, children: section }),
    Box({ flexDirection: 'column', marginTop: 1, children: [ask, keys, page].filter(Boolean) }),
  ].filter(Boolean) })
}

/** About how many rows these elements take at `cols` columns: one each, more for a long text that wraps. */
function rowsOf(els: Any[], cols: number): number {
  const text = (n: Any): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('') : n?.props?.children != null ? text(n.props.children) : n?.children != null ? text(n.children) : '')
  return els.reduce((sum, n) => sum + (n?.props?.wrap === 'wrap' || n?.wrap === 'wrap' ? Math.max(1, Math.ceil([...text(n)].length / Math.max(10, cols))) : 1), 0)
}

async function rowsEls($: Engine, els: Any, root: string, refs: string[], how: string, cols: number): Promise<Any[]> {
  const { Text } = els
  const out: Any[] = []
  for (const ref of refs.slice(0, 3)) {
    const r = (await $.state.get({ ...ROWS, id: `${root}|${ref}` })).value as Any
    if (r === undefined) { out.push(Text({ dimColor: true, children: `  rows  resolving ${cut(ref, cols - 20)}…` })); continue }
    const c = chainWords(r)
    if (c.error) { out.push(Text({ color: 'error', wrap: 'wrap', children: `  rows  ${c.notes[0]}` })); continue }
    out.push(Text({ wrap: 'truncate-end', children: [Text({ dimColor: true, children: '  rows  ' }), Text({ children: `← ${c.line}` }), Text({ dimColor: true, children: how && !how.startsWith('named') ? `  (${how})` : '' })] }))
    for (const n of c.notes.slice(0, 2)) out.push(Text({ dimColor: true, italic: true, wrap: 'wrap', children: `        ${n}` }))
    for (const rec of c.records.slice(0, 3)) out.push(Text({ wrap: 'truncate-end', children: [Text({ dimColor: true, children: `        ${rec.ref}  ` }), Text({ children: String(rec.text ?? '') })] }))
    if (r.count != null && r.count > c.records.length) out.push(Text({ dimColor: true, children: `        + ${fmtN(r.count - c.records.length)} more · lean resolve ${cut(ref, Math.max(10, cols - 40))}` }))
  }
  return out
}

function exampleText(fmt: unknown, rec: Any): string {
  if (typeof fmt === 'string' && rec && typeof rec === 'object') {
    return fmt.replace(/\{([\w.]+)\}/g, (m, key) => {
      const v = key.split('.').reduce((x: Any, k: string) => (x == null ? undefined : x[k]), rec)
      return v === undefined ? m : String(v)
    }).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\n/g, ' · ')
  }
  return typeof rec === 'string' ? rec : JSON.stringify(rec)
}

async function stepExample($: Engine, d: number): Promise<void> {
  const cur = (await $.state.get(SEL)).value
  if (cur) await $.state.set(SEL, { ...cur, ex: cur.ex + d })
}

async function toggleAll($: Engine): Promise<void> {
  const cur = (await $.state.get(SEL)).value
  if (cur) await $.state.set(SEL, { ...cur, all: !cur.all })
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

export const registerShell: Register = on => {
  // (a matcher, as the kernel's module hooks session.start without one and the engine takes one bare hook per event)
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'obj', description: 'Open an object in the detail view: /obj [object] [region] · /obj browser opens it in the browser', argumentHint: '[object] [region]', immediate: true })
      await $.command.register({ name: 'verb', description: 'Run a verb on an object: /verb <verb> [object] [region] [words] · /verb ? lists the verbs', argumentHint: '<verb> [object] [region] [words]' })
      const row = (await $.config.list()).find(x => x.key === 'theme')
      theme = String(row?.value ?? 'dark').startsWith('light') ? 'light' : 'dark'
    } catch {
      // the shell draws nothing it cannot; the session goes on
    }
    try {
      // a resumed session: its objects drawn under the same rows again
      await restoreShown($)
    } catch {
      // a session that cannot read its placements draws its new objects only
    }
    try {
      // the verbs of the message row (verbs/*/verb.json with "row": true), and a resumed session's message index
      await loadRowVerbs($)
      await msgFilesNow($)
    } catch (err) {
      $.ui.toast(`thimble: the verb row could not read the verbs (${cut(String((err as Error)?.message || err), 120)}); v and s still work`)
    }
    return r
  })

  // a turn of main's: the objects it saved, and its last text row, under which they are drawn
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turn = { unplaced: [], lastRow: '', calls: [], placed: [] }
      // a new turn: the keys act on its answer again, and a verb's open line closes
      try {
        await $.state.set(SELROW, null)
        await $.state.set(PICK, null)
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
      if (r.deny !== undefined || r.isError || input.agentId || !/\blean\b/.test(String(input.command)) || !text.includes('saved ')) return r
      const cdTo = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(String(input.command))
      notes = []
      for (const m of text.matchAll(SAVED)) {
        const id = String(m[1])
        const root = await findRoot($, id, cdTo ? [String(cdTo[1] || cdTo[2] || cdTo[3])] : [])
        if (!root) continue
        const ref: ObjRef = { id, v: Number(m[2]), root }
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
        notes.push(drawnNote(await prepared($, ref, 96), ref))
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
      }
    } catch {
      // a turn with no verb row is better than one that does not end
    }
    if (e.agentId === undefined) turn = null
    return done
  })

  // one of Claude's messages drawn from its record: its marks inline (a citation underlined, a gloss on a teal fill, a
  // sparkline in place, each a press that opens the tray), the verb row under a turn's answer, the line a verb opened,
  // then the objects its turn saved. A message with none of these is Claude Code's own drawing.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
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
    const answer = (await $.state.get(ANSWER)).value
    const final = !!rec.final || answer === at
    if (!rec.marks.length && !final && !list.length) return next(e)
    const tray = (await $.state.get(TRAY)).value as Tray | null
    const base = trayBase(tray) as TrayFrame | null
    const cols = Math.max(20, (e.viewport?.columns ?? 100) - 3)
    const parts: Any[] = []
    parts.push(rec.marks.length
      ? messageEl(els, { rec, key: `msg-${at}`, cols, first: !!e.props.isFirstOfReply, theme, focus: base && base.row === at ? base.i ?? null : null, onMark: (i: number) => openMark($, at, i, rec) })
      : await next(e))
    if (final) {
      const verbs = await rowVerbs($)
      const pick = (await $.state.get(PICK)).value as { row: string; verb: string } | null
      const sel = (await $.state.get(SELROW)).value
      const running = ((await $.state.get({ ...RUNNING, id: at })).value ?? null) as string | null
      parts.push(verbRowEl(els, { key: `vr-${at}`, verbs, lit: rec.verbs || {}, open: pick && pick.row === at ? pick.verb : null, running, selected: sel === at, theme, onPress: (k: string) => pressRowVerb($, at, k) }))
      if (pick && pick.row === at) {
        const verb = verbs.find(v => v.key === pick.verb)
        if (verb) {
          const { options, note } = lineOptions(pick.verb, rec)
          parts.push(verbLineEl(els, { key: `vl-${at}`, verb, options, ...(note ? { note } : {}), theme, onPick: (i: number) => pickOption($, i), onClose: () => $.state.set(PICK, null) }))
        }
      }
    }
    if (list.length) parts.push(...(await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `row-${at}-${i}`, at)))))
    return parts.length === 1 ? parts[0] : Box({ flexDirection: 'column', children: parts })
  })

  // the tray: one small panel above the prompt, a fixed number of rows, so the transcript scrolls above it. It shows the
  // card on top of its stack: a citation's source card or a gloss's explainer card.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const tray = (await $.state.get(TRAY)).value as Tray | null
    const frame = trayTop(tray) as TrayFrame | null
    if (!frame || e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e) as Any
    const w = Math.max(40, Math.min(104, (e.props.bodyColumns ?? 100) - 3))
    let kind: 'cite' | 'gloss' | 'spark' = 'cite'
    let title = frame.label || frame.ref || ''
    if (frame.row != null) {
      const rec = await recordNow($, frame.row)
      const m = rec?.marks?.[frame.i!]
      if (!rec || !m) return next(e)
      kind = m.kind
      title = m.kind === 'gloss' ? rec.glosses?.[m.gloss!]?.term ?? '' : m.kind === 'spark' ? `sparkline · ${m.ref}` : String(m.label)
    }
    const card = await cardNow($, frame, w)
    const depth = tray?.stack.length ?? 1
    const links = card?.links ?? []
    const keys = ['type + ↵ ask', '] next mark', ...(links.length ? [`${links.length > 1 ? `1–${links.length}` : '1'} open`] : []), depth > 1 ? '0 back' : '0 close'].join(' · ')
    return trayEl(els, {
      key: 'tray', w, body: 9, theme, kind, title: card?.title && frame.row == null ? card.title : title, right: card?.right || (kind === 'gloss' ? 'gloss' : 'cite'),
      grids: card?.grids ?? null, problem: card?.problem ?? null, links, depth, keys,
      onLink: (id: string) => { void openLink($, id) },
    })
  })

  // keys while the prompt is empty: v, s and a open their line under the message the keys act on; ] and [ move through
  // the marks, opening the tray; a digit picks in the open line or opens a mark inside the card; 0 closes the line or
  // goes back one card. Claude Code hands a plugin only the keys that edit the prompt (tab, ↵, esc and a ⌫ with nothing
  // to delete stay its own), so these are the keys. A verb key that began a word being typed (`visualize …`, `so …`)
  // gives its letter back to the prompt. Keys are read one at a time, in the order pressed.
  on('prompt.edit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    const mine = keyChain.then(() => emptyPromptKey($, e)).catch(() => null)
    keyChain = mine
    const r = await mine
    return r ?? next(e)
  }).catch(($, e, next) => next(e))

  // a turn whose last word was a tool call: its objects under that call's row
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const at = e.props.tool_use_id
    const list = ((await $.state.get({ ...UNDER, id: at })).value ?? []) as ObjRef[]
    if (!list.length || e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e) as Any
    const own = await next(e)
    const drawn = await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `call-${at.slice(-10)}-${i}`, at)))
    return Box({ flexDirection: 'column', children: [own, ...drawn] })
  })

  // a prompt asked while the detail view was open: under it, what it carried
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    const about = (await $.state.get({ ...ASKED, id: rowKey(e.requestId) })).value
    if (!about) return next(e)
    const { Box, Text } = $.ui.resolve(e) as Any
    const own = await next(e)
    return Box({ flexDirection: 'column', children: [own, Text({ dimColor: true, wrap: 'truncate-end', children: `  ▸ about ${about.id}${about.v != null ? '@' + about.v : ''}${about.region ? ' ▸ ' + about.label : ''}` })] })
  })

  // the prompt carries what verbs said for Claude since its last reply, and the open object with its selected part
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const context: string[] = []
    try {
      const notes = ((await $.state.get(NOTES)).value ?? []) as string[]
      if (notes.length) {
        context.push(notes.join('\n'))
        await $.state.set(NOTES, [])
      }
      const sel = (await $.state.get(SEL)).value
      // a question asked with the tray open is about its card's mark (CONTRACT 6: a prompt to main carrying the scope)
      const scoped = !e.isMeta && (e.origin as { kind?: string } | undefined)?.kind !== 'plugin' ? await trayScope($) : null
      await $.state.set(PICK, null)
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
      return { text: await openBrowser($, sel) }
    }
    await openDetail($, t.ref, t.region)
    return {}
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
    if (e.props.command !== 'verb' || e.props.isErrored) return next(e)
    const at = `cmd|${e.props.args.trim().slice(0, 300)}`
    const list = ((await $.state.get({ ...UNDER, id: at })).value ?? []) as ObjRef[]
    if (!list.length) return next(e)
    const { Box } = $.ui.resolve(e) as Any
    const own = await next(e)
    const drawn = await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `verb-${e.requestId.slice(-10)}-${i}`, at)))
    return Box({ flexDirection: 'column', children: [own, ...drawn] })
  })

  // the detail view
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => detailEl($, e))

  // tab through the parts: each lights in the drawing as the ring reaches it
  on('ui.focus', async ($, e, next) => {
    const r = await next(e)
    try {
      const region = e.requestId === PANE && typeof e.element === 'string' ? regionOfKey(e.element) : null
      if (region) {
        const cur = (await $.state.get(SEL)).value
        const p = cur ? await prepared($, cur, 96, cur.state) : null
        if (cur && p && knobOf(p.drawing, region)) { if (cur.knob !== region) await $.state.set(SEL, { ...cur, knob: region }) }
        else if (cur && cur.region !== region) await select($, { ...cur, region, ex: 0, all: false })
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
  shown = null
}

export { isRef }
