// cardframe.js: the frame a card has under a reply. A card reads as a card: a full border with square corners, its
// question in bold on the first row, a blank row, the drawing, and its takeaway under the drawing when it has one.
//
//   cardFrame(els, {key, w, title, text, body, bodyH, more, onMore, color}) -> one Box
//   w      the frame's outer width; the drawing inside has w - 4 columns (a border and a space on each side)
//   body   the drawing's element (cells.ts paintRegions), bodyH rows tall
//   more   the drawing's rows cut off below bodyH (bodyRows), said in one dim row under it; onMore opens them
//   color  the border's color: the keys' color on the card the keys act on, else none (the border is dim)
//   text   the takeaway, as Claude saved it; its citations show as their words
// frameLines() is the same frame's text rows, for a test or a plain-text surface.
import { width } from './message.js'

/** The frame's outer width for a drawing `gridW` columns wide, as wide as the drawing or its title needs and no wider
 *  than `outer`. */
export function frameWidth(outer, gridW, title) {
  return Math.min(outer, Math.max(gridW, Math.min(outer - 4, width(String(title || ''))), 36) + 4)
}

/** The rows a card's drawing takes under a reply on a screen `screen` rows tall: the whole drawing when it fits with
 *  its frame and the prompt; else what fits, with its last row kept for the line that says how many rows are below. */
export function bodyRows(gridH, screen) {
  const room = Math.max(12, screen - 14)
  return gridH <= room ? { rows: gridH, more: 0 } : { rows: room - 1, more: gridH - room + 1 }
}

/** The line under a cut drawing. */
export const moreText = n => `↓ ${n} more ${n === 1 ? 'row' : 'rows'} · open the card to see all`

/** Words to rows of at most `w` columns; a word longer than a row is cut with an ellipsis. */
export function wrapTo(s, w) {
  const out = []
  let cur = ''
  for (const word of String(s || '').split(/\s+/).filter(Boolean)) {
    const wd = width(word) > w ? [...word].slice(0, Math.max(1, w - 1)).join('') + '…' : word
    if (!cur) cur = wd
    else if (width(cur) + 1 + width(wd) <= w) cur += ' ' + wd
    else { out.push(cur); cur = wd }
  }
  if (cur) out.push(cur)
  return out
}

/** A takeaway as the analyst reads it in a frame: a citation `[words](ref)` shows its words, `**bold**` its text. */
export function plainTakeaway(s) {
  return String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\s+/g, ' ').trim()
}

/** The frame's rows around a body: [{kind: 'top'|'title'|'blank'|'body'|'text'|'bottom', s}] with the body's rows as
 *  one 'body' entry of `bodyH` rows. */
export function frameRows({ w, title, text, bodyH, more }) {
  const inner = Math.max(1, w - 4)
  const rows = [{ kind: 'top', s: '┌' + '─'.repeat(w - 2) + '┐' }]
  const t = wrapTo(title, inner).slice(0, 2)
  t.forEach(s => rows.push({ kind: 'title', s }))
  if (t.length) rows.push({ kind: 'blank', s: '' })
  rows.push({ kind: 'body', h: bodyH })
  if (more > 0) rows.push({ kind: 'more', s: moreText(more) })
  const take = wrapTo(plainTakeaway(text), inner)
  if (take.length) {
    rows.push({ kind: 'blank', s: '' })
    take.forEach(s => rows.push({ kind: 'text', s }))
  }
  rows.push({ kind: 'bottom', s: '└' + '─'.repeat(w - 2) + '┘' })
  return rows
}

/** The frame as plain text around a body given as its rows of text. */
export function frameLines(o, bodyLines) {
  const inner = Math.max(1, o.w - 4)
  const pad = s => s + ' '.repeat(Math.max(0, inner - width(s)))
  const out = []
  for (const r of frameRows({ ...o, bodyH: bodyLines.length })) {
    if (r.kind === 'top' || r.kind === 'bottom') out.push(r.s)
    else if (r.kind === 'body') bodyLines.forEach(l => out.push('│ ' + pad(l) + ' │'))
    else out.push('│ ' + pad(r.s) + ' │')
  }
  return out
}

/** The frame as Claude Code elements around the drawing's element. */
export function cardFrame(els, o) {
  const { Box, Text } = els
  const inner = Math.max(1, o.w - 4)
  const line = o.color ? { color: o.color } : { dimColor: true }
  const rows = frameRows(o)
  const innerH = rows.filter(r => r.kind !== 'top' && r.kind !== 'bottom').reduce((n, r) => n + (r.kind === 'body' ? r.h : 1), 0)
  const side = (k, s) => Box({ key: `${o.key}-${k}`, flexDirection: 'column', width: 2, flexShrink: 0, children: Array.from({ length: innerH }, (_, i) => Text({ key: `${k}${i}`, ...line, children: s })) })
  const mid = []
  rows.forEach((r, i) => {
    if (r.kind === 'title') mid.push(Text({ key: `t${i}`, bold: true, wrap: 'truncate-end', children: r.s }))
    else if (r.kind === 'blank') mid.push(Text({ key: `b${i}`, children: ' ' }))
    else if (r.kind === 'text') mid.push(Text({ key: `x${i}`, wrap: 'truncate-end', children: r.s }))
    else if (r.kind === 'more') mid.push(moreRow(els, r.s, o.onMore))
    else if (r.kind === 'body') mid.push(Box({ key: 'body', height: r.h, overflow: 'hidden', children: [o.body] }))
  })
  return Box({
    key: o.key, flexDirection: 'column', width: o.w,
    children: [
      Text({ key: 'top', ...line, children: rows[0].s }),
      Box({ key: 'mid', flexDirection: 'row', children: [side('l', '│ '), Box({ key: 'in', flexDirection: 'column', width: inner, children: mid }), side('r', ' │')] }),
      Text({ key: 'bottom', ...line, children: rows[rows.length - 1].s }),
    ],
  })
}

/** The dim line under a cut drawing, a press that opens the card when `open` is given. */
export function moreRow(els, s, open) {
  const t = els.Text({ key: 'more', dimColor: true, wrap: 'truncate-end', children: s })
  return open ? els.Button({ key: 'more-b', plain: true, label: 'open the card to see all its rows', onPress: open, children: [t] }) : t
}

/** A card in one row, for a column too narrow for its frame (a chat beside a pane): `□ ` and its title, cut to fit,
 *  then `· 1 open` on the card the keys act on (`keyed`, the key in `color`), else `· open`. The row is a press that
 *  opens the card when `open` is given. No wider than `w`. */
export function cardLine(els, o) {
  const tail = o.keyed ? ' · 1 open' : ' · open'
  const room = Math.max(1, o.w - 2 - width(tail))
  const t = String(o.title || 'card').replace(/\s+/g, ' ').trim()
  const title = width(t) <= room ? t : [...t].slice(0, Math.max(0, room - 1)).join('') + '…'
  const kids = [
    els.Text({ key: 'g', ...(o.color ? { color: o.color } : { dimColor: true }), children: '□ ' }),
    els.Text({ key: 't', bold: true, children: title }),
    els.Text({ key: 'd', dimColor: true, children: ' · ' }),
    ...(o.keyed ? [els.Text({ key: 'k', color: o.color, children: '1 ' })] : []),
    els.Text({ key: 'o', dimColor: true, children: 'open' }),
  ]
  const row = els.Text({ key: o.key, wrap: 'truncate-end', children: kids })
  return o.open ? els.Button({ key: `${o.key}-b`, plain: true, label: `open the card ${t}`, onPress: o.open, children: [row] }) : row
}
