// A card of a card type (backend cardtypes.py): the type's page in a sandboxed frame (files/ViewerFrame with `card`),
// drawn from what the card's code stored. The frame marks the records of the card's labels and of the labels turned on,
// in the analyst's colours, dims what the Files filter drops, and saves a label colour the analyst edits in it; while a
// label it draws runs, its rows are read again every RUN_POLL_MS, since a run sends no event per batch. A citation
// hovered in the card's text lights the record it names in the frame, and a click opens it there: a record ref as it
// is, a line of the card's listing by the record ref that ends the line. The frame is as tall as its page asks within
// the type's range, and fills the card when the analyst sized it. In the card harness (render.tsx) the page draws for
// the check's picture, and the body is settled once the page says so, or after SETTLE_MAX_MS.
import { useContext, useEffect, useMemo, useState } from 'react'
import { asText, CARD_MIME, outIndex } from '../components/Outputs'
import { labelStatus } from '../files/labels'
import { refreshLabels } from '../files/marks'
import { useFilesFilter, useFilesLabels } from '../files/useLabels'
import { ViewerFrame, type CardFrame, type ViewLabelActions } from '../files/ViewerFrame'
import { bus } from '../lib/bus'
import { onCiteClick } from '../lib/citeTargets'
import { parseRef } from '../lib/refs'
import type { Cell, Concept, MimeBundle } from '../lib/types'
import { CanvasContext } from './context'

/** What thimble.card stored (backend kernel_thimble.card). */
interface Made {
  type: string
  args?: Record<string, unknown>
  labels?: { id: string; name: string }[]
  data: unknown
  size: [number, number]
}

const RUN_POLL_MS = 3000
const SETTLE_MAX_MS = 4000
const RECORD_AT_END = /(\S+#L[1-9]\d*)\s*$/

const inHarness = (): boolean => typeof window !== 'undefined' && '__thimbleRender' in window

/** A short digest of a string (FNV-1a), which names what a card stored. */
function digest(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

/** The record a cited ref names for this card: a record ref itself, or the one ending the cited line of the card's
 * listing; null for anything else. */
export function citedRecord(ref: string, cardId: string, out: number, listing: string): string | null {
  const p = parseRef(ref)
  if (!p) return null
  if (p.kind === 'record') return ref
  if (p.kind !== 'cell' || p.cellId !== cardId || p.out !== out || p.line == null) return null
  return RECORD_AT_END.exec(listing.split('\n')[p.line - 1] ?? '')?.[1] ?? null
}

export function TypeCard({ cell, bundle, width, big }: { cell: Cell; bundle: MimeBundle; width: number; big: boolean }) {
  const { ws } = useContext(CanvasContext)
  const files = useFilesLabels(ws)
  const filter = useFilesFilter(ws)
  const made = bundle[CARD_MIME] as Made
  const render = inHarness()
  const listing = asText(bundle['text/plain'])
  const out = outIndex(cell.outputs, bundle)
  const [target, setTarget] = useState<{ ref: string; pick: boolean } | undefined>(undefined)
  const [settled, setSettled] = useState(false)

  const own = useMemo(() => (made.labels ?? []).map((l) => files.byId.get(l.id)).filter((k): k is Concept => !!k), [made.labels, files.byId])
  // the card's own labels first, so a record they mark takes their colour over a label turned on later
  const shown = useMemo(() => (render ? [] : [...own, ...files.on.filter((k) => !own.some((o) => o.id === k.id))]), [render, own, files.on])
  const running = shown.some((k) => labelStatus(k)?.state === 'running')
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(refreshLabels, RUN_POLL_MS)
    return () => window.clearInterval(t)
  }, [running])

  useEffect(
    () =>
      bus.on('citeHover', (e) => {
        if (e.card !== cell.id) return
        const rec = e.ref ? citedRecord(e.ref, cell.id, out, listing) : null
        setTarget(rec ? { ref: rec, pick: false } : undefined)
      }),
    [cell.id, out, listing],
  )
  useEffect(
    () =>
      onCiteClick(cell.id, (ref) => {
        const rec = citedRecord(ref, cell.id, out, listing)
        if (rec) setTarget({ ref: rec, pick: true })
        return !!rec
      }),
    [cell.id, out, listing],
  )
  useEffect(() => {
    if (!render || settled) return
    const t = window.setTimeout(() => setSettled(true), SETTLE_MAX_MS)
    return () => window.clearTimeout(t)
  }, [render, settled])

  const { toggle, setFocus, setColour, byId } = files
  const actions = useMemo<ViewLabelActions>(
    () => ({
      setOn: (id, on) => {
        const k = byId.get(id)
        if (!k || !!k.shown === on) return
        if (on) setFocus(id)
        toggle(id)
      },
      setColour,
    }),
    [byId, toggle, setFocus, setColour],
  )
  const stored = useMemo(() => digest(JSON.stringify([made.data ?? null, made.args ?? {}])), [made])
  const card = useMemo<CardFrame>(
    () => ({ id: cell.id, type: made.type, mode: render ? 'render' : big ? 'full' : 'card', data: made.data, args: made.args ?? {}, width, size: made.size, key: stored }),
    [cell.id, made, render, big, width, stored],
  )
  return (
    <div className="bcell-type" data-body="" data-settled={render ? String(settled) : undefined}>
      <ViewerFrame
        ws={ws}
        slug={made.type}
        card={card}
        title={cell.title}
        fit={cell.height == null || big}
        targetRef={target?.ref}
        targetPick={target?.pick}
        labels={shown}
        filter={render ? null : filter}
        filterFiles={filter ? files.presence.get(filter.concept) : undefined}
        byId={files.byId}
        labelActions={actions}
        onSettled={() => setSettled(true)}
        className="bcell-type-frame"
      />
    </div>
  )
}
