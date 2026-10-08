// The shell: the top bar (its tabs over the panes), the chat column on the left and the panes that show the surfaces
// on the right. It sets --pane-x, the main area's left edge, so the tabs line up with it. A tab, chip or citation shows
// its surface in the pane that holds it, else in the focused pane (panes.show). The layout and the chat column's width
// and fold state are kept per workspace in browser storage (App clears it first when the workspace was replaced by a new
// one of the same name, lib/workspace.ts syncInstance); a new workspace opens on Files. A folded chat column opens when
// something asks for a thread. When the workspace is replaced (the stream's `reset`), the page reloads. With no Claude
// Code session attached the shell is inert under SessionGone.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '../canvas/Canvas'
import { ChatPanel } from '../chat/ChatPanel'
import { holdForChat } from '../chat/pending'
import { isUnread, readSeen } from '../chat/seen'
import { useChatMetas, waitingChats } from '../chat/waiting'
import { Button } from '../components/Button'
import type { IconName } from '../components/Icon'
import { FilesTab } from '../files/FilesTab'
import { LabelEditorHost } from '../files/LabelEditor'
import { useViews } from '../files/ViewsBar'
import { ViewSurface } from '../files/ViewSurface'
import { api } from '../lib/api'
import { bus, type Tab } from '../lib/bus'
import { isReplay, useWorkspaceEvents } from '../lib/events'
import { track } from '../lib/telemetry'
import { notePress, pressedPane, renewPress, setShownSurfaces, setSurfaceDrag } from '../lib/surfaces'
import { refFromUrl, teleport } from '../lib/teleport'
import { noteOpened, openedBefore, openingRef, readStorage, storageKey, writeStorage } from '../lib/workspace'
import { CmdPointer } from '../pointer/CmdPointer'
import { ReportTab } from '../report/ReportTab'
import { tabSignals, useTabDots, writing } from './dots'
import { NewVersion } from './NewVersion'
import { DragGhost, PaneArea, usePaneDrag, type SurfaceSpec } from './PaneArea'
import {
  arrange,
  BASE_SURFACES,
  close,
  drop,
  findPane,
  focused,
  focusPane,
  isNarrow,
  parsePanes,
  place,
  preset,
  readSurface,
  resize,
  show,
  shownSurfaces,
  single,
  slugOfSurface,
  viewSurface,
  type Panes,
  type SurfaceId,
} from './panes'
import { Resizer } from './Resizer'
import { ServerDown } from './ServerDown'
import { SessionGone, useSessionGone } from './SessionGone'
import { Toasts } from './Toasts'
import { TopBar } from './TopBar'
import { TourHost } from './TourHost'

export const CHAT_WIDTH = { def: 308, min: 280, max: 640 }
const BASE: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'canvas', label: 'Canvas', icon: 'canvas' },
  { id: 'report', label: 'Report', icon: 'report' },
]
interface Layout {
  chatWidth: number
  chatOpen: boolean
  panes: Panes
}

/** What a workspace keeps, read back: the stored layout, else one pane on the tab an older page kept, else (a first
 * open) one pane on Files. */
function readLayout(key: string): Layout {
  const saved = readStorage<Partial<Layout> & { tab?: unknown }>(key, {})
  const w = Number(saved.chatWidth)
  const tab = saved.tab === 'files' || saved.tab === 'report' || saved.tab === 'canvas' ? saved.tab : null
  const panes = parsePanes(saved.panes) ?? single(tab ?? 'files')
  return {
    chatWidth: Number.isFinite(w) && w > 0 ? Math.min(CHAT_WIDTH.max, Math.max(CHAT_WIDTH.min, w)) : CHAT_WIDTH.def,
    chatOpen: saved.chatOpen !== false,
    panes,
  }
}

/** The element's size, measured as it changes; `guess` until the first measure. */
function useSize(el: HTMLElement | null, guess: () => { w: number; h: number }) {
  const [size, setSize] = useState(guess)
  useLayoutEffect(() => {
    if (!el) return
    const measure = () => {
      if (el.clientWidth > 0) setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return size
}

export function Shell({ ws }: { ws: string }) {
  useWorkspaceEvents(ws)
  useEffect(() => bus.on('wsReset', (e) => e.workspace === ws && window.location.reload()), [ws])
  const key = storageKey(ws, 'layout')
  const [layout, setLayout] = useState<Layout>(() => readLayout(key))
  const [liveWidth, setLiveWidth] = useState(layout.chatWidth)
  // the panes focused before the current one, most recent first (panes.show, panes.close)
  const recent = useRef<string[]>([])
  const patch = useCallback(
    (p: Partial<Layout>) =>
      setLayout((cur) => {
        const next = { ...cur, ...p }
        writeStorage(key, next)
        return next
      }),
    [key],
  )
  // `keep` false while a divider drags, so storage is written once, when it is let go
  const setPanes = useCallback(
    (fn: (p: Panes) => Panes, keep = true) =>
      setLayout((cur) => {
        const panes = fn(cur.panes)
        if (panes === cur.panes && !keep) return cur
        if (panes.focus !== cur.panes.focus) recent.current = [cur.panes.focus, ...recent.current.filter((id) => id !== cur.panes.focus)].slice(0, 8)
        const next = panes === cur.panes ? cur : { ...cur, panes }
        if (keep) writeStorage(key, next)
        return next
      }),
    [key],
  )
  useEffect(() => setLiveWidth(layout.chatWidth), [layout.chatWidth])

  // the views, each of which a pane can show on its own
  const { views } = useViews(ws)
  const available = useMemo<SurfaceId[]>(() => [...BASE_SURFACES, ...views.map((v) => viewSurface(v.slug))], [views])

  // the pane a press last landed in (lib/surfaces pressedPane): a request to show a surface right after it comes from
  // that pane
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (el?.closest?.('.shell')) notePress(el)
      else renewPress()
    }
    // a press inside a view's frame reaches the frame's document, not this one; the frame taking the focus says where it was
    const onBlur = () =>
      window.setTimeout(() => {
        const el = document.activeElement
        if (el?.tagName !== 'IFRAME') return
        notePress(el)
        const pane = pressedPane()
        if (pane) setPanes((p) => focusPane(p, pane))
      }, 0)
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [setPanes])

  useEffect(() => bus.on('showTab', (e) => setPanes((p) => show(p, e.tab, e.from === undefined ? pressedPane() : e.from, recent.current))), [setPanes])
  // a layout main asked for (the set_layout tool); the history the stream replays on load is not asked again
  useEffect(
    () =>
      bus.on('layout', (e) => {
        if (isReplay()) return
        setPanes((p) => preset(p, e.layout, available, e.surfaces.length ? e.surfaces : undefined))
      }),
    [setPanes, available],
  )

  // a request for the chat while its column is folded opens the column, and the chat panel takes the request once it
  // has mounted (chat/pending.ts)
  const chatOpen = useRef(layout.chatOpen)
  chatOpen.current = layout.chatOpen
  useEffect(() => {
    const open = () => {
      track('panel-open', { target: 'panel:chat', detail: { via: 'request' } })
      patch({ chatOpen: true })
    }
    const offs = [
      bus.on('openChat', (e) => {
        if (chatOpen.current) return
        holdForChat({ event: 'openChat', payload: e })
        open()
      }),
      bus.on('openRef', (e) => {
        if (chatOpen.current || !e.ref.startsWith('call:')) return
        holdForChat({ event: 'openRef', payload: e })
        open()
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [patch])
  // a `?ref=` in the URL opens its element once the surfaces are mounted (their effects run before this one), as a
  // click on its chip would. Without one, the first time this browser opens the workspace it opens at the view the
  // workspace's row names (openingRef: a demo dataset's main view, an example's), as that row on the start page does
  const [firstOpen] = useState(() => !openedBefore(ws))
  useEffect(() => {
    noteOpened(ws)
    const ref = refFromUrl()
    if (ref) return teleport(ref)
    if (!firstOpen) return
    let alive = true
    api
      .workspaces()
      .then((rows) => {
        const at = openingRef(rows, ws)
        if (alive && at) teleport(at)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws, firstOpen])
  const gone = useSessionGone(ws)

  // the main area's left edge: the window's 12px margin, the chat column and the 12px seam, or the collapsed strip
  const paneX = 12 + (layout.chatOpen ? liveWidth + 12 : 40)
  // the main area: its size, whether it is too small for more than one pane, and each pane's rectangle in it
  const [area, setArea] = useState<HTMLDivElement | null>(null)
  const size = useSize(area, () => ({ w: Math.max(0, window.innerWidth - paneX - 12), h: Math.max(0, window.innerHeight - 52) }))
  const panes = layout.panes
  // too small for this layout's panes
  const narrow = isNarrow(size.w, size.h, panes.root)
  const geometry = useMemo(() => {
    const whole = { x: 0, y: 0, w: size.w, h: size.h }
    if (!narrow) return arrange(panes.root, whole)
    const f = focused(panes)
    return { panes: [{ id: f.id, surface: f.surface, ...whole }], dividers: [] }
  }, [panes, narrow, size.w, size.h])
  const multi = geometry.panes.length > 1
  const shown = useMemo(() => shownSurfaces(panes, narrow), [panes, narrow])
  useLayoutEffect(() => setShownSurfaces(shown), [shown])
  const read = readSurface(panes, geometry.panes.length === 1)

  const labelOf = useCallback((s: SurfaceId) => BASE.find((b) => b.id === s)?.label ?? views.find((v) => v.slug === slugOfSurface(s))?.name ?? s, [views])
  const { drag, start: startDrag } = usePaneDrag({
    area,
    geometry,
    panes,
    enabled: !narrow,
    labelOf,
    onDrop: (pane, zone, surface) => {
      track('ui-click', { target: `layout:drop`, detail: { surface, zone } })
      setPanes((p) => drop(p, pane, zone, surface) ?? p)
    },
  })

  useEffect(() => {
    setSurfaceDrag(startDrag)
    return () => setSurfaceDrag(null)
  }, [startDrag])

  const surfaces = useMemo<SurfaceSpec[]>(
    () => [
      { id: 'files', label: 'Files', icon: 'files', panel: 'files', keep: true, render: (v, f) => <FilesTab ws={ws} active={v} focused={f} /> },
      { id: 'canvas', label: 'Canvas', icon: 'canvas', panel: 'canvas', keep: true, render: (v, f) => <Canvas ws={ws} active={v} focused={f} /> },
      { id: 'report', label: 'Report', icon: 'report', panel: 'report', keep: true, render: (v) => <ReportTab ws={ws} active={v} /> },
      ...views.map<SurfaceSpec>((view) => ({
        id: viewSurface(view.slug),
        label: view.name,
        icon: 'view',
        panel: 'files',
        keep: false,
        render: (v) => <ViewSurface ws={ws} view={view} active={v} />,
      })),
    ],
    [ws, views],
  )

  const dots = useTabDots(shown.filter((s): s is Tab => (BASE_SURFACES as readonly string[]).includes(s)))
  const metas = useChatMetas(ws)
  const signals = tabSignals(dots, writing(metas))

  return (
    <div className="shell" data-chat={layout.chatOpen ? 'open' : 'closed'} data-session={gone ? 'gone' : undefined} inert={!!gone} style={{ '--pane-x': `${paneX}px` } as React.CSSProperties}>
      <TopBar
        ws={ws}
        tabs={BASE.map((t) => ({
          value: t.id,
          label: t.label,
          dot: signals[t.id] === 'dot',
          busy: signals[t.id] === 'spinner',
          state: t.id === read ? 'focus' : shown.includes(t.id) ? 'shown' : 'hidden',
        }))}
        onTab={(id) => {
          track('tab-activate', { target: `panel:${id}` })
          setPanes((p) => show(p, id))
        }}
        onTabDrag={startDrag}
      />
      <div className="shell-body">
        {layout.chatOpen ? (
          <>
            <aside className="shell-left" style={{ width: liveWidth }}>
              <ChatPanel
                ws={ws}
                onCollapse={() => {
                  track('panel-close', { target: 'panel:chat' })
                  patch({ chatOpen: false })
                }}
              />
            </aside>
            <Resizer side="left" width={liveWidth} min={CHAT_WIDTH.min} max={CHAT_WIDTH.max} defaultWidth={CHAT_WIDTH.def} onResize={setLiveWidth} onEnd={(w) => patch({ chatWidth: Math.round(w) })} />
          </>
        ) : (
          <div className="shell-strip">
            <ChatStripButton
              ws={ws}
              onOpen={() => {
                track('panel-open', { target: 'panel:chat' })
                patch({ chatOpen: true })
              }}
            />
          </div>
        )}
        <div className="shell-main">
          <main className="shell-center">
            <PaneArea
              panes={panes}
              geometry={geometry}
              multi={multi}
              surfaces={surfaces}
              area={setArea}
              drag={drag}
              onDragStart={startDrag}
              onFocus={(id) => setPanes((p) => focusPane(p, id))}
              onPlace={(id, s) => {
                track('ui-click', { target: 'layout:place', detail: { surface: s } })
                setPanes((p) => place(p, id, s))
              }}
              onClose={(id) => {
                track('panel-close', { target: `pane:${findPane(panes, id)?.surface ?? 'empty'}` })
                setPanes((p) => close(p, id, recent.current))
              }}
              onResize={(path, ratio, done) => setPanes((p) => resize(p, path, ratio), done)}
            />
          </main>
        </div>
      </div>
      {drag && <DragGhost drag={drag} />}
      <CmdPointer ws={ws} />
      <LabelEditorHost ws={ws} />
      <Toasts />
      <TourHost />
      {!gone && <ServerDown />}
      <NewVersion />
      {gone && <SessionGone gone={gone} ws={ws} />}
    </div>
  )
}

/** The folded chat column's button, with the accent dot while main or a thread holds a reply the analyst has not read
 * and the warning dot while a permission prompt waits for them. */
function ChatStripButton({ ws, onOpen }: { ws: string; onOpen: () => void }) {
  const metas = useChatMetas(ws)
  const seen = readSeen(ws)
  const waiting = waitingChats(metas).length > 0 || metas.some((m) => m.kind === 'main' && (m.permissions?.length ?? 0) > 0)
  const unread = metas.some((m) => (m.kind === 'main' || m.kind === 'thread') && isUnread(seen, m.id, m.n_messages))
  return (
    <span className="shell-strip-chat">
      <Button variant="icon" icon="chat" title="Chat" aria-label="Chat" onClick={onOpen} />
      {(waiting || unread) && <span className={`dot shell-strip-dot${waiting ? ' tt-waiting' : ''}`} role="img" aria-label={waiting ? 'Waiting for you' : 'Unread'} />}
    </span>
  )
}
