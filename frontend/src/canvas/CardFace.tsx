// A card as the analyst sees it at rest: its question, the Labels row, its body by kind (bodies.tsx) and its takeaway,
// in the card's own box. The board's CellCard (Cell.tsx) adds hover chrome around it, and the card harness
// (render.tsx) mounts it alone, so the image a check reads is the card the canvas draws. The face also shows the card
// check, only as far as the analyst needs it at rest: a shimmer while it runs, its replacement faded in once confirmed,
// and a red ✕ at the takeaway's corner only for a real problem it found (lib/cardCheck checkProblem). The rest of the
// check, the fix's Undo among it, is in the card's details (CheckDetails).
// The body shimmers the same way while the card's code runs, as when an edit_card call is changing it, and the card
// shimmers as in a check while thimble runs it again because a label it read changed.
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChatMarkdown } from '../chat/markdown'
import { Button } from '../components/Button'
import { CheckMark as SharedCheckMark } from '../components/CheckMark'
import { TextArea } from '../components/Field'
import { Icon } from '../components/Icon'
import { Mark } from '../components/Marks'
import { Popover } from '../components/Menu'
import { GlyphCites } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { placeTip, useTooltip } from '../components/Tooltip'
import { LabelSheet } from '../files/LabelCard'
import { classesOf, isFilesLabel, isMultiClass, mainColour } from '../files/labels'
import { addAgentZone, tintElement } from '../lib/agentKey'
import { bus } from '../lib/bus'
import { checkOf, checkProblem } from '../lib/cardCheck'
import { conceptLabel, ensureConceptName, hasConceptName, onCellNames } from '../lib/cellName'
import { teleport } from '../lib/teleport'
import type { Cell, Concept } from '../lib/types'
import { CardBody, LabelHead, asksQuestion } from './bodies'
import { conceptName, labelsShown, staleLabels, type ConceptDetailState } from './concepts'
import { CanvasContext } from './context'
import { editedLabels, labelDraft, setLabelDraft, useLabelDrafts } from './labelDrafts'
import { kindOf } from './layout'
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
  /** Check again in the hover of the problem's ✕ (none in the harness, whose card has no mark) */
  onCheckAgain?: () => void
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
  const problem = p.onCheckAgain ? checkProblem(check) : ''
  const swapped = useSwap(check?.fix?.id ?? null)
  const cls = ['canvas-card']
  if (check?.state === 'running') cls.push('is-checking')
  if ((cell.regenerating_for ?? []).length > 0) cls.push('is-regenerating')
  if (running) cls.push('is-running')
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
      data-check-problem={problem ? '' : undefined}
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
          <div className={'chat-text bcell-take-text' + (cell.takeaway_stale ? ' is-stale' : '')} title={cell.takeaway_stale ? 'Written before the card ran again' : undefined}>
            <ChatMarkdown text={cell.takeaway} />
          </div>
          {problem && <ProblemMark text={problem} onAgain={p.onCheckAgain} />}
        </div>
      ) : problem ? (
        <div className="bcell-take bcell-take-none">
          <div className="chat-text bcell-take-text" />
          <ProblemMark text={problem} onAgain={p.onCheckAgain} />
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

/** The tooltip of a label tag on a card, null for none: a label the card is running again for (`regenerating_for`), a
 * label with unrun edits in its sheet, or one that changed since the card ran. Pure. */
export function labelTagTip(id: string, regenerating: ReadonlySet<string>, edited: ReadonlyMap<string, string[]>, stale: ReadonlyMap<string, string>): string | null {
  if (regenerating.has(id)) return 'Stale label: card regenerating…'
  if (edited.has(id)) return `Edited, not run yet: ${edited.get(id)!.join('; ')}`
  if (stale.has(id)) return 'Stale label'
  return null
}

/** The labels the card uses (concepts.labelsShown), in a row under its question, each a tag in the label's colour. A
 * click opens the label's edit card in a popover. thimble runs a card again by itself once a label it read changes; a
 * label that changed and is not being run again for shows its tag in ink. */
export function CardLabels({ cell }: { cell: Cell }) {
  const ctx = useContext(CanvasContext)
  const ids = labelsShown(cell, ctx.concepts)
  const stale = staleLabels(cell, ctx.concepts)
  const regenerating = new Set(cell.regenerating_for ?? [])
  useLabelDrafts()
  const edited = editedLabels(ctx.ws, cell, ctx.concepts)
  // a label the board's list does not name yet takes its name from the workspace's labels
  const key = ids.join(' ')
  useSyncExternalStore(onCellNames, () => ids.map((id) => conceptLabel(id) ?? '').join('\n'))
  useEffect(() => {
    for (const id of key.split(' ').filter(Boolean)) if (!ctx.concepts.get(id)?.name && !hasConceptName(id)) void ensureConceptName(ctx.ws, id)
  }, [ctx.ws, ctx.concepts, key])
  if (!ids.length) return null
  return (
    <div className="bcell-labels">
      <span className="bcell-labels-key">Labels:</span>
      {ids.map((id) => (
        <LabelTag key={id} id={id} label={ctx.concepts.get(id) ?? null} ws={ctx.ws} why={labelTagTip(id, regenerating, edited, stale)} ink={stale.has(id) && !regenerating.has(id)} />
      ))}
    </div>
  )
}

/** One label's tag in the Labels row, and the popover its click opens (LabelSheet, edits kept in labelDrafts). A label
 * the board's list does not hold yet opens its card on the canvas instead. `why` is the tag's tooltip, and `ink` draws
 * the tag in ink rather than the label's colour. */
function LabelTag({ id, label: k, ws, why, ink }: { id: string; label: Concept | null; ws: string; why: string | null; ink: boolean }) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const { props: tipProps, tip } = useTooltip(why && !open ? why : null)
  const name = k?.name || conceptLabel(id) || 'a label'
  const colour = !ink && k && isFilesLabel(k) && !isMultiClass(classesOf(k)) ? mainColour(k) : null
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
        className={'bcell-tag' + (colour ? '' : ' is-plain')}
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
            />
          </div>
        </Popover>
      )}
    </>
  )
}

/** The card check's one mark, a red ✕ at the takeaway's bottom right for a real problem it found (checkProblem). Its
 * hover says what is wrong and offers Check again. */
function ProblemMark({ text, onAgain }: { text: string; onAgain?: () => void }) {
  return (
    <SharedCheckMark state="failed" problem label={text} popLabel="The card check's problem">
      {(close) => (
        <>
          <span className="bcell-check-what">{text}</span>
          {onAgain && (
            <span className="bcell-check-acts">
              <Button
                variant="ghost"
                size="sm"
                icon="refresh"
                onClick={() => {
                  close()
                  onAgain()
                }}
              >
                Check again
              </Button>
            </span>
          )}
        </>
      )}
    </SharedCheckMark>
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
