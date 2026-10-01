// A view's own label controls (backend/app/viewer_bridge.js labelCall): the calls that change what thimble shows or
// stores take effect only during the analyst's own click or key press inside the frame. The frame's bridge sends one
// only while the frame has transient user activation, with the key only it holds, and the page checks again here that
// its document has the activation and the frame has the focus, so a page cannot turn labels on or off, filter by them
// or mark records on load, on a timer or from its script alone.
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
  /** open the label editor on a label, or on a new one with null */
  edit?: (id: string | null) => void
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
      if (!actions) throw new Error('label colours cannot be changed here')
      const k = filesLabel(byId, str(a.id))
      const at = palette.findIndex((c) => c.toLowerCase() === str(a.colour).toLowerCase())
      if (at < 0) throw new Error(`${JSON.stringify(str(a.colour))} is not one of the palette's colours`)
      actions.setColour(k.id, valueOf(k, str(a.value)), PALETTE[at])
      return
    }
    case 'edit': {
      if (!actions?.edit) throw new Error('there is no label editor here')
      actions.edit(a.id == null ? null : labelOf(byId, str(a.id)).id)
      return
    }
    case 'mark': {
      const ref = str(a.ref)
      if (!recordOf(ref)) throw new Error(`mark takes a record's ref, such as data.jsonl#L12, not ${JSON.stringify(ref)}`)
      const k = filesLabel(byId, str(a.label))
      await labelApi.verdict(ws, k.id, recordKey(ref), valueOf(k, str(a.value)))
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
