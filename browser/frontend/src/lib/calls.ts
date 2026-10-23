// The orientation's calls as the server stores them (backend calls.py): each call by its number, with its input and its
// whole output. The thread's chip and `call:` citations read from here, so both show the whole output even where the
// chat's log kept only a prefix. Each call's chip line is registered too, so a citation's chip reads like it.
import { api } from './api'
import type { StoredCall } from './types'

const key = (ws: string, chat: string, n: number) => `${ws}\n${chat}/${n}`

/** the calls read, by workspace and ref; a call still running is read again next time */
const cache = new Map<string, Promise<StoredCall>>()

/** A call's output: `result`, else `output`, else '' while it runs. */
export const callOutput = (c: Pick<StoredCall, 'result' | 'output'>): string => c.result ?? c.output ?? ''

/** Read call `n` of orientation `chat`, once per workspace for a call that has finished. */
export function fetchCall(ws: string, chat: string, n: number): Promise<StoredCall> {
  const k = key(ws, chat, n)
  const had = cache.get(k)
  if (had) return had
  const p = api.call(ws, chat, n).then((c) => {
    if (c.result == null && c.output == null) cache.delete(k)
    else setCallWords(chat, n, c.name, c.input)
    return c
  })
  p.catch(() => cache.delete(k))
  cache.set(k, p)
  return p
}

/** An output's lines as the refs number them, from 1: the text split at each newline, a newline that ends the text
 * opening no line of its own. Pure. */
export function outputLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// ---- the chip line's words, for citations of a call ----

export interface CallWords {
  name: string
  input: unknown
}

const words = new Map<string, CallWords>()
const listeners = new Set<() => void>()
let told = false

/** Register what call `n` of orientation `chat` ran, from a thread's records or a read of the store. The chips hear of
 * it once per burst, as a thread of many calls registers them all as it mounts. */
export function setCallWords(chat: string, n: number, name: string, input: unknown): void {
  const k = `${chat}/${n}`
  const had = words.get(k)
  if (had && had.name === name && had.input === input) return
  words.set(k, { name, input })
  if (told) return
  told = true
  queueMicrotask(() => {
    told = false
    for (const fn of listeners) fn()
  })
}

/** What call `n` of orientation `chat` ran, once a thread or a read has registered it. */
export const callWords = (chat: string, n: number): CallWords | undefined => words.get(`${chat}/${n}`)

export function onCallWords(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Forget every call read (tests). */
export function forgetCalls(): void {
  cache.clear()
  words.clear()
}
