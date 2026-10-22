// The Labels sidebar, at the right of the page: the one place where the analyst sees, turns on and off, and scopes the
// workspace's labels. The top bar's "Labels N" opens it.
//
// A row is a label: its color, name, question, Show in (Files · Cards · Report, each with what it found there) and its
// switch. A row opens its detail in the sidebar: a label's definition (a model label's question, editable; a regex or
// code shown as it is, the code's first lines with the rest a click away), its values, Show in, the records it found,
// each drawn as it looks where it is (the record with its value's color), a click on which goes straight to that place,
// and Run again, Turn off and Delete, with Color Files by it. The list ends in "+ New".
import { useEffect, useMemo, useRef, useState } from 'react'
import { useConcepts } from '../canvas/concepts'
import { Button } from '../components/Button'
import { TextArea, TextInput } from '../components/Field'
import { Icon } from '../components/Icon'
import { Switch } from '../components/Switch'
import { openLabelEditor } from '../files/LabelEditor'
import { classesOf, colourVar, howMade, labelDefinition, isFilesLabel, mainColour, unitWord } from '../files/labels'
import { labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { mapLinks } from '../lib/refs'
import { teleport } from '../lib/teleport'
import { hhmm } from '../lib/time'
import type { Concept, LabelAskShown, LabelRowText } from '../lib/types'
import { LabelAsk } from '../chat/LabelRun'

export type SideTab = 'labels'

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })
/** the found items a detail lists before "N more" */
const FOUND_SHOWN = 6
/** the records a label's "N more" adds at each click */
const FOUND_PAGE = 50

/** The labels the sidebar lists: every label but a trial run on a few records. */
export const listedLabels = (concepts: ReadonlyMap<string, Concept>): Concept[] => [...concepts.values()].filter((k) => !k.trial)

/** The surface a label shows on, by what it labels: records and files in Files, cards on the canvas, sentences in the
 * report. Pure. */
export function labelSurface(k: Pick<Concept, 'unit'>): 'files' | 'cards' | 'report' {
  return k.unit === 'cell' ? 'cards' : k.unit === 'span' ? 'report' : 'files'
}

export function LabelsSidebar({ ws, tab, onClose }: { ws: string; tab: SideTab; onClose: () => void }) {
  const concepts = useConcepts(ws)
  const labels = useMemo(() => listedLabels(concepts), [concepts])
  const [detail, setDetail] = useState<{ kind: SideTab; id: string } | null>(null)
  useEffect(() => setDetail(null), [tab])
  // a request from elsewhere to open one label's detail (a label's chip or tag)
  useEffect(() => bus.on('openLens', (e) => setDetail(e.id ? { kind: e.tab, id: e.id } : null)), [])
  const label = detail?.kind === 'labels' ? concepts.get(detail.id) : undefined
  // Escape goes back from a label's detail to the list, then closes the sidebar. It is heard on the
  // window, after the document's own listeners: a menu or popover open over the page (Menu.tsx stops the key there),
  // the pointer box (which marks it handled) and a field with words typed in it keep their Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.isContentEditable || ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value)) return
      e.preventDefault()
      if (detail) setDetail(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, onClose])
  return (
    <aside className="lside" aria-label="Labels" data-tab={tab}>
      <header className="lside-head">
        {detail ? (
          <button type="button" className="lside-back" onClick={() => setDetail(null)}>
            <Icon name="chevron-left" size={14} />
            Labels
          </button>
        ) : (
          <h2 className="lside-heading">Labels</h2>
        )}
        <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />
      </header>
      <div className="lside-body">
        {label ? (
          <LabelDetail ws={ws} label={label} onGone={() => setDetail(null)} />
        ) : (
          labels.map((k) => <LabelRow key={k.id} ws={ws} label={k} onOpen={() => setDetail({ kind: 'labels', id: k.id })} />)
        )}
      </div>
      {!detail && <NewLabel />}
    </aside>
  )
}

// ---- labels

function Swatch({ color, hollow }: { color: string; hollow?: boolean }) {
  return <span className={`lside-swatch${hollow ? ' is-hollow' : ''}`} style={{ '--sw': color } as React.CSSProperties} aria-hidden="true" />
}

/** Show in: one chip per surface, checked where the label shows, with what it found there. */
function ShowIn({ items, onToggle }: { items: { key: string; label: string; on: boolean; n: number; disabled?: boolean }[]; onToggle?: (key: string, on: boolean) => void }) {
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
  const [asked, setAsked] = useState<LabelAskShown | null>(null)
  const ask = asked ?? k.ask ?? null
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
      {ask && <LabelAsk ws={ws} ask={ask} onAnswered={() => setAsked(null)} />}
      <footer className="lside-foot">
        <Button
          variant="primary"
          size="sm"
          busy={running}
          onClick={() => {
            setRunning(true)
            labelApi
              .apply(ws, k.id, {})
              .then((r) => r.status === 'asked' && r.ask && setAsked(r.ask))
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
    <footer className="lside-new">
      <button ref={btn} type="button" className="lside-add" onClick={() => btn.current && openLabelEditor({ id: null, anchor: btn.current, side: 'left', back: btn.current })}>
        <Icon name="plus" size={13} />
        New label
      </button>
    </footer>
  )
}
