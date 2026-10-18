// CanvasPane.tsx: 0.9's canvas on lean's objects: the dotted board, a frame per question the person asked holding the
// cards its turn saved, each card drawn by lean's SVG renderer (the same program the terminal draws), laid out by 0.9's
// own board math (canvas/layout.ts). A click selects a card ("1 open detail"), a double click or 1 opens its detail;
// the wheel pans, ⌘/ctrl and the wheel zoom, a drag on the board pans; − + Fit and the minimap as in 0.9, except that
// Fit stops at a zoom where a card's words still read (fit.ts) and the person pans to the rest.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Icon } from '@09/components/Icon'
import { Spinner } from '@09/components/Spinner'
import { CARD_W, boardOf, cardCount, centerOn, extentOf, fitView, layoutBoard, MINIMAP, minimapOf, stepZoom, toPlane, wheelView, zoomLabel, zoomTo, type View } from '@09/canvas/layout'
import { CardFace } from './CardFace'
import { readableFit } from './fit'
import { cardGroups, setState, useStore, type CardGroup } from '../lib/store'

const OPEN = { has: () => true }

/** 0.9's canvas route answer, made from lean's groups: a group per frame, a cell per card. */
function canvasData(groups: CardGroup[]) {
  return {
    groups: groups.map((g, i) => ({ id: g.id, title: g.title, parent: null, kind: 'group', anchor: null, chat: null, role: 'analysis', pos: null, order: i })),
    cells: groups.flatMap((g) => g.cards.map((c) => ({ id: c.id, notebook: g.id, kind: 'plot', title: c.id }))),
  }
}

export function CanvasPane() {
  const rows = useStore((s) => s.rows)
  const objects = useStore((s) => s.objects)
  const selected = useStore((s) => s.selected)
  const loaded = useStore((s) => s.loaded)
  const groups = useMemo(() => cardGroups(rows, objects), [rows, objects])
  const board = useMemo(() => boardOf(canvasData(groups) as never), [groups])
  const [heights, setHeights] = useState<Record<string, number>>({})
  const lay = useMemo(() => layoutBoard(board, OPEN, heights), [board, heights])
  const content = useMemo(() => extentOf([...lay.rects.values()]), [lay])
  const vp = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [view, setView] = useState<View>({ x: 40, y: 40, scale: 0.6 })
  const fitted = useRef<string>('')
  const moved = useRef(false)

  useLayoutEffect(() => {
    const el = vp.current
    if (!el) return
    const fit = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loaded])

  // fit the board as its cards are drawn and measured, and again when a card comes, unless the person moved the view
  const cardsSig = String(board.cells.length)
  const sizeSig = content ? `${Math.round(content.w / 40)}x${Math.round(content.h / 40)}` : ''
  const lastCards = useRef('')
  useEffect(() => {
    if (!content) return
    if (lastCards.current !== cardsSig) {
      lastCards.current = cardsSig
      moved.current = false
    }
    if (moved.current || fitted.current === `${cardsSig}|${sizeSig}|${size.w}x${size.h}`) return
    fitted.current = `${cardsSig}|${sizeSig}|${size.w}x${size.h}`
    setView(readableFit(fitView(content, size.w, size.h, 48, 200), content, size.w, size.h, 48, 200))
  }, [cardsSig, sizeSig, size.w, size.h])

  // a card picked elsewhere (a chip in the chat): into view, once
  const reveal = useStore((s) => s.reveal)
  useEffect(() => {
    if (!reveal) return
    const r = lay.rects.get(reveal)
    if (!r) return
    setView((v) => {
      const s = Math.max(v.scale, 0.5)
      return centerOn({ ...v, scale: s }, r.x + r.w / 2, r.y + Math.min(r.h, size.h / s) / 2, size.w, size.h)
    })
    moved.current = true
    setState({ reveal: null })
  }, [reveal, lay.rects.has(reveal || '')])

  const onHeight = useCallback((id: string, h: number) => setHeights((x) => (Math.abs((x[id] ?? -1) - h) < 1 ? x : { ...x, [id]: h })), [])

  // the wheel pans, ⌘/ctrl zooms (a native listener: React's wheel is passive)
  useEffect(() => {
    const el = vp.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const b = el.getBoundingClientRect()
      moved.current = true
      setView((v) => wheelView(v, e, e.clientX - b.left, e.clientY - b.top))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [loaded])

  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-cellbox], .bctl')) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
    const move = (ev: MouseEvent) => {
      const d = drag.current
      if (!d) return
      if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 3) d.moved = true
      moved.current = true
      setView((v) => ({ ...v, x: d.vx + ev.clientX - d.x, y: d.vy + ev.clientY - d.y }))
    }
    const up = () => {
      if (drag.current && !drag.current.moved) setState({ selected: null })
      drag.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const zoom = (dir: 1 | -1) => {
    moved.current = true
    setView((v) => zoomTo(v, stepZoom(v.scale, dir), size.w / 2, size.h / 2))
  }
  const fit = () => {
    moved.current = false
    setView(readableFit(fitView(content, size.w, size.h, 48, 200), content, size.w, size.h, 48, 200))
  }
  const map = minimapOf(content, view, size.w, size.h)
  const onMinimap = (e: React.MouseEvent) => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const p = map.toPlane(e.clientX - b.left, e.clientY - b.top)
    moved.current = true
    setView((v) => centerOn(v, p.x, p.y, size.w, size.h))
  }

  const dot = 24 * Math.max(view.scale, 0.2)
  const gridStyle: CSSProperties = { backgroundSize: `${dot}px ${dot}px`, backgroundPosition: `${view.x}px ${view.y}px` }
  const planeStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }
  const cards = board.cells.length
  return (
    <div className="board" data-panel="canvas">
      <div className="board-stage">
        {!loaded && (
          <div className="board-state">
            <Spinner size={14} label="Loading the canvas" />
          </div>
        )}
        {loaded && (
          <div className="board-viewport" ref={vp} style={gridStyle} onMouseDown={onDown}>
            <div className="board-plane" style={planeStyle}>
              {board.groups.map((g) => {
                const r = lay.rects.get(g.id)
                if (!r) return null
                return (
                  <div key={g.id} className="frame" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} data-group={g.id}>
                    <div className="frame-title">
                      <Icon name="chevron-right" size={10} className="frame-chev is-open" />
                      <span className="frame-name">{g.name}</span>
                      <span className="frame-count">{cardCount(board, g.id)}</span>
                    </div>
                  </div>
                )
              })}
              {board.cells.map((c) => {
                const r = lay.rects.get(c.id)
                if (!r) return null
                const g = groups.find((x) => x.id === c.parent)
                const row = g?.cards.find((x) => x.id === c.id)?.row ?? null
                return <BoardCard key={c.id} id={c.id} row={row} x={r.x} y={r.y} w={c.w} selected={selected === c.id} onHeight={onHeight} />
              })}
            </div>
            {!cards && (
              <div className="board-state lean-board-empty">
                <p>No cards yet. When Claude saves a card in the terminal session, it shows here in a group named by your question.</p>
              </div>
            )}
          </div>
        )}
        {loaded && cards > 0 && (
          <div className="bctl">
            <div className="bctl-nav">
              <div className="bctl-bar bctl-zoom" role="group" aria-label="Zoom">
                <button type="button" className="bctl-btn bctl-sq" title="Zoom out" onClick={() => zoom(-1)}>
                  −
                </button>
                <span className="bctl-pct">{zoomLabel(view.scale)}</span>
                <button type="button" className="bctl-btn bctl-sq" title="Zoom in" onClick={() => zoom(1)}>
                  +
                </button>
                <span className="bctl-sep" />
                <button type="button" className="bctl-btn bctl-fit" onClick={fit}>
                  Fit
                </button>
              </div>
              <div className="bctl-map" style={{ width: MINIMAP.w, height: MINIMAP.h }} onMouseDown={onMinimap} aria-label="Minimap" role="img">
                {board.groups.map((g) => {
                  const r = lay.rects.get(g.id)
                  return r ? <span key={g.id} className="bctl-map-frame" style={{ left: map.x(r.x), top: map.y(r.y), width: r.w * map.k, height: r.h * map.k }} /> : null
                })}
                {board.cells.map((c) => {
                  const r = lay.rects.get(c.id)
                  return r ? <span key={c.id} className={`bctl-map-card${selected === c.id ? ' is-selected' : ''}`} style={{ left: map.x(r.x), top: map.y(r.y), width: Math.max(1.5, r.w * map.k), height: Math.max(1.5, r.h * map.k) }} /> : null
                })}
                <span className="bctl-map-view" style={{ left: map.view.x, top: map.view.y, width: map.view.w, height: map.view.h }} />
              </div>
            </div>
          </div>
        )}
        <div className="board-status">{[`${cards} ${cards === 1 ? 'card' : 'cards'}`, `${board.groups.length} ${board.groups.length === 1 ? 'group' : 'groups'}`, selected && board.cellById.has(selected) ? '1 selected' : ''].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  )
}

const BoardCard = memo(function BoardCard({ id, row, x, y, w, selected, onHeight }: { id: string; row: string | null; x: number; y: number; w: number; selected: boolean; onHeight: (id: string, h: number) => void }) {
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    const ro = new ResizeObserver(() => onHeight(id, node.offsetHeight))
    ro.observe(node)
    onHeight(id, node.offsetHeight)
    return () => ro.disconnect()
  }, [id, onHeight])
  return (
    <div
      ref={el}
      className={`bcell bcell-kind-plot${selected ? ' is-selected' : ''}`}
      style={{ left: x, top: y, width: w, zIndex: selected ? 5 : 2 }}
      data-cellbox=""
      data-card={id}
      onMouseDown={(e) => {
        e.stopPropagation()
        if (e.button === 0) setState({ selected: id })
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setState({ card: { id, v: null, region: null }, selected: id })
      }}
    >
      <CardFace id={id} row={row} width={w - 28} selected={selected} />
    </div>
  )
})

export { CARD_W }
