// Terminal views (docs/terminal-views.md): a view built in terminal mode has a program, view.term.js, that draws it in
// the panel. thimble's view host (backend/app/term_views.py, `thimble view host`) runs it sandboxed, one process per
// open view, and answers its reader queries; this file starts the host the first time a view opens (one per session,
// beside it, `$.process.spawn`), talks to it over the Unix socket it names (`$.http.fetch`), keeps the open view's last
// frame, and turns the panel's keys and clicks into the view's events.
//
//   POST /open  {slug, cols, rows, theme, ref?}   {id, frame}       the view opened, its first frame
//   POST /event {id, event}                        {frame, acts}    a key, click, drag, wheel, resize or place
//   POST /close {id}                               {ok}
//   stdout: {t: ready, socket, token} once; {t: frame, id, frame} for a frame the program drew on its own (an answer
//   came); {t: ended, id, error} when a program ended
//
// A drawing only says which view it shows and at what size (`viewFor`); the session's timer (`viewPump`, started in
// session.start) opens, resizes and closes the view to match, and starts the host. A call made inside a drawing's
// dispatch belongs to it, and Claude Code abandons a drawing for a newer one, which would end the call (`ui.render:
// superseded`) or the host with it; a timer session.start made lives for the session. A key or a click is sent from
// its own hook, which ends when it is handled, so the frame that answers it comes at once.
//
// An act (a record's place, a side thread, a label's panel) comes only with the frame that answers the analyst's own key
// or click, as the browser's label calls need the analyst's gesture.
import type { Ctx } from './ctx'
import type { Line } from './draw'
import type { Scope } from './data'
import { noControls } from './lib'

/** A frame as the view's program drew it (term_kit/kit.mjs `frame`). */
export type ViewFrame = {
  seq: number
  ack: number
  lines: Line[]
  /** `cursor` marks a chart's cells, whose column under the pointer is marked rather than the region drawn inverse,
   *  with `tips` each cell's words */
  hits: { y: number; x0: number; x1: number; row?: boolean; tip?: string; drag?: boolean; cursor?: boolean; tips?: string[] }[]
  hints: string[]
  /** each hint's keys (a sign's hint shows only while the relay holds the ring) */
  hintKeys?: string[][]
  keys: string[]
  typing: boolean
  /** the text of the view's field that takes typing, while one does */
  field?: { text: string } | null
  sub: string[]
  error?: string
  /** a reader query is out (term_kit/kit.mjs `loading`): the panel says `◌ loading…` */
  loading?: boolean
}

export type ViewAct = { kind: 'open' | 'ask' | 'label'; ref?: string; text?: string; id?: string; name?: string }

/** What the panel draws for the open view: its frame, or why there is none yet. */
export type OpenView = { slug: string; id: string; frame: ViewFrame | null; error: string; cols: number; rows: number; opening: boolean }

type Host = { socket: string; token: string }
type Wanted = { sc: Scope; slug: string; cols: number; rows: number; ref?: string }

/** How often the session's timer matches the open view to what the panel draws. */
export const PUMP_MS = 100
const READY_MS = 60_000

let host: Host | null = null
let hostStarting = false
let hostStop: (() => void) | null = null
let hostError = ''
let current: OpenView | null = null
// what the panel draws now (viewFor), which the timer matches; null when no view shows
let wanted: Wanted | null = null
let again = false
let pumping = false
// the session's context (session.start's `$`), which the timer's work runs on
let sessionCx: Ctx | null = null
// what the panel does with an act (set by panel.tsx)
let actSink: (cx: Ctx, a: ViewAct) => Promise<void> = async () => {}
// the frame of the open view its Client could not draw (ui.fault), and why: the panel draws why in its place
let fault: { seq: number; reason: string } | null = null

// a redraw of the panel from the timer's work or the host's line
const bump = (cx: Ctx): void => void cx.bumpPanel().catch(() => undefined)

/** What the panel does with each act the view asks for during the analyst's key or click. */
export function onViewAct(fn: (cx: Ctx, a: ViewAct) => Promise<void>): void {
  actSink = fn
}

/** The view open in the panel now, or null. */
export function openViewState(): OpenView | null {
  return current
}

/** Text of a frame as the panel may draw it (lib.ts noControls): a frame is the view's program's, and its text a
 *  record's, which can hold an escape sequence, a bell, a NUL or the C1 characters of text decoded twice; a drawing that
 *  holds one does not validate. The kit leaves them out (term_kit/kit.mjs printable); this holds for any frame. */
const printable = (s: unknown): string => noControls(String(s ?? ''))

/** A frame with no control character in its rows, tips, hints, facts, field or error. Pure. */
export function cleanFrame(f: ViewFrame): ViewFrame {
  const lines = (Array.isArray(f.lines) ? f.lines : []).map(l => (Array.isArray(l) ? l : []).map(r => (typeof r?.s === 'string' && noControls(r.s) === r.s ? r : { ...r, s: printable(r?.s) })))
  const hits = (Array.isArray(f.hits) ? f.hits : []).map(h => ({ ...h, ...(h.tip !== undefined ? { tip: printable(h.tip) } : {}), ...(Array.isArray(h.tips) ? { tips: h.tips.map(printable) } : {}) }))
  return {
    ...f,
    lines,
    hits,
    hints: (Array.isArray(f.hints) ? f.hints : []).map(printable),
    sub: (Array.isArray(f.sub) ? f.sub : []).map(printable),
    ...(f.field ? { field: { text: printable(f.field.text) } } : {}),
    ...(f.error !== undefined ? { error: printable(f.error) } : {}),
  }
}

/** The open view's Client could not draw its frame (register.tsx, ui.fault): until the next frame the panel draws
 *  `the view could not draw: <reason>` in its place, dim. */
export function viewFault(reason: string): void {
  if (current?.frame) fault = { seq: current.frame.seq, reason: printable(reason) }
}

/** Why the open view's Client could not draw the frame `seq`, or '' when it drew it (or has not tried). */
export function viewFaultOf(seq: number): string {
  return fault && fault.seq === seq ? fault.reason : ''
}

/**
 * The open view for the panel showing `slug` at `cols` × `rows`, as a drawing asks: what to draw now. The session's
 * timer opens it (starting the host the first time), tells it a new size, and redraws the panel as each step lands.
 */
export function viewFor(sc: Scope, slug: string, cols: number, rows: number, ref?: string): OpenView {
  wanted = { sc, slug, cols, rows, ...(ref ? { ref } : {}) }
  if (current && current.slug === slug) return current
  return { slug, id: '', frame: null, error: '', cols, rows, opening: true }
}

/** The panel shows no view now: the timer ends the open view's program. */
export function closeView(): void {
  wanted = null
}

/** The open view is opened again (its program failed). */
export function retryView(): void {
  again = true
}

/** The host ends (the module unloads, the session ends). */
export function stopHost(): void {
  hostStop?.()
  host = null
  current = null
  wanted = null
}

async function call<T>(cx: Ctx, h: Host, path: string, body: Record<string, unknown>): Promise<T> {
  const r = await cx.fetch(`http://thimble-views${path}`, {
    method: 'POST',
    socketPath: h.socket,
    headers: { 'content-type': 'application/json', 'x-thimble-token': h.token },
    body: JSON.stringify(body),
  })
  let v: unknown
  try {
    v = JSON.parse(r.text)
  } catch {
    throw new Error(`the view host answered ${r.status}`)
  }
  const err = (v as { error?: unknown })?.error
  if (typeof err === 'string') throw new Error(err)
  return v as T
}

/**
 * The session's timer: the open view matched to what the panel draws. Its program closed when no view shows, the view
 * opened when another shows (the host started the first time), a new size sent. One run at a time.
 */
export async function viewPump(cx: Ctx): Promise<void> {
  sessionCx = cx
  if (pumping) return
  pumping = true
  try {
    await pump(cx)
  } finally {
    pumping = false
  }
}

async function pump(cx: Ctx): Promise<void> {
  const w = wanted
  const was = current
  if (was && (!w || was.slug !== w.slug || again)) {
    current = null
    fault = null
    if (was.id && host) await call(cx, host, '/close', { id: was.id }).catch(() => undefined)
  }
  if (!w) return
  if (!current) {
    again = false
    const me: OpenView = { slug: w.slug, id: '', frame: null, error: '', cols: w.cols, rows: w.rows, opening: true }
    current = me
    const h = await ensureHost(cx, w.sc)
    if (current !== me) return
    if (!h) {
      me.error = `thimble's view host did not start${hostError ? `: ${printable(hostError)}` : ''}`
      me.opening = false
      return bump(cx)
    }
    try {
      const got = await call<{ id: string; frame: ViewFrame }>(cx, h, '/open', { slug: w.slug, cols: w.cols, rows: w.rows, theme: await cx.theme(), ...(w.ref ? { ref: w.ref } : {}) })
      if (current !== me) {
        await call(cx, h, '/close', { id: got.id }).catch(() => undefined)
        return
      }
      me.id = got.id
      me.frame = cleanFrame(got.frame)
    } catch (err) {
      me.error = printable(err instanceof Error ? err.message : err).slice(0, 400)
    }
    me.opening = false
    return bump(cx)
  }
  // the panel's size changed
  if (current.id && !current.error && (current.cols !== w.cols || current.rows !== w.rows)) {
    current.cols = w.cols
    current.rows = w.rows
    await sendEvent(cx, { t: 'resize', cols: w.cols, rows: w.rows })
  }
}

/** The session's view host, started the first time (from the timer, which lives for the session); null, and why in
 *  `hostError`, when it does not start. */
async function ensureHost(cx: Ctx, sc: Scope): Promise<Host | null> {
  if (host) return host
  if (hostStarting) return null
  hostStarting = true
  hostError = ''
  const errs: string[] = []
  const got = await new Promise<Host | null>(resolve => {
    let settled = false
    const done = (h: Host | null) => {
      if (settled) return
      settled = true
      if (!h) hostError = errs.at(-1) ?? hostError
      resolve(h)
    }
    const onLine = (line: string) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (msg.t === 'ready' && typeof msg.socket === 'string' && typeof msg.token === 'string') {
        host = { socket: msg.socket, token: msg.token }
        done(host)
      } else if (typeof msg.error === 'string' && !msg.t) {
        errs.push(msg.error)
      } else if (msg.t === 'frame' && current && msg.id === current.id && msg.frame) {
        // a frame the program drew on its own: an answer came
        const f = cleanFrame(msg.frame as ViewFrame)
        if (!current.frame || f.seq > current.frame.seq) {
          current.frame = f
          bump(cx)
        }
      } else if (msg.t === 'ended' && current && msg.id === current.id) {
        current.error = `the view's program ended: ${printable(msg.error)}`.slice(0, 300)
        bump(cx)
      }
    }
    const run = cx.spawnLines([sc.bin, 'view', 'host', '--cwd', sc.cwd], { cwd: sc.cwd, env: sc.env }, onLine, err => errs.push(err.trim().split('\n').at(-1) ?? ''))
    hostStop = run.stop
    void run.done.then(() => {
      host = null
      hostStop = null
      if (current) {
        current.error = current.error || `thimble's view host ended${errs.length ? `: ${printable(errs.at(-1))}` : ''}`
        current.id = ''
        bump(cx)
      }
      done(null)
    })
    cx.later(READY_MS, () => done(null))
  })
  hostStarting = false
  return got
}

/** An event for the open view: its answering frame is drawn, and the acts made while it was handled are done. */
export async function sendEvent(cx: Ctx, event: Record<string, unknown>): Promise<void> {
  const v = current
  if (!v || !v.id || !host) return
  try {
    const got = await call<{ frame: ViewFrame | null; acts: ViewAct[] }>(cx, host, '/event', { id: v.id, event })
    if (current !== v) return
    if (got.frame && (!v.frame || got.frame.seq >= v.frame.seq)) v.frame = cleanFrame(got.frame)
    bump(sessionCx ?? cx)
    // an ask's words are a record's, which the thread's panel draws
    for (const a of got.acts ?? []) await actSink(cx, typeof a.text === 'string' ? { ...a, text: printable(a.text) } : a)
  } catch (err) {
    if (current === v) {
      v.error = printable(err instanceof Error ? err.message : err).slice(0, 400)
      bump(sessionCx ?? cx)
    }
  }
}

/** A post of hooks/viewclient.tsx: each click and drag not seen yet, as the open view's events. */
const seen = new Map<string, number>()
export async function viewMessage(cx: Ctx, d: Record<string, unknown>): Promise<boolean> {
  const origin = typeof d.vorigin === 'string' ? d.vorigin : ''
  if (!Array.isArray(d.vacts) || !origin) return false
  let clicked = false
  for (const a of d.vacts as { n?: unknown; seq?: unknown; i?: unknown; x?: unknown; x0?: unknown; x1?: unknown; drag?: unknown }[]) {
    if (typeof a?.n !== 'number' || a.n <= (seen.get(origin) ?? 0)) continue
    seen.set(origin, a.n)
    clicked = true
    const i = Number(a.i)
    if (!(i >= 0)) continue
    if (a.drag) await sendEvent(cx, { t: 'drag', seq: Number(a.seq), i, x0: Number(a.x0) || 0, x1: Number(a.x1) || 0 })
    else await sendEvent(cx, { t: 'click', seq: Number(a.seq), i, x: Number(a.x) || 0 })
  }
  return clicked
}
