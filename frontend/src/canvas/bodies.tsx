// What a card shows between its question and its takeaway, by kind: a plot or table (components/Outputs), shell output,
// a note's text, an example's quoted records, a label's values and examples, a timeline or diagram (DataViz), a custom
// card's frame, a plan's steps (PlanBody). `width` is the room the body has.
import { useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChatMarkdown } from '../chat/markdown'
import { Chip } from '../components/Chip'
import { CodeText } from '../components/Code'
import { CARD_MIME, chartLabels, Output, outIndex, primaryArtifact } from '../components/Outputs'
import { refIcon, refTone } from '../components/RefChip'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { useTooltip } from '../components/Tooltip'
import { classesOf, colourVar, globPatterns, isFilesLabel, isMultiClass, mainColour, marksOf } from '../files/labels'
import { ReadCutLine } from '../files/ReadCutLine'
import { api, labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { mediaOf, mediaUrl, type MediaRef } from '../lib/media'
import { loadSettings, modelLabel } from '../lib/models'
import { addressLabel, hiddenPath } from '../lib/refs'
import { teleport } from '../lib/teleport'
import { track } from '../lib/telemetry'
import type { Cell, ConceptDetail, LabelRowText, ResolvedRef } from '../lib/types'
import { CanvasContext } from './context'
import { CustomFrame, DatasetView } from './DataViz'
import { conceptName, type ConceptDetailState } from './concepts'
import { PlanBody } from './PlanBody'
import { exampleCandidates, exampleParts, labelShares, labelValues, noMatchValues, pickExamples, shortGlob, shownValues, unitTotal, unitWord, unmatchedExample, wholeUnit, type ValueExample } from './details'
import { resolvedOf } from './excerpts'
import { FACT_KINDS, recordFacts } from './facts'
import { filterIs, kindOf, scopeForUnit } from './layout'
import { QuoteParts, RecordFacts } from './Quote'
import { TypeCard } from './TypeCard'
import { jsonRecordParts, plainMarkdown, quoteLine, quoteParts } from './quotes'

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })

export function CardBody({ cell, width, label, big = false }: { cell: Cell; width: number; label: ConceptDetailState; big?: boolean }) {
  const { ws, concepts } = useContext(CanvasContext)
  const kind = kindOf(cell)
  const payload = (cell.payload ?? {}) as Record<string, unknown>
  switch (kind) {
    case 'note': {
      const text = typeof payload.text === 'string' ? payload.text : cell.text ?? ''
      return text ? (
        <div className="chat-text bcell-note">
          <ChatMarkdown text={text} />
        </div>
      ) : null
    }
    case 'example': {
      const refs = Array.isArray(payload.refs) ? (payload.refs as unknown[]).filter((r): r is string => typeof r === 'string') : []
      return <ExampleBody refs={refs} ws={ws} big={big} />
    }
    case 'label': {
      const concept = typeof payload.concept === 'string' ? payload.concept : ''
      return concept ? <LabelBody conceptId={concept} concept={label.concept} error={label.error} title={cell.title} /> : null
    }
    case 'custom': {
      const html = typeof payload.html === 'string' ? payload.html : ''
      const libs = Array.isArray(payload.libs) ? (payload.libs as unknown[]).filter((x): x is string => typeof x === 'string') : undefined
      return html ? <CustomFrame html={html} title={cell.title} height={typeof payload.height === 'number' ? payload.height : undefined} ws={ws} libs={libs} /> : null
    }
    case 'plan':
      return <PlanBody cell={cell} />
    default: {
      if ((kind === 'timeline' || kind === 'diagram') && !cell.code && payload.dataset != null) return <DatasetView kind={kind} dataset={payload.dataset} fitWidth={width} />
      const art = primaryArtifact(cell.outputs)
      if (art && CARD_MIME in art.bundle)
        return (
          <div className="bcell-output bcell-output-chart" data-out={outIndex(cell.outputs, art.bundle)}>
            <TypeCard cell={cell} bundle={art.bundle} width={width} big={big} />
          </div>
        )
      const output = art ? (
        <div className={`bcell-output bcell-output-${art.kind}`} data-out={outIndex(cell.outputs, art.bundle)}>
          <Output bundle={art.bundle} maxLines={big ? 80 : 24} maxRows={big ? 40 : 12} fitWidth={width} card labels={chartLabels(cell.labels, concepts)} />
        </div>
      ) : null
      // a code card is its code (what the analyst asked to see), with what it printed or returned under it; a card of
      // another kind shows only its run's artifact
      if (cell.kind === 'code' && cell.code?.trim())
        return (
          <div className="bcell-codecard">
            <Clamp max={big ? CODE_MAX_BIG : CODE_MAX}>
              <pre className="bcell-code">
                <CodeText text={cell.code.replace(/\s+$/, '')} lang="python" />
              </pre>
            </Clamp>
            {output}
          </div>
        )
      // no output yet: the running line or the failed mark under the body says the state
      return output
    }
  }
}

/**
 * A box that shows its content up to `max` px, faded at the bottom when there is more, with Show all under it that
 * opens it whole (and Show less that closes it). Used where a card quotes something long: a record, a label's code.
 */
function Clamp({ max, className, children }: { max: number; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || open) return
    const check = () => setClipped(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null
    ro?.observe(el)
    for (const child of Array.from(el.children)) ro?.observe(child)
    return () => ro?.disconnect()
  })
  return (
    <>
      <div ref={box} className={`bcell-clamp${clipped && !open ? ' is-clipped' : ''}${className ? ` ${className}` : ''}`} style={open ? undefined : { maxHeight: max }}>
        {children}
      </div>
      {(clipped || open) && (
        <button type="button" className="bcell-more" onMouseDown={(e) => e.stopPropagation()} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  )
}

/** the height of a code card's code before Show all: about twelve lines, and more in focus mode */
const CODE_MAX = 220
const CODE_MAX_BIG = 520

/** the height a quoted record shows before Show all: one alone, one of several, and each in focus mode */
const QUOTE_MAX = 330
const QUOTES_MAX = 128
const QUOTE_MAX_BIG = 640
const QUOTES_MAX_BIG = 260

/** A ref to an image, a recording or a video, shown as itself at the card's width, a recording started at the moment
 * its ref names (lib/media); the player's controls take the mouse, not the card's drag. */
function MediaExample({ ws, media }: { ws: string; media: MediaRef }) {
  const src = mediaUrl(ws, media)
  const keep = (e: { stopPropagation: () => void }) => e.stopPropagation()
  if (media.kind === 'image') return <img className="bcell-media" src={src} alt="" loading="lazy" />
  if (media.kind === 'audio') return <audio className="bcell-media" src={src} controls preload="metadata" onMouseDown={keep} />
  return <video className="bcell-media" src={src} controls preload="metadata" onMouseDown={keep} />
}

/**
 * An example card's body: one record quoted under its address, or several as a numbered list. The address opens the
 * record. A ref to an image, recording or video shows the file itself (MediaExample).
 */
function ExampleBody({ refs, ws, big }: { refs: string[]; ws: string; big: boolean }) {
  const [got, setGot] = useState<Record<string, ResolvedRef | null>>({})
  useEffect(() => {
    let alive = true
    for (const ref of refs.filter((r) => !mediaOf(r))) void resolvedOf(ws, ref).then((r) => alive && setGot((cur) => (cur[ref] === r ? cur : { ...cur, [ref]: r })))
    return () => {
      alive = false
    }
  }, [ws, refs])
  if (!refs.length) return null
  const open = (r: string) => {
    track('chip-teleport', { target: r, detail: { kind: 'example' } })
    teleport(r, { browser: true })
  }
  const address = (r: string) => <Address r={r} onOpen={open} />
  // under the address, one record's facts (time, author, page; canvas/facts); a range spans several records and shows none
  const facts = (r: string) => {
    const res = got[r]
    if (!res || !FACT_KINDS.has(res.kind)) return null
    const f = recordFacts(res)
    return f.length ? <RecordFacts facts={f} /> : null
  }
  // the record behind a faint rule: the cited words highlighted, the words around them in the tertiary (Quote.tsx)
  const body = (r: string, max: number) => {
    const media = mediaOf(r)
    if (media) return <MediaExample ws={ws} media={media} />
    const res = got[r]
    if (!res) return null
    const parts = quoteParts(res)
    if (!parts.length) return null
    return (
      <Clamp max={max} className="bcell-q-body">
        <QuoteParts parts={parts} />
      </Clamp>
    )
  }
  const quote = (r: string, max: number) => (
    <>
      <div className="bcell-address-row">
        {address(r)}
        {facts(r)}
      </div>
      <div className="bcell-quote-rec">{body(r, max)}</div>
    </>
  )
  // drawn once every record it quotes has come back (a media file draws itself)
  const settled = refs.every((r) => mediaOf(r) || r in got) ? 'true' : 'false'
  if (refs.length === 1) {
    return (
      <div className="bcell-quote" data-body="" data-settled={settled} data-part={refs[0]}>
        {quote(refs[0], big ? QUOTE_MAX_BIG : QUOTE_MAX)}
      </div>
    )
  }
  return (
    <ol className="bcell-quotes" data-body="" data-settled={settled}>
      {refs.map((r, i) => (
        <li key={r}>
          <span className="bcell-quotes-n">{i + 1}</span>
          <div className="bcell-quote" data-part={r}>
            {quote(r, big ? QUOTES_MAX_BIG : QUOTES_MAX)}
          </div>
        </li>
      ))}
    </ol>
  )
}

/** Where an example's record is: the evidence chip with the file's glyph and the record's full address, which opens it
 * in Files at the quoted passage. Unlike other links inside a card, an example keeps its full address. */
function Address({ r, onOpen }: { r: string; onOpen: (r: string) => void }) {
  const { props, tip } = useTooltip(hiddenPath(r))
  return (
    <Chip kind="ref" tone={refTone(r)} icon={refIcon(r)} className="bcell-address" data-anchor={r} aria-label={`Open ${addressLabel(r)} in Files`} onMouseDown={(e) => e.stopPropagation()} onClick={() => onOpen(r)} {...props}>
      {addressLabel(r)}
      {tip}
    </Chip>
  )
}

/** A JSON record's text as one line of its own words (canvas/quotes), whole or cut short as a label's row keeps it; the
 * text itself when it is not JSON. */
function recordLine(text: string): string {
  const parts = jsonRecordParts(text)
  return (parts && quoteLine(parts)) || text
}

/** the characters of a value's one example the label card keeps (backend concepts.MATCH_WINDOW) */
const LABEL_EXAMPLE_MAX = 240
/** the rows of each value the card picks its example from, so a value whose first row repeats another value's example
 * can show its next (backend render.LABEL_ROWS) */
const EXAMPLE_ROWS = 3

/** A row's example: the words around its match when the server found them, else its own text, else the record's own
 * words (quoteLine). Without a match, units whose text only shows how they begin give none (unmatchedExample). */
async function exampleOf(ws: string, row: LabelRowText, unit: string | undefined): Promise<ValueExample | null> {
  const own = typeof row.text === 'string' ? row.text.trim() : ''
  if (own && row.match) return { text: plainMarkdown(own), match: plainMarkdown(row.match) }
  if (own) return unmatchedExample(unit, own, row.ref) && { text: own.startsWith('{') ? recordLine(own) : plainMarkdown(own) }
  if (unit === 'cell' || unit === 'span' || wholeUnit(unit, row.ref)) return null
  const res = await resolvedOf(ws, row.ref)
  return res ? unmatchedExample(unit, quoteLine(quoteParts(res)), row.ref) : null
}

/**
 * One example per value for a label card, from the first EXAMPLE_ROWS rows of each value, none repeating another
 * value's (pickExamples).
 */
function useValueExamples(ws: string, conceptId: string, values: readonly string[], labels: readonly string[], unit: string | undefined, stamp: string): Record<string, ValueExample> {
  const [examples, setExamples] = useState<Record<string, ValueExample>>({})
  const key = values.join('\u0000')
  const labelKey = labels.join('\u0000')
  useEffect(() => {
    let alive = true
    setExamples({})
    if (!conceptId || !key) return
    const vals = key.split('\u0000')
    const noMatch = noMatchValues(labelKey ? labelKey.split('\u0000') : [])
    void Promise.all(
      vals.map((v) =>
        labelApi
          .rows(ws, conceptId, { value: v, limit: EXAMPLE_ROWS, offset: 0 })
          .then((r) => Promise.all(r.rows.map((row) => exampleOf(ws, row, unit).catch(() => null))))
          .then((xs) => exampleCandidates(v, noMatch, xs.filter((x): x is ValueExample => !!x)))
          .catch(() => [] as ValueExample[]),
      ),
    ).then((lists) => alive && setExamples(pickExamples(vals, Object.fromEntries(vals.map((v, i) => [v, lists[i]])))))
    return () => {
      alive = false
    }
  }, [ws, conceptId, key, labelKey, unit, stamp])
  return examples
}

/** The model a prompt label judges with: the labels role's, else main's, from the workspace settings. */
function useLabelModel(ws: string, on: boolean): string {
  const [model, setModel] = useState('')
  useEffect(() => {
    if (!on) return
    let alive = true
    loadSettings(ws)
      .then((s) => alive && setModel(String(s.models?.labels?.model ?? '')))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws, on])
  return model
}

/** the height of a label's code or pattern before Show all: about six lines */
const LABEL_SPEC_MAX = 112

/** Whether a label card's title is a question of its own (apply_label's `question`) rather than the label's name. */
export const asksQuestion = (title: string | undefined, name: string): boolean => {
  const t = (title ?? '').trim().toLowerCase()
  return !!t && t !== name.trim().toLowerCase()
}

/**
 * A label card's body, drawn by a fixed template (a label card is deterministic, so no model checks it): the file glob
 * when the card has a question of its own, the value table (value · units · share, each value a button that sets the
 * scope's filter), one example per value with the words that earned it highlighted, and a `kind · show rule` line that
 * opens the classifier's prompt, pattern or code. While a run goes on, the line says how far it has come.
 */
function LabelBody({ conceptId, concept, error, title }: { conceptId: string; concept: ConceptDetail | null; error: string | null; title?: string }) {
  const ctx = useContext(CanvasContext)
  const { ws } = ctx
  const [pending, setPending] = useState<string | null>(null)
  const [ruleOpen, setRuleOpen] = useState(false)
  const known = concept ?? ctx.concepts.get(conceptId) ?? null
  const counts = known?.counts ?? {}
  const run = (known as ConceptDetail | null)?.run
  const running = run?.status === 'running'
  const values = known ? shownValues(labelValues(known.labels, counts), counts, running) : []
  const examples = useValueExamples(ws, conceptId, values, known?.labels ?? [], known?.unit, `${known?.n_labeled ?? 0}:${running ? 'run' : ''}`)
  const model = useLabelModel(ws, known?.kind === 'prompt' && !known?.model)
  if (error && !known) return <div className="bcell-plainerror">{error}</div>
  if (!known) return <div className="bcell-label" data-body="" data-settled="false" />
  const scope = scopeForUnit(known.unit)
  const total = known.n_labeled ?? Object.values(counts).reduce((a, b) => a + b, 0)
  const shares = labelShares(known.labels, counts, total)
  const noCounts = running && values.every((v) => !counts[v])
  const toggle = async (value: string) => {
    if (!scope || pending) return
    setPending(value)
    try {
      if (filterIs(ctx.filters, scope, conceptId, value)) {
        track('filter-clear', { target: `concept:${conceptId}`, detail: { scope, via: 'label-card' } })
        await api.deleteFilter(ws, scope)
      } else {
        track('filter-set', { target: `concept:${conceptId}`, detail: { scope, value, via: 'label-card' } })
        await api.putFilter(ws, scope, conceptId, value)
      }
    } catch (e) {
      fail(e)
    } finally {
      setPending(null)
    }
  }
  const spec = (known.spec || known.description || '').trim()
  const shown = values.filter((v) => examples[v])
  const files = isFilesLabel(known)
  const classes = files ? new Map(classesOf(known).map((c) => [c.name, c])) : null
  const glob = files && ctx.concepts.has(conceptId) && asksQuestion(title, conceptName(ctx.concepts, conceptId)) ? shortGlob(known.glob) : null
  const how = [known.kind, known.kind === 'prompt' && (known.model || model) ? modelLabel(known.model || model) : ''].filter(Boolean).join(' · ')
  // the whole files or runs its last run read only in part: the concepts list's `last_run`, a card's detail's last kept run
  const cut = (known.last_run ?? (known as ConceptDetail).applications?.at(-1))?.cut
  const done = run?.done ?? run?.labeled
  const progress = running && typeof done === 'number' ? (typeof run?.total === 'number' && run.total > 0 ? `${done.toLocaleString()} of ${run.total.toLocaleString()} ${unitWord(known.unit, run.total)}` : `${done.toLocaleString()} ${unitWord(known.unit, done)}`) : ''
  return (
    <div className="bcell-label" data-body="" data-settled="true">
      {glob?.short && (
        <span className="bcell-label-glob" title={glob.full}>
          {glob.short}
        </span>
      )}
      {values.length > 0 && (
        <table className="bcell-values">
          <thead>
            <tr>
              <th>value</th>
              <th className="num">{unitWord(known.unit, 2)}</th>
              <th className="num">share</th>
            </tr>
          </thead>
          <tbody>
            {values.map((v) => {
              const on = !!scope && filterIs(ctx.filters, scope, conceptId, v)
              const cls = classes?.get(v)
              return (
                <tr key={v}>
                  <td>
                    {classes ? <span className={`bcell-value-square${cls?.highlight ? ' is-lit' : ''}`} style={{ '--c': colourVar(cls?.color) } as CSSProperties} title={cls?.highlight ? 'highlighted in Files' : undefined} /> : null}
                    <button type="button" className={`bcell-value${on ? ' is-on' : ''}`} aria-pressed={on} disabled={!scope || pending != null} onClick={() => void toggle(v)} onMouseDown={(e) => e.stopPropagation()}>
                      {pending === v ? <Spinner size={10} label="setting the filter" /> : null}
                      {v}
                    </button>
                  </td>
                  <td className="num">{noCounts ? '—' : (counts[v] ?? 0).toLocaleString()}</td>
                  <td className="num">{noCounts ? '—' : shares.share[v]}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {values.length > 0 && !noCounts && shares.negatives.size > 0 && (
        <div className="bcell-values-total">
          {shares.matched.toLocaleString()} of {unitTotal(total, known.unit)} matched
        </div>
      )}
      {!running && cut && <ReadCutLine cut={cut} className="bcell-label-cut" />}
      {shown.length > 0 && (
        <ul className="bcell-label-examples">
          {shown.map((v) => {
            const part = exampleParts(examples[v], LABEL_EXAMPLE_MAX)
            return (
              <li key={v} className="bcell-label-example">
                <span className="bcell-label-example-value">{v}</span>
                {part.match ? (
                  <span className="bcell-label-example-text">
                    <span className="bcell-q-ctx">{part.before}</span>
                    <span className="bcell-q-passage hl">{part.match}</span>
                    <span className="bcell-q-ctx">{part.after}</span>
                  </span>
                ) : (
                  <span className="bcell-label-example-text">{part.before}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {spec && (
        <div className="bcell-label-how">
          <button type="button" className="bcell-label-rule-toggle" aria-expanded={ruleOpen} onMouseDown={(e) => e.stopPropagation()} onClick={() => setRuleOpen((o) => !o)}>
            {how} · {ruleOpen ? 'hide rule' : 'show rule'}
          </button>
          {ruleOpen && (
            <div className="bcell-label-def">
              {known.kind === 'prompt' ? (
                <q className="bcell-label-prompt">{spec}</q>
              ) : (
                <Clamp max={LABEL_SPEC_MAX}>
                  <pre className="bcell-label-spec">{spec}</pre>
                </Clamp>
              )}
            </div>
          )}
        </div>
      )}
      {running && (
        <div className="bcell-label-run">
          <Spinner size={10} label="applying" />
          {progress ? `applying · ${progress}` : 'applying'}
        </div>
      )}
    </div>
  )
}

/** A label card's head: the square (the label's colour for a label over files, else ink) and the label's name in mono,
 * and where it applies (for a label over files, what it marks and its glob). */
export function LabelHead({ conceptId }: { conceptId: string }) {
  const ctx = useContext(CanvasContext)
  const k = ctx.concepts.get(conceptId)
  const scope = scopeForUnit(k?.unit)
  const files = !!k && isFilesLabel(k)
  const where = k && files ? ['label', scope, `${marksOf(k)}s`, globPatterns(k.glob).join(', ')] : ['label', scope, k ? unitWord(k.unit, 2) : '']
  return (
    <span className="bcell-label-head">
      <span className="bcell-label-name">
        {files && isMultiClass(classesOf(k)) ? (
          <Icon name="label" size={11} className="bcell-label-tag" style={{ color: mainColour(k) }} />
        ) : (
          <span className="bcell-label-square" style={files ? { background: mainColour(k) } : undefined} />
        )}
        {conceptName(ctx.concepts, conceptId)}
      </span>
      <span className="bcell-label-where">{where.filter(Boolean).join(' · ')}</span>
    </span>
  )
}
