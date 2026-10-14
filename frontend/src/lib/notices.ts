// The open notices of a workspace (backend notices.py): failures of main or of any of thimble's agents (the orientation
// and its helpers, writers, view builds and reviews, checks, code tickets, labels, the view proposals), each with its
// fix. The chat shows them in the foreground, above the composer of whichever chat is open (chat/Notice.tsx), until the
// analyst dismisses one or a fix that worked clears it. Read from `GET /ws/{c}/notices` when the first reader mounts
// and again when the stream comes back after a failure, and kept up to date by the stream's `notice` records: a notice
// with the key of one shown replaces it in place, any other is added at the end. The history the stream replays is
// left to the read, which already holds what is open.
import { useSyncExternalStore } from 'react'
import { api } from './api'
import { bus, type Events } from './bus'
import type { Notice, NoticeAction } from './types'

const str = (x: unknown): string => (typeof x === 'string' ? x : '')

/** One action as the server sends it: {label, do, slug?}, else null. Pure. */
function actionOf(a: unknown): NoticeAction | null {
  if (!a || typeof a !== 'object') return null
  const o = a as Record<string, unknown>
  const label = str(o.label).trim()
  const what = str(o.do).trim()
  if (!label || !what) return null
  return { label, do: what, ...(str(o.slug) ? { slug: str(o.slug) } : {}) }
}

/** A notice's actions, from one action or a list of them; those without a label or a `do` left out. Pure. */
export function noticeActions(a: unknown): NoticeAction[] {
  return (Array.isArray(a) ? a : [a]).map(actionOf).filter((x): x is NoticeAction => x != null)
}

/** A notice as the server sends it (a row of `GET /notices`, the stream's record, a chat's log record), else null for
 * one with no text. `fallbackId` names one that has no id of its own. Pure. */
export function parseNotice(raw: unknown, fallbackId = ''): Notice | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const text = str(o.text).trim()
  const id = str(o.id) || fallbackId
  if (!text || !id) return null
  const actions = noticeActions(o.action)
  return {
    id,
    text,
    ...(str(o.key) ? { key: str(o.key) } : {}),
    ...(str(o.kind) ? { kind: str(o.kind) } : {}),
    ...(str(o.agent).trim() ? { agent: str(o.agent).trim() } : {}),
    ...(str(o.chat) ? { chat: str(o.chat) } : {}),
    ...(actions.length ? { action: actions.length === 1 ? actions[0] : actions } : {}),
    ...(str(o.ts) ? { ts: str(o.ts) } : {}),
  }
}

/** The open notices with `n` in: in place of the one with its key or id, else at the end. Pure. */
export function withNotice(list: readonly Notice[], n: Notice): Notice[] {
  const at = list.findIndex((x) => x.id === n.id || (!!n.key && x.key === n.key))
  if (at < 0) return [...list, n]
  const next = [...list]
  next[at] = n
  return next
}

/** The open notices less the one `gone` names: by its id, else every one under its key. Pure. */
export function withoutNotice(list: readonly Notice[], gone: { id?: string; key?: string }): Notice[] {
  if (gone.id && list.some((x) => x.id === gone.id)) return list.filter((x) => x.id !== gone.id)
  if (gone.key) return list.filter((x) => x.key !== gone.key)
  return [...list]
}

interface Store {
  list: Notice[]
  subs: Set<() => void>
  off: (() => void) | null
  /** the stream's records that came while a read was under way, applied over its answer */
  pending: Events['notice'][] | null
  /** whether a read answered, so the list holds every open notice */
  read: boolean
  sub: (fn: () => void) => () => void
}

const stores = new Map<string, Store>()

function storeOf(ws: string): Store {
  let s = stores.get(ws)
  if (!s) stores.set(ws, (s = { list: [], subs: new Set(), off: null, pending: null, read: false, sub: (fn) => subscribe(ws, fn) }))
  return s
}

function publish(s: Store, next: Notice[]) {
  s.list = next
  s.subs.forEach((fn) => fn())
}

function apply(list: readonly Notice[], e: Events['notice']): Notice[] {
  if (e.gone) return withoutNotice(list, e.gone)
  if (e.notice && e.foreground) return withNotice(list, e.notice)
  return [...list]
}

/** Read the workspace's open notices now (`GET /ws/{c}/notices`); a server without the route leaves the list as it is. */
export function refreshNotices(ws: string): Promise<void> {
  const s = storeOf(ws)
  s.pending ??= []
  return api
    .notices(ws)
    .then((rows) => {
      const pending = s.pending ?? []
      s.pending = null
      const read = (Array.isArray(rows) ? rows : []).map((r) => parseNotice(r)).filter((n): n is Notice => n != null)
      s.read = true
      publish(s, pending.reduce(apply, read.reduce(withNotice, [] as Notice[])))
    })
    .catch(() => {
      const pending = s.pending ?? []
      s.pending = null
      if (pending.length) publish(s, pending.reduce(apply, s.list))
    })
}

/** A `notice` record of the stream: applied now, or over the read under way; one of the replayed history is left out. */
export function applyNoticeEvent(ws: string, e: Events['notice']): void {
  if (e.replay) return
  const s = storeOf(ws)
  if (s.pending) s.pending.push(e)
  else publish(s, apply(s.list, e))
}

function subscribe(ws: string, fn: () => void): () => void {
  const s = storeOf(ws)
  s.subs.add(fn)
  if (!s.off) {
    const offNotice = bus.on('notice', (e) => applyNoticeEvent(ws, e))
    // what came while the stream was down is read again with the rest
    const offStream = bus.on('wsStream', (e) => e.connected && void refreshNotices(ws))
    s.off = () => {
      offNotice()
      offStream()
    }
    void refreshNotices(ws)
  }
  return () => {
    s.subs.delete(fn)
    if (s.subs.size === 0 && s.off) {
      s.off()
      s.off = null
    }
  }
}

/** The workspace's open notices, oldest first. */
export function useNotices(ws: string): readonly Notice[] {
  return useSyncExternalStore(
    storeOf(ws).sub,
    () => storeOf(ws).list,
    () => storeOf(ws).list,
  )
}

/** Whether the open notices were read from the server, so useNotices holds every one (not only those the stream
 * brought since the page opened). */
export function useNoticesRead(ws: string): boolean {
  return useSyncExternalStore(
    storeOf(ws).sub,
    () => storeOf(ws).read,
    () => false,
  )
}

/** The analyst's × on a notice, or a fix of theirs that went through: it goes from the foreground at once, and the
 * server forgets it (`POST /ws/{c}/notices/{id}/dismiss`), so a reload does not show it again. */
export function dismissNotice(ws: string, n: Pick<Notice, 'id'>): Promise<void> {
  const s = storeOf(ws)
  publish(s, withoutNotice(s.list, { id: n.id }))
  return api.dismissNotice(ws, n.id).then(
    () => undefined,
    () => undefined,
  )
}
