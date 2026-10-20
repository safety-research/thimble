// The cards a turn made or changed, drawn under its answer in the chat, as the terminal draws a reply's cards under
// it: each card's question, its body as the canvas draws it (canvas/bodies CardBody) and its takeaway with its marks.
// A click on the question opens the card on the canvas. The cards are read from the server once and again when one of
// them changes (the stream's `cell` records), so a card edited in a thread is drawn here as it now is. They are the
// cards feature's (features.ts): none while it is off.
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { CardBody } from '../canvas/bodies'
import { useConceptDetail } from '../canvas/concepts'
import { CanvasContext } from '../canvas/context'
import { GlyphCites } from '../components/RefChip'
import { useFeature } from '../features'
import { apiBase } from '../lib/browserKey'
import { bus } from '../lib/bus'
import { shownMarks, useLenses, useSurfaceMarks } from '../lib/marks'
import { teleport } from '../lib/teleport'
import type { Cell } from '../lib/types'
import { ChatMarkdown } from './markdown'

/** the width a card's body is drawn at before the column is measured */
const CARD_W = 280

function useCell(ws: string, id: string): Cell | null {
  const [cell, setCell] = useState<Cell | null>(null)
  useEffect(() => {
    let alive = true
    const read = () =>
      fetch(`${apiBase()}/ws/${encodeURIComponent(ws)}/cells/${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? (r.json() as Promise<Cell>) : null))
        .then((c) => alive && setCell(c))
        .catch(() => undefined)
    void read()
    const off = bus.on('cell', (e) => e.cell === id && void read())
    return () => {
      alive = false
      off()
    }
  }, [ws, id])
  return cell
}

function AnswerCard({ ws, id }: { ws: string; id: string }) {
  const cell = useCell(ws, id)
  const payload = (cell?.payload ?? {}) as Record<string, unknown>
  const label = useConceptDetail(ws, cell?.kind === 'label' && typeof payload.concept === 'string' ? payload.concept : null)
  const lenses = useLenses(ws)
  const cardMarks = useSurfaceMarks(ws, 'cards')
  const marks = useMemo(() => shownMarks(cardMarks.filter((m) => m.where === id), lenses, 'cards'), [cardMarks, lenses, id])
  // the body is drawn at the column's width, measured as it changes
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(CARD_W)
  useLayoutEffect(() => {
    if (!body) return
    const measure = () => body.clientWidth > 0 && setWidth(body.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(body)
    return () => ro.disconnect()
  }, [body])
  if (!cell) return null
  return (
    <figure className="chat-card" data-anchor={`card:${cell.id}`} data-anchor-text={cell.title} data-cite-home={cell.id}>
      <button type="button" className="chat-card-q" onClick={() => teleport(`card:${cell.id}`)} title="Open it on the canvas">
        {cell.title}
      </button>
      <div className="chat-card-body" ref={setBody}>
        <CardBody cell={cell} width={width} label={label} />
      </div>
      {cell.takeaway && (
        <figcaption className="chat-text chat-card-take">
          <ChatMarkdown text={cell.takeaway} marks={marks} lenses={lenses} />
        </figcaption>
      )}
    </figure>
  )
}

export function AnswerCards({ ws, ids }: { ws: string; ids: readonly string[] }) {
  const on = useFeature('cards')
  const ctx = useMemo(
    () => ({ ws, filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set<string>(), refresh: () => undefined, openThread: () => undefined }),
    [ws],
  )
  if (!on || !ids.length) return null
  return (
    <CanvasContext.Provider value={ctx}>
      <GlyphCites.Provider value={true}>
        <div className="chat-cards">
          {ids.map((id) => (
            <AnswerCard key={id} ws={ws} id={id} />
          ))}
        </div>
      </GlyphCites.Provider>
    </CanvasContext.Provider>
  )
}
