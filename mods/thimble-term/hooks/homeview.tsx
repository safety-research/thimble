// A panel drawn from styled lines (the home panel, home.ts; the threads tree and the lists of register.tsx and
// harness.tsx): a Client surface module (no `$`) that draws the lines the hooks module laid out and maps the pointer
// to their hit regions. Rows have no hover state; any other region under the pointer (a heading, a link, "… N more") is
// a control, drawn in inverse. A click (left or right: a right-click does what a click does) posts the hit's index and
// the stamp of the drawing it was in; a key, once a click has given the Client the keyboard, posts the key; the hooks
// module acts on both.
import type { ClientModule } from 'claude-code'

import { lineWidth, width } from './draw'
import type { Line } from './draw'
import { send } from './gestures'
import { paintLine } from './paint'

type Props = { lines: Line[]; hits: number[]; stamp: string; cols: number; keys?: boolean }
type S = { hover: number }
type H = { y: number; x0: number; x1: number; row: boolean; g: number }
type Out = { seq: number; s: string; i?: number; k?: string }
// the key a click on no hit posts (lines.tsx CLIENT_CLICK)
const CLICK = '\u0000click'

// every post carries the clicks and keys not yet seen, under this instance's name, so a reload's count starts afresh
const horigin = Math.random().toString(36).slice(2, 10)
let seq = 0
let outbox: Out[] = []

function unpack(packed: readonly number[] | undefined): H[] {
  const out: H[] = []
  const p = Array.isArray(packed) ? packed : []
  for (let i = 0; i + 4 < p.length; i += 5) out.push({ y: p[i]!, x0: p[i + 1]!, x1: p[i + 2]!, row: p[i + 3] === 1, g: p[i + 4]! })
  return out
}

function inverse(l: Line, x0: number, x1: number): Line {
  const out: Line = []
  let x = 0
  for (const s of l) {
    const parts: [string, string, string] = ['', '', '']
    for (const ch of s.s) {
      parts[x < x0 ? 0 : x < x1 ? 1 : 2] += ch
      x += width(ch)
    }
    if (parts[0]) out.push({ ...s, s: parts[0] })
    if (parts[1]) out.push({ ...s, s: parts[1], inv: true })
    if (parts[2]) out.push({ ...s, s: parts[2] })
  }
  return out
}

function post(surface: unknown, o: Omit<Out, 'seq'>): void {
  outbox = [...outbox, { seq: ++seq, ...o }].slice(-8)
  send(surface, { type: 'home', horigin, hacts: outbox as never })
}

const HomeView: ClientModule<Props, S> = (props, surface) => {
  const { Box, Text } = surface.elements
  const st = surface.state ?? { hover: -1 }
  const hits = unpack(props.hits)
  const at = (x: number, y: number) => hits.findIndex(h => h.y === y && x >= h.x0 && x < h.x1)
  surface.onPointer(ev => {
    if (ev.type === 'down') {
      const i = at(ev.x, ev.y)
      const button = ev.button ?? 'left'
      // a click on no hit of a list with keys gave this Client the keyboard, which the hooks module hands back to the pane,
      // whose own keys reach the list (panel.tsx RELAY)
      if (i < 0 && props.keys && button === 'left' && !ev.shift && !ev.ctrl && !ev.alt) return post(surface, { k: CLICK, s: props.stamp })
      if (i < 0 || button === 'middle' || ev.shift || ev.ctrl || ev.alt) return
      post(surface, { i, s: props.stamp })
      return
    }
    if (ev.type === 'up') return
    const i = ev.type === 'leave' ? -1 : at(ev.x, ev.y)
    if (i !== st.hover) surface.setState({ hover: i })
  })
  if (props.keys) surface.onKey(ev => post(surface, { k: ev.key, s: props.stamp }))
  if (surface.state === undefined) surface.setState(st)
  let lines = props.lines
  const h = st.hover >= 0 ? hits[st.hover] : undefined
  if (h && !h.row) lines = lines.map((l, y) => (y === h.y ? inverse(l, h.x0, h.x1) : l))
  return Box({ flexDirection: 'column', width: props.cols, children: lines.map(l => paintLine(Text, lineWidth(l) ? l : [{ s: ' ' }])) })
}

export default HomeView
