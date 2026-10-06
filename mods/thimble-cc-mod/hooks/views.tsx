// A view in the panel: a Client surface module (no `$`) that draws the lines the hooks module laid out (viewdraw.ts)
// and maps the pointer to their hit regions. The hits come packed (packHits: where each stands and what kind it is);
// their acts and records stay in the hooks module, so a click posts the hit's index and the stamp of the drawing it
// was in, and the hooks module acts on it: a tab, a facet, a sort, a row, a link followed, a label, a place opened. A
// right-click does what a click does. A row under the pointer shows "?" at its right, a side thread about the row, and
// has no other hover state; any other region under the pointer is a control, drawn in inverse. Keys reach it once a
// click has given it the focus, and go to the hooks module as they are.
import type { ClientModule } from 'claude-code'

import { lineWidth, width } from './draw'
import type { Line } from './draw'
import { send } from './gestures'
import { paintLine } from './paint'
import { HIT_ASK, HIT_ROW, VIEW_MARGIN as MARGIN } from './viewdraw'
import type { HitAct, ViewAct } from './viewdraw'

type Props = { lines: Line[]; hits: number[]; stamp: string; cols: number; view: string }
type S = { hover: number; ask: boolean }
type H = { y: number; x0: number; x1: number; f: number }


// every post carries the acts not yet seen, so one that replaces another in the same frame loses none
const vorigin = Math.random().toString(36).slice(2, 10)
let seq = 0
let outbox: { seq: number; act: ViewAct | HitAct }[] = []

function post(surface: unknown, view: string, act: ViewAct | HitAct): void {
  outbox = [...outbox, { seq: ++seq, act }].slice(-16)
  send(surface, { type: 'view', view, vorigin, acts: outbox as never })
}

function unpack(packed: readonly number[] | undefined): H[] {
  const out: H[] = []
  const p = Array.isArray(packed) ? packed : []
  for (let i = 0; i + 3 < p.length; i += 4) out.push({ y: p[i]!, x0: p[i + 1]!, x1: p[i + 2]!, f: p[i + 3]! })
  return out
}

function hitAt(hits: readonly H[], x: number, y: number): number {
  return hits.findIndex(h => h.y === y && x >= h.x0 && x < h.x1)
}

const Views: ClientModule<Props, S> = (props, surface) => {
  const { Box } = surface.elements
  const { Text } = surface.elements
  const cols = props.cols
  const inner = cols - MARGIN
  const st = surface.state ?? { hover: -1, ask: false }
  const hits = unpack(props.hits)
  const hover = st.hover >= 0 && st.hover < hits.length ? st.hover : -1
  const set = (next: S) => {
    if (next.hover !== st.hover || next.ask !== st.ask) surface.setState(next)
  }

  surface.onPointer(ev => {
    // over the margin of a row's line, that row; the header, the rules and the detail take the margin's cells too
    const direct = hitAt(hits, ev.x, ev.y)
    const rowHit = hits.findIndex(h => h.y === ev.y && h.f & HIT_ROW)
    const inMargin = ev.x >= inner && ev.x < cols && direct < 0 && rowHit >= 0
    const i = inMargin ? rowHit : direct
    const h = i >= 0 ? hits[i] : undefined
    if (ev.type === 'down' || ev.type === 'up') {
      // the press acts; a modified left click and the middle button are the terminal's
      if (ev.type !== 'down' || !h) return
      const button = ev.button ?? 'left'
      if ((button === 'left' || button === 'right') && !ev.shift && !ev.ctrl && !ev.alt) {
        post(surface, props.view, { op: 'hit', i, s: props.stamp, ...(inMargin && h.f & HIT_ASK ? { ask: true as const } : {}) })
      }
      return
    }
    if (ev.type === 'leave' || ev.x < 0 || ev.y < 0 || ev.x >= cols || ev.y >= props.lines.length) return set({ hover: -1, ask: false })
    if (ev.type === 'move') set({ hover: i, ask: inMargin && Boolean(h && h.f & HIT_ROW) })
  })
  surface.onKey(ev => {
    post(surface, props.view, { op: 'key', key: ev.key, ...(ev.ctrl ? { ctrl: true } : {}), ...(ev.shift ? { shift: true } : {}) })
  })
  if (surface.state === undefined) surface.setState(st)

  // the region under the pointer: a row unlit (its "?" shows), any other region in inverse
  let lines: Line[] = props.lines
  const h = hover >= 0 ? hits[hover] : undefined
  if (h) {
    if (!(h.f & HIT_ROW)) {
      lines = lines.map((l, y) => {
        if (y !== h.y) return l
        // the hooks module sends neighbouring segments of one style as one, so a segment may cross the region's edge
        const out: Line = []
        let x = 0
        for (const s of l) {
          const parts: [string, string, string] = ['', '', '']
          for (const ch of s.s) {
            parts[x < h.x0 ? 0 : x < h.x1 ? 1 : 2] += ch
            x += width(ch)
          }
          if (parts[0]) out.push({ ...s, s: parts[0] })
          if (parts[1]) out.push({ ...s, s: parts[1], inv: !s.inv })
          if (parts[2]) out.push({ ...s, s: parts[2] })
        }
        return out
      })
    }
  }
  const askRow = h && h.f & HIT_ROW && h.f & HIT_ASK ? h.y : -1
  const drawn = lines.map((l, y) => {
    const fill = Math.max(0, inner - lineWidth(l))
    // the row's "?" on R, after a 2-cell gutter
    const margin = y === askRow ? [{ s: ' '.repeat(fill + MARGIN - 1) }, { s: '?', fg: 'remember', ...(st.ask ? { inv: true } : {}) }] : []
    return paintLine(Text, [...l, ...margin])
  })
  return Box({ flexDirection: 'column', width: cols, children: drawn })
}

export default Views
