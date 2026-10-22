// One chat's live state: its meta and records, refetched on the stream's `chat` events, and its rows (tidy.ts). A
// message goes to the analyst's Claude Code session as a browser event (`main`, or `thread` with the thread's id); the
// reply comes back through the log the mirror writes. A null chat is idle.
//
// What the log does not hold yet shows at once (withLive): the analyst's message from its send until the log has it,
// and the words of main's reply while Claude writes them (the stream's `chat-live` records), until the log has the
// message they belong to.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { ChatMeta, ChatRecord } from '../lib/types'
import { foldRecords, withApiErrors, type Row } from './model'
import { tidyRows } from './tidy'

export interface ChatState {
  meta: ChatMeta | null
  records: ChatRecord[]
  rows: Row[]
  loading: boolean
  error: string | null
  /** a message is on its way to the session through this page */
  streaming: boolean
  /** Claude is writing a message of the reply, whose words show as they come (withLive) */
  writing: boolean
  /** the server says the chat is running: main's turn is open, a thread's event waits or its fork runs */
  running: boolean
  /** post a message; resolves false when it did not go out (the composer then gets its text back) */
  send: (text: string) => Promise<boolean>
  interrupt: () => Promise<void>
  reload: () => Promise<void>
}

const REFETCH_DEBOUNCE_MS = 120
/** after a message's words are complete, the log is read again this soon, so they are swapped for the message */
const LIVE_END_READ_MS = 300

/** A message the analyst sent from this page: its text, and the log's length when it was sent. */
export interface Sent {
  text: string
  from: number
  ts: string
}

/** The words of one message of a reply while Claude writes them (bus `chatLive`): `end` once the message is complete. */
export interface LivePiece {
  piece: string
  text: string
  end: boolean
}

/** Whether the log holds the sent message: a message of the analyst's with its text, logged after it was sent. Pure. */
export const logged = (records: readonly ChatRecord[], m: Sent): boolean =>
  records.some((r, i) => i >= m.from && r.type === 'user' && r.text.trim() === m.text)

/** The records as the chat shows them: the log's, then each sent message the log does not hold yet as the analyst's
 * line, then the words of the reply being written, as the text the log will hold. Pure. */
export function withLive(records: readonly ChatRecord[], sent: readonly Sent[], live: readonly LivePiece[]): ChatRecord[] {
  const waiting = sent.filter((m) => !logged(records, m))
  const words = live.filter((p) => p.text.trim())
  if (!waiting.length && !words.length) return records as ChatRecord[]
  return [
    ...records,
    ...waiting.map((m): ChatRecord => ({ type: 'user', text: m.text, ts: m.ts, by: 'browser' })),
    ...words.map((p): ChatRecord => ({ type: 'text', delta: p.text })),
  ]
}

export function useChat(ws: string, chatId: string | null): ChatState {
  const [meta, setMeta] = useState<ChatMeta | null>(null)
  const [records, setRecords] = useState<ChatRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const streamingRef = useRef(false)
  const dirty = useRef(false)
  const gen = useRef(0)
  const [sent, setSent] = useState<(Sent & { posted?: boolean })[]>([])
  const [live, setLive] = useState<LivePiece[]>([])
  const liveRef = useRef<LivePiece[]>([])
  liveRef.current = live
  const sentRef = useRef(sent)
  sentRef.current = sent
  const count = useRef(0)

  const reload = useCallback(async () => {
    const my = ++gen.current
    if (chatId == null) {
      setLoading(false)
      return
    }
    // what this read replaces once it lands: the words of messages already complete, the messages already posted
    const ended = new Set(liveRef.current.filter((p) => p.end).map((p) => p.piece))
    const posted = new Set(sentRef.current.filter((m) => m.posted))
    try {
      const d = await api.chat(ws, chatId)
      if (my !== gen.current) return
      setMeta(d.meta)
      setRecords(d.events)
      count.current = d.events.length
      if (ended.size) setLive((l) => l.filter((p) => !ended.has(p.piece)))
      setSent((s) => (s.some((m) => posted.has(m) || logged(d.events, m)) ? s.filter((m) => !posted.has(m) && !logged(d.events, m)) : s))
      setError(null)
    } catch (e) {
      if (my !== gen.current) return
      setError((e as Error).message)
    } finally {
      if (my === gen.current) setLoading(false)
    }
  }, [ws, chatId])

  useEffect(() => {
    setLoading(true)
    setMeta(null)
    setRecords([])
    setError(null)
    setSent([])
    setLive([])
    streamingRef.current = false
    setStreaming(false)
    void reload()
    let timer: number | null = null
    let endTimer: number | null = null
    const offLive = bus.on('chatLive', (e) => {
      if (e.chat !== chatId) return
      if (e.end) {
        setLive((l) => l.map((p) => (p.piece === e.piece ? { ...p, end: true } : p)))
        if (endTimer != null) window.clearTimeout(endTimer)
        endTimer = window.setTimeout(() => void reload(), LIVE_END_READ_MS)
        return
      }
      const text = e.text ?? ''
      setLive((l) => (l.some((p) => p.piece === e.piece) ? l.map((p) => (p.piece === e.piece && !p.end ? { ...p, text } : p)) : [...l, { piece: e.piece, text, end: false }]))
    })
    const off = bus.on('chat', (e) => {
      if (e.chat !== chatId) return
      if (streamingRef.current) {
        dirty.current = true
        return
      }
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void reload(), REFETCH_DEBOUNCE_MS)
    })
    return () => {
      off()
      offLive()
      if (timer != null) window.clearTimeout(timer)
      if (endTimer != null) window.clearTimeout(endTimer)
    }
  }, [ws, chatId, reload])

  const send = useCallback(
    (text: string): Promise<boolean> => {
      const t = text.trim()
      if (!t || streamingRef.current || chatId == null) return Promise.resolve(false)
      streamingRef.current = true
      setStreaming(true)
      // the analyst's line shows at once, until the log holds it (withLive)
      const mine: Sent & { posted?: boolean } = { text: t, from: count.current, ts: new Date().toISOString() }
      setSent((s) => [...s, mine])
      const payload = chatId === 'main' ? { text: t } : { thread: chatId, text: t }
      return api
        .postEvent(ws, chatId === 'main' ? 'main' : 'thread', payload)
        .then(() => {
          mine.posted = true
          return true
        })
        .catch((e: Error) => {
          setSent((s) => s.filter((m) => m !== mine))
          bus.emit('toast', { text: e.message, kind: 'error' })
          return false
        })
        .finally(() => {
          streamingRef.current = false
          setStreaming(false)
          dirty.current = false
          void reload()
        })
    },
    [ws, chatId, reload],
  )

  const interrupt = useCallback(async () => {
    if (chatId == null) return
    try {
      await api.interrupt(ws, chatId)
    } catch (e) {
      bus.emit('toast', { text: `Could not stop the reply: ${(e as Error).message}`, kind: 'error' })
    }
  }, [ws, chatId])

  const shown = useMemo(() => withLive(records, sent, live), [records, sent, live])
  const rows = useMemo(() => withApiErrors(tidyRows(foldRecords(shown))) as Row[], [shown])
  const writing = live.some((p) => !p.end && p.text.trim() !== '')
  return { meta, records: shown, rows, loading, error, streaming, writing, running: streaming || writing || !!meta?.running, send, interrupt, reload }
}
