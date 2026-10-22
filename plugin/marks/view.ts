// view.ts: a reply with marks, as Claude Code elements. No `$`: register.ts resolves the elements and hands in what to
// draw and what a press does.
//
//   messageEl(els, o)  one text block of a reply: each block of its markdown that holds marks laid out here, each mark a
//                      press with its status drawn on it; every other run of blocks drawn by Claude Code's own Markdown,
//                      so paragraphs, lists, code and tables look as in any reply
//   footerEl(els, o)   the line under a reply's last block while its marks are checked (each mark shows its own
//                      status once the check settled, so nothing counts them after)
//
// A note (the check found the words around a mark false) stands right under the block that holds its sentence, after
// ↳ in the warning color, so the person reads it with the words it is about.
//
// A mark's look by its status:
//   pending      the turn still runs: purple, underlined
//   checking     purple, underlined, and a turning glyph right after it
//   verified     purple, underlined
//   corrected    the corrected words in place of the marked ones, purple, underlined: once corrected it holds, so it
//                looks as a verified one does (its tray card says it was corrected)
//   failed       wrong as the check read the data: red, with ` ×` after it
//   unconfirmed  failed because the check's evidence did not hold: the warning color, with ` ?` after it
//   unchecked    underlined in the text's color: no check could run
//
// A row may also carry spans (core/answerview.ts Span): words a feature draws as a press of its own, such as an
// explainer on a teal fill; a span inside a mark's words keeps the mark's press and adds its fill. While the tray shows
// a mark (`focus`), it is drawn bold on the selection's background. `dim` draws the words dim (a rewrite of them runs),
// and `lead` stands in place of the reply's ● (▸: the answer the person picked for the keys).
//
// Where side threads can be asked about its passages (`passages`), each row of blocks is a passage (a heading's, its
// whole section), and its margin cell asks about it (core/askcell.js): a blue ? while the pointer is over the row, a
// blue ↳ once a thread was asked about it.
import { askCell, passageLabel } from '../core/askcell.js'
import { textWidth } from '../core/text.js'
import { blocks, inline, marksWithin, runsText, tableOf, wrapRuns } from './message.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; b?: boolean; it?: boolean; code?: boolean; link?: boolean; dim?: boolean; mark?: number; span?: number; tag?: string }
type SpanLook = { color?: string; backgroundColor?: string; bold?: boolean; italic?: boolean; underline?: boolean }
/** Words a feature draws as a press of its own (core/answerview.ts Span). */
export type ViewSpan = { start: number; end: number; look: SpanLook; label: string; onPress?: () => unknown }
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
  /** at a mark's index, the check's note on the words around it, if any */
  notes?: (string | undefined)[]
  onMark: (k: number) => unknown
  /** the features' spans on the text's words, in order */
  spans?: ViewSpan[]
  /** the index of the mark the tray shows */
  focus?: number | null
  /** the words drawn dim */
  dim?: boolean
  /** what stands in place of the ● of the reply's first block */
  lead?: string | null
  /** false: no margin cell before each row (a reply drawn inside a frame, such as the tray's, starts at the frame's
   *  left, as its title does) */
  gutter?: boolean
  /** the passages a side thread can be asked about: `has` says whether one was asked about already, `ask` starts it
   *  (or opens it). Each row of blocks is a passage, a heading's its whole section */
  passages?: { has: (p: Passage) => boolean; ask: (p: Passage) => unknown } | null
}

/** A passage of a reply: its words, and a few of them that name it. */
export type Passage = { text: string; label: string }

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
    // a correction may hold markdown (a file's line as written): it draws as the reply's own words would
    out.push(...(look?.status === 'corrected' && look.shown ? inline(look.shown, 0, look.shown.length).map((x: Run) => ({ ...x, mark: r.mark })) : runs.slice(k, e + 1)))
    if (look?.status === 'checking') out.push({ s: ` ${o.spin}`, mark: r.mark, tag: 'spin' })
    if (look?.status === 'failed') out.push({ s: ' ×', mark: r.mark, tag: 'x' })
    if (look?.status === 'unconfirmed') out.push({ s: ' ?', mark: r.mark, tag: 'x' })
    k = e
  }
  return out
}

/** A run as a Text: Claude Code's styles for bold, italic and inline code. */
function runText(els: Any, r: Run, wrap?: string, dim = false) {
  const p: Any = { children: r.s }
  if (wrap) p.wrap = wrap
  if (r.b) p.bold = true
  if (r.it) p.italic = true
  if (r.code) p.color = 'permission'
  if (r.dim || dim) p.dimColor = true
  return els.Text(p)
}

/** A span's run as a press of the feature's, drawn in the span's look. */
function spanEl(els: Any, o: MessageOpts, r: Run, key: string) {
  const sp = o.spans?.[r.span as number]
  const p: Any = { children: r.s, ...(sp?.look ?? {}) }
  if (r.b) p.bold = true
  if (r.it) p.italic = true
  if (r.code && !p.color) p.color = 'permission'
  const text = els.Text(p)
  return sp?.onPress ? els.Button({ key, plain: true, label: String(sp.label || r.s).slice(0, 120), hover: { bold: true }, children: [text], onPress: () => sp.onPress!() }) : els.Text({ key, children: [text] })
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
  else { p.color = PURPLE; p.underline = true }
  // a span inside the mark's words: its fill under the mark's color
  const sp = r.span !== undefined ? o.spans?.[r.span] : undefined
  if (sp?.look.backgroundColor) p.backgroundColor = sp.look.backgroundColor
  if (o.focus === r.mark) { p.bold = true; p.backgroundColor = 'selectionBg' }
  const label = `citation ${look.n}: ${look.shown ?? o.marks[r.mark as number]?.words ?? ''}`.slice(0, 120)
  return els.Button({ key, plain: true, label, hover: { bold: true }, children: [els.Text(p)], onPress: () => o.onMark(r.mark as number) })
}

/** One laid-out line: its runs, each mark a press. A line with marks is a row of its words and presses, cut at its end
 *  when the column narrows before the next drawing arrives (a piece of words wrapping in its own narrow column would
 *  break the text into columns). */
function lineEl(els: Any, o: MessageOpts, runs: Run[], key: string, lead: Any[] = []) {
  const kids: Any[] = [...lead]
  runs.forEach((r, j) => kids.push(r.mark !== undefined ? markEl(els, o, r, `${key}-m${r.mark}-${j}`) : r.span !== undefined ? spanEl(els, o, r, `${key}-s${r.span}-${j}`) : runText(els, r, 'truncate-end', !!o.dim)))
  return els.Box({ key, flexDirection: 'row', children: kids })
}

/** A block that holds marks, as lines laid out here. */
function blockLines(els: Any, o: MessageOpts, b: Any, key: string, w: number): Any[] {
  if (b.type === 'table') return tableLines(els, o, b, key, w)
  const runs = withLooks(inline(o.text, b.from, b.to, o.marks, o.spans ?? []), o)
  if (b.type === 'heading') runs.forEach(r => { r.b = true })
  if (b.type === 'quote') runs.forEach(r => { r.it = true })
  if (b.type === 'item') {
    const head = `${' '.repeat(b.indent)}${b.marker} `
    return wrapRuns(runs, w - textWidth(head)).map((l: Run[], k: number) => lineEl(els, o, l, `${key}-${k}`, [els.Text({ children: k === 0 ? head : ' '.repeat(textWidth(head)) })]))
  }
  const pad = ' '.repeat(b.indent ?? 0)
  if (b.type === 'quote') return wrapRuns(runs, w - pad.length - 2).map((l: Run[], k: number) => lineEl(els, o, l, `${key}-${k}`, [els.Text({ dimColor: true, children: `${pad}▎ ` })]))
  return wrapRuns(runs, w - pad.length).map((l: Run[], k: number) => lineEl(els, o, l, `${key}-${k}`, pad ? [els.Text({ children: pad })] : []))
}

/** The check's notes on the marks of a block, each once, under it: indented as the block's words. */
function noteLines(els: Any, o: MessageOpts, b: Any, key: string): Any[] {
  const said = [...new Set(marksWithin(o.marks, b.start, b.end).map((m: Any) => o.notes?.[m.i]).filter(Boolean))] as string[]
  const pad = b.type === 'item' ? textWidth(`${' '.repeat(b.indent)}${b.marker} `) : b.indent ?? 0
  return said.map((note, k) => els.Box({ key: `${key}-n${k}`, flexDirection: 'row', paddingLeft: pad, children: [els.Text({ color: 'warning', children: '↳ ' }), els.Box({ flexShrink: 1, children: [els.Text({ wrap: 'wrap', children: note })] })] }))
}

/** A table that holds marks, drawn as Claude Code draws a table: a box of light rules, its header bold. One too wide to
 *  draw whole is a list of its rows instead, each row a block of `header: cell` lines (a blank line between rows): the
 *  header bold, the cell's words wrapped beside it, each mark a press as in a paragraph. A header wider than half the
 *  column stands on a line of its own, its cell under it, indented. */
function tableLines(els: Any, o: MessageOpts, b: Any, key: string, w: number): Any[] {
  const rows: Run[][][] = tableOf(o.text, b, o.marks, o.spans ?? []).map((cells: Run[][]) => cells.map(c => withLooks(c, o)))
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
      runs.forEach((r, j) => kids.push(r.mark !== undefined ? markEl(els, o, r, `${key}-t${k}-${c}-${j}`) : r.span !== undefined ? spanEl(els, o, r, `${key}-ts${k}-${c}-${j}`) : runText(els, r, undefined, !!o.dim)))
      kids.push(els.Text({ children: ' '.repeat(pad - left) + ' │' }))
    }
    out.push(els.Box({ key: `${key}-r${k}`, flexDirection: 'row', children: kids }))
    if (k === 0 && rows.length > 1) out.push(rule('├', '┼', '┤'))
  })
  out.push(rule('└', '┴', '┘'))
  return out
}

/** A heading's whole section: from the heading to the next heading of its level or above. */
function sectionOf(text: string, bs: Any[], i: number): string {
  let j = i
  while (j + 1 < bs.length && !(bs[j + 1].type === 'heading' && bs[j + 1].level <= bs[i].level)) j++
  return text.slice(bs[i].start, bs[j].end)
}

/** One text block of a reply, drawn with its marks. */
export function messageEl(els: Any, o: MessageOpts): Any {
  const { Box, Markdown, Text } = els
  const bs = blocks(o.text)
  const w = Math.max(20, o.cols)
  const rows: Any[] = []
  let dot = o.first || !!o.lead
  let k = 0
  // a row's passage (its blocks i to j; a heading's, its whole section), when side threads can be asked about them
  const passageOf = (i: number, j: number): Passage => {
    const words = bs[i].type === 'heading' ? sectionOf(o.text, bs, i) : o.text.slice(bs[i].start, bs[j].end)
    return { text: words, label: passageLabel(words) }
  }
  const push = (content: Any[], gap: boolean, p: Passage) => {
    const key = `${o.key}-b${k++}`
    const lead = dot && o.lead
    const glyph = dot ? '●' : ' '
    const cell = lead
      ? Box({ width: 2, flexShrink: 0, children: [Text({ color: 'suggestion', bold: true, children: o.lead })] })
      : o.passages
        ? askCell(els, { key, label: p.label, has: o.passages.has(p), press: () => o.passages!.ask(p), glyph })
        : Box({ width: 2, flexShrink: 0, children: [Text({ children: glyph })] })
    rows.push(Box({ key, flexDirection: 'row', marginTop: gap ? 1 : 0, children: [...(o.gutter === false ? [] : [cell]), Box({ flexDirection: 'column', flexShrink: 1, width: w, children: content })] }))
    dot = false
  }
  // a block laid out here: one that holds marks, and every item of a list one of whose items holds marks, so a nested
  // item keeps its indent beside its siblings. A code block never is: its lines stay as written, in Claude Code's
  // Markdown, whatever lies in it
  // (dim words are laid out here too, as Claude Code's Markdown draws no dim text; and a block with a span)
  const laid: boolean[] = bs.map((b: Any) => b.type !== 'code' && (!!o.dim || marksWithin(o.marks, b.start, b.end).length > 0 || marksWithin(o.spans ?? [], b.start, b.end).length > 0))
  for (let a = 0; a < bs.length; a++) {
    if (bs[a].type !== 'item') continue
    let z = a
    while (z + 1 < bs.length && bs[z + 1].type === 'item') z++
    if (laid.slice(a, z + 1).some(Boolean)) laid.fill(true, a, z + 1)
    a = z
  }
  const laidOut = (k: number) => laid[k]
  // where passages can be asked about, a run of blocks drawn by Claude Code's Markdown is one passage: it ends at a
  // blank line (but a list's items stay together) and before a heading
  const joins = (a: Any, n: Any) => !o.passages || (n.type !== 'heading' && (!n.gap || (a.type === 'item' && n.type === 'item')))
  let i = 0
  while (i < bs.length) {
    const b = bs[i]
    if (laidOut(i)) {
      push([...blockLines(els, o, b, `${o.key}-l${i}`, w), ...noteLines(els, o, b, `${o.key}-l${i}`)], b.gap && i > 0, passageOf(i, i))
      i++
      continue
    }
    // a run of blocks with no mark: Claude Code's own Markdown, whole
    let j = i
    while (j + 1 < bs.length && !laidOut(j + 1) && joins(bs[j], bs[j + 1])) j++
    push([Markdown({ text: o.text.slice(b.start, bs[j].end) })], b.gap && i > 0, passageOf(i, j))
    i = j + 1
  }
  return Box({ flexDirection: 'column', marginTop: 1, children: rows })
}

export type FooterOpts = { key: string; checking: number; spin: string }

/** The line under a reply's last block while the check runs: `checking 12 citations`. Nothing once it settled: each
 *  citation shows its own status where it stands. */
export function footerEl(els: Any, o: FooterOpts): Any | null {
  if (!o.checking) return null
  const { Box, Text } = els
  return Box({ key: o.key, marginLeft: 2, flexDirection: 'row', children: [Text({ key: 'c', dimColor: true, children: `${o.spin} checking ${o.checking} citation${o.checking === 1 ? '' : 's'}` })] })
}
