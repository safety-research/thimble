// What thimble draws above every view's page, outside its frame, each a line that a click opens as a list and nothing
// while it is empty: the files the view claims and does not show whole (NotShown), the fields its reader derived and
// the labels it shows (DerivedData), and in red the lines its reader could not read (ReaderProblems).
import { useEffect, useMemo, useState } from 'react'
import { LabelChip } from '../chat/SurfaceChips'
import { Popover } from '../components/Menu'
import { api } from '../lib/api'
import type { Concept, ViewProblems, ViewShown } from '../lib/types'
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

const globs = new Map<string, RegExp>()

/** A claim's glob as the server matches it (views.glob_matches, Python's fnmatch): `*` crosses folders, and a glob
 * matches the whole path or its file name. */
export function globMatches(path: string, glob: string): boolean {
  if (!glob || glob === '*') return true
  let re = globs.get(glob)
  if (!re) {
    let src = ''
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i]
      const end = ch === '[' ? glob.indexOf(']', i + 2) : -1
      if (ch === '*') src += '.*'
      else if (ch === '?') src += '.'
      else if (end > 0) {
        const body = glob.slice(i + 1, end).replace(/\\/g, '\\\\')
        src += '[' + (body[0] === '!' ? '^' + body.slice(1) : body) + ']'
        i = end
      } else src += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
    re = new RegExp('^' + src + '$', 's')
    globs.set(glob, re)
  }
  return re.test(path) || re.test(path.slice(path.lastIndexOf('/') + 1))
}

/** The labels on in Files that mark any of the files the view claims: the labels its page shows. */
export function useShownLabels(labels: FilesLabels, claims: readonly string[] | undefined): Concept[] {
  const { on, presence } = labels
  return useMemo(() => on.filter((k) => Object.keys(presence.get(k.id) ?? {}).some((p) => (claims ?? []).some((g) => globMatches(p, g)))), [on, presence, claims])
}

/** Whether ViewNotesLine draws anything. */
export function hasNotes(notes: ViewNotes, shownLabels: readonly Concept[]): boolean {
  return !!(notes.problems?.count || notes.shown?.not_shown.count || notes.shown?.derived.length || shownLabels.length)
}

interface LineProps {
  ws: string
  name: string
  notes: ViewNotes
  shownLabels: readonly Concept[]
  /** a file or a line picked in a list */
  onPick: (ref: string) => void
}

/** The three in a row, in the order the view pane's head lists them after its files. */
export function ViewNotesLine({ ws, name, notes, shownLabels, onPick }: LineProps) {
  return (
    <>
      <NotShown shown={notes.shown} name={name} onPick={onPick} />
      <DerivedData ws={ws} shown={notes.shown} labels={shownLabels} name={name} />
      <ReaderProblems problems={notes.problems} onPick={onPick} />
    </>
  )
}

/** The files the view claims and does not show whole: their count, which a click lists, each with why its reader hides
 * it, else how much of it build_index read. */
function NotShown({ shown, name, onPick }: { shown: ViewShown | null; name: string; onPick: (path: string) => void }) {
  const [at, setAt] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const n = shown?.not_shown.count ?? 0
  if (!shown || !n) return null
  const { files } = shown.not_shown
  return (
    <>
      <button ref={setAt} type="button" className="view-pane-files" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {n.toLocaleString()} {n === 1 ? 'file' : 'files'} not shown
      </button>
      <Popover anchor={at} open={open} onClose={() => setOpen(false)} label={`The files ${name} does not show`} className="view-pane-list">
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            className="view-pane-list-item"
            onClick={() => {
              setOpen(false)
              onPick(f.path)
            }}
          >
            <span className="mono">{f.path}</span>
            <span className="view-pane-list-why">{f.why || (f.read ? `read ${fmtSize(f.read)} of ${fmtSize(f.size)}` : 'not read')}</span>
          </button>
        ))}
        {n > files.length && <span className="view-pane-list-more">and {(n - files.length).toLocaleString()} more</span>}
      </Popover>
    </>
  )
}

/** "Derived data", which a click lists: the fields the view's reader made rather than read, each with how and from
 * what, then the labels the view shows, each with its description. */
function DerivedData({ ws, shown, labels, name }: { ws: string; shown: ViewShown | null; labels: readonly Concept[]; name: string }) {
  const [at, setAt] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const fields = shown?.derived ?? []
  if (!fields.length && !labels.length) return null
  return (
    <>
      <button ref={setAt} type="button" className="view-pane-files" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Derived data
      </button>
      <Popover anchor={at} open={open} onClose={() => setOpen(false)} label={`What ${name} derived`} className="view-pane-list">
        {fields.map((d) => (
          <div key={d.field} className="view-pane-list-row">
            <span>
              <span className="mono view-pane-derived">{d.field}</span>
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

/** The lines of a view's files its reader could not read and left out, in red: their count, which a click lists the
 * first of, each with why; a line picked there opens in Raw. */
function ReaderProblems({ problems, onPick }: { problems: ViewProblems | null; onPick: (ref: string) => void }) {
  const [at, setAt] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  if (!problems?.count) return null
  const { count, examples } = problems
  const lines = `${count.toLocaleString()} ${count === 1 ? 'line' : 'lines'}`
  return (
    <>
      <button ref={setAt} type="button" className="view-pane-problems" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {lines} could not be read
      </button>
      <Popover anchor={at} open={open} onClose={() => setOpen(false)} label="Lines the view could not read" className="view-pane-list">
        <span className="view-pane-list-head">
          {lines} of the data could not be read and {count === 1 ? 'is' : 'are'} left out of the view
        </span>
        {examples.map((x, i) => (
          <button
            key={`${x.ref}:${i}`}
            type="button"
            className="view-pane-list-item"
            disabled={!x.ref}
            onClick={() => {
              setOpen(false)
              onPick(x.ref)
            }}
          >
            <span className="mono">{x.ref}</span>
            <span className="view-pane-list-why">{x.why}</span>
          </button>
        ))}
        {count > examples.length && <span className="view-pane-list-more">and {(count - examples.length).toLocaleString()} more</span>}
      </Popover>
    </>
  )
}
