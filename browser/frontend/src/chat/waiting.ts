// Which of thimble's sessions wait for the analyst. A session thimble starts beside main has no terminal, so a call
// that needs permission puts its request on the session's chat meta (`permissions`, backend agent_session.ask) until
// the analyst answers or its wait passes; one declined unanswered stays there, marked `expired`, until dismissed. Main's
// session relays the requests of its own agents on main's meta, each naming the chat of the agent that asked. Every
// request waits on PermissionCard, and at the thread its head names (askThread), whose strip and row in the thread
// tree say so. On Claude Code sign-in, a command's request to a host the analyst has not allowed asks on the chat whose
// agent made it, whose meta carries the ask (`hosts`, backend host_asks) while the command waits, and the ask waits
// under the command (HostAsks).
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { newest, STALE } from '../lib/newest'
import type { ChatMeta, HostAsk, PermissionRequest } from '../lib/types'
import { askThread, cardAsks, pendingRequests } from './permissions'

const REFETCH_DEBOUNCE_MS = 150

/** A chat's permission requests that wait for the analyst's answer while it runs. Pure. */
export function pendingAsks(m: Pick<ChatMeta, 'status' | 'permissions'> | null | undefined): readonly PermissionRequest[] {
  return cardAsks(m).filter((p) => !p.expired)
}

/** A chat's asks before a request to a host the analyst has not allowed, which the server adds to its meta while the
 * command that made the request waits. Pure. */
export function hostAsks(m: Pick<ChatMeta, 'hosts'> | null | undefined): readonly HostAsk[] {
  return m?.hosts ?? []
}

/** Where the requests that wait for an answer wait, by chat, with when the first of them asked: every request on the
 * card but those declined unanswered (pendingRequests), each at the thread the card's head names for it (askThread), so
 * the card, the strip and the thread tree name the same thread. `main` is main's meta, whose requests its session
 * relays. Pure. */
export function requestsAt(main: Pick<ChatMeta, 'permissions'> | null | undefined, metas: Iterable<ChatMeta>): Map<string, string> {
  const all = [...metas]
  const byId = new Map(all.map((m) => [m.id, m]))
  const out = new Map<string, string>()
  for (const ask of pendingRequests(main, all)) {
    if (ask.request.expired) continue
    const at = askThread(ask, byId)
    const since = ask.request.since ?? ''
    const was = out.get(at)
    if (was == null || since < was) out.set(at, since)
  }
  return out
}

/** Every chat that waits for the analyst, on a request that waits there (requestsAt) or an ask about a host on its
 * meta, the one that asked first first. `main` is main's meta, whose requests its session relays. Pure. */
export function waitingChats(metas: Iterable<ChatMeta>, main?: Pick<ChatMeta, 'permissions'> | null): ChatMeta[] {
  const all = [...metas]
  const asked = requestsAt(main, all)
  const first = (m: ChatMeta): string => {
    const at = asked.get(m.id)
    return [...(at == null ? [] : [at]), ...hostAsks(m).map((h) => h.since ?? '')].sort()[0] ?? ''
  }
  return all.filter((m) => asked.has(m.id) || hostAsks(m).length > 0).sort((a, b) => (first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0))
}

/** The chat that waits for the analyst on behalf of the chat `id`: `id` itself, else the chat under it that asked
 * first (a subagent of one of thimble's agents, whose card and row stand for it); null when none waits. `main` is main's
 * meta, whose requests its session relays. Pure. */
export function waitingAt(id: string | null | undefined, metas: Iterable<ChatMeta>, main?: Pick<ChatMeta, 'permissions'> | null): ChatMeta | null {
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
  const waiting = waitingChats(all, main)
  return waiting.find((m) => m.id === id) ?? waiting.find((m) => under.has(m.id)) ?? null
}

/** Whether main's turn or a thread's fork, the chat `m`, waits for the analyst itself: on an ask about a host on its
 * meta, or on a request that waits there (requestsAt; main's own, and a subagent's of main's own, wait at main). The
 * chats under it are sessions of their own, which wait on their own rows. Pure. */
export function waitsItself(m: Pick<ChatMeta, 'id' | 'hosts'> | null | undefined, main: Pick<ChatMeta, 'permissions'> | null | undefined, metas: Iterable<ChatMeta>): boolean {
  if (!m) return false
  return hostAsks(m).length > 0 || requestsAt(main, metas).has(m.id)
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
