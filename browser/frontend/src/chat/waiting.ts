// Which of thimble's sessions wait for the analyst. A session thimble starts beside main has no terminal, so a call
// that needs permission puts its request on the session's chat meta (`permissions`, backend agent_session.ask) until
// the analyst answers or its wait passes; one declined unanswered stays there, marked `expired`, until dismissed. Every
// request waits on PermissionCard.
//
// One of thimble's agents run as a subagent of main (the orientation and its critique, a writer, a report check, a view
// build) is asked in the terminal alone, where it waits until the analyst answers there: main's meta holds the request,
// marked `terminal`, naming the agent's chat (backend events._hold), until the backend sees it answered. While it does,
// each place that shows that agent's state says TERMINAL_WAIT in place of its working state (terminalWaits).
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

/** What a place that shows one of thimble's agents says while Claude Code asks that agent a permission prompt in the
 * terminal, which the browser cannot answer. */
export const TERMINAL_WAIT = 'Waiting for your answer in the terminal'

/** The chats whose agent waits on a permission prompt in the terminal: those main's requests marked `terminal` name,
 * and every chat each of them runs under up to main (the orientation, for its critique's prompt). `main` is main's meta,
 * else the one among `metas`. Pure. */
export function terminalWaits(main: Pick<ChatMeta, 'permissions'> | null | undefined, metas: Iterable<ChatMeta> = []): Set<string> {
  const byId = new Map<string, ChatMeta>()
  for (const m of metas) byId.set(m.id, m)
  const out = new Set<string>()
  for (const p of (main ?? byId.get('main'))?.permissions ?? []) {
    if (!p.terminal || !p.chat) continue
    // the asking chat and its parents, however deep (a cycle of parents ends the walk)
    for (let id: string | null | undefined = p.chat; id && id !== 'main' && !out.has(id); id = byId.get(id)?.parent) out.add(id)
  }
  return out
}

// terminalWaits for each workspace, shared by every component that asks (useTerminalWaits): one read of the chats per
// change for all of them
const shared = new Map<string, { value: Set<string>; subs: Set<(v: Set<string>) => void>; stop: () => void }>()

/** terminalWaits of workspace `ws`, read again on the stream's `chat` records; the empty set while `enabled` is off. */
export function useTerminalWaits(ws: string, enabled = true): ReadonlySet<string> {
  const [value, setValue] = useState<Set<string>>(() => (enabled ? shared.get(ws)?.value : undefined) ?? new Set())
  useEffect(() => {
    if (!enabled) {
      setValue(new Set())
      return
    }
    let entry = shared.get(ws)
    if (!entry) {
      let timer: number | null = null
      const fresh = newest<ChatMeta[]>()
      const made: { value: Set<string>; subs: Set<(v: Set<string>) => void>; stop: () => void } = { value: new Set(), subs: new Set(), stop: () => undefined }
      const load = () =>
        fresh(api.chats(ws))
          .then((l) => {
            if (l === STALE || shared.get(ws) !== made) return
            const next = terminalWaits(null, Array.isArray(l) ? l : [])
            if (next.size === made.value.size && [...next].every((id) => made.value.has(id))) return
            made.value = next
            for (const f of made.subs) f(next)
          })
          .catch(() => undefined)
      const off = bus.on('chat', () => {
        if (timer != null) window.clearTimeout(timer)
        timer = window.setTimeout(() => void load(), REFETCH_DEBOUNCE_MS)
      })
      made.stop = () => {
        off()
        if (timer != null) window.clearTimeout(timer)
      }
      shared.set(ws, made)
      entry = made
      void load()
    }
    const e = entry
    e.subs.add(setValue)
    setValue(e.value)
    return () => {
      e.subs.delete(setValue)
      if (!e.subs.size) {
        e.stop()
        if (shared.get(ws) === e) shared.delete(ws)
      }
    }
  }, [ws, enabled])
  return value
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
