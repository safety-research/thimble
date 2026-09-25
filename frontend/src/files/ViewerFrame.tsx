// A view's page in a sandboxed frame, the page half of the bridge (the frame half is backend/app/viewer_bridge.js).
// The page may reach only the view's media route; everything else comes through these messages:
//   open      the place to show (ref, locator, resolved answer, quoted passage to highlight)
//   quoted    whether that passage showed; when it did not, onQuoteMissing
//   fetch     answered with reader.records(index, query)
//   cite      a ⌘-click inside the frame opens the pointer's box on that element
//   navigate  another place, opened the way a chip opens it (lib/teleport)
//   size      the document's height, used when the frame sizes to its content (`fit`)
//   anchors   the data-anchor refs the page shows, answered with `labels` (labels.ts viewMarks)
// plus ready, error, point and cmd (for the ⌘ pointer). A new ref is sent as a new `open` without reloading the page.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { viewFonts, viewStyle, withFrameStyle } from '../lib/frame'
import { notePress } from '../lib/surfaces'
import { teleport } from '../lib/teleport'
import { useTheme } from '../lib/theme'
import { token } from '../lib/vizTheme'
import { cmdCursors } from '../pointer/cursor'
import type { Concept, LabelRow, ViewOpen } from '../lib/types'
import { recordRef, viewMarks } from './labels'
import { wantLabels, watchPathLabels } from './marks'

const P = 'thimble:'
const FIT_MIN = 80
const FIT_MAX = 1600

export interface ViewerFrameProps {
  ws: string
  slug: string
  /** what the view shows: a file ref it accepts or one of its view:<slug>/<key> refs; none for the view's own start */
  targetRef?: string
  /** the file the view was opened on, sent as `open`'s path when no ref names a place in it */
  path?: string
  title: string
  /** the frame is as tall as its page (a card) rather than filling its box (Files) */
  fit?: boolean
  /** the labels that are on, drawn over the records the page shows */
  labels?: readonly Concept[]
  onError?: (message: string) => void
  className?: string
  /** a passage inside the record `targetRef` names, for a view that shows the record but not the span */
  quote?: ViewQuote
  /** the page did not show `quote` */
  onQuoteMissing?: () => void
}

/** A quoted passage: the record ref it sits in and its text. */
export interface ViewQuote {
  record: string
  text: string
}

/** A rect the frame reports, in the page's coordinates. */
export function toPage(frame: HTMLIFrameElement, r: { left: number; top: number; width: number; height: number }): DOMRect {
  const f = frame.getBoundingClientRect()
  return new DOMRect(f.left + r.left, f.top + r.top, r.width, r.height)
}

const NO_LABELS: readonly Concept[] = []

/** The labels over the page's records: keeps the refs the page reports (`anchors`) and sends the marks of the labels
 * that are on as `labels` whenever they change; each message replaces the last. `reset` forgets the refs. */
function useViewLabels(ws: string, on: readonly Concept[], post: (msg: unknown) => void): { add: (refs: unknown) => void; reset: () => void } {
  const refs = useRef(new Set<string>())
  /** the refs whose block of rows has been asked for */
  const asked = useRef(new Set<string>())
  const rows = useRef(new Map<string, Map<string, Map<string, LabelRow>>>())
  const watching = useRef(new Map<string, () => void>())
  const sent = useRef('{}')
  const [tick, setTick] = useState(0)
  const send = useRef(post)
  send.current = post

  useEffect(
    () => () => {
      for (const off of watching.current.values()) off()
      watching.current.clear()
      rows.current.clear()
      asked.current.clear()
    },
    [ws],
  )
  const add = useCallback((list: unknown) => {
    if (!Array.isArray(list)) return
    let fresh = false
    for (const ref of list) {
      if (typeof ref !== 'string' || refs.current.has(ref) || !recordRef(ref)) continue
      refs.current.add(ref)
      fresh = true
    }
    if (fresh) setTick((t) => t + 1)
  }, [])
  const reset = useCallback(() => {
    refs.current.clear()
    sent.current = '{}'
  }, [])
  useEffect(() => {
    if (on.length) {
      for (const ref of refs.current) {
        if (asked.current.has(ref)) continue
        asked.current.add(ref)
        const at = recordRef(ref)!
        if (!watching.current.has(at.path))
          watching.current.set(
            at.path,
            watchPathLabels(ws, at.path, (got) => {
              rows.current.set(at.path, got)
              setTick((t) => t + 1)
            }),
          )
        wantLabels(ws, at.path, at.line)
      }
    }
    const marks = viewMarks(on, { get: (ref) => rows.current.get(recordRef(ref)?.path ?? '')?.get(ref) }, refs.current)
    const text = JSON.stringify(marks)
    if (text === sent.current) return
    sent.current = text
    send.current({ type: P + 'labels', marks })
  }, [ws, on, tick])
  return useMemo(() => ({ add, reset }), [add, reset])
}

export function ViewerFrame({ ws, slug, targetRef, path, title, fit, labels = NO_LABELS, onError, className, quote, onQuoteMissing }: ViewerFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [page, setPage] = useState<string | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const { resolved, key } = useTheme()
  const ready = useRef(false)
  const target = useRef(targetRef)
  target.current = targetRef
  const report = useRef(onError)
  report.current = onError
  const quoted = useRef(quote)
  quoted.current = quote
  const missing = useRef(onQuoteMissing)
  missing.current = onQuoteMissing

  const [fonts, setFonts] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    ready.current = false
    api
      .viewFrame(ws, slug)
      .then((doc) => alive && setPage(doc))
      .catch((e: Error) => alive && report.current?.(`the view's page did not load: ${e.message}`))
    void viewFonts().then((f) => alive && setFonts(f))
    return () => {
      alive = false
    }
  }, [ws, slug])
  // the theme's tokens are read when the page is built, so a theme change reloads the page with the new colours; the
  // page waits for the app's faces so it is drawn once, in them
  const doc = useMemo(() => (page == null || fonts == null ? null : withFrameStyle(page, viewStyle(resolved) + fonts)), [page, fonts, resolved, key]) // key: the tokens are read again when the paper or the accent changes
  const post = (msg: unknown) => ref.current?.contentWindow?.postMessage(msg, '*')
  const marks = useViewLabels(ws, labels, post)
  // a new document is a new page, which says ready again and reports its anchors afresh; set before any message of the
  // new page can be handled
  useLayoutEffect(() => {
    ready.current = false
    marks.reset()
  }, [doc, marks])
  const sendOpen = async (r: string | undefined) => {
    let open: ViewOpen = path ? { ref: null, path } : { ref: null }
    if (r) {
      try {
        open = await api.viewOpen(ws, slug, r)
      } catch (e) {
        open = { ref: r, error: (e as Error).message }
      }
      if (open.error) report.current?.(`${r}: ${open.error}`)
    }
    const q = quoted.current
    if (target.current === r) post({ type: P + 'open', open, quote: q && q.record === r ? q : undefined })
  }

  // a new ref (or a new passage in the same record) for a page that is already up: a new `open`, no reload
  useEffect(() => {
    if (ready.current) void sendOpen(targetRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef, quote?.text])

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const frame = ref.current
      if (!frame || e.source !== frame.contentWindow) return
      const d = (e.data ?? {}) as Record<string, any>
      switch (d.type) {
        case P + 'ready':
          ready.current = true
          void sendOpen(target.current)
          // the ⌘ arrow up front, so a ⌘ pressed while the frame has the focus shows it too
          post({ type: P + 'cmd', on: document.body.hasAttribute('data-cmd'), cursor: cmdCursors(token('--accent')).arrow })
          return
        case P + 'fetch': {
          try {
            const res = await api.viewRecords(ws, slug, d.query)
            post({ type: P + 'result', id: d.id, data: res.data })
          } catch (err) {
            post({ type: P + 'result', id: d.id, error: (err as Error).message })
          }
          return
        }
        case P + 'cite': {
          if (typeof d.ref !== 'string' || !d.ref) return
          const rect = d.rect ? toPage(frame, d.rect) : frame.getBoundingClientRect()
          const payload = { anchor: d.ref, text: String(d.text ?? ''), element: String(d.element ?? ''), rect, frame, view: slug }
          bus.emit('pointAt', payload)
          return
        }
        case P + 'point':
          bus.emit('pointHover', { rect: d.rect ? toPage(frame, d.rect) : null })
          return
        case P + 'navigate':
          // the click that asked for it landed in the frame's document, which the shell does not see
          if (typeof d.ref !== 'string' || !d.ref) return
          notePress(frame)
          teleport(d.ref)
          return
        case P + 'error':
          report.current?.(String(d.message ?? 'the view failed'))
          return
        case P + 'size':
          if (typeof d.height === 'number' && Number.isFinite(d.height)) setHeight(Math.min(FIT_MAX, Math.max(FIT_MIN, Math.ceil(d.height))))
          return
        case P + 'anchors':
          marks.add(d.refs)
          return
        case P + 'quoted':
          if (d.found === false) missing.current?.()
          return
      }
    }
    window.addEventListener('message', onMessage)
    const offCmd = bus.on('cmdHeld', ({ on, cursor }) => post({ type: P + 'cmd', on, cursor }))
    return () => {
      window.removeEventListener('message', onMessage)
      offCmd()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, slug, marks])

  if (doc == null) return <div className={'viewer-frame viewer-frame-loading' + (className ? ` ${className}` : '')} />
  return (
    <iframe
      ref={ref}
      className={'viewer-frame' + (className ? ` ${className}` : '')}
      sandbox="allow-scripts"
      srcDoc={doc}
      title={title}
      style={fit && height ? { height } : undefined}
    />
  )
}
