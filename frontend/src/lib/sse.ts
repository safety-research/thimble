// Server-sent events on the browser side: an EventSource that reconnects after a hard failure or a stall.

/** The server's keepalive cadence (backend EventSourceResponse ping=15). */
export const PING_MS = 15_000
/** Two keepalives missed: the connection is dead on the server's side. */
export const STALL_MS = 2 * PING_MS + 5_000
export const RETRY_MS = 5_000
export const RETRY_MAX_MS = 30_000

export interface StreamOptions {
  /** named events handed to `onEvent` besides `message`; `ping` never is */
  events?: readonly string[]
  onEvent: (event: string, data: unknown, lastEventId: string) => void
  /** the stream came back after a failure or a stall; what happened meanwhile was not replayed */
  onReopen?: () => void
  /** the stream failed or stalled: the server is restarting, stopped or out of reach */
  onDown?: () => void
  /** the URL to reopen with, given the last event id seen (the replay point) */
  urlFor?: (lastEventId: string | null) => string
}

/** Open `url` as a stream that reconnects; returns the release. */
export function openStream(url: string, opts: StreamOptions): () => void {
  if (typeof EventSource !== 'function') return () => {}
  let es: EventSource | null = null
  let timer: number | null = null
  let failures = 0
  let released = false
  let interrupted = false
  let lastId: string | null = null
  const clear = () => {
    if (timer != null) window.clearTimeout(timer)
    timer = null
  }
  const handler = (ev: Event) => {
    alive()
    const me = ev as MessageEvent
    if (me.lastEventId) lastId = me.lastEventId
    let data: unknown
    try {
      data = JSON.parse(me.data)
    } catch {
      return
    }
    opts.onEvent(ev.type, data, me.lastEventId ?? '')
  }
  const alive = () => {
    clear()
    timer = window.setTimeout(() => {
      if (released) return
      es?.close()
      interrupted = true
      opts.onDown?.()
      open()
    }, STALL_MS)
  }
  const open = () => {
    const cur = new EventSource(opts.urlFor ? opts.urlFor(lastId) : url)
    es = cur
    alive()
    for (const name of ['message', ...(opts.events ?? [])]) cur.addEventListener(name, handler)
    cur.addEventListener('ping', alive)
    cur.onerror = () => {
      if (released || es !== cur) return
      // the browser retries a dropped stream itself (readyState CONNECTING); its reopen is a reopen all the same
      interrupted = true
      opts.onDown?.()
      if (cur.readyState !== EventSource.CLOSED) return
      clear()
      const wait = Math.min(RETRY_MS * 2 ** failures, RETRY_MAX_MS)
      failures++
      timer = window.setTimeout(() => {
        if (!released && es === cur) open()
      }, wait)
    }
    cur.onopen = () => {
      if (released || es !== cur) return
      failures = 0
      alive()
      const reopen = interrupted
      interrupted = false
      if (reopen) opts.onReopen?.()
    }
  }
  open()
  return () => {
    if (released) return
    released = true
    clear()
    es?.close()
    es = null
  }
}
