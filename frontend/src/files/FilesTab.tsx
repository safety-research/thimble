// The Files pane: the views bar across the top (File browser first), under it the sidebar (the files tree with the
// Labels pane pinned to its bottom) and the reader for the open tab, or a picked view with a Labels-only sidebar; the
// status strip along the bottom. Open files are tabs kept per workspace in browser storage; a workspace with none opens
// its largest data file beside the README (Tree.defaultTabs). A ref opens where it belongs: in the view it names, else in
// the view the analyst last used for its file (kept per workspace), else in the File browser; Open in on the file's
// panel lists the other views that claim it. Tree folders are fetched one at a time (Tree.useFolderStore). While the pane has the
// focus, ⌘P focuses the search, ⌘F opens the find bar and Ctrl+G go to line (find.ts findKey).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { PaneStatus } from '../components/PaneStatus'
import { TipButton } from '../components/Tooltip'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { mediaOf } from '../lib/media'
import { fragmentIn, parseRef, refPath } from '../lib/refs'
import { pressedPane, surfaceShown, useFilesViewsSlot, useShownSurfaces } from '../lib/surfaces'
import { track } from '../lib/telemetry'
import type { ConceptRun, LabelDraft, SourceKind, ViewQuery } from '../lib/types'
import { findView } from '../lib/views'
import { readSession, readStorage, storageKey, writeSession, writeStorage } from '../lib/workspace'
import { ReadProbe, useDock, useFoldingSide } from '../shell/dock'
import { viewSurface } from '../shell/panes'
import { typingIn } from '../shell/undo'
import { findKey } from './find'
import { FileSearch } from './FileSearch'
import { folderPresence, presenceOf, viewDefaults, viewLabels, type Presence } from './labels'
import { inferKind, TREE } from './params'
import { pickKey, Reader, type FindAsk } from './Reader'
import { baseName, defaultTabs, fmtSize, glyphOf, kindIn, parentOf, Tree, useFolderStore } from './Tree'
import { useFilesLabels, type FilesLabels } from './useLabels'
import { OpenIn } from './OpenIn'
import { chooseView, viewPlace, viewValue } from './viewChoice'
import { ViewPane } from './ViewPane'
import { useLabelRuns, useLabelSide } from './ViewSide'
import type { ViewQuote } from './ViewerFrame'
import { BROWSER, slugOfKey, useViews, viewKey, ViewsBar, type BuiltView } from './ViewsBar'
import { markOpened, useOpenAskedViews } from './viewReady'

interface Open {
  path: string
  ref?: string
  /** in a view: a passage inside the record `ref` names, and the span ref the File browser opens when the view does not
   * show it */
  quote?: ViewQuote & { span: string }
  /** in a view: the card it was opened from and its arguments (a card type's Open as view) */
  query?: ViewQuery
}

/** The open tabs a workspace keeps: their paths and the one shown. */
interface KeptTabs {
  tabs: string[]
  current: string | null
}

function readTabs(key: string): KeptTabs {
  const got = readStorage<unknown>(key, null) as Partial<KeptTabs> | null
  const tabs = Array.isArray(got?.tabs) ? [...new Set(got.tabs.filter((p): p is string => typeof p === 'string' && !!p))] : []
  const current = typeof got?.current === 'string' && tabs.includes(got.current) ? got.current : tabs[0] ?? null
  return { tabs, current }
}

const NO_DOTS: readonly Presence[] = []

interface TabsProps {
  tabs: Open[]
  current: string | null
  onPick: (path: string) => void
  onClose: (path: string) => void
}

/** The open files as square tabs, VS Code's way: the open one on the cell's paper between hairlines with its ×. */
function ReaderTabs({ tabs, current, onPick, onClose }: TabsProps) {
  return (
    <span className="reader-tabs" role="tablist" aria-label="Open files">
      {tabs.map((t) => {
        const active = t.path === current
        const name = baseName(t.path)
        return (
          <span key={t.path} className={'reader-tab' + (active ? ' active' : '')}>
            <button type="button" role="tab" aria-selected={active} className="reader-tab-pick" onClick={() => onPick(t.path)} data-anchor={t.path} data-anchor-text={t.path}>
              <Icon name={glyphOf(name)} size={13} className="reader-tab-glyph" />
              <span className="reader-tab-name">{name}</span>
            </button>
            <TipButton tip="Close" className="reader-tab-x" aria-label={`Close ${name}`} onClick={() => onClose(t.path)}>
              <Icon name="x" size={12} />
            </TipButton>
          </span>
        )
      })}
    </span>
  )
}

/** The analyst's own choice to show or hide a view's Labels sidebar, per workspace, kept for the tab's session; null
 * until they make one. */
function useSessionChoice(ws: string, name: string): [boolean | null, (v: boolean) => void] {
  const key = storageKey(ws, name)
  const [v, setV] = useState<boolean | null>(() => {
    const got = readSession<unknown>(key, null)
    return typeof got === 'boolean' ? got : null
  })
  const set = useCallback(
    (next: boolean) => {
      setV(next)
      writeSession(key, next)
    },
    [key],
  )
  return [v, set]
}

/** A view's labels by default: the first time the analyst opens a view (per workspace), while no label marking its
 * files is on, the orientation's labels over those files are turned on (labels.viewDefaults), so the view opens
 * coloured with its Labels sidebar as the legend. */
function useViewDefaults(ws: string, view: BuiltView | null, labels: FilesLabels) {
  const [orient, setOrient] = useState<Set<string> | null>(null)
  useEffect(() => {
    let alive = true
    api
      .chats(ws)
      .then((list) => alive && setOrient(new Set(list.filter((c) => c.role === 'orient').map((c) => c.id))))
      .catch(() => alive && setOrient(new Set()))
    return () => {
      alive = false
    }
  }, [ws])
  const { all, presence, toggle } = labels
  useEffect(() => {
    if (!view?.claims?.length || !orient || !all.length || !presence.size) return
    const key = storageKey(ws, `viewLabels:${view.slug}`)
    if (readStorage<unknown>(key, false) === true) return
    writeStorage(key, true)
    for (const id of viewDefaults(all, presence, view.claims, orient)) toggle(id)
  }, [ws, view, orient, all, presence, toggle])
}

/** A per-workspace flag kept in browser storage (the sidebar, the tree and the Labels pane folded or not). */
function useFlag(ws: string, name: string, def: boolean): [boolean, (v: boolean) => void] {
  const key = storageKey(ws, name)
  const [v, setV] = useState(() => {
    const got = readStorage<unknown>(key, def)
    return typeof got === 'boolean' ? got : def
  })
  const set = useCallback(
    (next: boolean) => {
      setV(next)
      writeStorage(key, next)
    },
    [key],
  )
  return [v, set]
}

/** Why a ref to the view `slug` opens nothing: the view is switched off in Settings (its proposal's `off`), or there is
 * none. */
async function missingView(ws: string, slug: string): Promise<string> {
  const p = await api
    .proposals(ws)
    .then((all) => all.find((x) => x.slug === slug))
    .catch(() => undefined)
  return p?.off ? `${p.name} is switched off in Settings.` : `there is no view ${slug}`
}

export function FilesTab({ ws, active, focused = active }: { ws: string; active: boolean; focused?: boolean }) {
  const folders = useFolderStore(ws)
  const labels = useFilesLabels(ws)
  const { views, proposals } = useViews(ws)
  const [bar, setBar] = useState<string>(BROWSER)
  const [viewAt, setViewAt] = useState<Open | null>(null)
  const tabsKey = storageKey(ws, 'filesTabs')
  const [kept] = useState(() => readTabs(tabsKey))
  const [tabs, setTabs] = useState<Open[]>(() => kept.tabs.map((path) => ({ path })))
  const [current, setCurrent] = useState<string | null>(kept.current)
  // whether the tabs are the analyst's yet: kept ones, a file opened, or the defaults once the root is listed
  const [seeded, setSeeded] = useState(kept.tabs.length > 0)
  const [sideOpen, setSideOpen] = useFlag(ws, 'filesSide', true)
  const [viewSideChoice, setViewSideChoice] = useSessionChoice(ws, 'viewSide')
  const [treeOpen, setTreeOpen] = useFlag(ws, 'filesTree', true)
  const [labelsOpen, setLabelsOpen] = useFlag(ws, 'filesLabels', true)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  // a new label's card filled from what its Label from prompt row drafted, else null for a blank one
  const [drafted, setDrafted] = useState<LabelDraft | null>(null)
  // per label, the run the pane has seen: one running, polled until it ends, then its last record, which the label row
  // shows until the concepts list is read again
  const labelRuns = useLabelRuns(ws, labels)
  const [mode, setMode] = useState('')
  const widthKey = storageKey(ws, 'sideWidth')
  const [sideWidth, setSideWidth] = useState(() => {
    const w = Number(readStorage<unknown>(widthKey, TREE.def))
    return Number.isFinite(w) && w >= TREE.min && w <= TREE.max ? w : TREE.def
  })
  const [pendingRef, setPendingRef] = useState<{ ref: string; browser?: boolean; from: string | null } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [findAsk, setFindAsk] = useState<FindAsk>({ mode: 'find', n: 0 })
  // Sidebars (shell/dock.tsx) dock only while the body holds them beside the view or reader at a readable width. A
  // view's Labels sidebar starts hidden and shows while a label is on, until the analyst hides or shows it for the tab's
  // session; when it cannot dock it lies over the view's left edge. The File browser's sidebar folds to its show button
  // when it cannot dock.
  const dock = useDock(sideWidth)
  const viewSideOpen = viewSideChoice ?? labels.on.length > 0
  const viewSideOver = viewSideOpen && !dock.docks
  const side = useFoldingSide(dock.docks, sideOpen, setSideOpen)
  const root = folders.store.get('')
  const error = root?.state === 'error' ? root.message : null
  const open = tabs.find((t) => t.path === current) ?? null
  const listing = root?.state === 'ok' ? root.listing : null
  const shownView = slugOfKey(bar) ? views.find((v) => v.slug === slugOfKey(bar)) ?? null : null
  // a view the analyst asked for opens by itself once built, and one shown here waits for them no longer
  useOpenAskedViews(ws, new Map([...proposals, ...views].map((v) => [v.slug, v.name])))
  const shownSlug = shownView?.slug ?? null
  useEffect(() => {
    if (shownSlug && active) markOpened(ws, shownSlug)
  }, [ws, shownSlug, active])
  // a view a pane shows on its own (dragged out of the bar, or picked here while it has one) is not shown here as well:
  // its pane takes the place shown here and the focus, and Files goes back to the File browser
  const panesShow = useShownSurfaces()
  // the views sit in Files' pane head while Files shows beside another pane, and in a row at Files' top otherwise
  const viewsSlot = useFilesViewsSlot()
  const ownPane = !!shownSlug && panesShow.includes(viewSurface(shownSlug))
  useEffect(() => {
    if (!ownPane || !shownSlug) return
    if (viewAt) bus.emit('openInView', { slug: shownSlug, path: viewAt.path, ref: viewAt.ref, quote: viewAt.quote, query: viewAt.query })
    bus.emit('showTab', { tab: viewSurface(shownSlug) })
    setBar(BROWSER)
    setViewAt(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownPane, shownSlug])

  // the Files view's shortcuts, while its pane has the focus; a field outside Files keeps its keys
  const showSide = side.show
  const canFind = !shownView && !!open && !mediaOf(open.path)
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      const which = findKey(e)
      if (!which || e.defaultPrevented) return
      const held = document.activeElement
      if (typingIn(held) && !rootRef.current?.contains(held)) return
      if (which === 'files') {
        e.preventDefault()
        setBar(BROWSER)
        showSide()
        setTreeOpen(true)
        // the field takes the focus now when it is there, else once the sidebar or the tree has opened
        const focus = () => {
          searchRef.current?.focus()
          searchRef.current?.select()
        }
        if (searchRef.current) focus()
        else requestAnimationFrame(focus)
      } else if (canFind) {
        e.preventDefault()
        setFindAsk((a) => ({ mode: which, n: a.n + 1 }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused, canFind, showSide, setTreeOpen])

  // opening a path already open brings its tab forward (with the new target); a new one is appended and shown
  const openTab = useCallback((o: Open) => {
    setTabs((prev) => (prev.some((t) => t.path === o.path) ? prev.map((t) => (t.path === o.path ? { ...t, ...o } : t)) : [...prev, o]))
    setCurrent(o.path)
    setBar(BROWSER)
  }, [])
  const closeTab = useCallback(
    (path: string) => {
      const i = tabs.findIndex((t) => t.path === path)
      if (i < 0) return
      track('file-close', { target: path })
      const next = tabs.filter((_, j) => j !== i)
      setTabs(next)
      if (current === path) setCurrent(next.length ? next[Math.max(0, i - 1)].path : null)
    },
    [tabs, current],
  )
  useEffect(() => writeStorage(tabsKey, { tabs: tabs.map((t) => t.path), current } satisfies KeptTabs), [tabsKey, tabs, current])
  // which file is in front, for the telemetry: a click on a file's tab names no file (its label is a file name)
  useEffect(() => {
    if (current) track('tab-activate', { target: current, detail: { panel: 'files' } })
  }, [current])
  // a workspace that keeps no tabs opens its default files once the root is listed; closing every tab afterwards
  // leaves the reader empty until the next load
  useEffect(() => {
    if (seeded) return
    if (tabs.length) return setSeeded(true)
    if (!listing) return
    const first = defaultTabs(listing.files)
    setTabs(first.map((path) => ({ path })))
    setCurrent(first[0] ?? null)
    setSeeded(true)
  }, [seeded, tabs.length, listing])
  const showView = useCallback((slug: string, at: Open | null) => {
    setBar(viewKey(slug))
    setViewAt(at)
  }, [])
  // where a ref lands: a place in a view opens in the pane that shows that view on its own, else in Files; `from` is the
  // pane the ref was asked from, taken when asked, since placing it waits on the server
  const toView = useCallback(
    (slug: string, at: Open | null, from?: string | null) => {
      if (surfaceShown(viewSurface(slug))) {
        if (at) bus.emit('openInView', { slug, path: at.path, ref: at.ref, quote: at.quote, query: at.query })
        bus.emit('showTab', { tab: viewSurface(slug), from })
        return
      }
      bus.emit('showTab', { tab: 'files', from })
      showView(slug, at)
    },
    [showView],
  )
  const toBrowser = useCallback(
    (o: Open, from?: string | null) => {
      bus.emit('showTab', { tab: 'files', from })
      openTab(o)
    },
    [openTab],
  )
  // a file viewer is a mode of the File browser: a ref to it opens the file there, in that mode
  const toFileViewer = useCallback(
    (slug: string, at: Open, from?: string | null) => {
      writeStorage(pickKey(ws, at.path), viewValue(slug))
      toBrowser({ path: at.path, ref: at.ref }, from)
      bus.emit('fileMode', { path: at.path, mode: viewValue(slug) })
    },
    [ws, toBrowser],
  )
  // the view the analyst last used for a file, which a ref into it opens in; null for the File browser
  const usedFor = useCallback((path: string) => readStorage<string | null>(storageKey(ws, `openIn:${path}`), null), [ws])
  const used = useCallback((path: string, slug: string | null) => writeStorage(storageKey(ws, `openIn:${path}`), slug), [ws])

  useEffect(
    () =>
      bus.on('openView', ({ slug, query }) => {
        const from = pressedPane()
        findView(ws, slug)
          .then(async (v) => {
            if (!v?.first_file) throw new Error(v ? `there is no view ${slug}` : await missingView(ws, slug))
            if (v.file_type) toFileViewer(slug, { path: v.first_file }, from)
            else toView(slug, { path: v.first_file, query: query ?? undefined }, from)
          })
          .catch((e: Error) => bus.emit('toast', { text: `Could not open the view. ${e.message}`, kind: 'error' }))
      }),
    [ws, toView, toFileViewer],
  )
  useEffect(
    () =>
      bus.on('openRef', (e) => {
        const p = parseRef(e.ref)
        if (!p) return
        if (p.kind === 'view' || 'path' in p) setPendingRef({ ref: e.ref, browser: e.browser, from: pressedPane() })
      }),
    [],
  )

  // a ref's place: a view ref in its view (or the File browser when the view is gone); a file ref in the view the analyst
  // last used for the file, at the ref's place or the record a span sits in (viewPlace), else in the File browser. With
  // `browser` (an example card's address) a file ref always opens in the File browser
  const openRef = useCallback(
    async (ref: string, browser = false, from: string | null = null) => {
      const p = parseRef(ref)
      try {
        if (p?.kind === 'view') {
          const v = await findView(ws, p.slug)
          if (!p.key) {
            if (!v) throw new Error(await missingView(ws, p.slug))
            if (v.file_type && v.first_file) toFileViewer(p.slug, { path: v.first_file }, from)
            else toView(p.slug, v.first_file ? { path: v.first_file } : null, from)
            return
          }
          const r = await api.resolveRef(ws, ref)
          const first = (r.refs ?? [])[0]
          const path = first ? refPath(first) : null
          if (!path) throw new Error(`${ref} names no file line`)
          // a view that is gone or switched off in Settings leaves its refs to the File browser
          if (!v || (r.meta && (r.meta as { deleted?: boolean }).deleted)) toBrowser({ path, ref: first }, from)
          else if (v.file_type) toFileViewer(p.slug, { path, ref: first }, from)
          else {
            used(path, p.slug)
            toView(p.slug, { path, ref }, from)
          }
          return
        }
        const path = refPath(ref)
        if (path == null) return
        if (browser) return toBrowser({ path, ref }, from)
        const remembered = usedFor(path)
        const claiming = remembered ? await api.viewsForFile(ws, path).then((v) => v.filter((x) => x.ok)).catch(() => []) : []
        const slug = chooseView({ views: claiming, remembered })
        const view = claiming.find((v) => v.slug === slug)
        if (!view) return toBrowser({ path, ref }, from)
        if (view.file_type) return toFileViewer(view.slug, { path, ref }, from)
        const fragment = fragmentIn(ref, path)
        if (fragment == null) return toView(view.slug, { path }, from)
        const knows = (s: string, r: string) =>
          api
            .viewOpen(ws, s, r)
            .then((o) => !o.error)
            .catch(() => false)
        const place = await viewPlace([view], path, fragment, knows)
        if (!place) return toBrowser({ path, ref }, from)
        if (place.ref === ref) return toView(place.slug, { path, ref }, from)
        // the view shows the record a quoted span sits in: its page is sent the span's text to highlight
        const text = await api
          .resolveRef(ws, ref)
          .then((r) => (r.kind === 'span' && r.excerpt.trim() ? r.excerpt : null))
          .catch(() => null)
        toView(place.slug, { path, ref: place.ref, quote: text ? { record: place.ref, text, span: ref } : undefined }, from)
      } catch (e) {
        bus.emit('toast', { text: `Could not open ${ref}. ${(e as Error).message}`, kind: 'error' })
      }
    },
    [ws, toBrowser, toView, toFileViewer, used, usedFor],
  )
  // Open in: the file in another view that claims it, at the place shown when that is in the file, or in the File browser
  const openIn = useCallback(
    (path: string, ref: string | undefined, slug: string | null) => {
      used(path, slug)
      const at = ref && refPath(ref) === path ? ref : undefined
      track('view-open', { target: slug ? `view:${slug}` : 'panel:files', detail: { from: 'open-in' } })
      if (slug) toView(slug, { path, ref: at })
      else toBrowser({ path, ref: at })
    },
    [used, toView, toBrowser],
  )
  useEffect(() => bus.on('openIn', ({ path, ref, slug }) => openIn(path, ref, slug)), [openIn])
  // a quoted span the view did not show opens in the File browser, which highlights it
  const quoteMissing = useCallback(() => {
    if (viewAt?.quote) openTab({ path: viewAt.path, ref: viewAt.quote.span })
  }, [viewAt, openTab])
  // the view dropped the arguments of the card it was opened from
  const clearQuery = useCallback(() => setViewAt((v) => (v?.query ? { ...v, query: undefined } : v)), [])
  useEffect(() => {
    if (!pendingRef) return
    void openRef(pendingRef.ref, !!pendingRef.browser, pendingRef.from)
    setPendingRef(null)
  }, [pendingRef, openRef])

  // the open path's folder is fetched, so its kind is read from the listing rather than guessed from its name
  const shownPath = shownView ? viewAt?.path ?? shownView.first_file ?? null : open?.path ?? null
  useEffect(() => {
    if (shownPath) folders.ensure(parentOf(shownPath))
  }, [shownPath, folders])
  const kindOf = useCallback((path: string): SourceKind => kindIn(folders.store, path) ?? inferKind(path), [folders.store])
  // the reader waits for the open path's folder: a listing in flight may still say the path is a folder or a database
  const parentState = open ? folders.store.get(parentOf(open.path)) : undefined
  const ready = !!open && parentState !== undefined && parentState.state !== 'loading'

  const marksOf = useCallback((path: string) => presenceOf(labels.on, labels.presence, path), [labels.on, labels.presence])
  const folderDots = useMemo(() => folderPresence(labels.on, labels.presence), [labels.on, labels.presence])
  const folderDotsOf = useCallback((path: string) => folderDots.get(path) ?? NO_DOTS, [folderDots])
  // Open in Files on a label's popover outside Files: the Labels pane open, in the sidebar that holds it (a view's
  // Labels sidebar, else the File browser's), and the label's edit card
  useEffect(
    () =>
      bus.on('editLabel', ({ id }) => {
        if (shownSlug) setViewSideChoice(true)
        else showSide()
        setLabelsOpen(true)
        setEditing(id)
      }),
    [shownSlug, showSide, setViewSideChoice, setLabelsOpen],
  )
  // a label deleted while its card is open closes the card
  useEffect(() => {
    if (editing && editing !== 'new' && labels.all.length && !labels.byId.has(editing)) setEditing(null)
  }, [editing, labels.all.length, labels.byId])
  const totals = useMemo(() => {
    if (!listing) return ''
    const n = listing.n_files
    const size = listing.folders.length ? null : listing.files.reduce((a, f) => a + (f.size_bytes || 0), 0)
    return `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}${size != null ? ` · ${fmtSize(size)}` : ''}`
  }, [listing])
  const pickBar = (v: string) => {
    track('view-open', { target: v === BROWSER ? 'panel:files' : `view:${slugOfKey(v)}`, detail: { from: 'views-bar' } })
    setBar(v)
    setViewAt(null)
    setEditing(null)
  }
  const edit = useCallback((id: string | 'new' | null) => {
    setEditing(id)
    setDrafted(null)
  }, [])
  // what a new label applies to: the files the view in front claims, else the file open in the reader
  const appliesTo = useMemo(() => (shownView ? shownView.claims ?? (shownPath ? [shownPath] : []) : open?.path ? [open.path] : []), [shownView, shownPath, open?.path])
  useViewDefaults(ws, shownView, labels)
  // beside a view: the labels that mark its files come first
  const marking = useMemo(() => (shownView?.claims ? viewLabels(labels.all, labels.presence, shownView.claims) : null), [shownView, labels.all, labels.presence])
  // a view's New label… opens the prompt in the Labels sidebar beside it
  const newLabel = useCallback(() => {
    setViewSideChoice(true)
    setLabelsOpen(true)
    edit('new')
  }, [setViewSideChoice, setLabelsOpen, edit])
  const fillNew = useCallback((draft: LabelDraft) => {
    setEditing('new')
    setDrafted(draft)
  }, [])

  // the one Labels pane, the edit card and the sidebar's seam, which the File browser and a view both show; a docked
  // sidebar is dragged no wider than the body leaves room for beside the view or the reader, in whole px, as the width
  // is kept
  const { pane: labelsPane, card: labelCard, resizer } = useLabelSide({
    ws,
    labels,
    runs: labelRuns,
    open: labelsOpen,
    onToggleOpen: () => setLabelsOpen(!labelsOpen),
    editing,
    onEdit: edit,
    drafted,
    onDraft: fillNew,
    appliesTo,
    width: sideWidth,
    onWidth: setSideWidth,
    onWidthEnd: (w) => {
      setSideWidth(Math.round(w))
      writeStorage(widthKey, Math.round(w))
    },
    maxWidth: dock.room,
    onHide: shownView ? () => setViewSideChoice(false) : undefined,
    first: marking ?? undefined,
    filterable: !!shownView,
  })
  // the bar's lead keeps its identity while the sidebar is dragged, so the reader (a memo) is not rendered again on
  // each move of the drag
  const sideShown = side.shown
  const lead = useMemo(
    () => (
      <>
        {!sideShown && <Button variant="icon" size="sm" icon="sidebar" title="Show sidebar" className="reader-side-show" onClick={showSide} />}
        <ReaderTabs tabs={tabs} current={current} onPick={setCurrent} onClose={closeTab} />
      </>
    ),
    [sideShown, showSide, tabs, current, closeTab],
  )

  const openPath = open?.path ?? null
  const openRefAt = open?.ref
  const openInEnd = useMemo(
    () => (openPath ? <OpenIn ws={ws} path={openPath} current={null} onOpen={(slug) => openIn(openPath, openRefAt, slug)} /> : null),
    [ws, openPath, openRefAt, openIn],
  )
  const viewsBar = (compact: boolean) => <ViewsBar ws={ws} value={shownView ? bar : BROWSER} onChange={pickBar} views={views} proposals={proposals} compact={compact} />
  return (
    <div className="files-tab" data-panel="files" ref={rootRef}>
      {viewsSlot ? createPortal(viewsBar(true), viewsSlot) : viewsBar(false)}
      {shownView ? (
        <div className="files-body is-view" ref={dock.row}>
          <ReadProbe probe={dock.probe} />
          {viewSideOpen && (
            <>
              <aside className={'files-side files-side-labels' + (viewSideOver ? ' is-over' : '')} style={{ width: sideWidth }}>
                {labelsPane}
              </aside>
              {!viewSideOver && resizer}
            </>
          )}
          <ViewPane
            ws={ws}
            view={shownView}
            path={shownPath}
            picked={!!viewAt?.path}
            kind={shownPath ? kindOf(shownPath) : 'text'}
            targetRef={viewAt?.ref}
            quote={viewAt?.quote}
            query={viewAt?.query}
            onClearQuery={clearQuery}
            onQuoteMissing={quoteMissing}
            labels={labels}
            onMode={setMode}
            first={marking ?? undefined}
            onNewLabel={newLabel}
            lead={
              !viewSideOpen && <Button variant="icon" size="sm" icon="sidebar" title="Show labels" aria-label="Show labels" className="view-pane-side-show" onClick={() => setViewSideChoice(true)} />
            }
          />
          {viewSideOpen && labelCard}
        </div>
      ) : (
        <div className="files-body" ref={dock.row}>
          <ReadProbe probe={dock.probe} />
          {side.shown && (
            <>
              <aside className={'files-side' + (side.over ? ' is-over' : '')} style={{ width: sideWidth }}>
                <section className="files-side-tree">
                  <div className="files-side-head">
                    <button type="button" className="files-side-title" aria-expanded={treeOpen} onClick={() => setTreeOpen(!treeOpen)}>
                      <Icon name="chevron-right" size={14} className="files-caret" />
                      <span className="files-side-name">{ws}</span>
                    </button>
                    <Button variant="icon" size="sm" icon="sidebar" title="Hide sidebar" aria-label="Hide sidebar" onClick={side.hide} />
                  </div>
                  {treeOpen && (
                    <FileSearch ws={ws} inputRef={searchRef} onOpen={(path, line) => openTab({ path, ref: line ? `${path}#L${line}` : undefined })}>
                      <Tree folders={folders} error={error} activePath={open?.path ?? null} onOpen={(path) => openTab({ path })} marksOf={marksOf} folderDotsOf={folderDotsOf} />
                    </FileSearch>
                  )}
                </section>
                {labelsPane}
              </aside>
              {!side.over && resizer}
            </>
          )}
          <div className="files-main">
            {open && ready ? (
              <Reader workspace={ws} path={open.path} kind={kindOf(open.path)} targetRef={open.ref} lead={lead} end={openInEnd} labels={labels} onMode={setMode} findAsk={findAsk} />
            ) : (
              <div className="reader">
                <div className="reader-bar">{lead}</div>
              </div>
            )}
          </div>
          {side.shown && labelCard}
        </div>
      )}
      <PaneStatus name="Files" meta={shownView ? `view · ${shownView.name}${mode === 'Raw' ? ' · Raw' : ''}` : open ? [baseName(open.path), mode].filter(Boolean).join(' · ') : ''} totals={totals} />
    </div>
  )
}
