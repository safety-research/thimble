// The Report tab: the type bar, then the document in its arrangement. The bar holds the types as chips with an icon,
// drawn as the Files views bar draws its views (Segmented), + New
// (DocMenus.tsx), Export (ExportMenu.tsx), the story's Read, the lock note (LockNote.tsx), History (History.tsx) and the primary action,
// Write or Revise (WriteAction.tsx, where Revise asks first), which asks the analyst's session for the document (a
// `write` browser event; `report` stream events follow it). A failed write stays on its document (writeFailures.ts) with Retry until dismissed or written. A document
// not written yet is its frame (GET …/frame). The views' module (Documents.tsx) is imported once in an effect rather than
// with React.lazy, whose Suspense retry can stall; documents are kept by slug so a switch never shows an empty body.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Segmented } from '../components/Button'
import type { IconName } from '../components/Icon'
import { FilterChip } from '../components/FilterChip'
import { Mark } from '../components/Marks'
import { Spinner } from '../components/Spinner'
import { Tipped } from '../components/Tooltip'
import { api, docsApi, isNotFound } from '../lib/api'
import { bus } from '../lib/bus'
import { parseRef } from '../lib/refs'
import { track } from '../lib/telemetry'
import { revealAnchor } from '../lib/teleport'
import type { AnyDoc, TypesState, Writeup } from '../lib/types'
import { readStorage, writeStorage } from '../lib/workspace'
import { ReportProblemButton } from '../shell/ProblemReport'
import { writerDoc } from '../chat/threads'
import { useChatMetas } from '../chat/waiting'
import { NewDocMenu, TypeActions } from './DocMenus'
import type { DocFilter } from './Editor'
import { DraftDiff, HistoryMenu, PastDraft } from './History'
import type { HistoryRow, HistoryView } from './historyModel'
import { LockNote } from './LockNote'
import { ExportMenu } from './ExportMenu'
import { docKey, docLabel, labelReadDocument, ownType, rendererOf, reportFilterSets, SLUG, switcherItems } from './model'
import { WriteAction } from './WriteAction'
import { failedDetail, failedReport, failedText, useWriteFailures, WRITE_RETRY_NOTE } from './writeFailures'
import { ApiErrorCard } from '../chat/ApiError'
import { failureText, loadChunk } from '../lib/chunkRecovery'

type DocsModule = typeof import('./Documents')
let docsModule: DocsModule | null = null
let docsLoading: Promise<DocsModule> | null = null
/** The views' chunk, fetched once per page. */
function loadDocs(): Promise<DocsModule> {
  if (!docsLoading) {
    docsLoading = loadChunk(() => import('./Documents')).then((m) => {
      docsModule = m
      return m
    })
    docsLoading.catch(() => {
      docsLoading = null
    })
  }
  return docsLoading
}

const REFETCH_DEBOUNCE_MS = 300
const ROWS_LIMIT = 5000
/** this tab's token on its saves, so its own `edited` events are not refetched */
const CLIENT = Math.random().toString(36).slice(2, 10)

type Load = { state: 'loading' } | { state: 'ok'; doc: AnyDoc } | { state: 'none' } | { state: 'error'; message: string }

/** Each kind of document's icon in the type bar, by its renderer. */
const DOC_ICON: Record<string, IconName> = { document: 'doc', slides: 'image', story: 'writeup', video: 'run', custom: 'page' }

export function ReportTab({ ws, active }: { ws: string; active: boolean }) {
  const [slug, setSlugState] = useState<string>(() => readStorage<string>(docKey(ws), SLUG) || SLUG)
  const [types, setTypes] = useState<TypesState | null>(null)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [filter, setFilter] = useState<DocFilter | null>(null)
  const [writingSlug, setWritingSlug] = useState<string | null>(null)
  const [generating, setGenerating] = useState<Record<string, boolean>>({})
  const [drawer, setDrawer] = useState(false)
  // a past draft, or a comparison of two, shown read-only in place of the editor (History.tsx), with the history's rows
  // for the band; null for the current draft in the editor
  const [past, setPast] = useState<{ view: HistoryView; rows: HistoryRow[] } | null>(null)
  // the chats, for a writer's session of the document shown (below)
  const chats = useChatMetas(ws)
  const { failures, dismiss } = useWriteFailures(ws)
  const failure = failures[slug] ?? null
  // the views' module is fetched the first time the tab is shown, and stays mounted after
  const [shown, setShown] = useState(active)
  useEffect(() => {
    if (active) setShown(true)
  }, [active])
  const [views, setViews] = useState<DocsModule | null>(docsModule)
  const [viewsError, setViewsError] = useState<string | null>(null)
  useEffect(() => {
    if (!shown || views) return
    let live = true
    loadDocs()
      .then((m) => live && setViews(m))
      .catch((e) => live && setViewsError(failureText(e)))
    return () => {
      live = false
    }
  }, [shown, views])
  const root = useRef<HTMLDivElement>(null)
  const pendingRef = useRef<string | null>(null)
  const filterConcept = useRef<string | null>(null)
  const slugRef = useRef(slug)
  slugRef.current = slug
  // every document read or saved here, by slug, so a switch back to one shows it at once while it is read again; and
  // the one the body showed last, which it keeps showing while a document not read yet loads after a switch, so the
  // body never stands empty between two documents, and the layout does not jump
  const kept = useRef(new Map<string, AnyDoc>())
  const lastShown = useRef<{ slug: string; doc: AnyDoc } | null>(null)

  const setSlug = useCallback(
    (next: string) => {
      if (next === slugRef.current) return
      slugRef.current = next
      setSlugState(next)
      writeStorage(docKey(ws), next)
      const hit = kept.current.get(next)
      setLoad(hit ? { state: 'ok', doc: hit } : { state: 'loading' })
      setDrawer(false)
      setPast(null)
      track('ui-click', { target: `report:${next}`, detail: { action: 'switch' } })
    },
    [ws],
  )

  const readTypes = useCallback(async (): Promise<TypesState | null> => {
    try {
      const state = await docsApi.types(ws)
      setTypes(state)
      return state
    } catch {
      return null
    }
  }, [ws])

  const read = useCallback(async () => {
    const s = slugRef.current
    const state = await readTypes()
    if (slugRef.current !== s) return
    const renderer = rendererOf(state, s, null)
    const settle = (next: Load) => {
      if (next.state === 'ok') kept.current.set(s, next.doc)
      else kept.current.delete(s)
      if (slugRef.current === s) setLoad(next)
    }
    // a page the state says is not written yet is not fetched: its route answers 404 until then; the report, the
    // slides and the story read as their frame before a write
    const framed = renderer === 'document' || renderer === 'slides' || renderer === 'story'
    if (!framed && state?.[s] && !state[s].exists) return settle({ state: 'none' })
    try {
      if (framed && (renderer === 'document' || (state?.[s] && !state[s].exists))) {
        try {
          return settle({ state: 'ok', doc: await api.frame(ws, s) })
        } catch (e) {
          if (!isNotFound(e)) throw e
        }
      }
      settle({ state: 'ok', doc: await docsApi.document(ws, s) })
    } catch (e) {
      settle(isNotFound(e) ? { state: 'none' } : { state: 'error', message: (e as Error).message })
    }
  }, [ws, readTypes])

  const readFilter = useCallback(async () => {
    const s = slugRef.current
    try {
      const entry = (await api.filters(ws)).report
      if (!entry) {
        filterConcept.current = null
        return setFilter(null)
      }
      filterConcept.current = entry.concept
      // every value's rows, so a document the label never read (it runs over the report) takes no filter from it
      const [concept, rows] = await Promise.all([api.concept(ws, entry.concept).catch(() => null), api.conceptRows(ws, entry.concept, { limit: ROWS_LIMIT })])
      if (filterConcept.current !== entry.concept || slugRef.current !== s) return
      if (!labelReadDocument(rows.rows, s)) return setFilter(null)
      setFilter({ concept: entry.concept, name: concept?.name ?? 'label', value: entry.value, sets: reportFilterSets(rows.rows.filter((r) => r.label === entry.value), s) })
    } catch {
      /* the filter is a convenience; the document stands without it */
    }
  }, [ws])

  useEffect(() => {
    void read()
    void readFilter()
  }, [read, readFilter, slug])

  useEffect(() => {
    let timer: number | null = null
    let typesTimer: number | null = null
    const later = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void read(), REFETCH_DEBOUNCE_MS)
    }
    const typesLater = () => {
      if (typesTimer != null) window.clearTimeout(typesTimer)
      typesTimer = window.setTimeout(() => void readTypes(), REFETCH_DEBOUNCE_MS)
    }
    const offs = [
      bus.on('wsEvent', (ev) => {
        if (ev.type !== 'report') return
        const e = ev as { slug?: unknown; status?: unknown; client?: unknown }
        const evSlug = typeof e.slug === 'string' ? e.slug : ''
        if (!evSlug) return
        // a failure's mark on the document and its card come from writeFailures.ts
        if (e.status === 'generating') setGenerating((g) => ({ ...g, [evSlug]: true }))
        else if (e.status === 'generated' || e.status === 'failed') setGenerating((g) => ({ ...g, [evSlug]: false }))
        if (e.status === 'deleted' || e.status === 'created' || e.status === 'renamed') {
          // a type made, renamed or deleted, here or in another tab or by the chat: the bar follows, and a deleted
          // document shown goes back to the report
          kept.current.delete(evSlug)
          if (e.status === 'deleted' && evSlug === slugRef.current) setSlug(SLUG)
          typesLater()
          return
        }
        if (evSlug !== slugRef.current) {
          // its kept copy is out of date: a switch to it waits for the new one rather than show the old
          if (e.status !== 'generating') {
            kept.current.delete(evSlug)
            typesLater()
          }
          return
        }
        if (e.status === 'edited') {
          if (e.client !== CLIENT) later()
          return
        }
        if (e.status === 'generating') return
        later()
      }),
      bus.on('filter', (e) => {
        if (e.scope === 'report') void readFilter()
      }),
      bus.on('concepts', (e) => {
        if (filterConcept.current && (!e.concept || e.concept === filterConcept.current)) void readFilter()
      }),
    ]
    return () => {
      for (const off of offs) off()
      if (timer != null) window.clearTimeout(timer)
      if (typesTimer != null) window.clearTimeout(typesTimer)
    }
  }, [read, readFilter, readTypes, setSlug])

  // a chip's teleport into a document: the document it names comes forward, then the element
  useEffect(
    () =>
      bus.on('openRef', (e) => {
        const p = parseRef(e.ref)
        if (p?.kind !== 'report') return
        pendingRef.current = e.ref
        if (p.slug && p.slug !== slugRef.current) setSlug(p.slug)
      }),
    [setSlug],
  )
  useEffect(() => {
    const ref = pendingRef.current
    if (!ref || !active || !root.current) return
    const id = window.requestAnimationFrame(() => {
      if (revealAnchor(ref, root.current!)) pendingRef.current = null
    })
    return () => window.cancelAnimationFrame(id)
  }, [active, load])

  const clearFilter = async () => {
    const concept = filter?.concept
    setFilter(null)
    filterConcept.current = null
    track('filter-clear', { target: concept ? `concept:${concept}` : null, detail: { scope: 'report' } })
    try {
      await api.deleteFilter(ws, 'report')
    } catch (e) {
      bus.emit('toast', { text: `Could not clear the filter. ${(e as Error).message}`, kind: 'error' })
      void readFilter()
    }
  }

  const doc = load.state === 'ok' ? load.doc : null
  const renderer = rendererOf(types, slug, doc)
  const isPage = renderer === 'custom'
  const isVideo = renderer === 'video'
  useEffect(() => {
    if (doc) lastShown.current = { slug, doc }
  }, [slug, doc])
  // what the body shows: the selected document, or while it loads after a switch the one shown before it
  const held = load.state === 'loading' ? lastShown.current : null
  const bodySlug = held ? held.slug : slug
  const bodyDoc = held ? held.doc : doc
  const bodyRenderer = held ? rendererOf(types, held.slug, held.doc) : renderer
  // a writer's session of this document that runs: the write goes on after its first save (the stream says
  // `generated` then), so the primary action stays Writing, never Revise, until the session ends
  const writer = chats.find((m) => m.role === 'writer' && m.status === 'running' && writerDoc(m) === slug) ?? null
  // a document is being written while its write is pending or a writer of it runs (which goes on after its first save)
  const writingOf = (s: string) => !!generating[s] || types?.[s]?.status === 'generating' || chats.some((m) => m.role === 'writer' && m.status === 'running' && writerDoc(m) === s)
  const busy = writingSlug === slug || !!generating[slug] || types?.[slug]?.status === 'generating' || !!writer
  // the request reaches the session as an event; the stream's `report` events (generating, then generated or failed)
  // carry the write from there, so the button stays busy while the writer works
  const write = async () => {
    if (busy) return
    const s = slug
    setWritingSlug(s)
    track('ui-click', { target: `ui:report-write`, detail: { slug: s } })
    try {
      await api.write(ws, s)
      setGenerating((g) => ({ ...g, [s]: true }))
    } catch (e) {
      bus.emit('toast', { text: `Could not ask for the ${s}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setWritingSlug((w) => (w === s ? null : w))
    }
  }
  const made = async (t: { slug: string }) => {
    await readTypes()
    setSlug(t.slug)
  }
  // a save lands on the document it was made in: a save after a switch only updates that document's kept copy
  const onSaved = useMemo(
    () => (saved: AnyDoc) => {
      kept.current.set(bodySlug, saved)
      if (slugRef.current === bodySlug) setLoad({ state: 'ok', doc: saved })
    },
    [bodySlug],
  )

  const items = switcherItems(types)
  // a document the writer has produced: the primary action reads Revise; a frame, or nothing yet, reads Write
  const written = !!bodyDoc && !(bodyDoc as Writeup).frame
  const arranged = bodyRenderer === 'slides' || bodyRenderer === 'story'
  const fallback = (
    <div className="wu-status">
      <Spinner size={14} label="Loading the editor" />
    </div>
  )
  const closePast = useCallback(() => setPast(null), [])
  const pastShown = past != null && written && !isPage && !isVideo
  const view = pastShown ? (
    past.view.kind === 'diff' ? (
      <DraftDiff ws={ws} slug={slug} from={past.view.from} to={past.view.to} rows={past.rows} onClose={closePast} />
    ) : (
      <PastDraft ws={ws} slug={slug} target={past.view.target} rows={past.rows} onClose={closePast} />
    )
  ) : shown && (bodyDoc || (isPage && load.state === 'none')) ? (
      views ? (
        <views.DocumentView ws={ws} slug={bodySlug} renderer={bodyRenderer} doc={bodyDoc} filter={filter} client={CLIENT} drawer={drawer || load.state === 'none'} onSaved={onSaved} writing={writingOf(bodySlug)} />
      ) : viewsError ? (
        <div className="wu-status wu-error">
          Could not load the editor
          <div className="wu-error-detail">{viewsError}</div>
        </div>
      ) : (
        fallback
      )
    ) : null
  return (
    <div className="wu-root" ref={root} data-panel="report" data-doc={slug} data-renderer={renderer}>
      <div className="wu-bar">
        <Segmented
          className="wu-types"
          label="Documents"
          size="lg"
          value={slug}
          onChange={setSlug}
          options={items.map((it) => ({
            value: it.slug,
            icon: DOC_ICON[it.renderer] ?? 'doc',
            className: it.generating || writingOf(it.slug) ? 'is-updating' : undefined,
            label: (
              <span className="wu-type" data-doc-chip={it.slug}>
                {!(it.generating || writingOf(it.slug)) && failures[it.slug] && <Mark kind="failed" label="Not written" className="wu-type-failed" />}
                {it.label}
                {(it.generating || writingOf(it.slug)) && <Spinner size={10} label="Writing" className="tab-dot tab-spinner" />}
              </span>
            ),
          }))}
        />
        {ownType(slug) && types?.[slug] && <TypeActions ws={ws} slug={slug} name={types[slug].name || slug} onDeleted={() => setSlug(SLUG)} />}
        <NewDocMenu ws={ws} onMade={(t) => void made(t)} />
        <span className="wu-bar-spacer" />
        {filter && <FilterChip concept={filter.concept} name={filter.name} value={filter.value} count={filter.sets.sids.size} onClear={() => void clearFilter()} />}
        {written && !isPage && !isVideo && <HistoryMenu ws={ws} slug={slug} generation={bodyDoc?.generation} view={pastShown ? past.view : null} onView={(view, rows) => setPast(view == null ? null : { view, rows })} />}
        {written && <ExportMenu ws={ws} slug={slug} page={isPage} />}
        {isPage && load.state !== 'loading' && <Button variant="icon" icon="code" title="Code" aria-label="Code" active={drawer || load.state === 'none'} disabled={load.state === 'none'} onClick={() => setDrawer((d) => !d)} />}
        {written && <LockNote doc={bodyDoc} root={root} />}
        <WriteAction
          name={ownType(slug) ? docLabel(slug, types) : docLabel(slug, types).toLowerCase()}
          written={written}
          busy={busy}
          disabled={(load.state === 'loading' && !held) || load.state === 'error'}
          history={!isPage && !isVideo}
          onWrite={() => void write()}
        />
      </div>
      {failure && !busy && (
        <div className="wu-failed" data-failed={slug}>
          <ApiErrorCard
            line={failure.note}
            head={failedText(failure)}
            detail={failedDetail(failure)}
            retrying={WRITE_RETRY_NOTE}
            onRetry={write}
            actions={
              <>
                <ReportProblemButton {...failedReport(failure)} compact />
                <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label="Dismiss" onClick={() => dismiss(failure)} />
              </>
            }
          />
        </div>
      )}
      <div className={`wu-body${arranged ? ' wu-body-strip' : ''}`}>
        {load.state === 'loading' && !held && (
          <div className="wu-status">
            <Spinner size={14} label="Loading the document" />
          </div>
        )}
        {load.state === 'error' && (
          <div className="wu-status wu-error">
            Could not load the document
            <div className="wu-error-detail">{load.message}</div>
          </div>
        )}
        {view}
      </div>
      {arranged && (
        <div className="wu-strip glass">
          <span className="wu-strip-name">Report</span>
          <span>
            {bodyRenderer}
            {written && bodyDoc?.generation != null && ` · draft ${bodyDoc.generation}`}
          </span>
        </div>
      )}
    </div>
  )
}
