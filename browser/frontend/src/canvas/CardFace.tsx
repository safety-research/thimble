// A card as the analyst sees it at rest: its question, the Labels row (a label card's label row), its body by kind
// (bodies.tsx) and its takeaway, in the card's own box. The board's CellCard (Cell.tsx) adds hover chrome around it,
// and the card harness (render.tsx) mounts it alone. The body shimmers while the card's code runs, as when an edit_card
// call is changing it, and the card shimmers while thimble runs it again because a label it read changed.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChatMarkdown } from '../chat/markdown'
import { Button } from '../components/Button'
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
import { conceptLabel, ensureConceptName, hasConceptName, onCellNames } from '../lib/cellName'
import { teleport } from '../lib/teleport'
import type { Cell, Concept } from '../lib/types'
import { CardBody, LabelHead, LabelKindTag, LabelMeta, asksQuestion } from './bodies'
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
  // a plan has no takeaway (bodies.tsx PlanBody): its steps say where the work stands
  const takeaway = kind === 'plan' ? '' : cell.takeaway
  const cls = ['canvas-card']
  if ((cell.regenerating_for ?? []).length > 0) cls.push('is-regenerating')
  if (running) cls.push('is-running')
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
    >
      {p.chrome}
      <div className="bcell-head">
        {kind === 'label' && concept && !(ctx.concepts.has(concept) && asksQuestion(cell.title, conceptName(ctx.concepts, concept))) ? (
          <LabelHead conceptId={concept} detail={p.label.concept} />
        ) : p.editing === 'title' ? (
          <InlineField className="bcell-q" value={cell.title} onDone={(v) => p.onEdited?.('title', v)} onAsk={p.onAsk ? (v) => p.onAsk?.('title', v) : undefined} />
        ) : (
          <span className="bcell-q" data-anchor={`card:${cell.id}`} data-anchor-text={cell.title} onMouseDown={p.onTextDown?.('title')} onClick={p.onTextClick?.('title')}>
            <span className="bcell-q-text">{cell.title}</span>
          </span>
        )}
      </div>
      <CardLabels cell={cell} detail={p.label.concept} />
      <div className="bcell-body">
        <CardBody cell={cell} width={p.width} label={p.label} />
      </div>
      {running && (
        <div className="bcell-run" role="status">
          <Spinner size={10} label="running" />
          <span>running</span>
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
      ) : takeaway ? (
        <div className="bcell-take" data-anchor={`card:${cell.id}`} data-anchor-text={takeaway} onMouseDown={p.onTextDown?.('takeaway')} onClick={p.onTextClick?.('takeaway')}>
          <div className={'chat-text bcell-take-text' + (cell.takeaway_stale ? ' is-stale' : '')} title={cell.takeaway_stale ? 'Written before the card ran again' : undefined}>
            <ChatMarkdown text={takeaway} />
          </div>
        </div>
      ) : null}
      {p.after}
    </article>
  )
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
 * label that changed and is not being run again for shows its tag in ink. A label card whose head holds a question of
 * its own names its label on a row of its own instead: the Label tag, the label's tag, then how the label is defined
 * and what it ran on (bodies LabelMeta, from `detail`, the card's own copy of the label, else the board's list's). */
export function CardLabels({ cell, detail }: { cell: Cell; detail?: Concept | null }) {
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
  const tag = (id: string) => <LabelTag key={id} id={id} label={ctx.concepts.get(id) ?? null} ws={ctx.ws} why={labelTagTip(id, regenerating, edited, stale)} ink={stale.has(id) && !regenerating.has(id)} />
  const own = cell.kind === 'label' ? String(((cell.payload ?? {}) as Record<string, unknown>).concept ?? '') : ''
  const named = !!own && ids.includes(own)
  const self = named ? (detail?.id === own ? detail : null) ?? ctx.concepts.get(own) ?? null : null
  const rest = named ? ids.filter((id) => id !== own) : ids
  return (
    <>
      {named && (
        <div className="bcell-labels bcell-label-row">
          <span className="bcell-label-who">
            <LabelKindTag />
            {tag(own)}
          </span>
          {self && <LabelMeta label={self} />}
        </div>
      )}
      {rest.length > 0 && (
        <div className="bcell-labels">
          <span className="bcell-labels-key">Labels:</span>
          {rest.map(tag)}
        </div>
      )}
    </>
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
