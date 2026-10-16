// Server-sent events on the browser side: an EventSource that reconnects after a hard failure or a stall. A stream the
// server closed (an answer that is no stream, such as the 401 of a browser that is no longer signed in) makes the page
// ask whether it is still signed in (lib/api checkSignedIn), so a signed-out tab shows shell/SignIn's line rather than
// that the server is down.
//
// The stale-tab guard (lib/stale): the page itself reconnects, never the browser's own retry, since a reopen sends the
// cookie and the key in the path. A failure makes the page suspect, and each reopen waits for the challenge to pass
// first. The server's `stopping` event (it stops for good), the challenge failing, and MAX_FAILURES failed reconnects
// in a row stop the page, and with it every stream.
import { checkSignedIn } from './api'
import { browserKey } from './browserKey'
import { bus } from './bus'
import { markSuspect, MAX_FAILURES, pageStopped, stopPage, verified } from './stale'

/** The server's keepalive cadence (backend EventSourceResponse ping=15). */
export const PING_MS = 15_000
/** Two keepalives missed: the connection is dead on the server's side. */
export const STALL_MS = 2 * PING_MS + 5_000
export const RETRY_MS = 5_000
export const RETRY_MAX_MS = 30_000
/** The event the server ends a stream with when it stops for good (backend main.STOPPING_EVENT). */
export const STOPPING = 'stopping'

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
  if (typeof EventSource !== 'function' || pageStopped()) return () => {}
  let es: EventSource | null = null
  let timer: number | null = null
  // failed reconnects in a row: a challenge nothing answered, or a reopened stream that failed before it opened
  let failures = 0
  let released = false
  let interrupted = false
  let lastId: string | null = null
  const clear = () => {
    if (timer != null) window.clearTimeout(timer)
    timer = null
  }
  const close = () => {
    clear()
    es?.close()
    es = null
  }
  const offStopped = bus.on('pageStopped', () => {
    released = true
    close()
  })
  const release = () => {
    released = true
    offStopped()
    close()
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
  const retry = () => {
    clear()
    timer = window.setTimeout(() => void reopen(), Math.min(RETRY_MS * 2 ** failures, RETRY_MAX_MS))
  }
  const failed = () => {
    failures++
    if (failures >= MAX_FAILURES) stopPage('failures')
    else retry()
  }
  // the stream is down: tell the caller, close it (no retry of the browser's own), and reopen after a wait
  const down = (closed: boolean) => {
    if (released) return
    interrupted = true
    markSuspect()
    opts.onDown?.()
    close()
    if (closed) void checkSignedIn()
    retry()
  }
  // a reopen sends credentials: only once the challenge passed (lib/stale verified); a page with no key has none to send
  const reopen = async () => {
    if (released) return
    if (!browserKey()) {
      open()
      return
    }
    const v = await verified()
    if (released) return
    if (v === 'stopped') release()
    else if (v === 'down') failed()
    else open()
  }
  const alive = () => {
    clear()
    timer = window.setTimeout(() => {
      if (!released) down(false)
    }, STALL_MS)
  }
  const open = () => {
    const cur = new EventSource(opts.urlFor ? opts.urlFor(lastId) : url)
    es = cur
    alive()
    for (const name of ['message', ...(opts.events ?? [])]) cur.addEventListener(name, handler)
    cur.addEventListener('ping', alive)
    cur.addEventListener(STOPPING, () => stopPage('stopping'))
    cur.onerror = () => {
      if (released || es !== cur) return
      if (interrupted) {
        // a reopen that failed before it opened
        failures++
        if (failures >= MAX_FAILURES) {
          close()
          stopPage('failures')
          return
        }
      }
      down(cur.readyState === EventSource.CLOSED)
    }
    cur.onopen = () => {
      if (released || es !== cur) return
      failures = 0
      alive()
      const reopened = interrupted
      interrupted = false
      if (reopened) opts.onReopen?.()
    }
  }
  open()
  return release
}
