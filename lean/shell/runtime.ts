// runtime.ts: the terminal's side of the card runtime (draw/kit.js). A card is a program; what the person does in its
// open detail reaches the program as an event, the state the program answers with is kept where every surface reads
// it, and an ask(selection) from inside the card opens the card's side thread scoped to what is selected.
//
//   cardKey(drawing, key)          the handler name a key reaches in this card, or null: the card's keys come before
//                                  the detail's letters, never before esc, ↑↓, tab, ↵ or 0
//   pressTaken(drawing, region)    whether a press on a part reaches the program (k.on('press:<id>'), or 'press')
//   cardEvent($, sel, event, size) the program run once more with the event: {drawing, state, ask}
//   readCardState / writeCardState the card's interaction state, thimble/objects/.state/<id>.json: {state, region, at,
//                                  by}. The terminal writes it as the person turns, presses or selects; the browser's
//                                  page posts its own; each surface opens a card where the other left it.
//
// The program runs only in the drawing contract's sandbox (shell/node/prep.mjs, draw/sandbox-node.mjs), as a drawing
// does: an event changes nothing but the card's state and, on an ask, opens a thread the person then types into.
import type { EngineInterface } from 'claude-code'

import type { Sel } from '../types'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
export type CardAsk = { label: string; region?: string; refs?: string[]; text?: string; note?: string }
export type CardState = { state: Record<string, unknown>; region: string | null; at?: string; by?: string }

// keys the detail keeps whatever a card says: leaving, moving between parts, opening details, clearing
const KEPT = new Set(['esc', 'escape', 'up', 'down', 'tab', 'shift+tab', 'return', 'enter', '0'])
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/

/** A key as a card's handler names it: ' ' is 'space'. */
export function keyName(key: string): string {
  return key === ' ' ? 'space' : String(key || '')
}

/** The handler name a key reaches in this card, or null. */
export function cardKey(drawing: Any, key: string): string | null {
  const k = keyName(key)
  if (!k || KEPT.has(k)) return null
  const on = Array.isArray(drawing?.on) ? drawing.on : []
  return on.some((h: Any) => h.name === k || h.name === 'key') ? k : null
}

/** Whether a press on part `region` reaches the program (a part of one page of a card drawn all at once, `pg3~~x`, as
 *  the part `x`; a page's heading never). */
export function pressTaken(drawing: Any, region: string): boolean {
  const on = Array.isArray(drawing?.on) ? drawing.on : []
  const page = /^pg\d+~~(.*)$/.exec(String(region))
  if (page && !page[1]) return false
  const own = page ? page[1] : region
  return on.some((h: Any) => h.name === `press:${own}` || h.name === 'press')
}

/** The card's own keys, as the bar says them: "j next run · k previous run". */
export function cardKeysHint(drawing: Any): string[] {
  const on = Array.isArray(drawing?.on) ? drawing.on : []
  return on.filter((h: Any) => !/^(press|brush|key)(:|$)/.test(h.name) && !KEPT.has(h.name)).slice(0, 6).map((h: Any) => `${h.name === 'space' ? 'space' : h.name}${h.label ? ' ' + h.label : ''}`)
}

/** The state a surface keeps for a card: the program's, without what the host adds for it (`browser`). */
export function ownState(state: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(state || {})) if (k !== 'browser') out[k] = v
  return out
}

/** The program run once more with an event: it learns its handlers, the one the event reaches patches the state, and
 *  it draws again with it. `size.all`: the card is drawn with every page of that knob at once (its parts' ids are its
 *  pages', and the kit reads them back). */
export async function cardEvent($: Engine, object: Any, sel: Sel, event: Record<string, unknown>, size: { w: number; h: number; all?: string | null }, mode = 'detail'): Promise<{ drawing: Any; state: Record<string, unknown>; ask: CardAsk | null } | null> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `${dir}/shell/node/prep.mjs`], {
    stdin: JSON.stringify({ object, w: size.w, h: size.h, state: { ...(sel.state || {}) }, mode, event, ...(size.all ? { all: size.all } : {}) }),
    timeoutMs: 30000,
  })
  if (r.exitCode !== 0) return null
  const drawing = JSON.parse(r.stdout).drawing
  if (!drawing || drawing.error) return { drawing, state: ownState(sel.state), ask: null }
  return { drawing, state: ownState(drawing.state ?? sel.state), ask: drawing.ask ?? null }
}

export const stateFile = (root: string, id: string) => `${root.replace(/\/+$/, '')}/thimble/objects/.state/${id}.json`
const CARDVER = { plugin: 'thimble', key: 'cardver' } as const

/** A card's state as a drawing reads it: the drawing draws again when either surface changes it. */
export async function cardStateNow($: Engine, root: string, id: string): Promise<CardState | null> {
  await $.state.get({ ...CARDVER, id: `${root}|${id}` })
  return readCardState($, root, id)
}

export async function readCardState($: Engine, root: string, id: string): Promise<CardState | null> {
  if (!ID.test(id)) return null
  const f = stateFile(root, id)
  try {
    if (!(await $.fs.exists(f))) return null
    const v = JSON.parse(String(await $.fs.read(f)))
    return v && typeof v === 'object' ? { state: v.state && typeof v.state === 'object' ? v.state : {}, region: typeof v.region === 'string' ? v.region : null, at: v.at, by: v.by } : null
  } catch {
    return null
  }
}

/** Keep a card's state where every surface reads it, when it changed. */
export async function writeCardState($: Engine, root: string, id: string, st: { state?: Record<string, unknown> | null; region?: string | null }, by = 'terminal'): Promise<void> {
  if (!ID.test(id)) return
  const want = { state: ownState(st.state), region: st.region ?? null }
  const was = await readCardState($, root, id)
  if (was && JSON.stringify({ state: was.state, region: was.region }) === JSON.stringify(want)) return
  try {
    await $.fs.write(stateFile(root, id), JSON.stringify({ ...want, at: new Date().toISOString(), by }, null, 1))
    await $.state.set({ ...CARDVER, id: `${root}|${id}` }, Date.now())
  } catch {
    // the other surface opens the card where it was; this one keeps its own
  }
}

// ---------------------------------------------------------------- the versions the person saw
// A card saved several times in one turn (Claude fixing it before its reply was done) was seen once, at the version
// drawn under the finished reply. thimble/objects/.seen/<id>.json lists the versions the person could see: the one a
// turn of main's left under its reply, a label's new version drawn in place, the latest the detail drew. The detail's
// header lists those; the others are drafts, still a key away (carddetail.js versionsOf).

export const seenFile = (root: string, id: string) => `${root.replace(/\/+$/, '')}/thimble/objects/.seen/${id}.json`

/** The versions of a card the person could see, oldest first; null for a card with no record (one saved before the
 *  record was kept), whose versions all count. */
export async function readSeen($: Engine, root: string, id: string): Promise<number[] | null> {
  if (!ID.test(id)) return null
  try {
    const f = seenFile(root, id)
    if (!(await $.fs.exists(f))) return null
    const v = JSON.parse(String(await $.fs.read(f)))
    return Array.isArray(v?.seen) ? v.seen.map(Number).filter((x: number) => Number.isInteger(x)) : null
  } catch {
    return null
  }
}

/** Version `v` of a card was where the person could see it. */
export async function noteSeen($: Engine, root: string, id: string, v: number | null | undefined): Promise<void> {
  if (!ID.test(id) || v == null || !Number.isInteger(Number(v))) return
  const was = (await readSeen($, root, id)) ?? []
  if (was.includes(Number(v))) return
  try {
    await $.fs.write(seenFile(root, id), JSON.stringify({ seen: [...was, Number(v)].sort((a, b) => a - b), at: new Date().toISOString() }, null, 1))
  } catch {
    // the header lists every version then, as before
  }
}
