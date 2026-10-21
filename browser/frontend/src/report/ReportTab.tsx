// The Report tab: the open reports as tabs, as the File browser opens files, with + for a new report (DocMenus.tsx);
// then the open report's toolbar: its ⋯ (rename, delete), History (History.tsx), Export (ExportMenu.tsx) and Write
// (WriteAction.tsx), a field for instructions or feedback that go to Claude in the chat; while Claude writes, Stop stands
// beside Writing. Closing a tab leaves its report as it is; the tabs open are kept per workspace. A report is the
// person's from the start: the editor shows it, empty or not, so they can type notes and place cards before they ask
// for anything. The editor's module (Documents.tsx) is imported once in an
// effect rather than with React.lazy, whose Suspense retry can stall; documents are kept by slug so a switch never
// shows an empty body.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Menu } from '../components/Menu'
import { FilterChip } from '../components/FilterChip'
import { Mark } from '../components/Marks'
import { Spinner } from '../components/Spinner'
import { api, docsApi } from '../lib/api'
import { bus } from '../lib/bus'
import { parseRef } from '../lib/refs'
import { track } from '../lib/telemetry'
import { revealAnchor } from '../lib/teleport'
import type { TypesState, Writeup } from '../lib/types'
import { readStorage, writeStorage } from '../lib/workspace'
import { NewDocMenu, TypeActions } from './DocMenus'
import type { DocFilter } from './Editor'
import { DraftDiff, HistoryMenu, PastDraft } from './History'
import type { HistoryRow, HistoryView } from './historyModel'
import { ExportMenu } from './ExportMenu'
import { docKey, docLabel, labelReadDocument, reportFilterSets, SLUG } from './model'
import { StopWriter, WriteAction } from './WriteAction'
import { failureText, loadChunk } from '../lib/chunkRecovery'

type DocsModule = typeof import('./Documents')
let docsModule: DocsModule | null = null
let docsLoading: Promise<DocsModule> | null = null
/** The editor's chunk, fetched once per page. */
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
/** The line under the bar after a write that stopped before it finished. */
export const WRITE_FAILED_LINE = 'Claude stopped before it finished writing. The chat says why.'

type Load = { state: 'loading' } | { state: 'ok'; doc: Writeup } | { state: 'error'; message: string }

/** The tabs to show: the ones kept open that still exist, in their order, and the current one, which is always open.
 * Pure. */
export function openTabs(kept: readonly string[], types: TypesState | null, current: string): string[] {
  const known = (s: string) => !types || s in types
  const out = kept.filter((s, i) => known(s) && kept.indexOf(s) === i)
  if (!out.includes(current)) out.push(current)
  return out
}

/** The tab that opens when tab `closing` closes: the one after it, else the one before, else the report. Pure. */
export function nextOpen(tabs: readonly string[], closing: string): string {
  const i = tabs.indexOf(closing)
  const rest = tabs.filter((s) => s !== closing)
  return rest[Math.min(i, rest.length - 1)] ?? SLUG
}

export function ReportTab({ ws, active }: { ws: string; active: boolean }) {
  const [slug, setSlugState] = useState<string>(() => readStorage<string>(docKey(ws), SLUG) || SLUG)
  // the reports open as tabs, kept per workspace
  const openKey = `${docKey(ws)}-open`
  const [opened, setOpened] = useState<string[]>(() => readStorage<string[]>(openKey, [SLUG]))
  useEffect(() => writeStorage(openKey, opened), [openKey, opened])
  const [types, setTypes] = useState<TypesState | null>(null)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [filter, setFilter] = useState<DocFilter | null>(null)
  // a write asked for here, until the stream says it started
  const [asked, setAsked] = useState<string | null>(null)
  // a past draft, or a comparison of two, shown read-only in place of the editor (History.tsx), with the history's rows
  const [past, setPast] = useState<{ view: HistoryView; rows: HistoryRow[] } | null>(null)
  // the editor's module is fetched the first time the tab is shown, and stays mounted after
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
  // every document read or saved here, by slug, so a switch back to one shows it at once while it is read again
  const kept = useRef(new Map<string, Writeup>())

  const setSlug = useCallback(
    (next: string) => {
      setOpened((o) => (o.includes(next) ? o : [...o, next]))
      if (next === slugRef.current) return
      slugRef.current = next
      setSlugState(next)
      writeStorage(docKey(ws), next)
      const hit = kept.current.get(next)
      setLoad(hit ? { state: 'ok', doc: hit } : { state: 'loading' })
      setPast(null)
      track('ui-click', { target: `report:${next}`, detail: { action: 'switch' } })
    },
    [ws],
  )

  const readTypes = useCallback(async (): Promise<TypesState | null> => {
    try {
      const state = await docsApi.types(ws)
      setTypes(state)
      // a document shown that is gone (deleted here or in another tab) gives way to the report
      if (!(slugRef.current in state)) setSlug(SLUG)
      return state
    } catch {
      return null
    }
  }, [ws, setSlug])

  const read = useCallback(async () => {
    const s = slugRef.current
    void readTypes()
    try {
      const doc = (await docsApi.document(ws, s)) as Writeup
      kept.current.set(s, doc)
      if (slugRef.current === s) setLoad({ state: 'ok', doc })
    } catch (e) {
      if (slugRef.current === s) setLoad({ state: 'error', message: (e as Error).message })
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
      // every value's rows, so a document the label never read takes no filter from it
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
    // one read at most every REFETCH_DEBOUNCE_MS, which never waits for the events to stop: a write streaming in
    // sends one every quarter second, and the page shows it as it grows
    const later = () => {
      if (timer != null) return
      timer = window.setTimeout(() => {
        timer = null
        void read()
      }, REFETCH_DEBOUNCE_MS)
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
        if (e.status === 'generating') setAsked((a) => (a === evSlug ? null : a))
        typesLater()
        if (evSlug !== slugRef.current) {
          kept.current.delete(evSlug)
          return
        }
        if (e.status === 'edited' && e.client === CLIENT) return
        if (e.status === 'generating' || e.status === 'created' || e.status === 'renamed') return
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
  }, [read, readFilter, readTypes])

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
  const state = types?.[slug]
  const busy = asked === slug || state?.status === 'generating'
  // Claude has written in it before: the primary action reads Revise
  const written = (state?.generation ?? 0) > 0
  const failed = state?.status === 'failed' && !busy
  const name = docLabel(slug, types)
  // Write: the analyst's instructions go to Claude in the chat; the stream's `report` events carry the write from there
  const write = async (instructions: string): Promise<boolean> => {
    if (busy) return false
    const s = slug
    setAsked(s)
    track('ui-click', { target: 'ui:report-write', detail: { slug: s, instructions: !!instructions } })
    try {
      const a = await api.write(ws, s, { text: instructions })
      if (a.kind === 'busy') {
        setAsked(null)
        bus.emit('toast', { text: `Not sent: ${a.reason ?? 'Claude is busy'}. Try again once it has answered.`, kind: 'error' })
        return false
      }
      return true
    } catch (e) {
      setAsked(null)
      bus.emit('toast', { text: `Could not ask for the ${name.toLowerCase()}. ${(e as Error).message}`, kind: 'error' })
      return false
    }
  }
  const made = async (t: { slug: string }) => {
    await readTypes()
    setSlug(t.slug)
  }
  const onSaved = useMemo(
    () => (saved: Writeup) => {
      kept.current.set(slug, saved)
      if (slugRef.current === slug) setLoad({ state: 'ok', doc: saved })
    },
    [slug],
  )
  const closePast = useCallback(() => setPast(null), [])
  const onRestored = useCallback(
    (saved: Writeup) => {
      onSaved(saved)
      setPast(null)
    },
    [onSaved],
  )
  const view = past ? (
    past.view.kind === 'diff' ? (
      <DraftDiff ws={ws} slug={slug} from={past.view.from} to={past.view.to} rows={past.rows} onClose={closePast} />
    ) : (
      <PastDraft ws={ws} slug={slug} target={past.view.target} rows={past.rows} onClose={closePast} onRestored={(d) => onRestored(d as Writeup)} />
    )
  ) : shown && doc ? (
    views ? (
      <views.DocumentView ws={ws} slug={slug} doc={doc} filter={filter} client={CLIENT} onSaved={onSaved} />
    ) : viewsError ? (
      <div className="wu-status wu-error">
        Could not load the editor
        <div className="wu-error-detail">{viewsError}</div>
      </div>
    ) : (
      <div className="wu-status">
        <Spinner size={14} label="Loading the editor" />
      </div>
    )
  ) : null
  const tabs = openTabs(opened, types, slug)
  const close = (s: string) => {
    track('ui-click', { target: `report:${s}`, detail: { action: 'tab-close' } })
    const next = nextOpen(tabs, s)
    setOpened(tabs.filter((t) => t !== s).length ? tabs.filter((t) => t !== s) : [SLUG])
    if (s === slug) setSlug(next)
  }
  return (
    <div className="wu-root" ref={root} data-panel="report" data-doc={slug} data-renderer="document">
      <div className="wu-tabs-bar">
        <span className="reader-tabs" role="tablist" aria-label="Open reports">
          {tabs.map((s) => {
            const writing = asked === s || types?.[s]?.status === 'generating'
            return (
              <span key={s} className={'reader-tab' + (s === slug ? ' active' : '')} data-doc-chip={s}>
                <button type="button" role="tab" aria-selected={s === slug} className="reader-tab-pick" onClick={() => setSlug(s)}>
                  {!writing && types?.[s]?.status === 'failed' ? <Mark kind="failed" label="Not finished" className="reader-tab-glyph" /> : <Icon name="doc" size={13} className="reader-tab-glyph" />}
                  <span className="reader-tab-name">{docLabel(s, types)}</span>
                </button>
                {tabs.length > 1 && (
                  <button type="button" className="reader-tab-x" aria-label={`Close ${docLabel(s, types)}`} title="Close the tab; the report stays" onClick={() => close(s)}>
                    <Icon name="x" size={11} />
                  </button>
                )}
              </span>
            )
          })}
        </span>
        <NewDocMenu ws={ws} onMade={(t) => void made(t)} />
        <span className="wu-bar-spacer" />
        <ClosedReports types={types} open={tabs} onOpen={setSlug} />
      </div>
      <div className="wu-bar">
        {slug !== SLUG && state && <TypeActions ws={ws} slug={slug} name={name} onDeleted={() => close(slug)} />}
        {filter && <FilterChip concept={filter.concept} name={filter.name} value={filter.value} count={filter.sets.sids.size} onClear={() => void clearFilter()} />}
        <span className="wu-bar-spacer" />
        {written && <HistoryMenu ws={ws} slug={slug} generation={doc?.generation} view={past ? past.view : null} onView={(v, rows) => setPast(v == null ? null : { view: v, rows })} />}
        {doc && (doc.sections ?? []).length > 0 && <ExportMenu ws={ws} slug={slug} />}
        {busy && <StopWriter ws={ws} />}
        <WriteAction name={name} written={written} busy={busy} disabled={load.state !== 'ok'} onWrite={write} />
      </div>
      {failed && (
        <p className="wu-failed-line" role="status" data-failed={slug}>
          {WRITE_FAILED_LINE}
        </p>
      )}
      <div className="wu-body">
        {load.state === 'loading' && (
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
    </div>
  )
}

/** The reports whose tabs are closed, in a menu at the tab strip's end, so a closed report opens again. */
function ClosedReports({ types, open, onOpen }: { types: TypesState | null; open: readonly string[]; onOpen: (slug: string) => void }) {
  const closed = Object.keys(types ?? {}).filter((s) => !open.includes(s))
  if (!closed.length) return null
  return (
    <Menu
      label="Closed reports"
      align="end"
      items={closed.map((s) => ({ id: s, label: docLabel(s, types), icon: 'doc' as const, onSelect: () => onOpen(s) }))}
      trigger={<Button size="sm" className="reader-tabs-more">{`${closed.length} closed`}</Button>}
    />
  )
}
