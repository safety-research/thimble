// lib.ts: the browser's side of the panes (lean/panes/): the same program files the terminal runs, loaded from the
// page server (/code/panes/...), and the drawing kit (draw/kit.js) loaded into the page. A pane is thimble's own code,
// so it runs here in the page, as the terminal runs it in its hooks module; a card's program (Claude's) runs only in
// the sandbox (draw/browser/sandbox.js).
import { api, BASE, objectOf, resolveRef, serverModule } from '../lib/api'
import { drawingOf } from '../lib/draw'
import { getState } from '../lib/store'

export interface PaneModule {
  name: string
  title: string
  reads: (args: Record<string, unknown>) => string[]
  stateKey: (args: Record<string, unknown>) => string
  data: (stores: Record<string, unknown>, args: Record<string, unknown>, size: { w: number; h: number }) => unknown
  program: (k: any, data: any) => any
}

interface Mods {
  panes: Record<string, PaneModule>
  host: any
  kit: any
}
let mods: Promise<Mods> | null = null

export function paneModules(): Promise<Mods> {
  if (!mods) {
    mods = (async () => {
      await import(/* @vite-ignore */ `${BASE}/draw/kit.js`)
      const [index, host] = await Promise.all([serverModule('code/panes/index.js'), serverModule('code/panes/host.js')])
      return { panes: index.default, host, kit: (globalThis as any).DrawKit }
    })()
    mods.catch(() => {
      mods = null
    })
  }
  return mods
}

/** One store a pane reads, by name, as the terminal reads it: the claims, the order of the messages, a record. */
export async function readStore(name: string): Promise<unknown> {
  const [kind, ...rest] = name.split(':')
  const arg = rest.join(':')
  const s = getState()
  switch (kind) {
    case 'claims': {
      const r = await api('claims')
      return r.error ? null : r.store
    }
    case 'index':
      return s.rows.map((r) => ({ row: r.row, kind: r.kind }))
    case 'record':
      return s.rows.find((r) => r.row === arg)?.record ?? null
    case 'object': {
      const r = await objectOf(arg, null)
      return r.error ? null : r
    }
    // the session's side threads (the tray shows a mark's)
    case 'threads':
      return s.threads
    default:
      return null
  }
}

/** A card a program shows inside itself (the tray's): a citation's source card from the page server (cards.js
 *  citeCard, the terminal's own), or a term's explain card, each part and each section's part drawn in the page's
 *  sandbox at `w` (cards.js drawnCard, as the terminal draws them). */
async function cardWant(c: any, w: number, h: number): Promise<unknown> {
  const cards = await serverModule('code/shell/cards.js')
  let spec: any
  if (c?.kind === 'gloss') spec = cards.explainerCard({ gloss: c.gloss || {} })
  else if (typeof c?.ref === 'string' && c.ref) {
    spec = await api(`card?ref=${encodeURIComponent(c.ref)}&label=${encodeURIComponent(c.kind === 'spark' ? 'sparkline' : String(c.label || c.ref))}&room=${h}`)
    if (spec.error) return { problem: spec.error, drawings: [], links: [] }
  } else return { problem: 'this mark names no ref, so there are no rows to show', drawings: [], links: [] }
  // each part its own object, so the page's cache of drawings keeps them apart; a card drawn whole keeps its own id,
  // so its rows' refs read as the card's
  return cards.drawnCard(spec, (part: any) => {
    const hash = hashOf(String(part.program) + JSON.stringify(part.data ?? null))
    return drawingOf({ id: part.id || `card-${hash}`, version: `cite-${hash}`, program: part.program, data: part.data ?? {} }, { w, mode: 'inline' })
  })
}

function hashOf(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** What a program wants that its data does not hold (k.want): {rows: [refs]} through the kernel. */
export async function readWant(request: any): Promise<unknown> {
  if (request?.card && typeof request.card === 'object') return cardWant(request.card, Math.max(20, Number(request.w) || 80), Math.max(3, Number(request.h) || 9))
  if (Array.isArray(request?.rows)) {
    const refs = request.rows.filter((r: unknown) => typeof r === 'string').slice(0, 200)
    if (!refs.length) return { records: [], count: 0 }
    return resolveRef(refs, Math.max(1, Math.min(20, Number(request.n) || 8)))
  }
  if (typeof request?.facts === 'string') {
    const r = await api(`from/${encodeURIComponent(request.facts)}`)
    return r.error ? { error: r.error } : r
  }
  return { error: 'the page cannot read that' }
}

/** A pane's state as either surface left it: {state, by, at} or null. */
export async function readPaneState(key: string): Promise<{ state: Record<string, unknown> | null; by?: string; at?: string } | null> {
  const r = await api(`pane/${encodeURIComponent(key)}`)
  return r.error ? null : r
}

// ---------------------------------------------------------------- the focus stack
// What has the keys, top first: each pane that takes keys while it is open (the chips under a message, the Claims
// pane, the card detail). A key goes to the top pane that takes it, then down; the bar names the top pane's keys. A
// key no pane takes goes on to the app's own keys (Shell.tsx), as the terminal's go on to the message's verbs.
export interface Layer {
  id: string
  fire: (event: Record<string, unknown>) => boolean
  /** say its keys in the bar (it is on top now) */
  publish?: () => void
}
const layers: Layer[] = []
let listening = false

export function pushLayer(layer: Layer): () => void {
  const i = layers.findIndex((l) => l.id === layer.id)
  if (i >= 0) layers.splice(i, 1)
  layers.push(layer)
  if (!listening) {
    listening = true
    window.addEventListener('keydown', onKey, true)
  }
  return () => {
    const j = layers.indexOf(layer)
    if (j >= 0) layers.splice(j, 1)
    // the pane under it is on top again: its keys go back in the bar
    if (j === layers.length) layers[layers.length - 1]?.publish?.()
  }
}

/** The pane on top of the focus stack, or null. */
export const topLayer = (): string | null => layers[layers.length - 1]?.id ?? null

const ARROWS: Record<string, string> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

/** A keydown as a program names keys. */
export function keyOfEvent(e: KeyboardEvent): string {
  if (e.ctrlKey || e.metaKey || e.altKey) return ''
  if (ARROWS[e.key]) return ARROWS[e.key]
  if (e.key === ' ') return 'space'
  if (e.key === 'Enter') return 'return'
  if (e.key === 'Escape') return 'esc'
  if (e.key === 'Backspace') return 'backspace'
  return e.key && e.key.length === 1 ? e.key : ''
}

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return
  const k = keyOfEvent(e)
  if (!k) return
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].fire({ type: 'key', key: k })) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
  }
}
