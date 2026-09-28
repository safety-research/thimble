// The workspace's concepts, read once and refreshed on the `concepts` stream event, so label chips can show names and
// which labels changed since a card ran (staleLabels); and one label card's concept in full (useConceptDetail), re-read
// on its events and every second while its apply runs.
import { registerConcepts } from '../lib/cellName'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import type { Cell, Concept, ConceptDetail } from '../lib/types'

type Listener = () => void
const cache = new Map<string, Map<string, Concept>>()
const inflight = new Map<string, Promise<void>>()
// workspaces asked to load again while a read was in flight: that read may have started before the change it was asked
// for, so another follows it
const again = new Set<string>()
const listeners = new Set<Listener>()
const EMPTY: Map<string, Concept> = new Map()

function load(ws: string): Promise<void> {
  let p = inflight.get(ws)
  if (p) {
    again.add(ws)
    return p
  }
  p = api
    .concepts(ws)
    .then((list) => {
      cache.set(ws, new Map(list.map((k) => [k.id, k])))
      registerConcepts(list.map((k) => ({ id: k.id, name: k.name })))
      for (const fn of listeners) fn()
    })
    .catch(() => undefined)
    .finally(() => {
      inflight.delete(ws)
      if (again.delete(ws)) void load(ws)
    })
  inflight.set(ws, p)
  return p
}

/** The concepts by id; empty until the first read lands. */
export function useConcepts(ws: string): Map<string, Concept> {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump((n) => n + 1)
    listeners.add(fn)
    if (!cache.has(ws)) void load(ws)
    const off = bus.on('concepts', () => void load(ws))
    return () => {
      listeners.delete(fn)
      off()
    }
  }, [ws])
  return cache.get(ws) ?? EMPTY
}

export const conceptName = (concepts: Map<string, Concept>, id: string): string => concepts.get(id)?.name || 'label'

/** How often a label card re-reads its concept while an apply runs on it. */
export const RUN_POLL_MS = 1000

export interface ConceptDetailState {
  concept: ConceptDetail | null
  error: string | null
  /** re-read now (after a verdict, an edit or an apply) */
  reload: () => Promise<void>
  /** replace the concept locally (a route that answered the updated concept) */
  set: (k: ConceptDetail) => void
}

/** One concept in full for a label card: null until read, refreshed on its `concepts` events and polled while it runs. */
export function useConceptDetail(ws: string, conceptId: string | null): ConceptDetailState {
  const [concept, setConcept] = useState<ConceptDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const reload = useCallback(async () => {
    if (!conceptId) return
    try {
      const k = await labelApi.detail(ws, conceptId)
      if (alive.current) {
        setConcept(k)
        setError(null)
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message)
    }
  }, [ws, conceptId])
  useEffect(() => {
    alive.current = true
    setConcept(null)
    setError(null)
    if (!conceptId) return
    void reload()
    const off = bus.on('concepts', (e) => e.concept === conceptId && void reload())
    return () => {
      alive.current = false
      off()
    }
  }, [ws, conceptId, reload])
  const running = concept?.run?.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void reload(), RUN_POLL_MS)
    return () => clearInterval(t)
  }, [running, reload])
  return { concept, error, reload, set: setConcept }
}

/**
 * The labels a card shows as tags under its question: the ones it uses (`labels`), each once. A label card whose head
 * already names its label shows none. Pure.
 */
export function labelsShown(cell: { kind?: string; title?: string; labels?: unknown; payload?: unknown }, names: Map<string, { name?: string }>): string[] {
  const list = Array.isArray(cell.labels) ? cell.labels.filter((x): x is string => typeof x === 'string' && !!x) : []
  const ids = [...new Set(list)]
  if (cell.kind !== 'label') return ids
  const own = String(((cell.payload ?? {}) as Record<string, unknown>).concept ?? '')
  const title = (cell.title ?? '').trim().toLowerCase()
  const named = !!own && names.has(own) && !!title && title !== (names.get(own)?.name ?? '').trim().toLowerCase()
  const withOwn = own && !ids.includes(own) ? [own, ...ids] : ids
  // the head names the label unless the card asks a question of its own (bodies.tsx asksQuestion)
  return named ? withOwn : withOwn.filter((id) => id !== own)
}

/**
 * What changed in a label after revision `rev`, in the words its stale tag shows (as backend concepts.changed_since):
 * its kept changes after `rev`, "; "-joined. '' when nothing did. Pure.
 */
export function changedSince(k: Pick<Concept, 'rev' | 'changes'>, rev: number): string {
  if ((k.rev ?? 0) <= rev) return ''
  const entries = (k.changes ?? []).filter((e) => e.rev > rev)
  const parts = entries.length && entries[0].first <= rev + 1 ? [] : ['earlier changes']
  for (const e of entries) {
    if (e.what === 'corrected') {
      const n = e.rev - Math.max(e.first, rev + 1) + 1
      parts.push(`${n} value${n === 1 ? '' : 's'} corrected`)
    } else parts.push(e.text || e.what)
  }
  return parts.join('; ')
}

/**
 * The labels a card read at an older revision than theirs, by id, each with what changed since: the tags that turn red.
 * Only a card whose run kept the revisions it read (`label_revs`) can be stale. Pure.
 */
export function staleLabels(cell: Pick<Cell, 'label_revs'>, concepts: Map<string, Pick<Concept, 'rev' | 'changes'>>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, rev] of Object.entries(cell.label_revs ?? {})) {
    const k = concepts.get(id)
    const text = k && typeof rev === 'number' ? changedSince(k, rev) : ''
    if (text) out.set(id, text)
  }
  return out
}
