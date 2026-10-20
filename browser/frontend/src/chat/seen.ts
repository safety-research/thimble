// Which records of each chat the analyst has seen: a per-chat count in browser storage, compared with the list
// route's `n_messages` (the analyst's messages, finished replies, chips and agent rows).
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

/** The list route's measure of a log, computed from its records. */
export function countMessages(records: readonly ChatRecord[]): number {
  let n = 0
  for (const r of records) if (r.type === 'user' || r.type === 'done' || r.type === 'chip' || r.type === 'agent') n++
  return n
}

export function isUnread(seen: SeenMap, chatId: string, nMessages: number | undefined): boolean {
  if (!nMessages) return false
  return (seen[chatId] ?? 0) < nMessages
}
