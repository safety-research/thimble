// store.ts: what thimble keeps of each card, in $.state for drawing and on disk for a resumed session or a runner
// that starts again.
//
//   <THIMBLE_HOME>/cards/<conversation>/<card id>/
//     meta.json           the card: id, version, title, the call that drew it first, its anchor, keys, rows, ...
//     v<version>/view.js   the view of the version on screen
//     v<version>/rows.json the copy of the rows it read (the file Claude gave can change or go away)
//     state.json          the person's state of that version (what the view set with setState) and its search
//
//   $.state: card (meta, by id), cardTree (the runner's drawing, by id), cardFocus (the card that takes keys),
//   cardSearch (the card a `/` search types into), cardsAt (the cards drawn under an answer, by the answer's row),
//   cardCall (the card each call drew or changed, by the call's tool_use_id)
//
// A card's id comes from the call that first drew it, so a resumed session finds a card from its call's row alone.
import type { EngineInterface } from 'claude-code'

import { thimbleHome } from '../core/env'
import { sessionKey } from '../hooks/conversation'

type Engine = EngineInterface

/** One call of the card tool: the version it drew, with that version's title, data file and rows, or why it drew none. */
export type CardCall = { version: number; title?: string; file?: string; rows?: number; error?: string }
export type CardMeta = {
  id: string
  version: number // the version on screen; 0 while no version has drawn
  title: string
  toolUseId: string // the call that drew its first version: it draws under that call
  agentId: string | null
  anchorRow: string | null // the answer a designer fork's card draws under
  keys: string[]
  rows: number
  columns: string[]
  file: string // the data file as Claude named it
  gen: number // bumps with each version, so a drawing of an older one is not shown
  error: string | null // the view's last failure on an event the person made
  calls: Record<string, CardCall> // each call of the card, by its tool_use_id
  at: number
}
export type CardTree = { gen: number; width: number; tree: unknown; pointer: boolean }

const CARD = { plugin: 'thimble', key: 'card' } as const
const TREE = { plugin: 'thimble', key: 'cardTree' } as const
const FOCUS = { plugin: 'thimble', key: 'cardFocus' } as const
const SEARCH = { plugin: 'thimble', key: 'cardSearch' } as const
const AT = { plugin: 'thimble', key: 'cardsAt' } as const
const CALL = { plugin: 'thimble', key: 'cardCall' } as const

const ID = /^c[0-9a-f]{8,16}$/
export const isCardId = (id: string) => ID.test(id)

/** A card's id from the tool_use_id of the call that first drew it. */
export function cardIdOf(toolUseId: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x9747b28c
  for (let i = 0; i < toolUseId.length; i++) {
    const c = toolUseId.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return `c${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0').slice(0, 4)}`
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'none'

/** The folder of this conversation's cards. */
export async function cardsDir($: Engine): Promise<string> {
  return `${await thimbleHome($)}/cards/${safe(await sessionKey($))}`
}

export async function cardDir($: Engine, id: string): Promise<string> {
  return `${await cardsDir($)}/${id}`
}

export async function versionDir($: Engine, id: string, version: number): Promise<string> {
  return `${await cardDir($, id)}/v${version}`
}

// the cards under each answer, as v asks for them while it writes main's note (cardsUnder); $.state holds the same
const under = new Map<string, string[]>()

export function cardsAtNow(row: string): string[] {
  return under.get(row) ?? []
}

// ------------------------------------------------------------------------------------------------- $.state
// (Claude Code lists each value a module reads and writes from the references in that file, so every read and write
// of the cards' values is here.)

export async function treeOf($: Engine, id: string): Promise<CardTree | null> {
  return ((await $.state.get({ ...TREE, id })).value ?? null) as CardTree | null
}

export async function setTree($: Engine, id: string, t: CardTree): Promise<void> {
  await $.state.set({ ...TREE, id }, t)
}

export async function focusNow($: Engine): Promise<string | null> {
  return (await $.state.get(FOCUS)).value ?? null
}

export async function setFocus($: Engine, id: string): Promise<void> {
  if ((await $.state.get(FOCUS)).value !== id) await $.state.set(FOCUS, id)
}

export type CardSearch = { id: string; text: string; kept?: boolean }

export async function searchNow($: Engine): Promise<CardSearch | null> {
  return (await $.state.get(SEARCH)).value ?? null
}

export async function setSearch($: Engine, s: CardSearch | null): Promise<void> {
  await $.state.set(SEARCH, s)
}

/** The card a call of the card tool drew or changed. */
export async function callOf($: Engine, toolUseId: string): Promise<string | null> {
  return (((await $.state.get({ ...CALL, id: toolUseId })).value as { id?: string } | undefined)?.id) ?? null
}

/** The cards drawn under an answer, by its row. */
export async function anchoredAt($: Engine, row: string): Promise<string[]> {
  return (((await $.state.get(AT)).value ?? {}) as Record<string, string[]>)[row] ?? []
}

export async function metaOf($: Engine, id: string): Promise<CardMeta | null> {
  if (!isCardId(id)) return null
  return ((await $.state.get({ ...CARD, id })).value ?? null) as CardMeta | null
}

/** A card's meta, kept in $.state and on disk; each of its calls knows the card, and a card with an anchor joins the
 *  cards under that answer. */
export async function saveMeta($: Engine, meta: CardMeta): Promise<void> {
  await $.state.set({ ...CARD, id: meta.id }, meta)
  for (const call of Object.keys(meta.calls)) {
    if (((await $.state.get({ ...CALL, id: call })).value as { id?: string } | undefined)?.id !== meta.id) await $.state.set({ ...CALL, id: call }, { id: meta.id })
  }
  if (meta.anchorRow && meta.version > 0) {
    const all = ((await $.state.get(AT)).value ?? {}) as Record<string, string[]>
    const ids = all[meta.anchorRow] ?? []
    if (!ids.includes(meta.id)) {
      const next = { ...all, [meta.anchorRow]: [...ids, meta.id] }
      under.set(meta.anchorRow, next[meta.anchorRow]!)
      await $.state.set(AT, next)
    }
  }
  await $.fs.write(`${await cardDir($, meta.id)}/meta.json`, JSON.stringify(meta))
}

/** The person's state of a card's version on screen, and its search, as the runner last answered them. */
export async function saveState($: Engine, id: string, version: number, state: string, query: string | null): Promise<void> {
  await $.fs.write(`${await cardDir($, id)}/state.json`, JSON.stringify({ version, state, query }))
}

export async function readState($: Engine, id: string, version: number): Promise<{ state: unknown; query: string | null }> {
  try {
    const s = JSON.parse(String(await $.fs.read(`${await cardDir($, id)}/state.json`)))
    if (s?.version !== version) return { state: null, query: null }
    return { state: typeof s.state === 'string' ? JSON.parse(s.state) : null, query: typeof s.query === 'string' ? s.query : null }
  } catch {
    return { state: null, query: null }
  }
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
    for (const call of Object.keys(m.calls ?? {})) await $.state.set({ ...CALL, id: call }, { id: m.id })
    if (m.anchorRow && m.version > 0) (at[m.anchorRow] ??= []).push(m.id)
  }
  under.clear()
  for (const [row, ids] of Object.entries(at)) under.set(row, ids)
  await $.state.set(AT, at)
  const newest = metas.filter(m => m.version > 0).pop()
  if (newest && !(await $.state.get(FOCUS)).value) await $.state.set(FOCUS, newest.id)
}
