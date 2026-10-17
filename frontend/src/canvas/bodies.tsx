// What a card shows between its question and its takeaway, by kind: a plot or table (components/Outputs), shell output,
// a note's text, an example's quoted records, a label's values, a timeline or diagram (DataViz), a custom
// card's frame, a plan's steps (PlanBody). `width` is the room the body has.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChatMarkdown } from '../chat/markdown'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { CodeText } from '../components/Code'
import { CARD_MIME, chartLabels, Output, outIndex, primaryArtifact } from '../components/Outputs'
import { refIcon, refTone } from '../components/RefChip'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { useTooltip } from '../components/Tooltip'
import { againWords, classesOf, colourVar, isFilesLabel, isMultiClass, labelStatus, mainColour, stoppedText } from '../files/labels'
import { ReadCutLine } from '../files/ReadCutLine'
import { api, labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { mediaOf, mediaUrl, type MediaRef } from '../lib/media'
import { loadSettings, modelLabel } from '../lib/models'
import { addressLabel, hiddenPath } from '../lib/refs'
import { teleport } from '../lib/teleport'
import { track } from '../lib/telemetry'
import type { Cell, Concept, ConceptDetail, FilterScope, ResolvedRef } from '../lib/types'
import { CanvasContext } from './context'
import { CustomFrame, DatasetView } from './DataViz'
import { conceptName, type ConceptDetailState } from './concepts'
import { PlanBody } from './PlanBody'
import { labeledTotal, labelIdentity, labelShares, labelValues, shownValues, unitWord } from './details'
import { resolvedOf } from './excerpts'
import { FACT_KINDS, recordFacts } from './facts'
import { filterIs, kindOf, scopeForUnit } from './layout'
import { QuoteParts, RecordFacts } from './Quote'
import { TypeCard } from './TypeCard'
import { entryParts, exampleEntries, type ExampleEntry } from './quotes'

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })
/** Words as a sentence: the first letter capitalized and a period at the end. */
const sentenceOf = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`

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
      const raw = Array.isArray(payload.refs) ? (payload.refs as unknown[]) : []
      const quotes = Array.isArray(payload.quotes) ? (payload.quotes as unknown[]) : []
      const refs = raw.filter((r): r is string => typeof r === 'string')
      return <ExampleBody refs={refs} quotes={raw.flatMap((r, i) => (typeof r === 'string' ? [quotes[i]] : []))} ws={ws} big={big} question={cell.title ?? ''} takeaway={cell.takeaway ?? ''} />
    }
    case 'label': {
      const concept = typeof payload.concept === 'string' ? payload.concept : ''
      return concept ? <LabelBody cellId={cell.id} conceptId={concept} concept={label.concept} error={label.error} reload={label.reload} /> : null
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
          <Output bundle={art.bundle} maxLines={big ? 80 : 24} maxRows={big ? 40 : 12} frameRows={big ? undefined : CARD_TABLE_ROWS} fitWidth={width} card labels={chartLabels(cell.labels, concepts)} />
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
 * While closed, a box whose first highlight (.hl, a quoted passage) falls below what it shows opens at that highlight
 * with a few lines before it, faded at the top as well.
 */
function Clamp({ max, className, children }: { max: number; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [clip, setClip] = useState({ below: false, above: false })
  useLayoutEffect(() => {
    const el = box.current
    if (!el || open) return
    const check = () => {
      el.scrollTop = highlightTop(el)
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1
      const above = el.scrollTop > 0
      setClip((c) => (c.below === below && c.above === above ? c : { below, above }))
    }
    check()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null
    ro?.observe(el)
    for (const child of Array.from(el.children)) ro?.observe(child)
    return () => ro?.disconnect()
  })
  const clipped = clip.below || clip.above
  return (
    <>
      <div
        ref={box}
        className={`bcell-clamp${clip.below && !open ? ' is-clipped' : ''}${clip.above && !open ? ' is-scrolled' : ''}${className ? ` ${className}` : ''}`}
        style={open ? undefined : { maxHeight: max }}
      >
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

/** the room a clamped box keeps over its first highlight when it opens there: about two lines of what comes before */
const HIGHLIGHT_LEAD = 44

/** Where a clamped box scrolls to show its first highlight: 0 while the highlight's first line shows from the top (the
 * box as it always opened), else the highlight's top less HIGHLIGHT_LEAD, in the box's own px (the canvas may scale it). */
function highlightTop(el: HTMLElement): number {
  const hl = el.querySelector<HTMLElement>('.hl')
  if (!hl) return 0
  const box = el.getBoundingClientRect()
  const scale = el.offsetHeight ? box.height / el.offsetHeight || 1 : 1
  const line = hl.getClientRects()[0] ?? hl.getBoundingClientRect()
  const top = (line.top - box.top) / scale + el.scrollTop
  const bottom = (line.bottom - box.top) / scale + el.scrollTop
  // the bottom 36px of a clipped box fade out (canvas.css .bcell-clamp.is-clipped)
  return bottom <= el.clientHeight - 36 ? 0 : Math.max(0, Math.round(top - HIGHLIGHT_LEAD))
}

/** the height of a code card's code before Show all: about twelve lines, and more in focus mode */
const CODE_MAX = 220
const CODE_MAX_BIG = 520
/** the rows a table card's DataFrame shows on the board before `… n more rows`, as many as the terminal's card shows
 * (plugin/hooks/term/draw.ts MAX_TABLE_ROWS), so a long table keeps the board's Fit readable (bug hunt D5); focus mode
 * shows every row */
export const CARD_TABLE_ROWS = 15

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
 * record. Refs that name one record (three quotes of one JSON value) show it once with every quoted passage highlighted
 * (canvas/quotes exampleEntries, entryParts). A ref to an image, recording or video shows the file itself
 * (MediaExample).
 */
function ExampleBody({ refs, quotes, ws, big, question = '', takeaway = '' }: { refs: string[]; quotes: unknown[]; ws: string; big: boolean; question?: string; takeaway?: string }) {
  const [got, setGot] = useState<Record<string, ResolvedRef | null>>({})
  useEffect(() => {
    let alive = true
    for (const ref of new Set(refs.filter((r) => !mediaOf(r)))) void resolvedOf(ws, ref).then((r) => alive && setGot((cur) => (cur[ref] === r ? cur : { ...cur, [ref]: r })))
    return () => {
      alive = false
    }
  }, [ws, refs])
  const entries = useMemo(() => exampleEntries(refs, quotes), [refs, quotes])
  // what the card says of each record: the values its takeaway cites there, and its question's and takeaway's words
  const cited = useMemo(() => [...takeaway.matchAll(/\[\[([^\]|]*)\|([^\]]*)\]\]/g)].map((m) => ({ said: m[1].trim(), ref: m[2].trim() })), [takeaway])
  const words = `${question} ${takeaway.replace(/\[\[([^\]|]*)\|[^\]]*\]\]/g, '$1')}`
  if (!entries.length) return null
  const open = (r: string) => {
    track('chip-teleport', { target: r, detail: { kind: 'example' } })
    teleport(r, { browser: true })
  }
  const address = (r: string) => <Address r={r} onOpen={open} />
  const lookup = (r: string) => (r in got ? got[r] : undefined)
  // under the address, one record's facts (time, author, page; canvas/facts); a range spans several records and shows none
  const facts = (e: ExampleEntry) => {
    const res = got[e.refs[0]]
    if (!res || !FACT_KINDS.has(res.kind)) return null
    const f = recordFacts(res)
    return f.length ? <RecordFacts facts={f} /> : null
  }
  // the record behind a faint rule: the cited words highlighted, the words around them in the tertiary (Quote.tsx)
  const body = (e: ExampleEntry, max: number) => {
    const media = mediaOf(e.ref)
    if (media) return <MediaExample ws={ws} media={media} />
    const parts = entryParts(e, lookup, { said: cited.filter((c) => c.said && e.refs.includes(c.ref)).map((c) => c.said), words })
    if (!parts?.length) return null
    return (
      <Clamp max={max} className="bcell-q-body">
        <QuoteParts parts={parts} />
      </Clamp>
    )
  }
  const quote = (e: ExampleEntry, max: number) => (
    <>
      <div className="bcell-address-row">
        {address(e.ref)}
        {facts(e)}
      </div>
      <div className="bcell-quote-rec">{body(e, max)}</div>
    </>
  )
  // drawn once every record it quotes has come back (a media file draws itself)
  const settled = refs.every((r) => mediaOf(r) || r in got) ? 'true' : 'false'
  if (entries.length === 1) {
    return (
      <div className="bcell-quote" data-body="" data-settled={settled} data-part={entries[0].ref}>
        {quote(entries[0], big ? QUOTE_MAX_BIG : QUOTE_MAX)}
      </div>
    )
  }
  return (
    <ol className="bcell-quotes" data-body="" data-settled={settled}>
      {entries.map((e, i) => (
        <li key={e.ref}>
          <span className="bcell-quotes-n">{i + 1}</span>
          <div className="bcell-quote" data-part={e.ref}>
            {quote(e, big ? QUOTES_MAX_BIG : QUOTES_MAX)}
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

/** The small tag that says a card is a label's card, first on its label row (LabelHead, CardFace CardLabels). */
export function LabelKindTag() {
  return <span className="bcell-kind-tag">Label</span>
}

/** What a label card's label row says after the label's name (details labelIdentity): how the label is defined, what it
 * ran on, and how many units its shares are of, in one quiet line; the hover names every file pattern whole. */
export function LabelMeta({ label: k }: { label: Pick<Concept, 'kind' | 'unit' | 'glob' | 'n_labeled' | 'counts' | 'trial' | 'model'> }) {
  const { ws } = useContext(CanvasContext)
  const model = useLabelModel(ws, k.kind === 'prompt' && !k.model)
  const id = labelIdentity(k, k.kind === 'prompt' && (k.model || model) ? modelLabel(k.model || model) : '')
  const parts = [id.how && <span key="how">{id.how}</span>, <span key="where" title={id.full !== id.where ? id.full : undefined}>{id.where}</span>, id.units && <span key="units">{id.units}</span>].filter(Boolean)
  return <span className="bcell-label-meta">{parts.flatMap((part, i) => (i ? [' · ', part] : [part]))}</span>
}

/**
 * A label card's body, drawn by a fixed template (a label card is deterministic, so no model checks it); the label row
 * above it names the label (LabelHead, CardFace CardLabels). The value table: value · units · share, each value a
 * button that sets the scope's filter, its tooltip saying what the click shows (ValueButton), every value's share of the same total (details labelShares); the units that
 * total is of the label row states. Under it the Rule disclosure, closed, which opens the classifier's prompt, pattern
 * or code, and Definition and records, which opens the label's definition and its records under each value in the
 * card's details (DetailPanel LabelDetails); it shows only on the board and in focus mode, where those details open,
 * not in a report's figure or the card harness's picture. The card shows no record of the corpus itself (Matt
 * 2026-10-15: "examples in label card should always be collapsed by default, and we have to be very careful here").
 * While a run goes on, a line says how far it has come. A last run that was stopped (by the analyst, or by quitting
 * Claude Code) says where it stopped, so its counts do not read as the whole scope's, with Run again on the board (bug
 * hunt H3: a run the quit stopped at 8,447 of 14,591 records read as finished).
 */
function LabelBody({ cellId, conceptId, concept, error, reload }: { cellId: string; conceptId: string; concept: ConceptDetail | null; error: string | null; reload?: () => Promise<void> }) {
  const ctx = useContext(CanvasContext)
  const { ws } = ctx
  const [pending, setPending] = useState<string | null>(null)
  const [ruleOpen, setRuleOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const known = concept ?? ctx.concepts.get(conceptId) ?? null
  const counts = known?.counts ?? {}
  const run = (known as ConceptDetail | null)?.run
  const running = run?.status === 'running'
  const values = known ? shownValues(labelValues(known.labels, counts), counts, running) : []
  if (error && !known) return <div className="bcell-plainerror">{error}</div>
  if (!known) return <div className="bcell-label" data-body="" data-settled="false" />
  const scope = scopeForUnit(known.unit)
  const shares = labelShares(values, counts, labeledTotal(known))
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
  const files = isFilesLabel(known)
  const classes = files ? new Map(classesOf(known).map((c) => [c.name, c])) : null
  // the whole files or runs its last run read only in part: the concepts list's `last_run`, a card's detail's last kept run
  const cut = (known.last_run ?? (known as ConceptDetail).applications?.at(-1))?.cut
  const done = run?.done ?? run?.labeled
  const progress = running && typeof done === 'number' ? (typeof run?.total === 'number' && run.total > 0 ? `${done.toLocaleString()} of ${run.total.toLocaleString()} ${unitWord(known.unit, run.total)}` : `${done.toLocaleString()} ${unitWord(known.unit, done)}`) : ''
  const records = () => {
    track('ui-click', { target: `cell:${cellId}`, detail: { action: 'label-records' } })
    ctx.openDetail?.(cellId)
  }
  // where its last run stopped, when it was stopped; Run again goes on with the units that run never read while the
  // definition stands (`resume`, bug hunt I3), else runs it as that run ran (a trial on its sample), its words saying which
  const lastRun = known.last_run ?? (known as ConceptDetail).applications?.at(-1) ?? null
  const status = running ? null : labelStatus({ ...known, last_run: lastRun }, run ?? null)
  const stopped = status?.state === 'done' && status.stopped ? status.stoppedAt ?? null : null
  const resume = known.resume ?? null
  const again = async () => {
    setStarting(true)
    try {
      track('label-apply', { target: `concept:${conceptId}`, detail: { again: 'stopped', via: 'label-card', ...(resume ? { resume: true } : {}) } })
      await labelApi.apply(ws, conceptId, resume ? { resume: true } : lastRun?.limit ? { limit: lastRun.limit } : {})
      await reload?.()
    } catch (e) {
      fail(e)
    } finally {
      setStarting(false)
    }
  }
  return (
    <div className="bcell-label" data-body="" data-settled="true">
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
                    <ValueButton value={v} on={on} cue={scope ? labelValueCue(scope, known.unit, noCounts ? null : (counts[v] ?? 0), on) : null} pending={pending === v} disabled={!scope || pending != null} onToggle={() => void toggle(v)} />
                  </td>
                  <td className="num">{noCounts ? '—' : (counts[v] ?? 0).toLocaleString()}</td>
                  <td className="num">{noCounts ? '—' : shares[v]}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {stopped && (
        <div className="bcell-label-stopped">
          <span>{sentenceOf(stoppedText(stopped, known.unit))}</span>
          {ctx.openDetail && (
            <Button variant="secondary" size="sm" busy={starting} onMouseDown={(e) => e.stopPropagation()} onClick={() => void again()}>
              {!resume && lastRun?.limit ? 'Run the sample again' : againWords(resume, stopped)}
            </Button>
          )}
        </div>
      )}
      {!running && cut && <ReadCutLine cut={cut} className="bcell-label-cut" />}
      {running && (
        <div className="bcell-label-run">
          <Spinner size={10} label="applying" />
          {progress ? `applying · ${progress}` : 'applying'}
        </div>
      )}
      {(spec || ctx.openDetail) && (
        <div className="bcell-label-foot">
          {spec && (
            <button type="button" className="bcell-label-rule-toggle" aria-expanded={ruleOpen} onMouseDown={(e) => e.stopPropagation()} onClick={() => setRuleOpen((o) => !o)}>
              <Icon name={ruleOpen ? 'chevron-down' : 'chevron-right'} size={12} />
              Rule ({known.kind})
            </button>
          )}
          {ctx.openDetail && (
            <Button variant="ghost" size="sm" icon="panel-right" className="bcell-label-records" onMouseDown={(e) => e.stopPropagation()} onClick={records}>
              Definition and records
            </Button>
          )}
        </div>
      )}
      {spec && ruleOpen && (
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
  )
}

/** What a click on a value of a label card does, as its tooltip says it: shows only the `n` units with that value
 * where the label's scope shows them (Files, the canvas, the report), or, while that filter is `on`, shows them all
 * again; `n` null while a run has counted none. Pure. */
export function labelValueCue(scope: FilterScope, unit: string | undefined, n: number | null, on: boolean): string {
  const all = unitWord(unit, 2)
  const these = n == null ? `the ${all} with this value` : n === 1 ? `this ${unitWord(unit, 1)}` : `these ${n.toLocaleString()} ${unitWord(unit, n)}`
  if (scope === 'files') return on ? `Show all ${all} in Files` : `Show ${these} in Files`
  if (scope === 'canvas') return on ? `Show all ${all}` : `Show only ${these}`
  return on ? `Show all ${all} in the report` : `Show only ${these} in the report`
}

/** A value of a label card's table: a button that sets the scope's filter to it, its tooltip saying what the click does
 * (labelValueCue), on hover and at keyboard focus. */
function ValueButton({ value, on, cue, pending, disabled, onToggle }: { value: string; on: boolean; cue: string | null; pending: boolean; disabled: boolean; onToggle: () => void }) {
  const { props, tip } = useTooltip(disabled ? null : cue, undefined, 'start')
  return (
    <button type="button" className={`bcell-value${on ? ' is-on' : ''}`} aria-pressed={on} disabled={disabled} onClick={onToggle} onMouseDown={(e) => e.stopPropagation()} {...props}>
      {pending ? <Spinner size={10} label="setting the filter" /> : null}
      {value}
      {tip}
    </button>
  )
}

/** A label card's head when the card has no question of its own: the Label tag, the square (the label's colour for a
 * label over files, else ink) and the label's name in mono, then what the label row says of it (LabelMeta). `detail`
 * is the card's own copy of the label, else the board's list's. */
export function LabelHead({ conceptId, detail }: { conceptId: string; detail?: Concept | null }) {
  const ctx = useContext(CanvasContext)
  const k = detail ?? ctx.concepts.get(conceptId)
  const files = !!k && isFilesLabel(k)
  return (
    <span className="bcell-label-head">
      <span className="bcell-label-name">
        <LabelKindTag />
        {files && isMultiClass(classesOf(k)) ? (
          <Icon name="label" size={11} className="bcell-label-tag" style={{ color: mainColour(k) }} />
        ) : (
          <span className="bcell-label-square" style={files ? { background: mainColour(k) } : undefined} />
        )}
        {conceptName(ctx.concepts, conceptId)}
      </span>
      {k && <LabelMeta label={k} />}
    </span>
  )
}
