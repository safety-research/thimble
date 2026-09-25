// One chat's live state: its meta and records, refetched on the stream's `chat` events, and its rows (tidy.ts). A
// message goes to the analyst's Claude Code session as a channel event (`main`, or `thread` with the thread's id); the
// reply comes back through the log the mirror writes. A null chat is idle.
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
  /** the server says the chat is running: main's turn is open, a thread's event waits or its fork runs */
  running: boolean
  /** post a message; resolves false when it did not go out (the composer then gets its text back) */
  send: (text: string) => Promise<boolean>
  interrupt: () => Promise<void>
  reload: () => Promise<void>
}

const REFETCH_DEBOUNCE_MS = 120

export function useChat(ws: string, chatId: string | null): ChatState {
  const [meta, setMeta] = useState<ChatMeta | null>(null)
  const [records, setRecords] = useState<ChatRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const streamingRef = useRef(false)
  const dirty = useRef(false)
  const gen = useRef(0)

  const reload = useCallback(async () => {
    const my = ++gen.current
    if (chatId == null) {
      setLoading(false)
      return
    }
    try {
      const d = await api.chat(ws, chatId)
      if (my !== gen.current) return
      setMeta(d.meta)
      setRecords(d.events)
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
    streamingRef.current = false
    setStreaming(false)
    void reload()
    let timer: number | null = null
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
      if (timer != null) window.clearTimeout(timer)
    }
  }, [ws, chatId, reload])

  const send = useCallback(
    (text: string): Promise<boolean> => {
      const t = text.trim()
      if (!t || streamingRef.current || chatId == null) return Promise.resolve(false)
      streamingRef.current = true
      setStreaming(true)
      const payload = chatId === 'main' ? { text: t } : { thread: chatId, text: t }
      return api
        .postEvent(ws, chatId === 'main' ? 'main' : 'thread', payload)
        .then(() => true)
        .catch((e: Error) => {
          bus.emit('toast', { text: e.message, kind: 'error' })
          return false
        })
        .finally(() => {
          streamingRef.current = false
          setStreaming(false)
          if (dirty.current) {
            dirty.current = false
            void reload()
          }
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

  const rows = useMemo(() => withApiErrors(tidyRows(foldRecords(records))) as Row[], [records])
  return { meta, records, rows, loading, error, streaming, running: streaming || !!meta?.running, send, interrupt, reload }
}
