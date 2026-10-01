// The browser's record of what the analyst did, posted in batches to POST /ws/{c}/telemetry. Nothing here blocks the
// UI: a batch that fails is requeued, a handler that throws is swallowed. Three sources: the API requests the page
// makes (one wrapped fetch), clicks on interactive elements, and the window's uncaught errors.
import { workspaceFromUrl } from './workspace'

export const CLIENT_KINDS = [
  'page-load',
  'page-unload',
  'visibility',
  'corpus-switch',
  'panel-open',
  'panel-close',
  'tab-activate',
  'start-toggle',
  'start-run',
  'agent-row-expand',
  'chip-teleport',
  'pointer-open',
  'pointer-send',
  'chat-open',
  'chat-interrupt',
  'chat-settings',
  'thread-open',
  'thread-switch',
  'thread-fold',
  'thread-rename',
  'thread-delete',
  'thread-ask-again',
  'chat-retry',
  'ask-send',
  'notebook-switch',
  'report-generate',
  'file-close',
  'view-open',
  'view-build',
  'view-dismiss',
  'reader-find',
  'search',
  'label-edit',
  'label-apply',
  'card-code-toggle',
  'cell-run',
  'cell-edit',
  'cell-delete',
  'takeaway-edit',
  'filter-set',
  'filter-clear',
  'report-frame-edit',
  'rewrite-span',
  'error',
  'ui-click',
  'ui-select',
] as const
export type TelemetryKind = (typeof CLIENT_KINDS)[number]

export type Detail = Record<string, unknown>

export interface TelemetryRecord {
  kind: TelemetryKind
  target?: string | null
  detail?: Detail | null
  duration_ms?: number | null
  ts: string
  session: string
  seq?: number
}

export const FLUSH_MS = 2000
export const RETRY_MS = 5000
export const BATCH_MAX = 200
export const QUEUE_MAX = 2000
export const STASH_KEY = 'thimble.telemetry.pending'
export const STASH_MAX = 500
export const SELECT_SETTLE_MS = 700
const TEXT_MAX = 2000
export const ERROR_TEXT_MAX_BYTES = 1800

function newSession(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* fall through */
  }
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
export const SESSION: string = newSession()

// ---- the queue ----
export interface Pending {
  ws: string
  rec: TelemetryRecord
}
export interface QueueDeps {
  send: (workspace: string, records: TelemetryRecord[], beacon: boolean) => boolean | void | Promise<boolean | void>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
}
export function makeQueue(deps: QueueDeps) {
  const pending: Pending[] = []
  let timer: unknown = null
  const cap = (): void => {
    if (pending.length > QUEUE_MAX) pending.splice(0, pending.length - QUEUE_MAX)
  }
  const arm = (ms: number): void => {
    if (timer != null) return
    timer = deps.setTimer(() => {
      timer = null
      flush(false)
    }, ms)
  }
  const requeue = (ws: string, recs: TelemetryRecord[], beacon: boolean): void => {
    pending.push(...recs.map((rec) => ({ ws, rec })))
    cap()
    if (!beacon) arm(RETRY_MS)
  }
  const flush = (beacon = false): void => {
    if (timer != null) {
      deps.clearTimer(timer)
      timer = null
    }
    if (!pending.length) return
    const byWs = new Map<string, TelemetryRecord[]>()
    for (const { ws, rec } of pending.splice(0)) {
      const list = byWs.get(ws)
      if (list) list.push(rec)
      else byWs.set(ws, [rec])
    }
    const batches: [string, TelemetryRecord[]][] = []
    for (const [ws, recs] of byWs) for (let i = 0; i < recs.length; i += BATCH_MAX) batches.push([ws, recs.slice(i, i + BATCH_MAX)])
    for (const [ws, recs] of batches) {
      try {
        const r = deps.send(ws, recs, beacon)
        if (r === false) requeue(ws, recs, beacon)
        else if (r && typeof (r as Promise<unknown>).then === 'function')
          (r as Promise<boolean | void>).then(
            (ok) => {
              if (ok === false) requeue(ws, recs, beacon)
            },
            () => requeue(ws, recs, beacon),
          )
      } catch {
        requeue(ws, recs, beacon)
      }
    }
  }
  const push = (ws: string, rec: TelemetryRecord): void => {
    pending.push({ ws, rec })
    cap()
    arm(FLUSH_MS)
  }
  const drain = (): Pending[] => pending.splice(0)
  const restore = (rows: Pending[]): void => {
    pending.push(...rows)
    cap()
    if (pending.length) arm(FLUSH_MS)
  }
  return { push, flush, size: () => pending.length, drain, restore }
}

// ---- the stash for a leaving page ----
export interface StashStore {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
}
export function stash(store: StashStore, rows: Pending[]): number {
  const keep = rows.slice(-STASH_MAX).filter((r) => r && typeof r.ws === 'string' && r.rec && typeof r.rec.kind === 'string')
  try {
    if (!keep.length) return 0
    store.setItem(STASH_KEY, JSON.stringify(keep))
    return keep.length
  } catch {
    return 0
  }
}
export function unstash(store: StashStore): Pending[] {
  try {
    const raw = store.getItem(STASH_KEY)
    if (!raw) return []
    store.removeItem(STASH_KEY)
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter((r): r is Pending => !!r && typeof (r as Pending).ws === 'string' && !!(r as Pending).rec && typeof (r as Pending).rec.kind === 'string' && typeof (r as Pending).rec.session === 'string')
  } catch {
    return []
  }
}

// ---- classification of API requests (pure) ----
export interface Derived {
  kind: TelemetryKind
  target?: string | null
  detail?: Detail | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const text = (v: unknown): string | null => {
  const s = str(v)
  return s ? s.slice(0, TEXT_MAX) : null
}

function parseBody(body: string | null | undefined): Record<string, unknown> | null {
  if (!body || body.length > 16_384) return null
  try {
    const v = JSON.parse(body) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The kind an API request means, or null when the request is not an analyst action. */
export function classifyRequest(method: string, url: string, body?: string | null): Derived | null {
  let u: URL
  try {
    u = new URL(url, 'http://thimble.local')
  } catch {
    return null
  }
  const m = /^\/api\/ws\/([^/]+)\/(.*)$/.exec(u.pathname)
  if (!m) return null
  const parts = m[2].split('/').filter(Boolean)
  const [a, b, c] = parts
  const B = () => parseBody(body)
  if (a === 'telemetry') return null
  if (a === 'chats' && b && c === 'interrupt' && method === 'POST') return { kind: 'chat-interrupt', target: `chat:${decodeURIComponent(b)}` }
  if (a === 'chats' && b && !c && method === 'DELETE') return { kind: 'thread-delete', target: `chat:${decodeURIComponent(b)}` }
  if (a === 'chats' && b && !c && method === 'PUT') {
    const o = B()
    const model = str(o?.model)
    const effort = str(o?.effort)
    if (str(o?.title) && !model && !effort) return { kind: 'thread-rename', target: `chat:${decodeURIComponent(b)}` }
    if (!model && !effort) return null
    return { kind: 'chat-settings', target: `chat:${decodeURIComponent(b)}`, detail: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } }
  }
  if (a === 'chats' && !b && method === 'POST') {
    const anchor = str(B()?.anchor)
    return { kind: 'thread-open', target: anchor }
  }
  if (a === 'settings' && method === 'PUT' && B()?.models) return { kind: 'chat-settings', target: null, detail: { roles: Object.keys(B()!.models as object) } }
  // a message typed in the main chat or a thread, and the Report tab's Write: the chats hold the text, this row the moment
  // and the page it was sent from
  if (a === 'events' && !b && method === 'POST' && ['main', 'thread', 'write'].includes(str(B()?.kind) ?? '')) {
    const k = str(B()?.kind)
    const payload = (B()?.payload ?? {}) as Record<string, unknown>
    if (k === 'write') return { kind: 'report-generate', target: str(payload.doc) ? `report:${str(payload.doc)}` : null, detail: { request: !!str(payload.text), ...(str(payload.after) ? { after: str(payload.after) } : {}) } }
    const thread = str(payload.thread)
    return { kind: 'ask-send', target: k === 'main' ? 'chat:main' : thread ? `chat:${thread}` : null, detail: { event: k, chars: (str(payload.text) ?? '').length } }
  }
  // a message typed into the orientation's thread, which resumes it or waits in its queue
  if (a === 'orientation' && b === 'message' && method === 'POST') return { kind: 'ask-send', target: 'chat:orient', detail: { event: 'orient-follow-up', chars: (str(B()?.text) ?? '').length } }
  // the frame the analyst selected or worked in on the canvas, which the canvas reports as it changes
  if (a === 'canvas' && b === 'active-group' && method === 'PUT') {
    const group = str(B()?.group)
    return group ? { kind: 'notebook-switch', target: `group:${group}` } : null
  }
  if (a === 'events' && !b && method === 'POST' && str(B()?.kind) === 'start') {
    const payload = B()?.payload as Record<string, unknown> | undefined
    // the switches by the start event's names (StartBody), `final` being the deck's; legacy start events name the deck's
        // switch `analyze_data`, or carry `report` alone
    const on = { final: payload?.final_notebook ?? payload?.analyze_data ?? true, views: payload?.propose_views ?? false, report: payload?.generate_report ?? payload?.report, critique: payload?.critique, ultracode: payload?.ultracode }
    const passes = (['final', 'views', 'critique', 'report', 'ultracode'] as const).filter((p) => on[p] === true)
    return { kind: 'start-run', target: null, detail: { passes, ...(str(payload?.effort) ? { effort: str(payload?.effort) } : {}), ...(str(payload?.permissions) ? { permissions: str(payload?.permissions) } : {}) } }
  }
  if (a === 'filters') {
    if (method === 'PUT') {
      const o = B()
      return { kind: 'filter-set', target: str(o?.concept) ? `concept:${str(o?.concept)}` : null, detail: { scope: str(o?.scope), value: str(o?.value) } }
    }
    if (method === 'DELETE' && b) return { kind: 'filter-clear', target: null, detail: { scope: decodeURIComponent(b) } }
  }
  if (a === 'views' && b === 'proposals' && c && parts[3] === 'retry' && method === 'POST') return { kind: 'view-build', target: `view:${decodeURIComponent(c)}`, detail: { again: true } }
  if (a === 'cells' && b) {
    const cell = `cell:${decodeURIComponent(b)}`
    if (c === 'run' && method === 'POST') return { kind: 'cell-run', target: cell }
    if (!c && method === 'PUT') {
      const o = B() ?? {}
      if ('takeaway' in o && !('code' in o)) return { kind: 'takeaway-edit', target: cell }
      return { kind: 'cell-edit', target: cell, detail: { field: 'code' in o ? 'code' : 'title' in o ? 'title' : 'payload' } }
    }
    if (!c && method === 'DELETE') return { kind: 'cell-delete', target: cell }
  }
  if (a === 'investigations' && parts[3]) {
    const slug = decodeURIComponent(parts[3])
    if (parts[4] === 'rewrite' && method === 'POST') {
      const o = B()
      return { kind: 'rewrite-span', target: str(o?.span), detail: { text: text(o?.instruction) } }
    }
    if (parts[4] === 'frame' && parts[5] && method !== 'GET') return { kind: 'report-frame-edit', target: `report:${slug}`, detail: { unit: parts[5], method: method.toLowerCase() } }
  }
  return null
}

// ---- the generic click stream ----
export const INTERACTIVE = 'button, a[href], input, select, textarea, summary, label, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [role="link"], [tabindex]:not([tabindex="-1"])'
export const LABEL_MAX = 40
export const LABEL_WORDS_MAX = 4
const LABEL_RE = /^[^.!?;:…]+$/
const LABEL_TAGS = new Set(['BUTTON', 'A', 'SUMMARY', 'LABEL'])
const LABEL_ROLES = new Set(['button', 'tab', 'menuitem', 'link', 'option', 'checkbox', 'switch'])
const NAME_RE = /^[A-Za-z0-9._:-]{1,80}$/

export interface GenericInfo {
  tel: string | null
  tag: string | null
  panel: string | null
  label: string | null
}

export function labelOf(inter: Element, role: string | null): string | null {
  if (!(LABEL_TAGS.has(inter.tagName) || (role != null && LABEL_ROLES.has(role.toLowerCase())))) return null
  const t = (inter.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (!t || t.length > LABEL_MAX || t.split(' ').length > LABEL_WORDS_MAX || !LABEL_RE.test(t)) return null
  return t
}

/** The panel a node sits in: the nearest `data-panel`. */
export function panelOf(el: Element): string | null {
  const p = el.closest('[data-panel]')
  return p?.getAttribute('data-panel') ?? null
}

export function gatherGeneric(el: Element): GenericInfo {
  const inter = el.closest(INTERACTIVE)
  if (!inter) return { tel: null, tag: null, panel: null, label: null }
  let tel: string | null = null
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (tel == null && n.getAttribute('data-tel')) tel = n.getAttribute('data-tel')
    if (n === inter) break
  }
  const role = inter.getAttribute('role')
  const tag = (role && /^[a-z]+$/i.test(role) ? role : inter.tagName).toLowerCase()
  return { tel, tag, panel: panelOf(el), label: labelOf(inter, role) }
}

export function classifyGeneric(i: GenericInfo): { kind: TelemetryKind; target: string; detail: Detail } | null {
  if (!i.tag) return null
  const name = (i.tel && NAME_RE.test(i.tel) ? i.tel : null) ?? i.tag
  const detail: Detail = { name, tag: i.tag }
  if (i.tel) detail.tel = true
  if (i.panel) detail.panel = i.panel
  if (i.label) detail.label = i.label
  return { kind: 'ui-click', target: `ui:${name}`, detail }
}

export function uaFamily(ua: string): string {
  const s = ua.toLowerCase()
  if (s.includes('firefox')) return 'firefox'
  if (s.includes('edg/')) return 'edge'
  if (s.includes('chrome') || s.includes('chromium') || s.includes('headlesschrome')) return 'chromium'
  if (s.includes('safari')) return 'safari'
  return 'other'
}

// ---- what nothing caught ----
export function capJsonBytes(s: string, max: number): string {
  const bytes = (t: string): number => new TextEncoder().encode(JSON.stringify(t)).length
  let out = s
  let n = bytes(out)
  while (n > max && out.length) {
    out = out.slice(0, Math.max(0, Math.floor((out.length * max) / n) - 1))
    if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1)
    n = bytes(out)
  }
  return out
}

/** One line for an uncaught error: the message and the first stack frame, never the whole stack. */
export function errorText(message: unknown, error: unknown): string | null {
  const err = error != null && typeof error === 'object' ? (error as { name?: unknown; message?: unknown; stack?: unknown }) : null
  const msg = str(message) ?? str(err?.message) ?? (error != null && typeof error !== 'object' ? str(String(error)) : null)
  const name = str(err?.name) ?? 'Error'
  const lines = (str(err?.stack) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const frame = lines.find((l) => l.startsWith('at ')) ?? lines.find((l) => l !== `${name}: ${msg ?? ''}` && l !== (msg ?? '') && l !== name) ?? null
  if (!msg && !frame) return null
  const line = text(frame ? `${msg ?? '(no message)'} | ${frame}` : msg)
  return line ? capJsonBytes(line, ERROR_TEXT_MAX_BYTES) : null
}

/** The browser's notice that a ResizeObserver callback changed layout again within one frame. The browser delivers the
 * rest in the next frame, so nothing is lost and it is no error. */
const BENIGN_ERROR_RE = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/

/** Whether an uncaught error event's message is a notice that is no error (BENIGN_ERROR_RE). Pure. */
export const benignError = (message: unknown): boolean => typeof message === 'string' && BENIGN_ERROR_RE.test(message)

export function wireErrors(win: Pick<Window, 'addEventListener'>, report: (text: string) => void): void {
  win.addEventListener('error', (e) => {
    try {
      if (benignError(e?.message)) return
      const t = errorText(e?.message, e?.error)
      if (t) report(t)
    } catch {
      /* never */
    }
  })
  win.addEventListener('unhandledrejection', (e) => {
    try {
      report(errorText(null, e?.reason) ?? 'unhandled rejection')
    } catch {
      /* never */
    }
  })
}

// ---- the live poster ----
const HOLDER = '__thimbleTelemetry'
interface Holder {
  wired: boolean
  orig: typeof fetch | null
  observe: (input: RequestInfo | URL, init: RequestInit | undefined) => void
  click: (e: MouseEvent) => void
  visibility: () => void
  pagehide: () => void
  selection: () => void
  error: (text: string) => void
}
function holder(): Holder | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, Holder | undefined>
  if (!w[HOLDER]) w[HOLDER] = { wired: false, orig: null, observe: () => undefined, click: () => undefined, visibility: () => undefined, pagehide: () => undefined, selection: () => undefined, error: () => undefined }
  return w[HOLDER]!
}

const loadedAt = Date.now()
let lastWs: string | null = null
let nextSeq = 0
let unloaded = false
let selectTimer: number | null = null
let lastSelection = ''

function send(ws: string, records: TelemetryRecord[], beacon: boolean): boolean | Promise<boolean> {
  const url = `/api/ws/${encodeURIComponent(ws)}/telemetry`
  const body = JSON.stringify(records)
  try {
    if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      return navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
    }
    const f = holder()?.orig ?? (typeof fetch === 'function' ? fetch : null)
    if (!f) return false
    return f(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Thimble-Session': SESSION }, body, keepalive: beacon }).then(
      (r) => r.ok || (r.status >= 400 && r.status < 500),
      () => false,
    )
  } catch {
    return false
  }
}
const queue = makeQueue({
  send,
  setTimer: (fn, ms) => {
    if (typeof window === 'undefined') return null
    const t: unknown = window.setTimeout(fn, ms)
    ;(t as { unref?: () => void } | null)?.unref?.()
    return t
  },
  clearTimer: (t) => {
    if (typeof window !== 'undefined' && t != null) window.clearTimeout(t as number)
  },
})

let held = false
/** While held (the product tour runs), nothing is recorded: what the page does then is not the analyst's work. */
export function hold(on: boolean): void {
  held = on
}

/** Record one action of the analyst in the current workspace. Never throws; nothing when the page names no workspace. */
export function track(kind: TelemetryKind, opts: { target?: string | null; detail?: Detail | null; duration_ms?: number | null; ts?: string } = {}): void {
  try {
    const ws = workspaceFromUrl()
    if (!ws || held) return
    noteWorkspace(ws)
    const record: TelemetryRecord = { kind, ts: opts.ts ?? new Date().toISOString(), session: SESSION, seq: nextSeq++ }
    if (opts.target !== undefined) record.target = opts.target
    if (opts.detail && Object.keys(opts.detail).length) record.detail = opts.detail
    if (opts.duration_ms != null && Number.isFinite(opts.duration_ms)) record.duration_ms = Math.max(0, Math.round(opts.duration_ms))
    queue.push(ws, record)
  } catch {
    /* never */
  }
}
export function flush(beacon = false): void {
  try {
    queue.flush(beacon)
  } catch {
    /* never */
  }
}
function noteWorkspace(ws: string): void {
  if (lastWs !== null && lastWs !== ws) {
    lastWs = ws
    queue.push(ws, { kind: 'corpus-switch', target: `workspace:${ws}`, ts: new Date().toISOString(), session: SESSION, seq: nextSeq++ })
    return
  }
  lastWs = ws
}

function observeRequest(input: RequestInfo | URL, init: RequestInit | undefined): void {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')).toUpperCase()
  const body = typeof init?.body === 'string' ? init.body : null
  const d = classifyRequest(method, url, body)
  if (d) track(d.kind, { target: d.target ?? null, detail: d.detail ?? null })
}

function onClick(e: MouseEvent): void {
  const el = e.target instanceof Element ? e.target : null
  // the product tour's own popover and examples (src/tour) are not the analyst's work
  if (!el || el.closest('.tour-root, .tour-host')) return
  const g = classifyGeneric(gatherGeneric(el))
  if (g) track(g.kind, { target: g.target, detail: g.detail })
}

function onVisibility(): void {
  track('visibility', { detail: { state: document.hidden ? 'hidden' : 'visible' } })
  if (document.hidden) flush(true)
}
function storage(): StashStore | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null
  } catch {
    return null
  }
}
function onPagehide(): void {
  if (!unloaded) {
    unloaded = true
    track('page-unload', { duration_ms: Date.now() - loadedAt })
  }
  flush(true)
  const store = storage()
  if (store && queue.size()) stash(store, queue.drain())
}
function onSelectionChange(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  if (selectTimer != null) window.clearTimeout(selectTimer)
  selectTimer = window.setTimeout(() => {
    selectTimer = null
    try {
      const sel = document.getSelection()
      const t = sel ? sel.toString().trim() : ''
      if (!t || t === lastSelection) {
        if (!t) lastSelection = ''
        return
      }
      lastSelection = t
      const node = sel?.anchorNode
      const el = node instanceof Element ? node : node?.parentElement ?? null
      const panel = el ? panelOf(el) : null
      track('ui-select', { target: panel ? `ui:${panel}` : null, detail: { length: t.length, ...(panel ? { panel } : {}) } })
    } catch {
      /* never */
    }
  }, SELECT_SETTLE_MS)
}

/** Wire the page once; a later call swaps the handlers behind the existing listeners. */
export function install(): boolean {
  const h = holder()
  if (!h || typeof document === 'undefined') return false
  h.observe = observeRequest
  h.click = onClick
  h.visibility = onVisibility
  h.pagehide = onPagehide
  h.selection = onSelectionChange
  h.error = (t) => track('error', { detail: { source: 'window', text: t } })
  if (h.wired) return false
  h.wired = true
  const store = storage()
  if (store) {
    const rows = unstash(store)
    if (rows.length) queue.restore(rows)
  }
  try {
    const orig = window.fetch.bind(window)
    h.orig = orig
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const p = orig(input, init)
      try {
        h.observe(input, init)
      } catch {
        /* the request is untouched */
      }
      return p
    }) as typeof fetch
  } catch {
    /* the click and error sources still work */
  }
  document.addEventListener('click', (e) => h.click(e), true)
  document.addEventListener('visibilitychange', () => h.visibility())
  document.addEventListener('selectionchange', () => h.selection())
  window.addEventListener('pagehide', () => h.pagehide())
  window.addEventListener('beforeunload', () => h.pagehide())
  wireErrors(window, (t) => h.error(t))
  track('page-load', { detail: { ua_family: uaFamily(typeof navigator !== 'undefined' ? navigator.userAgent : '') } })
  return true
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && workspaceFromUrl()) install()
