// store.ts: what the app knows of the session, read from the page server and followed while the page is open, and
// what the person has open. One store, read with useStore(selector); the server's change events refresh it.
import { useSyncExternalStore } from 'react'
import { api, follow } from './api'

export interface Mark {
  kind: 'cite' | 'gloss' | 'explain' | 'spark'
  start?: number
  end?: number
  ref?: string
  label?: string
  gloss?: string
  values?: number[] | null
}
export interface Chip {
  id: string
  name: string
  levels: string[]
  level: number
}
export interface VerbState {
  lit?: boolean
  note?: string
  proposals?: string[]
  chips?: Chip[]
  offer?: { what?: string; minutes?: number; tokens?: number }
}
export interface MessageRecord {
  v: number
  row: string
  session?: string
  at?: string
  text: string
  shown?: string | null
  marks?: Mark[]
  glosses?: Record<string, { term?: string; title?: string; body?: string; program?: string; data?: unknown; refs?: string[] }>
  verbs?: Record<string, VerbState>
  objects?: string[]
  final?: boolean
}
export interface Row {
  row: string
  kind: 'user' | 'assistant'
  at?: string | null
  text?: string
  record?: MessageRecord
}
export interface ObjectInfo {
  id: string
  version: number
  title: string
  question?: string
  text?: string
  updated?: string | null
  created?: string | null
  verb?: string | null
  kind?: string | null
  session?: string | null
}
export interface ThreadTurn {
  role: 'user' | 'assistant'
  text: string
  at?: string
  about?: string
  calls?: string[]
}
export interface Thread {
  id: string
  key?: string
  title?: string
  scope?: { object?: string; v?: number; region?: string; label?: string; row?: string; mark?: { kind?: string; ref?: string; gloss?: string; label?: string; term?: string } }
  status?: string
  at?: string
  updated?: string
  turns: ThreadTurn[]
  error?: string
}
export interface Verb {
  key: string
  name: string
  line?: string
}
export interface SessionInfo {
  session: string
  root: string
  folder: string
  title: string
  started: string | null
  rows: number
  coverage: { total: { files: number; rows: number; not_read_files: number; not_read_rows: number }; groups: { group: string; files: number; rows: number; byStatus: Record<string, number> }[] } | null
}
export interface Ask {
  at: string
  text: string
  scope?: Record<string, unknown>
}

export type Surface = 'files' | 'canvas' | 'report'
/** a card in the tray: a mark of a message ({row, i}), or a mark inside a card (a nested citation) */
export type TrayEntry = { row: string; i: number } | { kind: 'cite' | 'spark'; ref: string; label: string; values?: number[] | null }

export interface State {
  live: boolean
  loaded: boolean
  info: SessionInfo | null
  rows: Row[]
  objects: ObjectInfo[]
  threads: Thread[]
  verbs: Verb[]
  asks: Ask[]
  problem: string | null
  // what the person has open
  surface: Surface
  thread: string
  card: { id: string; v: number | null; region: string | null } | null
  selected: string | null
  /** a card picked outside the canvas (a chip in the chat): the canvas brings it into view once */
  reveal: string | null
  tray: TrayEntry[]
  trayAsk: boolean
  focus: { row: string; i: number } | null
  filesView: string
  file: string | null
  squeezeOpen: string | null
  propsOpen: string | null
  sent: { text: string; at: number; error?: string } | null
  detailBar: 'examples' | 'from' | 'program' | null
  exampleAt: number
  pendingThread: { row: string; ref: string; at: number } | null
}

let state: State = {
  live: false,
  loaded: false,
  info: null,
  rows: [],
  objects: [],
  threads: [],
  verbs: [],
  asks: [],
  problem: null,
  surface: 'canvas',
  thread: 'main',
  card: null,
  selected: null,
  reveal: null,
  tray: [],
  trayAsk: false,
  focus: null,
  filesView: 'browser',
  file: null,
  squeezeOpen: null,
  propsOpen: null,
  sent: null,
  detailBar: null,
  exampleAt: 0,
  pendingThread: null,
}
const subs = new Set<() => void>()

export function getState(): State {
  return state
}
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  for (const f of subs) f()
}
function subscribe(f: () => void): () => void {
  subs.add(f)
  return () => subs.delete(f)
}
export function useStore<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => pick(state))
}

// ---------------------------------------------------------------- loading

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function refresh(): Promise<void> {
  const [m, o, t, a] = await Promise.all([api('messages'), api('objects'), api('threads'), api('asks')])
  const patch: Partial<State> = { loaded: true }
  if (m.error) patch.problem = m.error
  else {
    patch.problem = null
    if (!same(m.rows, state.rows)) patch.rows = m.rows || []
  }
  if (!o.error && !same(o.objects, state.objects)) patch.objects = o.objects || []
  if (!t.error && !same(t.threads, state.threads)) patch.threads = t.threads || []
  if (!a.error && !same(a.asks, state.asks)) patch.asks = a.asks || []
  setState(patch)
}

let infoAt = 0
async function refreshInfo(force = false): Promise<void> {
  if (!force && Date.now() - infoAt < 4000) return
  infoAt = Date.now()
  const info = await api('session')
  if (!info.error) setState({ info })
}

/** Start reading: the verbs once, then everything on each change the server announces. */
export async function start(): Promise<void> {
  const v = await api('verbs')
  setState({ verbs: v.verbs || [] })
  await Promise.all([refresh(), refreshInfo(true)])
  follow(
    () => {
      void refresh()
      void refreshInfo()
    },
    (open) => {
      if (open !== state.live) setState({ live: open })
    },
  )
}

// ---------------------------------------------------------------- derived

/** The groups the canvas draws: a group per question the person asked, holding the cards saved in its turn. */
export interface CardGroup {
  id: string
  title: string
  cards: { id: string; v: number | null; row: string | null }[]
}

const ATLAS = (o: ObjectInfo) => o.verb === 'atlas' || /(^|-)atlas$/.test(o.id)
export const isClaims = ATLAS
export const isDocument = (o: ObjectInfo) => o.kind === 'document' || o.verb === 'document'

export function parseObj(s: string): { id: string; v: number | null } | null {
  const m = /^([^@\s]+)(?:@(\d+))?$/.exec(String(s || ''))
  return m ? { id: m[1], v: m[2] ? Number(m[2]) : null } : null
}

export function cardGroups(rows: Row[], objects: ObjectInfo[]): CardGroup[] {
  const known = new Map(objects.map((o) => [o.id, o]))
  const placed = new Set<string>()
  const groups: CardGroup[] = []
  let cur: CardGroup | null = null
  for (const r of rows) {
    if (r.kind === 'user') {
      cur = { id: `g-${r.row}`, title: (r.text || '').replace(/\s+/g, ' ').trim() || 'A question', cards: [] }
      groups.push(cur)
      continue
    }
    for (const ref of r.record?.objects || []) {
      const o = parseObj(ref)
      if (!o || placed.has(o.id)) continue
      const info = known.get(o.id)
      if (info && (ATLAS(info) || isDocument(info))) continue
      placed.add(o.id)
      if (!cur) {
        cur = { id: 'g-work', title: 'Your work', cards: [] }
        groups.push(cur)
      }
      cur.cards.push({ id: o.id, v: null, row: r.row })
    }
  }
  // cards of this session no message names (a verb the person ran, a card saved by a thread): one group of their own
  const rest = objects.filter((o) => !placed.has(o.id) && !ATLAS(o) && !isDocument(o))
  if (rest.length) groups.push({ id: 'g-more', title: 'More cards', cards: rest.map((o) => ({ id: o.id, v: null, row: null })) })
  return groups.filter((g) => g.cards.length)
}

/** The shown text of a record: `shown` after a squeeze, else `text`. */
export const shownText = (r?: MessageRecord | null): string => String(r?.shown ?? r?.text ?? '')

/** The thread about a card, when there is one. */
export function cardThread(threads: Thread[], id: string): Thread | null {
  return threads.find((t) => t.scope?.object === id || t.id === `card-${id}` || t.key === `card-${id}`) ?? null
}
