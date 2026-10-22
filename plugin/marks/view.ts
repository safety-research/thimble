// view.ts: a reply with marks, as Claude Code elements. No `$`: register.ts resolves the elements and hands in what to
// draw and what a press does.
//
//   messageEl(els, o)  one text block of a reply: each block of its markdown that holds marks laid out here, each mark a
//                      press with its status drawn on it; every other run of blocks drawn by Claude Code's own Markdown,
//                      so paragraphs, lists, code and tables look as in any reply
//   footerEl(els, o)   the lines under a reply's last block while its marks are checked, or when the check changed or
//                      flagged some or found a statement no mark carries false (a note)
//
// A mark's look by its status:
//   pending      the turn still runs: purple, underlined
//   checking     purple, underlined, and a turning glyph right after it
//   verified     purple, underlined
//   corrected    the corrected words in place of the marked ones, in the warning color, underlined (the footer counts
//                them), so a changed claim stands out from the ones that held
//   failed       wrong as the check read the data: red, with ` ×` after it
//   unconfirmed  failed because the check's evidence did not hold: the warning color, with ` ?` after it
//   unchecked    underlined in the text's color: no check could run
import { textWidth } from '../core/text.js'
import { blocks, inline, marksWithin, runsText, tableOf, wrapRuns } from './message.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; b?: boolean; it?: boolean; code?: boolean; link?: boolean; dim?: boolean; mark?: number; tag?: string }
type Mark = { start: number; end: number; words: string }

export type MarkStatus = 'pending' | 'checking' | 'verified' | 'corrected' | 'failed' | 'unconfirmed' | 'unchecked'
export type MarkLook = { n: number; status: MarkStatus; shown?: string }

export type MessageOpts = {
  text: string
  /** the text's marks (message.js marksIn) and, at the same index, how each is drawn */
  marks: Mark[]
  looks: MarkLook[]
  key: string
  cols: number
  /** the block draws the bullet that opens a reply */
  first: boolean
  /** the turning glyph's frame now, after a mark that is checked */
  spin: string
  onMark: (k: number) => unknown
}

/** A purple that follows the person's theme (Claude Code's color for a merged pull request). */
const PURPLE = 'merged'

/** Each mark's runs as its status draws them: a correction's words in place of the marked ones, and the glyph after a
 *  mark that is checked or failed as a run of the mark's own. */
function withLooks(runs: Run[], o: MessageOpts): Run[] {
  const out: Run[] = []
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k]!
    if (r.mark === undefined) { out.push(r); continue }
    let e = k
    while (e + 1 < runs.length && runs[e + 1]!.mark === r.mark) e++
    const look = o.looks[r.mark]
    out.push(...(look?.status === 'corrected' && look.shown ? [{ s: look.shown, mark: r.mark }] : runs.slice(k, e + 1)))
    if (look?.status === 'checking') out.push({ s: ` ${o.spin}`, mark: r.mark, tag: 'spin' })
    if (look?.status === 'failed') out.push({ s: ' ×', mark: r.mark, tag: 'x' })
    if (look?.status === 'unconfirmed') out.push({ s: ' ?', mark: r.mark, tag: 'x' })
    k = e
  }
  return out
}

/** A run as a Text: Claude Code's styles for bold, italic and inline code. */
function runText(els: Any, r: Run, wrap?: string) {
  const p: Any = { children: r.s }
  if (wrap) p.wrap = wrap
  if (r.b) p.bold = true
  if (r.it) p.italic = true
  if (r.code) p.color = 'permission'
  if (r.dim) p.dimColor = true
  return els.Text(p)
}

/** A mark's run as a press that opens its evidence, drawn by its status. */
function markEl(els: Any, o: MessageOpts, r: Run, key: string) {
  const look: MarkLook = o.looks[r.mark as number] ?? { n: (r.mark as number) + 1, status: 'pending' }
  const p: Any = { children: r.s }
  if (r.b) p.bold = true
  if (r.it) p.italic = true
  if (r.tag === 'spin') p.color = PURPLE
  else if (look.status === 'failed') p.color = 'error'
  else if (look.status === 'unconfirmed') p.color = 'warning'
  else if (look.status === 'unchecked') p.underline = true
  else if (look.status === 'corrected') { p.color = 'warning'; p.underline = true }
  else { p.color = PURPLE; p.underline = true }
  const label = `mark ${look.n}: ${look.shown ?? o.marks[r.mark as number]?.words ?? ''}`.slice(0, 120)
  return els.Button({ key, plain: true, label, hover: { bold: true }, children: [els.Text(p)], onPress: () => o.onMark(r.mark as number) })
}

/** One laid-out line: its runs, each mark a press. A line with marks is a row of its words and presses, cut at its end
 *  when the column narrows before the next drawing arrives (a piece of words wrapping in its own narrow column would
 *  break the text into columns). */
function lineEl(els: Any, o: MessageOpts, runs: Run[], key: string, lead: Any[] = []) {
  const kids: Any[] = [...lead]
  runs.forEach((r, j) => kids.push(r.mark !== undefined ? markEl(els, o, r, `${key}-m${r.mark}-${j}`) : runText(els, r, 'truncate-end')))
  return els.Box({ key, flexDirection: 'row', children: kids })
}

/** A block that holds marks, as lines laid out here. */
function blockLines(els: Any, o: MessageOpts, b: Any, key: string, w: number): Any[] {
  if (b.type === 'table') return tableLines(els, o, b, key, w)
  const runs = withLooks(inline(o.text, b.from, b.to, o.marks), o)
  if (b.type === 'heading') runs.forEach(r => { r.b = true })
  if (b.type === 'quote') runs.forEach(r => { r.it = true })
  if (b.type === 'item') {
    const head = `${' '.repeat(b.indent)}${b.marker} `
    return wrapRuns(runs, w - textWidth(head)).map((l: Run[], k: number) => lineEl(els, o, l, `${key}-${k}`, [els.Text({ children: k === 0 ? head : ' '.repeat(textWidth(head)) })]))
  }
  if (b.type === 'quote') return wrapRuns(runs, w - 2).map((l: Run[], k: number) => lineEl(els, o, l, `${key}-${k}`, [els.Text({ dimColor: true, children: '▎ ' })]))
  return wrapRuns(runs, w).map((l: Run[], k: number) => lineEl(els, o, l, `${key}-${k}`))
}

/** A table that holds marks, drawn as Claude Code draws a table: a box of light rules, its header bold. One too wide to
 *  draw whole is a list of its rows instead, each row a block of `header: cell` lines (a blank line between rows): the
 *  header bold, the cell's words wrapped beside it, each mark a press as in a paragraph. A header wider than half the
 *  column stands on a line of its own, its cell under it, indented. */
function tableLines(els: Any, o: MessageOpts, b: Any, key: string, w: number): Any[] {
  const rows: Run[][][] = tableOf(o.text, b, o.marks).map((cells: Run[][]) => cells.map(c => withLooks(c, o)))
  const n = Math.max(...rows.map(r => r.length))
  const widths = Array.from({ length: n }, (_, c) => Math.max(1, ...rows.map(r => textWidth(runsText(r[c] || [])))))
  const total = widths.reduce((s, x) => s + x + 3, 1)
  if (total > w) {
    const heads: Run[][] = rows.length > 1 ? rows[0]!.map(h => (runsText(h).trim() ? [...h.map(r => ({ ...r, b: true })), { s: ':', b: true }] : [])) : []
    const body = rows.length > 1 ? rows.slice(1) : rows
    const hw = Math.max(0, ...heads.map(h => (h.length ? textWidth(runsText(h)) + 1 : 0)))
    const beside = hw <= Math.floor(w / 2)
    const out: Any[] = []
    body.forEach((cells, k) => {
      if (k) out.push(els.Text({ key: `${key}-g${k}`, children: ' ' }))
      for (let c = 0; c < n; c++) {
        const runs = cells[c] || []
        if (!runsText(runs).trim()) continue
        const head = heads[c] || []
        const id = `${key}-r${k}-${c}`
        if (beside) {
          // the header and its padding on the cell's first line, the cell's other lines indented as far
          const pad = head.length ? hw : 0
          const fill = { s: ' '.repeat(Math.max(0, pad - textWidth(runsText(head)))) }
          wrapRuns(runs, w - pad).forEach((l: Run[], j: number) => out.push(lineEl(els, o, j === 0 ? [...head, ...(pad ? [fill] : []), ...l] : [{ s: ' '.repeat(pad) }, ...l], `${id}-${j}`)))
        } else {
          wrapRuns(head, w).forEach((l: Run[], j: number) => out.push(lineEl(els, o, l, `${id}-h${j}`)))
          wrapRuns(runs, w - 2).forEach((l: Run[], j: number) => out.push(lineEl(els, o, [{ s: '  ' }, ...l], `${id}-${j}`)))
        }
      }
    })
    return out
  }
  const rule = (l: string, m: string, r: string) => els.Text({ children: l + widths.map(x => '─'.repeat(x + 2)).join(m) + r })
  const out: Any[] = [rule('┌', '┬', '┐')]
  rows.forEach((cells, k) => {
    const kids: Any[] = [els.Text({ children: '│' })]
    for (let c = 0; c < n; c++) {
      const runs = (cells[c] || []).map(r => (k === 0 ? { ...r, b: true } : r))
      const pad = widths[c]! - textWidth(runsText(runs))
      const left = k === 0 ? Math.floor(pad / 2) : 0
      kids.push(els.Text({ children: ' ' + ' '.repeat(left) }))
      runs.forEach((r, j) => kids.push(r.mark !== undefined ? markEl(els, o, r, `${key}-t${k}-${c}-${j}`) : runText(els, r)))
      kids.push(els.Text({ children: ' '.repeat(pad - left) + ' │' }))
    }
    out.push(els.Box({ key: `${key}-r${k}`, flexDirection: 'row', children: kids }))
    if (k === 0 && rows.length > 1) out.push(rule('├', '┼', '┤'))
  })
  out.push(rule('└', '┴', '┘'))
  return out
}

/** One text block of a reply, drawn with its marks. */
export function messageEl(els: Any, o: MessageOpts): Any {
  const { Box, Markdown, Text } = els
  const bs = blocks(o.text)
  const w = Math.max(20, o.cols)
  const rows: Any[] = []
  let dot = o.first
  let k = 0
  const push = (content: Any[], gap: boolean) => {
    rows.push(Box({ key: `${o.key}-b${k++}`, flexDirection: 'row', marginTop: gap ? 1 : 0, children: [Box({ width: 2, flexShrink: 0, children: [Text({ children: dot ? '●' : ' ' })] }), Box({ flexDirection: 'column', flexShrink: 1, width: w, children: content })] }))
    dot = false
  }
  // a block laid out here: one that holds marks, and every item of a list one of whose items holds marks, so a nested
  // item keeps its indent beside its siblings. A code block never is: its lines stay as written, in Claude Code's
  // Markdown, whatever lies in it
  const laid: boolean[] = bs.map((b: Any) => b.type !== 'code' && marksWithin(o.marks, b.start, b.end).length > 0)
  for (let a = 0; a < bs.length; a++) {
    if (bs[a].type !== 'item') continue
    let z = a
    while (z + 1 < bs.length && bs[z + 1].type === 'item') z++
    if (laid.slice(a, z + 1).some(Boolean)) laid.fill(true, a, z + 1)
    a = z
  }
  const laidOut = (k: number) => laid[k]
  let i = 0
  while (i < bs.length) {
    const b = bs[i]
    if (laidOut(i)) {
      push(blockLines(els, o, b, `${o.key}-l${i}`, w), b.gap && i > 0)
      i++
      continue
    }
    // a run of blocks with no mark: Claude Code's own Markdown, whole
    let j = i
    while (j + 1 < bs.length && !laidOut(j + 1)) j++
    push([Markdown({ text: o.text.slice(b.start, bs[j].end) })], b.gap && i > 0)
    i = j + 1
  }
  return Box({ flexDirection: 'column', marginTop: 1, children: rows })
}

export type FooterOpts = { key: string; checking: number; wrong: number; unconfirmed: number; corrected: number; unchecked: number; notes?: string[]; spin: string }

/** The lines under a reply's last block: `checking 12 marks` while the check runs; afterwards, when there are any,
 *  `1 mark wrong` in red, `2 not confirmed` in the warning color, `1 corrected` and `3 not checked` dim, then each
 *  note, a statement of the reply that no mark carried and the check found false, after a red ×; nothing when every
 *  mark was verified as written and no note came. */
export function footerEl(els: Any, o: FooterOpts): Any | null {
  const { Box, Text } = els
  const marks = (n: number) => `${n} mark${n === 1 ? '' : 's'}`
  const parts: Any[] = []
  const notes: Any[] = []
  if (o.checking) parts.push(Text({ key: 'c', dimColor: true, children: `${o.spin} checking ${marks(o.checking)}` }))
  else {
    const said: [string, number, Any][] = [['wrong', o.wrong, { color: 'error' }], ['not confirmed', o.unconfirmed, { color: 'warning' }], ['corrected', o.corrected, { dimColor: true }], ['not checked', o.unchecked, { dimColor: true }]]
    for (const [word, n, style] of said) {
      if (!n) continue
      if (parts.length) parts.push(Text({ key: `s${parts.length}`, dimColor: true, children: ' · ' }))
      parts.push(Text({ key: word, ...style, children: `${parts.length ? n : marks(n)} ${word}` }))
    }
    for (const [k, note] of (o.notes ?? []).entries()) {
      notes.push(Box({ key: `n${k}`, flexDirection: 'row', children: [Text({ color: 'error', children: '× ' }), Box({ flexShrink: 1, children: [Text({ wrap: 'wrap', children: note })] })] }))
    }
  }
  if (!parts.length && !notes.length) return null
  return Box({ key: o.key, marginLeft: 2, flexDirection: 'column', children: [...(parts.length ? [Box({ key: 'counts', flexDirection: 'row', children: parts })] : []), ...notes] })
}
