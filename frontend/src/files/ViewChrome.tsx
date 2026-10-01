// What thimble draws above every view's page, outside its frame: one quiet line under the view's name (ViewHeadLine)
// with the files it reads, what it leaves out, which a click opens as the list under the head (ResidueList), and the
// count of the fields its reader derived and the labels it shows (DerivedData), which a click lists; and the label
// filter with how many records it hides (ViewFilter). A file viewer's line says only what it leaves out of the file it
// shows.
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { LabelChip } from '../chat/SurfaceChips'
import { FilterChip } from '../components/FilterChip'
import { Popover } from '../components/Menu'
import { api } from '../lib/api'
import type { Concept, ViewDerived, ViewProblems, ViewShown } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { globMatches, type LabelFilter } from './labels'
import { fmtSize } from './Tree'
import type { FilesLabels } from './useLabels'

export interface ViewNotes {
  problems: ViewProblems | null
  shown: ViewShown | null
}

/** The view's reader problems and what it does not show and derived, at `version`, read again when either changes;
 * with `path`, of that one file, as a file viewer shows it. */
export function useViewNotes(ws: string, slug: string, version?: string, path?: string): ViewNotes {
  const [problems, setProblems] = useState<ViewProblems | null>(null)
  const [shown, setShown] = useState<ViewShown | null>(null)
  useEffect(() => {
    let alive = true
    setProblems(null)
    setShown(null)
    api
      .viewProblems(ws, slug, version, path)
      .then((p) => alive && setProblems(p))
      .catch(() => undefined)
    api
      .viewShown(ws, slug, version, path)
      .then((s) => alive && setShown(s))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws, slug, version, path])
  return { problems, shown }
}

/** The labels on in Files that mark any of the files the view claims: the labels its page shows. */
export function useShownLabels(labels: FilesLabels, claims: readonly string[] | undefined): Concept[] {
  const { on, presence } = labels
  return useMemo(() => on.filter((k) => Object.keys(presence.get(k.id) ?? {}).some((p) => (claims ?? []).some((g) => globMatches(p, g)))), [on, presence, claims])
}

/** The labels on in Files that mark the one file a file viewer shows, matched by its path as it is, not as a glob. */
export function useLabelsOfFile(labels: FilesLabels, path: string): Concept[] {
  const { on, presence } = labels
  return useMemo(() => on.filter((k) => Object.prototype.hasOwnProperty.call(presence.get(k.id) ?? {}, path)), [on, presence, path])
}

/** The label filter a view keeps its records to, as the chip that clears it, and how many of the view's records it
 * hides once that count is exact (ViewerFrame onHidden). */
export function ViewFilter({ ws, filter, name, hidden, className }: { ws: string; filter: LabelFilter; name: string; hidden: number | null; className?: string }) {
  return (
    <>
      <FilterChip concept={filter.concept} name={name} value={filter.value} className={className} onClear={() => void api.deleteFilter(ws, 'files').catch(() => undefined)} />
      {!!hidden && (
        <span className="view-pane-hidden" title={`Records of this view the filter ${name} · ${filter.value} hides`}>
          {hidden.toLocaleString()} hidden
        </span>
      )}
    </>
  )
}

/** Whether a file viewer's ViewHeadLine draws anything: what it leaves out of the file, its derived fields or the
 * labels it shows. */
export function fileLineShows(notes: ViewNotes, shownLabels: readonly Concept[]): boolean {
  return hasResidue(residueOf(notes)) || !!notes.shown?.derived.length || shownLabels.length > 0
}

type ResidueFile = ViewShown['not_shown']['files'][number]

/** What a view leaves out, by kind: the claimed files and those beside them it neither read to the end nor hid, those
 * its reader hid with a why, what the claims expect and the corpus lacks, the lines its reader could not parse and the
 * records it could not place. */
export interface Residue {
  /** the files listed, and how many there are in all, which the server counts beyond those it lists */
  unread: ResidueFile[]
  unreadCount: number
  hidden: ResidueFile[]
  hiddenCount: number
  missing: { path: string; why: string }[]
  problems: ViewProblems | null
  unplaced: ViewProblems | null
}

export function residueOf(notes: ViewNotes): Residue {
  const ns = notes.shown?.not_shown
  const files = ns?.files ?? []
  return {
    unread: files.filter((f) => !f.why),
    unreadCount: ns?.unexplained ?? 0,
    hidden: files.filter((f) => !!f.why),
    hiddenCount: (ns?.count ?? 0) - (ns?.unexplained ?? 0),
    missing: notes.shown?.missing ?? [],
    problems: notes.problems && (notes.problems.count ?? notes.problems.examples.length) ? notes.problems : null,
    unplaced: notes.shown?.unplaced && (notes.shown.unplaced.count ?? notes.shown.unplaced.examples.length) ? notes.shown.unplaced : null,
  }
}

export function hasResidue(r: Residue): boolean {
  return !!(r.unreadCount || r.hiddenCount || r.missing.length || r.problems || r.unplaced)
}

/** Whether the problems name whole files, as a reader of PDFs does, rather than lines. */
function wholeFiles(p: ViewProblems): boolean {
  return p.examples.length > 0 && p.examples.every((x) => x.ref && !x.ref.includes('#'))
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** Whether the residue list under a view's head is open, kept per view in this browser. */
export function useResidueOpen(ws: string, slug: string): [boolean, () => void] {
  const key = storageKey(ws, `residue:${slug}`)
  const [open, setOpen] = useState(() => readStorage<boolean>(key, false) === true)
  useEffect(() => setOpen(readStorage<boolean>(key, false) === true), [key])
  const toggle = useCallback(() => {
    setOpen((o) => {
      writeStorage(key, !o)
      return !o
    })
  }, [key])
  return [open, toggle]
}

/** "1 unreadable line", "3 unreadable files", and "Unreadable lines" while the count is not known */
function unreadable(p: ViewProblems): string {
  const what = wholeFiles(p) ? 'file' : 'line'
  return p.count == null ? `Unreadable ${what}s` : `${p.count.toLocaleString()} unreadable ${p.count === 1 ? what : `${what}s`}`
}

/** What a view leaves out, in a few words each, in the order the list under the head gives them. Of a whole view: the
 * files not read, those hidden, those missing, the records not placed and the unreadable lines or files. Of one file
 * (a file viewer): whether it is hidden or read only in part, its records not placed and its unreadable lines. */
export function residueWords(notes: ViewNotes, file = false): string[] {
  const r = residueOf(notes)
  const out: string[] = []
  if (file) {
    const own = notes.shown?.not_shown.files[0]
    if (own) out.push(own.why ? 'Hidden' : own.read ? 'Partly read' : 'Not read')
  } else {
    if (r.unreadCount) out.push(`${r.unreadCount.toLocaleString()} not read`)
    if (r.hiddenCount) out.push(`${r.hiddenCount.toLocaleString()} hidden`)
    if (r.missing.length) out.push(`${r.missing.length.toLocaleString()} missing`)
  }
  if (r.unplaced) out.push(r.unplaced.count == null ? 'Records not placed' : `${count(r.unplaced.count, 'record', 'records')} not placed`)
  if (r.problems) out.push(unreadable(r.problems))
  return out
}

interface FilesProps {
  /** the files it reads, the first of them, and how many there are */
  list: readonly string[]
  n: number
  /** the file Raw shows, marked in the list */
  current: string | null
  onPick: (path: string) => void
}

interface LineProps {
  ws: string
  name: string
  notes: ViewNotes
  shownLabels: readonly Concept[]
  /** the residue list is open */
  residueOpen: boolean
  onResidue: () => void
  /** a corpus view's files, first on the line */
  files?: FilesProps
  /** after the files, such as the file Raw shows */
  after?: ReactNode
  /** a file viewer's line, of the one file it shows */
  file?: boolean
}

/** The quiet line under a view's name, its items apart by dots: the files it reads ("All 12 files read" once its notes
 * say it leaves nothing out), what it leaves out, each part opening the list under the head, and its derived data. A
 * file viewer's line has no files, and says nothing of the file when it reads cleanly. */
export function ViewHeadLine({ ws, name, notes, shownLabels, residueOpen, onResidue, files, after, file = false }: LineProps) {
  const words = residueWords(notes, file)
  // both notes read, so a file count is not called complete before the unreadable lines are known
  const clean = !!notes.shown && !!notes.problems && !words.length
  const items: [string, ReactNode][] = []
  if (files && files.n) items.push(['files', <ViewFiles name={name} {...files} clean={clean} />])
  if (after) items.push(['after', after])
  for (const w of words)
    items.push([
      w,
      <button type="button" className="view-pane-files view-pane-residue" aria-expanded={residueOpen} onClick={onResidue}>
        {w}
      </button>,
    ])
  if (notes.shown?.derived.length || shownLabels.length) items.push(['derived', <DerivedData ws={ws} shown={notes.shown} labels={shownLabels} name={name} />])
  if (!items.length) return null
  return (
    <span className="view-pane-sub">
      {items.map(([key, it], i) => (
        <Fragment key={key}>
          {i > 0 && (
            <span className="view-pane-dot" aria-hidden="true">
              ·
            </span>
          )}
          {it}
        </Fragment>
      ))}
    </span>
  )
}

/** The files a view reads: their count, the file's name when it reads one, or "All 12 files read" when it leaves
 * nothing out, which a click lists them under; a file picked there opens in Raw. */
function ViewFiles({ name, list, n, current, onPick, clean }: FilesProps & { name: string; clean: boolean }) {
  const [at, setAt] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button ref={setAt} type="button" className="view-pane-files" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {n === 1 ? list[0] : clean ? `All ${n.toLocaleString()} files read` : `${n.toLocaleString()} files`}
      </button>
      <Popover anchor={at} open={open} onClose={() => setOpen(false)} label={`The files ${name} reads`} className="view-pane-list">
        {list.map((f) => (
          <button
            key={f}
            type="button"
            className={'view-pane-list-item mono' + (f === current ? ' is-current' : '')}
            onClick={() => {
              setOpen(false)
              onPick(f)
            }}
          >
            {f}
          </button>
        ))}
        {n > list.length && <span className="view-pane-list-more">and {(n - list.length).toLocaleString()} more</span>}
      </Popover>
    </>
  )
}

/** The list of what a view leaves out, under its head, by kind: each file with why its reader hid it, else how much of
 * it was read, each claim that matches no file, and each line that could not be parsed with the reader's why. A file
 * or line picked opens in Raw. */
export function ResidueList({ notes, onPick }: { notes: ViewNotes; onPick: (ref: string) => void }) {
  const r = residueOf(notes)
  if (!hasResidue(r)) return null
  const file = (f: ResidueFile) => (
    <button key={f.path} type="button" className="view-pane-list-item" onClick={() => onPick(f.path)}>
      <span className="mono">{f.path}</span>
      <span className="view-pane-list-why">{f.why || (f.read ? `read ${fmtSize(f.read)} of ${fmtSize(f.size)}` : f.claimed === false ? 'not claimed' : 'not read')}</span>
    </button>
  )
  return (
    <div className="view-pane-residue-list" role="region" aria-label="What the view leaves out">
      {r.unreadCount > 0 && (
        <section>
          <h4>Not read</h4>
          {r.unread.map(file)}
          {r.unreadCount > r.unread.length && <span className="view-pane-list-more">and {(r.unreadCount - r.unread.length).toLocaleString()} more</span>}
        </section>
      )}
      {r.hiddenCount > 0 && (
        <section>
          <h4>Hidden</h4>
          {r.hidden.map(file)}
          {r.hiddenCount > r.hidden.length && <span className="view-pane-list-more">and {(r.hiddenCount - r.hidden.length).toLocaleString()} more</span>}
        </section>
      )}
      {r.missing.length > 0 && (
        <section>
          <h4>Missing</h4>
          {r.missing.map((m) => (
            <div key={m.path} className="view-pane-list-row">
              <span className="mono">{m.path}</span>
              <span className="view-pane-list-why">{m.why}</span>
            </div>
          ))}
        </section>
      )}
      {r.unplaced && (
        <section>
          <h4>Not placed</h4>
          {r.unplaced.examples.map((x, i) => (
            <button key={`${x.ref}:${i}`} type="button" className="view-pane-list-item" disabled={!x.ref} onClick={() => onPick(x.ref)}>
              <span className="mono">{x.ref}</span>
              <span className="view-pane-list-why">{x.why}</span>
            </button>
          ))}
          {r.unplaced.count != null && r.unplaced.count > r.unplaced.examples.length && <span className="view-pane-list-more">and {(r.unplaced.count - r.unplaced.examples.length).toLocaleString()} more</span>}
        </section>
      )}
      {r.problems && (
        <section>
          <h4>Unreadable</h4>
          {r.problems.examples.map((x, i) => (
            <button key={`${x.ref}:${i}`} type="button" className="view-pane-list-item" disabled={!x.ref} onClick={() => onPick(x.ref)}>
              <span className="mono">{x.ref}</span>
              <span className="view-pane-list-why">{x.why}</span>
            </button>
          ))}
          {r.problems.count != null && r.problems.count > r.problems.examples.length && <span className="view-pane-list-more">and {(r.problems.count - r.problems.examples.length).toLocaleString()} more</span>}
        </section>
      )}
    </div>
  )
}

/** "Derived data" with how many fields the view's reader made rather than read and how many labels it shows, which a
 * click lists: the fields of each kind of record under its name, the computed ones first and marked so, each with how
 * and from what, then each label with its description. */
function DerivedData({ ws, shown, labels, name }: { ws: string; shown: ViewShown | null; labels: readonly Concept[]; name: string }) {
  const [at, setAt] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const fields = shown?.derived ?? []
  if (!fields.length && !labels.length) return null
  const counts = [fields.length ? count(fields.length, 'field', 'fields') : '', labels.length ? count(labels.length, 'label', 'labels') : ''].filter(Boolean)
  const groups = byRecord(fields)
  return (
    <>
      <button ref={setAt} type="button" className="view-pane-files" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Derived data: {counts.join(', ')}
      </button>
      <Popover anchor={at} open={open} onClose={() => setOpen(false)} label={`What ${name} derived`} className="view-pane-list">
        {groups.map(([record, ds]) => (
          <section key={record} className="view-pane-list-group">
            {(record || groups.length > 1) && <h4 className="view-pane-list-head">{record ? `Per ${record}` : 'Other fields'}</h4>}
            {ds.map((d) => (
              <div key={d.field} className="view-pane-list-row">
                <span>
                  <span className="mono">{d.field}</span>
                  {d.kind === 'inferred' && <span className="view-pane-list-kind"> computed</span>}
                  {d.from && <span className="view-pane-list-why"> from {d.from}</span>}
                </span>
                {d.how && <span className="view-pane-list-how">{d.how}</span>}
              </div>
            ))}
          </section>
        ))}
        {fields.length > 0 && labels.length > 0 && <hr className="view-pane-list-rule" />}
        {labels.map((k) => (
          <div key={k.id} className="view-pane-list-row">
            <LabelChip ws={ws} name={k.name} />
            {k.description && <span className="view-pane-list-why">{k.description}</span>}
          </div>
        ))}
      </Popover>
    </>
  )
}

/** The derived fields by the kind of record that holds them, in the order the kinds first appear, the computed ones
 * first in each; fields that name no kind form one group ''. */
function byRecord(fields: readonly ViewDerived[]): [string, ViewDerived[]][] {
  const out = new Map<string, ViewDerived[]>()
  for (const d of fields) {
    const k = d.record ?? ''
    out.set(k, [...(out.get(k) ?? []), d])
  }
  return [...out].map(([k, ds]) => [k, [...ds].sort((a, b) => Number(b.kind === 'inferred') - Number(a.kind === 'inferred'))])
}
