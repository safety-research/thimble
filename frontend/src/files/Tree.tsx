// The files tree: folders first, then files, alphabetical. Each folder's entries are fetched the first time it is shown
// (useFolderStore) and only the rows in view are rendered (windowOf), so a very large corpus scrolls like a small one.
// At the right of a row, a dot per label that is on and marks something in the file; a file label that is on draws a
// stripe left of the glyph instead (labels.ts presenceOf). A collapsed folder shows a dot for each label that marks
// something under it. The guide lines show only while the pointer is over the tree. Every file row carries
// `data-anchor`.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { scaleApi } from '../lib/api'
import type { FolderEntry, FolderListing, SourceInfo } from '../lib/types'
import type { Presence } from './labels'
import { isJsonlFile } from './views/common'

/** px, the height of `.files-row` (styles/files.css); the window is computed from it */
export const ROW_HEIGHT = 24
/** rows rendered above and below the visible window */
export const OVERSCAN = 8
/** px, the label glyph's box among a row's marks: its outline (16 of the 24 units and a stroke of 2) comes out 6.75px,
 * the size of the 7px dot beside it (`.files-dot`), and an odd box centres on the dot's centre at whole pixels */
const MARK_TAG_PX = 9

/** What the tree knows of one folder: its listing once fetched, or why not yet. */
export type FolderState = { state: 'loading' } | { state: 'ok'; listing: FolderListing } | { state: 'error'; message: string }
export type FolderStore = ReadonlyMap<string, FolderState>

/** What the tree says when the root holds no files: an empty folder is most often the wrong one, so it says where
 * thimble looks. Null otherwise. */
export function emptyFolderNote(root: FolderState | undefined): string | null {
  if (root?.state !== 'ok') return null
  const { n_files: n, files, folders } = root.listing
  if (n != null ? n > 0 : files.length > 0 || folders.length > 0) return null
  return 'This folder has no files. thimble shows the folder it was started in; to look at another folder, run thimble there.'
}

export interface DirNode {
  kind: 'dir'
  name: string
  path: string
  isRun: boolean
  entry: FolderEntry
}
export interface FileNode {
  kind: 'file'
  name: string
  path: string
  info: SourceInfo
}
export type TreeNode = DirNode | FileNode

const collate = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
const splitExt = (name: string): [string, string] => {
  const i = name.lastIndexOf('.')
  return i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [name, '']
}
/** Natural order by the name without its extension, then by the extension, then by code point: the collation ignores
 * punctuation, so comparing whole names would put `notes_sample.jsonl` before `notes.jsonl`. */
export function cmpName(a: string, b: string): number {
  const [sa, ea] = splitExt(a)
  const [sb, eb] = splitExt(b)
  return collate(sa, sb) || collate(ea, eb) || (a < b ? -1 : a > b ? 1 : 0)
}
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

export function fmtSize(n: number): string {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** The files a workspace opens with when it keeps no tabs: the largest file of records at the corpus root, then its
 * README; else the root's first file. The first is the one shown. */
export function defaultTabs(files: readonly SourceInfo[]): string[] {
  const shown = files.filter((f) => !f.hidden)
  const data = shown.filter((f) => isJsonlFile(f.path, f.kind)).sort((a, b) => (b.size_bytes || 0) - (a.size_bytes || 0))[0]
  const readme = shown.find((f) => /^readme(\.|$)/i.test(baseName(f.path)))
  const out = [data?.path, readme?.path].filter((p): p is string => !!p)
  if (out.length) return out
  const first = [...shown].sort((a, b) => cmpName(baseName(a.path), baseName(b.path)))[0]
  return first ? [first.path] : []
}

// A file's kind by its name, the glyph each kind takes: the first pattern that matches wins.
const GLYPHS: [RegExp, IconName][] = [
  [/\.(jsonl?|ndjson|geojson|jsonc)$/i, 'braces'],
  [/\.(csv|tsv|xlsx?|parquet|feather|arrow)$/i, 'table'],
  [/\.(db|sqlite3?|duckdb)$/i, 'forge'],
  [/\.(md|markdown|mdx)$/i, 'markdown'],
  [/\.(sh|bash|zsh|fish)$/i, 'terminal'],
  [/\.ipynb$/i, 'notebook'],
  [/\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i, 'image'],
  [/\.(zip|gz|tgz|tar|bz2|xz|7z|whl|zst)$/i, 'archive'],
  [/\.(ya?ml|toml|ini|cfg|conf|env|lock|properties)$|^(dockerfile|makefile|\.gitignore|\.env|\.editorconfig)$/i, 'sliders'],
  [/\.(py|pyi|js|mjs|cjs|jsx|ts|tsx|go|rs|java|kt|c|h|cc|cpp|hpp|rb|php|swift|scala|r|jl|lua|pl|sql|html?|css|scss|xml|vue|svelte)$/i, 'code'],
  [/\.(txt|text|rst|log|pdf|rtf|tex|docx?)$/i, 'doc'],
]

/** The glyph of a file, by its kind as its name says (VS Code's way): braces for JSON and
 * JSON lines, a grid for tables, a cylinder for databases, the markdown mark, a terminal for a shell script, a notebook,
 * a picture, an archive, sliders for configuration, angle brackets for source code, a page with lines for text, and a
 * bare page for anything else. */
export function glyphOf(name: string): IconName {
  const base = name.slice(name.lastIndexOf('/') + 1)
  for (const [re, glyph] of GLYPHS) if (re.test(base)) return glyph
  return 'page'
}

export interface Row {
  node: TreeNode
  depth: number
  open: boolean
  chev: boolean
  /** an expanded folder whose listing has not arrived */
  loading: boolean
}

/** The rows the tree shows: per level the folders first, then the files, in natural order; an expanded folder's
 * children follow it once its listing is loaded. `chev` reserves the chevron column when the root has any folder. */
export function rowsOf(store: FolderStore, expanded: ReadonlySet<string>): Row[] {
  const out: Row[] = []
  const root = store.get('')
  if (!root || root.state !== 'ok') return out
  const chev = root.listing.folders.length > 0
  const walk = (listing: FolderListing, depth: number) => {
    const dirs = [...listing.folders].sort((a, b) => cmpName(a.name, b.name))
    for (const d of dirs) {
      const open = expanded.has(d.path)
      const st = store.get(d.path)
      out.push({ node: { kind: 'dir', name: d.name, path: d.path, isRun: d.is_run, entry: d }, depth, open, chev, loading: open && (!st || st.state === 'loading') })
      if (open && st?.state === 'ok') walk(st.listing, depth + 1)
    }
    const files = listing.files.map((f) => ({ f, name: baseName(f.path) })).sort((a, b) => cmpName(a.name, b.name))
    for (const { f, name } of files) out.push({ node: { kind: 'file', name, path: f.path, info: f }, depth, open: false, chev, loading: false })
  }
  walk(root.listing, 0)
  return out
}

/** The slice [start, end) of `count` rows to render for a scroll position and a viewport height, with overscan. */
export function windowOf(count: number, scrollTop: number, height: number, rowHeight = ROW_HEIGHT, overscan = OVERSCAN): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const visible = Math.ceil(Math.max(0, height) / rowHeight) + 1
  const end = Math.min(count, first + visible + overscan)
  const start = Math.max(0, Math.min(first - overscan, end - visible - 2 * overscan))
  return { start, end }
}

export function ancestors(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

/** The kind of a path the store knows: a listed file's kind, 'dir' for a listed folder, undefined when unknown yet. */
export function kindIn(store: FolderStore, path: string): SourceInfo['kind'] | 'dir' | undefined {
  if (path === '' || store.has(path)) return 'dir'
  const parent = store.get(parentOf(path))
  if (!parent || parent.state !== 'ok') return undefined
  const file = parent.listing.files.find((f) => f.path === path)
  if (file) return file.kind
  return parent.listing.folders.some((d) => d.path === path) ? 'dir' : undefined
}

export interface FolderStoreHandle {
  store: FolderStore
  /** fetch a folder's listing unless the store has it or is fetching it */
  ensure: (path: string) => void
  /** drop everything and fetch again (a working-directory change) */
  reset: () => void
}

/** The folders fetched so far for a workspace, one request per folder, shared by the tree and the reader's kind lookup. */
export function useFolderStore(ws: string): FolderStoreHandle {
  const [store, setStore] = useState<Map<string, FolderState>>(() => new Map())
  const storeRef = useRef(store)
  storeRef.current = store
  const inflight = useRef(new Set<string>())
  const gen = useRef(0)
  const ensure = useCallback(
    (path: string) => {
      if (storeRef.current.has(path) || inflight.current.has(path)) return
      inflight.current.add(path)
      const my = gen.current
      setStore((s) => new Map(s).set(path, { state: 'loading' }))
      scaleApi
        .folder(ws, path)
        .then((listing) => my === gen.current && setStore((s) => new Map(s).set(path, { state: 'ok', listing })))
        .catch((e: Error) => my === gen.current && setStore((s) => new Map(s).set(path, { state: 'error', message: e.message })))
        .finally(() => inflight.current.delete(path))
    },
    [ws],
  )
  const reset = useCallback(() => {
    gen.current += 1
    inflight.current.clear()
    setStore(new Map())
  }, [])
  useEffect(() => reset, [ws, reset])
  return useMemo(() => ({ store, ensure, reset }), [store, ensure, reset])
}

interface Props {
  folders: FolderStoreHandle
  error: string | null
  activePath: string | null
  onOpen: (path: string, kind?: 'dir') => void
  /** the dots and stripes of a file row: the labels that are on and mark something in it */
  marksOf?: (path: string) => { dots: Presence[]; stripes: Presence[] }
  /** the dots of a collapsed folder row: the labels that are on and mark something under it */
  folderDotsOf?: (path: string) => readonly Presence[]
}

const GUIDE_X = 7
const INDENT = 14

export function Tree({ folders, error, activePath, onOpen, marksOf, folderDotsOf }: Props) {
  const { store, ensure } = folders
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [seeded, setSeeded] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const treeRef = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef<string | null>(null)
  const root = store.get('')

  useEffect(() => ensure(''), [ensure, store])
  useEffect(() => {
    if (!root) setSeeded(false)
  }, [root])

  // the root's own folders open by default, runs closed
  useEffect(() => {
    if (seeded || !root || root.state !== 'ok') return
    const top = root.listing.folders.filter((d) => !d.is_run).map((d) => d.path)
    setExpanded((prev) => new Set([...prev, ...top]))
    setSeeded(true)
  }, [root, seeded])

  // an expanded folder the store does not know yet is fetched
  useEffect(() => {
    for (const p of expanded) if (!store.has(p)) ensure(p)
  }, [expanded, store, ensure])

  // the open file's folders unfold
  useEffect(() => {
    if (!activePath) return
    const anc = ancestors(activePath)
    if (!anc.length) return
    setExpanded((prev) => (anc.every((a) => prev.has(a)) ? prev : new Set([...prev, ...anc])))
  }, [activePath])

  const rows = useMemo(() => rowsOf(store, expanded), [store, expanded])

  // the viewport: its height for the window, its scroll position
  useEffect(() => {
    const el = treeRef.current
    if (!el) return
    setHeight(el.clientHeight || 600)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 600))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // the active row scrolls into view once it exists, once per active path
  useEffect(() => {
    if (!activePath || scrolledFor.current === activePath) return
    const i = rows.findIndex((r) => r.node.path === activePath)
    const el = treeRef.current
    if (i < 0 || !el) return
    scrolledFor.current = activePath
    const top = i * ROW_HEIGHT
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - Math.floor(el.clientHeight / 2))
      setScrollTop(el.scrollTop)
    }
  }, [activePath, rows])

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const { start, end } = windowOf(rows.length, scrollTop, height)
  return (
    <div className="files-tree" role="tree" ref={treeRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      {error && <div className="files-empty">Could not load the files. {error}</div>}
      {!error && root?.state === 'error' && <div className="files-empty">Could not load the files. {root.message}</div>}
      {!error && (!root || root.state === 'loading') && (
        <div className="files-empty">
          <Spinner size={10} label="Loading" />
        </div>
      )}
      {!error && emptyFolderNote(root) && <div className="files-empty">{emptyFolderNote(root)}</div>}
      <div className="files-rows" style={{ paddingTop: start * ROW_HEIGHT, paddingBottom: Math.max(0, rows.length - end) * ROW_HEIGHT }} data-rows={rows.length}>
        {rows.slice(start, end).map((row) => {
          const n = row.node
          const isDir = n.kind === 'dir'
          const active = n.path === activePath
          const marks = !isDir && marksOf ? marksOf(n.path) : null
          const dots = isDir ? (!row.open && folderDotsOf ? folderDotsOf(n.path) : []) : marks?.dots ?? []
          const activate = () => (isDir ? toggle(n.path) : onOpen(n.path))
          return (
            <div
              key={n.path}
              className={'files-row' + (isDir ? ' files-dir' : ' files-file') + (active ? ' active' : '') + ((isDir ? n.entry.hidden : n.info.hidden) ? ' files-hidden' : '')}
              style={{ '--depth': row.depth } as CSSProperties}
              role="treeitem"
              tabIndex={0}
              aria-expanded={isDir ? row.open : undefined}
              aria-selected={active ? true : undefined}
              aria-level={row.depth + 1}
              data-anchor={isDir ? undefined : n.path}
              data-anchor-text={isDir ? undefined : n.path}
              onClick={activate}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  activate()
                }
              }}
            >
              {Array.from({ length: row.depth + 1 }, (_, i) => (
                <span key={i} className="files-guide" style={{ left: GUIDE_X + i * INDENT }} />
              ))}
              {marks?.stripes.map((st, i) => (
                <span key={st.id} className="files-stripe" style={{ left: 12 + row.depth * INDENT - i * 5, background: st.colour }} aria-label={`${st.name}, a file label`} />
              ))}
              {isDir ? <Icon className="files-glyph files-chevron" name="chevron-right" size={13} /> : <Icon className="files-glyph" name={glyphOf(n.name)} size={13} />}
              <span className="files-name">{n.name}</span>
              {row.loading && <Spinner size={10} className="files-row-spinner" />}
              {dots.length > 0 && (
                <span className="files-dots">
                  {dots.map((d) =>
                    d.multi ? (
                      <span key={d.id} className="files-dot-tag" style={{ color: d.colour }} aria-label={d.name}>
                        <Icon name="label" size={MARK_TAG_PX} />
                      </span>
                    ) : (
                      <span key={d.id} className="files-dot" style={{ background: d.colour }} aria-label={d.name} />
                    ),
                  )}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
