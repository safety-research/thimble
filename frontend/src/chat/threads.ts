// The chat's threads as the thread tree lists them (components/ThreadTree). The top level is main, the latest
// orientation and the `dev` group (DEV_GROUP, a row that only folds), under which hangs every dev ticket, a view build
// among them, named `dev/…`. Everything else started from main hangs
// under main (threads, writers, earlier orientations, running report checks); a thread born from a ⌘-click hangs under the chat it was started from (`parent`), and each
// step of an orientation or writer under that session. Rows are ordered by latest activity. Work the analyst did not
// start (a report check's run) is listed only while it is relevant (running, waiting, or shown); every dev ticket, the
// orientation's view builds among them, is always listed.
//
// Names: `main/<title>` for a thread, `orient` (and `orient-1`, `orient-2`, ...), `write-<document>` (`-2`, `-3` for
// later runs), `check/<title>`, `dev/<view>` for a view's build and `dev/<first words of its title>` for another ticket, and a step `orient/<phase>: <agent key>`. A chat's
// own `name` replaces the last part.
import type { ThreadNode } from '../components/ThreadTree'
import { hhmm } from '../lib/time'
import type { ChatMeta } from '../lib/types'

/** What a chat is: main, a thread (a fork of main), the orientation, a writer, a report check's run on a document, a
 * dev ticket's background session (a view build among them), or a step of the orientation or a writer (a subagent or
 * workflow agent of its session, nested under it and opened from its card). */
export type ThreadKind = 'main' | 'thread' | 'orient' | 'writer' | 'check' | 'dev' | 'step'

export interface PickItem {
  id: string
  /** the full name: main, main/why-the-spike, orient, dev/group-board-by-round */
  label: string
  /** the name the tree's row shows: the label after its slash, '' for main */
  title: string
  isMain: boolean
  kind: ThreadKind
  running: boolean
  unread: boolean
  /** the chat has finished its work */
  done: boolean
  /** the row this one hangs under: main, the orientation, the chat a thread was asked from; null at the top level */
  parent: string | null
  /** when the chat last changed, which orders the rows under a row */
  lastTs?: string | null
  /** how an agent's run ended (done, or failed for a failed or stopped run); null for a thread or a run still going */
  ended?: 'done' | 'failed' | null
  /** when an agent's run ended (its meta's ts_end) */
  endTs?: string | null
  /** not listed in the tree: work the analyst did not start once it has ended, or a thread with nothing in it */
  hidden?: boolean
  /** a permission prompt of its session or its fork waits for the analyst */
  waiting?: boolean
}

export interface PickOptions {
  /** the chat shown now, listed whatever else would hide it */
  current?: string | null
  /** the chats a permission prompt waits on (chat/waiting.ts, and main's prompts that name their thread) */
  waiting?: ReadonlySet<string>
}

const byCreation = (a: ChatMeta, b: ChatMeta) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)

/** The kind of a chat the tree lists, null for one it does not (another subagent, which shows as a card in main). */
export function threadKind(m: Pick<ChatMeta, 'kind' | 'role'>): ThreadKind | null {
  if (m.kind === 'main') return 'main'
  if (m.kind === 'thread') return 'thread'
  if (m.kind === 'agent' && m.role === 'orient') return 'orient'
  if (m.kind === 'agent' && m.role === 'writer') return 'writer'
  if (m.kind === 'agent' && m.role === 'check') return 'check'
  if (m.kind === 'agent' && m.role === 'dev') return 'dev'
  if (m.kind === 'agent' && m.role === 'step') return 'step'
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

/** Where a message typed in a thread's composer goes: `here`, the chat's own session (main, or a thread's fork); the
 * latest orientation from its thread or its steps' (`orient`); the view a build thread builds (`view`); else main, for
 * threads of sessions that take no message. */
export type ComposerTarget = { to: 'here' } | { to: 'main' } | { to: 'orient'; chat: string } | { to: 'view'; slug: string }

/** The composer's target in the thread of `meta` (ComposerTarget), `latestOrient` the latest orientation's chat. Pure. */
export function composerTarget(kind: ThreadKind | null, meta: Pick<ChatMeta, 'id' | 'parent'> & { view?: string | null } | null, latestOrient: string | null): ComposerTarget {
  if (kind === 'main' || kind === 'thread' || kind == null) return { to: 'here' }
  if (latestOrient && ((kind === 'orient' && meta?.id === latestOrient) || (kind === 'step' && meta?.parent === latestOrient))) return { to: 'orient', chat: latestOrient }
  if (kind === 'dev' && meta?.view) return { to: 'view', slug: meta.view }
  return { to: 'main' }
}

/** Whether the chat is the build of a view the orientation proposed, which the analyst never asked for (backend
 * dev._view_chat marks the build of one they asked for `asked`). Pure. */
export function orientBuild(m: Pick<ChatMeta, 'kind' | 'role'> & { view?: string | null; asked?: boolean | null }): boolean {
  return m.kind === 'agent' && m.role === 'dev' && !!m.view && !m.asked
}

/** Whether the analyst did not start the chat themselves: the build of a view the orientation proposed (its view's
 * chip is its home) or a report check's run (the Checks pane's). Pure. */
export function startedByThimble(m: Pick<ChatMeta, 'kind' | 'role'> & { view?: string | null; asked?: boolean | null }): boolean {
  return orientBuild(m) || (m.kind === 'agent' && m.role === 'check')
}

/**
 * A step's name under its session: `<phase in lower case>: <agent key>`, from the workflow agent's title
 * (`Read: read:run-logs` gives `read: run-logs`). A title with no phase stays as it is. Pure.
 */
export function stepName(title: string): string {
  const { phase, key } = stepParts(title)
  return phase ? `${phase}: ${key}` : key
}

/** A step's title in its two parts (stepName): the phase in lower case, '' for a title with none, and the agent's key
 * with its own copy of the phase dropped. Pure. */
export function stepParts(title: string): { phase: string; key: string } {
  const t = title.replace(/\s+/g, ' ').trim()
  const m = /^([A-Za-z][\w-]*(?: [\w-]+)?): (\S.*)$/.exec(t)
  if (!m) return { phase: '', key: t }
  const phase = m[1].toLowerCase()
  const key = m[2].trim()
  const bare = key.toLowerCase().startsWith(`${phase}:`) ? key.slice(phase.length + 1).trim() : key
  return { phase, key: bare || key }
}

/** The names of a session's steps as its card and its strip list them (stepParts): each agent's key alone while every
 * step shares one phase (`run-logs`, not `orient/read: run-logs`), and `phase: key` once the steps span two phases, so
 * a reader and a verifier read apart. Pure. */
export function shortStepNames(titles: readonly string[]): string[] {
  const parts = titles.map(stepParts)
  const phases = new Set(parts.map((p) => p.phase))
  return parts.map((p) => (p.phase && phases.size > 1 ? `${p.phase}: ${p.key}` : p.key))
}

/** The document a writer's chat writes: its `doc`, else its title after `Write ` (write_session.start). Pure. */
export function writerDoc(m: Pick<ChatMeta, 'title'> & { doc?: string | null }): string {
  return m.doc || (m.title || '').replace(/^write\s+/i, '').trim().toLowerCase() || 'document'
}

/** A check's run as a thread name: `check/` and its chat's title (the check's name), a leading `check/` or `check `
 * dropped. Pure. */
export function checkLabel(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim().replace(/^check(?:\/|\s+)/i, '')
  return `check/${t || 'run'}`
}

/** A ticket's title as a thread name: `ticket #2: ` dropped, the first four words, lower case, joined by '-'. Pure. */
export function ticketSlug(title: string): string {
  const words = title.replace(/^ticket #\d+:\s*/i, '').match(/[\p{L}\p{N}]+/gu) ?? []
  return words.slice(0, 4).join('-').toLowerCase() || 'ticket'
}

/**
 * The tree's items: main and what hangs under it, then the latest orientation and each dev ticket and what hangs under them, each row's
 * children in the order they started. Every chat the tree knows is an item, so every chip that points at one has its
 * name; `hidden` says which the tree leaves out (module note). Pure.
 */
export function pickItems(chats: readonly ChatMeta[], running: (m: ChatMeta) => boolean, unread: (m: ChatMeta) => boolean, opts: PickOptions = {}): PickItem[] {
  const main = chats.find((m) => m.kind === 'main')
  const listedChats = chats.filter((m) => m.kind !== 'main' && threadKind(m) != null).sort(byCreation)
  const listed = new Set<string>([...(main ? [main.id] : []), ...listedChats.map((t) => t.id)])
  const orients = listedChats.filter((m) => threadKind(m) === 'orient')
  const latestOrient = orients[orients.length - 1]?.id ?? null
  const mainId = main?.id ?? null
  // the row a chat hangs under: a thread under the chat it was asked from, a step under its session, the latest
  // orientation and each dev ticket at the top level, and every other chat under main
  const parentOf = (t: ChatMeta): string | null => {
    const kind = threadKind(t)
    if (kind === 'main' || kind === 'dev' || t.id === latestOrient) return null
    if ((kind === 'thread' || kind === 'step') && t.parent && t.parent !== t.id && listed.has(t.parent)) return t.parent
    return mainId
  }
  const labels = new Map<string, string>()
  if (main) labels.set(main.id, 'main')
  orients.forEach((m, i) => labels.set(m.id, i === orients.length - 1 ? 'orient' : `orient-${i + 1}`))
  const writes = new Map<string, ChatMeta[]>()
  for (const m of listedChats) if (threadKind(m) === 'writer') writes.set(writerDoc(m), [...(writes.get(writerDoc(m)) ?? []), m])
  // a document's first writer is `write-<doc>` and each later one takes the next number, so a name never moves to
  // another run and a chip in main's history keeps pointing at the run it named
  for (const [doc, ms] of writes) ms.forEach((m, i) => labels.set(m.id, i === 0 ? `write-${doc}` : `write-${doc}-${i + 1}`))
  for (const m of listedChats) if (threadKind(m) === 'dev') labels.set(m.id, `dev/${m.view || ticketSlug(m.title || m.id)}`)
  for (const m of listedChats) if (threadKind(m) === 'check') labels.set(m.id, checkLabel(m.title || m.id))
  for (const m of listedChats) {
    const known = labels.get(m.id)
    if (m.name && known) labels.set(m.id, known.includes('/') ? `${known.slice(0, known.indexOf('/'))}/${m.name}` : m.name)
  }
  const labelOf = (m: ChatMeta, seen: Set<string> = new Set()): string => {
    const known = labels.get(m.id)
    if (known) return known
    const p = parentOf(m)
    const parent = p && !seen.has(p) ? chats.find((c) => c.id === p) : undefined
    const root = parent && threadKind(parent) !== 'main' ? labelOf(parent, new Set([...seen, m.id])) : 'main'
    const label = `${root}/${m.name || (threadKind(m) === 'step' ? stepName(m.title || m.id) : m.title || m.id)}`
    labels.set(m.id, label)
    return label
  }
  const item = (m: ChatMeta): PickItem => {
    const kind = threadKind(m) ?? 'thread'
    const label = labelOf(m)
    const agent = kind === 'orient' || kind === 'writer' || kind === 'check' || kind === 'dev' || kind === 'step'
    const isRunning = agent ? m.status === 'running' || running(m) : running(m)
    const shown = m.id === opts.current
    // a thread with nothing in it (asked nothing yet, or its first question never went out) is noise in the tree
    const empty = kind === 'thread' && !m.n_messages && !isRunning
    const waiting = !!opts.waiting?.has(m.id)
    // every dev ticket is listed (the orientation's view builds among them); a report check's run only while it runs
    const left = kind === 'dev' ? false : (startedByThimble(m) && !isRunning) || empty
    return {
      id: m.id,
      label,
      title: kind === 'main' ? '' : kind === 'orient' || kind === 'writer' ? label : kind === 'thread' ? m.title || m.id : label.slice(label.indexOf('/') + 1),
      isMain: kind === 'main',
      kind,
      running: isRunning,
      // an orientation, a writer or a ticket reports in main (its card, its chip), so its own chat is never unread
      unread: agent ? false : unread(m),
      done: m.status === 'done' || m.status === 'failed' || m.status === 'stopped',
      parent: parentOf(m),
      lastTs: m.last_ts ?? m.ts_end ?? m.created_at,
      ended: !agent || m.status === 'running' ? null : m.status === 'done' ? 'done' : m.status === 'failed' || m.status === 'stopped' ? 'failed' : null,
      endTs: m.ts_end ?? null,
      hidden: !shown && left,
      waiting,
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
/** The id of the tree's `dev` row, which holds the dev tickets and is no thread: picking it folds it. */
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
  // the dev tickets hang under the `dev` row, which sits among the top-level rows by its latest ticket's activity
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
      waiting: it.waiting,
      time: endTime,
      ended: it.ended ?? undefined,
      fixed: it.isMain,
    }
  })
  if (!devs.length) return nodes
  const group: ThreadNode = { id: DEV_GROUP, name: 'dev', path: 'dev', parent: null, fixed: true, group: true, running: devs.some((it) => it.running), waiting: devs.some((it) => it.waiting) || undefined }
  // before the first top-level row whose activity is older than the latest ticket's
  const newest = latest.get(devs[0].id) ?? ''
  const at = nodes.findIndex((n, i) => i > 0 && n.parent === null && (latest.get(n.id) ?? '') < newest)
  nodes.splice(at < 0 ? nodes.length : at, 0, group)
  return nodes
}

/** The label of every listed chat by id, for the chips that point at a thread (main/why-the-spike, orient). Pure. */
export function threadLabels(items: readonly PickItem[]): Map<string, string> {
  return new Map(items.map((it) => [it.id, it.label]))
}
