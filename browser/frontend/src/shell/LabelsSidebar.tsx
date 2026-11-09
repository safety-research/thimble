// The Labels and Comments sidebar, at the right of the page: the one place where the analyst sees, turns on and off,
// and opens the workspace's labels and its comment categories (the checks: the built-in Heads up, Explainers and
// Judgment calls, and the analyst's own). It shows one section at a time: the top bar's Labels button, just above it,
// opens it on the labels, and its Comments button on the comment categories; a second click closes it. The labels'
// head holds the Label tool switch, on or off: whether Claude makes labels in this workspace (LabelTool), which applies
// at once.
//
// A label's row: its color, name, question and values with their counts, and for a label over files its switch, which
// turns it on or off in Files. A label over report sentences has no switch, since nothing paints its values in the
// report yet. A row opens its detail in the sidebar: the label's definition (a model label's
// question, editable; a regex or code shown as it is, the code's first lines with the rest a click away), its values
// with bars, what it reads and how it was made (regex, code, or read by Claude), with Edit, the records it found, each
// a click away, with "N more", and Run again, Color Files by it and Turn off (a label over files), and Delete. The
// labels end in "+ New label".
//
// A comment category's row: its color, name, open comments, definition, Show in (Chat · Cards · Report, each a toggle
// of where the check comments, with its comments there) and its switch, which shows or hides its comments everywhere.
// For a check that comments on the documents, its runs there show as the canvas's Comments button shows its runs on
// the cards (report/Checks.tsx): a spinner while one runs, which opens the run, ✕ when one failed, and under the row
// the passages changed since it checked them with Run, and a start that did not happen. The top bar's Comments button
// carries the new comments' dot for the documents (TopBar.tsx). A row opens its detail: its runs on the documents, each
// its Last run with Stop while it runs and Re-run, the definition, editable, Show in, and its open comments, each a link
// to where it stands (a card, or the passage in its document) with Apply, which sends it to Claude in the chat, Go to it
// and Done (CommentsList.tsx). A check's runs name their document when it has runs on several, and the comments in the
// documents name theirs when more than one document has comments. The analyst's and Claude's own notes, which no check
// made, are the category Notes. The categories end in "+ Ask for comments", which opens the new-check card beside the
// sidebar (report/Checks.tsx NewCheckCard): Run adds the check, commenting on the documents, and the server turns it on
// and runs it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useConcepts } from '../canvas/concepts'
import { LabelAsks } from '../chat/LabelAsk'
import { CommentRow, useComments, type CommentItem } from './CommentsList'
import { Button } from '../components/Button'
import { TextArea } from '../components/Field'
import { Icon } from '../components/Icon'
import { Popover } from '../components/Menu'
import { Switch } from '../components/Switch'
import { openLabelEditor } from '../files/LabelEditor'
import { classesOf, colourVar, howMade, labelDefinition, isFilesLabel, mainColour, unitWord } from '../files/labels'
import { checksApi, labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { useSettingSwitch } from '../lib/models'
import { track } from '../lib/telemetry'
import { teleport } from '../lib/teleport'
import type { Check, CheckCover, CheckRun, Concept, LabelRowText, TypesState } from '../lib/types'
import { NewCheckCard, RunLine, RunMark, RunNotes, runCheck, useChecks, type Checks } from '../report/Checks'
import { checkColour, coversOf, docRuns, freeColour, nameTaken, NOTE_COLOR, runLine } from '../report/checkComments'
import { useDocTypes, writtenDocs } from '../report/docTypes'
import { docLabel } from '../report/model'
import { HelpButton } from '../files/LabelsHelp'

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })
/** the found items a detail lists before "N more" */
const FOUND_SHOWN = 6
/** the records a label's "N more" adds at each click */
const FOUND_PAGE = 50
/** the key of the category of the comments no check made: the analyst's own and Claude's notes */
export const NOTES = '@notes'

/** The labels the sidebar lists: every label but a trial run on a few records. */
export const listedLabels = (concepts: ReadonlyMap<string, Concept>): Concept[] => [...concepts.values()].filter((k) => !k.trial)

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
  const next = (['documents', 'cards', 'answers'] as const).filter((k) => now.has(k))
  return next.length ? next : null
}

/** A check's run on one document, with the document's name when the check has runs on several. */
export interface DocRun {
  doc: string
  run: CheckRun
  where?: string
}

/** A check's runs on the documents (report/checkComments.ts docRuns: on the written ones, once `types` says which),
 * each named by its document when there are several. Pure. */
export function namedDocRuns(check: Check | null, types: TypesState | null): DocRun[] {
  if (!check) return []
  const runs = docRuns(check, types ? writtenDocs(types) : null)
  return runs.length > 1 ? runs.map((r) => ({ ...r, where: docLabel(r.doc, types) })) : runs
}

/** What a run's spinner or ✕ is named by: the check, and its document when the check has runs on several. Pure. */
const runName = (check: string, r: DocRun): string => (r.where ? `${check} on ${r.where}` : check)

type Detail = { kind: 'label' | 'comments'; id: string }

/** The sidebar's two sections: the labels, and the comment categories. */
export type SideSection = 'labels' | 'comments'

export function LabelsSidebar({ ws, section, onClose }: { ws: string; section: SideSection; onClose: () => void }) {
  const concepts = useConcepts(ws)
  const labels = useMemo(() => listedLabels(concepts), [concepts])
  const checks = useChecks(ws)
  const comments = useComments(ws)
  const categories = useMemo(() => commentCategories(checks.list, comments.items), [checks.list, comments.items])
  // the written documents, whose runs the categories show, and the names of the documents
  const types = useDocTypes(ws, section === 'comments')
  const [detail, setDetail] = useState<Detail | null>(null)
  // a request from elsewhere to open one label's detail (a label's chip or tag)
  useEffect(() => bus.on('openLabels', (e) => setDetail(e.id ? { kind: 'label', id: e.id } : null)), [])
  // a detail belongs to its section: the other section opens on its list
  const label = section === 'labels' && detail?.kind === 'label' ? concepts.get(detail.id) : undefined
  const category = section === 'comments' && detail?.kind === 'comments' ? categories.find((c) => c.key === detail.id) : undefined
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
    <aside className="lside" aria-label={section === 'labels' ? 'Labels' : 'Comments'} data-section={section}>
      <header className="lside-head">
        {open ? (
          <button type="button" className="lside-back" onClick={() => setDetail(null)}>
            <Icon name="chevron-left" size={14} />
            {label ? 'Labels' : 'Comments'}
          </button>
        ) : (
          <h2 className="lside-heading">
            {section === 'labels' ? 'Labels' : 'Comments'} <span className="lside-n">{section === 'labels' ? labels.length : comments.items.length}</span>
            {section === 'labels' && <HelpButton of="labels" />}
          </h2>
        )}
        {section === 'labels' && !open && <LabelTool ws={ws} />}
        <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />
      </header>
      <div className="lside-body">
        {label ? (
          <LabelDetail ws={ws} label={label} onGone={() => setDetail(null)} />
        ) : category ? (
          <CategoryDetail ws={ws} category={category} checks={checks} runs={namedDocRuns(category.check, types)} onDone={comments.done} />
        ) : section === 'labels' ? (
          <section className="lside-section" data-section="labels">
            {labels.map((k) => (
              <LabelRow key={k.id} ws={ws} label={k} onOpen={() => setDetail({ kind: 'label', id: k.id })} />
            ))}
            {!labels.length && <p className="lside-none lside-section-none">No labels yet.</p>}
            <NewLabel />
          </section>
        ) : (
          <section className="lside-section" data-section="comments">
            {categories.map((c) => (
              <CategoryRow key={c.key} ws={ws} category={c} checks={checks} runs={namedDocRuns(c.check, types)} onOpen={() => setDetail({ kind: 'comments', id: c.key })} />
            ))}
            {!categories.length && <p className="lside-none lside-section-none">No comments yet.</p>}
            <NewCheck checks={checks} />
          </section>
        )}
      </div>
    </aside>
  )
}

// ---- the parts

/** The words of the switch at the labels' head. */
export const LABEL_TOOL = 'Label tool'

/** The Label tool, on or off: whether Claude makes labels in this workspace, as the terminal's Labels setting (the
 * workspace's settings.json `labels`, backend ledger.LABELS_KEY, on by default). Off, main's prompt and the tools'
 * texts say nothing of labels and no agent has a label tool, while the labels made keep their own switches. A turn
 * applies at once, from main's next message. Its words are part of the switch: a click on them turns it too. */
function LabelTool({ ws }: { ws: string }) {
  const [on, turn] = useSettingSwitch(
    ws,
    (s) => s.labels !== false,
    (v) => ({ labels: v ? null : false }),
    (v, e) => bus.emit('toast', { text: `Could not turn the label tool ${v ? 'on' : 'off'}. ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' }),
  )
  if (on == null) return null
  return (
    <label className="lside-tool" data-on={on}>
      <span className="lside-tool-words">{LABEL_TOOL}</span>
      <Switch
        checked={on}
        onChange={(v) => {
          track('chat-settings', { target: 'ui:labels', detail: { labels: v } })
          turn(v)
        }}
      />
    </label>
  )
}

function Swatch({ color, hollow }: { color: string; hollow?: boolean }) {
  return <span className={`lside-swatch${hollow ? ' is-hollow' : ''}`} style={{ '--sw': color } as React.CSSProperties} aria-hidden="true" />
}

/** A check's Show in: one chip per surface, checked where the check applies, with what it found there. */
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
  // `shown` is on or off in Files, so only a label over files is ever off
  const files = isFilesLabel(k)
  return (
    <div className={`lside-row${files && !k.shown ? ' is-off' : ''}`} data-label={k.id}>
      <div className="lside-row-head">
        <span className="lside-tag" style={{ color: mainColour(k) }}>
          <Icon name="label" size={14} />
        </span>
        <button type="button" className="lside-name" onClick={onOpen}>
          {k.name}
        </button>
        {files && <Switch checked={!!k.shown} onChange={(on) => void setLabel(ws, k.id, { shown: on })} label={`${k.name}: ${k.shown ? 'on' : 'off'}`} />}
        <Button variant="icon" size="sm" icon="chevron-right" title="Open" aria-label={`Open ${k.name}`} onClick={onOpen} />
      </div>
      {k.description && <p className="lside-question">{k.description}</p>}
      <Values k={k} />
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
  const files = isFilesLabel(k)
  return (
    <div className="lside-detail" data-label={k.id}>
      <div className="lside-row-head">
        <span className="lside-tag" style={{ color: mainColour(k) }}>
          <Icon name="label" size={14} />
        </span>
        <span className="lside-title">{k.name}</span>
        {files && <Switch checked={!!k.shown} onChange={(on) => void setLabel(ws, k.id, { shown: on })} label={`${k.name}: ${k.shown ? 'on' : 'off'}`} />}
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
        <span className="mono">{k.glob || (files ? 'the files' : 'the report')}</span>
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
        {files && (
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
        {files && (
          <Button variant="ghost" size="sm" onClick={() => void setLabel(ws, k.id, { shown: !k.shown })}>
            {k.shown ? 'Turn off' : 'Turn on'}
          </Button>
        )}
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

/** "+ Ask for comments" at the end of the categories: the new-check card beside the sidebar, whose Run adds the check
 * over the documents, as the Report's Comments pane's + did; the server turns it on and runs it. */
function NewCheck({ checks }: { checks: Checks }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <div className="lside-new">
      <button ref={btn} type="button" className="lside-add" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={13} />
        Ask for comments
      </button>
      <Popover anchor={btn} open={open} onClose={close} side="left" width={340} label="Ask for comments" className="check-card">
        {open && (
          <NewCheckCard
            colour={colourVar(freeColour(checks.list))}
            taken={(name) => nameTaken(checks.list, name)}
            onClose={close}
            onAdd={async (name, prompt) => {
              if (await checks.create(name, prompt, ['documents'])) close()
            }}
          />
        )}
      </Popover>
    </div>
  )
}

/** A category's Show in: Chat · Cards · Report, each with its open comments there. Each turns the check's covers on
 * and off (Chat is its `answers`: it reads each of Claude's answers when the turn ends; the last one stays on: the
 * switch hides a check everywhere); Notes, which no check made, are fixed. */
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
        { key: 'answers', label: 'Chat', on: check ? covers.includes('answers') : n('chat') > 0, n: n('chat'), disabled: !check || only('answers') },
        { key: 'cards', label: 'Cards', on: check ? covers.includes('cards') : n('canvas') > 0, n: n('canvas'), disabled: !check || only('cards') },
        { key: 'documents', label: 'Report', on: check ? covers.includes('documents') : n('report') > 0, n: n('report'), disabled: !check || only('documents') },
      ]}
      onToggle={check ? (key, on) => set(key as CheckCover, on) : undefined}
    />
  )
}

function CategoryRow({ ws, category: c, checks, runs, onOpen }: { ws: string; category: Category; checks: Checks; runs: DocRun[]; onOpen: () => void }) {
  const check = c.check
  const shown = check ? check.shown : true
  return (
    <div className={`lside-row${shown ? '' : ' is-off'}`} data-category={c.key}>
      <div className="lside-row-head">
        <Swatch color={c.color} hollow={!shown} />
        <button type="button" className="lside-name" onClick={onOpen}>
          {c.name}
          <span className="lside-n">{c.items.length}</span>
        </button>
        {/* a run that failed before its session started has no chat: the detail runs it again */}
        {runs.map((r) => (
          <RunMark key={r.doc} name={runName(c.name, r)} run={r.run} onCard={onOpen} />
        ))}
        {c.check && <Switch checked={shown} onChange={(on) => checks.toggle(c.key, on)} label={`${c.name}: ${shown ? 'on' : 'off'}`} />}
        <Button variant="icon" size="sm" icon="chevron-right" title="Open" aria-label={`Open ${c.name}`} onClick={onOpen} />
      </div>
      {c.check?.prompt && <p className="lside-question lside-clamp">{c.check.prompt}</p>}
      {c.key === NOTES && <p className="lside-question">Your own notes and Claude's.</p>}
      {categoryShowIn(ws, c)}
      {check && runs.map((r) => <RunNotes key={r.doc} ws={ws} check={check} doc={r.doc} run={r.run} where={r.where} />)}
    </div>
  )
}

/** A check's runs on the documents in its detail: under Last run, each run's line (report/Checks.tsx RunLine: what it
 * does or how it ended, with Stop while it runs) with Re-run while the check is on and does not run there, as its card
 * beside the canvas's Comments button has them; then what each run leaves to the analyst (RunNotes). A run that only
 * counts the passages changed before the check first ran there has no line. */
function LastRuns({ ws, check, runs }: { ws: string; check: Check; runs: DocRun[] }) {
  const ran = runs.filter((r) => r.run.run)
  return (
    <>
      {ran.length > 0 && <h4 className="lside-label">Last run</h4>}
      {ran.map((r) => (
        <LastRun key={r.doc} ws={ws} check={check} run={r} />
      ))}
      {runs.map((r) => (
        <RunNotes key={r.doc} ws={ws} check={check} doc={r.doc} run={r.run} where={r.where} />
      ))}
    </>
  )
}

function LastRun({ ws, check, run: { doc, run, where } }: { ws: string; check: Check; run: DocRun }) {
  const [busy, setBusy] = useState(false)
  const running = run.status === 'running'
  return (
    <div className="lside-run" data-doc={doc}>
      {where && <span className="lside-run-doc">{where}</span>}
      <RunLine ws={ws} check={check} doc={doc} line={runLine(run)} running={running} />
      {check.shown && !running && (
        <Button
          size="sm"
          variant="ghost"
          busy={busy}
          onClick={() => {
            setBusy(true)
            void runCheck(ws, check, doc, { action: 'run' }).finally(() => setBusy(false))
          }}
        >
          Re-run
        </Button>
      )}
    </div>
  )
}

function CategoryDetail({ ws, category: c, checks, runs, onDone }: { ws: string; category: Category; checks: Checks; runs: DocRun[]; onDone: (c: CommentItem) => void }) {
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
        {runs.map((r) => (
          <RunMark key={r.doc} name={runName(c.name, r)} run={r.run} />
        ))}
        {c.check && <Switch checked={shown} onChange={(on) => checks.toggle(c.key, on)} label={`${c.name}: ${shown ? 'on' : 'off'}`} />}
      </div>
      {c.check && <LastRuns ws={ws} check={c.check} runs={runs} />}
      {c.check && (
        <>
          <h4 className="lside-label">Definition</h4>
          <TextArea className="lside-ask" value={text} onChange={setText} autoGrow rows={3} aria-label={`Definition of ${c.name}`} />
          {dirty && (
            <div className="lside-new-acts">
              <Button variant="primary" size="sm" busy={busy} onClick={save} title={shown ? 'Save, and run it again where it comments' : 'Save'}>
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
          <CommentRow key={`${it.surface}:${it.doc?.slug ?? ''}:${it.id}`} item={it} name={c.name} onDone={() => onDone(it)} />
        ))}
      </div>
    </div>
  )
}
