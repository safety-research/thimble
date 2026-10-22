// A card Claude drew (backend features/cards.py), in the chat under the call that drew its first version, or under the
// answer v was pressed on, where each new version replaces it: its title, the card runner's tree (tree.tsx) at the
// chat's width in cells, and a line that names its keys. A click on a Button presses it; a click elsewhere goes to the
// view's onPointer, as the cell it fell in; a key goes to the card while it has the focus, or from an empty message box
// (keys.ts). Each answer draws the card anew. A new version (the stream's `card` record) draws as soon as it is made.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cardsApi, type CardDrawing } from '../lib/api'
import { bus } from '../lib/bus'
import { focusCard, OWN_KEYS, showCard } from './keys'
import { Tree, type TreeNode } from './tree'

/** The width of one cell of the card's font, measured once per font size. */
function cellSize(el: HTMLElement): { w: number; h: number } {
  const probe = document.createElement('span')
  probe.className = 'drawn-probe'
  probe.textContent = '0'.repeat(20)
  el.appendChild(probe)
  const r = probe.getBoundingClientRect()
  probe.remove()
  return { w: r.width / 20 || 7.2, h: r.height || 17 }
}

/** The cells a card's body has across: its width less its padding, in cells; at least 20. */
export function columnsOf(width: number, cell: number): number {
  return Math.max(20, Math.floor(width / cell))
}

/** The columns a card has in the chat whose flow is `flow`: a frame laid out there and taken away. */
function chatColumns(flow: HTMLElement): number {
  const frame = document.createElement('div')
  frame.className = 'drawn-frame'
  frame.style.visibility = 'hidden'
  frame.style.position = 'absolute'
  frame.style.width = `${flow.clientWidth}px`
  const body = document.createElement('div')
  body.className = 'drawn-body'
  frame.appendChild(body)
  flow.appendChild(frame)
  const cols = columnsOf(body.clientWidth, cellSize(body).w)
  frame.remove()
  return cols
}

/** The chat's width in card cells, told to the server whenever it changes (a moment after the last change), so the
 * text copy Claude reads of its next card is as wide as the card the analyst sees. */
export function useChatColumns(ws: string, flow: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = flow.current
    if (!el || typeof ResizeObserver !== 'function') return
    let told = 0
    let t: number | undefined
    const tell = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        const cols = chatColumns(el)
        if (cols !== told) void cardsApi.width(ws, cols).then(() => (told = cols), () => undefined)
      }, 400)
    }
    const ro = new ResizeObserver(tell)
    ro.observe(el)
    return () => (ro.disconnect(), window.clearTimeout(t))
  }, [ws, flow])
}

export function Card({ ws, id, version }: { ws: string; id: string; version?: number }) {
  const frame = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(0)
  const [drawing, setDrawing] = useState<CardDrawing | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const cell = useRef({ w: 7.2, h: 17 })

  // the width in cells, from the body's width, again whenever the chat's width changes
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    cell.current = cellSize(el)
    const measure = () => setCols(columnsOf(el.clientWidth, cell.current.w))
    measure()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  const load = useCallback(() => {
    if (!cols) return
    cardsApi.get(ws, id, cols).then(
      (d) => (setDrawing(d), setFailed(null)),
      (e: Error) => setFailed(e.message),
    )
  }, [ws, id, cols])
  useEffect(() => {
    const t = window.setTimeout(load, drawing ? 120 : 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, version])
  // a new version made, or a key the message box gave it
  useEffect(() => {
    const offs = [
      bus.on('wsEvent', (ev) => {
        const r = ev as { type?: string; card?: string }
        if (r.type === 'card' && r.card === id) load()
      }),
      bus.on('cardDrawn', (e) => e.id === id && setDrawing(e.drawing)),
    ]
    return () => offs.forEach((off) => off())
  }, [id, load])
  // the keys it takes from an empty message box, while it is on screen
  const keys = (drawing?.keys ?? []).filter((k) => !OWN_KEYS.includes(k))
  useEffect(() => (frame.current ? showCard(ws, id, keys, frame.current) : undefined), [ws, id, keys.join('')])

  const send = (op: 'key' | 'press' | 'pointer', b: Record<string, unknown>) =>
    cardsApi.event(ws, id, op, b).then(setDrawing, (e: Error) => bus.emit('toast', { text: `The card did not answer: ${e.message}`, kind: 'error' }))

  const tree = drawing?.tree as TreeNode | undefined
  const error = drawing?.error ?? failed
  return (
    <div
      ref={frame}
      className="drawn-frame"
      tabIndex={0}
      data-card={id}
      onPointerDown={() => focusCard(id)}
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey || !keys.includes(e.key)) return
        e.preventDefault()
        void send('key', { key: e.key })
      }}
    >
      <div className="drawn-title">{drawing?.title ?? ' '}</div>
      <div
        ref={body}
        className="drawn-body"
        onClick={(e) => {
          if (!tree || (e.target as HTMLElement).closest('.drawn-button')) return
          const r = body.current!.getBoundingClientRect()
          const at = { x: Math.floor((e.clientX - r.left) / cell.current.w), y: Math.floor((e.clientY - r.top) / cell.current.h) }
          void send('pointer', { down: at, up: at })
        }}
      >
        {tree ? (
          <span className="drawn-root" style={{ width: `${cols}ch` }}>
            <Tree node={tree} onPress={(n) => void send('press', { button: n })} />
          </span>
        ) : error ? null : (
          <span className="drawn-wait">drawing…</span>
        )}
      </div>
      {error && <div className="drawn-error">The card cannot draw: {error}</div>}
      {keys.length > 0 && <div className="drawn-keys">keys {keys.join(' ')}</div>}
    </div>
  )
}
