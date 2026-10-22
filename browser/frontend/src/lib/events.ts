// One EventSource per workspace on `GET /ws/{c}/events`, fanned out on the bus by record type. A record says what
// changed, never the content, and the server keeps no history to replay (backend hub.py): a page that reconnects reads
// what it shows anew.
import { useEffect } from 'react'
import { api } from './api'
import { bus } from './bus'
import { openStream } from './sse'
import type { WsEvent } from './types'

/** Hand one stream record to the bus. Exported so a test can feed records without a socket. */
export function dispatch(ev: WsEvent): void {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return
  fanOut(ev)
}

function fanOut(ev: WsEvent): void {
  bus.emit('wsEvent', ev)
  const rest = ev as Record<string, unknown>
  switch (ev.type) {
    case 'chat':
      if (typeof rest.chat === 'string') bus.emit('chat', { chat: rest.chat, deleted: rest.deleted === true })
      return
    case 'cell':
      if (typeof rest.cell === 'string') bus.emit('cell', { notebook: String(rest.notebook ?? ''), cell: rest.cell, kind: String(rest.kind ?? 'ran'), slug: typeof rest.slug === 'string' ? rest.slug : undefined })
      return
    case 'report':
      if (typeof rest.slug === 'string') bus.emit('report', { slug: rest.slug, status: String(rest.status ?? ''), span: typeof rest.span === 'string' ? rest.span : undefined })
      return
    case 'view':
      if (typeof rest.slug === 'string')
        bus.emit('view', {
          slug: rest.slug,
          status: String(rest.status ?? ''),
          path: typeof rest.path === 'string' ? rest.path : undefined,
          chat: typeof rest.chat === 'string' ? rest.chat : undefined,
          asked: rest.asked === true || undefined,
          accepted: rest.accepted === true || undefined,
          version: typeof rest.version === 'string' ? rest.version : undefined,
          held: rest.held === true || undefined,
        })
      return
    case 'features':
      // Settings turned a feature on or off (features.ts reads the switches again)
      bus.emit('features', {})
      return
    case 'lenses':
      // a lens's switch or scope changed, or a check of the analyst's own came or went (lib/lensMarks.ts)
      bus.emit('lenses', {})
      return
    case 'lens_marks':
      // a lens's reading made marks (lib/lensMarks.ts)
      bus.emit('lensMarks', {})
      return
    case 'concepts':
      bus.emit('concepts', { concept: String(rest.concept ?? ''), what: String(rest.what ?? ''), rows: rest.rows !== false })
      return
    case 'filter':
      bus.emit('filter',{ scope: rest.scope as 'files' | 'canvas' | 'report', concept: typeof rest.concept === 'string' ? rest.concept : undefined, value: typeof rest.value === 'string' ? rest.value : undefined })
      return
    default:
      return
  }
}

interface Sub {
  release: () => void
  refs: number
}
const subs = new Map<string, Sub>()

/** Subscribe the workspace's stream; one socket however many callers. Returns the release. */
export function subscribeWorkspace(workspace: string): () => void {
  let sub = subs.get(workspace)
  if (!sub) {
    const release = openStream(api.eventsUrl(workspace), {
      onEvent: (event, data) => event === 'message' && dispatch(data as WsEvent),
      onReopen: () => bus.emit('wsStream', { connected: true }),
      onDown: () => bus.emit('wsStream', { connected: false }),
    })
    sub = { release, refs: 0 }
    subs.set(workspace, sub)
  }
  sub.refs++
  let released = false
  return () => {
    if (released) return
    released = true
    const s = subs.get(workspace)
    if (!s) return
    s.refs--
    if (s.refs <= 0) {
      s.release()
      subs.delete(workspace)
    }
  }
}

export function useWorkspaceEvents(workspace: string | null | undefined): void {
  useEffect(() => {
    if (!workspace) return
    return subscribeWorkspace(workspace)
  }, [workspace])
}
