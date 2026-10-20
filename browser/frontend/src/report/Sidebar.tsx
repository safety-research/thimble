// The report's sidebar: the card search and the hide toggle, then the canvas's cards in Starred, Figures and Your work
// (cards.ts), each draggable into the page or placed at its end with a double-click (or Enter), ✓ once the page shows
// it. While the pane holds it beside a column of the report's text it docks, as the analyst left it; in a narrower pane
// it starts folded to a toggle over the page's top left, which opens it over the page's left edge (shell/dock.tsx).
import { useCallback, useMemo, useState, type DragEvent } from 'react'
import { figureKind } from '../components/Outputs'
import { dragCard } from '../lib/cardDrag'
import { track } from '../lib/telemetry'
import type { Cell, Group } from '../lib/types'
import { readStorage, writeStorage } from '../lib/workspace'
import { useDock, useFoldingSide, type FoldingSide } from '../shell/dock'
import { cardSections, sectionsKey, sideKey, type CardSectionKey } from './cards'
import { Chevron, Glyph, IconButton } from './icons'

const DEFAULT_OPEN: Record<CardSectionKey, boolean> = { starred: true, figures: true, yours: true }
/** The width of the sidebar, as .wu-side sets it in report.css. */
const SIDE_WIDTH = 260

export interface DocSidebar extends FoldingSide {
  /** the refs of the row that holds the sidebar and the document, and of the ReadProbe in it */
  row: (el: HTMLElement | null) => void
  probe: (el: HTMLElement | null) => void
}

/** The sidebar's state: docked and as the analyst left it while the pane has room, else folded to its toggle. */
export function useSidebar(ws: string): DocSidebar {
  const [side, setSide] = useState<boolean>(() => readStorage<boolean>(sideKey(ws), true) !== false)
  const { docks, row, probe } = useDock(SIDE_WIDTH)
  const keep = useCallback(
    (next: boolean) => {
      setSide(next)
      writeStorage(sideKey(ws), next)
    },
    [ws],
  )
  const fold = useFoldingSide(docks, side, keep)
  const note = (open: boolean) => track('ui-click', { target: 'ui:report-sidebar', detail: { open, over: !docks } })
  return {
    ...fold,
    show: () => {
      fold.show()
      note(true)
    },
    hide: () => {
      fold.hide()
      note(false)
    },
    row,
    probe,
  }
}

/** The toggle that brings a hidden sidebar back, over the page's top left. */
export function SidebarShow({ onShow }: { onShow: () => void }) {
  return (
    <IconButton label="Show the cards" className="wu-side-show" onClick={onShow}>
      <Glyph name="sidebar" />
    </IconButton>
  )
}

export interface SidebarProps {
  ws: string
  cells: readonly Cell[]
  groups: readonly Group[]
  /** the cells the page shows as figures */
  used: ReadonlySet<string>
  onInsert: (cellId: string) => void
  onHide: () => void
  /** it shows over the page's left edge, the pane being too narrow for it beside the text */
  over: boolean
}

export function Sidebar({ ws, cells, groups, used, onInsert, onHide, over }: SidebarProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ ...DEFAULT_OPEN, ...readStorage<Record<string, boolean>>(sectionsKey(ws), {}) }))
  const sections = useMemo(() => cardSections(cells, groups, query, figureKind), [cells, groups, query])
  const toggle = (key: string) => {
    const next = { ...open, [key]: !open[key] }
    setOpen(next)
    writeStorage(sectionsKey(ws), next)
  }
  const searching = !!query.trim()
  return (
    <aside className={'wu-side' + (over ? ' is-over' : '')} aria-label="Cards">
      <div className="wu-side-cards">
        <div className="wu-side-top">
          <label className="wu-search">
            <Glyph name="search" size={13} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search cards" aria-label="Search cards" spellCheck={false} />
          </label>
          <IconButton label="Hide the cards" onClick={onHide}>
            <Glyph name="sidebar" />
          </IconButton>
        </div>
        <div className="wu-side-list">
          {sections.map((sec) => {
            const shown = searching ? true : open[sec.key] !== false
            return (
              <section key={sec.key} className="wu-sec" data-section={sec.key}>
                <button type="button" className="wu-sec-head" aria-expanded={shown} onClick={() => toggle(sec.key)} disabled={searching}>
                  <Chevron open={shown} />
                  {sec.key === 'starred' && <Glyph name="star" size={12} filled className="wu-star" />}
                  <span className="wu-sec-name">{sec.name}</span>
                  <span className="wu-count">{sec.cards.length}</span>
                </button>
                {shown &&
                  sec.cards.map((k) => (
                    <div
                      key={k.id}
                      className="wu-card-row"
                      draggable
                      tabIndex={0}
                      onDragStart={(e: DragEvent) => dragCard(e, k.id)}
                      onDoubleClick={() => onInsert(k.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onInsert(k.id)
                      }}
                      data-card={k.id}
                      title={used.has(k.id) ? 'In the report' : 'Drag into the report, or double-click to add it at the end'}
                    >
                      <Glyph name={k.shape} size={13} className="wu-card-ico" />
                      <span className="wu-card-q">{k.title}</span>
                      {used.has(k.id) && <span className="wu-card-used">✓</span>}
                    </div>
                  ))}
              </section>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
