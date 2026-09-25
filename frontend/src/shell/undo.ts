// Undo and redo for the top bar (backend undo.py): what each would do, refreshed on every card or document change the
// stream announces, and the two actions. ⌘Z undoes and ⇧⌘Z (or ⌘Y) redoes, except in a field or the report's editor,
// which run their own undo.
import { useCallback, useEffect, useRef, useState } from 'react'
import { undoApi } from '../lib/api'
import { bus } from '../lib/bus'
import type { UndoLabels } from '../lib/types'

const REFETCH_MS = 250

/** Undo's tooltip: what it would revert, else why a running session holds it (a click then says so), else Undo. Pure. */
export function undoTip(labels: UndoLabels): string {
  if (labels.undo) return `Undo: ${labels.undo}`
  if (labels.held) return labels.held.charAt(0).toUpperCase() + labels.held.slice(1)
  return 'Undo'
}

/** Whether a key press belongs to what has the focus: a field, a text area, anything editable (the report's editor is
 * contenteditable). Pure over the element. */
export function typingIn(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes((el as HTMLInputElement).type)
  return (el as HTMLElement).isContentEditable === true || !!el.closest('[contenteditable=""], [contenteditable="true"]')
}

/** Which of the two a key press asks for: ⌘Z (Ctrl+Z) undo, ⇧⌘Z or ⌘Y redo, else null. Pure. */
export function undoKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): 'undo' | 'redo' | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  const k = e.key.toLowerCase()
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (k === 'y' && !e.shiftKey) return 'redo'
  return null
}

export function useUndo(ws: string): { labels: UndoLabels; undo: () => void; redo: () => void } {
  const [labels, setLabels] = useState<UndoLabels>({ undo: null, redo: null })
  const busy = useRef(false)
  const read = useCallback(() => {
    undoApi
      .labels(ws)
      .then(setLabels)
      .catch(() => undefined)
  }, [ws])

  useEffect(() => {
    read()
    let timer: number | null = null
    const later = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(read, REFETCH_MS)
    }
    const offCell = bus.on('cell', later)
    const offReport = bus.on('report', later)
    return () => {
      offCell()
      offReport()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [read])

  const act = useCallback(
    (which: 'undo' | 'redo') => {
      if (busy.current) return
      busy.current = true
      undoApi[which](ws)
        .then((r) => setLabels({ undo: r.undo, redo: r.redo, held: r.held ?? null }))
        .catch((e: Error) => {
          bus.emit('toast', { text: e.message, kind: 'error' })
          read()
        })
        .finally(() => {
          busy.current = false
        })
    },
    [ws, read],
  )
  const undo = useCallback(() => act('undo'), [act])
  const redo = useCallback(() => act('redo'), [act])

  const latest = useRef(labels)
  latest.current = labels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const which = undoKey(e)
      if (!which || e.defaultPrevented || typingIn(document.activeElement)) return
      e.preventDefault()
      if (latest.current[which]) act(which)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [act])

  return { labels, undo, redo }
}
