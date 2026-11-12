// A figure's art: the chart, table or drawing a report figure shows under its question, laid out at the figure's width.
// The page draws it in each figure (FigureBlock.tsx), and the card harness draws the same for an export (render.tsx), so
// a downloaded report shows each figure as the page does.
import { useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { CardBody } from '../canvas/bodies'
import { useConceptDetail, useConcepts } from '../canvas/concepts'
import { CanvasContext } from '../canvas/context'
import { chartLabels, isVegaLite, Output, outIndex, pickMime, primaryArtifact } from '../components/Outputs'
import { GlyphCites } from '../components/RefChip'
import type { Cell } from '../lib/types'

const FIGURE_TABLE_ROWS = 20
/** The narrowest a figure's chart is laid out, px. In a narrower column (a narrow window, with the margin beside the
 * text) the chart keeps this width and scrolls in its box, as a wide table does: fitted narrower, its views get too
 * small to read. */
const FIGURE_CHART_MIN = 320

/** The art of `cell` at `width` px: its run's chart or table, or for a card with no run its body as the canvas draws it;
 * nothing for a run that failed. */
export function FigureArt({ ws, cell, width }: { ws: string; cell: Cell; width: number }) {
  const concepts = useConcepts(ws)
  const art = primaryArtifact(cell.outputs)
  const shown = art && art.kind !== 'error' ? art.bundle : null
  if (shown) {
    const wide = width < FIGURE_CHART_MIN && isVegaLite(pickMime(shown) ?? '') ? FIGURE_CHART_MIN : undefined
    return (
      <FigureOutput table={art?.kind === 'table'} wide={wide} out={outIndex(cell.outputs, shown)}>
        <Output bundle={shown} fitWidth={wide ?? width} maxLines={30} maxRows={FIGURE_TABLE_ROWS} labels={chartLabels(cell.labels, concepts)} />
      </FigureOutput>
    )
  }
  return art ? null : <CardFigure ws={ws} cell={cell} width={width} />
}

/** A card without a run to show, drawn by the canvas's own body for its kind (canvas/bodies CardBody), so a note, an
 * example, a label, a timeline or a custom card reads in the report as it does on the board. */
function CardFigure({ ws, cell, width }: { ws: string; cell: Cell; width: number }) {
  const board = useContext(CanvasContext)
  const ctx = useMemo(() => ({ ...board, ws }), [board, ws])
  const payload = (cell.payload ?? {}) as Record<string, unknown>
  const label = useConceptDetail(ws, cell.kind === 'label' && typeof payload.concept === 'string' ? payload.concept : null)
  return (
    <CanvasContext.Provider value={ctx}>
      <GlyphCites.Provider value={true}>
        {/* the wrapper keeps the body from reading as :empty (report.css hides an empty body) while it has nothing yet,
            such as a label whose definition is still loading */}
        <div className="wu-fig-card">
          <CardBody cell={cell} width={width} label={label} />
        </div>
      </GlyphCites.Provider>
    </CanvasContext.Provider>
  )
}

/**
 * The chart, table or drawing of a figure. A table wider than the column, or a chart laid out `wide` (px) in a narrower one,
 * scrolls inside its box, and the box carries `wu-fig-overflow` while it does, so the stylesheet draws a fade at the
 * right edge where it continues.
 */
function FigureOutput({ table, wide, out, children }: { table?: boolean; wide?: number; out: number; children: ReactNode }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    if (!el) return
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    for (const kid of Array.from(el.children)) ro.observe(kid)
    return () => ro.disconnect()
  }, [el, children])
  if (!table && !wide)
    return (
      <div className="wu-fig-chart" data-out={out}>
        {children}
      </div>
    )
  return (
    <div className={`wu-fig-scroll${overflow ? ' wu-fig-overflow' : ''}`} data-out={out}>
      <div className={`wu-fig-chart ${table ? 'wu-fig-table' : 'wu-fig-wide'}`} ref={setEl}>
        {table ? children : <div style={{ width: wide }}>{children}</div>}
      </div>
    </div>
  )
}
