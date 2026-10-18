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
//   resume     where each object is drawn is kept per session in $THIMBLE_HOME/lean/shown/<session>.json, so
//              `claude -c` and `--resume` draw the objects under the same replies again.
//
// What it never does: it registers no model tool (a plugin's tool skips the asks of Manual mode), starts no
// `claude`, and allows nothing on anyone's behalf. Everything it runs is the person's press or command, or a pure
// drawing of what Claude saved. The Node helpers run as child processes: a hooks module has no Node, and an
// object's program runs only in the drawing contract's sandbox.
import type { EngineInterface, Register } from 'claude-code'

import type { ObjRef, Ran, Said, Sel } from '../types'
import { knobOf, toHash, turn as turnKnob } from '../draw/handoff.js'
import { gridText, renderTerm } from '../draw/term.js'
import { paintRegions, selectable } from './cells'
import { detailPane, markOpen, openDetailPane, registerDetail } from './detail'
import { isRef, objectRefs, rankRow, recordRefs, regionMeta, regionRefs } from './object.js'
import { askThread, registerThreads } from './thread'

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

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/
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
export const citeLabels = new Map<string, string>()
const preps = new Map<string, Prepared>()
const pending = new Map<string, Promise<Prepared>>()
let turn: { unplaced: ObjRef[]; lastRow: string; calls: string[]; placed: string[] } | null = null
let theme: 'dark' | 'light' = 'dark'
let pendingAsk: { text: string; about: { id: string; v: number | null; region: string | null; label: string } } | null = null
let server: { base: string; root: string } | null = null
let serverStarting: Promise<{ base: string } | { problem: string }> | null = null
// the server's stream: leaving it (return()) ends the server
let serverStream: { return?: (v?: unknown) => unknown } | null = null
// browser mode: the `browser` setting as the module loaded with it, then as /config changes it
let browserFlag = false

let shown: { file: string; under: Record<string, Placed[]> } | null = null

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

const prepKey = (ref: ObjRef, w: number, state?: Record<string, unknown> | null, mode = 'inline', h = 24) => `${ref.root}|${ref.id}|${ref.v ?? ''}|${w}|${stateKey(state)}|${mode}${h === 24 ? '' : '|' + h}`

/** The object drawn at `w` columns (with the knobs at `state`), with its verbs: the program runs in a Node child, in the
 *  contract's sandbox. `mode` is where it is drawn (k.mode): 'inline' under a reply, 'detail' in the detail view, where
 *  a program may show more, in the `h` rows the detail gives it (k.h). Kept per object version, width, state, mode and
 *  rows; a failed one stays failed until the module reloads. */
export function prepared($: Engine, ref: ObjRef, w: number, state?: Record<string, unknown> | null, mode = 'inline', h = 24): Promise<Prepared> {
  const key = prepKey(ref, w, state, mode, h)
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
    const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `${dir}/shell/node/prep.mjs`], { stdin: JSON.stringify({ object, w, h, state: state || undefined, mode }), timeoutMs: 30000 })
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
export async function leanEnv($: Engine, root: string): Promise<Record<string, string>> {
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

/** A citation of Claude's words, opened in the detail view: where its value came from, down to its rows. */
async function openCite($: Engine, ref: string | null, label: string): Promise<void> {
  if (!ref) return
  const root = await rootHere($)
  if (!root) { $.ui.toast(`no thimble/ folder here to resolve ${ref}`); return }
  const last = (await $.state.get(LAST)).value
  await $.state.set(SEL, { id: last?.id ?? '', v: last?.v ?? null, root, region: null, ex: 0, all: false, cite: ref })
  citeLabels.set(ref, label)
  await openDetailPane($, 'citation')
  await resolveRefs($, root, [ref])
}

/** The values a reply cites, listed in the detail view: each a press from its rows. */
async function openCites($: Engine, cites: { ref: string; label: string }[]): Promise<void> {
  const root = await rootHere($)
  if (!root) { $.ui.toast('no thimble/ folder here to resolve these citations'); return }
  const last = (await $.state.get(LAST)).value
  await $.state.set(SEL, { id: last?.id ?? '', v: last?.v ?? null, root, region: null, ex: 0, all: false, cites: cites.slice(0, 200) })
  await openDetailPane($, 'cited values')
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
export async function ask($: Engine, request: string, verb: string, on: string): Promise<void> {
  const notes = ((await $.state.get(NOTES)).value ?? []) as string[]
  await $.state.set(NOTES, [])
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: [...notes, request].join('\n\n') }] } })
  await $.prompt.submit({ text: `${verb} ${on}`, asUser: true })
}

/** A verb the person pressed (a click under an object, a key in the detail view). It runs here, outside the press, and
 *  the hint row says so while it runs. */
function pressVerb($: Engine, verb: string, ref: ObjRef, region: string | null, at: string | null, inPane: boolean, extra?: Record<string, unknown>): void {
  $.clock.after(0, () => {
    void (async () => {
      const busy = (await $.state.get({ ...SAID, id: ref.id })).value
      if (busy?.running) return
      await $.state.set({ ...SAID, id: ref.id }, { verb, running: true })
      let ran: Ran
      try {
        const sel = inPane ? (await $.state.get(SEL)).value : null
        ran = await execVerb($, verb, ref, region, 96, { state: sel && sel.id === ref.id ? sel.state : null, extra })
      } catch (err) {
        ran = { verb, on: refText(ref), error: String((err as Error)?.message || err).slice(0, 300) }
      }
      await settle($, ran, ref, at, inPane)
    })()
  })
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

/** The record of one of Claude's messages in this session (CONTRACT 1), or null. */
async function recordOf($: Engine, root: string, row: string): Promise<Any | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(row)) return null
  const file = `${root}/thimble/messages/${String(await $.session.id())}/${row}.json`
  try { return (await $.fs.exists(file)) ? JSON.parse(String(await $.fs.read(file))) : null } catch { return null }
}

type WebScope = { row?: string; object?: string; v?: number; region?: string; label?: string; mark?: { kind?: string; ref?: string; gloss?: string; label?: string; term?: string } }

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
  const m = scope.mark
  if (m && m.kind === 'gloss') {
    lines.push(`They asked about the term "${m.term || m.label || ''}", which the page explains under your message.`)
  } else if (m && m.ref && isRef(m.ref)) {
    lines.push(`They asked about your citation "${m.label || m.ref}" (${m.ref}). \`lean resolve ${m.ref}\` shows its rows.`)
  }
  if (scope.row) {
    const rec = await recordOf($, root, scope.row)
    const text = rec ? String(rec.shown ?? rec.text ?? '') : ''
    if (text && !scope.object) lines.push(`It is about your message that begins: "${cut(withoutTargets(text).replace(/\s+/g, ' '), 240)}"`)
  }
  return lines.join('\n')
}

/** A question asked in the browser. About a card or a mark it is a side thread (thread.ts), which main does not see;
 *  about a message as a whole it is a turn the person started, their words as the prompt, what it was asked about
 *  just before it as a row for Claude alone (as a verb's request is). Claude Code labels that prompt's row as the
 *  plugin's. */
async function askFromBrowser($: Engine, root: string, text: string, scope: WebScope): Promise<void> {
  try {
    if ((scope.object && ID.test(scope.object)) || scope.mark) {
      const card = scope.object && ID.test(scope.object) ? await withVersion($, { id: scope.object, v: scope.v ?? null, root }) : null
      const p = card ? await prepared($, card, 96) : null
      const region = scope.region && REGION.test(scope.region) ? scope.region : null
      const refs = p?.object ? (region ? regionRefs(p.object, p.drawing, region).refs : objectRefs(p.object).map((c: Any) => c.ref)) : undefined
      const r = await askThread($, {
        text, root, ...(refs ? { refs } : {}),
        scope: { ...(card ? { object: card.id, v: card.v } : {}), ...(region ? { region, label: scope.label || String(regionMeta(p?.drawing, region)?.label || region) } : {}), ...(scope.row ? { row: scope.row } : {}), ...(scope.mark ? { mark: scope.mark } : {}) },
        card: p?.object ? { id: p.object.id, v: p.object.version, title: p.object.title, file: `${root}/thimble/objects/${p.object.id}.json` } : null,
      })
      if (r.problem) $.ui.toast(`A question from the browser: ${r.problem}.`)
      return
    }
    const context = await webContext($, root, scope)
    const notes = ((await $.state.get(NOTES)).value ?? []) as string[]
    await $.state.set(NOTES, [])
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: [...notes, context].join('\n\n') }] } })
    await $.prompt.submit({ text, asUser: true })
  } catch (err) {
    $.ui.toast(`A question from the browser did not reach Claude (${cut(String((err as Error)?.message || err), 120)}); type it here instead.`)
  }
}

/** A verb pressed under a message in the browser: pressed here as in the terminal, on the message's card. */
async function verbFromBrowser($: Engine, root: string, key: string, row: string, proposal: string | null): Promise<void> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  let verbs: Any[] = []
  try {
    const r = await $.process.run(['node', `${dir}/shell/node/verb.mjs`, 'list'], { timeoutMs: 30000 })
    verbs = JSON.parse(r.stdout).verbs || []
  } catch { verbs = [] }
  const verb = verbs.find(v => v.key === key)
  if (!verb) { $.ui.toast(`The browser pressed ${key}, but no verb is on that key yet, so nothing ran.`); return }
  const rec = await recordOf($, root, row)
  const first = ((rec?.objects ?? []) as string[]).map(x => /^([^@\s]+)(?:@(\d+))?$/.exec(String(x))).find(Boolean)
  if (!first || !ID.test(first[1]!)) { $.ui.toast(`${verb.name}: the message pressed in the browser has no card for it to work on.`); return }
  const ref = await withVersion($, { id: first[1]!, v: first[2] ? Number(first[2]) : null, root })
  pressVerb($, verb.name, ref, null, row, false, { record: rec, row, ...(proposal ? { proposal } : {}) })
}

/** Open a page of this session in the browser: the mirror (at a row), or a card's detail (on a part). */
export async function openBrowser($: Engine, at: { id?: string; v?: number | null; region?: string | null; row?: string | null; root?: string } = {}): Promise<string> {
  if (!browserFlag) return 'Browser mode is off. Turn on Browser in /config (thimble-lean), then press o or type /browser.'
  const root = at.root || (await webRoot($))
  const s = await startServer($, root)
  if ('problem' in s) {
    await $.state.set(WEB, { on: true, problem: s.problem })
    return `No page: ${s.problem}. Try /browser again; if it fails twice, turn Browser off and on in /config.`
  }
  const q = (o: Record<string, unknown>) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
  const url = at.id
    ? `${s.base}/card/?${q({ o: at.id, v: at.v, from: at.row })}${at.region ? `#r=${encodeURIComponent(at.region)}` : ''}`
    : `${s.base}/mirror/${at.row ? `#row=${encodeURIComponent(at.row)}` : ''}`
  const what = at.id ? `${at.id}${at.region ? ' ▸ ' + at.region : ''}` : 'this session'
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

/** Which picked verbs read as the observer's few words, best first, while the row fits in `room` columns (the rest
 *  read as their names), and the columns the row then takes: its verbs, `? all`, and `open` at its right. */
function hintWords(ref: ObjRef, verbs: Verb[], o: { fullscreen: boolean; more: number }, room: number): { words: string[]; width: number } {
  const tail = o.fullscreen ? (o.more ? `${o.more} more rows · open ›` : 'open ›') : `/obj ${refText(ref)} opens it`
  const picked = verbs.filter(v => v.picked).slice(0, 3)
  const len = (s: string) => 2 + [...s].length + 3
  let width = picked.reduce((n, v) => n + len(v.name), 6) + tail.length + 2 + (browserFlag ? 12 : 0)
  const words: string[] = []
  for (const v of picked) {
    if (!v.hint) continue
    const more = len(v.hint) - len(v.name)
    if (width + more > room) break
    width += more
    words.push(v.name)
  }
  return { words, width }
}

/** The one quiet row under an object: the picked verbs, `? all`, and `open` (with how many rows wait there). With
 *  `words`, a verb the observer ranked reads as its few words for this object (`t trace 2,327 to its rows`). */
function hintRow($: Engine, els: Any, ref: ObjRef, verbs: Verb[], key: string, o: { fullscreen: boolean; at: string; more: number; said: Said | null; words: string[]; focused?: boolean }) {
  const { Box, Button, Text } = els
  const picked = verbs.filter(v => v.picked).slice(0, 3)
  const running = o.said?.running ? o.said.verb : null
  const kids: Any[] = []
  picked.forEach((v, i) => {
    if (i) kids.push(sep(els))
    kids.push(verbChip(els, `${key}:v:${v.name}`, v.hint && o.words.includes(v.name) ? { ...v, name: v.hint } : v, () => pressVerb($, v.name, ref, null, o.at, false), { running: running === v.name }))
  })
  if (running && !picked.some(v => v.name === running)) kids.push(...(picked.length ? [sep(els)] : []), Text({ dimColor: true, children: `${running}…` }))
  if (kids.length) kids.push(sep(els))
  kids.push(Button({ key: `${key}:all`, plain: true, label: 'all verbs', children: [Text({ color: 'suggestion', children: '?' }), Text({ dimColor: true, children: ' all' })], onPress: () => openAll($, ref) }))
  // the latest card is the focused one: 1 on an empty prompt opens its detail (detail.tsx)
  const right: Any[] = o.fullscreen
    ? [Button({ key: `${key}:open`, plain: true, label: 'open detail', children: o.focused
        ? [Text({ dimColor: true, children: o.more ? `${o.more} more rows · ` : '' }), Text({ color: 'suggestion', children: '1' }), Text({ dimColor: true, children: ' open detail' })]
        : [Text({ dimColor: true, children: o.more ? `${o.more} more rows · open detail ` : 'open detail ' }), Text({ color: 'suggestion', children: '›' })], onPress: () => openDetail($, ref) })]
    : [Text({ dimColor: true, children: `/obj ${refText(ref)} opens it` })]
  if (browserFlag) right.unshift(browserChip(els, `${key}:web`, async () => $.ui.toast(await openBrowser($, { id: ref.id, v: ref.v, row: o.at, root: ref.root }))), sep(els))
  return Box({ flexDirection: 'row', justifyContent: 'space-between', children: [Box({ flexDirection: 'row', children: kids }), Box({ flexDirection: 'row', children: right })] })
}

async function openAll($: Engine, ref: ObjRef): Promise<void> {
  await openDetail($, ref)
  const cur = (await $.state.get(SEL)).value
  if (cur) await $.state.set(SEL, { ...cur, all: true })
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
  // the row's few words as far as they fit the screen, which may widen it past the drawing; else the verbs' names
  const verbs = await rankedVerbs($, ref, p.verbs)
  const { words, width } = hintWords(ref, verbs, { fullscreen, more }, Math.max(40, (e.viewport?.columns ?? 100) - 4))
  return Box({
    flexDirection: 'column', marginTop: 1, marginLeft: 2, width: Math.max(p.grid.w, 40, words.length ? width : 0),
    children: [
      paintRegions(p.grid, els, { theme, key: `${key}-${ref.id}`, rows, onPress }),
      hintRow($, els, ref, verbs, `${key}-${ref.id}`, { fullscreen, at, more, said, words, focused: (await $.state.get(LAST)).value?.id === ref.id }),
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

// a citation's target may hold spaces (a query's key, as in q9#kind=SEC via proxy@n); a link that is no kernel ref
// is left as Claude wrote it
const LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g

/** Claude's citations in a reply: each kernel ref it links, once, with the words that link it. */
function citesIn(md: string): { ref: string; label: string }[] {
  const out: { ref: string; label: string }[] = []
  for (const m of String(md).matchAll(LINK)) {
    const ref = String(m[2])
    if (/^(https?|file):/i.test(ref) || !isRef(ref) || out.some(c => c.ref === ref)) continue
    // a citation whose words are only a mark (`[↗](rows.jsonl#L12)`) is named by its place
    const label = /[\p{L}\p{N}]/u.test(String(m[1])) ? String(m[1]) : ref.replace(/#L(\d+)/, ':$1').replace(/^obj:/, '')
    out.push({ ref, label })
  }
  return out
}

/** The reply as drawn: a citation reads as its words. */
function withoutTargets(md: string): string {
  return String(md).replace(LINK, (m, label: string, ref: string) => (/^(https?|file):/i.test(ref) || !isRef(ref) ? m : label))
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

export const registerShell: Register = (on, options) => {
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
      // a resumed session: its objects drawn under the same rows again
      await restoreShown($)
    } catch {
      // a session that cannot read its placements draws its new objects only
    }
    return r
  })

  // a turn of main's: the objects it saved, and its last text row, under which they are drawn
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) turn = { unplaced: [], lastRow: '', calls: [], placed: [] }
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
        const msg = e.message as { type?: string; content?: unknown }
        if (pendingAsk && e.door === 'prompt' && msg.type === 'user') {
          await $.state.set({ ...ASKED, id: rowKey(stored.uuid) }, pendingAsk.about)
          pendingAsk = null
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
    if (e.agentId === undefined) turn = null
    return done
  })

  // the reply with its citations as their words (Claude Code draws a link that is no URL as its words and its target),
  // then one quiet row naming the cited values, each a press away from its rows; then the objects its turn saved
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const at = rowKey(e.requestId)
    const list = ((await $.state.get({ ...UNDER, id: at })).value ?? []) as ObjRef[]
    const cites = e.props.isSummary ? [] : citesIn(e.props.text)
    // browser mode on: every reply carries `o browser`, the mirror opened at this reply
    const web = browserFlag && !e.props.isSummary
    if (!list.length && !cites.length && !web) return next(e)
    const els = $.ui.resolve(e) as Any
    const { Box, Text, Button } = els
    let own = await next(cites.length ? { ...e, props: { ...e.props, text: withoutTargets(e.props.text) } } : e)
    const webChip = () => browserChip(els, `web-${at}`, async () => $.ui.toast(await openBrowser($, { row: at })))
    if (web && !cites.length) own = Box({ flexDirection: 'column', children: [own, Box({ flexDirection: 'row', marginLeft: 2, children: [webChip()] })] })
    if (cites.length) {
      // a few citations by their words, each a press from its rows; more than fit calmly, one press to their list
      const room = Math.min(72, Math.max(20, (e.viewport?.columns ?? 100) - 12))
      const label = (c: { label: string }) => cut(c.label.replace(/`/g, ''), 32)
      const words = cites.reduce((n, c) => n + [...label(c)].length + 3, 6)
      const fits = cites.length <= 4 && words <= room
      const chips: Any[] = fits
        ? [Text({ dimColor: true, children: 'cites ' }), ...cites.flatMap((c, i) => [
            ...(i ? [Text({ dimColor: true, children: ' · ' })] : []),
            Button({ key: `cite-${at}-${i}`, plain: true, label: c.label, children: [Text({ color: 'suggestion', children: label(c) })], onPress: () => openCite($, c.ref, c.label) }),
          ])]
        : [Button({ key: `cites-${at}`, plain: true, label: 'cited values', children: [Text({ dimColor: true, children: `${cites.length} cited values ` }), Text({ color: 'suggestion', children: '›' })], onPress: () => openCites($, cites) })]
      if (web) chips.push(Text({ dimColor: true, children: ' · ' }), webChip())
      own = Box({ flexDirection: 'column', children: [own, Box({ flexDirection: 'row', marginLeft: 2, children: chips })] })
    }
    if (!list.length) return own
    const drawn = await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `row-${at}-${i}`, at)))
    return Box({ flexDirection: 'column', children: [own, ...drawn] })
  })

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
      const open = !e.isMeta && (await $.ui.panes()).some(x => x.id === PANE && x.isPlaced)
      if (sel && open && sel.cite) {
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
    if (e.props.command !== 'verb' || e.props.isErrored) return next(e)
    const at = `cmd|${e.props.args.trim().slice(0, 300)}`
    const list = ((await $.state.get({ ...UNDER, id: at })).value ?? []) as ObjRef[]
    if (!list.length) return next(e)
    const { Box } = $.ui.resolve(e) as Any
    const own = await next(e)
    const drawn = await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `verb-${e.requestId.slice(-10)}-${i}`, at)))
    return Box({ flexDirection: 'column', children: [own, ...drawn] })
  })

  // the detail view (detail.tsx)
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    markOpen(true)
    return detailPane($, e)
  })
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
}

export { isRef }
