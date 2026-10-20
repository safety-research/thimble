// The Labels and Checks sidebar, at the right of the page: the one place where the analyst sees, turns on and off, and
// scopes the workspace's labels (labels feature) and checks (lenses feature: the built-in Explainers, Important details
// and Unverifiable, and the analyst's own). The top bar's "Labels N" and "Checks N" open it on their tab.
//
// A row is a label or a check: its color, name, question, Show in (Chat · Cards · Report for a check, Files · Cards ·
// Report for a label, each with what it found there) and its switch. A row opens its detail in the sidebar: the
// question (an own check's editable), a label's definition (a model label's question, editable; a regex or code shown
// as it is, the code's first lines with the rest a click away), what it leaves (a check) or its values (a label), Show in, what it
// found, each drawn as it looks where it is (the passage in the check's highlight, the record with its value's color),
// a click on which goes straight to that place, and Run again, Turn off and Delete, with Color Files by it for a label.
// Each list ends in "+ New". A check's scope is set through the lenses' one route (lib/marks lensApi.set).
// The sidebar's head names the list it shows and has no tabs of its own: the top bar's two buttons, just above it, are
// the one way to switch between Labels and Checks.
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
import { lensApi, lensColors, loadLenses, revealMark, SURFACES, SURFACE_WORDS, useLenses, type FoundMark, type Lens, type Surface } from '../lib/marks'
import { teleport } from '../lib/teleport'
import { hhmm } from '../lib/time'
import type { Concept, LabelAskShown, LabelRowText } from '../lib/types'
import { LabelAsk } from '../chat/LabelRun'

export type SideTab = 'labels' | 'checks'

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

export function LensSidebar({ ws, tab, onClose }: { ws: string; tab: SideTab; onClose: () => void }) {
  const lenses = useLenses(ws)
  const concepts = useConcepts(ws)
  const labels = useMemo(() => listedLabels(concepts), [concepts])
  const [detail, setDetail] = useState<{ kind: SideTab; id: string } | null>(null)
  useEffect(() => setDetail(null), [tab])
  // a request from elsewhere to open one label's detail (a label's chip or tag)
  useEffect(() => bus.on('openLens', (e) => setDetail(e.id ? { kind: e.tab, id: e.id } : null)), [])
  const lens = detail?.kind === 'checks' ? lenses.find((l) => l.id === detail.id) : undefined
  const label = detail?.kind === 'labels' ? concepts.get(detail.id) : undefined
  return (
    <aside className="lside" aria-label="Labels and checks" data-tab={tab}>
      <header className="lside-head">
        {detail ? (
          <button type="button" className="lside-back" onClick={() => setDetail(null)}>
            <Icon name="chevron-left" size={14} />
            {detail.kind === 'labels' ? 'Labels' : 'Checks'}
          </button>
        ) : (
          <h2 className="lside-heading">{tab === 'labels' ? 'Labels' : 'Checks'}</h2>
        )}
        <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />
      </header>
      <div className="lside-body">
        {lens ? (
          <CheckDetail ws={ws} lens={lens} onGone={() => setDetail(null)} />
        ) : label ? (
          <LabelDetail ws={ws} label={label} onGone={() => setDetail(null)} />
        ) : tab === 'checks' ? (
          lenses.map((l) => <CheckRow key={l.id} ws={ws} lens={l} onOpen={() => setDetail({ kind: 'checks', id: l.id })} />)
        ) : (
          labels.map((k) => <LabelRow key={k.id} ws={ws} label={k} onOpen={() => setDetail({ kind: 'labels', id: k.id })} />)
        )}
      </div>
      {!detail && (tab === 'checks' ? <NewCheck ws={ws} /> : <NewLabel />)}
    </aside>
  )
}

// ---- checks

function Swatch({ color, hollow }: { color: string; hollow?: boolean }) {
  return <span className={`lside-swatch${hollow ? ' is-hollow' : ''}`} style={{ '--sw': color } as React.CSSProperties} aria-hidden="true" />
}

/** Show in: one chip per surface, checked when the check reads it there, with what it found there. */
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

const setLens = (ws: string, id: string, patch: Parameters<typeof lensApi.set>[2]) =>
  lensApi
    .set(ws, id, patch)
    .then(() => loadLenses(ws))
    .catch(fail)

function checkShowIn(ws: string, lens: Lens) {
  return (
    <ShowIn
      items={SURFACES.map((s) => ({ key: s, label: SURFACE_WORDS[s], on: lens.scope[s], n: lens.found[s] }))}
      onToggle={(s, on) => void setLens(ws, lens.id, { scope: { [s as Surface]: on } })}
    />
  )
}

function CheckRow({ ws, lens, onOpen }: { ws: string; lens: Lens; onOpen: () => void }) {
  const c = lensColors(lens.color)
  return (
    <div className={`lside-row${lens.on ? '' : ' is-off'}`} data-lens={lens.id}>
      <div className="lside-row-head">
        <Swatch color={c.ink} hollow={!lens.on} />
        <button type="button" className="lside-name" onClick={onOpen}>
          {lens.name}
          <span className="lside-kind">{lens.builtin ? 'built in' : 'yours'}</span>
        </button>
        <Switch checked={lens.on} onChange={(on) => void setLens(ws, lens.id, { on })} label={`${lens.name}: ${lens.on ? 'on' : 'off'}`} />
        <Button variant="icon" size="sm" icon="chevron-right" title="Open" aria-label={`Open ${lens.name}`} onClick={onOpen} />
      </div>
      <p className="lside-question">{lens.question}</p>
      {checkShowIn(ws, lens)}
    </div>
  )
}

/** The first line of a mark's Markdown as plain words: a citation's link text kept, its target dropped. Pure. */
export const plainLine = (md: string): string => md.split('\n').find((l) => l.trim())?.replace(/^[-*]\s+/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim() ?? ''

/** A found mark drawn as it looks where it is: its words in the check's highlight, then what the check says, and its
 * place; a click goes there (lib/marks revealMark). */
function FoundCheck({ m, lens }: { m: FoundMark; lens: Lens }) {
  const c = lensColors(lens.color)
  const where = m.surface === 'chat' ? `chat${m.ts ? ` · ${hhmm(m.ts)}` : ''}` : m.surface === 'cards' ? `card · ${m.place}` : 'report'
  return (
    <button type="button" className={`lside-found${m.shown ? '' : ' is-hidden'}`} onClick={() => revealMark(m)} title={m.shown ? 'Go to it' : `Go to it (hidden there while ${SURFACE_WORDS[m.surface ?? 'chat']} is not in Show in)`}>
      <span className="lside-found-term" style={{ background: c.fill, textDecorationColor: c.ink }}>
        {m.term}
      </span>
      <span className="lside-found-title">{m.title || plainLine(m.body)}</span>
      <span className="lside-found-where">{where}</span>
    </button>
  )
}

function CheckDetail({ ws, lens, onGone }: { ws: string; lens: Lens; onGone: () => void }) {
  const c = lensColors(lens.color)
  const [question, setQuestion] = useState(lens.instructions ?? lens.question)
  useEffect(() => setQuestion(lens.instructions ?? lens.question), [lens.instructions, lens.question])
  const [found, setFound] = useState<FoundMark[] | null>(null)
  const [all, setAll] = useState(false)
  const [running, setRunning] = useState(false)
  const read = () =>
    lensApi
      .found(ws, lens.id)
      .then(setFound)
      .catch(() => setFound([]))
  useEffect(() => {
    void read()
    const offs = [bus.on('marks', () => void read()), bus.on('lenses', () => void read())]
    return () => offs.forEach((f) => f())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, lens.id])
  const shown = found ? (all ? found : found.slice(0, FOUND_SHOWN)) : []
  const save = () => {
    if (lens.builtin || question.trim() === (lens.instructions ?? '').trim() || !question.trim()) return
    void setLens(ws, lens.id, { instructions: question.trim() })
  }
  return (
    <div className="lside-detail" data-lens={lens.id}>
      <div className="lside-row-head">
        <Swatch color={c.ink} hollow={!lens.on} />
        <span className="lside-title">{lens.name}</span>
        <Switch checked={lens.on} onChange={(on) => void setLens(ws, lens.id, { on })} label={`${lens.name}: ${lens.on ? 'on' : 'off'}`} />
      </div>
      <h4 className="lside-label">Question</h4>
      {lens.builtin ? <p className="lside-question">{lens.question}</p> : <TextArea className="lside-ask" value={question} onChange={setQuestion} onBlur={save} autoGrow rows={2} aria-label="The check's question" />}
      <h4 className="lside-label">Leaves</h4>
      <p className="lside-leaves">
        <span className="lside-found-term" style={{ background: c.fill }}>
          {lens.id === 'explain' ? 'the term' : 'the passage'}
        </span>{' '}
        {lens.leaves.replace(/^the (term|detail|claim|passage) highlighted/, 'highlighted')}
      </p>
      <h4 className="lside-label">Show in</h4>
      {checkShowIn(ws, lens)}
      <h4 className="lside-label">
        Found <span className="lside-n">{found?.length ?? ''}</span>
      </h4>
      <div className="lside-founds">
        {found && !found.length && <p className="lside-none">Nothing yet. It reads what Claude writes after each turn, on what Show in names.</p>}
        {shown.map((m) => (
          <FoundCheck key={m.id} m={m} lens={lens} />
        ))}
        {found && found.length > shown.length && (
          <button type="button" className="lside-more" onClick={() => setAll(true)}>
            {found.length - shown.length} more
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
            lensApi
              .read(ws, { lens: lens.id, surfaces: SURFACES.filter((s) => lens.scope[s]) })
              .then(() => read())
              .catch(fail)
              .finally(() => setRunning(false))
          }}
          disabled={!SURFACES.some((s) => lens.scope[s])}
          title="Read the chat's latest answer, the cards and the report again, as Show in names"
        >
          Run again
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void setLens(ws, lens.id, { on: !lens.on })}>
          {lens.on ? 'Turn off' : 'Turn on'}
        </Button>
        {!lens.builtin && (
          <Button
            variant="ghost"
            size="sm"
            className="lside-delete"
            onClick={() =>
              void lensApi
                .remove(ws, lens.id)
                .then(() => loadLenses(ws))
                .then(onGone)
                .catch(fail)
            }
          >
            Delete
          </Button>
        )}
      </footer>
    </div>
  )
}

function NewCheck({ ws }: { ws: string }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [question, setQuestion] = useState('')
  const [scope, setScope] = useState<Record<Surface, boolean>>({ chat: false, cards: false, report: true })
  const [busy, setBusy] = useState(false)
  if (!open)
    return (
      <footer className="lside-new">
        <button type="button" className="lside-add" onClick={() => setOpen(true)}>
          <Icon name="plus" size={13} />
          New check
        </button>
      </footer>
    )
  const add = () => {
    setBusy(true)
    lensApi
      .add(ws, name.trim() || question.trim().split(/\s+/).slice(0, 4).join(' '), question.trim(), scope)
      .then(() => loadLenses(ws))
      .then(() => {
        setOpen(false)
        setName('')
        setQuestion('')
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }
  return (
    <footer className="lside-new is-open">
      <TextInput value={name} onChange={setName} placeholder="Name, such as No citation" aria-label="The check's name" block />
      <TextArea value={question} onChange={setQuestion} placeholder="What should it mark? Such as: Flag any claim with no citation." aria-label="The check's question" block autoGrow rows={2} />
      <ShowIn items={SURFACES.map((s) => ({ key: s, label: SURFACE_WORDS[s], on: scope[s], n: 0 }))} onToggle={(s, on) => setScope((x) => ({ ...x, [s]: on }))} />
      <div className="lside-new-acts">
        <Button variant="primary" size="sm" busy={busy} disabled={!question.trim()} onClick={add}>
          Add and run
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </footer>
  )
}

// ---- labels

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
