// The Files tree's search (⌘P / Ctrl+P): while the field holds text, in place of the tree, the files whose path holds
// every word of it, then the files whose text holds it with their first matching lines (find.ts resultRows). Both run
// on the server over the whole corpus: names at once (GET /corpora/{c}/sources/find), text as a stream of a line per
// file (GET /sources/grep), so the first files show while a big corpus is read. The text search has no time limit:
// while it reads, a row says how many files it has read, with Stop. ↑ and ↓ pick a row, Enter opens it (at line n when
// the query ends in `:<n>`), Escape clears the field.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { track } from '../lib/telemetry'
import type { FileFind, GrepDone, GrepFile, GrepProgress } from '../lib/types'
import { nameSegments, parseFileQuery, resultRows, snippetParts, type ResultRow } from './find'
import { baseName, glyphOf, parentOf } from './Tree'

/** ms the search by name waits after the last key before it asks the server */
const DEBOUNCE_MS = 150
/** ms the search inside the files waits, longer, since it reads the corpus */
const GREP_DEBOUNCE_MS = 250
/** the fewest letters the search inside the files starts on: one letter matches nearly every line */
const GREP_MIN = 2

interface Found {
  text: string
  found: FileFind | null
  error: string | null
}

/** The server's answer for the words typed, asked once typing pauses; `loading` while the answer is for other words. */
export function useFileFind(ws: string, text: string): Found & { loading: boolean } {
  const [got, setGot] = useState<Found>({ text: '', found: null, error: null })
  useEffect(() => {
    if (!text) return
    const ctl = new AbortController()
    const t = window.setTimeout(() => {
      api
        .findFiles(ws, text, ctl.signal)
        .then((found) => setGot({ text, found, error: null }))
        .catch((e: Error) => !ctl.signal.aborted && setGot({ text, found: null, error: e.message }))
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(t)
      ctl.abort()
    }
  }, [ws, text])
  return { ...got, loading: !!text && got.text !== text }
}

interface Grepped {
  text: string
  files: GrepFile[]
  progress: GrepProgress | null
  done: GrepDone | null
  /** the server's id of the search, once its stream opened */
  search: number | null
  /** the analyst stopped the search, and it had not read every file */
  stopped: boolean
  /** the stream was dropped before its closing line */
  cut: boolean
  error: string | null
}

const fresh = (text: string): Grepped => ({ text, files: [], progress: null, done: null, search: null, stopped: false, cut: false, error: null })

/** ms Stop waits for the stopped search's closing line before it drops the stream */
const STOP_WAIT_MS = 5000

/** The files whose text holds `text`, as the server's stream hands them over, and how many files it has read; a new
 * text drops the stream before it. `stop` asks the server to stop the search, whose closing line then says how many
 * files it read; a search that has not answered yet is dropped. `loading` until the stream for this text has closed. */
export function useFileGrep(ws: string, text: string): Omit<Grepped, 'text' | 'search' | 'cut'> & { loading: boolean; stop: () => void } {
  const [got, setGot] = useState<Grepped>(() => fresh(''))
  const gotRef = useRef(got)
  gotRef.current = got
  const ctlRef = useRef<AbortController | null>(null)
  const on = text.length >= GREP_MIN
  useEffect(() => {
    if (!on) return
    const ctl = new AbortController()
    ctlRef.current = ctl
    const mineOnly = (f: (g: Grepped) => Grepped) => !ctl.signal.aborted && setGot((g) => (g.text === text ? f(g) : g))
    const t = window.setTimeout(() => {
      if (ctl.signal.aborted) return
      setGot(fresh(text))
      api
        .grepFiles(
          ws,
          text,
          (f) => mineOnly((g) => ({ ...g, files: [...g.files, f] })),
          (d) => mineOnly((g) => ({ ...g, done: d, stopped: g.stopped && !d.complete })),
          ctl.signal,
          (p) => mineOnly((g) => ({ ...g, progress: p })),
          (id) => mineOnly((g) => ({ ...g, search: id })),
        )
        .catch((e: Error) => !ctl.signal.aborted && setGot((g) => ({ ...g, text, error: e.message })))
    }, GREP_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(t)
      ctl.abort()
    }
  }, [ws, text, on])
  const stop = useCallback(() => {
    const ctl = ctlRef.current
    const g = gotRef.current
    const drop = () => {
      ctl?.abort()
      setGot((x) => (x.text !== text ? { ...fresh(text), stopped: true, cut: true } : x.done || x.error ? x : { ...x, stopped: true, cut: true }))
    }
    if (g.text !== text || g.search == null) return drop()
    if (g.done || g.error) return
    setGot((x) => (x.text === text ? { ...x, stopped: true } : x))
    api.stopGrep(ws, g.search).catch(drop)
    window.setTimeout(() => {
      const now = gotRef.current
      if (now.text === text && now.search === g.search && !now.done && !now.error) drop()
    }, STOP_WAIT_MS)
  }, [ws, text])
  const mine = on && got.text === text
  return {
    files: mine ? got.files : [],
    progress: mine ? got.progress : null,
    done: mine ? got.done : null,
    stopped: mine && got.stopped,
    error: mine ? got.error : null,
    loading: on && (!mine || (!got.done && !got.error && !got.cut)),
    stop,
  }
}

const filesRead = (n: number, of: number) => `${n.toLocaleString()} of ${of.toLocaleString()} files`

/** What the row under the results says of the text search: how many files it has read while it runs, and once the
 * analyst stopped it, how many it read, which the search's closing line gives; null when there is nothing to say.
 * Pure. */
export function grepStatus(grep: { loading: boolean; stopped: boolean; progress: GrepProgress | null; done: GrepDone | null }): string | null {
  const p = grep.progress
  if (grep.stopped) {
    if (grep.done) return `Stopped after ${filesRead(grep.done.scanned, grep.done.of)}`
    return grep.loading ? 'Stopping' : 'Stopped'
  }
  if (!grep.loading || !p) return null
  return p.scanned ? `Searched ${filesRead(p.scanned, p.of)}` : `Searching ${p.of.toLocaleString()} ${p.of === 1 ? 'file' : 'files'}`
}

interface Props {
  ws: string
  /** the field, for the shortcut to put the focus in */
  inputRef: Ref<HTMLInputElement>
  /** open a file the search found, at a line when the query named one or the row is a matching line */
  onOpen: (path: string, line: number | null) => void
  /** what shows while the field is empty: the tree */
  children: ReactNode
}

const pickable = (r: ResultRow) => r.kind !== 'head'

export function FileSearch({ ws, inputRef, onOpen, children }: Props) {
  const [raw, setRaw] = useState('')
  const [picked, setPicked] = useState(0)
  const [allNames, setAllNames] = useState(false)
  const query = parseFileQuery(raw)
  const { found, error, loading } = useFileFind(ws, query.text)
  const grep = useFileGrep(ws, query.text)
  const rows = query.text ? resultRows(found, grep, allNames) : []
  const picks = rows.filter(pickable)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setPicked(0)
    setAllNames(false)
  }, [query.text])
  // the picked row stays in view as ↑ and ↓ move it
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.files-found-row.active')?.scrollIntoView?.({ block: 'nearest' })
  }, [picked])
  const open = (r: ResultRow | undefined) => {
    if (!r) return
    if (r.kind === 'more') return setAllNames(true)
    if (r.kind === 'name') {
      track('search', { target: r.path, detail: { from: 'files-tree', words: query.text.split(/\s+/).length, rank: picks.indexOf(r) } })
      onOpen(r.path, query.line)
    } else if (r.kind === 'file' || r.kind === 'match') {
      track('search', { target: `${r.path}#L${r.line}`, detail: { from: 'files-tree', in: 'text', rank: picks.indexOf(r) } })
      onOpen(r.path, r.line)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (picks.length) setPicked((p) => (p + (e.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      open(picks[Math.min(picked, picks.length - 1)])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (raw) setRaw('')
      else e.currentTarget.blur()
    }
  }
  const busy = loading || grep.loading
  const nothing = !busy && !error && !grep.error && !grep.stopped && rows.length === 0
  const status = grepStatus(grep)
  return (
    <>
      <label className="files-search">
        <Icon name="search" size={13} />
        <input ref={inputRef} value={raw} onChange={(e) => setRaw(e.target.value)} onKeyDown={onKey} placeholder="Search files" aria-label="Search files" spellCheck={false} autoComplete="off" />
        {raw && (
          <button type="button" className="files-search-clear" aria-label="Clear the search" onClick={() => setRaw('')}>
            <Icon name="x" size={12} />
          </button>
        )}
      </label>
      {query.text ? (
        <div className="files-tree files-found" role="listbox" aria-label="Search results" ref={listRef}>
          {rows.map((r) => {
            if (r.kind === 'head')
              return (
                <div key={r.key} className="files-found-head" role="presentation">
                  <span>{r.text}</span>
                  <span className="files-found-note">{r.note}</span>
                </div>
              )
            const i = picks.indexOf(r)
            const active = i === picked
            const common = {
              role: 'option',
              'aria-selected': active,
              onPointerMove: () => !active && setPicked(i),
              onClick: () => open(r),
            }
            if (r.kind === 'more')
              return (
                <div key={r.key} {...common} className={'files-row files-found-row files-found-more' + (active ? ' active' : '')}>
                  {r.n.toLocaleString()} more
                </div>
              )
            if (r.kind === 'match') {
              const [before, hit, after] = snippetParts(r.text, r.hit)
              return (
                <div key={r.key} {...common} className={'files-row files-found-row files-found-line' + (active ? ' active' : '')} data-anchor={`${r.path}#L${r.line}`} data-anchor-text={`${r.path}#L${r.line}`}>
                  <span className="files-found-lno">{r.line}</span>
                  <span className="files-found-snip">
                    {before}
                    <mark>{hit}</mark>
                    {after}
                  </span>
                </div>
              )
            }
            const name = baseName(r.path)
            const folder = parentOf(r.path)
            return (
              <div key={r.key} {...common} className={'files-row files-file files-found-row' + (r.kind === 'file' ? ' files-found-infile' : '') + (active ? ' active' : '')} data-anchor={r.path} data-anchor-text={r.path}>
                <Icon className="files-glyph" name={glyphOf(name)} size={13} />
                <span className="files-name">{r.kind === 'name' ? nameSegments(name, query.text).map((s, k) => (s.hit ? <mark key={k}>{s.text}</mark> : s.text)) : name}</span>
                {folder && <span className="files-found-dir">{folder}</span>}
                {r.kind === 'file' && (
                  <span className="files-found-n">
                    {r.total.toLocaleString()}
                    {r.complete ? '' : '+'}
                  </span>
                )}
              </div>
            )
          })}
          {(grep.loading || grep.stopped) && (
            <div className="files-found-status">
              {grep.loading && <Spinner size={10} label="Searching" />}
              {status && <span className="files-found-status-text">{status}</span>}
              {grep.loading && !grep.stopped && (
                <button type="button" className="files-found-stop" onClick={grep.stop}>
                  Stop
                </button>
              )}
            </div>
          )}
          {loading && !grep.loading && (
            <div className="files-empty">
              <Spinner size={10} label="Searching" />
            </div>
          )}
          {error && <div className="files-empty">Could not search the file names. {error}</div>}
          {grep.error && <div className="files-empty">Could not search inside the files. {grep.error}</div>}
          {nothing && <div className="files-found-count">No results</div>}
        </div>
      ) : (
        children
      )}
    </>
  )
}
