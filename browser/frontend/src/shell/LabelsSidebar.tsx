// The Labels and Comments sidebar, at the right of the page: the one place where the analyst sees, turns on and off,
// and opens the workspace's labels and its comment categories (the checks: the built-in Judgment calls, Unverifiable
// and Important details, and the analyst's own), as release 0.10's Labels and Checks sidebar had them in one list. The
// top bar's "Labels N · Comments N", just above it, opens and closes it.
//
// A label's row: its color, name, question, values with their counts, Show in (Files · Cards · Report, where it shows,
// with what it found there) and its switch. It opens its detail in the sidebar: the label's definition (a model label's
// question, editable; a regex or code shown as it is, the code's first lines with the rest a click away), its values
// with bars, what it reads and how it was made (regex, code, or read by Claude), with Edit, Show in, the records it
// found, each a click away, with "N more", and Run again, Color Files by it, Turn off and Delete. The labels end in
// "+ New label".
//
// A comment category's row: its color, name, open comments, definition, Show in (Chat · Cards · Report, each a toggle
// of where the check comments, with its comments there) and its switch, which shows or hides its comments everywhere.
// It opens its detail: the definition, editable, Show in, and its open comments, each a link to where it stands (a
// card, or the passage in the report) with Apply, which sends it to Claude in the chat, Go to it and Done
// (CommentsList.tsx). The analyst's and Claude's own notes, which no check made, are the category Notes.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useConcepts } from '../canvas/concepts'
import { LabelAsks } from '../chat/LabelAsk'
import { CommentRow, useComments, type CommentItem } from './CommentsList'
import { Button } from '../components/Button'
import { TextArea } from '../components/Field'
import { Icon } from '../components/Icon'
import { Switch } from '../components/Switch'
import { openLabelEditor } from '../files/LabelEditor'
import { classesOf, colourVar, howMade, labelDefinition, isFilesLabel, mainColour, unitWord } from '../files/labels'
import { checksApi, labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { teleport } from '../lib/teleport'
import type { Check, CheckCover, Concept, LabelRowText } from '../lib/types'
import { useChecks, type Checks } from '../report/Checks'
import { checkColour, coversOf, NOTE_COLOR } from '../report/checkComments'

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })
/** the found items a detail lists before "N more" */
const FOUND_SHOWN = 6
/** the records a label's "N more" adds at each click */
const FOUND_PAGE = 50
/** the key of the category of the comments no check made: the analyst's own and Claude's notes */
export const NOTES = '@notes'

/** The labels the sidebar lists: every label but a trial run on a few records. */
export const listedLabels = (concepts: ReadonlyMap<string, Concept>): Concept[] => [...concepts.values()].filter((k) => !k.trial)

/** The surface a label shows on, by what it labels: records and files in Files, cards on the canvas, sentences in the
 * report. Pure. */
export function labelSurface(k: Pick<Concept, 'unit'>): 'files' | 'cards' | 'report' {
  return k.unit === 'cell' ? 'cards' : k.unit === 'span' ? 'report' : 'files'
}

/** A comment category: a check, or the notes no check made, with its open comments. */
export interface Category {
  key: string
  check: Check | null
  name: string
  color: string
  items: CommentItem[]
}

/** The comment categories, pure: every check in the server's order, then a check the list does not hold that left
 * comments, then Notes when there are any. */
export function commentCategories(checks: readonly Check[], items: readonly CommentItem[]): Category[] {
  const of = (key: string | null) => items.filter((c) => c.check === key)
  const out: Category[] = checks.map((c) => ({ key: c.id, check: c, name: c.name, color: checkColour(c), items: of(c.id) }))
  const known = new Set(checks.map((c) => c.id))
  for (const id of new Set(items.map((c) => c.check).filter((x): x is string => x != null && !known.has(x)))) {
    out.push({ key: id, check: null, name: id, color: checkColour(null), items: of(id) })
  }
  const notes = of(null)
  if (notes.length) out.push({ key: NOTES, check: null, name: 'Notes', color: NOTE_COLOR, items: notes })
  return out
}

/** A check's covers with one surface turned on or off, in the server's order; null when that would leave none. Pure. */
export function withCover(check: Pick<Check, 'covers'>, cover: CheckCover, on: boolean): CheckCover[] | null {
  const now = new Set(coversOf(check))
  if (on) now.add(cover)
  else now.delete(cover)
  const next = (['documents', 'cards'] as const).filter((k) => now.has(k))
  return next.length ? next : null
}

type Detail = { kind: 'label' | 'comments'; id: string }

export function LabelsSidebar({ ws, onClose }: { ws: string; onClose: () => void }) {
  const concepts = useConcepts(ws)
  const labels = useMemo(() => listedLabels(concepts), [concepts])
  const checks = useChecks(ws)
  const comments = useComments(ws)
  const categories = useMemo(() => commentCategories(checks.list, comments.items), [checks.list, comments.items])
  const [detail, setDetail] = useState<Detail | null>(null)
  // a request from elsewhere to open one label's detail (a label's chip or tag)
  useEffect(() => bus.on('openLabels', (e) => setDetail(e.id ? { kind: 'label', id: e.id } : null)), [])
  const label = detail?.kind === 'label' ? concepts.get(detail.id) : undefined
  const category = detail?.kind === 'comments' ? categories.find((c) => c.key === detail.id) : undefined
  const open = !!(label || category)
  // Escape goes back from a detail to the list, then closes the sidebar. It is heard on the window, after the
  // document's own listeners: a menu or popover open over the page and a field with words typed in it keep their Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.isContentEditable || ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value)) return
      e.preventDefault()
      if (open) setDetail(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <aside className="lside" aria-label="Labels and comments">
      <header className="lside-head">
        {open ? (
          <button type="button" className="lside-back" onClick={() => setDetail(null)}>
            <Icon name="chevron-left" size={14} />
            {label ? 'Labels' : 'Comments'}
          </button>
        ) : (
          <h2 className="lside-heading">Labels and comments</h2>
        )}
        <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />
      </header>
      <div className="lside-body">
        {label ? (
          <LabelDetail ws={ws} label={label} onGone={() => setDetail(null)} />
        ) : category ? (
          <CategoryDetail ws={ws} category={category} checks={checks} onDone={comments.done} />
        ) : (
          <>
            <section className="lside-section" data-section="labels">
              <h3 className="lside-section-head">
                Labels <span className="lside-n">{labels.length}</span>
              </h3>
              {labels.map((k) => (
                <LabelRow key={k.id} ws={ws} label={k} onOpen={() => setDetail({ kind: 'label', id: k.id })} />
              ))}
              {!labels.length && <p className="lside-none lside-section-none">No labels yet.</p>}
              <NewLabel />
            </section>
            <section className="lside-section" data-section="comments">
              <h3 className="lside-section-head">
                Comments <span className="lside-n">{comments.items.length}</span>
              </h3>
              {categories.map((c) => (
                <CategoryRow key={c.key} ws={ws} category={c} checks={checks} onOpen={() => setDetail({ kind: 'comments', id: c.key })} />
              ))}
              {!categories.length && <p className="lside-none lside-section-none">No comments yet.</p>}
            </section>
          </>
        )}
      </div>
    </aside>
  )
}

// ---- the parts

function Swatch({ color, hollow }: { color: string; hollow?: boolean }) {
  return <span className={`lside-swatch${hollow ? ' is-hollow' : ''}`} style={{ '--sw': color } as React.CSSProperties} aria-hidden="true" />
}

/** Show in: one chip per surface, checked where the label or the check applies, with what it found there. */
function ShowIn({ items, onToggle }: { items: { key: string; label: string; on: boolean; n: number; disabled?: boolean; title?: string }[]; onToggle?: (key: string, on: boolean) => void }) {
  return (
    <div className="lside-showin">
      <span className="lside-showin-word">Show in</span>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="checkbox"
          aria-checked={it.on}
          disabled={it.disabled || !onToggle}
          title={it.title}
          className={`lside-chip${it.on ? ' is-on' : ''}${it.disabled ? ' is-fixed' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onToggle?.(it.key, !it.on)
          }}
        >
          <span className="lside-box" aria-hidden="true">
            {it.on && <Icon name="check" size={10} />}
          </span>
          {it.label}
          {it.n > 0 && <span className="lside-n">{it.n}</span>}
        </button>
      ))}
    </div>
  )
}

function labelShowIn(k: Concept) {
  const on = labelSurface(k)
  const n = k.n_labeled ?? Object.values(k.counts ?? {}).reduce((a, b) => a + b, 0)
  return <ShowIn items={(['files', 'cards', 'report'] as const).map((s) => ({ key: s, label: s === 'files' ? 'Files' : s === 'cards' ? 'Cards' : 'Report', on: s === on, n: s === on ? n : 0, disabled: true }))} />
}

function Values({ k, bars = false }: { k: Concept; bars?: boolean }) {
  const classes = classesOf(k)
  const max = Math.max(1, ...classes.map((c) => k.counts?.[c.name] ?? 0))
  return (
    <div className={bars ? 'lside-values is-bars' : 'lside-values'}>
      {classes.map((c) => {
        const n = k.counts?.[c.name] ?? 0
        return (
          <span key={c.name} className="lside-value">
            <Swatch color={colourVar(c.color)} hollow={!c.color} />
            <span className="lside-value-name">{c.name}</span>
            {bars && <span className="lside-bar" style={{ width: `${Math.round((n / max) * 100)}%`, background: c.color ? colourVar(c.color) : 'var(--border-strong)' }} />}
            <span className="lside-n">{n}</span>
          </span>
        )
      })}
    </div>
  )
}

const setLabel = (ws: string, id: string, patch: Parameters<typeof labelApi.update>[2]) => labelApi.update(ws, id, patch).catch(fail)

function LabelRow({ ws, label: k, onOpen }: { ws: string; label: Concept; onOpen: () => void }) {
  return (
    <div className={`lside-row${k.shown ? '' : ' is-off'}`} data-label={k.id}>
      <div className="lside-row-head">
        <span className="lside-tag" style={{ color: mainColour(k) }}>
          <Icon name="label" size={14} />
        </span>
        <button type="button" className="lside-name" onClick={onOpen}>
          {k.name}
        </button>
        <Switch checked={!!k.shown} onChange={(on) => void setLabel(ws, k.id, { shown: on })} label={`${k.name}: ${k.shown ? 'on' : 'off'}`} />
        <Button variant="icon" size="sm" icon="chevron-right" title="Open" aria-label={`Open ${k.name}`} onClick={onOpen} />
      </div>
      {k.description && <p className="lside-question">{k.description}</p>}
      <Values k={k} />
      {labelShowIn(k)}
    </div>
  )
}

function LabelDetail({ ws, label: k, onGone }: { ws: string; label: Concept; onGone: () => void }) {
  // a model label's question is its definition
  const definition = labelDefinition(k)
  const said = k.kind === 'prompt' ? definition : k.description
  const [question, setQuestion] = useState(said)
  useEffect(() => setQuestion(said), [said])
  const [rows, setRows] = useState<{ rows: LabelRowText[]; total: number } | null>(null)
  const [running, setRunning] = useState(false)
  const edit = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let alive = true
    labelApi
      .rows(ws, k.id, { limit: FOUND_SHOWN })
      .then((got) => alive && setRows(got))
      .catch(() => alive && setRows({ rows: [], total: 0 }))
    return () => {
      alive = false
    }
  }, [ws, k.id, k.n_labeled, k.rev])
  const how = howMade(k.kind)
  const n = k.n_labeled ?? 0
  return (
    <div className="lside-detail" data-label={k.id}>
      <div className="lside-row-head">
        <span className="lside-tag" style={{ color: mainColour(k) }}>
          <Icon name="label" size={14} />
        </span>
        <span className="lside-title">{k.name}</span>
        <Switch checked={!!k.shown} onChange={(on) => void setLabel(ws, k.id, { shown: on })} label={`${k.name}: ${k.shown ? 'on' : 'off'}`} />
      </div>
      {/* a big run of this label that waits for the person's choice, as above the chat's composer */}
      <LabelAsks ws={ws} concept={k.id} />
      <h4 className="lside-label">Definition</h4>
      {k.kind === 'prompt' ? (
        <TextArea className="lside-ask" value={question} onChange={setQuestion} onBlur={() => question.trim() !== said && void setLabel(ws, k.id, { description: question.trim() })} autoGrow rows={2} aria-label="The label's definition" />
      ) : (
        <>
          {definition ? <Definition code={k.kind === 'code'} text={definition} /> : <p className="lside-none">No definition.</p>}
          {k.description && (
            <>
              <h4 className="lside-label">Question</h4>
              <TextArea className="lside-ask" value={question} onChange={setQuestion} onBlur={() => question.trim() !== k.description && void setLabel(ws, k.id, { description: question.trim() })} autoGrow rows={2} aria-label="The label's question" />
            </>
          )}
        </>
      )}
      <h4 className="lside-label">
        Values <span className="lside-n">{`${n} ${unitWord(k.unit, n)}`}</span>
      </h4>
      <Values k={k} bars />
      <h4 className="lside-label">Reads</h4>
      <p className="lside-reads">
        <span className="mono">{k.glob || (isFilesLabel(k) ? 'the files' : labelSurface(k) === 'cards' ? 'the cards' : 'the report')}</span>
        {` · one value per ${unitWord(k.unit, 1)} · ${how}`}
        <button
          ref={edit}
          type="button"
          className="lside-link"
          onClick={() => edit.current && openLabelEditor({ id: k.id, anchor: edit.current, side: 'left', back: edit.current })}
        >
          Edit
        </button>
      </p>
      <h4 className="lside-label">Show in</h4>
      {labelShowIn(k)}
      <h4 className="lside-label">
        Found <span className="lside-n">{rows?.total.toLocaleString('en-US') ?? ''}</span>
      </h4>
      <div className="lside-founds">
        {rows && !rows.rows.length && <p className="lside-none">No record has a value yet.</p>}
        {rows?.rows.map((r) => {
          const value = r.analyst ?? r.label
          const cls = classesOf(k).find((c) => c.name === value)
          return (
            <button key={r.ref} type="button" className="lside-found is-record" onClick={() => teleport(r.ref)} title="Go to it">
              <span className="lside-found-ref mono">{r.ref.split('/').pop()}</span>
              {r.text && <span className="lside-found-title">{r.text.slice(0, 140)}</span>}
              <span className="lside-found-value">
                <Swatch color={cls?.color ? colourVar(cls.color) : 'var(--border-strong)'} hollow={!cls?.color} />
                {value}
              </span>
            </button>
          )
        })}
        {rows && rows.total > rows.rows.length && (
          <button
            type="button"
            className="lside-more"
            onClick={() =>
              void labelApi
                .rows(ws, k.id, { offset: rows.rows.length, limit: FOUND_PAGE })
                .then((got) => setRows((cur) => (cur ? { rows: [...cur.rows, ...got.rows], total: got.total } : got)))
                .catch(fail)
            }
          >
            {(rows.total - rows.rows.length).toLocaleString('en-US')} more
          </button>
        )}
      </div>
      <footer className="lside-foot">
        <Button
          variant="primary"
          size="sm"
          busy={running}
          onClick={() => {
            setRunning(true)
            labelApi
              .apply(ws, k.id, {})
              .catch(fail)
              .finally(() => setRunning(false))
          }}
        >
          Run again
        </Button>
        {isFilesLabel(k) && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              // a label turned on takes the first place of Color by in Files (files/useColorBy.ts)
              void setLabel(ws, k.id, { shown: true })
              bus.emit('showTab', { tab: 'files' })
            }}
          >
            Color Files by it
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void setLabel(ws, k.id, { shown: !k.shown })}>
          {k.shown ? 'Turn off' : 'Turn on'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="lside-delete"
          onClick={() =>
            void labelApi
              .remove(ws, k.id)
              .then(onGone)
              .catch(fail)
          }
        >
          Delete
        </Button>
      </footer>
    </div>
  )
}

/** the lines of a label's code shown before "N more lines" */
const CODE_SHOWN = 6

/** A regex or code label's definition, as it is: the pattern whole, the code's first lines with the rest a click away. */
function Definition({ code, text }: { code: boolean; text: string }) {
  const [whole, setWhole] = useState(false)
  const lines = text.split('\n')
  const cut = code && !whole && lines.length > CODE_SHOWN
  return (
    <div className="lside-def-box">
      <pre className={code ? 'lside-def is-code' : 'lside-def'}>{cut ? lines.slice(0, CODE_SHOWN).join('\n') : text}</pre>
      {code && lines.length > CODE_SHOWN && (
        <button type="button" className="lside-link lside-def-more" onClick={() => setWhole(!whole)}>
          {whole ? 'Show less' : `${(lines.length - CODE_SHOWN).toLocaleString('en-US')} more lines`}
        </button>
      )}
    </div>
  )
}

function NewLabel() {
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <div className="lside-new">
      <button ref={btn} type="button" className="lside-add" onClick={() => btn.current && openLabelEditor({ id: null, anchor: btn.current, side: 'left', back: btn.current })}>
        <Icon name="plus" size={13} />
        New label
      </button>
    </div>
  )
}

// ---- the comment categories

/** what Show in's Chat says while no check reads the chat */
const NO_CHAT = 'Checks read the cards and the report; none reads the chat yet'

/** A category's Show in: Chat · Cards · Report, each with its open comments there. Cards and Report turn the check's
 * covers on and off (the last one stays on: the switch hides a check everywhere); Notes, which no check made, and
 * Chat are fixed. */
function categoryShowIn(ws: string, c: Category) {
  const n = (s: CommentItem['surface']) => c.items.filter((x) => x.surface === s).length
  const covers = c.check ? coversOf(c.check) : []
  const check = c.check
  const set = (cover: CheckCover, on: boolean) => {
    if (!check) return
    const next = withCover(check, cover, on)
    if (next) void checksApi.update(ws, check.id, { covers: next }).catch(fail)
  }
  const only = (cover: CheckCover) => covers.length === 1 && covers[0] === cover
  return (
    <ShowIn
      items={[
        { key: 'chat', label: 'Chat', on: false, n: 0, disabled: true, title: NO_CHAT },
        { key: 'cards', label: 'Cards', on: check ? covers.includes('cards') : n('canvas') > 0, n: n('canvas'), disabled: !check || only('cards') },
        { key: 'documents', label: 'Report', on: check ? covers.includes('documents') : n('report') > 0, n: n('report'), disabled: !check || only('documents') },
      ]}
      onToggle={check ? (key, on) => set(key as CheckCover, on) : undefined}
    />
  )
}

function CategoryRow({ ws, category: c, checks, onOpen }: { ws: string; category: Category; checks: Checks; onOpen: () => void }) {
  const shown = c.check ? c.check.shown : true
  return (
    <div className={`lside-row${shown ? '' : ' is-off'}`} data-category={c.key}>
      <div className="lside-row-head">
        <Swatch color={c.color} hollow={!shown} />
        <button type="button" className="lside-name" onClick={onOpen}>
          {c.name}
          <span className="lside-n">{c.items.length}</span>
        </button>
        {c.check && <Switch checked={shown} onChange={(on) => checks.toggle(c.key, on)} label={`${c.name}: ${shown ? 'on' : 'off'}`} />}
        <Button variant="icon" size="sm" icon="chevron-right" title="Open" aria-label={`Open ${c.name}`} onClick={onOpen} />
      </div>
      {c.check?.prompt && <p className="lside-question lside-clamp">{c.check.prompt}</p>}
      {c.key === NOTES && <p className="lside-question">Your notes and Claude's, which no check made.</p>}
      {categoryShowIn(ws, c)}
    </div>
  )
}

function CategoryDetail({ ws, category: c, checks, onDone }: { ws: string; category: Category; checks: Checks; onDone: (c: CommentItem) => void }) {
  const prompt = c.check?.prompt ?? ''
  const [text, setText] = useState(prompt)
  const [busy, setBusy] = useState(false)
  useEffect(() => setText(prompt), [prompt])
  const shown = c.check ? c.check.shown : true
  const dirty = !!c.check && !!text.trim() && text.trim() !== prompt.trim()
  const save = () => {
    if (!c.check || !dirty) return
    setBusy(true)
    void checks.editPrompt(c.check.id, text.trim()).finally(() => setBusy(false))
  }
  return (
    <div className="lside-detail" data-category={c.key}>
      <div className="lside-row-head">
        <Swatch color={c.color} hollow={!shown} />
        <span className="lside-title">{c.name}</span>
        {c.check && <Switch checked={shown} onChange={(on) => checks.toggle(c.key, on)} label={`${c.name}: ${shown ? 'on' : 'off'}`} />}
      </div>
      {c.check && (
        <>
          <h4 className="lside-label">Definition</h4>
          <TextArea className="lside-ask" value={text} onChange={setText} autoGrow rows={3} aria-label="The check's definition" />
          {dirty && (
            <div className="lside-new-acts">
              <Button variant="primary" size="sm" busy={busy} onClick={save} title={shown ? 'Save, and run the check again where it comments' : 'Save'}>
                {shown ? 'Save and run' : 'Save'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setText(prompt)}>
                Cancel
              </Button>
            </div>
          )}
        </>
      )}
      <h4 className="lside-label">Show in</h4>
      {categoryShowIn(ws, c)}
      <h4 className="lside-label">
        Comments <span className="lside-n">{c.items.length}</span>
      </h4>
      <div className="lside-founds">
        {!c.items.length && <p className="lside-none">No open comments.</p>}
        {c.items.map((it) => (
          <CommentRow key={`${it.surface}:${it.id}`} item={it} name={c.name} onDone={() => onDone(it)} />
        ))}
      </div>
    </div>
  )
}
