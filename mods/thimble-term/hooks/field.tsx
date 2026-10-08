// A text field that shows all of its text: a Client surface module (no `$`) for a definition too long for Claude Code's
// one-line Input, such as a label's prompt. Its text is wrapped to the field's width and every row shows. A click puts
// the cursor (inverse) on the cell clicked and gives the field the keyboard: typing inserts, Backspace and Delete
// remove, the arrows, Home and End move. Enter saves (in a `multiline` field, such as code, Enter breaks the line and
// ctrl+s saves). Each change posts the text to the hooks module as a draft, and a save posts it to be stored, as
// `{type: 'field', name, text, save}`, so a control beside the field (a run) can store what was typed first.
import type { ClientModule } from 'claude-code'

import { width } from './draw'
import { send } from './gestures'

type Props = { name: string; text: string; cols: number; placeholder?: string; multiline?: boolean }
/** `base`: the text the hooks module drew it with; `text`: what the field holds now; `at`: the cursor's index; `on`: a
 *  click gave it the keyboard. */
type S = { base: string; text: string; at: number; on: boolean }

/** The rows `text` takes in `cols` columns: each row's first and end index. A newline ends a row; a row breaks after
 *  the last space that fits, else where the room ends. One cell stays free for the cursor at a row's end. */
export function fieldRows(text: string, cols: number): { start: number; end: number }[] {
  const room = Math.max(4, cols - 1)
  const rows: { start: number; end: number }[] = []
  let i = 0
  for (;;) {
    const nl = text.indexOf('\n', i)
    const stop = nl < 0 ? text.length : nl
    if (i === stop) rows.push({ start: i, end: i })
    let j = i
    while (j < stop) {
      let k = j
      let used = 0
      while (k < stop && used + width(text[k]!) <= room) {
        used += width(text[k]!)
        k++
      }
      if (k < stop) {
        const sp = text.lastIndexOf(' ', k - 1)
        if (sp >= j) k = sp + 1
      }
      rows.push({ start: j, end: k })
      j = k
    }
    if (nl < 0) break
    i = nl + 1
  }
  return rows
}

/** The row the cursor at `at` stands on: the last row starting at or before it. */
function rowOf(rows: readonly { start: number; end: number }[], at: number): number {
  let r = 0
  rows.forEach((x, k) => {
    if (x.start <= at) r = k
  })
  return r
}

/** The index in row `r` nearest column `x`. */
function indexAt(text: string, row: { start: number; end: number }, x: number): number {
  let used = 0
  for (let k = row.start; k < row.end; k++) {
    const w = width(text[k]!)
    if (used + w > x) return k
    used += w
  }
  return row.end
}

const SPECIAL = new Set(['up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end', 'escape'])

const Field: ClientModule<Props, S> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cols = surface.columns || props.cols || 60
  const prev = surface.state
  // a new text from the hooks module (saved, another label) replaces the field's unless it holds an edit of its own
  let st: S = prev ?? { base: props.text, text: props.text, at: props.text.length, on: false }
  if (prev && props.text !== prev.base) st = { ...prev, base: props.text, text: prev.text === prev.base ? props.text : prev.text, at: prev.text === prev.base ? Math.min(prev.at, props.text.length) : prev.at }
  const rows = fieldRows(st.text, cols)
  const put = (next: S, save = false) => {
    surface.setState(next)
    send(surface, { type: 'field', name: props.name, text: next.text, save })
  }
  surface.onPointer(ev => {
    if (ev.type !== 'down') return
    const cur = surface.state ?? st
    const rs = fieldRows(cur.text, cols)
    const r = rs[Math.max(0, Math.min(rs.length - 1, ev.y))]!
    surface.setState({ ...cur, on: true, at: indexAt(cur.text, r, Math.max(0, ev.x)) })
  })
  surface.onKey(ev => {
    const cur = surface.state ?? st
    const t = cur.text
    const rs = fieldRows(t, cols)
    const r = rowOf(rs, cur.at)
    const k = ev.key
    if ((k === 'return' || k === 'enter') && !props.multiline) return put({ ...cur, on: true }, true)
    if (k === 's' && ev.ctrl) return put({ ...cur, on: true }, true)
    if (k === 'escape') return surface.setState({ ...cur, on: false })
    if (k === 'return' || k === 'enter') return put({ ...cur, on: true, text: `${t.slice(0, cur.at)}\n${t.slice(cur.at)}`, at: cur.at + 1 })
    if (k === 'backspace') return cur.at > 0 ? put({ ...cur, on: true, text: t.slice(0, cur.at - 1) + t.slice(cur.at), at: cur.at - 1 }) : undefined
    if (k === 'delete') return cur.at < t.length ? put({ ...cur, on: true, text: t.slice(0, cur.at) + t.slice(cur.at + 1) }) : undefined
    if (k === 'left') return surface.setState({ ...cur, on: true, at: Math.max(0, cur.at - 1) })
    if (k === 'right') return surface.setState({ ...cur, on: true, at: Math.min(t.length, cur.at + 1) })
    if (k === 'home' || (k === 'a' && ev.ctrl)) return surface.setState({ ...cur, on: true, at: rs[r]!.start })
    if (k === 'end' || (k === 'e' && ev.ctrl)) return surface.setState({ ...cur, on: true, at: rs[r]!.end })
    if (k === 'up' || k === 'down') {
      const to = rs[r + (k === 'up' ? -1 : 1)]
      if (!to) return surface.setState({ ...cur, on: true, at: k === 'up' ? 0 : t.length })
      const x = width(t.slice(rs[r]!.start, cur.at))
      return surface.setState({ ...cur, on: true, at: indexAt(t, to, x) })
    }
    if (SPECIAL.has(k) || ev.ctrl || ev.meta) return
    // a character typed, or a run of them pasted
    const typed = k === 'space' ? ' ' : k.replace(/\r\n?/g, '\n')
    if (!typed) return
    put({ ...cur, on: true, text: t.slice(0, cur.at) + typed + t.slice(cur.at), at: cur.at + typed.length })
  })
  if (!prev || st !== prev) surface.setState(st)
  if (!st.text && !st.on) return Box({ flexDirection: 'column', width: cols, children: [Text({ dimColor: true, children: props.placeholder || ' ' })] })
  const cur = rowOf(rows, st.at)
  return Box({
    flexDirection: 'column',
    width: cols,
    children: rows.map((r, i) => {
      const line = st.text.slice(r.start, r.end)
      if (!st.on || i !== cur) return Text({ wrap: 'truncate-end', children: line || ' ' })
      const k = st.at - r.start
      const under = st.text[st.at] && st.at < r.end ? st.text[st.at]! : ' '
      return Text({ wrap: 'truncate-end', children: [line.slice(0, k), Text({ inverse: true, children: under }), line.slice(k + (under === ' ' && st.at >= r.end ? 0 : 1))] })
    }),
  })
}

export default Field
