// Which records of each chat the analyst has seen: a per-chat count in browser storage, compared with the list
// route's `n_messages`, the analyst's messages (backend chats.listing).
import type { ChatRecord } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'

export type SeenMap = Record<string, number>

const key = (ws: string) => storageKey(ws, 'seen')

export function readSeen(ws: string): SeenMap {
  const v = readStorage<unknown>(key(ws), {})
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as SeenMap) : {}
}

export function markSeen(ws: string, chatId: string, n: number): SeenMap {
  const cur = readSeen(ws)
  if (cur[chatId] === n) return cur
  const next = { ...cur, [chatId]: n }
  writeStorage(key(ws), next)
  return next
}

/** The list route's measure of a log, computed from its records: the analyst's messages. */
export const countMessages = (records: readonly ChatRecord[]): number => records.filter((r) => r.type === 'user').length

export function isUnread(seen: SeenMap, chatId: string, nMessages: number | undefined): boolean {
  if (!nMessages) return false
  return (seen[chatId] ?? 0) < nMessages
}
