// One EventSource per workspace on `GET /ws/{c}/events`, fanned out on the bus by record type. The first open replays
// the workspace's history, then the server sends `live` (backend investigation._stream); isReplay tells whether the
// record being dispatched is from that history, so one-time effects (a toast, a tab dot) happen only for new records.
// When `/thimble fresh` or `resume` replaces the log, the server sends `reset`, the bus gets `wsReset` and the shell
// reloads the page.
import { useEffect } from 'react'
import { api } from './api'
import { bus } from './bus'
import { openStream } from './sse'
import type { WsEvent } from './types'

let replaying = false

/** Whether the record being dispatched now is from the replayed history rather than new. Read it inside a bus
 * handler, which runs during the dispatch. */
export function isReplay(): boolean {
  return replaying
}

/** Hand one stream record to the bus; `replay` marks a record of the history (isReplay). Exported so a test can feed
 * records without a socket. */
export function dispatch(ev: WsEvent, replay = false): void {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return
  const was = replaying
  replaying = replay
  try {
    fanOut(ev)
  } finally {
    replaying = was
  }
}

function fanOut(ev: WsEvent): void {
  bus.emit('wsEvent', ev)
  const rest = ev as Record<string, unknown>
  switch (ev.type) {
    case 'chat':
      if (typeof rest.chat === 'string') bus.emit('chat', { chat: rest.chat, deleted: rest.deleted === true })
      return
    case 'cell':
      if (typeof rest.cell === 'string') bus.emit('cell', { notebook: String(rest.notebook ?? ''), cell: rest.cell, kind: String(rest.kind ?? 'ran') })
      return
    case 'orient':
      bus.emit('orient', { ...rest, status: String(rest.status ?? '') })
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
        })
      return
    case 'ticket':
      bus.emit('ticket', { id: String(rest.id ?? ''), n: Number(rest.n ?? 0), status: String(rest.status ?? '') })
      return
    case 'concepts':
      bus.emit('concepts', { concept: String(rest.concept ?? ''), what: String(rest.what ?? '') })
      return
    case 'check':
      if (typeof rest.id === 'string')
        bus.emit('check', { id: rest.id, doc: String(rest.doc ?? ''), status: String(rest.status ?? ''), run: typeof rest.run === 'string' ? rest.run : undefined, chat: typeof rest.chat === 'string' ? rest.chat : undefined })
      return
    case 'card-request':
      if (typeof rest.request === 'string' && typeof rest.card === 'string') bus.emit('cardRequest', { request: rest.request, card: rest.card })
      return
    case 'layout': {
      const presets = ['one', 'columns', 'rows', 'three', 'quadrants'] as const
      const name = presets.find((x) => x === rest.layout)
      if (name) bus.emit('layout', { layout: name, surfaces: Array.isArray(rest.surfaces) ? rest.surfaces.filter((x): x is string => typeof x === 'string') : [] })
      return
    }
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
    // the history lasts until the first `live` event; a reopen after a failure asks from the last record seen, so what
    // it replays happened while the page was open
    let history = true
    let log: string | null = null
    const release = openStream(api.eventsUrl(workspace), {
      events: ['live', 'reset'],
      urlFor: (last) => api.eventsUrl(workspace, last, log),
      onEvent: (event, data) => {
        if (event === 'live') {
          history = false
          const named = (data as { log?: unknown } | null)?.log
          if (typeof named === 'string' && named) log = named
        } else if (event === 'reset') {
          history = true
          bus.emit('wsReset', { workspace })
        } else dispatch(data as WsEvent, history)
      },
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
