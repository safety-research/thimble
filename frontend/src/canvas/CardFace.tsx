// A card as the analyst sees it at rest: its question, the Labels row, its body by kind (bodies.tsx) and its takeaway,
// in the card's own box. The board's CellCard (Cell.tsx) adds hover chrome around it, and the card harness
// (render.tsx) mounts it alone, so the image a check reads is the card the canvas draws. The face also shows the card
// check's state: a shimmer while it runs, its replacement faded in once confirmed, and a mark at the takeaway's corner.
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChatMarkdown } from '../chat/markdown'
import { Button } from '../components/Button'
import { TextArea } from '../components/Field'
import { Icon } from '../components/Icon'
import { Mark } from '../components/Marks'
import { Popover } from '../components/Menu'
import { GlyphCites } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { placeTip, TipButton, useTooltip } from '../components/Tooltip'
import { draftProblem, LabelSheet, patchOf, withSavedColours } from '../files/LabelCard'
import { classesOf, isFilesLabel, isMultiClass, mainColour } from '../files/labels'
import { addAgentZone, tintElement } from '../lib/agentKey'
import { api, labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { checkable, checkLine, checkOf, typedLine, type CardCheck } from '../lib/cardCheck'
import { conceptLabel, ensureConceptName, hasConceptName, onCellNames } from '../lib/cellName'
import { track } from '../lib/telemetry'
import { teleport } from '../lib/teleport'
import type { Cell, Concept } from '../lib/types'
import { CardBody, LabelHead, asksQuestion } from './bodies'
import { conceptName, labelsShown, staleLabels, type ConceptDetailState } from './concepts'
import { CanvasContext } from './context'
import { editedLabels, labelDraft, setLabelDraft, useLabelDrafts } from './labelDrafts'
import { isRunnable, kindOf } from './layout'
import { RefEditor } from './RefEditor'

export type CardField = 'title' | 'takeaway'

export interface CardFaceProps {
  cell: Cell
  /** the room the body has, px */
  width: number
  label: ConceptDetailState
  /** first in the card: the hover chrome the board adds; none in the harness */
  chrome?: ReactNode
  /** last in the card: the grip and the unread dot */
  after?: ReactNode
  /** the stop control on the running line */
  stop?: ReactNode
  /** the field edited in place, and where the click that opened it landed, for the caret */
  editing?: CardField | null
  editAt?: { x: number; y: number } | null
  /** the text typed in place, when the field is left */
  onEdited?: (field: CardField, value: string) => void
  /** ⌘↵ in the question typed in place (lib/agentKey): the question, to save and send to main */
  onAsk?: (field: CardField, value: string) => void
  /** a request about the card is out with main: `sent to main` stands where `running` would */
  asking?: boolean
  onTextDown?: (field: CardField) => (e: MouseEvent<HTMLElement>) => void
  onTextClick?: (field: CardField) => (e: MouseEvent<HTMLElement>) => void
  /** Undo in the check mark's hover */
  onUndoFix?: (check: CardCheck) => void
  /** a click on the check mark: run the check again (none in the harness, whose card has no mark) */
  onCheckAgain?: () => void
  /** a click on a running check's mark: stop it */
  onStopCheck?: () => void
  cardRef?: (el: HTMLElement | null) => void
}

/** The face in its card's context: a citation in the card's content is its target's glyph alone (components/RefChip
 * GlyphCites). */
export function CardFace(p: CardFaceProps) {
  return (
    <GlyphCites.Provider value={true}>
      <Face {...p} />
    </GlyphCites.Provider>
  )
}

function Face(p: CardFaceProps) {
  const { cell } = p
  const ctx = useContext(CanvasContext)
  const kind = kindOf(cell)
  const payload = (cell.payload ?? {}) as Record<string, unknown>
  const concept = kind === 'label' ? String(payload.concept ?? '') : ''
  const running = cell.status === 'running'
  const failed = cell.status === 'error' && !running
  const check = checkOf(cell)
  const swapped = useSwap(check?.fix?.id ?? null)
  const cls = ['canvas-card']
  if (check?.state === 'running') cls.push('is-checking')
  if (swapped) cls.push('is-swapped')
  return (
    <article
      className={cls.join(' ')}
      ref={p.cardRef}
      data-anchor={`card:${cell.id}`}
      data-anchor-text={cell.title}
      data-anchor-parts=""
      data-cell={cell.id}
      data-cite-home={cell.id}
      data-concept={concept || undefined}
      data-status={cell.status || undefined}
      data-check={check?.state || undefined}
    >
      {p.chrome}
      <div className="bcell-head">
        {kind === 'label' && concept && !(ctx.concepts.has(concept) && asksQuestion(cell.title, conceptName(ctx.concepts, concept))) ? (
          <LabelHead conceptId={concept} />
        ) : p.editing === 'title' ? (
          <InlineField className="bcell-q" value={cell.title} onDone={(v) => p.onEdited?.('title', v)} onAsk={p.onAsk ? (v) => p.onAsk?.('title', v) : undefined} />
        ) : (
          <span className="bcell-q" data-anchor={`card:${cell.id}`} data-anchor-text={cell.title} onMouseDown={p.onTextDown?.('title')} onClick={p.onTextClick?.('title')}>
            {cell.title}
          </span>
        )}
      </div>
      <CardLabels cell={cell} />
      <div className="bcell-body">
        <CardBody cell={cell} width={p.width} label={p.label} />
      </div>
      {running && (
        <div className="bcell-run" role="status">
          <Spinner size={10} label="running" />
          <span>running</span>
          <span className="bcell-spacer" />
          {p.stop}
        </div>
      )}
      {p.asking && !running && (
        <div className="bcell-run" role="status">
          <Spinner size={10} label="working" />
          <span>sent to main</span>
        </div>
      )}
      {failed && (
        <div className="bcell-failed" role="status">
          <Mark kind="failed" /> failed
        </div>
      )}
      {p.editing === 'takeaway' ? (
        <div className="bcell-take">
          <RefEditor className="bcell-take-text chat-text bcell-edit-take" label="Takeaway" value={cell.takeaway ?? ''} at={p.editAt ?? null} onDone={(v) => p.onEdited?.('takeaway', v)} />
        </div>
      ) : cell.takeaway ? (
        <div className="bcell-take" data-anchor={`card:${cell.id}`} data-anchor-text={cell.takeaway} onMouseDown={p.onTextDown?.('takeaway')} onClick={p.onTextClick?.('takeaway')}>
          <div className="chat-text bcell-take-text">
            <ChatMarkdown text={cell.takeaway} />
          </div>
          <CheckMark check={check} idle={!check && !!p.onCheckAgain && checkable(cell)} onUndo={p.onUndoFix} onAgain={p.onCheckAgain} onStop={p.onStopCheck} />
        </div>
      ) : check ? (
        <div className="bcell-take bcell-take-none">
          <div className="chat-text bcell-take-text" />
          <CheckMark check={check} onUndo={p.onUndoFix} onAgain={p.onCheckAgain} onStop={p.onStopCheck} />
        </div>
      ) : null}
      {p.after}
    </article>
  )
}

/** How long a confirmed fix takes to fade in, ms (styles/canvas.css .is-swapped). */
const SWAP_MS = 320

/** True for SWAP_MS after the fix stamp changes (not on the first render). */
function useSwap(stamp: string | null): boolean {
  const seen = useRef(stamp)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (stamp === seen.current) return
    seen.current = stamp
    if (!stamp) return
    setOn(true)
    const t = setTimeout(() => setOn(false), SWAP_MS)
    return () => clearTimeout(t)
  }, [stamp])
  return on
}

/** The labels the card uses (concepts.labelsShown), in a row under its question, each a tag in the label's colour. A
 * click opens the label's edit card in a popover. A label with unrun edits or that changed since the card ran turns
 * red and offers Regenerate Card; nothing re-runs by itself. */
export function CardLabels({ cell }: { cell: Cell }) {
  const ctx = useContext(CanvasContext)
  const ids = labelsShown(cell, ctx.concepts)
  const stale = staleLabels(cell, ctx.concepts)
  useLabelDrafts()
  const edited = editedLabels(ctx.ws, cell, ctx.concepts)
  // a label the board's list does not name yet takes its name from the workspace's labels
  const key = ids.join(' ')
  useSyncExternalStore(onCellNames, () => ids.map((id) => conceptLabel(id) ?? '').join('\n'))
  useEffect(() => {
    for (const id of key.split(' ').filter(Boolean)) if (!ctx.concepts.get(id)?.name && !hasConceptName(id)) void ensureConceptName(ctx.ws, id)
  }, [ctx.ws, ctx.concepts, key])
  if (!ids.length) return null
  const regenerate = (stale.size > 0 || edited.size > 0) && isRunnable(cell)
  return (
    <div className="bcell-labels">
      <span className="bcell-labels-key">Labels:</span>
      {ids.map((id) => (
        <LabelTag
          key={id}
          id={id}
          label={ctx.concepts.get(id) ?? null}
          ws={ctx.ws}
          why={edited.has(id) ? `Edited, not run yet: ${edited.get(id)!.join('; ')}` : stale.has(id) ? `Changed since this card ran: ${stale.get(id)}` : null}
          regenerate={regenerate ? <RegenerateCard cell={cell} primary /> : undefined}
        />
      ))}
      {regenerate && <RegenerateCard cell={cell} />}
    </div>
  )
}

/**
 * Save the unrun edits of each label `cell` uses, then ask the server to run the card again on its labels as they are
 * now (POST /cells/{id}/regenerate). Throws the first problem, with the label's name, before anything is saved.
 */
export async function regenerateCard(ws: string, cell: Cell, concepts: ReadonlyMap<string, Concept>): Promise<void> {
  const edits = [...editedLabels(ws, cell, concepts).keys()].map((id) => {
    const k = concepts.get(id)!
    const draft = labelDraft(ws, id)!
    const classes = withSavedColours(k, draft)
    const problem = draftProblem(draft, classes)
    if (problem) throw new Error(`${k.name}: ${problem}`)
    return { k, draft, patch: patchOf(draft, classes) }
  })
  for (const { k, draft, patch } of edits) {
    await labelApi.update(ws, k.id, patch)
    setLabelDraft(ws, k.id, null)
    track('label-apply', { target: `concept:${k.id}`, detail: { over: draft.over, marks: draft.over === 'files' ? draft.marks : null, kind: draft.kind, created: false, from: `cell:${cell.id}` } })
  }
  await api.regenerateCell(ws, cell.id)
}

/** The Regenerate Card of a card whose label has edits or changed (CardLabels): a ghost button at the end of the Labels
 * row, or with `primary` the popover's own. It turns while a label it waits for runs and while the card runs. */
function RegenerateCard({ cell, primary }: { cell: Cell; primary?: boolean }) {
  const ctx = useContext(CanvasContext)
  const [busy, setBusy] = useState(false)
  const running = cell.status === 'running' || (cell.labels ?? []).some((id) => ctx.concepts.get(id)?.run?.status === 'running')
  const go = async () => {
    setBusy(true)
    try {
      await regenerateCard(ctx.ws, cell, ctx.concepts)
      ctx.refresh()
    } catch (e) {
      bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      variant={primary ? 'primary' : 'ghost'}
      size="sm"
      icon="refresh"
      busy={busy || running}
      className={primary ? 'label-sheet-regen' : 'bcell-regen'}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => void go()}
    >
      Regenerate Card
    </Button>
  )
}

/** One label's tag in the Labels row, and the popover its click opens (LabelSheet, edits kept in labelDrafts). A label
 * the board's list does not hold yet opens its card on the canvas instead. `why` is what makes the tag red. */
function LabelTag({ id, label: k, ws, why, regenerate }: { id: string; label: Concept | null; ws: string; why: string | null; regenerate?: ReactNode }) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const { props: tipProps, tip } = useTooltip(why && !open ? why : null)
  const name = k?.name || conceptLabel(id) || 'a label'
  const colour = k && isFilesLabel(k) && !isMultiClass(classesOf(k)) ? mainColour(k) : null
  const openInFiles = () => {
    setOpen(false)
    bus.emit('showTab', { tab: 'files' })
    bus.emit('editLabel', { id })
  }
  // the label's card when it has one, else its review in the canvas's side panel (Canvas, LabelPanel)
  const review = () => {
    setOpen(false)
    teleport(`concept:${id}`)
  }
  return (
    <>
      <button
        type="button"
        ref={setEl}
        className={'bcell-tag' + (colour ? '' : ' is-plain') + (why ? ' is-stale' : '')}
        style={colour ? ({ '--c': colour } as CSSProperties) : undefined}
        aria-expanded={k ? open : undefined}
        data-anchor={`concept:${id}`}
        data-anchor-text={name}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => (k ? setOpen((o) => !o) : teleport(`concept:${id}`))}
        {...tipProps}
      >
        <Icon name="label" size={10} className="bcell-tag-icon" />
        <span className="bcell-tag-name">{name}</span>
        {tip}
      </button>
      {k && (
        <Popover anchor={el} open={open} onClose={() => setOpen(false)} width={360} label={name} className="label-sheet-popover">
          {/* the popover is portaled, so a double click in its fields would still reach the card's focus mode (Cell) */}
          <div onDoubleClick={(e) => e.stopPropagation()}>
            <LabelSheet
              ws={ws}
              label={k}
              draft={labelDraft(ws, id)}
              onDraft={(d) => setLabelDraft(ws, id, d)}
              onClose={() => setOpen(false)}
              onOpen={openInFiles}
              onReview={review}
              regenerate={regenerate}
            />
          </div>
        </Popover>
      )}
    </>
  )
}

/**
 * The card check's mark at the takeaway's bottom right: a spinner while running, a check glyph when done, a run-again
 * glyph when it failed or was stopped. Its hover explains the state (with Undo for an applied replacement); a click
 * stops a running check or runs a finished one again. With `idle`, an unchecked card shows a faint mark on hover.
 */
function CheckMark({ check, idle, onUndo, onAgain, onStop }: { check: CardCheck | null; idle?: boolean; onUndo?: (check: CardCheck) => void; onAgain?: () => void; onStop?: () => void }) {
  const [open, setOpen] = useState(false)
  const at = useRef<HTMLButtonElement>(null)
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (hide.current && clearTimeout(hide.current)), [])
  if (!check && idle && onAgain) {
    const stopIt = (e: MouseEvent) => e.stopPropagation()
    return (
      <span className="bcell-check bcell-check-idle" onMouseDown={stopIt} onClick={stopIt}>
        <TipButton tip="Not checked. Click to check the card" className="bcell-check-mark is-idle" onClick={() => onAgain()}>
          <Icon name="check" size={12} />
        </TipButton>
      </span>
    )
  }
  if (!check) return null
  const enter = () => {
    if (hide.current) clearTimeout(hide.current)
    setOpen(true)
  }
  const leave = () => {
    hide.current = setTimeout(() => setOpen(false), 180)
  }
  const stop = (e: MouseEvent) => e.stopPropagation()
  const running = check.state === 'running'
  const act = running ? onStop : onAgain
  const fix = check.fix
  const title = fix?.before.title
  const takeaway = fix?.before.takeaway
  const line = checkLine(check)
  const typed = typedLine(check)
  const ended = check.state === 'failed' || check.state === 'stopped'
  return (
    <span className="bcell-check" onMouseEnter={enter} onMouseLeave={leave} onMouseDown={stop} onClick={stop}>
      <button
        ref={at}
        type="button"
        className={`bcell-check-mark is-${check.state}${check.phase ? ` is-${check.phase}` : ''}${typed ? ' is-flagged' : ''}`}
        aria-label={[line, typed.replace(/\.$/, ''), act ? (running ? 'Stop the check' : 'Check again') : ''].filter(Boolean).join('. ')}
        aria-disabled={!act || undefined}
        onFocus={enter}
        onBlur={leave}
        onClick={() => {
          setOpen(false)
          act?.()
        }}
      >
        {running ? <Spinner size={10} /> : <Icon name={ended ? 'refresh' : typed ? 'flag' : 'check'} size={12} />}
      </button>
      {open && at.current && (
        <CheckPop anchor={at.current} onEnter={enter} onLeave={leave} label="The card check">
          <span className="bcell-check-when">{line}</span>
          {typed && <span className="bcell-check-what">{typed}</span>}
          {check.note && <span className="bcell-check-what">{check.note}.</span>}
          {ended && <span className="bcell-check-what">This check changed nothing on the card.</span>}
          {running && onStop && (
            <span className="bcell-check-acts">
              <Button
                variant="ghost"
                size="sm"
                icon="stop"
                onClick={() => {
                  setOpen(false)
                  onStop()
                }}
              >
                Stop
              </Button>
            </span>
          )}
          {fix?.reason && <span className="bcell-check-what">Revised: {fix.reason}</span>}
          {fix && (title != null || takeaway != null) && (
            <span className="bcell-check-before">
              <span className="bcell-check-label">Before</span>
              {title != null && <span className="bcell-check-q">{title}</span>}
              {takeaway != null && (
                <span className="chat-text">
                  <ChatMarkdown text={takeaway || '—'} />
                </span>
              )}
            </span>
          )}
          {!running && (onAgain || (fix && onUndo)) && (
            <span className="bcell-check-acts">
              {fix && onUndo && (
                <Button variant="ghost" size="sm" icon="undo" onClick={() => onUndo(check)}>
                  Undo
                </Button>
              )}
              {onAgain && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="refresh"
                  onClick={() => {
                    setOpen(false)
                    onAgain()
                  }}
                >
                  Check again
                </Button>
              )}
            </span>
          )}
        </CheckPop>
      )}
    </span>
  )
}

/** The mark's hover card, on the page rather than in the card (a card clips what runs past its edge), under the mark
 * or over it where there is no room below. */
function CheckPop({ anchor, onEnter, onLeave, label, children }: { anchor: HTMLElement; onEnter: () => void; onLeave: () => void; label: string; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const pop = el.current
    if (pop) setPos(placeTip(anchor.getBoundingClientRect(), pop.offsetWidth, pop.offsetHeight, window.innerWidth, window.innerHeight))
  }, [anchor])
  return createPortal(
    <div
      ref={el}
      className="bcell-check-pop overlay"
      role="dialog"
      aria-label={label}
      style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}

/** The question as a bare field in its place: Enter (or leaving it) keeps it, Escape leaves it as it was, and ⌘↵ hands
 * it to `onAsk` (lib/agentKey), which saves it and sends it to main. */
function InlineField({ value, onDone, onAsk, className }: { value: string; onDone: (v: string) => void; onAsk?: (v: string) => void; className: string }) {
  const [text, setText] = useState(value)
  const gone = useRef(false)
  const field = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => setText(value), [value])
  const finish = (v: string) => {
    if (gone.current) return
    gone.current = true
    onDone(v)
  }
  const now = useRef({ text, onAsk })
  now.current = { text, onAsk }
  useEffect(() => {
    const root = field.current
    if (!root || !onAsk) return
    return addAgentZone(root, () => {
      const typed = now.current.text.trim()
      const send = now.current.onAsk
      if (!typed || !send || gone.current) return null
      return {
        tint: tintElement(() => field.current),
        send: () => {
          gone.current = true
          send(typed)
        },
      }
    })
  }, [!!onAsk]) // eslint-disable-line react-hooks/exhaustive-deps
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') finish(value)
    else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      finish(text)
    }
  }
  return (
    <TextArea
      ref={field}
      bare
      block
      autoGrow
      autoFocus
      rows={1}
      maxHeight={160}
      className={`bcell-edit ${className}`}
      value={text}
      onChange={setText}
      onKeyDown={onKey}
      onBlur={() => finish(text)}
      onMouseDown={(e) => e.stopPropagation()}
      aria-label="Question"
    />
  )
}
