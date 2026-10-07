// The File browser's reader: a file in the built-in view that fits it best (views/registry.ts), with the others in the
// mode switch; the pick is remembered per file. Records load a page at a time around the ref's line and as the reader
// scrolls, up to CAP in memory, with the overview ruler beside them (Ruler.tsx). ⌘F opens the find bar (FindBar.tsx);
// media files show as themselves (MediaReader), a PDF in the browser's own viewer beside the viewers made for PDFs
// (PdfReader), and other binary files show only their size.
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Button, Segmented } from '../components/Button'
import { Spinner } from '../components/Spinner'
import { api, scaleApi } from '../lib/api'
import { bus } from '../lib/bus'
import { mediaOf, mediaUrl, type MediaRef } from '../lib/media'
import { refreshProposals } from '../lib/proposals'
import { fragmentIn, nearestLine, parseRef } from '../lib/refs'
import { track } from '../lib/telemetry'
import type { Concept, LabelsForPath, Proposal, SourceKind, SourcePage, SourceRecord, TranscriptHint, View } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { failureText, ReportProblemButton } from '../shell/ProblemReport'
import { clearMatches, firstMatchFrom, lineAsked, markMatches, markSpots, matchCount, matchNumber, stepInLine, stepMatch, unfoldAt, type MatchAt } from './find'
import { countsOf, FindBar, useSourceFind } from './FindBar'
import { classesOf, colourVar, laneTags, litClass, marksOf, valueOf } from './labels'
import { useScrollAnchor } from './anchor'
import { ReaderLabelsContext, useReaderLabels } from './marks'
import { findColumn, rulerColumns, useRuler, type RulerTick, type Seen, type Shown } from './Ruler'
import { ColorBy } from './ColorBy'
import { keyColor, KEY_COLORS, keyValue, OTHER, recordObject } from './colorChoice'
import { ColorContext } from './colorContext'
import { labelPaint, PlaceFeed, ReaderTracks, ZOOM_SPAN, type DrawnRecord, type OverviewPaint, type PreviewRecord, type TrackLane } from './Tracks'
import { useColorBy } from './useColorBy'
import { fmtSize } from './Tree'
import { useFilesFilter, type FilesLabels } from './useLabels'
import { accepts, slugOf, viewValue } from './viewChoice'
import { fileLineShows, ResidueList, useLabelsOfFile, useResidueOpen, useViewNotes, ViewFilter, ViewHeadLine } from './ViewChrome'
import { ViewerFrame } from './ViewerFrame'
import { usePinnedView, ViewUpdated } from './viewVersion'
import { DeleteViewConfirm, ProposalOption } from './ViewsBar'
import { useTypeViewers } from './typeViewers'
import { compact, errMsg, LaneHead, recordExcerpt, targetOf, type ViewDef, type ViewProps } from './views/common'
import { messageKeys, nameOf, pick, textOf, timeOf } from './views/transcript'
import { withoutEscapes } from './views/raw'
import { pickView, scoreViews, viewByType } from './views/registry'

const PAGE = 100
const CAP = 2000
const SAMPLE = 20
/** px from either end of the records at which the next page loads */
const LOAD_AHEAD_PX = 400
/** the records a drag of the frame shows before and after its line while the frame is held */
const DRAG_BEFORE = 5
const DRAG_AFTER = 30
/** a held drag of the frame reads ahead when it has not read this many lines past its place in its direction: a read
 * takes AHEAD_READ lines that way and AHEAD_BEHIND the other (the server gives at most 250 a side), and the drag keeps
 * AHEAD_MAX of them */
const AHEAD_NEAR = 120
const AHEAD_READ = 240
const AHEAD_BEHIND = 40
const AHEAD_MAX = 3000
/** the records of a patch's first lines a click on the overview reads for the first in the patch's value, at most */
const SNAP_LINES = 250
/** ms between the records a held drag of the frame shows from what it read ahead: every other frame at least, and at
 * most DRAG_SHOW_MAX_MS twice over where drawing them takes longer than a frame */
const DRAG_SHOW_MS = 30
const DRAG_SHOW_MAX_MS = 60
/** ms between asks for the line count while the server's is an estimate (a big file whose line index is being built) */
const LINES_POLL_MS = 1000
/** the order of the built-in views in the mode switch */
const ORDER = ['transcript', 'text', 'raw', 'table', 'forge']
const BINARY_REASON = 'A binary file, with no text to show here.'
const NO_MATCH: MatchAt = { i: -1, k: 0 }
const NO_SPOTS: ReadonlyMap<number, number[]> = new Map()
/** the built-in views whose records carry the label gutter (views/common.tsx RecordCard and LineRow) */
const GUTTERED = new Set(['transcript', 'text', 'raw'])

/** A line count as the reader says it: nothing while it is an estimate (a big file whose line index is being built). */
export function linesText(total: number, estimated: boolean): string {
  return estimated ? '' : total.toLocaleString()
}

/** What the reader says of a binary file whose size the server gave. */
export function binaryReason(size: number | null): string {
  return size == null ? BINARY_REASON : `A binary file of ${fmtSize(size)} (${size.toLocaleString()} bytes), with no text to show here.`
}

/** What asks for the find bar: the mode and a count that bumps on each ask (FilesTab's shortcuts). */
export interface FindAsk {
  mode: 'find' | 'line'
  n: number
}

export interface ReaderProps {
  workspace: string
  path: string
  kind: SourceKind
  targetRef?: string
  /** what leads the bar: the open files as tabs */
  lead?: ReactNode
  /** at the bar's end, before the modes: the Open in menu */
  end?: ReactNode
  labels: FilesLabels
  /** show this built-in view alone, with no mode switch (a view's Raw) */
  only?: string
  /** the view shown changed: its title, for the pane's status */
  onMode?: (title: string) => void
  /** open the find bar (⌘F) or go to a line (Ctrl+G) */
  findAsk?: FindAsk
}

/** Whether the sampled records read as binary rather than text: a NUL, or more than 2% of control or replacement
 * characters once a terminal's escape sequences are left out (a tmux log is text). */
export function looksBinary(sample: any[]): boolean {
  let total = 0
  let bad = 0
  for (const r of sample) {
    const raw = typeof r === 'string' ? r : r && typeof r === 'object' && typeof r.text === 'string' ? r.text : ''
    if (raw.includes('\0')) return true
    const text = withoutEscapes(raw)
    if (!text) continue
    for (const ch of text) {
      total++
      const c = ch.charCodeAt(0)
      if (c === 0) return true
      if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++
    }
  }
  return total > 0 && bad / total > 0.02
}

class ViewBoundary extends Component<{ viewType: string; onFallback: () => void; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`view ${this.props.viewType} failed`, error, info.componentStack)
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return <ViewFailed name={viewByType(this.props.viewType)?.title ?? this.props.viewType} detail={error.message || String(error)} onRaw={this.props.viewType !== 'raw' ? this.props.onFallback : undefined} />
  }
}

/** A view that could not show the file: what failed, Raw, and Report a problem with the error written in. */
export function ViewFailed({ name, detail, onRaw }: { name: string; detail: string; onRaw?: () => void }) {
  return (
    <div className="reader-fail">
      <div className="reader-error-text">
        Could not show the {name} view
        <div className="reader-error-detail">{detail}</div>
      </div>
      {onRaw && (
        <Button size="sm" icon="text" onClick={onRaw}>
          Raw
        </Button>
      )}
      <ReportProblemButton description={failureText(`The ${name} view could not show a file.`, detail)} />
    </div>
  )
}

/** A viewer for the file's type as its mode: the view's page in the reader, and what failed with Raw beside it when the
 * file has a Raw. It keeps the version it opened at, with Updated and Reload over its top right corner once a newer one
 * is there. Above the page, thimble's notes on the file it shows (ViewChrome), when there are any: what the viewer
 * leaves out of that file, never of the other files it claims, and what it derived; then the label filter with how many
 * records it hides. A line picked there opens in the File browser. */
function ReaderViewer({ ws, view, path, targetRef, labels, onRaw }: { ws: string; view: View; path: string; targetRef?: string; labels: FilesLabels; onRaw?: () => void }) {
  const [failure, setFailure] = useState<string | null>(null)
  const filter = useFilesFilter(ws)
  const pin = usePinnedView(ws, view.slug, view.version || undefined)
  const notes = useViewNotes(ws, view.slug, pin.pinned || undefined, path)
  const shownLabels = useLabelsOfFile(labels, path)
  const [residueOpen, toggleResidue] = useResidueOpen(ws, view.slug)
  const filterLabel = filter ? labels.byId.get(filter.concept) : undefined
  const [hidden, setHidden] = useState<number | null>(null)
  useEffect(() => setHidden(null), [pin.pinned])
  const noted = fileLineShows(notes, shownLabels)
  const pick = (ref: string) => bus.emit('openRef', { ref, browser: true })
  return (
    <div className="reader-main reader-viewer">
      {(noted || (filter && filterLabel)) && (
        <div className="reader-viewer-notes">
          {noted && <ViewHeadLine ws={ws} name={view.name} notes={notes} shownLabels={shownLabels} residueOpen={residueOpen} onResidue={toggleResidue} file />}
          {filter && filterLabel && <ViewFilter ws={ws} filter={filter} name={filterLabel.name} hidden={hidden} className="reader-viewer-filter" />}
        </div>
      )}
      {residueOpen && <ResidueList notes={notes} onPick={pick} />}
      {failure && <ViewFailed name={view.name} detail={failure} onRaw={onRaw} />}
      {pin.stale && <ViewUpdated onReload={() => (setFailure(null), void pin.reload())} className="reader-viewer-updated" />}
      <ViewerFrame
        key={`${view.slug}:${pin.pinned ?? ''}`}
        version={pin.pinned || undefined}
        restore={pin.restore}
        handle={pin.frame}
        ws={ws}
        slug={view.slug}
        targetRef={targetRef}
        path={path}
        title={view.name}
        labels={labels.on}
        filter={filter}
        filterFiles={filter ? labels.presence.get(filter.concept) : undefined}
        byId={labels.byId}
        onHidden={setHidden}
        onError={setFailure}
      />
    </div>
  )
}

/** A memo, so that a render of the pane around it with the same props (a drag of the sidebar's width) leaves the
 * records alone. */
export const Reader = memo(function Reader(props: ReaderProps) {
  if (props.kind === 'dir') {
    return (
      <div className="reader">
        <div className="reader-bar">{props.lead}</div>
      </div>
    )
  }
  const media = mediaOf(props.path)
  if (media) return <MediaReader key={`${props.workspace}|${props.path}`} {...props} media={media} />
  if (isPdf(props.path)) return <PdfReader key={`${props.workspace}|${props.path}`} {...props} />
  return <FileReader key={`${props.workspace}|${props.path}|${props.kind}`} {...props} />
})

export const isPdf = (path: string): boolean => /\.pdf$/i.test(path)

/** The page a PDF ref names, counting from 1: `#p4`, the first of `#p4-p6`, `#page=4`; null for none. Pure. */
export function pdfPage(ref: string | undefined, path: string): number | null {
  const fragment = fragmentIn(ref, path)
  const m = fragment ? /^(?:p|page=?)(\d+)(?:-p?\d+)?$/i.exec(fragment.trim()) : null
  const n = m ? Number(m[1]) : 0
  return n >= 1 ? n : null
}

/** Whether the browser draws a PDF in the page; one that would only download it says so (navigator.pdfViewerEnabled). */
export const pdfInPage = (): boolean => typeof navigator === 'undefined' || (navigator as { pdfViewerEnabled?: boolean }).pdfViewerEnabled !== false

/** The labels over files that are on and mark this file, each with the name of the value it has. */
function useFileLabels(labels: FilesLabels, path: string): { id: string; name: string; colour: string }[] {
  return useMemo(
    () =>
      labels.on
        .filter((k) => marksOf(k) === 'file')
        .flatMap((k) => {
          const values = labels.presence.get(k.id)?.[path] ?? {}
          const classes = classesOf(k)
          const c = classes.find((x) => x.highlight && (values[x.name] ?? 0) > 0)
          return c ? [{ id: k.id, name: classes.length > 2 ? `${k.name} · ${c.name}` : k.name, colour: colourVar(c.color) }] : []
        }),
    [labels.on, labels.presence, path],
  )
}

function FileLabels({ items }: { items: { id: string; name: string; colour: string }[] }) {
  if (!items.length) return null
  return (
    <div className="reader-filelabels">
      {items.map((f) => (
        <span key={f.id} className="reader-filelabel" style={{ '--c': f.colour } as CSSProperties} data-anchor={`concept:${f.id}`} data-anchor-text={f.name}>
          <span className="reader-filelabel-bar" />
          {f.name}
        </span>
      ))}
    </div>
  )
}

export interface PageMarks {
  key: string
  name: string
  colour: string
  pages: number[]
}

/** The pages of a PDF that each label over records that is on marks with a highlighted value, one entry per label and
 * value (the value's name after the label's when it has more than two), asked again when the labels on or their runs
 * change. */
function usePdfPageLabels(ws: string, labels: FilesLabels, path: string): PageMarks[] {
  const [rows, setRows] = useState<LabelsForPath[]>([])
  const onKey = labels.on.map((k) => k.id).join(',')
  useEffect(() => {
    if (!onKey) {
      setRows([])
      return
    }
    let alive = true
    api
      .labelsForPath(ws, path)
      .then((r) => alive && setRows(r))
      .catch(() => alive && setRows([]))
    return () => {
      alive = false
    }
  }, [ws, path, onKey, labels.presence])
  return useMemo(() => pdfPageMarks(labels.on, rows, path), [labels.on, rows, path])
}

/** Per label over records that is on and value it highlights, the pages of the PDF at `path` its rows mark. Pure. */
export function pdfPageMarks(on: FilesLabels['on'], rows: LabelsForPath[], path: string): PageMarks[] {
  return on
    .filter((k) => marksOf(k) !== 'file')
    .flatMap((k) => {
      const got = rows.find((r) => r.concept_id === k.id)
      const classes = classesOf(k)
      return classes
        .filter((c) => c.highlight)
        .map((c) => ({
          key: `${k.id}:${c.name}`,
          name: classes.length > 2 ? `${k.name} · ${c.name}` : k.name,
          colour: colourVar(c.color),
          pages: [...new Set((got?.rows ?? []).filter((r) => valueOf(r) === c.name).map((r) => pdfPage(r.ref, path)).filter((n): n is number => n != null))].sort((a, b) => a - b),
        }))
        .filter((m) => m.pages.length)
    })
}

/** The labels on a PDF's pages, which the browser's own viewer cannot draw: each label with its colour and the pages it
 * marks, a click on one opening the PDF there. */
function PdfPageLabels({ items, page, onPage, path }: { items: PageMarks[]; page: number | null; onPage: (n: number) => void; path: string }) {
  if (!items.length) return null
  return (
    <div className="reader-filelabels reader-pagelabels">
      {items.map((m) => (
        <span key={m.key} className="reader-filelabel reader-pagelabel" style={{ '--c': m.colour } as CSSProperties}>
          <span className="reader-filelabel-bar" />
          <span className="reader-pagelabel-name">{m.name}</span>
          {m.pages.map((n) => (
            <button key={n} type="button" className="reader-pagelabel-page" aria-current={n === page ? 'page' : undefined} data-anchor={`${path}#p${n}`} onClick={() => onPage(n)}>
              p. {n}
            </button>
          ))}
        </span>
      ))}
    </div>
  )
}

/** Where the File browser keeps the mode picked for a file: a built-in view's type, or `v:<slug>` for a file viewer. */
export const pickKey = (workspace: string, path: string): string => storageKey(workspace, `viewOf:${path}`)

/** A proposed view for the file's type, offered beside the modes until the analyst dismisses it. */
function useOffered(ws: string, proposal: Proposal | null, on: boolean): { offered: Proposal | null; dismiss: (p: Proposal) => void } {
  const [dismissed, setDismissed] = useState<string | null>(null)
  const offered = on && proposal && proposal.slug !== dismissed ? proposal : null
  const dismiss = (p: Proposal) => {
    track('view-dismiss', { target: `view:${p.slug}` })
    setDismissed(p.slug)
    api
      .deleteProposal(ws, p.slug)
      .then(() => refreshProposals(ws))
      .catch((e: Error) => {
        setDismissed(null)
        bus.emit('toast', { text: `Could not remove ${p.name}. ${e.message}`, kind: 'error' })
      })
  }
  return { offered, dismiss }
}

/** The × a file viewer built for the workspace shows on hover in a file's modes, which deletes it once confirmed, as
 * the views bar's × does a corpus view: `removable` gives a viewer's option its ×, `confirmDelete` goes beside the
 * modes. */
function useViewerDelete(ws: string, pickedSlug: string | null, forgetPick: () => void) {
  const [removing, setRemoving] = useState<{ slug: string; name: string; at: HTMLElement } | null>(null)
  const remove = async ({ slug, name }: { slug: string; name: string }) => {
    setRemoving(null)
    track('view-dismiss', { target: `view:${slug}` })
    if (pickedSlug === slug) forgetPick()
    try {
      await api.deleteView(ws, slug)
      await refreshProposals(ws)
    } catch (e) {
      bus.emit('toast', { text: `Could not delete ${name}. ${(e as Error).message}`, kind: 'error' })
    }
  }
  const removable = (v: View) => (v.origin === 'builtin' ? {} : { removeLabel: `Delete ${v.name}`, onRemove: (at: HTMLElement) => setRemoving({ slug: v.slug, name: v.name, at }) })
  const confirmDelete = <DeleteViewConfirm asked={removing} onClose={() => setRemoving(null)} onDelete={() => removing && void remove(removing)} />
  return { removable, confirmDelete }
}

/** A PDF of the corpus as itself, in the browser's own viewer, opened at the page a ref names. The viewers made for
 * PDFs stand beside it in the mode switch, and the pick is remembered per file; a ref whose fragment is no page opens in
 * the first viewer that reads it. The frame is drawn anew for each page asked for, since a viewer reads the page only
 * when it opens the file. A browser that would only download it gets a line saying so and a link to the file in place
 * of the frame. */
function PdfReader({ workspace, path, targetRef, lead, end, labels, only, onMode }: ReaderProps) {
  const asked = pdfPage(targetRef, path)
  // a page picked from the labels' pages, until another ref is asked for
  const [picked, setPicked] = useState<{ n: number; ref: string | undefined } | null>(null)
  const page = picked && picked.ref === targetRef ? picked.n : asked
  const src = api.pdfUrl(workspace, path, page)
  const inPage = pdfInPage()
  const memoryKey = pickKey(workspace, path)
  const [pick, setPick] = useState<string | null>(() => readStorage<string | null>(memoryKey, null))
  useEffect(() => bus.on('fileMode', (e) => e.path === path && setPick(e.mode)), [path])
  const fragment = fragmentIn(targetRef, path)
  const types = useTypeViewers(workspace, path, !only, true)
  const autoViewer = fragment != null && page == null ? types.viewers.find((v) => accepts(v, fragment)) : undefined
  const pickedSlug = slugOf(pick)
  const viewer = only ? undefined : pickedSlug ? (types.viewers.find((v) => v.slug === pickedSlug) ?? autoViewer) : pick ? undefined : autoViewer
  const modeTitle = viewer?.name ?? 'PDF'
  useEffect(() => {
    onMode?.(modeTitle)
  }, [modeTitle, onMode])
  const onPick = (v: string) => {
    track('view-open', { target: path, detail: { from: 'switcher', to: v } })
    setPick(v)
    writeStorage(memoryKey, v)
  }
  const forgetPick = () => {
    setPick(null)
    writeStorage(memoryKey, null)
  }
  const fileLabels = useFileLabels(labels, path)
  const pageLabels = usePdfPageLabels(workspace, labels, path)
  const { removable, confirmDelete } = useViewerDelete(workspace, pickedSlug, forgetPick)
  const { offered, dismiss } = useOffered(workspace, types.proposal, !only && !viewer)
  const options = [{ value: PDF_MODE, label: 'PDF' }, ...(only ? [] : types.viewers.map((v) => ({ value: viewValue(v.slug), label: v.name, ...removable(v) })))]
  return (
    <div className="reader">
      {lead !== undefined && (
        <div className="reader-bar">
          {lead}
          <span className="reader-spacer" />
          {end}
          {(options.length > 1 || offered) && (
            <span className="reader-modes">
              <Segmented label="Mode" size="md" value={viewer ? viewValue(viewer.slug) : PDF_MODE} onChange={onPick} options={options} />
              {offered && <ProposalOption ws={workspace} p={offered} size="md" onDismiss={() => dismiss(offered)} onAccept={forgetPick} />}
              {confirmDelete}
            </span>
          )}
        </div>
      )}
      <FileLabels items={fileLabels} />
      {!viewer && <PdfPageLabels items={pageLabels} page={page} path={path} onPage={(n) => setPicked({ n, ref: targetRef })} />}
      {viewer ? (
        <ReaderViewer key={viewer.slug} ws={workspace} view={viewer} path={path} targetRef={fragment != null && accepts(viewer, fragment) ? targetRef : undefined} labels={labels} />
      ) : inPage ? (
        <div className="reader-pdf" data-body="">
          <iframe key={src} src={src} title={path} className="reader-pdf-frame" allowFullScreen />
        </div>
      ) : (
        <div className="reader-noview">
          <div className="reader-noview-reason dim">This browser does not show PDFs in a page.</div>
          <Button size="sm" onClick={() => window.open(src, '_blank', 'noopener')}>
            Open the PDF
          </Button>
        </div>
      )}
    </div>
  )
}

/** the mode switch's value for a PDF in the browser's own viewer */
const PDF_MODE = 'pdf'

/** An image, a recording or a video of the corpus, shown as itself from the media route (lib/media), which answers
 * range requests, so a video plays and seeks without loading whole; a ref with a moment (`#t=30:55`) starts it there. */
function MediaReader({ workspace, path, targetRef, lead, media }: ReaderProps & { media: MediaRef }) {
  const at = targetRef ? mediaOf(targetRef) : null
  const src = mediaUrl(workspace, at && at.path === path ? at : media)
  return (
    <div className="reader">
      {lead !== undefined && <div className="reader-bar">{lead}</div>}
      <div className="reader-media" data-body="">
        {media.kind === 'image' ? (
          <img src={src} alt={path} />
        ) : media.kind === 'audio' ? (
          <audio src={src} controls preload="metadata" aria-label={path} />
        ) : (
          <video src={src} controls preload="metadata" aria-label={path} />
        )}
      </div>
    </div>
  )
}

interface Builtins {
  /** the built-in views the switcher lists for this file */
  listed: ViewDef[]
  /** the one that fits best */
  auto: ViewDef
  loaded: boolean
  /** the server's sniff, when the file reads as a transcript */
  transcript: TranscriptHint | null
  /** the first records read as binary (looksBinary), or the server said the file is binary: no text to show */
  binary: boolean
  /** the file's size when the server said it is binary */
  binarySize: number | null
  /** the Transcript mode found no turns to show: it is dropped for the mode the file would otherwise open in */
  dropTranscript: () => void
}

/** The built-in views scored over the file's first records (views/registry.ts). */
function useBuiltins(ws: string, path: string, kind: SourceKind): Builtins {
  const isDatabase = kind === 'forge'
  const [sample, setSample] = useState<any[] | null>(isDatabase ? [] : null)
  const [binarySize, setBinarySize] = useState<number | null>(null)
  const [hint, setHint] = useState<TranscriptHint | null>(null)
  // the file whose turns the server's whole parse did not find, though the sniff of its head promised them
  const [noTurns, setNoTurns] = useState<string | null>(null)
  const transcript = noTurns === path ? null : hint
  const dropTranscript = useCallback(() => setNoTurns(path), [path])
  useEffect(() => {
    if (isDatabase) return
    let alive = true
    api
      .source(ws, path, 1, SAMPLE)
      .then((page) => {
        if (!alive) return
        if (page.binary) setBinarySize(page.size_bytes ?? 0)
        setHint(page.transcript ?? null)
        setSample(page.records.map((r) => r.record))
      })
      .catch(() => alive && setSample([]))
    return () => {
      alive = false
    }
  }, [ws, path, isDatabase])
  return useMemo(() => {
    const scored = scoreViews(path, kind, sample ?? [], transcript)
    const scoreOf = (t: string) => scored.find((s) => s.def.type === t)?.score ?? 0
    const binary = !isDatabase && (binarySize != null || looksBinary(sample ?? []))
    const listed = (isDatabase ? scored.filter((s) => s.score >= 0.5).map((s) => s.def) : scored.map((s) => s.def).filter((v) => v.type !== 'forge' && (v.type === 'raw' || scoreOf(v.type) > 0)))
      // a file that reads as binary lists Raw alone, and the reader says it is binary in place of its bytes
      .filter((v) => !binary || v.type === 'raw' || isDatabase)
      .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
    return { listed, auto: pickView(scored), loaded: sample != null, transcript, binary, binarySize, dropTranscript }
  }, [path, kind, sample, isDatabase, binarySize, transcript, dropTranscript])
}

/** The line of the first record the reader shows at its top, or null when it shows none. */
function topLine(body: HTMLElement | null): number | null {
  if (!body) return null
  const top = body.getBoundingClientRect().top
  for (const el of Array.from(body.querySelectorAll<HTMLElement>('.reader-card[data-line]'))) {
    if (el.getBoundingClientRect().bottom > top + 1) return Number(el.dataset.line)
  }
  return null
}

/** What the reader's body shows of a file of `total` lines, read from its records: each record stands for its line and
 * the lines after it up to the next record shown (the records a view hides, such as a transcript's system records), so
 * the view's place in the file follows the records on screen whatever their heights. Null when the body shows no
 * records (a view that draws the file whole). */
export function shownIn(body: HTMLElement, total: number): Shown | null {
  const cards = body.querySelectorAll<HTMLElement>('.reader-card[data-line]')
  const h = body.clientHeight
  if (!cards.length || total <= 0 || h <= 0) return null
  const top = body.getBoundingClientRect().top
  const bottom = top + h
  const unit = (x: number) => Math.max(0, Math.min(1, x))
  const lineOf = (i: number) => Number(cards[i].dataset.line)
  const span = (i: number) => (i + 1 < cards.length ? Math.max(1, lineOf(i + 1) - lineOf(i)) : 1)
  // the first record whose bottom is below the reader's top, by halving: the records stand in the order of their lines
  let lo = 0
  let hi = cards.length - 1
  let from = cards.length
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cards[mid].getBoundingClientRect().bottom > top) {
      from = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  const seen: Seen[] = []
  let a: number | null = null
  let b = 0
  for (let i = from; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect()
    if (r.top >= bottom) break
    seen.push({ line: lineOf(i), top: (r.top - top) / h, bottom: (r.bottom - top) / h })
    const rh = Math.max(1, r.height)
    if (a == null) a = lineOf(i) - 1 + unit((top - r.top) / rh) * span(i)
    b = lineOf(i) - 1 + unit((bottom - r.top) / rh) * span(i)
  }
  if (a == null) return null
  return { top: a / total, height: Math.max(0, b - a) / total, seen }
}

/** The scrollTop at which `a` lines of the file lie above the reader's top: shownIn's model read backwards, from the
 * last record drawn at or before line ⌊a⌋ + 1 and the part of its span `a` reaches into. Before the first record drawn
 * or past the last (a table draws only the rows near its view), the records drawn stand in for the rest at their mean
 * height per line. Null when the body draws no records. */
export function scrollTopFor(body: HTMLElement, a: number): number | null {
  const cards = body.querySelectorAll<HTMLElement>('.reader-card[data-line]')
  const n = cards.length
  if (!n) return null
  const lineOf = (i: number) => Number(cards[i].dataset.line)
  const base = body.getBoundingClientRect().top - body.scrollTop
  let lo = 0
  let hi = n - 1
  let at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lineOf(mid) - 1 <= a) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const first = cards[0].getBoundingClientRect()
  const last = cards[n - 1].getBoundingClientRect()
  const perLine = (last.bottom - first.top) / Math.max(1, lineOf(n - 1) - lineOf(0) + 1)
  if (at < 0) return Math.max(0, first.top - base - (lineOf(0) - 1 - a) * perLine)
  const r = at === n - 1 ? last : cards[at].getBoundingClientRect()
  const span = at + 1 < n ? Math.max(1, lineOf(at + 1) - lineOf(at)) : 1
  const into = a - (lineOf(at) - 1)
  return into <= span ? r.top - base + (into / span) * r.height : r.bottom - base + (into - span) * perLine
}

/** The lines a record of another reader spans in its file of text (a JSON document's value, a CSV row), as the server
 * resolves its ref, so the reader opens it there: `at` null until the answer comes, and for any other ref; `pending`
 * while the answer is awaited. */
export function useRecordLines(ws: string, ref: string | undefined, path: string): { at: { line: number; endLine: number } | null; pending: boolean } {
  const p = ref ? parseRef(ref) : null
  const asks = !!ref && !!p && (p.kind === 'pointer' || p.kind === 'csvrow') && p.path === path
  const [got, setGot] = useState<{ ref: string; at: { line: number; endLine: number } | null } | null>(null)
  useEffect(() => {
    if (!asks || !ref) return
    let alive = true
    api
      .resolveRef(ws, ref)
      .then((r) => {
        const meta = (r.meta ?? {}) as { line?: unknown; end_line?: unknown }
        if (!alive) return
        const line = typeof meta.line === 'number' ? meta.line : null
        setGot({ ref, at: line == null ? null : { line, endLine: typeof meta.end_line === 'number' ? meta.end_line : line } })
      })
      .catch(() => alive && setGot({ ref, at: null }))
    return () => {
      alive = false
    }
  }, [ws, ref, asks])
  const mine = asks && got?.ref === ref ? got : null
  return { at: mine?.at ?? null, pending: asks && !mine }
}

/** records the zoomed track draws at most */
const ZOOM_RECORDS = 400

/** The records the body draws for the zoomed track around its scroll: those within three ZOOM_SPAN heights of the body
 * that hold every stretch the zoomed track can show at this scroll, on a grid of those heights so that they change only
 * as the reader scrolls past a step of it, and at most ZOOM_RECORDS, those nearest the view. Null when the body draws
 * none. */
export function zoomRecordsOf(body: HTMLElement): DrawnRecord[] | null {
  const cards = body.querySelectorAll<HTMLElement>('.reader-card[data-line]')
  if (!cards.length) return null
  const st = body.scrollTop
  const unit = Math.max(1, body.clientHeight * ZOOM_SPAN)
  const from = (Math.floor(st / unit) - 1) * unit
  const to = from + 3 * unit
  const base = body.getBoundingClientRect().top - st
  const firstBelow = (y: number) => {
    let lo = 0
    let hi = cards.length - 1
    let at = cards.length
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (cards[mid].getBoundingClientRect().bottom - base > y) {
        at = mid
        hi = mid - 1
      } else lo = mid + 1
    }
    return at
  }
  // past ZOOM_RECORDS, those from half of them above the view on
  const first = Math.max(firstBelow(from), firstBelow(st) - ZOOM_RECORDS / 2)
  const recs: DrawnRecord[] = []
  for (let i = first; i < cards.length && recs.length < ZOOM_RECORDS; i++) {
    const r = cards[i].getBoundingClientRect()
    const top = r.top - base
    if (top >= to) break
    recs.push({ line: Number(cards[i].dataset.line), top, bottom: r.bottom - base })
  }
  return recs
}

/** A record as the overview's hover shows it: its index, who and when (the sniff's keys, else those the record
 * carries), and its first two lines of words. */
export function previewOf(rec: SourceRecord, hint: TranscriptHint | null, color: string | null): PreviewRecord {
  const first = (s: string) =>
    s
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 2)
      .join('\n')
      .slice(0, 280)
  const obj = recordObject(rec)
  if (!obj) return { line: rec.line, who: null, when: null, text: first(recordExcerpt(rec)), color }
  const keys = hint?.keys ? { author: hint.keys.speaker, time: hint.keys.time, body: hint.keys.text } : messageKeys([obj])
  const who = nameOf(pick(obj, keys.author)) ?? (typeof obj.type === 'string' ? obj.type : null)
  const when = timeOf(pick(obj, keys.time))
  const body = textOf(pick(obj, keys.body)) ?? rec.blocks.find((b) => b.kind !== 'raw')?.text ?? compact(obj, 300)
  return { line: rec.line, who, when, text: first(body), color }
}

const NO_LANES: Concept[] = []
const NO_OFF: ReadonlySet<string> = new Set()


function FileReader({ workspace, path, kind, targetRef, lead, end, labels, only, onMode, findAsk }: ReaderProps) {
  const isDatabase = kind === 'forge'
  const builtins = useBuiltins(workspace, path, kind)
  const memoryKey = pickKey(workspace, path)
  const [pick, setPick] = useState<string | null>(() => readStorage<string | null>(memoryKey, null))
  useEffect(() => bus.on('fileMode', (e) => e.path === path && setPick(e.mode)), [path])
  const fragment = fragmentIn(targetRef, path)
  const picked = viewByType(only ?? pick)
  const view: ViewDef | undefined = picked && (only || builtins.listed.includes(picked)) ? picked : builtins.auto
  // the Transcript mode colors its records by Color by and marks the labels on the tracks, with no gutter of lanes
  const isTranscript = view?.type === 'transcript'
  const [records, setRecords] = useState<SourceRecord[]>([])
  const [total, setTotal] = useState<number | null>(null)
  // the server estimated `total` (a big file whose line index is being built): it is asked for again until it is exact,
  // and once it is, a page answered with the estimate leaves it alone
  const [estimated, setEstimated] = useState(false)
  const exact = useRef(false)
  const takeTotal = useCallback((n: number, guess?: boolean) => {
    if (guess && exact.current) return
    exact.current = !guess
    setEstimated(!!guess)
    setTotal(n)
  }, [])
  const [loaded, setLoaded] = useState(isDatabase)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // the server said the file is binary: its size
  const [binarySize, setBinarySize] = useState<number | null>(null)
  // a move the reader makes itself (a click on the ruler, a step of the find, a drag of the scrollbar past the records
  // loaded): its records load around its line, and it lands once, with its record at the top of the reader
  const [jumpAt, setJumpAt] = useState<{ line: number; held?: boolean } | null>(null)
  const jumpLine = jumpAt?.line ?? null
  const setJumpLine = useCallback((line: number | null, held?: boolean) => setJumpAt(line == null ? null : { line, held }), [])
  const landed = useRef<{ line: number } | null>(null)
  // the find bar, open with its text; `ask` bumps each time it is asked for, so the field takes the focus again
  const [finder, setFinder] = useState<{ text: string; ask: number } | null>(null)
  const findInput = useRef<HTMLInputElement | null>(null)
  // the record the find or go to line moved to, which the view scrolls to and flashes as it does a followed ref's
  const [findRef, setFindRef] = useState<string | null>(null)
  const [cursor, setCursor] = useState<MatchAt>(NO_MATCH)
  // where the reader stands and the records around it, which the tracks hear of each frame it scrolls without a render
  // of the reader
  const feed = useMemo(() => new PlaceFeed(), [])
  // columns lie past the right edge of the body (a wide table): a fade at the edge says so
  const [moreRight, setMoreRight] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const recordsRef = useRef(records)
  recordsRef.current = records
  // a page is being read: the scroll, the fill below and a resize can each ask for the next page in the same frame,
  // before the `loading` they see has turned true
  const reading = useRef(false)
  // the body's height as last measured; 0 while the reader is in a hidden tab
  const [bodyHeight, setBodyHeight] = useState(0)
  // the last line after which a page came back empty (the file changed under the reader): no page past it loads by itself
  const dryAfter = useRef<number | null>(null)
  // the line the ref names, or where the record it names starts; a fragment no view understands opens the file at the
  // line it starts with, if any
  const { at: recordAt, pending: recordPending } = useRecordLines(workspace, targetRef, path)
  const targetLine = useMemo(() => targetOf(targetRef, path)?.line ?? recordAt?.line ?? nearestLine(fragment), [targetRef, path, fragment, recordAt])
  const wantLine = jumpLine ?? targetLine

  // the labels that are on and left rows on this file
  const on = useMemo(() => labels.on.filter((k) => marksOf(k) !== 'file' && !!labels.presence.get(k.id)?.[path]), [labels.on, labels.presence, path])
  useEffect(() => {
    setJumpLine(null)
    setFindRef(null)
  }, [targetRef, setJumpLine])
  // every label over files that is on has a column in each record's gutter (but in the Transcript mode, where the
  // tracks mark them); a label over files marks each record of the file with the file's value
  const lanes = labels.on
  const gutterLanes = isTranscript ? NO_LANES : lanes
  const fileOf = useCallback((id: string) => labels.presence.get(id)?.[path], [labels.presence, path])
  const readerLabels = useReaderLabels(workspace, path, on, gutterLanes, labels.focus, fileOf)
  const tags = useMemo(() => laneTags(gutterLanes), [gutterLanes])
  const fileLanes = useMemo(() => new Set(lanes.filter((k) => marksOf(k) === 'file').map((k) => k.id)), [lanes])
  const ruler = useRuler(workspace, path, lanes.length > 0)
  const columns = useMemo(() => rulerColumns(lanes, ruler, fileOf), [lanes, ruler, fileOf])
  const fileLabels = useFileLabels(labels, path)

  useEffect(() => {
    if (isDatabase) return
    const cur = recordsRef.current
    if (cur.length && (wantLine == null || cur.some((r) => r.line === wantLine))) return
    let alive = true
    setLoading(true)
    setError(null)
    // the reader's own moves ask for a clamp: made while the count is an estimate, one can land past the end
    const p = wantLine != null ? api.sourceAround(workspace, path, wantLine, jumpAt?.held ? DRAG_BEFORE : 50, jumpAt?.held ? DRAG_AFTER : 50, jumpAt != null) : api.source(workspace, path, 1, PAGE)
    p.then((page) => {
      if (!alive) return
      if (page.binary) setBinarySize(page.size_bytes ?? 0)
      setRecords(page.records)
      takeTotal(page.total_lines, page.total_estimated)
      setLoaded(true)
      const lastLine = page.records[page.records.length - 1]?.line
      if (jumpAt && lastLine != null && jumpAt.line > lastLine) setJumpLine(lastLine, jumpAt.held)
    })
      .catch((e) => {
        if (!alive) return
        setError(errMsg(e))
        setLoaded(true)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [workspace, path, wantLine, jumpAt, isDatabase, takeTotal, setJumpLine])

  useEffect(() => {
    if (!estimated) return
    let alive = true
    let timer = 0
    const ask = () => {
      timer = window.setTimeout(() => {
        api
          .sourceLines(workspace, path)
          .then((r) => {
            if (!alive) return
            takeTotal(r.total_lines, r.estimated)
            if (r.estimated) ask()
          })
          .catch(() => {})
      }, LINES_POLL_MS)
    }
    ask()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [estimated, workspace, path, takeTotal])

  const first = records[0]?.line
  const last = records[records.length - 1]?.line

  const measure = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    setBodyHeight(el.clientHeight)
    if (el.scrollHeight <= 0) return
    setMoreRight(el.scrollWidth - el.scrollLeft - el.clientWidth > 1)
    const a = el.scrollTop / el.scrollHeight
    const b = (el.scrollTop + el.clientHeight) / el.scrollHeight
    const next =
      (total ? shownIn(el, total) : null) ??
      (!total || first == null || last == null ? { top: a, height: b - a, seen: [] } : { top: (first - 1 + a * (last - first + 1)) / total, height: ((b - a) * (last - first + 1)) / total, seen: [] })
    feed.set({ top: next.top, height: next.height, scroll: el.scrollTop, h: el.clientHeight, content: el.scrollHeight, start: first == null || first <= 1, end: total == null || (last != null && last >= total) })
    feed.setRecords(zoomRecordsOf(el))
  }, [total, first, last, feed])

  // the record at the top of the reader keeps its place while records above it change height: as they are drawn near
  // the view, and across a page loaded above or records dropped above (hold, in loadMore)
  const viewType = viewByType(only ?? pick)?.type ?? builtins.auto.type
  const { hold } = useScrollAnchor(bodyRef, [records, viewType, pick])

  useLayoutEffect(() => {
    measure()
  }, [records, measure])

  // the body or the view in it changed size (the reader resized, a label's column came in): measure again. A pick
  // (a file-type viewer's page in place of the body, and back) can mount a new body.
  useEffect(() => {
    const el = bodyRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    for (const c of Array.from(el.children)) ro.observe(c)
    return () => ro.disconnect()
  }, [measure, records, viewType, pick])

  // a jump lands once its records are in: the record scrolls to the top of the reader
  useLayoutEffect(() => {
    if (jumpAt == null || landed.current === jumpAt) return
    const root = bodyRef.current
    if (!root || !records.some((r) => r.line === jumpAt.line)) return
    landed.current = jumpAt
    const el = root.querySelector<HTMLElement>(`.reader-card[data-line="${jumpAt.line}"]`)
    if (el) root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top
    else if (first != null && last != null) root.scrollTop = ((jumpAt.line - first) / Math.max(1, last - first + 1)) * root.scrollHeight
    measure()
  }, [jumpAt, records, first, last, measure])

  // a drag of the frame's target top, a fraction of the file. A place already loaded is scrolled to at once. While the
  // frame is held the drag reads the file ahead of the pointer, in its direction, into `ahead`, and the records around
  // each place it reaches show from there at once (DRAG_BEFORE and DRAG_AFTER of them), so that the reader follows
  // every move of the pointer; a place not read yet shows once its read lands. Let go, a place not loaded loads as a
  // jump does.
  const seeking = useRef<{ f: number; held: boolean } | null>(null)
  const loadingNow = useRef(loading)
  loadingNow.current = loading
  const ahead = useRef(new Map<number, SourceRecord>())
  const shownAt = useRef(0)
  const showCost = useRef(0)
  const showTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (showTimer.current != null) window.clearTimeout(showTimer.current)
  }, [])
  const aheadAsk = useRef(false)
  const aheadDir = useRef<{ line: number | null; dir: number }>({ line: null, dir: 1 })
  const aheadOf = (line: number) => {
    const lo = Math.max(1, line - DRAG_BEFORE)
    const hi = Math.min(total ?? line, line + DRAG_AFTER)
    const out: SourceRecord[] = []
    for (let l = lo; l <= hi; l++) {
      const r = ahead.current.get(l)
      if (!r) return null
      out.push(r)
    }
    return out.length ? out : null
  }
  const readAhead = (line: number) => {
    const d = aheadDir.current
    if (d.line != null && line !== d.line) d.dir = Math.sign(line - d.line)
    d.line = line
    if (aheadAsk.current || !total) return
    const down = d.dir >= 0
    const lo = Math.max(1, line - (down ? DRAG_BEFORE : AHEAD_NEAR))
    const hi = Math.min(total, line + (down ? AHEAD_NEAR : DRAG_AFTER))
    let missing = false
    for (let l = lo; l <= hi && !missing; l++) missing = !ahead.current.has(l)
    if (!missing) return
    aheadAsk.current = true
    api
      .sourceAround(workspace, path, line, down ? AHEAD_BEHIND : AHEAD_READ, down ? AHEAD_READ : AHEAD_BEHIND, true)
      .then((page) => {
        const got = ahead.current
        for (const r of page.records) got.set(r.line, r)
        // the oldest reads go first past AHEAD_MAX
        for (const k of got.keys()) {
          if (got.size <= AHEAD_MAX) break
          got.delete(k)
        }
        takeTotal(page.total_lines, page.total_estimated)
      })
      .catch(() => {})
      .finally(() => {
        aheadAsk.current = false
        if (seeking.current) settleNow.current()
      })
  }
  const settleSeek = () => {
    const s = seeking.current
    const el = bodyRef.current
    const recs = recordsRef.current
    if (!s || !el || !total || !recs.length) return
    const a = s.f * total
    const line = Math.max(1, Math.min(total, Math.floor(a) + 1))
    if (s.held) readAhead(line)
    if (a >= recs[0].line - 1 && (a < recs[recs.length - 1].line || recs[recs.length - 1].line >= total)) {
      const t = scrollTopFor(el, a)
      if (t != null) el.scrollTop = t
      if (!s.held) seeking.current = null
      return
    }
    // read ahead already: those records show now, and the reader settles on the place once they are drawn; while the
    // frame is held, at most every DRAG_SHOW_MS, or twice as long as the frame that last drew them took where that is
    // longer, so that drawing them leaves the tracks their frames
    const near = aheadOf(line)
    if (near) {
      const wait = s.held ? shownAt.current + Math.max(DRAG_SHOW_MS, 2 * showCost.current) - performance.now() : 0
      if (wait > 0) {
        if (showTimer.current == null)
          showTimer.current = window.setTimeout(() => {
            showTimer.current = null
            settleNow.current()
          }, wait)
        return
      }
      shownAt.current = performance.now()
      setRecords(near)
      requestAnimationFrame((t0) => requestAnimationFrame((t1) => (showCost.current = Math.min(DRAG_SHOW_MAX_MS, t1 - t0))))
      return
    }
    if (s.held || loadingNow.current) return
    setJumpLine(line)
    seeking.current = null
  }
  const settleNow = useRef(settleSeek)
  settleNow.current = settleSeek
  useLayoutEffect(() => {
    settleNow.current()
  }, [records])
  const scrollBy = useCallback((px: number) => {
    const el = bodyRef.current
    if (!el) return 0
    const was = el.scrollTop
    el.scrollTop = was + px
    return el.scrollTop - was
  }, [])

  const loadMore = useCallback(
    async (dir: 'earlier' | 'later') => {
      const cur = recordsRef.current
      const f = cur[0]?.line
      const l = cur[cur.length - 1]?.line
      if (loading || reading.current || f == null || l == null || seeking.current?.held) return
      if (dir === 'earlier' ? f <= 1 : total == null || l >= total) return
      reading.current = true
      setLoading(true)
      try {
        if (dir === 'earlier') {
          const start = Math.max(1, f - PAGE)
          const page = await api.source(workspace, path, start, f - start)
          hold()
          setRecords((c) => {
            const merged = [...page.records, ...c]
            return merged.length > CAP ? merged.slice(0, CAP) : merged
          })
          takeTotal(page.total_lines, page.total_estimated)
        } else {
          const page = await api.source(workspace, path, l + 1, PAGE)
          if (!page.records.length) dryAfter.current = l
          // records dropped from the start are above the view
          if (recordsRef.current.length + page.records.length > CAP) hold()
          setRecords((c) => {
            const merged = [...c, ...page.records]
            return merged.length > CAP ? merged.slice(merged.length - CAP) : merged
          })
          takeTotal(page.total_lines, page.total_estimated)
        }
      } catch (e) {
        setError(errMsg(e))
      } finally {
        reading.current = false
        setLoading(false)
      }
    },
    [workspace, path, loading, total, takeTotal, hold],
  )

  const frame = useRef<number | null>(null)
  const onScroll = () => {
    if (frame.current != null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const el = bodyRef.current
      if (!el) return
      // the ruler is drawn in the frame the records scroll in
      flushSync(measure)
      if (el.scrollTop < LOAD_AHEAD_PX) void loadMore('earlier')
      if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_AHEAD_PX) void loadMore('later')
    })
  }
  useEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current)
  }, [])
  const seek = (f: number, held: boolean) => {
    seeking.current = { f, held }
    settleSeek()
    if (held || !total) return
    ahead.current.clear()
    aheadDir.current = { line: null, dir: 1 }
    // the pages a held drag left unloaded around the place it let go of load as a scroll there would load them
    onScroll()
    track('reader-find', { target: `${path}#L${Math.max(1, Math.min(total, Math.floor(f * total) + 1))}`, detail: { from: 'scrollbar' } })
  }

  const jump = (fraction: number) => {
    if (!total) {
      const el = bodyRef.current
      if (el) el.scrollTop = fraction * el.scrollHeight - el.clientHeight / 2
      return
    }
    const line = Math.max(1, Math.min(total, Math.floor(fraction * total) + 1))
    track('reader-find', { target: `${path}#L${line}`, detail: { from: 'ruler' } })
    setJumpLine(line)
  }

  const binary = binarySize != null || builtins.binary
  // the records shown leave room below them and the file goes on (a view hid some records): load the next page until
  // the reader is full. A reader in a hidden tab has no height and loads nothing until shown.
  useEffect(() => {
    const el = bodyRef.current
    if (!el || bodyHeight <= 0 || loading || !loaded || error || binary || last == null || total == null || last >= total || dryAfter.current === last) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_AHEAD_PX) void loadMore('later')
  }, [records, loading, loaded, error, binary, last, total, loadMore, viewType, bodyHeight])

  // ---- find in the file and go to a line
  const openFinder = useCallback((mode: 'find' | 'line') => setFinder((f) => ({ text: mode === 'line' ? ':' : f?.text ?? '', ask: (f?.ask ?? 0) + 1 })), [])
  // a shortcut's ask opens the bar in the same render, so the field has the focus before the next key arrives
  const [seenAsk, setSeenAsk] = useState(findAsk?.n ?? 0)
  if (findAsk && findAsk.n !== seenAsk) {
    setSeenAsk(findAsk.n)
    openFinder(findAsk.mode)
  }
  const lineAsk = finder ? lineAsked(finder.text) : null
  const findText = finder && lineAsk == null ? finder.text.trim() : ''
  const search = useSourceFind(workspace, path, binary ? '' : findText)
  const found = search.found && search.text === findText ? search.found : null
  // a move to a line: its records load around it, and the view scrolls to it and flashes it as it does a followed ref's
  const goTo = useCallback(
    (line: number, from: 'find' | 'line' | 'ruler') => {
      track('reader-find', { target: `${path}#L${line}`, detail: { from } })
      setJumpLine(line)
      setFindRef(`${path}#L${line}`)
    },
    [path],
  )
  // the match the reader scrolls to once it is marked: set by each move of the find, taken by the mark that finds it
  const scrollToMatch = useRef<MatchAt | null>(null)
  const land = (at: MatchAt) => {
    setCursor(at)
    scrollToMatch.current = at
  }
  // a new answer shows its first match at or after the top of what the reader shows
  useEffect(() => {
    if (!found) return setCursor(NO_MATCH)
    const i = firstMatchFrom(found.lines, topLine(bodyRef.current) ?? 1)
    land(i >= 0 ? { i, k: 0 } : NO_MATCH)
    if (i >= 0) goTo(found.lines[i], 'find')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.found])
  // a step moves through the matches inside a line (a long record matches many times) before it leaves the line; a step
  // past the last line listed reads on (the search listed or read only part of the file) before it wraps
  const step = async (dir: 1 | -1) => {
    if (!found || !found.lines.length) return
    const counts = countsOf(found)
    const inLine = stepInLine(cursor, dir, counts)
    if (inLine) {
      track('reader-find', { target: `${path}#L${found.lines[inLine.i]}`, detail: { from: 'find' } })
      return land(inLine)
    }
    const i = cursor.i
    if (dir === 1 && i === found.lines.length - 1 && (found.lines.length < found.total || !found.complete)) {
      const lines = await search.more().catch(() => null)
      if (lines && lines.length > i + 1) {
        land({ i: i + 1, k: 0 })
        goTo(lines[i + 1], 'find')
        return
      }
    }
    const j = stepMatch(i, dir, found.lines.length)
    land({ i: j, k: dir === 1 ? 0 : counts[j] - 1 })
    goTo(found.lines[j], 'find')
  }
  const shownMatch = found && cursor.i >= 0 ? found.lines[cursor.i] ?? null : null
  const goToLine = () => {
    if (!lineAsk || !total) return
    goTo(Math.max(1, Math.min(total, lineAsk)), 'line')
    setFinder(null)
  }
  const closeFinder = () => setFinder(null)
  // the matches in the records shown are marked, again whenever the records or the view's text change; the current one,
  // once marked after a move, is scrolled into view
  const markText = found && found.total > 0 ? findText : ''
  const shownK = cursor.k
  // where the marks stand in their records, for the thumb's find lane
  const [spots, setSpots] = useState<ReadonlyMap<number, number[]>>(NO_SPOTS)
  useEffect(() => {
    const root = bodyRef.current
    if (!markText || !root) {
      setSpots(NO_SPOTS)
      return clearMatches()
    }
    let frameId = 0
    const mark = () => {
      frameId = 0
      const range = markMatches(root, markText, shownMatch, shownK)
      setSpots(markSpots())
      const want = scrollToMatch.current
      if (!want || found?.lines[want.i] !== shownMatch || want.k !== shownK) return
      // a record that is shown without the words (a view that leaves that part out) keeps the view's own scroll
      if (!range && !root.querySelector(`.reader-card[data-line="${shownMatch}"]`)) return
      // a match inside a folded tool output opens its block first; the mark after it renders open scrolls to it
      if (range && unfoldAt(range)) {
        if (!frameId) frameId = requestAnimationFrame(mark)
        return
      }
      scrollToMatch.current = null
      if (!range) return
      const r = range.getBoundingClientRect()
      const box = root.getBoundingClientRect()
      if (r.top < box.top || r.bottom > box.bottom) root.scrollTop += r.top - box.top - root.clientHeight / 3
    }
    mark()
    if (typeof MutationObserver === 'undefined') return clearMatches
    const mo = new MutationObserver(() => {
      if (!frameId) frameId = requestAnimationFrame(mark)
    })
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      mo.disconnect()
      if (frameId) cancelAnimationFrame(frameId)
      clearMatches()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markText, shownMatch, shownK])
  const findStatus = !finder ? '' : lineAsk != null ? (total && !estimated ? `of ${linesText(total, estimated)}` : '') : search.error ? 'Could not search' : found ? matchCount(cursor.i < 0 ? -1 : matchNumber(cursor, countsOf(found)), found.matches ?? found.total, !found.complete) : ''
  const rulerCols = useMemo(() => (found && found.total && total ? [...columns, findColumn(found.lines, total, findText)] : columns), [columns, found, total, findText])

  // ---- Color by and the tracks
  const color = useColorBy(workspace, path, isTranscript && !binary && !isDatabase, labels, records, readerLabels.rows, total)
  const colorChoice = color.choice
  // the overview's colors: the chosen key's commonest value per bin, the chosen label's value most records have per
  // bin, else the density
  const paint = useMemo<OverviewPaint>(() => {
    if (!isTranscript) return { kind: 'none' }
    if (colorChoice.by === 'key') {
      const k = color.keys?.keys.find((x) => x.key === colorChoice.key)
      if (k) {
        const ranks = Math.max(1, k.values.length)
        const offSet = new Set(color.off)
        // a value's rank's color, or the one picked for it
        const pickedOf = (r: number) => color.picked[r < KEY_COLORS ? k.values[r]?.value ?? '' : OTHER]
        return {
          kind: 'bins',
          at: k.at,
          colors: Array.from({ length: ranks }, (_, r) => (pickedOf(r) ? `var(--label-${pickedOf(r)})` : keyColor(r))),
          faded: Array.from({ length: ranks }, (_, r) => offSet.has(r < KEY_COLORS ? k.values[r].value : OTHER)),
        }
      }
    }
    if (colorChoice.by === 'label') {
      const k = lanes.find((x) => x.id === colorChoice.id)
      const got = k ? labelPaint(k, ruler, new Set(color.off)) : null
      if (got) return got
    }
    return color.keys?.bytes.length ? { kind: 'density', bytes: color.keys.bytes } : { kind: 'none' }
  }, [isTranscript, colorChoice, color.keys, color.off, color.picked, lanes, ruler])
  // the markers: the find's matches. Each other label that is on and marks the file has a lane of its own beside the
  // choice's, in its own colors, so that one choice is one lane and two labels on are two
  const markers = useMemo(() => rulerCols.filter((c) => c.id === 'find'), [rulerCols])
  const choiceLabel = colorChoice.by === 'label' ? colorChoice.id : null
  const trackLanes = useMemo<TrackLane[]>(() => {
    if (!isTranscript) return []
    const out: TrackLane[] = []
    for (const k of lanes) {
      if (k.id === choiceLabel || marksOf(k) === 'file' || !fileOf(k.id)) continue
      const got = labelPaint(k, ruler, NO_OFF)
      if (got) out.push({ id: k.id, name: k.name, paint: got })
    }
    return out
  }, [isTranscript, lanes, choiceLabel, fileOf, ruler])
  const paintName = colorChoice.by === 'key' ? colorChoice.key : colorChoice.by === 'label' ? (lanes.find((k) => k.id === choiceLabel)?.name ?? '') : ''
  const recordAtLine = useMemo(() => new Map(records.map((r) => [r.line, r])), [records])
  // a record's color on the zoomed track, and its value of the choice for its hover
  const zoomColor = useMemo(() => {
    const names = new Map(color.values.map((v) => [v.id, v.name]))
    return (line: number) => {
      const rec = recordAtLine.get(line)
      const chip = rec ? color.chipOf(rec) : undefined
      return { color: color.colors?.get(line)?.color ?? null, title: (chip != null ? names.get(chip) : null) ?? '' }
    }
  }, [color, recordAtLine])
  const hint = builtins.transcript
  const preview = useCallback(
    (line: number) =>
      api.source(workspace, path, line, 3).then((p) =>
        p.records.map((rec) => {
          const chip = color.chipOf(rec)
          return previewOf(rec, hint, chip != null ? (color.values.find((v) => v.id === chip)?.color ?? null) : null)
        }),
      ),
    [workspace, path, color, hint],
  )
  // the record a mark of the ruler stands for: its line when it stands for one, else the first of its lines whose value
  // of the label is the mark's, read from the server once per mark
  const markLines = useMemo(() => new Map<string, Promise<number | null>>(), [ruler, on])
  const markLine = useCallback(
    (column: string, tick: RulerTick): Promise<number | null> => {
      if (tick.from === tick.to) return Promise.resolve(tick.from)
      const key = `${column}|${tick.value}|${tick.from}`
      const known = markLines.get(key)
      if (known) return known
      const k = on.find((x) => x.id === column)
      const got: Promise<number | null> = !k
        ? Promise.resolve(null)
        : scaleApi
            .labelsForLines(workspace, path, tick.from, tick.to)
            .then((list) => {
              let line: number | null = null
              for (const r of list.find((g) => g.concept_id === column)?.rows ?? []) {
                const l = Number(/#L(\d+)$/.exec(r.ref)?.[1])
                if (l >= tick.from && l <= tick.to && litClass(k, valueOf(r))?.name === tick.value && (line == null || l < line)) line = l
              }
              return line
            })
            .catch(() => null)
      markLines.set(key, got)
      return got
    },
    [markLines, on, workspace, path],
  )
  // a click near a patch of color on the overview goes to the first record of the patch's value on the lines where the
  // patch starts (read from the server: a key's value from the records, a label's from its rows), and chooses it as the
  // find does; the first of those lines when none is found
  const snapTo = (from: number, to: number, value: number, lane: string | null) => {
    const land = (line: number | null) => goTo(line ?? from, 'ruler')
    if (colorChoice.by === 'key' && lane == null) {
      const k = color.keys?.keys.find((x) => x.key === colorChoice.key)
      if (!k) return land(from)
      const inValue = (rec: SourceRecord) => {
        const v = keyValue(rec, k.key)
        if (v == null) return false
        const rank = k.values.findIndex((x) => x.value === v)
        return value < KEY_COLORS ? rank === value : rank < 0 || rank >= KEY_COLORS
      }
      void api
        .source(workspace, path, from, Math.min(SNAP_LINES, to - from + 1))
        .then((p) => land(p.records.find(inValue)?.line ?? null))
        .catch(() => land(null))
      return
    }
    const id = lane ?? choiceLabel
    const k = id != null ? lanes.find((x) => x.id === id) : undefined
    const name = k ? classesOf(k).filter((c) => c.highlight)[value]?.name : undefined
    if (!k || name == null) return land(from)
    void scaleApi
      .labelsForLines(workspace, path, from, to)
      .then((list) => {
        let line: number | null = null
        for (const r of list.find((g) => g.concept_id === k.id)?.rows ?? []) {
          const l = Number(/#L(\d+)$/.exec(r.ref)?.[1])
          if (l >= from && l <= to && litClass(k, valueOf(r))?.name === name && (line == null || l < line)) line = l
        }
        land(line)
      })
      .catch(() => land(null))
  }
  // a click on a mark goes to its record, or to the middle of its lines when none is found; a label over files' mark
  // stands for the whole file and goes nowhere
  const onMark = (column: string, tick: RulerTick) => {
    if (fileLanes.has(column)) return
    void markLine(column, tick).then((line) => {
      if (line != null) goTo(line, 'ruler')
      else if (total) jump((tick.from - 1 + (tick.to - tick.from + 1) / 2) / total)
    })
  }

  // a viewer for the file's type shows in its place: the one picked for this file, else, while no built-in mode is
  // picked and the best one is Raw, the first that reads the ref's fragment
  const rawBest = builtins.loaded && (builtins.auto.type === 'raw' || binary)
  const types = useTypeViewers(workspace, path, !only && !isDatabase, rawBest)
  const autoViewer = rawBest ? types.viewers.find((v) => fragment == null || accepts(v, fragment)) : undefined
  const pickedSlug = slugOf(pick)
  const viewer = only ? undefined : pickedSlug ? types.viewers.find((v) => v.slug === pickedSlug) ?? autoViewer : pick ? undefined : autoViewer
  const modeTitle = viewer?.name ?? view?.title
  useEffect(() => {
    if (modeTitle && builtins.loaded) onMode?.(modeTitle)
  }, [modeTitle, builtins.loaded, onMode])
  const onPick = (v: string) => {
    track('view-open', { target: path, detail: { from: 'switcher', to: v } })
    setPick(v)
    writeStorage(memoryKey, v)
  }
  // a viewer built from the chip opens as the file's mode, even after a pick of Raw
  const forgetPick = () => {
    setPick(null)
    writeStorage(memoryKey, null)
  }
  const { removable, confirmDelete } = useViewerDelete(workspace, pickedSlug, forgetPick)
  const { offered, dismiss } = useOffered(workspace, types.proposal, !only && !viewer)
  // a file that could not be read says so, and so does a binary one (an archive, a file of a type no view reads), whose
  // bytes read as text would be noise
  const noViewReason: string | null = isDatabase || !loaded || loading ? null : error && records.length === 0 ? `Could not read it. ${error}` : binary ? binaryReason(binarySize ?? builtins.binarySize) : null
  // the fragment is named when nothing here reads it (a sheet cell of a spreadsheet no view claims)
  const unread = fragment != null && targetOf(targetRef, path) == null && !recordAt && !recordPending ? fragment : null
  const page: SourcePage = useMemo(() => ({ path, kind, total_lines: total ?? 0, start: first ?? 1, records }), [path, kind, total, first, records])
  const ViewComponent = view?.component
  // a record the server placed on lines is shown to the view as those lines, which it scrolls to and flashes
  const viewTarget = findRef ?? (recordAt ? `${path}#L${recordAt.line}` + (recordAt.endLine > recordAt.line ? `-L${recordAt.endLine}` : '') : targetRef)
  const loadPage = useCallback((dir: 'earlier' | 'later') => void loadMore(dir), [loadMore])
  // the view is rendered again only when what it shows changes, not when the reader measures its scroll (the ruler's
  // thumb, the fade at the right edge) as the reader resizes or scrolls
  const transcript = builtins.transcript
  // the Transcript mode is the one view that can find nothing it was offered for (the sniff reads only the head)
  const unavailable = isTranscript ? builtins.dropTranscript : undefined
  const viewEl = useMemo(() => {
    if (!ViewComponent) return null
    const viewProps: ViewProps = { workspace, path, kind, page, loadMore: loadPage, targetRef: viewTarget, transcript, unavailable }
    return <ViewComponent {...viewProps} />
  }, [ViewComponent, workspace, path, kind, page, loadPage, viewTarget, transcript, unavailable])
  // the built-in modes, then the file-type viewers, then Raw
  const builtinOptions = builtins.listed.map((v) => ({ value: v.type, label: v.title }))
  const options = [
    ...builtinOptions.filter((o) => o.value !== 'raw'),
    ...(only
      ? []
      : types.viewers.map((v) => ({
          value: viewValue(v.slug),
          label: v.name,
          ...removable(v),
        }))),
    ...builtinOptions.filter((o) => o.value === 'raw'),
  ]
  return (
    <ReaderLabelsContext.Provider value={readerLabels}>
      <div className="reader">
        {lead !== undefined && (
          <div className="reader-bar">
            {lead}
            <span className="reader-spacer" />
            {unread && <span className="reader-fragment mono">#{unread}</span>}
            {!isDatabase && !binary && loaded && !viewer && <Button variant="icon" size="sm" icon="search" title="Find in the file" className="reader-find-open" active={!!finder} onClick={() => (finder ? closeFinder() : openFinder('find'))} />}
            {end}
            {!only && builtins.loaded && view && (options.length > 1 || offered) && (
              <span className="reader-modes">
                <Segmented label="Mode" size="md" value={viewer ? viewValue(viewer.slug) : view.type} onChange={onPick} options={options} />
                {offered && <ProposalOption ws={workspace} p={offered} size="md" onDismiss={() => dismiss(offered)} onAccept={forgetPick} />}
                {confirmDelete}
              </span>
            )}
          </div>
        )}
        {finder && !isDatabase && !binary && !viewer && (
          <FindBar
            text={finder.text}
            onText={(text) => setFinder((f) => (f ? { ...f, text } : f))}
            status={findStatus}
            busy={search.loading && !!findText}
            onStep={found && found.lines.length ? (dir) => void step(dir) : null}
            onEnter={goToLine}
            onClose={closeFinder}
            inputRef={findInput}
            ask={finder.ask}
          />
        )}
        <FileLabels items={fileLabels} />
        {viewer ? (
          <ReaderViewer key={viewer.slug} ws={workspace} view={viewer} path={path} targetRef={fragment != null && accepts(viewer, fragment) ? targetRef : undefined} labels={labels} onRaw={() => onPick('raw')} />
        ) : (
          <>
            {isTranscript && !binary && !isDatabase && loaded && !noViewReason && (
              <div className="reader-colorbar">
                <ColorBy choice={color.choice} keys={color.keys?.keys ?? []} labels={color.fileLabels} values={color.values} off={color.off} onChoose={color.choose} onToggle={color.toggle} countsOf={fileOf} onColor={color.recolor} onResetColors={color.resetColors ?? undefined} pickedOf={color.pickedOf} />
              </div>
            )}
            <div className="reader-main">
              <div className="reader-scroll" data-more-right={moreRight || undefined}>
                <div className={'reader-body' + (isDatabase ? ' reader-body-fill' : '')} ref={bodyRef} onScroll={onScroll} style={{ ...(tags.length ? { '--lanes': tags.length } : {}), '--digits': String(total ?? 0).length } as CSSProperties}>
                  {tags.length > 0 && view && GUTTERED.has(view.type) && loaded && !noViewReason && <LaneHead tags={tags} />}
                  {error && !noViewReason && <div className="reader-error-text">{error}</div>}
                  {noViewReason && (
                    <div className="reader-noview">
                      <div className="reader-noview-reason dim">{noViewReason}</div>
                    </div>
                  )}
                  {ViewComponent && loaded && !noViewReason && (
                    <ColorContext.Provider value={isTranscript ? color.colors : null}>
                      <ViewBoundary key={`${view!.type}|${path}`} viewType={view!.type} onFallback={() => onPick('raw')}>
                        {viewEl}
                      </ViewBoundary>
                    </ColorContext.Provider>
                  )}
                  {loading && (
                    <div className="reader-more">
                      <Spinner size={14} label="Loading" />
                    </div>
                  )}
                </div>
                {moreRight && <div className="reader-edge" aria-hidden />}
              </div>
              {!isDatabase && !binary && (
                <ReaderTracks total={total} feed={feed} paint={paint} paintName={paintName} lanes={trackLanes} markers={markers} colorOf={zoomColor} onSnap={snapTo} onJump={jump} onSeek={seek} onScrollBy={scrollBy} onMark={onMark} preview={preview} />
              )}
            </div>
          </>
        )}
      </div>
    </ReaderLabelsContext.Provider>
  )
}

export default Reader
