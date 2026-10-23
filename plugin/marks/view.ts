// view.ts: a reply with marks, as Claude Code elements. No `$`: register.ts resolves the elements and hands in what to
// draw and what a press does.
//
//   messageEl(els, o)  one text block of a reply: each block of its markdown that holds marks laid out here, each mark a
//                      press with its status drawn on it; every other run of blocks drawn by Claude Code's own Markdown,
//                      so paragraphs, lists, code and tables look as in any reply
//   footerEl(els, o)   the line under a reply's last block while its marks are checked (each mark shows its own
//                      status once the check settled, so nothing counts them after)
//
// The check's notes (it found words around a mark false) are not drawn: main reads them with the next prompt
// (checker.ts tellText), and a detail the person must see is a heads-up's.
//
// A mark's look by its status. Every mark is underlined, whatever its status, so a citation reads as one; the status
// shows as its look (citeLook) and the sign after it:
//   pending      the turn still runs: the text's own color, underlined, on the citations' light purple tint
//   checking     as pending, and a turning glyph right after it
//   verified     as pending
//   corrected    the corrected words in place of the marked ones, as pending: once corrected it holds, so it
//                looks as a verified one does (its tray card says it was corrected). A narrowed one (`narrowed`) keeps
//                its words: only the part the check cited is the mark, the rest reads as the reply's plain words
//   failed       the check could not confirm the words (it found them false and no right words, or its evidence
//                did not show them), or it did not run or gave no answer: red (`error`), underlined, no tint, with
//                ` ×` after it. One look whatever the cause
//   unchecked    underlined in the text's color, no tint: words no check is for (a side thread's citations, or new
//                ones in a version shown in place of Claude's words)
//
// A row may also carry spans (core/answerview.ts Span): words a feature draws as a press of its own, such as an
// explainer in teal, underlined; a span inside a mark's words keeps the mark's press and look, its `tint` behind them
// in place of the citation's. While the tray shows
// a mark (`focus`), it is drawn bold on the selection's background. `dim` draws the words dim (a rewrite of them runs),
// and `lead` stands in place of the reply's ● (▸: the answer the person picked for the keys).
//
// Where side threads can be asked about its passages (`passages`), each row of blocks is a passage (a heading's, its
// whole section), and its margin cell asks about it (core/askcell.js): a blue ? while the pointer is over the row, a
// blue ↳ once a thread was asked about it.
import { askCell, passageLabel } from '../core/askcell.js'
import { textWidth } from '../core/text.js'
import { themeLast, type Theme } from '../core/theme'
import { blocks, inline, marksWithin, runsText, tableOf, wrapRuns } from './message.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; b?: boolean; it?: boolean; code?: boolean; link?: boolean; dim?: boolean; mark?: number; span?: number; tag?: string }
type SpanLook = { color?: string; backgroundColor?: string; bold?: boolean; italic?: boolean; underline?: boolean; tint?: string }
/** Words a feature draws as a press of its own (core/answerview.ts Span). */
export type ViewSpan = { start: number; end: number; look: SpanLook; label: string; onPress?: () => unknown }
type Mark = { start: number; end: number; words: string }

export type MarkStatus = 'pending' | 'checking' | 'verified' | 'corrected' | 'failed' | 'unchecked'
export type MarkLook = { n: number; status: MarkStatus; shown?: string; narrowed?: boolean }

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

/** A purple that follows the person's theme (Claude Code's color for a merged pull request): the turning glyph. */
const PURPLE = 'merged'

/** The citations' tint, behind their words. A background takes no theme key, so it is one hex per theme set
 *  (core/theme.ts): the light purple rgba(179,107,255,.24) over a dark terminal's #1e1e1e, rgba(135,0,255,.10) over a
 *  light one's #ffffff. */
export const CITE_TINT: Record<Theme, string> = { dark: '#423054', light: '#f3e6ff' }

/** A citation's words wherever they show (the reply, the tray, the evidence, the claims and threads panes): the text's
 *  own color, underlined (Claude Code's underline takes the text's color), on the citations' tint, so they stand apart
 *  from an explainer's teal and a heads-up's orange, which are colored words. The theme set is the one the drawing hook
 *  read last (themeNow). */
export function citeLook(theme: Theme = themeLast()): { underline: true; backgroundColor: string } {
  return { underline: true, backgroundColor: CITE_TINT[theme] }
}

/** A citation's words by its status, as the header comment says: failed red and underlined, unchecked underlined in
 *  the text's color, every other status citeLook. */
export function wordsLook(status: MarkStatus): { underline: true; color?: string; backgroundColor?: string } {
  if (status === 'failed') return { underline: true, color: 'error' }
  if (status === 'unchecked') return { underline: true }
  return citeLook()
}

/** A narrowed mark's runs: the part of its words the check cited (`shown`) stays the mark's, the words before and after
 *  it are plain words. White space compares loosely and every quote mark as one; the runs as they are when the part is
 *  not found. */
function narrowRuns(runs: Run[], shown: string): Run[] {
  const q = (c: string) => (/["“”‘’']/.test(c) ? '"' : c)
  const text = runsText(runs)
  let flat = ''
  const at: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = /\s/.test(text[i]!) ? ' ' : q(text[i]!)
    if (c === ' ' && (!flat || flat.endsWith(' '))) continue
    flat += c
    at.push(i)
  }
  const want = [...shown.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()].map(q).join('')
  const k = want ? flat.indexOf(want) : -1
  if (k < 0) return runs
  const a = at[k]!, b = at[k + want.length - 1]! + 1
  const out: Run[] = []
  let pos = 0
  for (const r of runs) {
    const end = pos + r.s.length
    const { mark: _m, ...plain } = r
    for (const [x, y, cited] of [[pos, Math.min(end, a), false], [Math.max(pos, a), Math.min(end, b), true], [Math.max(pos, b), end, false]] as const) {
      if (y > x) out.push({ ...(cited ? r : plain), s: r.s.slice(x - pos, y - pos) })
    }
    pos = end
  }
  return out
}

/** Each mark's runs as its status draws them: a correction's words in place of the marked ones (a narrowing's part of
 *  them), and the glyph after a mark that is checked or failed as a run of the mark's own. */
function withLooks(runs: Run[], o: MessageOpts): Run[] {
  const out: Run[] = []
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k]!
    if (r.mark === undefined) { out.push(r); continue }
    let e = k
    while (e + 1 < runs.length && runs[e + 1]!.mark === r.mark) e++
    const look = o.looks[r.mark]
    // a correction may hold markdown (a file's line as written): it draws as the reply's own words would
    const own = runs.slice(k, e + 1)
    if (look?.status === 'corrected' && look.shown) out.push(...(look.narrowed ? narrowRuns(own, look.shown) : inline(look.shown, 0, look.shown.length).map((x: Run) => ({ ...x, mark: r.mark }))))
    else out.push(...own)
    if (look?.status === 'checking') out.push({ s: ` ${o.spin}`, mark: r.mark, tag: 'spin' })
    if (look?.status === 'failed') out.push({ s: ' ×', mark: r.mark, tag: 'x' })
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
  const { tint: _tint, ...look } = sp?.look ?? {}
  const p: Any = { children: r.s, ...look }
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
  // the words underlined in every status; the turning glyph (purple) and the sign after them (failed: red) are not words
  if (r.tag === 'spin') p.color = PURPLE
  else if (r.tag) p.color = 'error'
  else Object.assign(p, wordsLook(look.status))
  // a span inside the mark's words: its tint in place of the citation's
  const sp = r.span !== undefined ? o.spans?.[r.span] : undefined
  const bg = sp?.look.backgroundColor ?? sp?.look.tint
  if (bg) p.backgroundColor = bg
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
      push(blockLines(els, o, b, `${o.key}-l${i}`, w), b.gap && i > 0, passageOf(i, i))
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
