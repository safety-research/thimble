// space.js: the blank rows the runner adds between the parts of a card. Views often draw a card as one column of lines
// with nothing between its parts, which reads as one dense block. spaced(tree) returns the tree with a blank row
// (a Text of one space) put in its top column between parts that are apart:
//
//   - after the first line, when it is a sentence (the card's takeaway under its title), not a label or a table's header
//   - before and after a panel: a Box that is more than a line (a border, or a column of 2 or more children, in it), or
//     a run of 3 or more row Boxes (a chart drawn a row per Box)
//   - before and after a legend: a line of 2 or more keys, each a symbol and a word ("● managed  ● leaderless")
//   - before a heading: a line that starts at its left edge with a bold word, under a line that is not one (a list of
//     bold-led rows stays together)
//
// Nothing changes where the parts are already apart (a blank line), or when the view spaced its column itself (a gap,
// a part's margin above or below it). A card gets at most MAX_ROWS more rows, and a card of fewer than MIN_ROWS rows
// stays as it is. A line that starts with a selection marker (▸) is never a heading, so the rows stay where they are
// when the selection moves. The runner leaves a view that listens to clicks by cell (surface.onPointer) as it drew it,
// since its cells are the view's own. Pure: no Node.

import { layoutLines } from './layout.js'

const MAX_ROWS = 4
const MIN_ROWS = 12
const MARKER = /^[▸►▶›>]\s?/u
const KEY = /^[^\p{L}\p{N}\s](?:\s*[^\p{L}\p{N}\s])*\s+\p{L}/u

const isNode = n => !!n && typeof n === 'object'
const isBox = n => isNode(n) && n.t === 'Box'
const isText = n => isNode(n) && n.t === 'Text'
const column = n => isBox(n) && (n.p.flexDirection === 'column' || n.p.flexDirection === 'column-reverse')

/** The words a node draws, joined (a row Box's children side by side). */
function textOf(n) {
  if (typeof n === 'string') return n
  if (!isNode(n)) return ''
  return (n.c || []).map(textOf).join(column(n) ? '\n' : '')
}

/** A line's top runs: [{text, bold}], a Text's strings and nested Texts, or a row Box's Texts. */
function runsOf(n, bold = false) {
  const b = bold || !!n.p?.bold
  return (n.c || []).flatMap(k => (typeof k === 'string' ? [{ text: k, bold: b }] : isText(k) ? [{ text: textOf(k), bold: b || !!k.p.bold }] : []))
}

/** One line of text: a Text, or a row Box that holds only Texts. */
const line = n => isText(n) || (isBox(n) && !column(n) && !n.p.borderStyle && (n.c || []).every(k => typeof k === 'string' || isText(k)))

const blank = n => (isText(n) || isBox(n)) && !n.p?.borderStyle && textOf(n).trim() === ''

/** A sentence, not a label or a table's header: one Text of 5 or more words, with no run of two spaces inside it, or
 *  with a bold start and plain words after it. */
function sentence(n) {
  if (!isText(n)) return false
  const text = textOf(n).trim()
  if ((text.match(/\p{L}+/gu) || []).length < 5) return false
  if (!/\S {2,}\S/.test(text)) return true
  const runs = runsOf(n).filter(r => r.text.trim())
  return runs.length > 1 && runs[0].bold && runs.slice(1).some(r => !r.bold)
}

const tall = n => isBox(n) && (!!n.p.borderStyle || (column(n) && (n.c || []).length >= 2) || (n.c || []).some(tall))
// a Button around lines (a Box with onPress) is an item of a list, not a panel
const panel = n => isBox(n) && !line(n) && typeof n.p.onPress !== 'number' && tall(n)

/** A legend: two or more keys, each a symbol and a word, the first at the line's left edge. */
function legend(n) {
  if (!line(n)) return false
  const text = textOf(n)
  if (MARKER.test(text) || !KEY.test(text)) return false
  return runsOf(n).filter(r => KEY.test(r.text.replace(/^\s+/, ''))).length >= 2
}

/** A line that starts at its left edge with a bold word (`marked`: a selection marker before it counts as no marker). */
function boldLed(n, marked) {
  if (!line(n)) return false
  const runs = runsOf(n).filter(r => r.text !== '')
  if (!runs.length || !runs[0].bold) return false
  const text = marked ? textOf(n).replace(MARKER, '') : textOf(n)
  return /^[\p{L}\p{N}]/u.test(text)
}

/** The column the blank rows go in: the tree's, or that of the one column Box it wraps. */
function topColumn(tree) {
  let n = tree
  while (column(n) && n.c?.length === 1 && column(n.c[0])) n = n.c[0]
  return column(n) ? n : null
}

/** A part the view put apart from the others itself, with a margin above or below it. */
const margined = n => isNode(n) && ['margin', 'marginY', 'marginTop', 'marginBottom'].some(k => num(n.p?.[k]))

const num = v => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? 1 : 0)

/** The tree with blank rows between its top column's parts; the tree itself when none goes in, or when it takes fewer
 *  than MIN_ROWS rows at `width` (a small card reads well as it is). */
export function spaced(tree, width) {
  const col = topColumn(tree)
  if (!col || col.p.flexDirection === 'column-reverse' || num(col.p.gap) || num(col.p.rowGap)) return tree
  const K = col.c || []
  if (K.length < 2 || K.some(margined) || layoutLines(tree, width).lines.length < MIN_ROWS) return tree
  const at = []
  const add = i => { if (i > 0 && i < K.length && !at.includes(i)) at.push(i) }
  if (sentence(K[0])) add(1)
  for (let i = 0; i < K.length; i++) {
    // panels side by side in the column stay as the view put them: the blank rows go before the first and after the last
    if (panel(K[i]) && !panel(K[i - 1])) add(i)
    if (panel(K[i]) && !panel(K[i + 1])) add(i + 1)
    if (legend(K[i])) { add(i); add(i + 1) }
    if (i > 0 && boldLed(K[i], false) && !boldLed(K[i - 1], true)) add(i)
  }
  // a run of 3 or more row Boxes: a chart
  for (let i = 0; i < K.length;) {
    let j = i
    while (j < K.length && line(K[j]) && isBox(K[j]) && typeof K[j].p.onPress !== 'number' && !blank(K[j])) j++
    if (j - i >= 3) { add(i); add(j) }
    i = Math.max(j, i + 1)
  }
  const put = new Set(at.filter(i => !blank(K[i]) && !blank(K[i - 1])).sort((a, b) => a - b).slice(0, MAX_ROWS))
  if (!put.size) return tree
  const c = K.flatMap((k, i) => (put.has(i) ? [{ t: 'Text', p: {}, c: [' '] }, k] : [k]))
  const swap = n => (n === col ? { ...n, c } : { ...n, c: n.c.map(swap) })
  return swap(tree)
}
