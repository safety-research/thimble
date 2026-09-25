// What every card on the board reads without prop drilling: the workspace, the filter, the concept names, the thread
// a card came from, and the hooks back into the board (measure, refresh, open a thread).
import { createContext } from 'react'
import type { Cell, Concept, Filters } from '../lib/types'
import type { CellThread } from './layout'

export interface CanvasCtx {
  ws: string
  filters: Filters | null
  /** the cells the canvas filter keeps; null when no filter is set */
  keep: Set<string> | null
  concepts: Map<string, Concept>
  /** the thread a card came from, for its foot */
  threadOf: (cell: Cell) => CellThread
  /** the cards a thread with an unread reply hangs on: they carry the dot */
  unread: ReadonlySet<string>
  /** re-read the board after an edit the stream may not announce */
  refresh: () => void
  /** open the chat a card came from */
  openThread: (cell: Cell) => void
}

export const CanvasContext = createContext<CanvasCtx>({
  ws: '',
  filters: null,
  keep: null,
  concepts: new Map(),
  threadOf: () => ({ chatId: null, name: '', writable: false }),
  unread: new Set(),
  refresh: () => undefined,
  openThread: () => undefined,
})
