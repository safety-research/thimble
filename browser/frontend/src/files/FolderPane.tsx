// A folder open in the File browser, as a ref that names a folder opens it: its folders, then its files, in the tree's
// order, each with its size or the files it holds where the server knows them. Only the rows in view are rendered. A
// row opens its file or folder in a tab of its own.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { baseName, cmpName, fmtSize, glyphOf, ROW_HEIGHT, windowOf, type FolderState } from './Tree'

interface FolderRow {
  path: string
  name: string
  dir: boolean
  hidden: boolean
  meta: string
}

const filesWord = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`

/** The rows of a folder's listing: its folders, then its files, each in natural order. Pure. */
export function folderRows(state: FolderState | undefined): FolderRow[] {
  if (state?.state !== 'ok') return []
  const { folders, files } = state.listing
  const dirs = [...folders]
    .sort((a, b) => cmpName(a.name, b.name))
    .map((d) => ({ path: d.path, name: d.name, dir: true, hidden: !!d.hidden, meta: d.n_files != null ? filesWord(d.n_files) : '' }))
  const own = files
    .map((f) => ({ path: f.path, name: baseName(f.path), dir: false, hidden: !!f.hidden, meta: f.size_bytes != null ? fmtSize(f.size_bytes) : '' }))
    .sort((a, b) => cmpName(a.name, b.name))
  return [...dirs, ...own]
}

export function FolderPane({ state, lead, onOpen }: { state: FolderState | undefined; lead: ReactNode; onOpen: (path: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  useEffect(() => {
    const el = box.current
    if (!el) return
    setHeight(el.clientHeight || 600)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 600))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const rows = useMemo(() => folderRows(state), [state])
  const { start, end } = windowOf(rows.length, scrollTop, height)
  const key = (path: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(path)
    }
  }
  return (
    <div className="reader">
      <div className="reader-bar">{lead}</div>
      <div className="folder-pane" ref={box} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        {(!state || state.state === 'loading') && (
          <div className="files-empty">
            <Spinner size={10} label="Loading" />
          </div>
        )}
        {state?.state === 'error' && <div className="files-empty">Could not load the folder. {state.message}</div>}
        {state?.state === 'ok' && !rows.length && <div className="files-empty">This folder is empty.</div>}
        <div className="files-rows" role="list" style={{ paddingTop: start * ROW_HEIGHT, paddingBottom: Math.max(0, rows.length - end) * ROW_HEIGHT }}>
          {rows.slice(start, end).map((r) => (
            <div
              key={r.path}
              role="listitem"
              tabIndex={0}
              className={'files-row folder-pane-row' + (r.dir ? ' files-dir' : ' files-file') + (r.hidden ? ' files-hidden' : '')}
              data-anchor={r.dir ? undefined : r.path}
              data-anchor-text={r.dir ? undefined : r.path}
              onClick={() => onOpen(r.path)}
              onKeyDown={key(r.path)}
            >
              <Icon className="files-glyph" name={r.dir ? 'folder' : glyphOf(r.name)} size={13} />
              <span className="files-name">{r.name}</span>
              {r.meta && <span className="folder-pane-meta">{r.meta}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
