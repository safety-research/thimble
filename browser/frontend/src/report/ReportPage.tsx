// The report: the card sidebar (Sidebar.tsx; over the page when the pane is narrow), then the page: the block editor in
// a card-wide column, and at the right the ruler and scrollbar (files/Ruler PageRuler). The page is the analyst's from
// the start: an empty report is a document they type into and place cards in.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageRuler, type Passage } from '../files/Ruler'
import { api, reportApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { Cell, Group, Writeup } from '../lib/types'
import { ReadProbe, useDock } from '../shell/dock'
import { usedCells } from './cards'
import type { Flag } from './decorations'
import { ReportEditor, type DocFilter, type EditorHandle } from './Editor'
import { readableText } from './model'
import { Sidebar, SidebarShow, useSidebar } from './Sidebar'

const CANVAS_DEBOUNCE_MS = 400
/** The tints the editor draws over whole passages, by sentence id: none. */
const NO_FLAGS: ReadonlyMap<string, Flag> = new Map()

export interface ReportPageProps {
  ws: string
  slug: string
  doc: Writeup
  filter: DocFilter | null
  client: string
  onSaved: (doc: Writeup) => void
}

/** The canvas's cards and groups, read again when a card or a group changes. */
export function useCanvas(ws: string): { cells: Cell[]; groups: Group[] } {
  const [state, setState] = useState<{ cells: Cell[]; groups: Group[] }>({ cells: [], groups: [] })
  useEffect(() => {
    let live = true
    let timer: number | null = null
    const read = () =>
      api
        .canvas(ws)
        .then((r) => live && setState({ cells: r.cells, groups: r.groups }))
        .catch(() => {
          /* the sidebar stands empty; the page does not need it */
        })
    const later = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void read(), CANVAS_DEBOUNCE_MS)
    }
    void read()
    const offs = [
      bus.on('cell', later),
      bus.on('wsEvent', (ev) => {
        if (ev.type === 'notebook' || ev.type === 'group' || ev.type === 'canvas') later()
      }),
    ]

    return () => {
      live = false
      if (timer != null) window.clearTimeout(timer)
      for (const off of offs) off()
    }
  }, [ws])
  return state
}

export function ReportPage({ ws, slug, doc, filter, client, onSaved }: ReportPageProps) {
  const side = useSidebar(ws)
  const [figures, setFigures] = useState<string[]>([])
  const { cells, groups } = useCanvas(ws)
  const editor = useRef<EditorHandle | null>(null)
  const column = useRef<HTMLDivElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const used = useMemo(() => usedCells(figures), [figures])
  const byId = useMemo(() => new Map(cells.map((c) => [c.id, c])), [cells])
  const captionOf = useCallback(
    (id: string) => {
      const c = byId.get(id)
      return readableText(c?.takeaway || c?.title || '').trim()
    },
    [byId],
  )

  // the loupe's passages (each block the decorations mark as a cell: a heading, a paragraph, a list item) follow the
  // page as it lays out; the ruler follows the scroll itself
  const [passages, setPassages] = useState<Passage[]>([])
  const measure = useCallback(() => {
    const box = scroller.current
    const col = column.current
    if (!box || !col) return
    const base = box.getBoundingClientRect().top - box.scrollTop
    const blocks: Passage[] = []
    for (const el of Array.from(col.querySelectorAll<HTMLElement>('[data-anchor-cell]'))) {
      const text = el.getAttribute('data-anchor-text') ?? ''
      const r = el.getBoundingClientRect()
      if (text && r.height > 0) blocks.push({ top: r.top - base, bottom: r.bottom - base, text, heading: el.getAttribute('data-content-type') === 'heading' })
    }
    blocks.sort((a, b) => a.top - b.top)
    setPassages(blocks)
  }, [])
  useEffect(() => {
    const id = window.requestAnimationFrame(measure)
    return () => window.cancelAnimationFrame(id)
  }, [measure, doc])
  useEffect(() => {
    const col = column.current
    const box = scroller.current
    if (!col || !box) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(col)
    ro.observe(box)
    return () => ro.disconnect()
  }, [measure])
  const jump = (fraction: number) => {
    const box = scroller.current
    if (!box) return
    box.scrollTo({ top: Math.max(0, fraction * box.scrollHeight - box.clientHeight / 2), behavior: 'smooth' })
    track('ui-click', { target: 'ui:report-ruler', detail: { at: Math.round(fraction * 100) / 100 } })
  }

  return (
    <div className="wu-report" ref={side.row}>
      <ReadProbe probe={side.probe} />
      {side.shown ? (
        <Sidebar ws={ws} cells={cells} groups={groups} used={used} onInsert={(id) => editor.current?.insertCard(id)} onHide={side.hide} over={side.over} />
      ) : (
        <SidebarShow onShow={side.show} />
      )}
      <div className="wu-page" ref={scroller}>
        <div className="wu-page-row">
          <div className="wu-page-col" ref={column}>
            <ReportEditor ref={editor} ws={ws} slug={slug} doc={doc} flags={NO_FLAGS} filter={filter} client={client} onSaved={onSaved} onFigures={setFigures} captionOf={captionOf} />
          </div>
        </div>
      </div>
      <PageRuler scroller={scroller} columns={[]} onJump={jump} onMark={() => undefined} tipOf={(col) => col.name} passages={passages} />
    </div>
  )
}
