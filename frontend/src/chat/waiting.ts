// Which of thimble's sessions wait for the analyst. A session thimble starts beside main has no terminal, so a call
// that needs permission puts its request on the session's chat meta (`permissions`, backend agent_session.ask) until
// the analyst answers or its wait passes; one declined unanswered stays there, marked `expired`, until dismissed. Every
// request waits on PermissionCard.
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { newest, STALE } from '../lib/newest'
import type { ChatMeta, PermissionRequest } from '../lib/types'

const REFETCH_DEBOUNCE_MS = 150

/** A chat's permission requests on the card while it runs, those declined unanswered among them; none once it has
 * ended. Pure. */
export function cardAsks(m: Pick<ChatMeta, 'status' | 'permissions'> | null | undefined): readonly PermissionRequest[] {
  return m && m.status === 'running' ? m.permissions ?? [] : []
}

/** A chat's permission requests that wait for the analyst's answer while it runs. Pure. */
export function pendingAsks(m: Pick<ChatMeta, 'status' | 'permissions'> | null | undefined): readonly PermissionRequest[] {
  return cardAsks(m).filter((p) => !p.expired)
}

const firstAsk = (m: ChatMeta): string => pendingAsks(m).map((p) => p.since ?? '').sort()[0] ?? ''

/** Every chat that waits for the analyst, the one that asked first first. Pure. */
export function waitingChats(metas: Iterable<ChatMeta>): ChatMeta[] {
  return [...metas].filter((m) => pendingAsks(m).length > 0).sort((a, b) => (firstAsk(a) < firstAsk(b) ? -1 : firstAsk(a) > firstAsk(b) ? 1 : 0))
}

/** The chat that waits for the analyst on behalf of the chat `id`: `id` itself, else the chat under it that asked
 * first (a critique under the orientation, whose card and row stand for it); null when none waits. Pure. */
export function waitingAt(id: string | null | undefined, metas: Iterable<ChatMeta>): ChatMeta | null {
  if (!id) return null
  const all = [...metas]
  const under = new Set([id])
  // the chats under `id`, however deep, each parent before its children (a cycle of parents ends the walk)
  for (let grew = true; grew; ) {
    grew = false
    for (const m of all) {
      if (m.parent && under.has(m.parent) && !under.has(m.id)) {
        under.add(m.id)
        grew = true
      }
    }
  }
  const self = all.find((m) => m.id === id)
  if (self && pendingAsks(self).length) return self
  return waitingChats(all.filter((m) => under.has(m.id)))[0] ?? null
}

/** The workspace's chat metas, read again on the stream's `chat` records, for a surface outside the chat panel; none
 * read while `enabled` is off. */
export function useChatMetas(ws: string, enabled = true): ChatMeta[] {
  const [metas, setMetas] = useState<ChatMeta[]>([])
  useEffect(() => {
    if (!enabled) {
      setMetas([])
      return
    }
    let alive = true
    let timer: number | null = null
    const fresh = newest<ChatMeta[]>()
    const load = () =>
      fresh(api.chats(ws))
        .then((l) => alive && l !== STALE && setMetas(Array.isArray(l) ? l : []))
        .catch(() => undefined)
    void load()
    const off = bus.on('chat', () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(), REFETCH_DEBOUNCE_MS)
    })
    return () => {
      alive = false
      off()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [ws, enabled])
  return metas
}
