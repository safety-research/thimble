// The main area right of the chat: its panes (shell/panes.ts), each a card 12px from the next, with the gap between
// two panes as the divider that resizes them. With more than one pane, each has a head: the surface's name (a menu of
// Files, Canvas and Report, and the drag handle) and ×; Files' head also holds its views (lib/surfaces
// setFilesViewsSlot). Files, Canvas and Report stay mounted so each keeps its state. An empty pane offers the surfaces no
// pane shows. While a surface is dragged, the part of the pane it would take is tinted.
import { useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../components/Button'
import { Icon, type IconName } from '../components/Icon'
import { Menu } from '../components/Menu'
import { setFilesViewsSlot } from '../lib/surfaces'
import { drop, isView, previewOf, ratioAt, zoneAt, type Divider, type PaneRect, type Panes, type Rect, type SurfaceId, type Zone } from './panes'

export interface SurfaceSpec {
  id: SurfaceId
  label: string
  icon: IconName
  /** the `data-panel` the surface's pane carries */
  panel: string
  /** mounted while no pane shows it (Files, Canvas, Report), so it keeps its state */
  keep: boolean
  /** the surface's component, told whether a pane shows it and whether that pane has the focus */
  render: (visible: boolean, focused: boolean) => ReactNode
}

export interface Geometry {
  panes: PaneRect[]
  dividers: Divider[]
}

export interface SurfaceDrag {
  surface: SurfaceId
  label: string
  x: number
  y: number
  /** the pane and the part of it a release here drops on, with the rectangle it would take, in the area's px */
  target: { pane: string; zone: Zone; rect: Rect } | null
}

const box = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h })

interface Props {
  panes: Panes
  geometry: Geometry
  /** more than one pane is drawn: panes have heads and dividers */
  multi: boolean
  surfaces: readonly SurfaceSpec[]
  area: (el: HTMLDivElement | null) => void
  drag: SurfaceDrag | null
  onDragStart: (e: ReactPointerEvent, surface: SurfaceId) => void
  onFocus: (pane: string) => void
  onPlace: (pane: string, surface: SurfaceId) => void
  onClose: (pane: string) => void
  onResize: (path: string, ratio: number, done: boolean) => void
}

export function PaneArea({ panes, geometry, multi, surfaces, area, drag, onDragStart, onFocus, onPlace, onClose, onResize }: Props) {
  const rectOf = new Map(geometry.panes.filter((p) => p.surface != null).map((p) => [p.surface as string, p]))
  const known = new Set(surfaces.map((s) => s.id))
  const unshown = surfaces.filter((s) => !rectOf.has(s.id))
  const head = (pane: PaneRect, s: SurfaceSpec | null) =>
    multi && (
      <PaneHead
        pane={pane.id}
        surface={s}
        focus={pane.id === panes.focus}
        surfaces={surfaces}
        onDragStart={onDragStart}
        onPlace={onPlace}
        onClose={onClose}
      />
    )
  return (
    <div className="shell-panes" ref={area} data-multi={multi || undefined}>
      {surfaces.map((s) => {
        const r = rectOf.get(s.id)
        if (!r && !s.keep) return null
        const focus = !!r && r.id === panes.focus
        return (
          <section
            key={s.id}
            className={'shell-panel' + (multi && focus ? ' is-focus' : '')}
            role="tabpanel"
            aria-label={s.label}
            data-panel={s.panel}
            data-surface={s.id}
            data-pane={r?.id}
            hidden={!r}
            style={r ? box(r) : undefined}
            onPointerDownCapture={r ? () => onFocus(r.id) : undefined}
          >
            {r && head(r, s)}
            <div className="shell-panel-body">{s.render(!!r, focus)}</div>
          </section>
        )
      })}
      {geometry.panes
        .filter((p) => p.surface == null || !known.has(p.surface))
        .map((p) => (
          <section key={`empty:${p.id}`} className={'shell-panel is-empty' + (multi && p.id === panes.focus ? ' is-focus' : '')} data-pane={p.id} style={box(p)} onPointerDownCapture={() => onFocus(p.id)}>
            {head(p, null)}
            <div className="pane-pick" role="group" aria-label="Show in this pane">
              {unshown.length ? (
                unshown.map((s) => (
                  <button key={s.id} type="button" className="view-tab pane-pick-opt" data-surface={s.id} onClick={() => onPlace(p.id, s.id)}>
                    <Icon name={s.icon} size={12} className="view-tab-ico" />
                    <span className="view-tab-name">{s.label}</span>
                  </button>
                ))
              ) : (
                <span className="pane-pick-none">Every surface shows in another pane</span>
              )}
            </div>
          </section>
        ))}
      {multi && geometry.dividers.map((d) => <PaneDivider key={d.path} d={d} onResize={onResize} />)}
      {drag?.target && <div className="pane-drop" style={box(drag.target.rect)} aria-hidden="true" />}
    </div>
  )
}

interface HeadProps {
  pane: string
  surface: SurfaceSpec | null
  focus: boolean
  surfaces: readonly SurfaceSpec[]
  onDragStart: (e: ReactPointerEvent, surface: SurfaceId) => void
  onPlace: (pane: string, surface: SurfaceId) => void
  onClose: (pane: string) => void
}

function PaneHead({ pane, surface, focus, surfaces, onDragStart, onPlace, onClose }: HeadProps) {
  return (
    <div
      className={'pane-head' + (focus ? ' is-focus' : '')}
      onPointerDown={(e) => {
        if (surface && !(e.target as Element).closest('.pane-close, .pane-head-views > *')) onDragStart(e, surface.id)
      }}
    >
      {surface && (
        <Menu
          label="Show in this pane"
          className="pane-name-menu"
          items={surfaces.filter((s) => !isView(s.id)).map((s) => ({ id: s.id, label: s.label, icon: s.icon, checked: s.id === surface.id, onSelect: () => onPlace(pane, s.id) }))}
          trigger={
            <button type="button" className="pane-name">
              <Icon name={surface.icon} size={12} className="pane-name-ico" />
              <span className="pane-name-text">{surface.label}</span>
              <Icon name="chevron-down" size={12} className="pane-name-caret" />
            </button>
          }
        />
      )}
      {surface?.id === 'files' ? <span ref={setFilesViewsSlot} className="pane-head-views" /> : <span className="pane-head-spacer" />}
      <Button variant="icon" size="sm" icon="x" title="Close pane" className="pane-close" onClick={() => onClose(pane)} />
    </div>
  )
}

/** The 12px between two panes: dragged, it moves the split between them; a double click evens it. */
function PaneDivider({ d, onResize }: { d: Divider; onResize: (path: string, ratio: number, done: boolean) => void }) {
  const [active, setActive] = useState(false)
  const origin = useRef<{ left: number; top: number } | null>(null)
  const last = useRef(0)
  const at = (e: ReactPointerEvent) => (d.dir === 'row' ? e.clientX - origin.current!.left : e.clientY - origin.current!.top)
  const cls = d.dir === 'row' ? 'shell-resizing' : 'shell-resizing-row'
  const finish = () => {
    if (!origin.current) return
    origin.current = null
    setActive(false)
    document.body.classList.remove(cls)
    onResize(d.path, last.current, true)
  }
  return (
    <div
      className={'pane-divider' + (d.dir === 'row' ? ' is-row' : ' is-col') + (active ? ' active' : '')}
      role="separator"
      aria-orientation={d.dir === 'row' ? 'vertical' : 'horizontal'}
      data-path={d.path}
      style={box(d)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
        origin.current = { left: r.left, top: r.top }
        last.current = ratioAt(d, at(e))
        setActive(true)
        document.body.classList.add(cls)
      }}
      onPointerMove={(e) => {
        if (!origin.current) return
        last.current = ratioAt(d, at(e))
        onResize(d.path, last.current, false)
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => onResize(d.path, 0.5, true)}
    />
  )
}

/** Dragging a surface onto a pane: `start` goes on a tab's or pane head's pointerdown. The drag begins after 5px so a
 * click stays a click; a release over a pane's part calls `onDrop`, Escape or a release elsewhere drops nothing.
 * `area` is the panes' box, and `geometry` its panes in the box's px. */
export function usePaneDrag(opts: { area: HTMLElement | null; geometry: Geometry; panes: Panes; enabled: boolean; labelOf: (s: SurfaceId) => string; onDrop: (pane: string, zone: Zone, surface: SurfaceId) => void }) {
  const [drag, setDrag] = useState<SurfaceDrag | null>(null)
  const live = useRef(opts)
  live.current = opts
  const start = useCallback((e: ReactPointerEvent, surface: SurfaceId) => {
    // a press with ⌘ or Ctrl is the pointing gesture (pointer/CmdPointer), not a drag
    if (e.button !== 0 || e.metaKey || e.ctrlKey) return
    const x0 = e.clientX
    const y0 = e.clientY
    let on = false
    const targetAt = (x: number, y: number): SurfaceDrag['target'] => {
      const { area, geometry, panes, enabled } = live.current
      if (!area || !enabled) return null
      const b = area.getBoundingClientRect()
      const px = x - b.left
      const py = y - b.top
      const r = geometry.panes.find((p) => px >= p.x && px < p.x + p.w && py >= p.y && py < p.y + p.h)
      if (!r) return null
      const zone = zoneAt(r, px, py)
      return drop(panes, r.id, zone, surface) ? { pane: r.id, zone, rect: previewOf(r, zone) } : null
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      document.body.classList.remove('shell-dragging')
      setDrag(null)
    }
    const move = (ev: PointerEvent) => {
      if (!on) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return
        on = true
        document.body.classList.add('shell-dragging')
      }
      setDrag({ surface, label: live.current.labelOf(surface), x: ev.clientX, y: ev.clientY, target: targetAt(ev.clientX, ev.clientY) })
    }
    const up = (ev: PointerEvent) => {
      const was = on
      const t = was ? targetAt(ev.clientX, ev.clientY) : null
      end()
      if (!was) return
      if (t) live.current.onDrop(t.pane, t.zone, surface)
      // the click the release makes belongs to the drag, not to what lies under the pointer
      const swallow = (c: MouseEvent) => {
        c.stopPropagation()
        c.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    }
    const cancel = () => end()
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !on) return
      ev.stopPropagation()
      end()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }, [])
  return { drag, start }
}

/** The dragged surface's name beside the pointer, on its left near the window's right edge. */
export function DragGhost({ drag }: { drag: SurfaceDrag }) {
  const left = drag.x + 12 + GHOST_ROOM > window.innerWidth ? { right: window.innerWidth - drag.x + 12 } : { left: drag.x + 12 }
  return createPortal(
    <div className="pane-ghost" style={{ ...left, top: drag.y + 14 }} aria-hidden="true">
      {drag.label}
    </div>,
    document.body,
  )
}
/** The room kept for the ghost's name right of the pointer before it goes to the pointer's left. */
const GHOST_ROOM = 180
