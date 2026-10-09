// The board's controls. At the top right, the bar that adds to the board (Card · Group, and Group ⌘G for a multiple
// selection) and Comments, which lists the checks that comment on the cards with their switches and counts, as the
// Report's Comments pane does (report/Checks.tsx CheckRows), and + for a new one. At the bottom right: the search menu (the card filter, cardFilter.ts), the zoom and Fit, and the minimap,
// where a press or drag moves the view. While a filter is set the minimap draws the kept cards in ink, the rest faint.
import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Kbd } from '../components/Marks'
import { Popover } from '../components/Menu'
import { TipButton, useTooltip } from '../components/Tooltip'
import { choices, filterOn, toggled, activeParts, type CardFilter, type FilterCard } from './cardFilter'
import { CardCheckPart } from './CheckStatus'
import { CHECK_STATES, CHECK_WORDS } from '../lib/cardCheck'
import { MINIMAP, zoomLabel, type Board, type Layout, type Minimap, type View } from './layout'
import { shortcutLabel } from '../lib/platform'
import type { CanvasComment } from '../lib/types'
import { CheckRows, type Checks } from '../report/Checks'
import { CANVAS, checksFor } from '../report/checkComments'
import { IconButton } from '../report/icons'

/** A label the canvas can be filtered by (its unit is the card), with its values and how many cards each marks. */
export interface CanvasLabel {
  concept: string
  name: string
  values: { value: string; count: number }[]
}

export interface ControlsProps {
  board: Board
  lay: Layout
  view: View
  map: Minimap
  selected: ReadonlySet<string>
  onCell: () => void
  onGroup: () => void
  /** the cards selected, when more than one */
  several: number
  onGroupSelection: () => void
  onZoom: (dir: 1 | -1) => void
  onFit: () => void
  onMinimap: (e: MouseEvent<HTMLDivElement>) => void
  /** the card filter and what it can choose from; onClear clears it and the label filter together */
  filter: CardFilter
  onFilter: (f: CardFilter) => void
  onClear: () => void
  cards: readonly FilterCard[]
  groupName: (id: string) => string
  /** the canvas's labels, the label filter set (the server's canvas filter), and a change to it (null clears it) */
  labels: readonly CanvasLabel[]
  label: { concept: string; value: string } | null
  onLabel: (concept: string, value: string | null) => void
  /** the cards the filters keep together; null when none is set */
  keep: ReadonlySet<string> | null
  /** the server's filter has been read: until then the menu stays shut, so a choice made on an empty filter never
   * overwrites the one kept */
  filterReady: boolean
  ws: string
  /** the workspace's checks, and the open comments on the cards, whether their check is on or off */
  checks: Checks
  comments: readonly CanvasComment[]
}

export function Controls(p: ControlsProps) {
  const set = activeParts(p.filter).length + (p.label ? 1 : 0)
  // a press or a wheel on the controls stays off the board, which would start a marquee or pan under them
  const hold = { onMouseDown: (e: MouseEvent) => e.stopPropagation(), onWheel: (e: WheelEvent<HTMLDivElement>) => e.stopPropagation() }
  return (
    <>
      <div className="bctl bctl-top" {...hold}>
        <div className="bctl-bar bctl-add">
          <button type="button" className="bctl-btn" onClick={p.onCell}>
            <Icon name="cell-add" size={14} />
            Card
          </button>
          <button type="button" className="bctl-btn" onClick={p.onGroup}>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" className="icon">
              <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" strokeDasharray="3 2.5" />
              <path d="M12 9v6M9 12h6" />
            </svg>
            Group
          </button>
          <CommentsButton ws={p.ws} checks={p.checks} comments={p.comments} />
          {p.several > 1 && (
            <>
              <span className="bctl-sep" />
              <span className="bctl-count">{p.several} selected</span>
              <Button variant="primary" size="md" className="bctl-group" onClick={p.onGroupSelection}>
                Group <Kbd>{shortcutLabel('G')}</Kbd>
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="bctl" {...hold}>
        <div className="bctl-nav">
          <div className="bctl-bar bctl-zoom" role="group" aria-label="Search and zoom">
            <FilterButton {...p} set={set} />
            <span className="bctl-sep" />
            <TipButton tip="Zoom out" className="bctl-btn bctl-sq" onClick={() => p.onZoom(-1)}>
              −
            </TipButton>
            <span className="bctl-pct">{zoomLabel(p.view.scale)}</span>
            <TipButton tip="Zoom in" className="bctl-btn bctl-sq" onClick={() => p.onZoom(1)}>
              +
            </TipButton>
            <span className="bctl-sep" />
            <button type="button" className="bctl-btn bctl-fit" onClick={p.onFit}>
              Fit
            </button>
          </div>
          <div className="bctl-map" style={{ width: MINIMAP.w, height: MINIMAP.h }} onMouseDown={p.onMinimap} aria-label="Minimap" role="img">
            {p.board.groups.map((g) => {
              const r = p.lay.rects.get(g.id)
              return r ? <span key={g.id} className="bctl-map-frame" style={{ left: p.map.x(r.x), top: p.map.y(r.y), width: r.w * p.map.k, height: r.h * p.map.k }} /> : null
            })}
            {p.board.cells.map((c) => {
              const r = p.lay.rects.get(c.id)
              const cls = ['bctl-map-card', p.selected.has(c.id) ? 'is-selected' : '', p.keep ? (p.keep.has(c.id) ? 'is-kept' : 'is-left') : ''].filter(Boolean).join(' ')
              return r ? <span key={c.id} className={cls} style={{ left: p.map.x(r.x), top: p.map.y(r.y), width: Math.max(1.5, r.w * p.map.k), height: Math.max(1.5, r.h * p.map.k) }} /> : null
            })}
            <span className="bctl-map-view" style={{ left: p.map.view.x, top: p.map.view.y, width: p.map.view.w, height: p.map.view.h }} />
          </div>
        </div>
      </div>
    </>
  )
}

/** Comments in the top bar: the count of the comments shown on the cards, and a menu of the checks that comment on
 * them, each with its switch, its count and its card (CheckRows), with + for a new check over the cards. */
function CommentsButton({ ws, checks, comments }: { ws: string; checks: Checks; comments: readonly CanvasComment[] }) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState<HTMLElement | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const mine = new Set(checksFor(checks.list, CANVAS).map((c) => c.id))
  const shown = comments.filter((c) => c.check == null || (checks.on.has(c.check) && mine.has(c.check))).length
  const close = () => {
    setOpen(false)
    setAdding(null)
  }
  return (
    <>
      <button ref={btn} type="button" className={`bctl-btn bctl-comments${open ? ' is-open' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="comment" size={14} />
        Comments
        {shown > 0 && <span className="bctl-comments-count">{shown}</span>}
      </button>
      <Popover anchor={btn} open={open} onClose={close} align="end" width={280} label="Comments" className="bcomments">
        <div className="wu-checks bcomments-pane">
          <div className="wu-checks-head bcomments-head" ref={head}>
            <span className="wu-sec-name">Comments</span>
            <IconButton label="New check" className="wu-checks-add" aria-expanded={!!adding} onClick={() => setAdding((a) => (a ? null : head.current))}>
              <Icon name="plus" size={14} />
            </IconButton>
          </div>
          <CheckRows ws={ws} surface={CANVAS} checks={checks} comments={comments} adding={adding} onAdding={setAdding} />
        </div>
      </Popover>
    </>
  )
}

/**
 * The search button and its menu: a search field over the cards' questions and takeaways, then a heading per filter
 * part, each choice a row with its count and a check while set. The menu stays open between clicks.
 */
function FilterButton(p: ControlsProps & { set: number }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  // the menu is placed before it shows, so the search takes the keyboard on the frame after it opens
  useEffect(() => {
    if (!open) return
    const id = window.requestAnimationFrame(() => search.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [open])
  const f = p.filter
  const row = (key: string, label: string, on: boolean, count: number | null, act: () => void, mono = false) => (
    <button key={key} type="button" role="menuitemcheckbox" aria-checked={on} className={`menu-item${on ? ' checked' : ''}`} onClick={act}>
      <span className={`menu-item-label${mono ? ' bfilter-mono' : ''}`}>{label}</span>
      {count != null && <span className="menu-item-note">{count.toLocaleString()}</span>}
      <Icon name="check" size={14} className={`menu-check bfilter-check${on ? '' : ' is-off'}`} />
    </button>
  )
  const part = (heading: string, which: 'kinds' | 'groups' | 'makers', name: (v: string) => string, mono = false) => {
    const list = choices(p.cards, which)
    if (!list.length) return null
    return (
      <div className="bfilter-part" key={which}>
        <div className="menu-heading" role="presentation">
          {heading}
        </div>
        {list.map((c) => row(`${which}:${c.value}`, name(c.value), f[which].includes(c.value), c.count, () => p.onFilter({ ...f, [which]: toggled(f[which], c.value) }), mono))}
      </div>
    )
  }
  const starred = p.cards.filter((c) => c.starred).length
  const locked = p.cards.filter((c) => c.locked).length
  // what the card check found, in the states' own order, each that a card has or the filter holds
  const checkCounts = new Map(choices(p.cards, 'checks').map((c) => [c.value, c.count]))
  const checks = CHECK_STATES.filter((s) => checkCounts.has(s) || f.checks.includes(s))
  const name = p.set ? `Search and filter the cards (${p.set} set)` : 'Search and filter the cards'
  const { props: tipProps, tip } = useTooltip(open ? null : name)
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`bctl-btn bctl-sq bctl-filter${p.set ? ' is-on' : ''}`}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!p.filterReady}
        onClick={() => setOpen((v) => !v)}
        {...tipProps}
      >
        <Icon name="search" size={14} />
        {p.set > 0 && <span className="bctl-filter-count">{p.set}</span>}
      </button>
      {tip}
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} align="end" width={260} role="menu" label="Filter the cards" className="bfilter">
        <div className="menu">
          <label className="bfilter-search">
            <Icon name="search" size={13} />
            <input
              ref={search}
              value={f.text}
              onChange={(e) => p.onFilter({ ...f, text: e.target.value })}
              placeholder="Search cards"
              aria-label="Search the cards' questions and takeaways"
              spellCheck={false}
            />
          </label>
          {part('Kind', 'kinds', (v) => v, true)}
          {part('Group', 'groups', p.groupName)}
          {part('Made by', 'makers', (v) => v, true)}
          <CardCheckPart
            cards={p.board.cells}
            open={open}
            rows={checks.length ? checks.map((s) => row(`checks:${s}`, CHECK_WORDS[s], f.checks.includes(s), checkCounts.get(s) ?? 0, () => p.onFilter({ ...f, checks: toggled(f.checks, s) }))) : null}
          />
          {p.labels.some((l) => l.values.length) && (
            <div className="bfilter-part">
              <div className="menu-heading" role="presentation">
                Label
              </div>
              {p.labels.flatMap((l) =>
                l.values.map((v) => {
                  const on = p.label?.concept === l.concept && p.label.value === v.value
                  return row(`label:${l.concept}:${v.value}`, `${l.name} · ${v.value}`, on, v.count, () => p.onLabel(l.concept, on ? null : v.value))
                }),
              )}
            </div>
          )}
          <div className="bfilter-part">
            <div className="menu-heading" role="presentation">
              Marked
            </div>
            {row('starred', 'Starred', f.starred, starred, () => p.onFilter({ ...f, starred: !f.starred }))}
            {row('locked', 'Locked', f.locked, locked, () => p.onFilter({ ...f, locked: !f.locked }))}
          </div>
          {(filterOn(f) || p.label) && (
            <>
              <div className="menu-sep" role="separator" />
              <button type="button" role="menuitem" className="menu-item" onClick={p.onClear}>
                <span className="menu-item-label">Clear filters</span>
              </button>
            </>
          )}
        </div>
      </Popover>
    </>
  )
}
