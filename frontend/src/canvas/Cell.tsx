// One card on the board: the card's face (CardFace.tsx) with the board's chrome around it. At rest a card is its face,
// and its lock when locked. Hovered or selected, the chrome shows in a row above the question: `thread · time` at the
// left, the details, chat, delete, star and lock icons at the right. Any edge or corner resizes it. A locked card is one
// no model may change or delete. Selected alone, a click on its question or takeaway edits it in place (RefEditor); a
// double click opens focus mode. ⌘↵ in the question typed in place saves it and sends it to main as a request on the
// card (lib/agentKey), and the card says `sent to main` until main's turn ends. The board (Canvas.tsx) owns placement,
// selection, drag and resize. The card is its citations' home (`data-cite-home`).
import { memo, useContext, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Button } from '../components/Button'
import { askMain, whenMainIdle } from '../lib/agentKey'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { pointKeyHeld } from '../lib/platform'
import type { CardCheck } from '../lib/cardCheck'
import { track } from '../lib/telemetry'
import type { Cell } from '../lib/types'
import { CardFace, type CardField } from './CardFace'
import { useConceptDetail } from './concepts'
import { CanvasContext } from './context'
import { DOUBLE_MS, hhmm, kindOf } from './layout'

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })
/** the card's side padding, left and right: what a chart may take of its width */
export const CARD_PAD_X = 28

export type { CardField } from './CardFace'
export type CardAction = 'detail' | 'ask' | 'delete' | 'star' | 'lock'
/** The edge or corner of a card a resize holds, by compass point: the opposite edge stays where it is. */
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

export interface CellCardProps {
  cell: Cell
  x: number
  y: number
  w: number
  /** its own height; null for the content's */
  h: number | null
  selected: boolean
  /** selected alone: its question and takeaway edit in place */
  alone: boolean
  /** the first card of a collapsed frame: no grip */
  collapsed: boolean
  /** the edges of the frame's other cards stack under it */
  deck: boolean
  dragging: boolean
  /** its details are open in the panel */
  detailOpen: boolean
  editing: CardField | null
  z: number
  register: (id: string, el: HTMLElement | null) => void
  onPress: (e: MouseEvent<HTMLElement>, id: string) => void
  onFocusMode: (id: string) => void
  onResizeStart: (e: MouseEvent<HTMLElement>, id: string, edge: Edge) => void
  onAction: (action: CardAction, id: string, el: HTMLElement | null) => void
  onEdit: (id: string, field: CardField | null) => void
}

export const CellCard = memo(function CellCard(p: CellCardProps) {
  const { cell } = p
  const ctx = useContext(CanvasContext)
  const kind = kindOf(cell)
  const payload = (cell.payload ?? {}) as Record<string, unknown>
  const concept = kind === 'label' ? String(payload.concept ?? '') : ''
  const label = useConceptDetail(ctx.ws, concept || null)
  const thread = ctx.threadOf(cell)
  const time = hhmm(cell.created_ts ?? cell.ts)
  const dimmed = ctx.keep != null && !ctx.keep.has(cell.id)
  const unread = ctx.unread.has(cell.id)
  const [card, setCard] = useState<HTMLElement | null>(null)
  const [stopping, setStopping] = useState(false)
  // where the click that opened the takeaway's editor landed, for the caret
  const [editAt, setEditAt] = useState<{ x: number; y: number } | null>(null)

  // a click on the text of the card selected alone edits it; anywhere else the board takes the press. The click that
  // selects a card does not also edit it
  const armed = useRef<CardField | null>(null)
  const textDown = (field: CardField) => (e: MouseEvent<HTMLElement>) => {
    armed.current = null
    if (!p.alone || e.button !== 0 || pointKeyHeld(e) || (e.target as HTMLElement).closest('a, button, .chip, .refchip')) return
    armed.current = field
    e.stopPropagation()
  }
  // the edit waits DOUBLE_MS for a second click, which makes it a double click (focus mode) instead
  const editTimer = useRef<number | null>(null)
  const cancelEdit = () => {
    if (editTimer.current != null) window.clearTimeout(editTimer.current)
    editTimer.current = null
  }
  useEffect(() => cancelEdit, [])
  const textClick = (field: CardField) => (e: MouseEvent<HTMLElement>) => {
    const was = armed.current
    armed.current = null
    if (was !== field || !p.alone || pointKeyHeld(e) || (e.target as HTMLElement).closest('a, button, .chip, .refchip')) return
    if (e.detail > 1) return cancelEdit()
    const at = { x: e.clientX, y: e.clientY }
    cancelEdit()
    editTimer.current = window.setTimeout(() => {
      editTimer.current = null
      setEditAt(at)
      p.onEdit(cell.id, field)
    }, DOUBLE_MS)
  }
  const stop = async () => {
    if (!thread.chatId || stopping) return
    setStopping(true)
    track('ui-click', { target: `cell:${cell.id}`, detail: { action: 'stop', chat: thread.chatId } })
    try {
      await api.interrupt(ctx.ws, thread.chatId)
      ctx.refresh()
    } catch (e) {
      fail(e)
    } finally {
      setStopping(false)
    }
  }
  // ⌘↵ in the question typed in place: the question is saved, then sent to main as a request on this card, which shows
  // `sent to main` until main's turn ends
  const [asking, setAsking] = useState(false)
  const idle = useRef<(() => void) | null>(null)
  useEffect(() => () => idle.current?.(), [])
  const ask = async (field: CardField, value: string) => {
    const text = value.trim()
    await save(ctx, cell, field, text, () => p.onEdit(cell.id, null))
    setAsking(true)
    try {
      const request = await askMain(ctx.ws, text, { card: cell.id })
      track('ui-click', { target: `cell:${cell.id}`, detail: { action: 'ask', request } })
      idle.current?.()
      idle.current = whenMainIdle(ctx.ws, () => {
        idle.current = null
        setAsking(false)
      })
    } catch (e) {
      setAsking(false)
      fail(e)
    }
  }
  const act = (a: CardAction) => (e: MouseEvent) => {
    e.stopPropagation()
    p.onAction(a, cell.id, card)
  }

  const cls = ['bcell', `bcell-kind-${kind}`]
  if (p.selected) cls.push('is-selected')
  if (p.collapsed) cls.push('is-collapsed')
  if (p.dragging) cls.push('is-dragging')
  if (p.h != null) cls.push('is-sized')
  if (dimmed) cls.push('is-dimmed')
  if (cell.locked) cls.push('is-locked')
  return (
    <div
      className={cls.join(' ')}
      style={{ left: p.x, top: p.y, width: p.w, height: p.h ?? undefined, zIndex: p.z }}
      data-cellbox=""
      onMouseDown={(e) => p.onPress(e, cell.id)}
      onDoubleClick={(e) => {
        cancelEdit()
        if ((e.target as HTMLElement).closest('button, textarea, input, [contenteditable="true"], .chip, .refchip')) return
        e.stopPropagation()
        p.onFocusMode(cell.id)
      }}
      ref={(el) => p.register(cell.id, el)}
    >
      <CardFace
        cell={cell}
        width={p.w - CARD_PAD_X}
        label={label}
        cardRef={setCard}
        editing={p.editing}
        editAt={editAt}
        onEdited={(field, v) => save(ctx, cell, field, v, () => p.onEdit(cell.id, null))}
        onAsk={(field, v) => void ask(field, v)}
        asking={asking}
        onTextDown={textDown}
        onTextClick={textClick}
        onUndoFix={(check) => void undoFix(ctx, cell, check)}
        onCheckAgain={() => void checkAgain(ctx, cell)}
        onStopCheck={() => void stopCheck(ctx, cell)}
        stop={
          thread.chatId && thread.writable ? (
            <Button variant="ghost" size="sm" busy={stopping} onMouseDown={(e) => e.stopPropagation()} onClick={() => void stop()}>
              stop
            </Button>
          ) : null
        }
        chrome={
          <div className="bcell-top">
            {(thread.name || time || unread) && (
              <button
                type="button"
                className="bcell-meta"
                disabled={!thread.chatId}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  ctx.openThread(cell)
                }}
              >
                {[thread.name, time].filter(Boolean).join(' · ')}
                {/* the dot at rest says this in words once the card is hovered, where the dot gives way to the chrome */}
                {unread && <span className="bcell-meta-new">{thread.name || time ? ' · ' : ''}new reply</span>}
              </button>
            )}
            <span className="bcell-acts" onMouseDown={(e) => e.stopPropagation()}>
              <Button variant="icon" size="sm" icon="code" title="Details" aria-label="Details" active={p.detailOpen} onClick={act('detail')} />
              <Button variant="icon" size="sm" icon="chat" title="Chat about this card" aria-label="Chat about this card" onClick={act('ask')} />
              <Button variant="icon" size="sm" icon="trash" title="Delete" aria-label="Delete" className="bcell-delete" onClick={act('delete')} />
              <Button variant="icon" size="sm" icon="star" title={cell.starred ? 'Starred' : 'Star'} aria-label={cell.starred ? 'Starred' : 'Star'} active={!!cell.starred} className="bcell-star" onClick={act('star')} />
              <Button variant="icon" size="sm" icon={cell.locked ? 'lock' : 'unlock'} title={cell.locked ? 'Locked' : 'Lock'} aria-label={cell.locked ? 'Locked' : 'Lock'} active={!!cell.locked} className="bcell-lock" onClick={act('lock')} />
            </span>
          </div>
        }
        after={
          <>
            {!p.collapsed && (
              <span className="bcell-grip" role="separator" aria-label="Size" onMouseDown={(e) => p.onResizeStart(e, cell.id, 'se')}>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M12 6L6 12M12 10l-2 2" />
                </svg>
              </span>
            )}
            {unread && <span className="dot bcell-dot" role="status" aria-label="A reply landed on a thread about this card" />}
          </>
        }
      />
      {!p.collapsed && EDGES.map((edge) => <span key={edge} className={`bcell-edge bcell-edge-${edge}`} aria-hidden="true" onMouseDown={(e) => p.onResizeStart(e, cell.id, edge)} />)}
      {p.deck && (
        <div className="bcell-deck" aria-hidden="true">
          <span />
          <span />
        </div>
      )}
    </div>
  )
})

/** Save a question or a takeaway typed in place; nothing is sent when it did not change. */
async function save(ctx: { ws: string; refresh: () => void }, cell: Cell, field: CardField, value: string, done: () => void) {
  done()
  const next = value.trim()
  if (next === (field === 'title' ? cell.title : cell.takeaway ?? '').trim()) return
  if (field === 'title' && !next) return
  track(field === 'title' ? 'cell-edit' : 'takeaway-edit', { target: `cell:${cell.id}`, detail: { field, via: 'inline' } })
  try {
    await api.updateCell(ctx.ws, cell.id, field === 'title' ? { title: next } : { takeaway: next })
    ctx.refresh()
  } catch (e) {
    fail(e)
  }
}

/** Undo in the check mark's hover: restore the card as it was before the check changed it. */
async function undoFix(ctx: { ws: string; refresh: () => void }, cell: Cell, check: CardCheck) {
  if (!check.fix) return
  track('ui-click', { target: `cell:${cell.id}`, detail: { action: 'undo-fix', fix: check.fix.id } })
  try {
    await api.undoCardFix(ctx.ws, cell.id, check.fix.id)
    ctx.refresh()
  } catch (e) {
    fail(e)
  }
}

/** A click on the check mark: run the check again on the card as it stands. */
async function checkAgain(ctx: { ws: string; refresh: () => void }, cell: Cell) {
  track('ui-click', { target: `cell:${cell.id}`, detail: { action: 'check-again' } })
  try {
    await api.checkCardAgain(ctx.ws, cell.id)
    ctx.refresh()
  } catch (e) {
    fail(e)
  }
}

/** Stop a running check; the card stays as it is. */
async function stopCheck(ctx: { ws: string; refresh: () => void }, cell: Cell) {
  track('ui-click', { target: `cell:${cell.id}`, detail: { action: 'stop-check' } })
  try {
    await api.stopCardCheck(ctx.ws, cell.id)
    ctx.refresh()
  } catch (e) {
    fail(e)
  }
}
