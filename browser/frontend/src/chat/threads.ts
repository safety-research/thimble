// The chat's threads as the thread tree lists them (components/ThreadTree). The top level is main, with the threads asked
// from it under it, and `dev`, the row that holds the builds of the views the analyst accepted. A thread hangs under the
// chat it was asked from. Pure.

import type { ThreadNode } from '../components/ThreadTree'
import { hhmm } from '../lib/time'
import type { ChatMeta } from '../lib/types'

/** What a chat is: main, a thread (a fork of main), or the build of a view the analyst accepted (`dev`). */
export type ThreadKind = 'main' | 'thread' | 'dev'

export interface PickItem {
  id: string
  /** the full name: main, main/why-the-spike, dev/run-trail */
  label: string
  /** the name the tree's row shows: the label after its slash, '' for main */
  title: string
  isMain: boolean
  kind: ThreadKind
  running: boolean
  unread: boolean
  /** the chat has finished its work */
  done: boolean
  /** the row this one hangs under: main, the chat a thread was asked from; null at the top level */
  parent: string | null
  /** when the chat last changed, which orders the rows under a row */
  lastTs?: string | null
  /** how a build ended (done, or failed for a failed or stopped run); null for a thread or a build still going */
  ended?: 'done' | 'failed' | null
  /** when a build ended (its meta's ts_end) */
  endTs?: string | null
  /** not listed in the tree: a thread with nothing in it */
  hidden?: boolean
}

export interface PickOptions {
  /** the chat shown now, listed whatever else would hide it */
  current?: string | null
}

const byCreation = (a: ChatMeta, b: ChatMeta) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)

/** The kind of a chat, or null for one the tree does not list. Pure. */
export function threadKind(m: Pick<ChatMeta, 'kind' | 'role'>): ThreadKind | null {
  if (m.kind === 'main') return 'main'
  if (m.kind === 'thread') return 'thread'
  if (m.kind === 'agent' && m.role === 'dev') return 'dev'
  return null
}

/** Each thread's running flag, for answeredSince to compare with later. Pure. */
export function threadsRunning(chats: readonly ChatMeta[]): Map<string, boolean> {
  return new Map(chats.filter((m) => threadKind(m) === 'thread').map((m) => [m.id, !!m.running]))
}

/** The threads that stopped running since `was` (threadsRunning of an earlier list), other than the one shown
 * (`current`): a thread the analyst left while it answered, which has its answer now. Pure. */
export function answeredSince(was: ReadonlyMap<string, boolean>, chats: readonly ChatMeta[], current: string): string[] {
  return chats.filter((m) => threadKind(m) === 'thread' && m.id !== current && was.get(m.id) === true && !m.running).map((m) => m.id)
}

/** The tree's items: main and the threads under it, then each view build, each row's children in the order they
 * started. Every chat the tree knows is an item, so every chip that points at one has its name; `hidden` says which the
 * tree leaves out. Pure. */
export function pickItems(chats: readonly ChatMeta[], running: (m: ChatMeta) => boolean, unread: (m: ChatMeta) => boolean, opts: PickOptions = {}): PickItem[] {
  const main = chats.find((m) => m.kind === 'main')
  const listedChats = chats.filter((m) => m.kind !== 'main' && threadKind(m) != null).sort(byCreation)
  const listed = new Set<string>([...(main ? [main.id] : []), ...listedChats.map((t) => t.id)])
  const mainId = main?.id ?? null
  const parentOf = (t: ChatMeta): string | null => {
    const kind = threadKind(t)
    if (kind === 'main' || kind === 'dev') return null
    if (t.parent && t.parent !== t.id && listed.has(t.parent)) return t.parent
    return mainId
  }
  const labels = new Map<string, string>()
  if (main) labels.set(main.id, 'main')
  // each build of a view takes a name of its own: the first `dev/<view>`, each later one the next number
  const devs = new Map<string, ChatMeta[]>()
  for (const m of listedChats) {
    if (threadKind(m) !== 'dev') continue
    const base = m.view ?? (m.title || m.id)
    devs.set(base, [...(devs.get(base) ?? []), m])
  }
  for (const [base, ms] of devs) ms.forEach((m, i) => labels.set(m.id, `dev/${base}${i > 0 ? `-${i + 1}` : ''}`))
  for (const m of listedChats) {
    const known = labels.get(m.id)
    if (m.name && known) labels.set(m.id, `${known.slice(0, known.indexOf('/'))}/${m.name}`)
  }
  const labelOf = (m: ChatMeta, seen: Set<string> = new Set()): string => {
    const known = labels.get(m.id)
    if (known) return known
    const p = parentOf(m)
    const parent = p && !seen.has(p) ? chats.find((c) => c.id === p) : undefined
    const root = parent && threadKind(parent) !== 'main' ? labelOf(parent, new Set([...seen, m.id])) : 'main'
    const label = `${root}/${m.name || m.title || m.id}`
    labels.set(m.id, label)
    return label
  }
  const item = (m: ChatMeta): PickItem => {
    const kind = threadKind(m) ?? 'thread'
    const label = labelOf(m)
    const build = kind === 'dev'
    const isRunning = build ? m.status === 'running' || running(m) : running(m)
    // a thread with nothing in it (asked nothing yet, or its first question never went out) is noise in the tree
    const empty = kind === 'thread' && !m.n_messages && !isRunning
    return {
      id: m.id,
      label,
      title: kind === 'main' ? '' : kind === 'thread' ? m.title || m.id : label.slice(label.indexOf('/') + 1),
      isMain: kind === 'main',
      kind,
      running: isRunning,
      unread: build ? false : unread(m),
      done: m.status === 'done' || m.status === 'failed' || m.status === 'stopped',
      parent: parentOf(m),
      lastTs: m.last_ts ?? m.ts_end ?? m.created_at,
      ended: !build || m.status === 'running' ? null : m.status === 'done' ? 'done' : m.status === 'failed' || m.status === 'stopped' ? 'failed' : null,
      endTs: m.ts_end ?? null,
      hidden: m.id !== opts.current && empty,
    }
  }
  const kids = new Map<string, ChatMeta[]>()
  for (const t of listedChats) {
    const p = parentOf(t)
    if (p) kids.set(p, [...(kids.get(p) ?? []), t])
  }
  const out: PickItem[] = []
  const seen = new Set<string>()
  const walk = (m: ChatMeta) => {
    if (seen.has(m.id)) return
    seen.add(m.id)
    out.push(item(m))
    for (const k of kids.get(m.id) ?? []) walk(k)
  }
  if (main) walk(main)
  for (const t of listedChats) if (!parentOf(t)) walk(t)
  // a cycle of parents leaves its members unvisited; they are still threads the analyst can open
  for (const t of listedChats) if (!seen.has(t.id)) out.push({ ...item(t), parent: mainId })
  return out
}

/**
 * The tree's nodes from the picked items, hidden items left out: main first, then rows ordered by latest activity
 * (theirs or a descendant's). A finished agent shows how it ended and when. Pure.
 */
/** The id of the tree's `dev` row, which holds the view builds and is no thread: picking it folds it. */
export const DEV_GROUP = 'group:dev'

export function threadNodes(items: readonly PickItem[]): ThreadNode[] {
  const visible = items.filter((it) => !it.hidden)
  const ids = new Set(visible.map((it) => it.id))
  const mainId = visible.find((it) => it.isMain)?.id ?? null
  // a child of a hidden row hangs under that row's parent instead, up to main
  const shownParent = (it: PickItem): string | null => {
    let p = it.parent
    for (let hops = 0; p && !ids.has(p) && hops < 16; hops++) p = items.find((x) => x.id === p)?.parent ?? null
    return p && ids.has(p) ? p : it.parent === null ? null : mainId
  }
  const parentOf = new Map(visible.map((it) => [it.id, shownParent(it)]))
  // a row's latest activity: its own, or a later one of a row under it (ISO times compare as strings)
  const latest = new Map(visible.map((it) => [it.id, it.lastTs ?? '']))
  for (const it of visible) {
    const seen = new Set([it.id])
    for (let p = parentOf.get(it.id); p && !seen.has(p); p = parentOf.get(p) ?? null) {
      seen.add(p)
      if ((latest.get(p) ?? '') < (it.lastTs ?? '')) latest.set(p, it.lastTs ?? '')
    }
  }
  const order = [...visible].sort((a, b) => Number(b.isMain) - Number(a.isMain) || ((latest.get(b.id) ?? '') < (latest.get(a.id) ?? '') ? -1 : (latest.get(b.id) ?? '') > (latest.get(a.id) ?? '') ? 1 : 0))
  // the view builds hang under the `dev` row, which sits among the top-level rows by its latest build's activity
  const devs = order.filter((it) => it.kind === 'dev' && parentOf.get(it.id) === null)
  for (const it of devs) parentOf.set(it.id, DEV_GROUP)
  const nodes: ThreadNode[] = order.map((it) => {
    const endTime = it.ended && (it.endTs ?? it.lastTs) ? hhmm((it.endTs ?? it.lastTs)!) : undefined
    return {
      id: it.id,
      name: it.isMain ? 'main' : it.title,
      path: it.label,
      parent: parentOf.get(it.id) ?? null,
      running: it.running,
      unread: it.unread,
      time: endTime,
      ended: it.ended ?? undefined,
      fixed: it.isMain,
    }
  })
  if (!devs.length) return nodes
  const group: ThreadNode = { id: DEV_GROUP, name: 'dev', path: 'dev', parent: null, fixed: true, group: true, running: devs.some((it) => it.running) }
  // before the first top-level row whose activity is older than the latest build's
  const newest = latest.get(devs[0].id) ?? ''
  const at = nodes.findIndex((n, i) => i > 0 && n.parent === null && (latest.get(n.id) ?? '') < newest)
  nodes.splice(at < 0 ? nodes.length : at, 0, group)
  return nodes
}

/** The label of every listed chat by id, for the chips that point at a thread (main/why-the-spike, dev/run-trail). Pure. */
export function threadLabels(items: readonly PickItem[]): Map<string, string> {
  return new Map(items.map((it) => [it.id, it.label]))
}

/** The document a writer's chat wrote, which the report's own bar still reads. Pure. */
export function writerDoc(m: Pick<ChatMeta, 'title'> & { doc?: string | null }): string {
  return m.doc || (m.title || '').replace(/^write\s+/i, '').trim().toLowerCase() || 'document'
}
