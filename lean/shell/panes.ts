// panes.ts: the terminal's host for programs on the card runtime that thimble itself writes (lean/panes/): the Claims
// graph, the squeeze chips, the card detail. A pane is a program like a card: its data comes from thimble's own stores,
// its state is kept where the browser reads it too, what the person does reaches it through k.on, and it draws through
// the same renderer as a card. The browser runs the same program file (shell/browser/src/panes/) on the same stores.
//
//   paneDraw($, name, args, size)        the program run on its stores and state now: its drawing
//   paneTakes($, name, args, event)       whether the program takes the event, with nothing run (a key's answer)
//   paneTry($, name, args, event)         what the program would answer to the event, nothing of it kept
//   paneFire($, name, args, event)        what the person did, as the program's event: true when the program took it.
//                                         The state it answers with is kept (thimble/panes/<session>/<key>.json), its
//                                         actions run (k.do), its later events wait (k.after), its asks are kept
//   paneEl($, e, name, args, o)          the drawing as Claude Code elements: each part a press, the ring a focus event
//                                         (o.painted: drawn in a pane of Claude Code's, on the theme's background)
//   paneKeys(name, args)                 its last drawing, for the bar (panes/host.js keysOf)
//   setPaneState($, name, args, state)   a state another surface answered with (the browser): kept, and drawn here
//   shell.tsx gives what a pane reads and may ask for, by name: paneStore (each store), paneAction (what k.do asks),
//   paneWant (what k.want asks) and paneWhere (the session's folder). A hooks module passes `$` only to functions it
//   declares or imports, so these are imported, not handed in.
//
// The program is thimble's own code, so it runs here, in the hooks module, as a function (a card's program, Claude's,
// runs only in the sandbox). Nothing here makes a model call: an action may (squeeze's rewrite), as its own module does.
import type { EngineInterface } from 'claude-code'

import '../draw/kit.js'
import { renderTerm } from '../draw/term.js'
import PANES from '../panes/index.js'
import { joinShared, localKeys, nextState, same, shared, takes, wantsOpen } from '../panes/host.js'
import { paintRegions, regionOfKey } from './cells'
import { paneAction, paneStateChanged, paneStore, paneWant, paneWhere } from './shell'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
export type Size = { w: number; h: number }
export type Inst = {
  id: string
  name: string
  args: Record<string, unknown>
  state: Record<string, unknown>
  loaded: boolean
  drawing: Any | null
  size: Size | null
  got: Record<string, unknown>
  asked: Map<string, number>
  tries: Map<string, number>
  gen: Record<string, number>
  ask: Any | null
  data: { key: string; value: Any } | null
}
const VER = { plugin: 'thimble-lean', key: 'panever' } as const
const insts = new Map<string, Inst>()
/** A want with no answer after this long is asked again. */
const WANT_AGAIN_MS = 5000
let theme: () => 'dark' | 'light' = () => 'dark'

const kit = (): Any => (globalThis as Any).DrawKit
const safe = (s: string) => String(s).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120) || 'none'

export function setTheme(fn: () => 'dark' | 'light'): void {
  theme = fn
}

export function paneOf(name: string): Any {
  const p = (PANES as Any)[name]
  if (!p) throw new Error(`no pane ${name}`)
  return p
}

const keyOf = (name: string, args: Record<string, unknown>) => `${name}|${paneOf(name).stateKey(args || {})}`

export function instance(name: string, args: Record<string, unknown> = {}): Inst {
  const id = keyOf(name, args)
  let i = insts.get(id)
  if (!i) {
    i = { id, name, args: { ...args }, state: {}, loaded: false, drawing: null, size: null, got: {}, asked: new Map(), tries: new Map(), gen: {}, ask: null, data: null }
    insts.set(id, i)
  } else i.args = { ...i.args, ...args }
  return i
}

/** The file a pane's state is kept in: thimble/panes/<session>/<state key>.json, which the browser reads too. */
async function stateFile($: Engine, inst: Inst): Promise<string | null> {
  const w = await paneWhere($)
  if (!w.root) return null
  return `${w.root.replace(/\/+$/, '')}/thimble/panes/${safe(w.session)}/${safe(paneOf(inst.name).stateKey(inst.args))}.json`
}

async function load($: Engine, inst: Inst): Promise<void> {
  if (inst.loaded) return
  inst.loaded = true
  try {
    const f = await stateFile($, inst)
    if (f && (await $.fs.exists(f))) {
      const v = JSON.parse(String(await $.fs.read(f)))
      if (v && typeof v.state === 'object' && v.state) inst.state = shared(v.state, localOf(inst))
    }
  } catch {
    // no state kept yet: the pane opens at rest
  }
}

/** The state keys this pane keeps on this surface alone (a hover, a replay's frame): its module's and its program's. */
const localOf = (inst: Inst): string[] => localKeys(inst.drawing, paneOf(inst.name))

async function keep($: Engine, inst: Inst, by: string): Promise<void> {
  const f = await stateFile($, inst)
  if (!f) return
  try {
    // only what every surface shares: a hover or a replay stays where it was made
    await $.fs.write(f, JSON.stringify({ pane: inst.name, args: inst.args, state: shared(inst.state, localOf(inst)), at: new Date().toISOString(), by }, null, 1))
  } catch {
    // the other surface opens the pane where it was; this one keeps its own
  }
}

/** Ask every drawing of this pane to draw again. */
export async function redraw($: Engine, inst: Inst): Promise<void> {
  const v = ((await $.state.get({ ...VER, id: inst.id })).value as number | undefined) ?? 0
  await $.state.set({ ...VER, id: inst.id }, v + 1)
}

async function stores($: Engine, inst: Inst): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const name of paneOf(inst.name).reads(inst.args) as string[]) {
    const [kind, ...rest] = String(name).split(':')
    out[name] = await paneStore($, kind!, rest.join(':'))
  }
  return out
}

/** The program run on its stores and state now (with an event, the program answers it). `keep` false: the drawing is
 *  only read (paneTry), never kept as the pane's last, and its wants are not asked. */
export async function paneRun($: Engine, name: string, args: Record<string, unknown>, size: Size, event: Record<string, unknown> | null = null, keep = true): Promise<Any> {
  const inst = instance(name, args)
  await load($, inst)
  await $.state.get({ ...VER, id: inst.id })
  const pane = paneOf(name)
  const st = await stores($, inst)
  const key = `${size.w}x${size.h}|${JSON.stringify(st)}`
  if (!inst.data || inst.data.key !== key) inst.data = { key, value: pane.data(st, inst.args, size) }
  inst.size = size
  const drawing = kit().run(pane.program, inst.data.value, { w: size.w, h: size.h, state: inst.state, event, mode: 'pane', surface: 'terminal', got: inst.got, title: pane.title, id: name })
  if (!keep) return drawing
  if (!drawing?.error) inst.drawing = drawing
  // what the program wants that is not in hand: read once, outside the drawing, and drawn again with it
  const open = wantsOpen(drawing, inst.got)
  const now = open.length ? await $.clock.now() : 0
  for (const w of open) {
    // asked once; asked again when no answer came for a while (a read lost with an abandoned drawing or a reload of
    // the module), and after three asks with no answer the program gets the failure, which it says in one line
    const at = inst.asked.get(w.key)
    if (at != null && now - at < WANT_AGAIN_MS) continue
    const tries = (inst.tries.get(w.key) ?? 0) + 1
    inst.tries.set(w.key, tries)
    inst.asked.set(w.key, now)
    if (tries > 3) {
      inst.got = { ...inst.got, [w.key]: { error: 'no answer came after three tries; close this and open it again', problem: 'no answer came after three tries; close this and open it again' } }
      $.clock.after(0, () => { void redraw($, inst) })
      continue
    }
    $.clock.after(0, () => {
      void (async () => {
        let v: unknown
        try { v = await paneWant($, inst.name, inst.args, w.request) } catch (err) { v = { error: String((err as Error)?.message || err).slice(0, 200) } }
        inst.got = { ...inst.got, [w.key]: v === undefined ? { error: 'the host gave no answer' } : v }
        await redraw($, inst)
      })()
    })
    // a drawing again a while later if no answer came, so the want is asked again even when nothing else redraws
    $.clock.after(WANT_AGAIN_MS + 200, () => {
      if (!Object.prototype.hasOwnProperty.call(inst.got, w.key)) void redraw($, inst)
    })
  }
  return drawing
}

/** The pane run now on its stores and state, at the size it was last drawn (for the bar: its keys and status as they
 *  stand, even before the pane draws again). */
export async function paneNow($: Engine, name: string, args: Record<string, unknown> = {}): Promise<Any> {
  const inst = instance(name, args)
  return paneRun($, name, args, inst.size ?? { w: 100, h: 30 })
}

/** The pane's drawing now, as last drawn (for the bar), or null. */
export function paneDrawing(name: string, args: Record<string, unknown> = {}): Any | null {
  try { return insts.get(keyOf(name, args))?.drawing ?? null } catch { return null }
}

/** Whether the program takes the event now, as paneFire decides it (the handlers of its last drawing), with nothing
 *  run for it: a key's answer is decided from reads alone (keys.ts). */
export async function paneTakes($: Engine, name: string, args: Record<string, unknown>, event: Record<string, unknown>): Promise<boolean> {
  const inst = instance(name, args)
  await load($, inst)
  const known = inst.drawing ?? (await paneRun($, name, args, inst.size ?? { w: 100, h: 30 }))
  return takes(known, event)
}

/** What the program would answer to the event now, nothing of it kept (its state, actions and later events are
 *  paneFire's to apply): null when it does not take the event. */
export async function paneTry($: Engine, name: string, args: Record<string, unknown>, event: Record<string, unknown>): Promise<Any | null> {
  if (!(await paneTakes($, name, args, event))) return null
  return paneRun($, name, args, instance(name, args).size ?? { w: 100, h: 30 }, event, false)
}

/** What the person did, as the program's event. True when the program took it. */
export async function paneFire($: Engine, name: string, args: Record<string, unknown>, event: Record<string, unknown>, by = 'terminal'): Promise<boolean> {
  const inst = instance(name, args)
  await load($, inst)
  const size = inst.size ?? { w: 100, h: 30 }
  // a drawing to learn the handlers from: the last, else one now
  const known = inst.drawing ?? (await paneRun($, name, args, size))
  if (!takes(known, event)) return false
  const d = await paneRun($, name, args, size, event)
  if (d?.error) { $.ui.toast(`× ${paneOf(name).title} could not answer: ${d.error.name} · fix: ${d.error.fix || 'its program'}`); return true }
  await answered($, inst, d, by)
  return true
}

/** What a program answered with: its state kept, its actions run, its later events set, its ask kept. */
async function answered($: Engine, inst: Inst, d: Any, by: string): Promise<void> {
  const next = nextState(inst.state, d)
  const keys = localKeys(d, paneOf(inst.name))
  const changed = !same(next, inst.state)
  // a change of what every surface shares is kept for the other surface; a change of this surface's own keys is not
  const sharedChanged = !same(shared(next, keys), shared(inst.state, keys))
  inst.state = next
  if (d.ask) inst.ask = d.ask
  for (const a of (d.after || []) as { ms: number; event: Record<string, unknown> }[]) later($, inst, a.ms, a.event)
  if (changed) {
    await redraw($, inst)
    if (sharedChanged) {
      $.clock.after(0, () => { void keep($, inst, by) })
      await paneStateChanged($, inst.name, inst.args, inst.state)
    }
  }
  for (const eff of (d.effects || []) as Record<string, unknown>[]) await act($, inst, eff)
}

/** One event later (k.after): the newest asked for a name replaces the one waiting. */
function later($: Engine, inst: Inst, ms: number, event: Record<string, unknown>): void {
  const name = String(event.type)
  const gen = (inst.gen[name] = (inst.gen[name] ?? 0) + 1)
  $.clock.after(Math.max(30, ms), () => {
    if (inst.gen[name] !== gen) return
    void paneFire($, inst.name, inst.args, event).catch(() => undefined)
  })
}

/** An action a program asked for (k.do), done by shell.tsx's paneAction. One the host does not have says so. */
export async function act($: Engine, inst: Inst, eff: Record<string, unknown>): Promise<void> {
  const name = String(eff.do || '')
  try {
    const said = await paneAction($, inst.name, inst.args, eff)
    if (said === false) $.ui.toast(`× ${paneOf(inst.name).title}: the terminal has no action "${name}". Use the keys in the thimble line instead.`)
    else if (typeof said === 'string' && said) $.ui.toast(said)
  } catch (err) {
    $.ui.toast(`× ${paneOf(inst.name).title}: ${name} failed (${String((err as Error)?.message || err).slice(0, 160)}). Try again, or press esc.`)
  }
}

/** A state the browser's run of the same program answered with: kept here, and drawn. */
export async function setPaneState($: Engine, name: string, args: Record<string, unknown>, state: Record<string, unknown>, by = 'browser'): Promise<void> {
  const inst = instance(name, args)
  await load($, inst)
  // what the other surface shares, with this surface's own hover and replay kept
  const keys = localOf(inst)
  const next = joinShared(inst.state, state, keys)
  if (same(next, inst.state)) return
  inst.state = next
  await redraw($, inst)
  await keep($, inst, by)
  await paneStateChanged($, name, args, inst.state)
}

/** A state set by the host itself (opening a pane on a part): kept and drawn. */
export async function patchPaneState($: Engine, name: string, args: Record<string, unknown>, patch: Record<string, unknown>): Promise<void> {
  const inst = instance(name, args)
  await load($, inst)
  await setPaneState($, name, args, { ...inst.state, ...patch }, 'terminal')
}

export async function paneState($: Engine, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const inst = instance(name, args)
  await load($, inst)
  return inst.state
}

/** The ask the program left for the next question (k.ask), taken once. */
export function takeAsk(name: string, args: Record<string, unknown> = {}): Any | null {
  const i = insts.get(keyOf(name, args))
  const a = i?.ask ?? null
  if (i) i.ask = null
  return a
}

/** The drawing as Claude Code elements: each part a press (a click), and the ring's place a focus event. */
export async function paneEl($: Engine, e: Any, name: string, args: Record<string, unknown>, size: Size, o: { frame?: string | null; painted?: boolean } = {}): Promise<Any> {
  const els = $.ui.resolve(e) as Any
  const d = await paneRun($, name, args, size)
  const grid = renderTerm(d, { w: size.w })
  return paintRegions(grid, els, {
    theme: theme(), key: `p-${name}`, frame: o.frame ?? null, painted: !!o.painted,
    onPress: (id: string, dir?: number) => { void paneFire($, name, args, { type: 'press', region: id, ...(dir ? { dir } : {}) }) },
  })
}

/** The ring moved onto a part of a pane (Claude Code's focus): the program's focus event. */
export async function paneFocus($: Engine, name: string, args: Record<string, unknown>, element: string): Promise<boolean> {
  const region = regionOfKey(element)
  if (!region) return false
  return paneFire($, name, args, { type: 'focus', region })
}

/** A pane closed: its later events stop; its state stays for the next open and the browser. */
export function paneClosed(name: string, args: Record<string, unknown> = {}): void {
  const i = insts.get(keyOf(name, args))
  if (!i) return
  for (const k of Object.keys(i.gen)) i.gen[k]! += 1
}

/** For tests: the module's memory, cleared. */
export function resetPanes(): void {
  insts.clear()
}
