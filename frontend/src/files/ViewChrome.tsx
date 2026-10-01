// What thimble draws above every view's page, outside its frame: the view's residue, a line that opens the list of what
// it leaves out (ResidueList) under the head, which says so when nothing is, and the count of the fields its reader
// derived and the labels it shows (DerivedData), which a click lists.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { LabelChip } from '../chat/SurfaceChips'
import { Popover } from '../components/Menu'
import { api } from '../lib/api'
import type { Concept, ViewProblems, ViewShown } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { globMatches } from './labels'
import { fmtSize } from './Tree'
import type { FilesLabels } from './useLabels'

export interface ViewNotes {
  problems: ViewProblems | null
  shown: ViewShown | null
}

/** The view's reader problems and what it does not show and derived, at `version`, read again when either changes. */
export function useViewNotes(ws: string, slug: string, version?: string): ViewNotes {
  const [problems, setProblems] = useState<ViewProblems | null>(null)
  const [shown, setShown] = useState<ViewShown | null>(null)
  useEffect(() => {
    let alive = true
    setProblems(null)
    setShown(null)
    api
      .viewProblems(ws, slug, version)
      .then((p) => alive && setProblems(p))
      .catch(() => undefined)
    api
      .viewShown(ws, slug, version)
      .then((s) => alive && setShown(s))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws, slug, version])
  return { problems, shown }
}

/** The labels on in Files that mark any of the files the view claims: the labels its page shows. */
export function useShownLabels(labels: FilesLabels, claims: readonly string[] | undefined): Concept[] {
  const { on, presence } = labels
  return useMemo(() => on.filter((k) => Object.keys(presence.get(k.id) ?? {}).some((p) => (claims ?? []).some((g) => globMatches(p, g)))), [on, presence, claims])
}

/** Whether ViewNotesLine draws anything: once the view's notes have come, it always says what the view leaves out. */
export function hasNotes(notes: ViewNotes, shownLabels: readonly Concept[]): boolean {
  return !!(notes.shown || notes.problems?.count || shownLabels.length)
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
    problems: notes.problems?.count ? notes.problems : null,
    unplaced: notes.shown?.unplaced?.count ? notes.shown.unplaced : null,
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

interface LineProps {
  ws: string
  name: string
  notes: ViewNotes
  shownLabels: readonly Concept[]
  /** the residue list is open */
  residueOpen: boolean
  onResidue: () => void
}

/** The residue line and the derived data, in the order the view pane's head lists them after its files. */
export function ViewNotesLine({ ws, name, notes, shownLabels, residueOpen, onResidue }: LineProps) {
  return (
    <>
      <ResidueLine notes={notes} open={residueOpen} onToggle={onResidue} />
      <DerivedData ws={ws} shown={notes.shown} labels={shownLabels} name={name} />
    </>
  )
}

/** What the view leaves out, in a few words, which a click opens as the list under the head: the files not read, those
 * hidden, those missing, the records not placed, and in red the lines that could not be parsed. With none it says how
 * many files it read, once that count is known. */
function ResidueLine({ notes, open, onToggle }: { notes: ViewNotes; open: boolean; onToggle: () => void }) {
  if (!notes.shown && !notes.problems?.count) return null
  const r = residueOf(notes)
  const parts: string[] = []
  if (r.unreadCount) parts.push(`${count(r.unreadCount, 'file', 'files')} not read`)
  if (r.hiddenCount) parts.push(`${r.hiddenCount.toLocaleString()} hidden`)
  if (r.missing.length) parts.push(`${r.missing.length.toLocaleString()} missing`)
  if (r.unplaced) parts.push(`${count(r.unplaced.count, 'record', 'records')} not placed`)
  const failed = r.problems ? `${count(r.problems.count, wholeFiles(r.problems) ? 'file' : 'line', wholeFiles(r.problems) ? 'files' : 'lines')} not parsed` : ''
  if (!hasResidue(r) && notes.shown) {
    const n = notes.shown.files
    return <span className="view-pane-residue-none">{n === 1 ? '1 file read' : `All ${n.toLocaleString()} files read`}</span>
  }
  return (
    <button type="button" className="view-pane-files view-pane-residue" aria-expanded={open} onClick={onToggle}>
      {parts.join(' · ')}
      {parts.length > 0 && failed && ' · '}
      {failed && <span className="view-pane-residue-failed">{failed}</span>}
    </button>
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
          {r.unplaced.count > r.unplaced.examples.length && <span className="view-pane-list-more">and {(r.unplaced.count - r.unplaced.examples.length).toLocaleString()} more</span>}
        </section>
      )}
      {r.problems && (
        <section>
          <h4>Not parsed</h4>
          {r.problems.examples.map((x, i) => (
            <button key={`${x.ref}:${i}`} type="button" className="view-pane-list-item" disabled={!x.ref} onClick={() => onPick(x.ref)}>
              <span className="mono">{x.ref}</span>
              <span className="view-pane-list-why">{x.why}</span>
            </button>
          ))}
          {r.problems.count > r.problems.examples.length && <span className="view-pane-list-more">and {(r.problems.count - r.problems.examples.length).toLocaleString()} more</span>}
        </section>
      )}
    </div>
  )
}

/** "Derived data" with how many fields the view's reader made rather than read, how many of them are inferred, and how
 * many labels it shows, which a click lists: the inferred fields first, each field with how and from what, then each
 * label with its description. */
function DerivedData({ ws, shown, labels, name }: { ws: string; shown: ViewShown | null; labels: readonly Concept[]; name: string }) {
  const [at, setAt] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const fields = shown?.derived ?? []
  if (!fields.length && !labels.length) return null
  const inferred = fields.filter((d) => d.kind === 'inferred').length
  const counts = [fields.length ? count(fields.length, 'field', 'fields') : '', inferred ? `${inferred.toLocaleString()} inferred` : '', labels.length ? count(labels.length, 'label', 'labels') : ''].filter(Boolean)
  return (
    <>
      <button ref={setAt} type="button" className="view-pane-files" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Derived data: {counts.join(', ')}
      </button>
      <Popover anchor={at} open={open} onClose={() => setOpen(false)} label={`What ${name} derived`} className="view-pane-list">
        {[...fields].sort((a, b) => Number(b.kind === 'inferred') - Number(a.kind === 'inferred')).map((d) => (
          <div key={d.field} className="view-pane-list-row">
            <span>
              <span className="mono">{d.field}</span>
              {d.kind === 'inferred' && <span className="view-pane-list-kind"> inferred</span>}
              {d.from && <span className="view-pane-list-why"> from {d.from}</span>}
            </span>
            {d.how && <span className="view-pane-list-how">{d.how}</span>}
          </div>
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
