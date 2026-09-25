// The tab's recent console errors and failed requests, sent with Report a problem (shell/ProblemReport; the backend's
// feedback.py writes them to browser-log.jsonl). An in-memory ring buffer of the last MAX_ENTRIES, fed by console.error,
// uncaught errors, unhandled rejections and failed fetches (status 400+). Nothing leaves the tab until the analyst
// prepares a report, and the backend removes anything that looks like a key or token.
import { errorText } from './telemetry'

export type ProblemKind = 'console' | 'error' | 'rejection' | 'request'

export interface ProblemEntry {
  ts: string
  kind: ProblemKind
  text: string
  method?: string
  url?: string
  status?: number
  ms?: number
}

export const MAX_ENTRIES = 200
export const TEXT_MAX = 2000
export const URL_MAX = 300
/** Of a failed request's answer, the error the server gave. */
export const DETAIL_MAX = 500

/** The last `max` entries, oldest first. Pure but for its own array. */
export class Ring {
  private items: ProblemEntry[] = []
  constructor(private readonly max = MAX_ENTRIES) {}
  push(e: ProblemEntry): void {
    this.items.push({ ...e, text: cut(e.text, TEXT_MAX) })
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max)
  }
  list(): ProblemEntry[] {
    return this.items.slice()
  }
  clear(): void {
    this.items = []
  }
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [${s.length - max} more characters]`
}

/** One console.error call as a line: strings as they are, an Error as telemetry names it, anything else as JSON.
 * Pure. */
export function consoleText(args: readonly unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return errorText(null, a) ?? a.name
      try {
        return JSON.stringify(a) ?? String(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

/** A request's address as the log keeps it: the path and query of one to this page's server, else the URL without its
 * user and password. Pure given `origin`. */
export function requestUrl(input: RequestInfo | URL, origin: string): string {
  let raw = ''
  if (typeof input === 'string') raw = input
  else if (input instanceof URL) raw = input.href
  else raw = (input as Request).url ?? ''
  try {
    const u = new URL(raw, origin)
    const shown = u.origin === origin ? u.pathname + u.search : `${u.protocol}//${u.host}${u.pathname}${u.search}`
    return cut(shown, URL_MAX)
  } catch {
    return cut(raw, URL_MAX)
  }
}

const HOLDER = '__thimbleProblemLog'
interface Holder {
  ring: Ring
  wired: boolean
}

function holder(): Holder {
  const g = globalThis as unknown as Record<string, Holder | undefined>
  if (!g[HOLDER]) g[HOLDER] = { ring: new Ring(), wired: false }
  return g[HOLDER]!
}

/** What the log holds now, oldest first. */
export function recentProblems(): ProblemEntry[] {
  return holder().ring.list()
}

/** Keep one entry, stamped now unless it says when it happened. */
export function recordProblem(e: Omit<ProblemEntry, 'ts'> & { ts?: string }): void {
  holder().ring.push({ ...e, ts: e.ts ?? new Date().toISOString() })
}

type Win = Pick<Window, 'addEventListener' | 'fetch' | 'location'> & { console: Pick<Console, 'error'> }

/** Wire `win` once: its console.error, its uncaught errors and rejections, and its fetch. A later call does nothing,
 * so a module reloaded in development never wraps twice. */
export function installProblemLog(win: Win = window as unknown as Win): boolean {
  const h = holder()
  if (h.wired) return false
  h.wired = true
  const origin = win.location?.origin ?? 'http://localhost'
  try {
    const origError = win.console.error.bind(win.console)
    win.console.error = (...args: unknown[]) => {
      try {
        recordProblem({ kind: 'console', text: consoleText(args) })
      } catch {
        /* the console still prints */
      }
      origError(...args)
    }
  } catch {
    /* the other sources still work */
  }
  win.addEventListener('error', (e) => {
    try {
      recordProblem({ kind: 'error', text: errorText(e?.message, e?.error) ?? 'uncaught error' })
    } catch {
      /* never */
    }
  })
  win.addEventListener('unhandledrejection', (e) => {
    try {
      recordProblem({ kind: 'rejection', text: errorText(null, e?.reason) ?? 'unhandled rejection' })
    } catch {
      /* never */
    }
  })
  try {
    const orig = win.fetch.bind(win)
    win.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const start = Date.now()
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const url = requestUrl(input, origin)
      try {
        const res = await orig(input, init)
        if (res.status >= 400) {
          const base = { kind: 'request' as const, ts: new Date().toISOString(), method, url, status: res.status, ms: Date.now() - start }
          const head = `${res.status} ${res.statusText}`.trim()
          // the answer is read from a copy, after the caller has its response, so nothing waits on the log; the entry
          // is kept once it is read, so it may follow entries made meanwhile, and its time says when it answered
          res
            .clone()
            .text()
            .then((body) => recordProblem({ ...base, text: body ? `${head}: ${cut(body, DETAIL_MAX)}` : head }))
            .catch(() => recordProblem({ ...base, text: head }))
        }
        return res
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          recordProblem({ kind: 'request', method, url, ms: Date.now() - start, text: `no answer: ${(err as Error)?.message ?? String(err)}` })
        }
        throw err
      }
    }) as typeof fetch
  } catch {
    /* the console and error sources still work */
  }
  return true
}
