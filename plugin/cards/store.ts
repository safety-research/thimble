// store.ts: what thimble keeps of each card, in $.state for drawing and on disk for a resumed session or a runner
// that starts again.
//
//   <conversation folder>/cards/<card id>/   (core/layout.mjs)
//     meta.json           the card: id, version, title, the call that drew it first, its anchor, keys, what it read, ...
//     v<version>/view.js   the view of the version on screen, and of a later call's version that did not draw
//     v<version>/rows.json the copy of the rows it read (the file Claude gave can change or go away)
//     state.json          the person's state of that version (what the view set with setState)
//
//   $.state: card (meta, by id), cardTree (the runner's drawings, by id: one for each width and theme it is drawn at), cardFocus (the card that takes keys first),
//   cardSeen (the cards drawn on screen since the plugin loaded), cardsAt (the cards drawn under an answer, by the
//   answer's row), cardCall (the card each call drew or changed, by the call's tool_use_id)
//
// A card's id comes from the call that first drew it, so a resumed session finds a card from its call's row alone.
import { update, type EngineInterface } from 'claude-code'

import { keptDir } from '../core/env'
import type { Theme } from '../core/theme'
import { tempDir } from '../core/home'
import { shortHash } from '../core/layout.mjs'

type Engine = EngineInterface

/** One call of the card tool: the version it drew, with that version's title, data file and what it read from it
 *  ("412 rows", "an object with months (18), agents (44)"), or why it drew none. */
export type CardCall = { version: number; title?: string; file?: string; read?: string; error?: string; down?: boolean }
export type CardMeta = {
  id: string
  version: number // the version on screen; 0 while no version has drawn
  last?: number // the folder of the last call's view and rows: the version on screen, or the next one when that call did not draw
  lastFile?: string // the data file of the last call, as Claude named it
  title: string
  toolUseId: string // the call of main's the card draws under: the one that drew its first version, unless Claude Code could not draw it there again (draw.ts canRedraw)
  turn?: string // main's turn of that call
  agentId: string | null // the fork that drew the version on screen (a designer's), or null for main
  anchorRow: string | null // the answer a designer fork's card draws under
  inRow?: string | null // the text row of main's that places the card on a line of its own (marks/message.js cardRef), where it draws instead of under its call
  callsBeforeRow?: string[] // the calls of the card made before that row, which point down to it; a later call points up
  keys: string[]
  read: string // what the version on screen read from its file, as CardCall says it
  columns: string[]
  file: string // the data file as Claude named it
  gen: number // bumps with each version, so a drawing of an older one is not shown
  error: string | null // the view's last failure on an event the person made
  errorWidth?: number | null // the width a drawing failed at, when the failure was a drawing's: it holds only at that width
  calls: Record<string, CardCall> // each call of the card, by its tool_use_id
  at: number
}
/** The runner's drawing of a card: `seq` is the runner's answer it came from, so an older answer never replaces it.
 *  `width`, `theme` and `tree` are the runner's newest drawing, at the width the runner holds the card at, for a
 *  terminal theme (core/theme.ts; absent in a drawing kept before themes: dark); `others` are its drawings at other
 *  widths or for the other theme (the card's copy in a side pane, the conversation before the pane opened, the theme
 *  before the person changed it) of the same state, by `<width>:<theme>`; `since` is the answer that last changed the
 *  state, and a drawing older than it is gone. */
export type CardTree = { gen: number; width: number; tree: unknown; seq: number; theme?: Theme; since?: number; others?: Record<string, { tree: unknown; seq: number }> }
/** A card's drawing at one width, for one theme. */
export type CardDrawing = { gen: number; width: number; tree: unknown; seq: number; theme?: Theme }

/** The drawings at other widths and themes a card keeps, the newest first. */
const OTHERS = 4

const CARD = { plugin: 'thimble', key: 'card' } as const
const TREE = { plugin: 'thimble', key: 'cardTree' } as const
const FOCUS = { plugin: 'thimble', key: 'cardFocus' } as const
const SEEN = { plugin: 'thimble', key: 'cardSeen' } as const
const AT = { plugin: 'thimble', key: 'cardsAt' } as const
const CALL = { plugin: 'thimble', key: 'cardCall' } as const

const ID = /^c[0-9a-f]{8,16}$/
export const isCardId = (id: string) => ID.test(id)

/** A card's id from the tool_use_id of the call that first drew it. */
export const cardIdOf = (toolUseId: string): string => `c${shortHash(toolUseId)}`

/** The folder of this conversation's cards. */
export async function cardsDir($: Engine): Promise<string> {
  return `${await keptDir($)}/cards`
}

export async function cardDir($: Engine, id: string): Promise<string> {
  return `${await cardsDir($)}/${id}`
}

export async function versionDir($: Engine, id: string, version: number): Promise<string> {
  return `${await cardDir($, id)}/v${version}`
}

/** Whether a path lands inside the temp folder, where Claude writes a card's rows: its real path, every link followed,
 *  is the temp folder or under it (core/home.ts tempDir, a real path). A file not there yet lands by its folder's real path;
 *  a link that leads nowhere does not land, since a write through it makes a file where it points. */
export async function inTemp($: Engine, path: unknown): Promise<boolean> {
  const p = typeof path === 'string' ? path : ''
  if (!p.startsWith('/')) return false
  const real = await realOf($, p)
  const temp = await tempDir($)
  return real !== undefined && (real === temp || real.startsWith(`${temp}/`))
}

async function realOf($: Engine, p: string): Promise<string | undefined> {
  const own = await $.fs.stat(p, { resolve: true }).catch(() => null)
  if (own) return own.realPath
  const cut = p.lastIndexOf('/')
  const name = p.slice(cut + 1)
  if (!name || name === '.' || name === '..') return undefined
  const dir = await $.fs.stat(p.slice(0, cut) || '/', { resolve: true }).catch(() => null)
  return dir?.realPath === undefined ? undefined : `${dir.realPath.replace(/\/$/, '')}/${name}`
}

// ------------------------------------------------------------------------------------------------- $.state
// (Claude Code lists each value a module reads and writes from the references in that file, so every read and write
// of the cards' values is here.)

export async function treeOf($: Engine, id: string): Promise<CardTree | null> {
  return ((await $.state.get({ ...TREE, id })).value ?? null) as CardTree | null
}

// a drawing's place among a card's: its width and theme (a key with no theme, kept before themes, is dark)
const placeOf = (width: number, theme: Theme | undefined) => `${width}:${theme ?? 'dark'}`
const parsePlace = (k: string): { width: number; theme: Theme } => {
  const [w, th] = k.split(':')
  return { width: Number(w), theme: th === 'light' ? 'light' : 'dark' }
}

/** A card's drawing laid out at `width` for version `gen`, or null when it has none: the one for `theme`, else the one
 *  at that width for the other theme (drawn until the one for this theme comes; its `theme` says which it is). A
 *  drawing laid out at another width is never drawn in its place. */
export function drawingAt(t: CardTree | null | undefined, gen: number, width: number, theme: Theme = 'dark'): CardDrawing | null {
  if (!t || t.gen !== gen) return null
  const all: Record<string, { tree: unknown; seq: number }> = {}
  for (const [k, d] of Object.entries(t.others ?? {})) all[placeOf(parsePlace(k).width, parsePlace(k).theme)] = d
  all[placeOf(t.width, t.theme)] = { tree: t.tree, seq: t.seq }
  const other: Theme = theme === 'light' ? 'dark' : 'light'
  for (const th of [theme, other]) {
    const d = all[placeOf(width, th)]
    if (d) return { gen, width, tree: d.tree, seq: d.seq, theme: th }
  }
  return null
}

/** A drawing of the runner's added to the card's: an answer to an event (`changed`: a key, a click, a new version)
 *  changed the state, and the drawings older than it go; a drawing at a width or for a theme (not `changed`) keeps the
 *  drawings at other widths and for the other theme. An answer older than the drawing kept at its width and theme, or
 *  than the last change, is dropped. The runner's width and theme are those of its newest answer. */
export function withDrawing(cur: CardTree | null | undefined, t: CardDrawing, changed: boolean): CardTree {
  const theme: Theme = t.theme ?? 'dark'
  if (!cur || cur.gen !== t.gen) return { gen: t.gen, width: t.width, tree: t.tree, seq: t.seq, theme, since: changed ? t.seq : 0, others: {} }
  const since = Math.max(cur.since ?? 0, changed ? t.seq : 0)
  const all: Record<string, { tree: unknown; seq: number }> = {}
  for (const [k, d] of Object.entries(cur.others ?? {})) all[placeOf(parsePlace(k).width, parsePlace(k).theme)] = d
  all[placeOf(cur.width, cur.theme)] = { tree: cur.tree, seq: cur.seq }
  const here = placeOf(t.width, theme)
  // (on a tie, which only answers with no seq make, the one that came last wins)
  const fresh = t.seq >= since && (all[here]?.seq ?? -1) <= t.seq
  if (fresh) all[here] = { tree: t.tree, seq: t.seq }
  const first = (k: string) => (fresh && k === here ? 1 : 0)
  const kept = Object.entries(all).filter(([, d]) => d.seq >= since).sort((a, b) => b[1].seq - a[1].seq || first(b[0]) - first(a[0]))
  if (!kept.length) return cur
  const [[k, top], ...rest] = kept as [[string, { tree: unknown; seq: number }], ...Array<[string, { tree: unknown; seq: number }]>]
  const at = parsePlace(k)
  return { gen: t.gen, width: at.width, tree: top.tree, seq: top.seq, theme: at.theme, since, others: Object.fromEntries(rest.slice(0, OTHERS)) }
}

/** The card's drawing, unless the one it holds at that width came from a newer answer of the runner's (withDrawing). */
export async function setTree($: Engine, id: string, t: CardDrawing, changed = true): Promise<void> {
  await update($, { ...TREE, id }, cur => withDrawing(cur as CardTree | undefined, t, changed))
}

// What a card key at an empty prompt reads (cards/draw.ts keyOwner): the cards seen, each card's meta and the focused
// card, as this module last wrote or read them. This module alone writes them, so the copy is the state's. Claude Code
// gives a key's hook a few milliseconds of its own time, and each read of the state costs some of it under load, so a
// key reads the copy (keptSeen, keptMeta, keptFocus) and no state. A drawing reads the state itself (seenNow, metaOf,
// focusNow), so a change draws again.
let seenKept: string[] | null = null
let focusKept: { id: string | null } | null = null
const metasKept = new Map<string, CardMeta | null>()

/** The cards drawn on screen since the plugin loaded: only they take keys. */
export async function seenNow($: Engine): Promise<string[]> {
  return ((await $.state.get(SEEN)).value ?? []) as string[]
}

export async function keptSeen($: Engine): Promise<string[]> {
  return seenKept ?? (seenKept = await seenNow($))
}

export async function markSeen($: Engine, id: string): Promise<void> {
  if (seenKept?.includes(id)) return
  let now: string[] = []
  await update($, SEEN, cur => (now = (cur ?? []).includes(id) ? cur ?? [] : [...(cur ?? []), id]))
  seenKept = now
}

export async function focusNow($: Engine): Promise<string | null> {
  return (await $.state.get(FOCUS)).value ?? null
}

export async function keptFocus($: Engine): Promise<string | null> {
  return (focusKept ?? (focusKept = { id: await focusNow($) })).id
}

async function writeFocus($: Engine, id: string | null): Promise<void> {
  await $.state.set(FOCUS, id)
  focusKept = { id }
}

export async function setFocus($: Engine, id: string): Promise<void> {
  if ((await $.state.get(FOCUS)).value !== id) await writeFocus($, id)
  else focusKept = { id }
}

/** The card a call of the card tool drew or changed. */
export async function callOf($: Engine, toolUseId: string): Promise<string | null> {
  return (((await $.state.get({ ...CALL, id: toolUseId })).value as { id?: string } | undefined)?.id) ?? null
}

/** The cards drawn under an answer, by its row, oldest first. */
export async function anchoredAt($: Engine, row: string): Promise<string[]> {
  return (((await $.state.get(AT)).value ?? {}) as Record<string, string[]>)[row] ?? []
}

export async function metaOf($: Engine, id: string): Promise<CardMeta | null> {
  if (!isCardId(id)) return null
  return ((await $.state.get({ ...CARD, id })).value ?? null) as CardMeta | null
}

export async function keptMeta($: Engine, id: string): Promise<CardMeta | null> {
  if (!metasKept.has(id)) metasKept.set(id, await metaOf($, id))
  return metasKept.get(id) ?? null
}

/** A card's meta, kept in $.state and on disk; each of its calls knows the card, and a card with an anchor joins the
 *  cards under that answer. */
export async function saveMeta($: Engine, meta: CardMeta): Promise<void> {
  await $.state.set({ ...CARD, id: meta.id }, meta)
  metasKept.set(meta.id, meta)
  for (const call of Object.keys(meta.calls)) {
    if (((await $.state.get({ ...CALL, id: call })).value as { id?: string } | undefined)?.id !== meta.id) await $.state.set({ ...CALL, id: call }, { id: meta.id })
  }
  if (meta.anchorRow && meta.version > 0) {
    const all = ((await $.state.get(AT)).value ?? {}) as Record<string, string[]>
    const ids = all[meta.anchorRow] ?? []
    if (!ids.includes(meta.id)) await $.state.set(AT, { ...all, [meta.anchorRow]: [...ids, meta.id] })
  }
  await $.fs.write(`${await cardDir($, meta.id)}/meta.json`, JSON.stringify(meta))
}

/** The person's state of a card's version on screen, as the runner last answered it (JSON text). */
export async function saveState($: Engine, id: string, version: number, state: string): Promise<void> {
  await $.fs.write(`${await cardDir($, id)}/state.json`, JSON.stringify({ version, state }))
}

export async function readState($: Engine, id: string, version: number): Promise<unknown> {
  try {
    const s = JSON.parse(String(await $.fs.read(`${await cardDir($, id)}/state.json`)))
    return s?.version === version && typeof s.state === 'string' ? JSON.parse(s.state) : null
  } catch {
    return null
  }
}

/** A /clear or a /resume (hooks/turnover.ts): no card of the earlier conversation takes keys or is drawn under an
 *  answer; the new conversation's cards are back (restoreCards). */
export async function turnCards($: Engine): Promise<void> {
  await writeFocus($, null)
  await $.state.set(SEEN, [])
  seenKept = []
  await $.state.set(AT, {})
  await restoreCards($)
}

/** The cards this conversation drew before (a resumed session, or a reload of the plugin): back in $.state, the
 *  newest drawn card focused. */
export async function restoreCards($: Engine): Promise<void> {
  const dir = await cardsDir($)
  let entries: { name: string; kind: string }[] = []
  try { entries = (await $.fs.list(dir)) as { name: string; kind: string }[] } catch { return }
  const metas: CardMeta[] = []
  for (const x of entries) {
    if (x.kind !== 'dir' || !isCardId(x.name)) continue
    try { metas.push(JSON.parse(String(await $.fs.read(`${dir}/${x.name}/meta.json`))) as CardMeta) } catch { /* a card whose first call never finished */ }
  }
  const at: Record<string, string[]> = {}
  for (const m of metas.sort((a, b) => a.at - b.at)) {
    await $.state.set({ ...CARD, id: m.id }, m)
    metasKept.set(m.id, m)
    for (const call of Object.keys(m.calls ?? {})) await $.state.set({ ...CALL, id: call }, { id: m.id })
    if (m.anchorRow && m.version > 0) (at[m.anchorRow] ??= []).push(m.id)
  }
  await $.state.set(AT, at)
  const newest = metas.filter(m => m.version > 0).pop()
  if (newest && !(await $.state.get(FOCUS)).value) await writeFocus($, newest.id)
}
