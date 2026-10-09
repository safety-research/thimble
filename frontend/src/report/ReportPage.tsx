// The report: the card sidebar with its Checks pane (Sidebar.tsx; over the page when the pane is narrow), then the page:
// the block editor in a card-wide column, the margin of comment cards (Margin.tsx), and at the right the ruler and
// scrollbar (files/Ruler PageRuler) with a lane per check that is on. The checks (Checks.tsx useChecks), the active
// comment and the analyst's new comment live here; their tints go to the editor as flags.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { PageRuler, type RulerColumn, type RulerTick } from '../files/Ruler'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { Cell, Group, Writeup } from '../lib/types'
import { ReadProbe, useDock } from '../shell/dock'
import { usedCells } from './cards'
import { SidebarShow, useChecks, useSidebar } from './Checks'
import { checkColumns, openComments, passageFlags, shownComments, type DocComment } from './checkComments'
import { commentsApi, type ResolveHow } from './commentsApi'
import { ReportEditor, type DocFilter, type EditorHandle } from './Editor'
import { forgetFigureCell } from './FigureBlock'
import { Margin, RAIL_ROOM } from './Margin'
import { allSentences, paragraphOf, passageOrder, readableText, TITLE_ID } from './model'
import { Sidebar } from './Sidebar'

const CANVAS_DEBOUNCE_MS = 400

export interface ReportPageProps {
  ws: string
  slug: string
  doc: Writeup
  filter: DocFilter | null
  client: string
  onSaved: (doc: Writeup) => void
}

/** The canvas's cards and groups, read again when a card or a group changes, and when an orientation ends. */
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
      bus.on('cell', (e) => {
        forgetFigureCell(ws, e.cell)
        later()
      }),
      bus.on('wsEvent', (ev) => {
        if (ev.type === 'notebook' || ev.type === 'group' || ev.type === 'canvas') later()
      }),
      bus.on('orient', later),
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
  const checks = useChecks(ws)
  const { on, look } = checks
  const [active, setActive] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [figures, setFigures] = useState<string[]>([])
  const { cells, groups } = useCanvas(ws)
  const editor = useRef<EditorHandle | null>(null)
  const column = useRef<HTMLDivElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  // while a check is on, comments can arrive at any moment, so the margin stands (empty until they come) wherever the page
    // has room beside the text column (report.css `.wu-page > .read-probe`), so the text does not reflow. A page too
    // narrow for both takes the margin only while it has a card to show
  const rail = useDock(RAIL_ROOM)
  const setRailRow = rail.row
  const page = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el
      setRailRow(el)
    },
    [setRailRow],
  )

  const texts = useMemo(() => {
    const out = new Map<string, string>([[TITLE_ID, readableText(doc.title ?? '')]])
    for (const sec of doc.sections ?? []) out.set(sec.id, readableText(sec.heading ?? ''))
    for (const s of allSentences(doc)) out.set(s.id, readableText(s.text))
    return out
  }, [doc])
  const textOf = useCallback((sid: string) => texts.get(sid) ?? '', [texts])
  const open = useMemo(() => openComments(doc.comments, allSentences(doc), passageOrder(doc), paragraphOf(doc)), [doc])
  const shown = useMemo(() => shownComments(open, on), [open, on])
  const flags = useMemo(() => passageFlags(shown, active, look), [shown, active, look])
  const used = useMemo(() => usedCells(figures), [figures])
  const byId = useMemo(() => new Map(cells.map((c) => [c.id, c])), [cells])
  const captionOf = useCallback((id: string) => {
    const c = byId.get(id)
    return readableText(c?.takeaway || c?.title || '').trim()
  }, [byId])

  // a comment that went away (resolved, or its check turned off) stops being active
  useEffect(() => {
    if (active && !shown.some((c) => c.id === active)) setActive(null)
  }, [active, shown])

  // a click on a tinted passage opens its card (the next one of the passage's when one of them is open); a click
  // elsewhere on the page closes the open one
  const onPageClick = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as Element
    if (t.closest('.wu-rail')) return
    const hit = t.closest('[data-cids]')
    const cids = hit?.getAttribute('data-cids')?.split(' ').filter(Boolean) ?? []
    if (!cids.length) {
      if (active) setActive(null)
      return
    }
    const at = active ? cids.indexOf(active) : -1
    setActive(cids[(at + 1) % cids.length])
  }

  const resolve = async (cm: DocComment, how: ResolveHow = 'done') => {
    try {
      const saved = await commentsApi.resolve(ws, slug, cm.id, how)
      track('ui-click', { target: `report:${slug}#${cm.sid}`, detail: { action: how === 'known' ? 'comment-know' : 'comment-resolve', check: cm.check } })
      onSaved(saved as Writeup)
    } catch (e) {
      bus.emit('toast', { text: `Could not resolve the comment. ${(e as Error).message}`, kind: 'error' })
    }
  }
  const saveDraft = async (sid: string, text: string) => {
    const comment = await commentsApi.add(ws, slug, sid, text)
    track('ui-click', { target: `report:${slug}#${sid}`, detail: { action: 'comment-add' } })
    setDraft(null)
    onSaved({ ...doc, comments: [...(doc.comments ?? []), comment] })
    setActive(comment.id)
  }

  // the ruler: the marks follow the passages as the page lays out (a check turned on, a save, a narrower pane); the
  // ruler follows the scroll itself
  const [columns, setColumns] = useState<RulerColumn[]>([])
  const measure = useCallback(() => {
    const box = scroller.current
    const col = column.current
    if (!box || !col) return
    const base = box.getBoundingClientRect().top - box.scrollTop
    const spanOf = (sid: string): [number, number] | null => {
      const r = col.querySelector(`[data-sid="${CSS.escape(sid)}"]`)?.getBoundingClientRect()
      return r ? [r.top - base, r.bottom - base] : null
    }
    setColumns(checkColumns(shown, on, checks.list, spanOf, Math.max(1, box.scrollHeight)))
  }, [shown, on, checks.list])
  useEffect(() => {
    // the editor applies the new tints in its own effect: the ticks are measured on the frame after
    const id = window.requestAnimationFrame(measure)
    return () => window.cancelAnimationFrame(id)
  }, [measure, doc, flags])
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
  const toMark = (_column: string, tick: RulerTick) => {
    const box = scroller.current
    if (box) jump((tick.from - 1 + tick.to) / 2 / Math.max(1, box.scrollHeight))
  }

  return (
    <div className="wu-report" ref={side.row}>
      <ReadProbe probe={side.probe} />
      {side.shown ? (
        <Sidebar ws={ws} cells={cells} groups={groups} used={used} onInsert={(id) => editor.current?.insertCard(id)} onHide={side.hide} over={side.over} doc={slug} checks={checks} comments={open} />
      ) : (
        <SidebarShow onShow={side.show} />
      )}
      <div className="wu-page" ref={page} onClick={onPageClick}>
        <ReadProbe probe={rail.probe} />
        <div className="wu-page-row">
          <div className="wu-page-col" ref={column}>
            <ReportEditor ref={editor} ws={ws} slug={slug} doc={doc} flags={flags} filter={filter} client={client} onSaved={onSaved} onFigures={setFigures} onComment={setDraft} captionOf={captionOf} />
          </div>
          {shown.length > 0 || draft ? (
            <Margin ws={ws} slug={slug} comments={shown} look={look} active={active} onActivate={setActive} onResolve={resolve} draft={draft} onDraft={saveDraft} onDraftCancel={() => setDraft(null)} column={column} textOf={textOf} />
          ) : (
            rail.docks && on.size > 0 && <div className="wu-rail" aria-hidden="true" />
          )}
        </div>
      </div>
      <PageRuler scroller={scroller} columns={columns} onJump={jump} onMark={toMark} tipOf={(col) => col.name} />
    </div>
  )
}
