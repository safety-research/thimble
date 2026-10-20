// view.ts: the message layer's drawings as Claude Code elements. No `$`: the shell resolves the elements and hands in
// what to draw and what a press does.
//
//   messageEl(els, o)   one of Claude's messages drawn from its record: the blocks that hold marks laid out here, each
//                       mark a press (a cite underlined, a gloss on a teal fill, a sparkline in place), and every other
//                       run of blocks drawn by Claude Code's own Markdown, so paragraphs, lists, code and tables look
//                       as in any reply
//   catchUpEl(els, o)   a catch-up in place of the replies it stands in for: a rule down its left side, `thimble  catch-up of …`, then
//                       its text (a message drawn as above)
//   messageRows(els, o) a message as rows, one element a row of the terminal, each block laid out here (as the
//                       catch-up's), so a side thread's answer can be cut to the rows its panel has
//   trayEl(els, o)      the tray above the prompt: one card in a frame, its title on the top border, a fixed number of
//                       rows; its keys are in the bar under it, and its color says cite or explain
import { blocks, inline, marksIn, runsText, shownOf, tableOf, width, wrapRuns } from './message.js'
import { paintRegions } from './cells'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; b?: boolean; it?: boolean; code?: boolean; link?: boolean; dim?: boolean; mark?: number; within?: number; tag?: string }
export type Theme = 'dark' | 'light'

/** The marks' colors, per theme: a citation's purple, a mid tone that reads on a dark and a light background; an explained term as a highlighter pen marks it, dark text on a
 *  light teal, and an important detail the same on a light orange, so both read in a light and a dark terminal; the
 *  focused one a deeper shade of its own. `gloss` and `heads` are their frames' colors in the tray. */
export function markColors(theme: Theme) {
  const pen = { glossInk: '#10201e', glossBg: '#9fe0d5', focusGloss: '#4fc3b2', headsInk: '#2a1600', headsBg: '#ffcf94', focusHeads: '#f5a142' }
  return theme === 'light'
    ? { cite: '#8b3fd9', gloss: '#1f8a85', heads: '#c2610f', paper: '#ffffff', ...pen, glossBg: '#c4eee6', headsBg: '#ffe0b8' }
    : { cite: '#b36bff', gloss: '#62d2c6', heads: '#f2a24b', paper: '#1e1e1e', ...pen }
}

/** A key's color in the bar: v's, s's and c's own, else the bar's blue. */
export function keyColor(key: string, theme: Theme): string {
  const own: Record<string, [string, string]> = { v: ['#4f46e5', '#9a93ff'], s: ['#b7791f', '#e0a43a'], c: ['#8a4fb5', '#c792ea'] }
  const pair = own[key] || ['#2a78c4', '#5aa2e6']
  return theme === 'light' ? pair[0] : pair[1]
}

// ------------------------------------------------------------------------------------------------ the message

export type MessageOpts = {
  rec: Any
  key: string
  cols: number
  first: boolean
  theme: Theme
  focus: number | null
  onMark: (i: number) => unknown
  /** a rewrite of it is running (squeeze): the words dim, and `lead` takes the place of its first ● */
  dim?: boolean
  lead?: string | null
  /** the color of `lead` (squeeze's amber when none) */
  leadColor?: string | null
  /** the words' color where the terminal's own may not read (a pane's background: `text`) */
  ink?: string | null
  /** the passages a side thread can be asked about: `has` says whether one has a thread already, `ask` starts it (or
   *  opens it). Each row of blocks is a passage, a heading's its whole section */
  passages?: { has: (p: Passage) => boolean; ask: (p: Passage) => unknown } | null
}

/** A passage of a message a side thread can be about: its words as written, and a few words naming it. */
export type Passage = { text: string; label: string }

/** A run as a Text: Claude Code's styles for bold, italic and inline code. */
function runText(els: Any, r: Run, dim = false, ink: string | null = null) {
  const p: Any = { children: r.s }
  if (ink) p.color = ink
  if (dim) p.dimColor = true
  if (r.b) p.bold = true
  if (r.it) p.italic = true
  if (r.code) p.color = 'permission'
  if (r.dim) p.dimColor = true
  return els.Text(p)
}

/** A mark's run as a press: the citation underlined in purple, the gloss on its teal fill, the sparkline in place; the
 *  focused one inverse. A gloss on words inside a citation's words keeps its fill, underlined, and a click on it opens
 *  the citation (the words are the citation's); the citation's card in the tray offers the gloss. */
function markEl(els: Any, o: MessageOpts, r: Run, key: string) {
  const m = o.rec.marks[r.mark as number]
  const c = markColors(o.theme)
  const inCite = m.kind === 'gloss' && r.within !== undefined && o.rec.marks[r.within]?.kind === 'cite'
  const on = o.focus === r.mark || (inCite && o.focus === r.within)
  const p: Any = { children: r.s }
  if (r.b) p.bold = true
  if (r.tag) {
    // the healing pass's glyph after a citation's words: a small spinner while it checks, a red × when contradicted
    if (r.tag === 'bad') p.color = 'error'
    else p.dimColor = true
  } else if (m.kind === 'cite' && m.heal === 'quiet') {
    // a value the pass unwrapped: plain grey words (a press still says why)
    if (on) { p.backgroundColor = 'selectionBg'; p.color = 'text' } else p.color = 'inactive'
  } else if (m.kind === 'cite') {
    if (on) { p.backgroundColor = c.cite; p.color = c.paper } else { p.color = c.cite; p.underline = true }
  } else if (m.kind === 'gloss') {
    const heads = o.rec.glosses?.[m.gloss as string]?.kind === 'heads'
    p.color = heads ? c.headsInk : c.glossInk
    p.backgroundColor = on ? (heads ? c.focusHeads : c.focusGloss) : heads ? c.headsBg : c.glossBg
    if (r.within !== undefined) p.underline = true
  } else {
    p.color = on ? 'text' : 'inactive'
    if (on) p.backgroundColor = 'selectionBg'
  }
  const label = inCite ? `cite ${o.rec.marks[r.within as number].label}` : m.kind === 'gloss' ? `${o.rec.glosses?.[m.gloss as string]?.kind === 'heads' ? 'heads up' : 'explain'} ${r.s}` : m.kind === 'spark' ? `cite sparkline ${m.ref}` : `cite ${m.label}`
  // the first run of a mark has a key of its own, `mk-<row>-<i>`, so the keys can scroll it into view
  const seen = (o as MessageOpts & { seen?: Set<number> }).seen
  const own = seen && !seen.has(r.mark as number) ? `mk-${o.rec.row}-${r.mark}` : key
  seen?.add(r.mark as number)
  const opens = inCite ? (r.within as number) : (r.mark as number)
  return els.Button({ key: own, plain: true, label, children: [els.Text(p)], onPress: () => o.onMark(opens) })
}

/** One laid-out line: its runs, each mark a press. */
function lineEl(els: Any, o: MessageOpts, runs: Run[], key: string, lead: Any[] = []) {
  const kids: Any[] = [...lead]
  runs.forEach((r, j) => kids.push(r.mark !== undefined ? markEl(els, o, r, `${key}-m${r.mark}-${j}`) : runText(els, r, !!o.dim, o.ink ?? null)))
  if (!runs.some(r => r.mark !== undefined)) return els.Text({ key, wrap: 'truncate-end', children: kids })
  return els.Box({ key, flexDirection: 'row', children: kids.map(k => (typeof k === 'string' ? els.Text({ children: k }) : k)) })
}

/** The 2 columns left of a reply: Claude Code's ● on the reply's first row, else blank. A passage's cell (`ask`): a
 *  blue ↳ once a side thread was asked about it, which opens it; else a blue ? over the ● or the blank, shown only
 *  while the pointer is over the passage's row (the row's keyed Box scopes the hover), which asks about it. The mark
 *  takes the ●'s own cell, so it never adds indent. */
function margin(els: Any, dot: boolean, lead?: string | null, theme: Theme = 'dark', leadColor?: string | null, ask?: { key: string; label: string; has: boolean; press: () => unknown } | null) {
  if (lead) return els.Box({ width: 2, flexShrink: 0, children: [els.Text({ color: leadColor || keyColor('s', theme), children: lead })] })
  const glyph = els.Text({ children: dot ? '●' : ' ' })
  if (!ask) return els.Box({ width: 2, flexShrink: 0, children: [glyph] })
  const blue = keyColor('?', theme)
  if (ask.has) return els.Box({ width: 2, flexShrink: 0, children: [els.Button({ key: `${ask.key}-asked`, plain: true, label: `open the thread about ${ask.label}`, onPress: ask.press, children: [els.Text({ color: blue, children: '↳' })] })] })
  const q = els.Button({ key: `${ask.key}-ask`, plain: true, label: `ask about ${ask.label}`, onPress: ask.press, children: [els.Text({ color: blue, bold: true, children: '?' })] })
  return els.Box({ width: 2, flexShrink: 0, children: [glyph, els.Box({ width: 1, display: 'none', hover: { display: 'flex' }, position: 'absolute', top: 0, left: 0, children: [q] })] })
}

/** A passage's few words: a heading's section by its heading, else its first words. */
function passageLabel(text: string): string {
  const first = text.split('\n')[0]!.trim()
  const head = /^#{1,6}\s+(.*)$/.exec(first)
  const words = (head ? head[1]! : first).replace(/[*_`#>]|\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:[-+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim()
  const cut = [...words].length > 40 ? [...words].slice(0, 39).join('') + '…' : words
  return head ? `the section "${cut}"` : `"${cut}"`
}

/** A heading's whole section: from the heading to the next heading of its level or above. */
function sectionOf(text: string, bs: Any[], i: number): string {
  let j = i
  while (j + 1 < bs.length && !(bs[j + 1].type === 'heading' && bs[j + 1].level <= bs[i].level)) j++
  return text.slice(bs[i].start, bs[j].end)
}

/** A block that holds marks, as lines laid out here. */
function blockLines(els: Any, o: MessageOpts, text: string, b: Any, key: string, w: number): Any[] {
  const out: Any[] = []
  if (b.type === 'table') return tableLines(els, o, text, b, key, w)
  const runs: Run[] = inline(text, b.from, b.to, o.rec.marks)
  if (b.type === 'heading') runs.forEach(r => { r.b = true })
  if (b.type === 'quote') runs.forEach(r => { r.it = true })
  if (b.type === 'item') {
    const pad = ' '.repeat(b.indent)
    const head = `${pad}${b.marker} `
    const lines = wrapRuns(runs, w - width(head))
    lines.forEach((l: Run[], k: number) => out.push(lineEl(els, o, l, `${key}-${k}`, [els.Text({ children: k === 0 ? head : ' '.repeat(width(head)) })])))
    return out
  }
  if (b.type === 'quote') {
    const lines = wrapRuns(runs, w - 2)
    lines.forEach((l: Run[], k: number) => out.push(lineEl(els, o, l, `${key}-${k}`, [els.Text({ dimColor: true, children: '▎ ' })])))
    return out
  }
  wrapRuns(runs, w).forEach((l: Run[], k: number) => out.push(lineEl(els, o, l, `${key}-${k}`)))
  return out
}

/** A table that holds marks, drawn as Claude Code draws a table: a box of light rules, its header bold. One too wide to
 *  draw whole is Claude Code's Markdown, or (`lines`) its rows as written, each cut at the width. */
function tableLines(els: Any, o: MessageOpts, text: string, b: Any, key: string, w: number, lines = false): Any[] {
  const rows: Run[][][] = tableOf(text, b, o.rec.marks)
  const n = Math.max(...rows.map(r => r.length))
  const widths = Array.from({ length: n }, (_, c) => Math.max(1, ...rows.map(r => width(runsText(r[c] || [])))))
  const total = widths.reduce((s, x) => s + x + 3, 1)
  if (total > w) {
    // too wide to draw whole: Claude Code's Markdown, with each mark as its words
    const plain = text.slice(b.start, b.end).replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1')
    if (lines) return plain.split('\n').map((l, k) => els.Text({ key: `${key}-r${k}`, wrap: 'truncate-end', children: l }))
    return [els.Markdown({ text: plain })]
  }
  const rule = (l: string, m: string, r: string) => els.Text({ children: l + widths.map(x => '─'.repeat(x + 2)).join(m) + r })
  const out: Any[] = [rule('┌', '┬', '┐')]
  rows.forEach((cells, k) => {
    const kids: Any[] = [els.Text({ children: '│' })]
    for (let c = 0; c < n; c++) {
      const runs = (cells[c] || []).map(r => (k === 0 ? { ...r, b: true } : r))
      const pad = widths[c]! - width(runsText(runs))
      const left = k === 0 ? Math.floor(pad / 2) : 0
      kids.push(els.Text({ children: ' ' + ' '.repeat(left) }))
      runs.forEach((r, j) => kids.push(r.mark !== undefined ? markEl(els, o, r, `${key}-t${k}-${c}-${j}`) : runText(els, r, false, o.ink ?? null)))
      kids.push(els.Text({ children: ' '.repeat(pad - left) + ' │' }))
    }
    out.push(els.Box({ key: `${key}-r${k}`, flexDirection: 'row', children: kids }))
    if (k === 0 && rows.length > 1) out.push(rule('├', '┼', '┤'))
  })
  out.push(rule('└', '┴', '┘'))
  return out
}

/** One of Claude's messages drawn from its record. */
export function messageEl(els: Any, given: MessageOpts): Any {
  const { Box, Markdown } = els
  const o = { ...given, seen: new Set<number>() }
  const text = shownOf(o.rec)
  const bs = blocks(text)
  const w = Math.max(20, o.cols)
  const rows: Any[] = []
  let dot = o.first
  let k = 0
  // a row's passage (its blocks i to j; a heading's, its whole section), when side threads can be asked about them
  const passageOf = (i: number, j: number): Passage => {
    const words = bs[i].type === 'heading' ? sectionOf(text, bs, i) : text.slice(bs[i].start, bs[j].end)
    return { text: words, label: passageLabel(words) }
  }
  const push = (content: Any[], gap: boolean, p: Passage | null) => {
    const key = `${o.key}-b${k++}`
    const ask = p && o.passages ? { key, label: p.label, has: o.passages.has(p), press: () => o.passages!.ask(p) } : null
    rows.push(Box({ key, flexDirection: 'row', marginTop: gap ? 1 : 0, children: [margin(els, dot, rows.length === 0 ? o.lead : null, o.theme, o.leadColor, ask), Box({ flexDirection: 'column', flexShrink: 1, width: w, children: content })] }))
    dot = false
  }
  let i = 0
  while (i < bs.length) {
    const b = bs[i]
    if (marksIn(o.rec.marks, b.start, b.end).length) {
      push(blockLines(els, o, text, b, `${o.key}-l${i}`, w), b.gap && i > 0, passageOf(i, i))
      i++
      continue
    }
    // a run of blocks with no mark: Claude Code's own Markdown, whole. Where passages can be asked about, a run is one
    // passage: it ends at a blank line (but a list's items stay together) and before a heading
    const joins = (a: Any, n: Any) => !o.passages || (n.type !== 'heading' && (!n.gap || (a.type === 'item' && n.type === 'item')))
    let j = i
    while (j + 1 < bs.length && !marksIn(o.rec.marks, bs[j + 1].start, bs[j + 1].end).length && joins(bs[j], bs[j + 1])) j++
    push([Markdown({ text: text.slice(b.start, bs[j].end), ...(o.dim ? { dimColor: true } : {}) })], b.gap && i > 0, passageOf(i, j))
    i = j + 1
  }
  return Box({ flexDirection: 'column', marginTop: 1, children: rows })
}

// ------------------------------------------------------------------------------------------------ the catch-up

export type CatchUpOpts = MessageOpts & {
  /** what it covers, after `thimble`: `catch-up of 3 replies since your last message` */
  head: string
  /** a line in place of its text: while its first version is written, or why that failed */
  note?: { text: string; error?: boolean } | null
}

/** One block of a catch-up as rows, each one row of the terminal: every kind laid out here, none left to Claude Code's
 *  Markdown, whose wrapping cannot be counted. */
function blockRows(els: Any, o: MessageOpts, text: string, b: Any, key: string, w: number): Any[] {
  const cutRow = (s: string, k: number, p: Any = {}) => els.Text({ key: `${key}-${k}`, wrap: 'truncate-end', ...p, children: s || ' ' })
  if (b.type === 'code') return text.slice(b.start, b.end).split('\n').slice(1, -1).map((l, k) => cutRow(l, k, { color: 'permission', ...(o.dim ? { dimColor: true } : {}) }))
  if (b.type === 'rule') return [cutRow('─'.repeat(Math.min(w, 40)), 0, { dimColor: true })]
  if (b.type === 'table') return tableLines(els, o, text, b, key, w, true)
  return blockLines(els, o, text, b, key, w)
}

/**
 * A catch-up under the newest reply: its head line (`thimble  catch-up of …`) and its text, each row of it after a rule
 * in thimble's color, so the rule runs down its left side as tall as the text. Its text is drawn as a message's is (the
 * marks presses, a citation underlined), every block laid out here so each row can carry the rule.
 */
export function catchUpEl(els: Any, o: CatchUpOpts): Any {
  const { Box, Text } = els
  const color = o.theme === 'light' ? '#4f46e5' : '#9a93ff'
  const mo = { ...o, seen: new Set<number>() }
  const w = Math.max(20, o.cols - 2)
  const ruled = (key: string, kids: Any[]) => Box({ key, flexDirection: 'row', children: [Text({ color, children: '▎ ' }), Box({ flexDirection: 'column', width: w, children: kids })] })
  const rows: Any[] = [ruled(`${o.key}-head`, [Text({ children: [Text({ color, bold: true, children: 'thimble' }), Text({ dimColor: true, children: `  ${o.head}` })] })])]
  if (o.note) rows.push(ruled(`${o.key}-note`, [Text({ wrap: 'truncate-end', ...(o.note.error ? { color: 'error' } : { dimColor: true }), children: o.note.text })]))
  else {
    const text = shownOf(o.rec)
    blocks(text).forEach((b: Any, i: number) => {
      if (b.gap && i > 0) rows.push(ruled(`${o.key}-g${i}`, [Text({ children: ' ' })]))
      blockRows(els, mo, text, b, `${o.key}-l${i}`, w).forEach((line: Any, j: number) => rows.push(ruled(`${o.key}-l${i}-${j}`, [line])))
    })
  }
  return Box({ key: o.key, flexDirection: 'column', marginTop: 1, children: rows })
}

/** One of Claude's messages as rows, each one row of the terminal: `● ` on its first row (Claude Code's mark of a
 *  reply), every block laid out here as a catch-up's is, the marks presses. For a side thread's answer in its panel. */
export function messageRows(els: Any, o: MessageOpts & { mark?: string }): Any[] {
  const { Box, Text } = els
  const mo = { ...o, seen: new Set<number>() }
  const w = Math.max(20, o.cols - 2)
  const text = shownOf(o.rec)
  const out: Any[] = []
  let first = true
  blocks(text).forEach((b: Any, i: number) => {
    if (b.gap && i > 0 && out.length) out.push(Text({ key: `${o.key}-g${i}`, children: ' ' }))
    blockRows(els, mo, text, b, `${o.key}-l${i}`, w).forEach((line: Any, j: number) => {
      out.push(Box({ key: `${o.key}-l${i}-${j}`, flexDirection: 'row', children: [Box({ width: 2, flexShrink: 0, children: [Text({ color: 'text', children: first ? `${o.mark ?? '●'} ` : '  ' })] }), Box({ flexDirection: 'column', width: w, children: [line] })] }))
      first = false
    })
  })
  return out
}

// ------------------------------------------------------------------------------------------------ the tray

export type TrayOpts = {
  key: string
  w: number
  body: number
  theme: Theme
  kind: 'cite' | 'gloss' | 'spark'
  title: string
  grids: Any[] | null
  /** rows of text in place of the card (a side thread), the newest at the bottom */
  lines?: Any[]
  problem?: string | null
  links: { id: string; ref: string; label: string }[]
  onLink: (id: string) => unknown
}

/** The tray: one card in a frame of `body` rows, its title on the top border; a cite's frame purple, an explain's
 *  teal. One frame: the card inside it has none of its own, and its keys are in the hint line. */
export function trayEl(els: Any, o: TrayOpts): Any {
  const { Box, Text } = els
  const c = markColors(o.theme)
  const tone = o.kind === 'gloss' ? c.gloss : c.cite
  const inner = o.w - 4
  const cutTo = (s: string, n: number) => ([...s].length <= n ? s : [...s].slice(0, Math.max(0, n - 1)).join('') + '…')
  const title = cutTo(o.title, Math.max(8, inner - 6))
  const fill = Math.max(1, o.w - 2 - 2 - width(title) - 1 - 2)
  const titleText = o.kind === 'gloss'
    ? Text({ color: c.glossInk, backgroundColor: c.glossBg, bold: true, children: title })
    : Text({ color: c.cite, underline: o.kind === 'cite', bold: true, children: title })
  const top = Text({ wrap: 'truncate-end', children: [Text({ color: tone, children: '╭─ ' }), titleText, Text({ color: tone, children: ' ' + '─'.repeat(fill) + '─╮' })] })
  const bottom = Text({ wrap: 'truncate-end', children: [Text({ color: tone, children: '╰' + '─'.repeat(Math.max(1, o.w - 2)) + '╯' })] })
  const side = Text({ color: tone, children: '│ ' })
  const sideR = Text({ color: tone, children: ' │' })
  const rows: Any[] = []
  const blank = (k: string) => Box({ key: k, flexDirection: 'row', children: [side, Text({ children: ' '.repeat(inner) }), sideR] })
  if (o.lines) {
    for (const [i, l] of o.lines.slice(-o.body).entries()) rows.push(Box({ key: `${o.key}-l${i}`, flexDirection: 'row', children: [side, Box({ width: inner, flexShrink: 0, children: [l] }), sideR] }))
  } else if (!o.grids) {
    rows.push(Box({ key: `${o.key}-wait`, flexDirection: 'row', children: [side, Text({ dimColor: true, children: (o.problem ? cutTo(o.problem, inner) : 'reading it through the kernel…').padEnd(inner) }), sideR] }))
  } else {
    o.grids.forEach((g: Any, gi: number) => {
      if (gi && rows.length < o.body) rows.push(blank(`${o.key}-gap${gi}`))
      for (let y = 0; y < g.h && rows.length < o.body; y++) {
        const painted = paintRegions(g, els, { theme: o.theme, key: `${o.key}-g${gi}`, from: y, rows: 1, onPress: (id: string) => o.onLink(id) })
        rows.push(Box({ key: `${o.key}-${gi}-${y}`, flexDirection: 'row', children: [side, Box({ width: inner, flexShrink: 0, children: [painted] }), sideR] }))
      }
    })
  }
  while (rows.length < o.body) rows.push(blank(`${o.key}-pad${rows.length}`))
  return Box({ flexDirection: 'column', marginLeft: 2, width: o.w, children: [top, ...rows, bottom] })
}
