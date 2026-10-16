// The document's editor (SPEC.md, section 7, "Documents"): a Client surface module (no `$`) that holds a document's
// Markdown in a window `rows` tall over its whole text, moved to keep the cursor in view, `↑ N more` and `↓ N more` dim
// where rows are above or below it. A click puts the cursor (inverse) on the cell clicked and gives it the keyboard:
// typing inserts, Enter breaks the line, Backspace and Delete remove, the arrows, Home, End and the page keys move;
// ctrl+s saves; Esc gives the keys back to the panel. Each change posts the text to the hooks module as a draft, and a
// save posts it to be saved, as `{type: 'doc-edit', slug, text, save}` (register.tsx, report.ts).
import type { ClientModule } from 'claude-code'

import { width } from './draw'
import { fieldRows } from './field'
import { send } from './gestures'

type Props = { slug: string; text: string; cols: number; rows: number }
/** `base`: the text the hooks module drew it with; `text`: what it holds now; `at`: the cursor's index; `top`: the
 *  first row shown; `on`: a click gave it the keyboard. */
type S = { base: string; text: string; at: number; top: number; on: boolean }
type Row = { start: number; end: number }

function rowOf(rows: readonly Row[], at: number): number {
  let r = 0
  rows.forEach((x, k) => {
    if (x.start <= at) r = k
  })
  return r
}

function indexAt(text: string, row: Row, x: number): number {
  let used = 0
  for (let k = row.start; k < row.end; k++) {
    const w = width(text[k]!)
    if (used + w > x) return k
    used += w
  }
  return row.end
}

/** The window over `len` rows that starts at `top` in `room` rows: a row each for `↑ N more` and `↓ N more` where rows
 *  are cut off, and how many of the text's rows show. */
export function editWindow(top: number, len: number, room: number): { up: number; down: number; n: number } {
  if (len <= room) return { up: 0, down: 0, n: len }
  const up = top > 0 ? 1 : 0
  let n = room - up
  const down = top + n < len ? 1 : 0
  n -= down
  return { up, down, n: Math.max(1, n) }
}

/** The first row to show so that row `r` shows, moving the least from `top`; a window that reaches the last row
 *  starts where it shows the most rows. */
export function editTop(top: number, r: number, len: number, room: number): number {
  if (len <= room) return 0
  let t = Math.max(0, Math.min(top, len - 1))
  if (r < t) t = r
  // a window between the first row and the last shows two rows fewer than it has, for `↑ N more` and `↓ N more`
  else if (r >= t + editWindow(t, len, room).n) t = r - Math.max(1, room - 2) + 1
  return Math.max(0, Math.min(t, len - Math.max(1, room - 1)))
}

const SPECIAL = new Set(['up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end', 'escape'])

const DocEdit: ClientModule<Props, S> = (props, surface) => {
  const { Box, Text } = surface.elements
  // the width the panel laid it out at, which wraps its rows as the document's Markdown is saved
  const cols = props.cols || surface.columns || 60
  const room = Math.max(3, props.rows || 20)
  const prev = surface.state
  // a new text from the hooks module (the document saved, or discarded) replaces the editor's unless it holds an edit
  let st: S = prev ?? { base: props.text, text: props.text, at: 0, top: 0, on: false }
  if (prev && props.text !== prev.base) st = { ...prev, base: props.text, text: prev.text === prev.base ? props.text : prev.text, at: prev.text === prev.base ? Math.min(prev.at, props.text.length) : prev.at }
  const rows = fieldRows(st.text, cols)
  const put = (next: S, save = false) => {
    const before = (surface.state ?? st).text
    const rs = fieldRows(next.text, cols)
    surface.setState({ ...next, top: editTop(next.top, rowOf(rs, next.at), rs.length, room) })
    if (save || next.text !== before) send(surface, { type: 'doc-edit', slug: props.slug, text: next.text, save })
  }
  const move = (next: S) => {
    const rs = fieldRows(next.text, cols)
    surface.setState({ ...next, top: editTop(next.top, rowOf(rs, next.at), rs.length, room) })
  }
  surface.onPointer(ev => {
    if (ev.type !== 'down') return
    const cur = surface.state ?? st
    const rs = fieldRows(cur.text, cols)
    const w = editWindow(cur.top, rs.length, room)
    const y = ev.y - w.up
    // a click on `↑ N more` or `↓ N more` moves the window a page
    if (y < 0) return move({ ...cur, on: true, at: rs[Math.max(0, cur.top - w.n)]!.start, top: Math.max(0, cur.top - w.n) })
    if (y >= w.n) return move({ ...cur, on: true, at: rs[Math.min(rs.length - 1, cur.top + 2 * w.n - 1)]!.start, top: cur.top + w.n })
    const r = rs[Math.max(0, Math.min(rs.length - 1, cur.top + y))]!
    surface.setState({ ...cur, on: true, at: indexAt(cur.text, r, Math.max(0, ev.x)) })
  })
  surface.onKey(ev => {
    const cur = surface.state ?? st
    const t = cur.text
    const rs = fieldRows(t, cols)
    const r = rowOf(rs, cur.at)
    const k = ev.key
    if (k === 's' && ev.ctrl) return put({ ...cur, on: true }, true)
    if (k === 'escape') return surface.setState({ ...cur, on: false })
    if (k === 'return' || k === 'enter') return put({ ...cur, on: true, text: `${t.slice(0, cur.at)}\n${t.slice(cur.at)}`, at: cur.at + 1 })
    if (k === 'backspace') return cur.at > 0 ? put({ ...cur, on: true, text: t.slice(0, cur.at - 1) + t.slice(cur.at), at: cur.at - 1 }) : undefined
    if (k === 'delete') return cur.at < t.length ? put({ ...cur, on: true, text: t.slice(0, cur.at) + t.slice(cur.at + 1) }) : undefined
    if (k === 'left') return move({ ...cur, on: true, at: Math.max(0, cur.at - 1) })
    if (k === 'right') return move({ ...cur, on: true, at: Math.min(t.length, cur.at + 1) })
    if (k === 'home' || (k === 'a' && ev.ctrl)) return move({ ...cur, on: true, at: rs[r]!.start })
    if (k === 'end' || (k === 'e' && ev.ctrl)) return move({ ...cur, on: true, at: rs[r]!.end })
    if (k === 'up' || k === 'down' || k === 'pageup' || k === 'pagedown') {
      const by = k === 'up' ? -1 : k === 'down' ? 1 : (k === 'pageup' ? -1 : 1) * Math.max(1, editWindow(cur.top, rs.length, room).n - 1)
      const to = rs[r + by]
      if (!to) return move({ ...cur, on: true, at: by < 0 ? 0 : t.length })
      const x = width(t.slice(rs[r]!.start, cur.at))
      return move({ ...cur, on: true, at: indexAt(t, to, x) })
    }
    if (SPECIAL.has(k) || ev.ctrl || ev.meta) return
    // a character typed, or a run of them pasted
    const typed = k === 'space' ? ' ' : k.replace(/\r\n?/g, '\n')
    if (!typed) return
    put({ ...cur, on: true, text: t.slice(0, cur.at) + typed + t.slice(cur.at), at: cur.at + typed.length })
  })
  if (!prev || st !== prev) surface.setState(st)
  const w = editWindow(st.top, rows.length, room)
  const cur = rowOf(rows, st.at)
  const shown = rows.slice(st.top, st.top + w.n)
  const out = []
  if (w.up) out.push(Text({ dimColor: true, children: `↑ ${st.top.toLocaleString('en-US')} more` }))
  shown.forEach((r, k) => {
    const i = st.top + k
    const line = st.text.slice(r.start, r.end)
    if (!st.on || i !== cur) {
      out.push(Text({ wrap: 'truncate-end', children: line || ' ' }))
      return
    }
    const at = st.at - r.start
    const under = st.text[st.at] && st.at < r.end && st.text[st.at] !== '\n' ? st.text[st.at]! : ' '
    out.push(Text({ wrap: 'truncate-end', children: [line.slice(0, at), Text({ inverse: true, children: under }), line.slice(at + (under === ' ' && st.at >= r.end ? 0 : 1))] }))
  })
  const below = rows.length - st.top - w.n
  if (w.down) out.push(Text({ dimColor: true, children: `↓ ${below.toLocaleString('en-US')} more` }))
  return Box({ flexDirection: 'column', width: cols, children: out })
}

export default DocEdit
