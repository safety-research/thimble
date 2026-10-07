// A terminal view's frame (hooks/viewhost.ts), drawn by a Client surface module (no `$`): the rows its program drew
// and its hot regions. A region under the pointer that is not a whole row is drawn in inverse, and its tip (what it
// does, a value's meaning) on the tip background on the row below it, or above it on the last row. A chart's region
// (`cursor`: a strip, a lane) is never inverse, which would turn the chart into a band: only the pointer's column is
// marked, `┊` in an empty cell and a bar in the text color, on every chart region over the same columns (the lanes and
// the range's strip), and the tip is that cell's (`tips`). A press on a region
// posts a click with the cell it landed on, counted from the region's start; on a region the program lets drag, the
// release posts a drag from the cell pressed to the cell let go, or a click when the pointer did not move. A press on
// no region posts a click of none, which gives the pane its keys back (lines.tsx CLIENT_CLICK). Each post carries the
// frame it was made on, so a click lands on what was drawn.
import type { ClientModule } from 'claude-code'

import { width } from './draw'
import type { Line } from './draw'
import { paintLine } from './paint'

type Hit = { y: number; x0: number; x1: number; row?: boolean; tip?: string; drag?: boolean; cursor?: boolean; tips?: string[] }
type Props = { lines: Line[]; hits: Hit[]; seq: number; cols: number }
type S = { hover: number; x?: number; down: { i: number; x: number } | null }
type Out = { n: number; seq: number; i: number; x?: number; x0?: number; x1?: number; drag?: boolean }

const TIP_BG = 'userMessageBackground'
const RULE = 'subtle'
// every post carries the clicks not yet seen, under this instance's name
const vorigin = Math.random().toString(36).slice(2, 10)
let n = 0
let outbox: Out[] = []

/** The cells [x0, x1) of a line in a style over its own: inverse, or the tip's words on the tip background. */
function overlay(l: Line, x0: number, x1: number, f: (s: Line[number]) => Line[number], put?: string): Line {
  const out: Line = []
  let x = 0
  const cells: { ch: string; s: Line[number] }[] = []
  for (const s of l) for (const ch of s.s) cells.push({ ch, s })
  while (width(cells.map(c => c.ch).join('')) < x1) cells.push({ ch: ' ', s: { s: ' ' } })
  let tip = put !== undefined ? [...put] : null
  for (const c of cells) {
    const w = width(c.ch)
    let seg: Line[number] = { ...c.s, s: c.ch }
    if (x >= x0 && x < x1) {
      if (tip) seg = { s: tip.shift() ?? ' ', bg: TIP_BG }
      else seg = f(seg)
    }
    const prev = out.at(-1)
    if (prev && JSON.stringify({ ...prev, s: '' }) === JSON.stringify({ ...seg, s: '' })) out[out.length - 1] = { ...prev, s: prev.s + seg.s }
    else out.push(seg)
    x += w
  }
  return out
}

function post(surface: { post: (d: never) => void }, o: Omit<Out, 'n'>): void {
  outbox = [...outbox, { n: ++n, ...o }].slice(-8)
  surface.post({ type: 'view', vorigin, vacts: outbox } as never)
}

const ViewClient: ClientModule<Props, S> = (props, surface) => {
  const { Box } = surface.elements
  const st = surface.state ?? { hover: -1, down: null }
  const hits = Array.isArray(props.hits) ? props.hits : []
  const at = (x: number, y: number) => {
    // a control wins over the row it stands on
    const inside = hits.map((h, i) => ({ h, i })).filter(({ h }) => h.y === y && x >= h.x0 && x < h.x1)
    return (inside.find(({ h }) => !h.row) ?? inside[0])?.i ?? -1
  }
  surface.onPointer(ev => {
    const button = ev.button ?? 'left'
    if (ev.type === 'down') {
      if (button === 'middle' || ev.shift || ev.ctrl || ev.alt) return
      const i = at(ev.x, ev.y)
      if (i < 0) return post(surface, { seq: props.seq, i: -1 })
      const h = hits[i]!
      if (h.drag) return surface.setState({ ...st, down: { i, x: ev.x - h.x0 } })
      return post(surface, { seq: props.seq, i, x: ev.x - h.x0 })
    }
    if (ev.type === 'up') {
      const d = st.down
      if (!d) return
      const h = hits[d.i]
      surface.setState({ ...st, down: null })
      if (!h) return
      const x1 = Math.max(-1, Math.min(h.x1 - h.x0, ev.x - h.x0))
      if (x1 === d.x) post(surface, { seq: props.seq, i: d.i, x: d.x })
      else post(surface, { seq: props.seq, i: d.i, x0: d.x, x1: Math.max(0, Math.min(h.x1 - h.x0 - 1, x1)), drag: true })
      return
    }
    if (st.down) return
    const i = ev.type === 'leave' ? -1 : at(ev.x, ev.y)
    // on a chart's region the pointer's column matters too
    const x = i >= 0 && hits[i]?.cursor ? ev.x : undefined
    if (i !== st.hover || x !== st.x) surface.setState({ ...st, hover: i, x })
  })
  if (surface.state === undefined) surface.setState(st)
  let lines = Array.isArray(props.lines) ? props.lines : []
  const h = st.hover >= 0 ? hits[st.hover] : undefined
  const cx = h?.cursor && typeof st.x === 'number' && st.x >= h.x0 && st.x < h.x1 ? st.x : -1
  if (h && h.cursor && cx >= 0) {
    // the pointer's column on each chart region over the same cells: `┊` where nothing is drawn, a bar in the text color
    const mark = (seg: Line[number]): Line[number] => {
      if (!seg.s.trim()) return { s: '┊', fg: RULE, ...(seg.bg ? { bg: seg.bg } : {}) }
      const { fg: _fg, d: _d, ...rest } = seg
      return rest
    }
    const cols = new Set(hits.filter(g => g.cursor && g.x0 === h.x0 && g.x1 === h.x1).map(g => g.y))
    lines = lines.map((l, y) => (cols.has(y) ? overlay(l, cx, cx + 1, mark) : l))
  } else if (h && !h.row) {
    lines = lines.map((l, y) => (y === h.y ? overlay(l, h.x0, h.x1, s => ({ ...s, inv: true })) : l))
  }
  const tipWords = cx >= 0 ? h?.tips?.[cx - h.x0] || h?.tip : h?.tip
  if (h && tipWords) {
    const ty = h.y + 1 < lines.length ? h.y + 1 : h.y - 1
    if (ty >= 0) {
      const words = ` ${tipWords} `
      const w = Math.min(width(words), props.cols)
      const at0 = cx >= 0 ? Math.max(h.x0, cx - 1) : h.x0
      const x0 = Math.max(0, Math.min(at0, props.cols - w))
      lines = lines.map((l, y) => (y === ty ? overlay(l, x0, x0 + w, s => s, words.slice(0, w)) : l))
    }
  }
  return Box({ flexDirection: 'column', width: props.cols, children: lines.map(l => paintLine(surface.elements.Text, l.length ? l : [{ s: ' ' }])) })
}

export default ViewClient
