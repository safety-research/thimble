// A view's own label controls (backend/app/viewer_bridge.js labelCall): the calls that change what thimble shows or
// stores take effect only during the analyst's own click or key press inside the frame. The frame's bridge sends one
// only while the frame has transient user activation, with the key only it holds, and the page checks again here that
// its document has the activation and the frame has the focus, so a page cannot turn labels on or off, filter by them
// or mark records on load, on a timer or from its script alone. The editor a page opens (`edit`) stands in a popover
// over the page beside the control that asked (files/LabelEditor), which the page gives as a rect in its frame.
import type { PopoverAnchor } from '../components/Menu'
import { api, labelApi } from '../lib/api'
import { recordKey, recordOf } from '../lib/refs'
import type { Concept } from '../lib/types'
import { classesOf, isFilesLabel, PALETTE } from './labels'

export const NO_GESTURE = 'thimble changes labels only while the analyst clicks or types in the view'

/** What a view's label controls do, as the Labels pane does it. */
export interface ViewLabelActions {
  /** turn a label over files on or off */
  setOn: (id: string, on: boolean) => void
  /** give a label's value a palette colour (labels.ts PALETTE) */
  setColour: (id: string, value: string, colour: number) => void
  /** open the label editor on a label, or on a new one with null, beside the control that asked */
  edit?: (id: string | null, at?: LabelEditAt) => void
}

/** A rect of a view's page, in its frame's coordinates. */
export interface FrameRect {
  left: number
  top: number
  width: number
  height: number
}

/** Where a view's page asked for the label editor: beside `anchor`, the control that asked, or a point inside the
 * view's top-left corner when the page gave no rect (then `below` it); the focus goes back to the frame when the editor
 * closes from inside, and `onClose` tells the page (labelEditorClosed), with whether it did. */
export interface LabelEditAt {
  anchor: PopoverAnchor
  side: 'aside' | 'below' | 'left'
  back: HTMLIFrameElement
  onClose: (focused: boolean) => void
}

/** A rect the page sent, or null when it is not one. Pure. */
export function frameRect(v: unknown): FrameRect | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const n = [r.left, r.top, r.width, r.height]
  if (!n.every((x) => typeof x === 'number' && Number.isFinite(x)) || (r.width as number) < 0 || (r.height as number) < 0) return null
  return { left: r.left as number, top: r.top as number, width: r.width as number, height: r.height as number }
}

/** How far inside the view's top-left corner the editor stands when the page gave no rect. */
const CORNER = 8

/** A rect of the page in `frame` as a box in this page's coordinates, read again wherever the frame has moved; with no
 * rect, a point inside the frame's top-left corner. */
export function frameAnchor(frame: HTMLIFrameElement, rect: FrameRect | null): PopoverAnchor {
  return {
    get isConnected() {
      return frame.isConnected
    },
    getBoundingClientRect: () => {
      const f = frame.getBoundingClientRect()
      return rect ? new DOMRect(f.left + rect.left, f.top + rect.top, rect.width, rect.height) : new DOMRect(f.left + CORNER, f.top + CORNER / 2, 0, 0)
    },
  }
}

export type LabelOp = 'on' | 'colour' | 'edit' | 'mark' | 'filter'

/** Whether the analyst is acting in `frame` now: the page holds transient user activation, which a click or key press
 * in a frame gives the page too, and the frame has the focus, so the activation is not from a click elsewhere. */
export function inGesture(frame: HTMLIFrameElement | null): boolean {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  return !!frame && !!ua?.isActive && document.activeElement === frame
}

export interface LabelCallContext {
  ws: string
  byId: ReadonlyMap<string, Concept>
  /** the palette as the page heard it (labels.ts pagePalette) */
  palette: readonly string[]
  actions?: ViewLabelActions
  /** the page's frame, which the editor stands over */
  frame?: HTMLIFrameElement
  /** the editor this call opened closed, `focused` when the focus went back to the frame */
  onEditorClosed?: (focused: boolean) => void
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The label a call names, by id or else by name. */
function labelOf(byId: ReadonlyMap<string, Concept>, named: string): Concept {
  const k = byId.get(named) ?? [...byId.values()].find((x) => x.name === named)
  if (!k) throw new Error(`no label has the id or name ${JSON.stringify(named)}`)
  return k
}

function filesLabel(byId: ReadonlyMap<string, Concept>, named: string): Concept {
  const k = labelOf(byId, named)
  if (!isFilesLabel(k)) throw new Error(`${k.name} labels cards or sentences, not records`)
  return k
}

function valueOf(k: Concept, value: string): string {
  if (!classesOf(k).some((c) => c.name === value)) throw new Error(`${k.name} has no value ${JSON.stringify(value)}`)
  return value
}

/** Do one label call of a view's page; throws with the reason when it cannot. */
export async function runLabelCall(op: string, args: unknown, ctx: LabelCallContext): Promise<void> {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const { ws, byId, palette, actions } = ctx
  switch (op as LabelOp) {
    case 'on': {
      if (!actions) throw new Error('labels cannot be turned on or off here')
      actions.setOn(filesLabel(byId, str(a.id)).id, !!a.on)
      return
    }
    case 'colour': {
      if (!actions) throw new Error('label colors cannot be changed here')
      const k = filesLabel(byId, str(a.id))
      const at = palette.findIndex((c) => c.toLowerCase() === str(a.colour).toLowerCase())
      if (at < 0) throw new Error(`${JSON.stringify(str(a.colour))} is not one of the palette's colors`)
      actions.setColour(k.id, valueOf(k, str(a.value)), PALETTE[at])
      return
    }
    case 'edit': {
      if (!actions?.edit) throw new Error('there is no label editor here')
      const id = a.id == null ? null : labelOf(byId, str(a.id)).id
      const { frame, onEditorClosed } = ctx
      const rect = frameRect(a.anchor)
      actions.edit(id, frame ? { anchor: frameAnchor(frame, rect), side: rect && a.side !== 'below' ? (a.side === 'left' ? 'left' : 'aside') : 'below', back: frame, onClose: (focused) => onEditorClosed?.(focused) } : undefined)
      return
    }
    case 'mark': {
      const ref = str(a.ref)
      const at = recordOf(ref)
      const k = filesLabel(byId, str(a.label))
      const value = valueOf(k, str(a.value))
      // a label of whole files takes its value on the file a record is in
      if (k.unit === 'agent') {
        const path = at?.path ?? (ref && !ref.includes('#') ? ref : '')
        if (!path) throw new Error(`mark takes a file's path or a record's ref for ${k.name}, not ${JSON.stringify(ref)}`)
        await labelApi.verdict(ws, k.id, path, value)
        return
      }
      if (k.unit !== 'record') throw new Error(`${k.name} labels whole runs, not records`)
      if (!at) throw new Error(`mark takes a record's ref, such as data.jsonl#L12, not ${JSON.stringify(ref)}`)
      await labelApi.verdict(ws, k.id, recordKey(ref), value)
      return
    }
    case 'filter': {
      if (a.label == null) {
        await api.deleteFilter(ws, 'files')
        return
      }
      const k = filesLabel(byId, str(a.label))
      await api.putFilter(ws, 'files', k.id, valueOf(k, str(a.value)))
      return
    }
    default:
      throw new Error(`there is no label call ${JSON.stringify(op)}`)
  }
}

/** A random key for a page's label calls. */
export function callKey(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
