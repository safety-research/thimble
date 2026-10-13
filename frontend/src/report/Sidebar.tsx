// The report's sidebar: the card search and the hide toggle, then the canvas's cards in Starred,
// Orientation and Your work (cards.ts), each draggable into the page or placed at its end with a double-click (or
// Enter), ✓ once the page shows it; and the Checks pane (Checks.tsx, the same pane every document type's sidebar has)
// pinned to the bottom.
import { useMemo, useState, type DragEvent } from 'react'
import { figureKind } from '../components/Outputs'
import type { Cell, Group } from '../lib/types'
import { readStorage, writeStorage } from '../lib/workspace'
import { CARD_MIME, cardSections, sectionsKey, type CardSectionKey } from './cards'
import { CommentsPane, type Checks } from './Checks'
import type { DocComment } from './checkComments'
import { Chevron, Glyph, IconButton } from './icons'

const DEFAULT_OPEN: Record<CardSectionKey, boolean> = { starred: true, orientation: true, figures: true, yours: true }

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
  /** the document shown, the workspace's checks, and the document's open comments */
  doc: string
  checks: Checks
  comments: readonly DocComment[]
}

export function Sidebar({ ws, cells, groups, used, onInsert, onHide, over, doc, checks, comments }: SidebarProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ ...DEFAULT_OPEN, ...readStorage<Record<string, boolean>>(sectionsKey(ws), {}) }))
  const sections = useMemo(() => cardSections(cells, groups, query, figureKind), [cells, groups, query])
  const toggle = (key: string) => {
    const next = { ...open, [key]: !open[key] }
    setOpen(next)
    writeStorage(sectionsKey(ws), next)
  }
  const searching = !!query.trim()
  const onDragStart = (id: string) => (e: DragEvent) => {
    e.dataTransfer.setData(CARD_MIME, id)
    e.dataTransfer.effectAllowed = 'copy'
  }
  return (
    <aside className={'wu-side' + (over ? ' is-over' : '')} aria-label="Cards">
      <div className="wu-side-cards">
        <div className="wu-side-top">
          <label className="wu-search">
            <Glyph name="search" size={13} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search cards" aria-label="Search cards" spellCheck={false} />
          </label>
          <IconButton label="Hide sidebar" onClick={onHide}>
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
                      onDragStart={onDragStart(k.id)}
                      onDoubleClick={() => onInsert(k.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onInsert(k.id)
                      }}
                      data-card={k.id}
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
      <CommentsPane ws={ws} doc={doc} checks={checks} comments={comments} />
    </aside>
  )
}
