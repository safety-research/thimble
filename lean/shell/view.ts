// view.ts: the message layer's drawings as Claude Code elements. No `$`: the shell resolves the elements and hands in
// what to draw and what a press does.
//
//   messageEl(els, o)   one of Claude's messages drawn from its record: the blocks that hold marks laid out here, each
//                       mark a press (a cite underlined, a gloss on a teal fill, a sparkline in place), and every other
//                       run of blocks drawn by Claude Code's own Markdown, so paragraphs, lists, code and tables look
//                       as in any reply
//   verbRowEl(els, o)   `v visualize · s squeeze · a atlas` under a message: dim at rest, a lit verb in its color with
//                       ● and its note
//   verbLineEl(els, o)  the line a verb opens under the row: v's proposals, squeeze's chips, atlas's offer
//   trayEl(els, o)      the tray above the prompt: one card in a frame, its title and kind on the top border, its keys
//                       on the bottom border, a fixed number of rows
import { blocks, inline, marksIn, runsText, shownOf, tableOf, width, wrapRuns } from './message.js'
import { paintRegions } from './cells'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; b?: boolean; it?: boolean; code?: boolean; link?: boolean; dim?: boolean; mark?: number }
export type Theme = 'dark' | 'light'

/** The marks' colors: a citation's indigo, a gloss's teal and its fill, per theme. */
export function markColors(theme: Theme) {
  return theme === 'light'
    ? { cite: '#4f46e5', gloss: '#1f8a85', glossBg: '#dcefec', paper: '#ffffff', focusGloss: '#1f8a85' }
    : { cite: '#a29bff', gloss: '#62d2c6', glossBg: '#173d3a', paper: '#1e1e1e', focusGloss: '#2a9d94' }
}

/** A verb's color: its verb.json `color` ({light, dark} or one hex), else the row's own for v, s and a. */
export function verbColor(key: string, theme: Theme, color?: unknown): string {
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) return color
  if (color && typeof color === 'object') {
    const c = (color as Record<string, unknown>)[theme]
    if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) return c
  }
  const own: Record<string, [string, string]> = { v: ['#4f46e5', '#9a93ff'], s: ['#b7791f', '#e0a43a'], a: ['#8a4fb5', '#c792ea'] }
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
}

/** A run as a Text: Claude Code's styles for bold, italic and inline code. */
function runText(els: Any, r: Run, dim = false) {
  const p: Any = { children: r.s }
  if (dim) p.dimColor = true
  if (r.b) p.bold = true
  if (r.it) p.italic = true
  if (r.code) p.color = 'permission'
  if (r.dim) p.dimColor = true
  return els.Text(p)
}

/** A mark's run as a press: the citation underlined in indigo, the gloss on its teal fill, the sparkline in place;
 *  the focused one inverse. */
function markEl(els: Any, o: MessageOpts, r: Run, key: string) {
  const m = o.rec.marks[r.mark as number]
  const c = markColors(o.theme)
  const on = o.focus === r.mark
  const p: Any = { children: r.s }
  if (r.b) p.bold = true
  if (m.kind === 'cite') {
    if (on) { p.backgroundColor = c.cite; p.color = c.paper } else { p.color = c.cite; p.underline = true }
  } else if (m.kind === 'gloss') {
    if (on) { p.backgroundColor = c.focusGloss; p.color = c.paper } else { p.color = c.gloss; p.backgroundColor = c.glossBg }
  } else {
    p.color = 'inactive'
    if (on) p.backgroundColor = 'selectionBg'
  }
  const label = m.kind === 'gloss' ? `explain ${r.s}` : m.kind === 'spark' ? `cite sparkline ${m.ref}` : `cite ${m.label}`
  // the first run of a mark has a key of its own, `mk-<row>-<i>`, so the keys can scroll it into view
  const seen = (o as MessageOpts & { seen?: Set<number> }).seen
  const own = seen && !seen.has(r.mark as number) ? `mk-${o.rec.row}-${r.mark}` : key
  seen?.add(r.mark as number)
  return els.Button({ key: own, plain: true, label, children: [els.Text(p)], onPress: () => o.onMark(r.mark as number) })
}

/** One laid-out line: its runs, each mark a press. */
function lineEl(els: Any, o: MessageOpts, runs: Run[], key: string, lead: Any[] = []) {
  const kids: Any[] = [...lead]
  runs.forEach((r, j) => kids.push(r.mark !== undefined ? markEl(els, o, r, `${key}-m${r.mark}-${j}`) : runText(els, r, !!o.dim)))
  if (!runs.some(r => r.mark !== undefined)) return els.Text({ key, wrap: 'truncate-end', children: kids })
  return els.Box({ key, flexDirection: 'row', children: kids.map(k => (typeof k === 'string' ? els.Text({ children: k }) : k)) })
}

/** The 2 columns left of a reply: Claude Code's ● on the reply's first row, else blank. */
function margin(els: Any, dot: boolean, lead?: string | null, theme: Theme = 'dark') {
  if (lead) return els.Box({ width: 2, flexShrink: 0, children: [els.Text({ color: verbColor('s', theme), children: lead })] })
  return els.Box({ width: 2, flexShrink: 0, children: [els.Text({ children: dot ? '●' : ' ' })] })
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

/** A table that holds marks, drawn as Claude Code draws a table: a box of light rules, its header bold. */
function tableLines(els: Any, o: MessageOpts, text: string, b: Any, key: string, w: number): Any[] {
  const rows: Run[][][] = tableOf(text, b, o.rec.marks)
  const n = Math.max(...rows.map(r => r.length))
  const widths = Array.from({ length: n }, (_, c) => Math.max(1, ...rows.map(r => width(runsText(r[c] || [])))))
  const total = widths.reduce((s, x) => s + x + 3, 1)
  if (total > w) {
    // too wide to draw whole: Claude Code's Markdown, with each mark as its words
    return [els.Markdown({ text: text.slice(b.start, b.end).replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1') })]
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
      runs.forEach((r, j) => kids.push(r.mark !== undefined ? markEl(els, o, r, `${key}-t${k}-${c}-${j}`) : runText(els, r)))
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
  const push = (content: Any[], gap: boolean) => {
    rows.push(Box({ key: `${o.key}-b${k++}`, flexDirection: 'row', marginTop: gap ? 1 : 0, children: [margin(els, dot, rows.length === 0 ? o.lead : null, o.theme), Box({ flexDirection: 'column', flexShrink: 1, width: w, children: content })] }))
    dot = false
  }
  let i = 0
  while (i < bs.length) {
    const b = bs[i]
    if (marksIn(o.rec.marks, b.start, b.end).length) {
      push(blockLines(els, o, text, b, `${o.key}-l${i}`, w), b.gap && i > 0)
      i++
      continue
    }
    // a run of blocks with no mark: Claude Code's own Markdown, whole
    let j = i
    while (j + 1 < bs.length && !marksIn(o.rec.marks, bs[j + 1].start, bs[j + 1].end).length) j++
    push([Markdown({ text: text.slice(b.start, bs[j].end), ...(o.dim ? { dimColor: true } : {}) })], b.gap && i > 0)
    i = j + 1
  }
  return Box({ flexDirection: 'column', marginTop: 1, children: rows })
}

// ------------------------------------------------------------------------------------------------ the verb row

export type RowVerb = { key: string; name: string; color?: unknown }
export type VerbRowOpts = {
  key: string
  verbs: RowVerb[]
  lit: Record<string, { lit?: boolean; note?: string }>
  open: string | null
  running: string | null
  selected: boolean
  theme: Theme
  onPress: (key: string) => unknown
  /** presses after the verbs, each after a dim ` · ` (the browser's `o browser`) */
  after?: Any[]
}

export function verbRowEl(els: Any, o: VerbRowOpts): Any {
  const { Box, Button, Text } = els
  const kids: Any[] = []
  if (o.selected) kids.push(Text({ color: verbColor('v', o.theme), children: '▸ ' }))
  o.verbs.forEach((v, i) => {
    if (i) kids.push(Text({ dimColor: true, children: ' · ' }))
    const lit = o.lit[v.key]
    const color = verbColor(v.key, o.theme, v.color)
    const isOpen = o.open === v.key
    const run = o.running === v.key
    let children: Any[]
    if (isOpen) children = [Text({ backgroundColor: color, color: markColors(o.theme).paper, bold: true, children: ` ${v.key} ` }), Text({ color, children: ` ${lit?.lit && lit.note ? '● ' + lit.note : v.name}${run ? '…' : ''}` })]
    else if (lit?.lit && lit.note) children = [Text({ color, bold: true, children: v.key }), Text({ color, children: ` ● ${lit.note}${run ? '…' : ''}` })]
    else children = [Text({ dimColor: true, bold: true, children: v.key }), Text({ dimColor: true, children: ` ${v.name}${run ? '…' : ''}` })]
    kids.push(Button({ key: `${o.key}-verb-${v.key}`, plain: true, label: v.name, children, onPress: () => o.onPress(v.key) }))
  })
  for (const a of o.after || []) kids.push(...(kids.length ? [Text({ dimColor: true, children: ' · ' })] : []), a)
  return Box({ flexDirection: 'row', marginLeft: 2, children: kids })
}

export type VerbLineOpts = {
  key: string
  verb: RowVerb
  options: { label: string; note?: string }[]
  note?: string
  theme: Theme
  onPick: (i: number) => unknown
  onClose: () => unknown
}

/** The line a verb opens under the row: its options, each a digit and a press, then the keys. */
export function verbLineEl(els: Any, o: VerbLineOpts): Any {
  const { Box, Button, Text } = els
  const color = verbColor(o.verb.key, o.theme, o.verb.color)
  const kids: Any[] = []
  o.options.slice(0, 9).forEach((opt, i) => {
    if (i) kids.push(Text({ children: '  ' }))
    kids.push(Button({
      key: `${o.key}-opt-${i}`, plain: true, label: opt.label,
      children: [Text({ backgroundColor: i === 0 ? color : undefined, color: i === 0 ? markColors(o.theme).paper : color, bold: i === 0, children: ` ▸ ${i + 1} ${opt.label} ` }), ...(opt.note ? [Text({ dimColor: true, children: ` ${opt.note}` })] : [])],
      onPress: () => o.onPick(i),
    }))
  })
  if (o.note) kids.push(Text({ dimColor: true, children: `  ${o.note}` }))
  const n = Math.min(9, o.options.length)
  kids.push(Text({ children: '    ' }), Text({ dimColor: true, children: n > 1 ? `1–${n} ` : '1 ' }), Text({ dimColor: true, children: 'pick · ' }))
  kids.push(Button({ key: `${o.key}-close`, plain: true, label: 'close', children: [Text({ dimColor: true, children: '0 close' })], onPress: o.onClose }))
  return Box({ flexDirection: 'row', flexWrap: 'wrap', marginLeft: 2, children: kids })
}

// ------------------------------------------------------------------------------------------------ the tray

export type TrayOpts = {
  key: string
  w: number
  body: number
  theme: Theme
  kind: 'cite' | 'gloss' | 'spark'
  title: string
  right: string
  grids: Any[] | null
  problem?: string | null
  links: { id: string; ref: string; label: string }[]
  depth: number
  onLink: (id: string) => unknown
  keys: string
}

/** The tray: one card in a frame of `body` rows, the title on the top border, the keys on the bottom one. */
export function trayEl(els: Any, o: TrayOpts): Any {
  const { Box, Text } = els
  const c = markColors(o.theme)
  const tone = o.kind === 'gloss' ? c.gloss : c.cite
  const inner = o.w - 4
  const cutTo = (s: string, n: number) => ([...s].length <= n ? s : [...s].slice(0, Math.max(0, n - 1)).join('') + '…')
  const title = cutTo(o.title, Math.max(8, inner - [...o.right].length - 8))
  const back = o.depth > 1 ? `‹ ${o.depth - 1}  ` : ''
  const fill = Math.max(1, o.w - 2 - 2 - [...back].length - width(title) - 1 - 1 - [...o.right].length - 2)
  const titleText = o.kind === 'gloss'
    ? Text({ color: c.gloss, backgroundColor: c.glossBg, bold: true, children: title })
    : Text({ color: c.cite, underline: o.kind === 'cite', bold: true, children: title })
  const top = Text({ wrap: 'truncate-end', children: [Text({ color: tone, children: '╭─ ' }), Text({ dimColor: true, children: back }), titleText, Text({ color: tone, children: ' ' + '─'.repeat(fill) + ' ' }), Text({ color: tone, children: o.right }), Text({ color: tone, children: ' ─╮' })] })
  const keysText = cutTo(o.keys, Math.max(4, o.w - 8))
  const bottom = Text({ wrap: 'truncate-end', children: [Text({ color: tone, children: '╰─ ' }), Text({ dimColor: true, children: keysText }), Text({ color: tone, children: ' ' + '─'.repeat(Math.max(1, o.w - 6 - width(keysText))) + '─╯' })] })
  const side = Text({ color: tone, children: '│ ' })
  const sideR = Text({ color: tone, children: ' │' })
  const rows: Any[] = []
  const blank = (k: string) => Box({ key: k, flexDirection: 'row', children: [side, Text({ children: ' '.repeat(inner) }), sideR] })
  if (!o.grids) {
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
