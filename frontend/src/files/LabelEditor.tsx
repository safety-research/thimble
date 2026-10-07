// The label editor: a label's edit card (LabelCard), or a new label's with Label from prompt above it (LabelPrompt).
// Files' Labels sidebar shows it at the pane's edge (ViewSide useLabelSide); a view, or a control in Files, opens it in
// a popover beside the control that asked (openLabelEditor), so the view stays where it is and no sidebar opens. The
// popover is drawn by LabelEditorHost, once in the shell, over every pane and every view's frame: a view's page cannot
// clip it. It takes the focus when it opens; Escape, ×, Cancel and Re-run close it and give the focus back to `back`
// (the view's frame, or the control), a click outside closes it where the click lands, and `onClose` hears every close.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Popover, type Align, type PopoverAnchor } from '../components/Menu'
import type { ConceptRun, LabelDraft } from '../lib/types'
import { LabelCard, labelCardName } from './LabelCard'
import { LabelPrompt } from './LabelPrompt'
import { useFilesLabels, type FilesLabels } from './useLabels'

/** The editor's width in the popover, the card's own width at the Labels pane's edge (files.css .label-card). */
export const EDITOR_WIDTH = 340

export interface LabelEditorProps {
  ws: string
  labels: FilesLabels
  /** the label whose card shows, or 'new' */
  editing: string | 'new'
  /** a new label's definition when Label from prompt drafted it */
  drafted: LabelDraft | null
  /** what a new label applies to */
  appliesTo: string[]
  /** another label's card, a new label's ('new'), or none (null), which closes the editor */
  onEdit: (id: string | 'new' | null) => void
  /** Label from prompt could not make the label: its card is filled with this draft */
  onDraft: (draft: LabelDraft) => void
  /** an apply started for a label, with the run record the server answered */
  onRun: (id: string, run: ConceptRun) => void
  inPopover?: boolean
}

/** A label's edit card, or a new label's with Label from prompt as its lead: the one editor Files' sidebar and the
 * popover both show. */
export function LabelEditor({ ws, labels, editing, drafted, appliesTo, onEdit, onDraft, onRun, inPopover }: LabelEditorProps) {
  const label = editing === 'new' ? null : labels.byId.get(editing) ?? null
  return (
    <LabelCard
      ws={ws}
      label={label}
      labels={labels}
      appliesTo={appliesTo}
      draft={drafted}
      inPopover={inPopover}
      onClose={() => onEdit(null)}
      onRun={onRun}
      lead={editing === 'new' ? <LabelPrompt ws={ws} labels={labels} appliesTo={appliesTo} onRun={onRun} onManual={onDraft} onEdit={onEdit} onDone={() => onEdit(null)} /> : undefined}
    />
  )
}

/** What opens the editor in its popover. */
export interface LabelEditorRequest {
  /** the label, or null for a new one */
  id: string | null
  /** what the popover sits beside: the control that asked (an element), or a box such as a control inside a view's frame
   * (labelCalls frameAnchor) */
  anchor: PopoverAnchor
  /** `aside` (the default): to the anchor's right, else its left, level with its middle; `below`: under it, else above */
  side?: 'aside' | 'below'
  /** with `below`, the anchor's edge the popover lines up with */
  align?: Align
  /** what a new label applies to */
  appliesTo?: readonly string[]
  /** where the focus goes when the editor closes from inside it: the view's frame, or the control that opened it */
  back?: HTMLElement | null
  /** the editor closed, by any way, or another request took its place; `focused` when the focus went back to `back` */
  onClose?: (focused: boolean) => void
}

type Shown = LabelEditorRequest & { turn: number }

let shown: Shown | null = null
let turns = 0
const listeners = new Set<() => void>()
const notify = () => {
  for (const fn of listeners) fn()
}

/** Open the label editor in its popover beside `req.anchor`; one already open closes first. */
export function openLabelEditor(req: LabelEditorRequest): void {
  const was = shown
  shown = { ...req, turn: ++turns }
  notify()
  was?.onClose?.(false)
}

/** Close the editor's popover, or with `turn` only the request of that turn; `focused` when the focus went back. */
export function closeLabelEditor(turn?: number, focused = false): void {
  const was = shown
  if (!was || (turn != null && was.turn !== turn)) return
  shown = null
  notify()
  was.onClose?.(focused)
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** The editor's popover, drawn once in the shell. */
export function LabelEditorHost({ ws }: { ws: string }) {
  const req = useSyncExternalStore(subscribe, () => shown)
  return req ? <LabelEditorPop key={req.turn} ws={ws} req={req} /> : null
}

const NO_RUN = () => undefined

function LabelEditorPop({ ws, req }: { ws: string; req: Shown }) {
  // the editor's own read of the labels, as a label's popover on a card has (LabelSheet): read only while it is open
  const labels = useFilesLabels(ws)
  const [editing, setEditing] = useState<string | 'new'>(req.id ?? 'new')
  const [drafted, setDrafted] = useState<LabelDraft | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const appliesTo = useMemo(() => [...(req.appliesTo ?? [])], [req.appliesTo])
  const label = editing === 'new' ? null : labels.byId.get(editing)
  const known = editing === 'new' || !!label
  // the focus goes back when the editor closes from inside it; a click outside leaves it where the click put it
  const close = useCallback(
    (how?: 'escape' | 'outside') => {
      const back = how !== 'outside' && !!req.back?.isConnected
      if (back) req.back!.focus({ preventScroll: true })
      closeLabelEditor(req.turn, back)
    },
    [req],
  )
  // a label deleted while its editor is open, or one the labels never held, closes it once the labels are read
  useEffect(() => {
    if (!known && labels.all.length) closeLabelEditor(req.turn)
  }, [known, labels.all.length, req.turn])
  // the focus moves into the popover once it is placed (a hidden sheet takes none): a new label's Label from prompt
  // takes it itself, a label's card holds it on its body
  useEffect(() => {
    if (!known) return
    const raf = requestAnimationFrame(() => {
      const b = body.current
      if (b && !b.contains(document.activeElement)) b.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [known])
  if (!known) return null
  return (
    <Popover anchor={req.anchor} open onClose={close} side={req.side ?? 'aside'} align={req.align} width={EDITOR_WIDTH} label={labelCardName(label ?? null)} className="label-editor-pop">
      <div ref={body} tabIndex={-1} className="label-editor-body">
        <LabelEditor
          ws={ws}
          labels={labels}
          editing={editing}
          drafted={drafted}
          appliesTo={appliesTo}
          inPopover
          onEdit={(id) => {
            if (id == null) close()
            else {
              setEditing(id)
              setDrafted(null)
            }
          }}
          onDraft={(d) => {
            setEditing('new')
            setDrafted(d)
          }}
          onRun={NO_RUN}
        />
      </div>
    </Popover>
  )
}
