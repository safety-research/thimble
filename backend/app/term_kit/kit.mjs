// thimble's terminal view kit: what a view's view.term.js imports to draw the view in terminal mode, as view.html uses
// the view kit in the browser (docs/terminal-views.md). The program runs in a sandbox of its own (runtime.mjs,
// app/term_views.py): it reads no file and opens no socket, and what it knows arrives as events. It draws rows of
// styled text with hot regions in them, in thimble-term's look (mods/thimble-term/SPEC.md): one left edge with a
// 2-cell margin for `❯`, links blue and underlined, dim for what is secondary, a palette hue only on the marks of the
// one Color by field, the selection background on a choice in use.
//
//   import { draw, fetch, colorBy, timeRange, list } from 'thimble-term'
//
// The parts mirror the browser kit's: Color by with fields and labels and chips with counts, a label's definition a
// step away; a time range with an overview strip and a window; a list with a chosen row, details in place and the
// colored track beside it; a record's place one click away and asking about a row as a side thread.

// ------------------------------------------------------------------------------------------------ colors

/** Claude Code's theme keys thimble-term draws with (mods/thimble-term/hooks/paint.ts): each has one meaning. */
export const COLORS = Object.freeze({
  text: 'text',
  dim: 'inactive',
  rule: 'subtle',
  link: 'remember',
  accent: 'suggestion',
  fresh: 'success',
  problem: 'error',
  selected: 'selectionBg',
  tip: 'userMessageBackground',
  code: 'permission',
})

/** The palette for the values of the one Color by field: seven hues that keep 3:1 on light and dark panels. */
export const SERIES = Object.freeze(['#1d7fc0', '#b77300', '#00946a', '#b96895', '#8c65e8', '#927543', '#87861a'])

/** How many values of a field take a hue of their own (SPEC.md rule 20); the others share one chip, `other`. */
export const HUES = 6

// ------------------------------------------------------------------------------------------------ text

/** The cells a character takes: 2 for a wide one (CJK, emoji), 0 for a combining mark, else 1. */
export function charWidth(ch) {
  const c = ch.codePointAt(0) ?? 0
  if (c === 0 || (c >= 0x300 && c <= 0x36f) || c === 0x200b || c === 0x200c || c === 0x200d || c === 0xfe0f) return 0
  if (
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
  ) return 2
  return 1
}

/** The cells a string takes on the grid. */
export function width(s) {
  let n = 0
  for (const ch of String(s)) n += charWidth(ch)
  return n
}

/** The longest start of `s` that fits in `n` cells, with no `…`. */
export function prefix(s, n) {
  let out = ''
  let w = 0
  for (const ch of String(s)) {
    const k = charWidth(ch)
    if (w + k > n) break
    out += ch
    w += k
  }
  return out
}

const CUT_TAIL = /[\s,;:.!?\-–—·]+$/

/** `s` in at most `n` cells, cut at the last word that fits with `…` right against it (mid-word only when a word fills
 *  more than half the room), as thimble-term cuts every row. */
export function cut(s, n) {
  s = oneLine(s)
  if (width(s) <= n) return s
  if (n <= 1) return n === 1 ? '…' : ''
  const head = prefix(s, n - 1)
  const at = /\s/.test(s[head.length] ?? '') ? head.length : head.search(/\s\S*$/)
  const keep = at > 0 && width(head.slice(0, at)) * 2 > n ? head.slice(0, at) : head
  return `${keep.replace(CUT_TAIL, '') || keep.trimEnd()}…`
}

/** A line of code or data cut at the cell edge, so a file's rows end together. */
export function clip(s, n) {
  s = String(s).replace(/\t/g, '  ').replace(/[\r\n]+/g, ' ')
  if (width(s) <= n) return s
  return n <= 1 ? (n === 1 ? '…' : '') : `${prefix(s, n - 1)}…`
}

/** Whitespace runs as one space. */
export function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/** `s` padded with spaces to `n` cells (cut first when longer, and the cut padded, since it may end short of `n`). */
export function pad(s, n) {
  s = String(s)
  if (width(s) > n) s = cut(s, n)
  return s + ' '.repeat(Math.max(0, n - width(s)))
}

/** `s` right-aligned in `n` cells. */
export function padStart(s, n) {
  s = String(s)
  if (width(s) > n) s = cut(s, n)
  return ' '.repeat(Math.max(0, n - width(s))) + s
}

/** Words wrapped to rows of at most `w` cells, at most `max` rows, the last cut with `…` when more is left. */
export function wrap(text, w, max = Infinity) {
  const out = []
  for (const para of String(text ?? '').split(/\n/)) {
    let row = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = row ? `${row} ${word}` : word
      if (width(next) <= w) row = next
      else {
        if (row) out.push(row)
        row = width(word) > w ? prefix(word, w) : word
      }
    }
    out.push(row)
  }
  while (out.length > 1 && out.at(-1) === '') out.pop()
  if (out.length > max) {
    const kept = out.slice(0, max)
    kept[max - 1] = cut(`${kept[max - 1]} ${out[max]}`, w)
    if (!kept[max - 1].endsWith('…')) kept[max - 1] = cut(`${kept[max - 1]}……`, w)
    return kept
  }
  return out
}

/** A count with thousands separators from 1,000. */
export function num(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US')
}

/** `n word` or `n words`. */
export function plural(n, word, many = `${word}s`) {
  return `${num(n)} ${n === 1 ? word : many}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n) => String(n).padStart(2, '0')

/** A time in seconds since 1970, in UTC, as precise as `step` seconds need: `16 May 2026`, `16 May 04:31`,
 *  `16 May 04:31:07`. */
export function when(t, step = 60) {
  const d = new Date(t * 1000)
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  if (step >= 86400) return `${day} ${d.getUTCFullYear()}`
  const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
  return step >= 60 ? `${day} ${hm}` : `${day} ${hm}:${two(d.getUTCSeconds())}`
}

/** The time of day, `04:31:07`, in UTC. */
export function hms(t) {
  return new Date(t * 1000).toISOString().slice(11, 19)
}

/** The day a time falls on, `2026-05-16`, in UTC. */
export function dayOf(t) {
  return new Date(t * 1000).toISOString().slice(0, 10)
}

/** A day's heading, `Sat 16 May 2026`. */
export function dayName(t) {
  const d = new Date(t * 1000)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** A length of time in seconds, `45s`, `12m 5s`, `3h 20m`, `2d 4h`. */
export function dur(s) {
  s = Math.max(0, Math.round(s))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)}m` : ''}`
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600) ? ` ${Math.floor((s % 86400) / 3600)}h` : ''}`
}

// a place without its folders: `…/agents.log line 12`
function placeShort(ref) {
  const words = placeWords(ref)
  const path = String(ref ?? '').split('#', 1)[0]
  const file = path.split('/').at(-1) || path
  return file === path ? words : `…/${file}${words.slice(path.length)}`
}

/** A place in words in `n` cells: whole where it fits, else without its folders (`…/agents.log line 12`), else its
 *  file's name cut in the middle, the line or row it names kept (`…/monitor-2…0000.jsonl line 2`). */
export function placeIn(ref, n) {
  const words = placeWords(ref)
  if (width(words) <= n) return words
  if (width(placeShort(ref)) <= n) return placeShort(ref)
  const path = String(ref ?? '').split('#', 1)[0]
  const file = path.split('/').at(-1) || path
  const at = words.slice(path.length) // ` line 12`, ` row 4`, or nothing
  const lead = file === path ? '' : '…/'
  const room = n - width(lead) - width(at) - 1
  if (room < 4) return cut(words, n)
  const tail = Math.min(Math.floor(room / 2), 10)
  return `${lead}${prefix(file, room - tail)}…${[...file].slice(-tail).join('')}${at}`
}

/** A place as the analyst reads it: `agents.log line 12`, `deploys.csv row 4`, `inc-312.json message 3`. */
export function placeWords(ref) {
  const [path = '', frag = ''] = String(ref ?? '').split('#', 2)
  const file = path.split('/').at(-1) || path
  let m
  if ((m = /^L(\d+)(?:-L?(\d+))?$/.exec(frag))) return m[2] && m[2] !== m[1] ? `${path} lines ${m[1]}-${m[2]}` : `${path} line ${m[1]}`
  if ((m = /^row=(\d+)$/.exec(frag))) return `${path} row ${m[1]}`
  if ((m = /^\/messages\/(\d+)$/.exec(frag))) return `${path} message ${Number(m[1]) + 1}`
  if ((m = /^\/(\d+)$/.exec(frag))) return `${path} item ${Number(m[1]) + 1}`
  return frag ? `${path} ${frag}` : file
}

// ------------------------------------------------------------------------------------------------ styles

/** A run of text in one style: `fg` and `bg` a theme key or a palette hue, `b` bold, `d` dim, `i` italic, `u`
 *  underlined, `inv` inverse. */
export const seg = (s, style = {}) => ({ ...style, s: String(s) })
export const dim = (s) => ({ s: String(s), d: true })
export const bold = (s) => ({ s: String(s), b: true })
export const italic = (s) => ({ s: String(s), i: true })
export const link = (s) => ({ s: String(s), fg: COLORS.link, u: true })
export const accent = (s) => ({ s: String(s), fg: COLORS.accent })
export const problem = (s) => ({ s: String(s), fg: COLORS.problem })
export const chosen = (s) => ({ s: String(s), bg: COLORS.selected })
/** A mark in a value's hue: `●` by default; dim where the hue is none. */
export const mark = (colour, glyph = '●') => (colour && colour !== COLORS.dim ? { s: glyph, fg: colour } : { s: glyph, d: true })

const STYLE_KEYS = ['fg', 'bg', 'b', 'd', 'i', 'u', 'inv']

function segOf(x) {
  if (x == null || x === false) return null
  if (typeof x === 'string' || typeof x === 'number') return { s: String(x) }
  if (typeof x === 'object' && 's' in x) {
    const out = { s: String(x.s) }
    for (const k of STYLE_KEYS) if (x[k]) out[k] = x[k]
    return out
  }
  return { s: String(x) }
}

const sameStyle = (a, b) => STYLE_KEYS.every((k) => (a[k] || undefined) === (b[k] || undefined))

/** Neighboring runs of one style as one, empty runs left out. */
export function merged(line) {
  const out = []
  for (const s of line) {
    if (!s || !s.s) continue
    const prev = out.at(-1)
    if (prev && sameStyle(prev, s)) out[out.length - 1] = { ...prev, s: prev.s + s.s }
    else out.push(s)
  }
  return out
}

/** The cells of a line of runs. */
export function lineWidth(line) {
  return line.reduce((n, s) => n + width(s.s), 0)
}

/** A line in `n` cells, its runs kept: where words pass the edge, the last cell is `…` (thimble-term never cuts a row
 *  bare); where only spaces do, they are dropped. */
export function fitLine(line, n) {
  if (lineWidth(line) <= n) return line
  const all = line.map((x) => x.s).join('')
  if (!all.slice(prefix(all, n).length).trim()) return clipLine(line, n)
  const kept = clipLine(line, Math.max(0, n - 1))
  while (kept.length && !kept[kept.length - 1].s.trim()) kept.pop()
  if (kept.length) kept[kept.length - 1] = { ...kept[kept.length - 1], s: kept[kept.length - 1].s.replace(/\s+$/, '') }
  const last = kept[kept.length - 1] || {}
  return [...kept, { s: '…', ...(last.fg ? { fg: last.fg } : {}), ...(last.d ? { d: true } : {}), ...(last.bg ? { bg: last.bg } : {}) }]
}

/** A line cut to `n` cells, its runs kept. */
export function clipLine(line, n) {
  const out = []
  let w = 0
  for (const s of line) {
    const k = width(s.s)
    if (w + k <= n) {
      out.push(s)
      w += k
      continue
    }
    const part = prefix(s.s, n - w)
    if (part) out.push({ ...s, s: part })
    break
  }
  return out
}

// ------------------------------------------------------------------------------------------------ keys

// the keys a view's pane passes on (mods/thimble-term/SPEC.md rule 26): ↑↓, Enter, Space and Backspace through the
// list's relay, and a letter, a digit or a sign as the panel's hotkey. ←, →, the page keys, Home, End, Tab and Esc reach
// no element of a pane, so a view never binds them and never names them.
const NAMED = { up: '↑', down: '↓', return: 'Enter', space: 'Space', backspace: 'Backspace' }
const UNREACHABLE = new Set(['left', 'right', 'pageup', 'pagedown', 'home', 'end', 'tab', 'escape', 'esc', 'delete', 'insert', 'enter'])

// the panel's own keys: b back, t the threads, x close
const PANEL_KEYS = new Set(['b', 't', 'x'])

function checkKey(k) {
  if (k in NAMED) return k
  if (PANEL_KEYS.has(k)) throw new Error(`the key ${k} is the panel's own (b back, t the threads, x close): bind another`)
  if (k === 'enter') return 'return'
  if (UNREACHABLE.has(k)) throw new Error(`the key ${k} does not reach a view's pane: bind a letter, a digit or a sign`)
  if ([...k].length !== 1 || /\s/.test(k)) throw new Error(`a view binds ${JSON.stringify(k)}: a key is up, down, return, space, backspace or one character`)
  if (/[A-Z]/.test(k)) throw new Error(`a view binds ${k}: a letter key is lowercase (Shift does not reach the pane)`)
  return k
}

function keyWords(keys) {
  if (keys.includes('up') && keys.includes('down')) return ['↑↓', ...keys.filter((k) => k !== 'up' && k !== 'down').map((k) => NAMED[k] ?? k)].join(' ')
  return keys.map((k) => NAMED[k] ?? k).join(' ')
}

// the order of the hint row (rule 26): choosing, Enter, Space, the view's own keys
const keyOrder = (keys) => (keys.includes('up') || keys.includes('down') ? 0 : keys.includes('return') ? 1 : keys.includes('space') ? 2 : 3)

// ------------------------------------------------------------------------------------------------ the drawing

/** What a view's draw function draws into: rows of styled runs on a grid `cols` wide (the type area, A0 to R) and at
 *  most `rows` tall, each with a 2-cell margin left of it for `❯`, the hot regions a click reaches, the keys the
 *  view binds with the words its hint row says, and the facts of the panel's subtitle. */
export class Drawing {
  constructor(cols, rows, parent = null, indent = 0) {
    this.cols = Math.max(10, cols | 0)
    this.rows = Math.max(1, rows | 0)
    this.lines = []
    this.hits = []
    this.parent = parent
    this.indent = indent
    this.binds = parent ? parent.binds : []
    this.facts = parent ? parent.facts : []
    // the rows cut at the columns, in this drawing or one inside it: how many, and the first one's text (the frame's
    // `overflow`, which the view checks read)
    this.cutAt = parent ? parent.cutAt : { n: 0, first: '' }
    // what stands over the rows drawn under it (an open menu's frame): [{y, lines, hits}], the root drawing's
    this.overlays = parent ? parent.overlays : []
    this.typer = null
    this.focusY = null
  }

  /** The row the next line goes on. */
  get y() {
    return this.lines.length
  }

  /** How many rows are left. */
  get left() {
    return Math.max(0, this.rows - this.lines.length)
  }

  /** A line of runs (a string, a run or a list of them), with its hot regions `{x0, x1, on(x), tip, drag, row}` in
   *  cells from A0; `margin` the run in the 2-cell margin (`❯`). */
  line(content, hits = [], margin = null) {
    const runs = merged((Array.isArray(content) ? content : [content]).map(segOf).filter(Boolean))
    const y = this.lines.length
    if (lineWidth(runs) > this.cols) {
      this.cutAt.n += 1
      if (!this.cutAt.first) this.cutAt.first = runs.map((s) => s.s).join('').trimEnd()
    }
    this.lines.push({ margin: margin ? segOf(margin) : null, runs: fitLine(runs, this.cols) })
    for (const h of hits) if (h && (h.on || h.tip || h.drag)) this.hits.push({ ...h, y })
    return y
  }

  /** A row built run by run (Row): `d.row().add('a').gap().add('b', DIM).right('3').end()`. */
  row() {
    return new Row(this)
  }

  /** A blank row, but never two in a row and none at the top (SPEC.md rule 9). */
  blank() {
    const last = this.lines.at(-1)
    if (!last || (!last.runs.length && !last.margin)) return
    this.lines.push({ margin: null, runs: [] })
  }

  /** A rule across the type area in the rule gray: a panel's regions only (two at most, with the panel's own). */
  rule() {
    this.line({ s: '─'.repeat(this.cols), fg: COLORS.rule })
  }

  /** Bind keys (`up`, `down`, `return`, `space`, `backspace` or one character each) to `run(key)`, with the words the
   *  hint row says after them (`to choose`); `strong` keeps them from a later binding of the same key (an open menu's
   *  ↑↓); `rank` orders the view's own keys in the hint row (Color by's is 0, others 1), which the panel cuts from its
   *  end when it is too long. Bound for this frame only: a part binds its keys as it draws, so the hints name what is
   *  drawn. */
  key(keys, words, run, strong = false, rank = 1) {
    const ks = (Array.isArray(keys) ? keys : [keys]).map(checkKey)
    const taken = new Set(this.binds.filter((b) => b.strong).flatMap((b) => b.keys))
    const mine = ks.filter((k) => !taken.has(k))
    if (!mine.length) return
    for (const b of this.binds) b.keys = b.keys.filter((k) => !mine.includes(k))
    this.binds.push({ keys: mine, words: words ? String(words) : '', run, strong, rank })
  }

  /** Facts for the panel's subtitle under the view's name, dim, parted by ` · `. */
  sub(...facts) {
    for (const f of facts.flat()) if (f !== null && f !== undefined && f !== '') this.facts.push(String(f))
  }

  /** While a part takes typing (a search field): the panel's field holds `text` and sends each change of it whole to
   *  `onText(text)`, as the analyst edits it there; Enter goes to `onKey('return')`, and a key sent one at a time (a
   *  character, Space, Backspace) to `onKey` too. */
  typing(o = {}) {
    let root = this
    while (root.parent) root = root.parent
    root.typer = { onKey: o.onKey || (() => {}), onText: o.onText || null, text: String(o.text ?? ''), hints: o.hints || ['Enter to finish'] }
  }

  /** Keep the next row drawn in view: in a row's details, the record a citation opened, which a list shows however far
   *  down its details it is. */
  focus() {
    this.focusY = this.lines.length
  }

  /** A drawing `cols` wide whose lines stand `indent` cells in from this one's edge (a row's details at A2), to be
   *  put in with `put`. */
  inner(indent = 2, rows = this.left) {
    return new Drawing(this.cols - indent, rows, this, indent)
  }

  /** The lines of an inner drawing, in at this one's row. */
  put(inner, from = 0, to = inner.lines.length) {
    const y0 = this.lines.length
    if (inner.focusY !== null && inner.focusY >= from && inner.focusY < to) this.focusY = inner.focusY - from + y0
    for (const l of inner.lines.slice(from, to)) this.lines.push({ margin: l.margin, runs: clipLine([{ s: ' '.repeat(inner.indent) }, ...l.runs], this.cols) })
    for (const h of inner.hits) if (h.y >= from && h.y < to) this.hits.push({ ...h, y: h.y - from + y0, x0: h.x0 + inner.indent, x1: h.x1 + inner.indent })
  }
}

/** One row of a Drawing, built left to right. */
export class Row {
  constructor(d) {
    this.d = d
    this.runs = []
    this.hits = []
    this.x = 0
    this.marginRun = null
    this.menus = []
  }

  /** Text in a style, cut to `max` cells; `opts.on(x)` makes it a control (inverse under the pointer), `opts.tip`
   *  words the pointer shows under it, `opts.row` a hit as wide as the row. `opts.cursor` marks a chart's cells: under
   *  the pointer only its cell is marked, never inverse (thimble-term draws `┊` there, or the bar in the text color),
   *  with `opts.tips[i]` the words for cell i where they differ from `tip`. */
  add(text, style = {}, opts = {}) {
    let s = String(text ?? '')
    if (opts.max !== undefined) s = cut(s, opts.max)
    if (!s) return this
    const w = width(s)
    this.runs.push({ ...style, s })
    if (opts.on || opts.tip || opts.drag) this.hits.push({ x0: this.x, x1: this.x + w, on: opts.on, tip: opts.tip, drag: opts.drag, row: opts.row, cursor: opts.cursor, tips: opts.tips })
    this.x += w
    return this
  }

  /** Runs as they are (a string, a run or a list). */
  runsOf(list) {
    for (const r of (Array.isArray(list) ? list : [list]).map(segOf).filter(Boolean)) this.add(r.s, r)
    return this
  }

  /** `n` cells of space: 1 a word space, 2 a gutter (SPEC.md section 2, rule 3). */
  gap(n = 2) {
    if (n > 0) this.add(' '.repeat(n))
    return this
  }

  /** Space up to column `col` (from A0), or one word space when the row is there already. */
  at(col) {
    return this.gap(this.x < col ? col - this.x : this.x > 0 ? 1 : 0)
  }

  /** Text that ends on R, the type area's last cell, after at least a gutter; left out when it does not fit. */
  right(text, style = {}, opts = {}) {
    const s = String(text ?? '')
    const room = this.d.cols - this.x - 2
    if (!s || room < 1) return this
    const fit = cut(s, room)
    this.at(this.d.cols - width(fit))
    return this.add(fit, style, opts)
  }

  /** The cells left on the row. */
  get room() {
    return Math.max(0, this.d.cols - this.x)
  }

  /** The mark in the margin: `❯` on the chosen row. */
  margin(run) {
    this.marginRun = run
    return this
  }

  /** Draw the row, and under it a menu one of its controls opened. */
  end() {
    const y = this.d.line(this.runs, this.hits, this.marginRun)
    for (const m of this.menus) m(this.d)
    return y
  }
}

// ------------------------------------------------------------------------------------------------ the program's life

const state = {
  out: null, // where the runtime writes a message
  cols: 120,
  rows: 30,
  theme: 'dark',
  view: { slug: '', name: '' },
  kept: {},
  labels: [],
  filter: null,
  drawFn: null,
  frameSeq: 0,
  ack: 0,
  gesture: null, // the event being handled for the analyst's own click or key, while it runs
  binds: [],
  hits: new Map(), // frame seq -> the hits of that frame (the last few)
  typer: null,
  pending: new Map(),
  fetchId: 0,
  scheduled: false,
  lastSent: '',
  openers: [],
  labelFns: [],
  resets: [],
  pageReset: null,
  stateTimer: false,
  wheelFns: [],
  error: null,
  textMode: '',
  colorBys: [],
  colour: null, // the view's Color by, whose hues a time range and a strip take by default
  lastOpen: null,
  drawNo: 0, // the drawings made, so a count made while drawing (Color by's tally) knows a new one began
  answered: 0, // the reader's answers the program has had
  labelWants: [], // each part's labels a query names, so the reader reads them though they are not on in Files
  holds: [], // each part's labels that take no color when turned on (Rows' label: the lanes keep Color by's choice)
  rehome: [], // Color by's look again at how it opens, once a part holds a label it may have opened on
}

function send(msg) {
  if (state.out) state.out(msg)
}

/** The size of the view's area: `{cols, rows}`. */
export function size() {
  return { cols: state.cols, rows: state.rows }
}

/** The view this program draws: `{slug, name}`. */
export function view() {
  return { ...state.view }
}

/** `dark` or `light`. The colors are theme keys and hues that keep 3:1 on both, so a view rarely needs it. */
export function theme() {
  return state.theme
}

/** The function that draws the view: `fn(d)` with a Drawing, called after every event and answer. */
export function draw(fn) {
  state.drawFn = fn
  redraw()
}

/** Draw again soon (once, however often it is asked). */
export function redraw() {
  if (state.scheduled) return
  state.scheduled = true
  queueMicrotask(flush)
}

function flush() {
  state.scheduled = false
  // nothing is drawn before the program registered its draw function (or failed)
  if (!state.drawFn && !state.error) return
  const f = frame()
  // the same frame again is not sent, unless it answers an event thimble waits on (its `ack`)
  const text = JSON.stringify({ ...f, seq: 0 })
  if (text === state.lastSent) return
  state.lastSent = text
  send({ t: 'frame', ...f })
}

/** The frame of the view as drawn now (what goes to thimble-term). */
export function frame() {
  const d = new Drawing(state.cols, state.rows)
  state.drawNo++
  let error = state.error
  if (!error && state.drawFn) {
    try {
      state.drawFn(d)
    } catch (e) {
      error = describe(e)
    }
  }
  if (error) return errorFrame(error)
  overlay(d)
  const seq = ++state.frameSeq
  state.binds = d.binds.filter((b) => b.keys.length)
  state.typer = d.typer
  const lines = d.lines.slice(0, state.rows)
  const hits = d.hits.filter((h) => h.y < lines.length && h.x1 > h.x0)
  for (const h of hits) if (h.cursor === undefined && !h.row && chartCells(lines[h.y], h.x0, h.x1)) h.cursor = true
  state.hits.set(seq, hits)
  for (const k of [...state.hits.keys()]) if (k < seq - 4) state.hits.delete(k)
  const keys = [...new Set(state.binds.flatMap((b) => b.keys))]
  const shownBinds = d.typer ? [] : [...state.binds].sort((a, b) => keyOrder(a.keys) - keyOrder(b.keys) || a.rank - b.rank).filter((b) => b.words)
  const hints = d.typer ? d.typer.hints.slice() : shownBinds.map((b) => `${keyWords(b.keys)} ${b.words}`)
  const out = {
    seq,
    ack: state.ack,
    lines: lines.map(wireLine),
    hits: hits.map((h) => ({ y: h.y, x0: h.x0 + 2, x1: Math.min(h.x1, state.cols) + 2, ...(h.row ? { row: true } : {}), ...(h.tip ? { tip: String(h.tip) } : {}), ...(h.drag ? { drag: true } : {}), ...(h.cursor ? { cursor: true } : {}), ...(h.cursor && Array.isArray(h.tips) ? { tips: h.tips.slice(0, h.x1 - h.x0).map((t) => (t ? String(t).slice(0, 160) : '')) } : {}) })),
    hints,
    // each hint's keys, so the panel names a sign's key only while its relay holds the ring (a Button's hotkey is a
    // letter or a digit; a sign reaches the view through the relay's field alone)
    hintKeys: d.typer ? d.typer.hints.map(() => []) : shownBinds.map((b) => b.keys.slice()),
    keys,
    typing: Boolean(d.typer),
    // the text of the field that takes typing, which the panel's field holds while it does
    field: d.typer ? { text: d.typer.text } : null,
    sub: [...new Set(d.facts)],
  }
  // a reader query out long enough to say so, or the first one out before any came back: the panel says `◌ loading…`
  if (loading()) out.loading = true
  // what the panel cuts: rows past its height, and rows wider than its columns (with the first one's text)
  const past = d.lines.length - lines.length
  if (past > 0 || d.cutAt.n) out.overflow = { rows: past, cols: d.cutAt.n, first: d.cutAt.first.slice(0, 300) }
  if (state.textMode) out.text = frameText(out, { ansi: state.textMode === 'ansi', cols: state.cols })
  return out
}

// an open menu's frame over the rows under its control, which keep their places (the chart does not move down)
function overlay(d) {
  for (const o of d.overlays) {
    const y1 = o.y + o.lines.length
    while (d.lines.length < y1) d.lines.push({ margin: null, runs: [] })
    o.lines.forEach((l, k) => {
      d.lines[o.y + k] = l
    })
    d.hits = d.hits.filter((h) => h.y < o.y || h.y >= y1)
    d.hits.push(...o.hits)
  }
}

// the glyphs of a chart's cells: a strip's bars, a lane's lines and marks, a break, a range's edges
const CHART = new Set([...' ▁▂▃▄▅▆▇█▏▎▍▌▋▊▉─│┊×◆/[]|·'])

// whether the cells [x0, x1) of a line are a chart's alone (at least four of them), whose hit is marked by its cell under
// the pointer rather than drawn inverse, which would turn the chart into a band
function chartCells(line, x0, x1) {
  if (!line || x1 - x0 < 4) return false
  const text = line.runs.map((r) => r.s).join('')
  const part = [...text].slice(x0, x1)
  return part.length > 0 && part.every((ch) => CHART.has(ch)) && part.some((ch) => ch !== ' ')
}

function wireLine(l) {
  const margin = l.margin ? [{ ...l.margin, s: pad(l.margin.s, 2) }] : [{ s: '  ' }]
  return merged([...margin, ...l.runs])
}

function describe(e) {
  const msg = e && e.message ? e.message : String(e)
  const at = /view\.term\.js:(\d+)/.exec(String(e && e.stack))
  return `${e && e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${msg}${at ? ` (view.term.js line ${at[1]})` : ''}`
}

function errorFrame(why) {
  const seq = ++state.frameSeq
  state.binds = []
  state.typer = null
  // in red, at most three rows: the error and where in view.term.js it came from
  const rows = wrap(`the view could not be drawn: ${why}`, state.cols - 2, Math.min(3, state.rows))
  const lines = rows.map((r, i) => merged([{ s: '  ' }, { s: i ? '  ' : '× ', fg: COLORS.problem }, { s: r, fg: COLORS.problem }]))
  const out = { seq, ack: state.ack, lines, hits: [], hints: [], hintKeys: [], keys: [], typing: false, field: null, sub: [], error: why }
  if (state.textMode) out.text = frameText(out, { ansi: state.textMode === 'ansi', cols: state.cols })
  return out
}

function gesture(n, fn) {
  state.gesture = n
  try {
    fn()
  } catch (e) {
    state.error = describe(e)
    send({ t: 'error', message: state.error })
  } finally {
    state.gesture = null
  }
}

function act(kind, args) {
  if (state.gesture === null) throw new Error(`${kind}() works only during the analyst's own click or key in the view`)
  send({ t: 'act', n: state.gesture, act: { kind, ...args } })
}

/** Open a record's place in thimble-term (`↗`): its lines in the citation panel. Only during the analyst's click or
 *  key. */
export function open(ref) {
  act('open', { ref: String(ref) })
}

/** Ask a side thread about a record or a row (`ref` its place, `text` its words), as the browser's ⌘-click does. Only
 *  during the analyst's click or key. */
export function ask(ref, text = '') {
  act('ask', { ref: String(ref), text: oneLine(text).slice(0, 400) })
}

/** Open a label's panel: its definition, its run, its records. Only during the analyst's click or key. */
export function openLabel(id) {
  const l = state.labels.find((x) => x.id === id)
  act('label', { id: String(id), name: l ? l.name : '' })
}

/** The answer of the view's reader.records(index, query), as a promise. `opts.key`: a newer fetch with the same key
 *  drops this one, which rejects with an AbortError (its reader call is cancelled). */
export function fetch(query, opts = {}) {
  return new Promise((resolve, reject) => {
    const id = ++state.fetchId
    const key = opts.key == null ? null : String(opts.key)
    if (key !== null) for (const [k, p] of state.pending) if (p.key === key) drop(k)
    // the kit's own queries ({$thimble: ...}) thimble answers itself; a reader query out a while is the view loading
    const kit = Boolean(query && typeof query === 'object' && '$thimble' in query)
    state.pending.set(id, { resolve, reject, key, kit, at: Date.now() })
    send({ t: 'query', id, q: query === undefined ? null : query, labels: wantedLabels() })
    if (!kit) setTimeout(redraw, LOADING_MS + 5)
  })
}

// ms a reader query is out before the view says it loads, so a quick one draws no flicker
const LOADING_MS = 150

/** Whether the view is loading: a reader query has been out LOADING_MS or more, or the first is out before any came
 *  back. The panel says `◌ loading…` then; a view may draw it too, such as in place of an empty list. */
export function loading() {
  const now = Date.now()
  for (const p of state.pending.values()) if (!p.kit && (!state.answered || now - p.at >= LOADING_MS)) return true
  return false
}

// the labels the program's parts read, which each query names (Color by's, Filter by's, Rows')
function wantedLabels() {
  const out = new Set()
  for (const f of state.labelWants) for (const id of f() || []) out.add(String(id))
  return [...out]
}

function drop(id) {
  const p = state.pending.get(id)
  if (!p) return
  state.pending.delete(id)
  send({ t: 'cancel', id })
  const e = new Error('the fetch was dropped')
  e.name = 'AbortError'
  p.reject(e)
}

/** `fn(place)` for each place a citation opens the view at (`{ref, target, key, label, excerpt}`, what the reader's
 *  resolve() answered), at once with the one the view opened at. */
export function onOpen(fn) {
  state.openers.push(fn)
  if (state.lastOpen) Promise.resolve().then(() => fn(state.lastOpen))
}

/** `fn({labels, filter})` when the workspace's labels or the label filter change (a label ran, a value changed). */
export function onLabels(fn) {
  state.labelFns.push(fn)
}

/** Every label over files: `[{id, name, kind, text, spec, scope, values: [{name, meaning, n}], here}]`, `here` for
 *  the labels that mark the view's files. */
export function labels() {
  return state.labels.slice()
}

/** Reset in the Color by row: `changed()` whether the view differs from how it opens; `reset()` puts it back, after
 *  the kit put back its own parts (chips, the time range, the search, a choice). */
export function onReset(opts) {
  state.pageReset = opts
}

/** Whether anything the kit or the page keeps differs from how the view opens. */
export function changed() {
  return state.resets.some((r) => r.changed()) || Boolean(state.pageReset && state.pageReset.changed && state.pageReset.changed())
}

/** Put the view back as it opens. */
export function reset() {
  for (const r of state.resets) r.reset()
  if (state.pageReset && state.pageReset.reset) state.pageReset.reset()
  else for (const r of state.resets) r.after && r.after()
  redraw()
}

/** A value kept for this view across openings (the Color by choice, the time range), by key. */
export function kept(key) {
  return state.kept[key]
}

/** Keep a value for this view (thimble keeps it per view, as the browser keeps Color by's choice). */
export function keep(key, value) {
  if (value === undefined) delete state.kept[key]
  else state.kept[key] = value
  if (state.stateTimer) return
  state.stateTimer = true
  queueMicrotask(() => {
    state.stateTimer = false
    send({ t: 'state', state: state.kept })
  })
}

/** `fn(by)` for the wheel over the view (rows, positive down); the list moves its rows with it. */
export function onWheel(fn) {
  state.wheelFns.push(fn)
}

// ------------------------------------------------------------------------------------------------ events

/** The runtime's half: a message from thimble (init, resize, key, click, drag, wheel, answer, labels, open). */
export function handle(msg) {
  if (typeof msg.n === 'number' && msg.n > state.ack) state.ack = msg.n
  switch (msg.t) {
    case 'init':
      state.cols = msg.cols || state.cols
      state.rows = msg.rows || state.rows
      state.theme = msg.theme === 'light' ? 'light' : 'dark'
      state.view = msg.view || state.view
      state.kept = msg.state && typeof msg.state === 'object' ? { ...msg.state } : {}
      state.labels = Array.isArray(msg.labels) ? msg.labels : []
      state.filter = msg.filter || null
      state.textMode = msg.text || ''
      if (msg.open) state.lastOpen = msg.open
      break
    case 'resize':
      state.cols = msg.cols || state.cols
      state.rows = msg.rows || state.rows
      break
    case 'key':
      gesture(msg.n, () => pressKey(String(msg.key)))
      break
    case 'click':
    case 'drag': {
      const h = (state.hits.get(msg.seq) || state.hits.get(state.frameSeq) || [])[msg.i]
      if (!h) break
      gesture(msg.n, () => {
        if (msg.t === 'drag' && h.drag) h.drag(Number(msg.x0) || 0, Number(msg.x1) || 0)
        else if (h.on) h.on(Math.max(0, (Number(msg.x) || 0)))
      })
      break
    }
    case 'text':
      // the panel's field changed: its whole text, as the analyst edited it
      if (state.typer && state.typer.onText) gesture(msg.n, () => state.typer.onText(String(msg.value ?? '').slice(0, 2000)))
      break
    case 'wheel':
      for (const fn of state.wheelFns) fn(Number(msg.by) || 0)
      break
    case 'answer': {
      const p = state.pending.get(msg.id)
      if (!p) break
      state.pending.delete(msg.id)
      if (!p.kit) state.answered += 1
      if (msg.error) {
        const e = new Error(String(msg.error))
        e.name = 'ReaderError'
        p.reject(e)
      } else p.resolve(msg.data)
      break
    }
    case 'labels':
      state.labels = Array.isArray(msg.labels) ? msg.labels : state.labels
      state.filter = msg.filter || null
      // a label ran or changed: its values on the records are read again
      marks.got.clear()
      marks.asked.clear()
      for (const cb of state.colorBys) cb()
      for (const fn of state.labelFns) fn({ labels: state.labels.slice(), filter: state.filter })
      break
    case 'open':
      state.lastOpen = msg.place
      for (const fn of state.openers) fn(msg.place)
      break
  }
  redraw()
}

function pressKey(k) {
  if (state.typer && (k.length === 1 || k === 'space' || k === 'backspace' || k === 'return')) {
    state.typer.onKey(k === 'space' ? ' ' : k)
    return
  }
  const b = state.binds.find((x) => x.keys.includes(k))
  if (b) b.run(k)
}

/** For the runtime and the tests: where messages go, and the kit's state set back. */
export const __driver = {
  connect(out) {
    state.out = out
  },
  reset() {
    Object.assign(state, {
      out: null, cols: 120, rows: 30, theme: 'dark', view: { slug: '', name: '' }, kept: {}, labels: [], filter: null, drawFn: null,
      frameSeq: 0, ack: 0, gesture: null, binds: [], hits: new Map(), typer: null, pending: new Map(), fetchId: 0, scheduled: false,
      lastSent: '', openers: [], labelFns: [], resets: [], pageReset: null, stateTimer: false, wheelFns: [], error: null, textMode: '',
      lastOpen: null, colorBys: [], colour: null, drawNo: 0, answered: 0, labelWants: [], holds: [], rehome: [],
    })
    openMenu = null
    openBlocks.clear()
    marks.got.clear()
    marks.asked.clear()
    marks.batch.clear()
  },
  fail(why) {
    state.error = String(why)
    redraw()
  },
  get state() {
    return state
  },
}

// ------------------------------------------------------------------------------------------------ menus

// a menu a control opened, drawn under the control's row; one at a time
let openMenu = null

function menuOf(owner) {
  return openMenu && openMenu.owner === owner ? openMenu : null
}

function toggleMenu(owner, pick = 0) {
  openMenu = menuOf(owner) ? null : { owner, pick }
  redraw()
}

/** A menu under its control, in a frame over the rows below it (they keep their places): `❯` and the accent on the
 *  chosen item, ↑↓ choose, Enter picks, `close` (the key that opened it) closes it. An item is `{name, chips, right,
 *  about, indent}`: `chips` its values after its name, `right` dim against the frame's right side, and under the chosen
 *  item its `about(w)` lines. Where the frame is narrow, an item's values and its about lines stand under its name, the
 *  values for the chosen item alone. A menu taller than the rows left shows the part around the chosen item, with `↑ N
 *  more` and `↓ N more` in the frame. */
function drawMenu(d, owner, items, onPick, closeKey, pickWords, title = '', space = null) {
  const m = menuOf(owner)
  if (!m) return
  m.pick = Math.max(0, Math.min(items.length - 1, m.pick))
  // the root drawing frames the menu over the rows under its control; an inner one (a row's details) draws it in place
  const boxed = !d.parent && d.cols >= 24
  const box = boxed ? new Drawing(d.cols - 6, 100000, d, 0) : d
  const nameW = Math.min(28, Math.max(8, ...items.map((it) => width(it.name) + 2 * (it.indent || 0) + (it.mark ? width(it.mark.s) + 1 : 0)))) + 2
  // too narrow for an item's values and its about lines beside its name: they stand under it, at A2
  const stack = box.cols - nameW < 34
  const spans = []
  items.forEach((it, i) => {
    const y0 = box.y
    if (it.heading) {
      box.line([{ s: it.name, d: true }])
      spans.push([y0, box.y - 1])
      return
    }
    const sel = i === m.pick
    const r = box.row()
    if (sel) r.margin({ s: '❯', fg: COLORS.accent })
    if (it.indent) r.gap(2 * it.indent)
    // a mark before the name: `●` for a choice in use, `○` for one that is not, in a list that takes several
    if (it.mark) r.add(it.mark.s, it.mark).gap(1)
    const markW = it.mark ? width(it.mark.s) + 1 : 0
    const rightW = it.right ? width(it.right) + 2 : 0
    // in a narrow frame the other items' values still follow their names where 10 cells are left for them
    const beside = !stack || (!sel && box.cols - nameW - rightW >= 10)
    const nameRoom = beside ? Math.max(1, nameW - 2 * (it.indent || 0) - markW) : Math.max(4, box.cols - rightW - 2 * (it.indent || 0) - markW)
    r.add(beside ? pad(it.name, nameRoom) : cut(it.name, nameRoom), sel ? { fg: COLORS.accent } : {}, { on: () => { m.pick = i; pick(i) }, row: true })
    if (it.chips && beside) r.runsOf(fitLine(it.chips, Math.max(0, r.room - rightW)))
    if (it.right) r.right(it.right, { d: true })
    r.end()
    const indent = stack ? 2 : nameW
    if (sel && stack && it.chips && lineWidth(it.chips)) box.line([{ s: '  ' }, ...fitLine(it.chips, box.cols - 2)])
    if (sel && it.about) {
      for (const l of it.about(box.cols - indent)) {
        box.line([{ s: ' '.repeat(indent) }, ...(Array.isArray(l) ? l : [l]).map(segOf)], (l.hits || []).map((h) => ({ ...h, x0: h.x0 + indent, x1: h.x1 + indent })))
      }
    }
    spans.push([y0, box.y - 1])
  })
  if (boxed) frameMenu(d, box, spans[m.pick] || [0, 0], title)
  const step = (by) => {
    let i = m.pick
    do i += by
    while (items[i] && items[i].heading)
    if (items[i]) m.pick = i
  }
  const pick = (i) => {
    openMenu = null
    onPick(items[i], i)
  }
  d.key(['up', 'down'], 'to choose', (k) => step(k === 'up' ? -1 : 1), true)
  // `space` {words, on(item, i)}: Space acts on the item and the menu stays open
  if (space) d.key('space', space.words, () => {
    if (items[m.pick] && !items[m.pick].heading) space.on(items[m.pick], m.pick)
    redraw()
  }, true)
  d.key('return', pickWords, () => pick(m.pick), true)
  if (closeKey) d.key(closeKey, 'to close', () => toggleMenu(owner), true, 0)
}

// a menu's rows in a frame in the rule gray, `title` in its top edge, over the rows under the control; the rows
// around the chosen item where the menu is taller than the rows left
function frameMenu(d, box, [a, b], title) {
  const total = box.lines.length
  const room = Math.max(1, d.rows - d.y - 2)
  let from = 0
  if (total > room) {
    from = Math.max(0, Math.min(a, total - room))
    if (b >= from + room) from = Math.min(total - room, b - room + 1)
  }
  const to = Math.min(total, from + room)
  const rule = { fg: COLORS.rule }
  const edge = (left, right, words, note) => {
    const head = words ? `${left}─ ` : left
    const tail = note ? ` ${note} ─${right}` : right
    const fill = Math.max(0, d.cols - width(head) - width(words) - (words ? 1 : 0) - width(tail))
    return { margin: null, runs: merged([{ s: head, ...rule }, ...(words ? [{ s: words, d: true }, { s: ' ', ...rule }] : []), { s: '─'.repeat(fill), ...rule }, { s: tail, ...rule }]) }
  }
  const lines = [edge('╭', '╮', title, from ? `↑ ${num(from)} more` : '')]
  for (let y = from; y < to; y++) {
    const l = box.lines[y]
    const runs = fitLine(l.runs, box.cols)
    const mk = l.margin ? [{ ...l.margin, s: pad(l.margin.s, 2) }] : [{ s: '  ' }]
    lines.push({ margin: null, runs: merged([{ s: '│ ', ...rule }, ...mk, ...runs, { s: ' '.repeat(Math.max(0, box.cols - lineWidth(runs))) }, { s: ' │', ...rule }]) })
  }
  lines.push(edge('╰', '╯', '', to < total ? `↓ ${num(total - to)} more` : ''))
  const hits = box.hits.filter((h) => h.y >= from && h.y < to).map((h) => ({ ...h, y: d.y + 1 + h.y - from, x0: h.x0 + 4, x1: Math.min(h.x1, box.cols) + 4, row: false }))
  d.overlays.push({ y: d.y, lines, hits })
}

// ------------------------------------------------------------------------------------------------ Color by

/**
 * Color by: the one control for the view's color, in its top row (docs/terminal-views.md, "Color by"). It lists Off,
 * the view's fields and every label over files; the chosen field's or label's values are chips with their counts, which
 * a click turns off and on; a label's definition is one step away (its name's `↗` opens the label's panel, and the menu
 * shows it under the label's row). As in the browser, the view opens colored by a label that is on in Files and marks
 * its files, and a label turned on while the view is away or open takes the color.
 *
 * opts: fields [{name, title, description?, values?, meanings?, value?(record)}], initial (a field's name), chips
 * ('filter' hides the records of a value turned off, 'highlight' dims them; the page does either, from isOn), onChange.
 */
export function colorBy(opts = {}) {
  const fields = (opts.fields || []).map((f) => ({ ...f, title: f.title || f.name }))
  const keptBy = kept('colour')
  const startKey = fields.length ? `field:${opts.initial || fields[0].name}` : 'off'
  const fieldOf = (key) => fields.find((f) => `field:${f.name}` === key)
  const labelOf = (key) => state.labels.find((l) => `label:${l.id}` === key)
  // the labels on in Files (or filtering) that mark the view's files
  const onIds = () => state.labels.filter((l) => l.on && l.here !== false).map((l) => String(l.id))
  // the labels another part holds (the one Rows groups the lanes by), which take no color
  const held = () => new Set(state.holds.flatMap((f) => f() || []).map(String))
  // how the view opens: colored by a label that is on and no part holds, as the browser's view opens, else by its first
  // field
  const home = () => {
    const h = held()
    const on = onIds().filter((id) => !h.has(id))
    return on.length ? `label:${on[0]}` : startKey
  }
  const c = {
    // the choices in order, as the browser's Color by keeps them: the first is the color, each other a track beside
    // the list's; none is Off. `choice` is the first ('off' for none), and setting it makes it the one choice
    picks: keptBy && Array.isArray(keptBy.picks) ? keptBy.picks.map(String) : keptBy && typeof keptBy.by === 'string' ? (keptBy.by === 'off' ? [] : [keptBy.by]) : [home()].filter((k) => k !== 'off'),
    get choice() {
      return this.picks[0] || 'off'
    },
    set choice(key) {
      this.picks = key === 'off' ? [] : [key]
    },
    off: new Set(keptBy && Array.isArray(keptBy.off) ? keptBy.off.map((v) => (v === null ? '' : String(v))) : []),
    // the labels on when the view last looked: one turned on since takes the color
    seen: keptBy && Array.isArray(keptBy.seen) ? keptBy.seen.map(String) : onIds(),
    counts: null,
    hues: new Map(), // field -> value -> hue
    // the values the records the list draws take, for each field: the menu's words for a field that declares none
    tally: new Map(),
    tallied: new Map(),
    tallyAt: -1,
    tallySeen: new Set(),
  }
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {}
  // a label turned on since the view last looked takes the color, the one turned on last
  const notice = () => {
    const on = onIds()
    const h = held()
    const fresh = on.filter((id) => !c.seen.includes(id) && !h.has(id))
    c.seen = on
    const key = fresh.length ? `label:${fresh[fresh.length - 1]}` : null
    if (!key || key === c.choice) return false
    // the label takes the first place, the color; a field it takes it from gives way, a label there keeps its track
    const rest = c.picks.filter((k) => k !== key)
    c.picks = [key, ...(rest[0] && rest[0].startsWith('field:') ? rest.slice(1) : rest)]
    c.off.clear()
    c.counts = null
    return true
  }
  // a label the workspace no longer has, or a field the view dropped, leaves the choices; with none left that the
  // analyst chose, the view gives way to how it opens
  const settle = () => {
    const had = c.picks.length
    const first = c.choice
    c.picks = c.picks.filter((k, i, all) => (fieldOf(k) || labelOf(k)) && all.indexOf(k) === i)
    if (had && !c.picks.length) c.choice = home()
    if (c.choice !== first) c.off.clear()
  }
  const save = () => keep('colour', { by: c.choice, picks: c.picks, off: [...c.off].map((v) => (v === '' ? null : v)), seen: c.seen })
  if (keptBy) notice()
  settle()
  state.colorBys.push(() => {
    const moved = notice()
    settle()
    save()
    if (moved) onChange(api)
  })
  state.labelWants.push(() => c.picks.map(labelOf).filter(Boolean).map((l) => l.id))
  // a part that holds a label now: a view that opened colored by it, and was never given a color, opens again
  state.rehome.push(() => {
    const l = labelOf(c.choice)
    if (kept('colour') || !l || !held().has(String(l.id))) return
    c.choice = home()
    c.off.clear()
    c.counts = null
  })

  // a label's values that color, as the browser's chips: those it highlights (a regex label's `other` is not one); the
  // records with none are `not marked`
  function labelValues(l) {
    return labelClasses(l)
  }
  function labelHue(l, v) {
    const i = labelValues(l).indexOf(v)
    if (i >= 0) return SERIES[i % SERIES.length]
    return (l.values || []).some((x) => x.name === v) ? COLORS.dim : null
  }

  // a field's values in hue order: those it declares, then the others by their count (the reader counts the field
  // chosen, so only it), each keeping the hue it took
  function fieldValues(f) {
    const hues = c.hues.get(f.name) || new Map()
    c.hues.set(f.name, hues)
    const declared = (f.values || []).map((v) => (typeof v === 'object' ? v : { name: v }))
    for (const v of declared) {
      if (hues.has(v.name)) continue
      const want = Number(v.colour) >= 1 && Number(v.colour) <= SERIES.length ? SERIES[Number(v.colour) - 1] : null
      hues.set(v.name, want && ![...hues.values()].includes(want) ? want : nextHue(hues))
    }
    const counts = (fieldOf(c.choice) === f && c.counts) || {}
    const others = Object.keys(counts).filter((v) => v !== '' && !hues.has(v)).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
    for (const v of others) hues.set(v, nextHue(hues))
    return [...hues.keys()]
  }
  function nextHue(hues) {
    const used = new Set(hues.values())
    const free = SERIES.slice(0, HUES).find((h) => !used.has(h))
    return free || null // past six values: no hue of its own, under `other`
  }
  // a value's hue for a field that is a track (not the first choice): the field's own, a value new to it the next free
  function hueFor(f, v) {
    fieldValues(f)
    const hues = c.hues.get(f.name)
    if (!hues.has(v)) hues.set(v, nextHue(hues))
    return hues.get(v) || COLORS.dim
  }
  // a kept choice as the page reads it
  const resolve = (key) => {
    const f = fieldOf(key)
    if (f) return { field: f.name, title: f.title }
    const l = labelOf(key)
    return l ? { label: l.id, title: l.name } : null
  }
  // a choice checked or unchecked: one checked goes after the others, a track; with none left, Off
  function togglePick(key) {
    if (key === 'off') {
      api.choose(null)
      return
    }
    const first = c.choice
    c.picks = c.picks.includes(key) ? c.picks.filter((k) => k !== key) : [...c.picks, key]
    if (c.choice !== first) {
      c.off.clear()
      c.counts = null
    }
    save()
    onChange(api)
    redraw()
  }

  const api = {
    /** `{field, title}` or `{label, title}`, or null for Off. */
    get by() {
      const f = fieldOf(c.choice)
      if (f) return { field: f.name, title: f.title }
      const l = labelOf(c.choice)
      return l ? { label: l.id, title: l.name } : null
    },
    get off() {
      return c.choice === 'off'
    },
    /** Every choice in order, the first the color and each other a track beside the list's: `[{field, title}]` or
     *  `[{label, title}]`; none for Off. */
    get picks() {
      return c.picks.map(resolve).filter(Boolean)
    },
    /** The tracks of the choices past the first, which the list draws beside its own: `[{title, valueOf(record),
     *  colourOf(value)}]`. */
    get tracks() {
      return c.picks.slice(1).map((key) => {
        const f = fieldOf(key)
        if (f) return { title: f.title, valueOf: (r) => { const v = r && (typeof f.value === 'function' ? f.value(r) : r[f.name]); return v === undefined || v === null || v === '' ? null : String(v) }, colourOf: (v) => (v === null ? null : hueFor(f, String(v))) }
        const l = labelOf(key)
        return l ? { title: l.name, valueOf: (r) => labelValue(l.id, r), colourOf: (v) => (v === null ? null : labelHue(l, String(v))) } : null
      }).filter(Boolean)
    },
    /** A group's mix (a page, an agent, a session takes no color of its own): runs of `cells` cells, each value's share
     *  of `counts` ({value: n}, '' for no value) in its hue, the chips' order, no value dim and last, the values turned
     *  off left out; none for Off. Add them to the group's row. */
    mix(counts, cells = 8) {
      if (c.choice === 'off' || !counts) return []
      const order = chips().map((ch) => (ch.value === null ? '' : String(ch.value)))
      const keys = Object.keys(counts).filter((k) => Number(counts[k]) > 0 && api.isOn(k === '' ? null : k))
      keys.sort((a, b) => (a === '' ? 1 : b === '' ? -1 : (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9)))
      const total = keys.reduce((n, k) => n + Number(counts[k]), 0)
      if (!total) return []
      const out = []
      let used = 0
      keys.forEach((k, i) => {
        const n = i === keys.length - 1 ? cells - used : Math.max(1, Math.round((Number(counts[k]) / total) * cells))
        const w = Math.max(0, Math.min(n, cells - used))
        used += w
        if (w) out.push(k === '' ? { s: '█'.repeat(w), d: true } : mark(api.colourOf(k), '█'.repeat(w)))
      })
      return out
    },
    /** Check or uncheck a choice: a field by name, a label (`{label}`), Off (null); several together, the first the
     *  color. */
    togglePick(to) {
      togglePick(to === null ? 'off' : typeof to === 'object' ? `label:${to.label}` : `field:${to}`)
    },
    get field() {
      const f = fieldOf(c.choice)
      return f ? f.name : null
    },
    get label() {
      const l = labelOf(c.choice)
      return l ? l.id : null
    },
    /** The choice for the reader: `{field, off}`, `{label, name, off}` or null for Off; `off` the values turned off
     *  (null for the records with no value). */
    query() {
      const off = [...c.off].map((v) => (v === '' ? null : v))
      const f = fieldOf(c.choice)
      if (f) return { field: f.name, off }
      const l = labelOf(c.choice)
      return l ? { label: l.id, name: l.name, off } : null
    },
    /** The counts of the current choice's values, from the reader (`''` for no value). */
    counts(map) {
      c.counts = map && typeof map === 'object' ? { ...map } : null
      redraw()
    },
    /** A record's value under the choice: its field's (or `value(record)`), a label's on `record.ref` once thimble
     *  answered for it; null for Off. A record the reader gave a `value` under the choice keeps that. */
    valueOf(record) {
      if (!record) return null
      const f = fieldOf(c.choice)
      if (f) {
        const v = typeof f.value === 'function' ? f.value(record) : record[f.name]
        return v === undefined || v === null || v === '' ? null : String(v)
      }
      const l = labelOf(c.choice)
      if (!l) return null
      if (typeof record === 'object' && 'value' in record) return record.value === undefined || record.value === '' ? null : record.value
      return labelValue(l.id, record)
    },
    /** A value's hue (a palette color), dim for a value past six and a label's value that does not color, null for Off
     *  and for no value. */
    colourOf(value) {
      if (value === null || value === undefined || value === '') return null
      const f = fieldOf(c.choice)
      if (f) {
        fieldValues(f)
        const h = c.hues.get(f.name).get(String(value))
        return h || COLORS.dim
      }
      const l = labelOf(c.choice)
      return l ? labelHue(l, String(value)) : null
    },
    /** The mark of a value: `●` in its hue, dim for no value; `○` for a value turned off. */
    dot(value, glyph = '●') {
      if (!api.isOn(value)) return { s: '○', d: true }
      return mark(api.colourOf(value), glyph)
    },
    /** Whether a value's chip is on (null standing for no value). */
    isOn(value) {
      if (c.choice === 'off') return true
      return !c.off.has(value === null || value === undefined ? '' : String(value))
    },
    keeps(record) {
      return api.isOn(api.valueOf(record))
    },
    /** Count a record's values of every field, as the browser's kit counts the records a page hands it: the menu
     *  shows them for a field that declares none. The list counts the records it draws. */
    tally(record) {
      if (!record || typeof record !== 'object') return
      if (c.tallyAt !== state.drawNo) {
        if (c.tally.size) c.tallied = c.tally
        c.tally = new Map()
        c.tallySeen = new Set()
        c.tallyAt = state.drawNo
      }
      if (c.tallySeen.has(record)) return
      c.tallySeen.add(record)
      for (const f of fields) {
        const v = typeof f.value === 'function' ? f.value(record) : record[f.name]
        if (v === undefined || v === null || v === '' || typeof v === 'object') continue
        const m = c.tally.get(f.name) || new Map()
        m.set(String(v), (m.get(String(v)) || 0) + 1)
        c.tally.set(f.name, m)
      }
    },
    /** The chips: `[{value, name, colour, on, n}]`, `value` null for no value; none for Off. */
    get values() {
      return chips()
    },
    /** The top row's Color by control and its chips, added to a row (the row's room is theirs). */
    add(row) {
      control(row, true, false)
      return row
    },
    /** The top row: `before(r)` adds the row's other controls, then Color by with its chips, and Reset at R. Where
     *  the row has no room for Color by's name whole and its first chip, Color by takes the row under it; where its
     *  own row has no room for a chip beside the name, the chips take the row under that. */
    draw(d, before = null) {
      const r = d.row()
      if (before) before(r)
      if (r.x && r.x + 2 + nameW() + firstChipW() > d.cols - RESET_W) {
        addReset(r)
        r.end()
        control(d.row(), false, true).end()
      } else control(r, true, true).end()
    },
    /** Choose a field by name, a label by id (`{label}`), or Off (null). */
    choose(to) {
      const key = to === null ? 'off' : typeof to === 'object' ? `label:${to.label}` : `field:${to}`
      if (key !== c.choice) {
        c.choice = key
        c.off.clear()
        c.counts = null
        settle()
        save()
        onChange(api)
      } else if (c.picks.length > 1) {
        // the first choice taken alone: its tracks go
        c.choice = key
        save()
        onChange(api)
      }
      redraw()
    },
    /** Turn a value's chip off or on. */
    toggle(value) {
      const k = value === null || value === undefined ? '' : String(value)
      if (c.off.has(k)) c.off.delete(k)
      else c.off.add(k)
      save()
      onChange(api)
      redraw()
    },
  }

  function noValueName() {
    const f = fieldOf(c.choice)
    return f ? `no ${f.title.toLowerCase()}` : 'not marked'
  }

  function meaningOf(v) {
    const f = fieldOf(c.choice)
    if (f) {
      const declared = (f.values || []).find((x) => typeof x === 'object' && x.name === v)
      return (declared && declared.meaning) || (f.meanings && f.meanings[v]) || f.description || ''
    }
    const l = labelOf(c.choice)
    const lv = l && (l.values || []).find((x) => x.name === v)
    return (lv && lv.meaning) || (l ? `${l.name}: ${v}` : '')
  }

  function chips() {
    if (c.choice === 'off') return []
    const counts = c.counts || {}
    const f = fieldOf(c.choice)
    const l = labelOf(c.choice)
    if (!f && !l) return []
    // a label's values that color, each with its count, then `not marked`, as the browser's chips
    if (l) {
      const vs = labelValues(l)
      const out = vs.map((v) => ({ value: v, name: v, colour: labelHue(l, v), on: api.isOn(v), n: counts[v] || 0 }))
      const rest = (l.values || []).map((x) => x.name).filter((v) => !vs.includes(v))
      const n = (counts[''] || 0) + rest.reduce((k, v) => k + (counts[v] || 0), 0)
      out.push({ value: null, name: noValueName(), colour: null, on: api.isOn(null), n })
      return out
    }
    const names = fieldValues(f)
    const out = []
    const other = { value: '\u0000other', name: 'other', colour: null, on: true, n: 0, members: [] }
    for (const v of names) {
      const n = counts[v] || 0
      if (!c.hues.get(f.name).get(v)) {
        other.n += n
        other.members.push(v)
        continue
      }
      if (c.counts && !n && !c.off.has(v) && !(f.values || []).some((x) => (typeof x === 'object' ? x.name : x) === v)) continue
      out.push({ value: v, name: v, colour: api.colourOf(v), on: api.isOn(v), n })
    }
    // like a value with no records, `other` with none is left out once the counts are in, unless one of its values is off
    if (other.members.length && (!c.counts || other.n || other.members.some((v) => c.off.has(v)))) {
      other.on = other.members.some((v) => api.isOn(v))
      out.push(other)
    }
    if (counts[''] || c.off.has('')) out.push({ value: null, name: noValueName(), colour: null, on: api.isOn(null), n: counts[''] || 0 })
    return out
  }

  function toggleChip(ch) {
    if (ch.value === '\u0000other') {
      const on = ch.members.some((v) => api.isOn(v))
      for (const v of ch.members) (on ? c.off.add(v) : c.off.delete(v))
      save()
      onChange(api)
      redraw()
      return
    }
    api.toggle(ch.value)
  }

  function chipRuns(ch) {
    const runs = [ch.on ? mark(ch.colour) : { s: '○', d: true }, { s: ' ' }, ch.on ? { s: ch.name } : { s: ch.name, d: true }]
    if (c.counts) runs.push({ s: ` ${num(ch.n)}`, d: true })
    return runs
  }

  // a field's values in words for the menu: those it declares, then those the records the list drew take, the commonest
  // first, else those it gives meanings for
  function valueWords(f) {
    const declared = (f.values || []).map((v) => (typeof v === 'object' ? v.name : v))
    const t = (c.tallyAt === state.drawNo ? c.tallied : c.tally).get(f.name)
    const seen = t ? [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v) : []
    const names = [...new Set([...declared, ...seen])]
    return names.length ? names : Object.keys(f.meanings || {})
  }
  // the chosen field's or label's values with their dots, in their hues; the others' values in words, dim
  const dotted = (chs) => chs.flatMap((ch, i) => [...(i ? [{ s: '  ' }] : []), ch.on ? mark(ch.colour) : { s: '○', d: true }, { s: ` ${ch.name}` }])
  const words = (names) => (names.length ? [{ s: names.slice(0, 16).join(' · '), d: true }] : [])

  // `●` before a choice in use (in the accent), `○` before one that is not; a choice past the first says it is a track
  const pickMark = (key) => (key === 'off' ? c.choice === 'off' : c.picks.includes(key)) ? { s: '●', fg: COLORS.accent } : { s: '○', d: true }
  const trackWord = (key) => (c.picks.indexOf(key) > 0 ? 'track' : '')
  // the menu: Off, the fields, then the labels, each with its values; under the chosen one what it is. Space checks
  // or unchecks a choice, several together, the first the color; Enter takes it alone
  function menuItems() {
    const items = [{ key: 'off', name: 'Off', mark: pickMark('off'), chips: [{ s: 'no color', d: true }] }]
    if (fields.length) items.push({ heading: true, name: 'fields' })
    for (const f of fields) {
      const key = `field:${f.name}`
      const mine = fieldOf(c.choice) === f
      items.push({ key, name: f.title, mark: pickMark(key), right: trackWord(key), chips: mine && chips().length ? dotted(chips()) : words(valueWords(f)), about: (w) => wrap(f.description || '', w, 2).filter(Boolean).map((s) => [{ s, d: true }]) })
    }
    const ls = [...state.labels].sort((a, b) => Number(Boolean(b.here)) - Number(Boolean(a.here)))
    if (ls.length) items.push({ heading: true, name: 'labels' })
    for (const l of ls) {
      const key = `label:${l.id}`
      const mine = labelOf(c.choice) === l
      items.push({
        key,
        name: l.name,
        mark: pickMark(key),
        chips: mine ? dotted(chips()) : words([...labelValues(l), 'not marked']),
        right: [trackWord(key), l.kind || ''].filter(Boolean).join(' · '),
        // its kind and definition, then `definition ↗`, which opens the label's panel: on the last row where it fits,
        // else on a row of its own, so the ↗ is never cut
        about: (w) => {
          const text = l.text || l.spec || ''
          const what = text ? `${l.kind ? `${l.kind} · ` : ''}"${oneLine(text)}"` : l.kind || ''
          const link = 'definition ↗'
          const rows = what ? wrap(what, w, 2).map((s) => [{ s, d: true }]) : []
          let last = rows[rows.length - 1]
          if (!last || lineWidth(last) + 2 + width(link) > w) rows.push((last = []))
          else last.push({ s: '  ' })
          const x = lineWidth(last)
          last.push({ s: 'definition', fg: COLORS.link, u: true }, { s: ' ↗', fg: COLORS.link })
          last.hits = [{ x0: x, x1: x + width(link), on: () => openLabel(l.id), tip: "the label's panel: its definition, its runs and its records" }]
          return rows
        },
      })
    }
    return items
  }

  const showMenu = () => toggleMenu(api, menuItems().findIndex((it) => it.key === c.choice))
  // the values "+N" stands for, the chips the row has no room for, each with what its chip offers: its dot in its hue,
  // Space or Enter turns it off or on, and under it what it means
  const valuesOwner = { values: true }
  const showValues = () => toggleMenu(valuesOwner, 0)
  function valueItems() {
    return chips().slice(c.hiddenFrom || 0).map((ch) => ({
      key: ch.value,
      chip: ch,
      name: ch.name,
      mark: ch.on ? mark(ch.colour) : { s: '○', d: true },
      right: c.counts ? num(ch.n) : '',
      about: (w) => wrap(chipTip(ch), w, 2).filter(Boolean).map((s) => [{ s, d: true }]),
    }))
  }
  const name = () => (api.by ? api.by.title : 'Off') + (c.picks.length > 1 ? ` +${c.picks.length - 1}` : '')
  const arrowW = () => (api.by && api.by.label ? 2 : 0)
  const nameW = () => width(`Color by  ${name()}`) + arrowW()
  const chipW = (ch) => lineWidth(chipRuns(ch))
  const moreW = (n) => (n > 0 ? 2 + width(`+${n}`) : 0)
  const firstChipW = () => {
    const all = chips()
    return all.length ? 2 + chipW(all[0]) + moreW(all.length - 1) : 0
  }
  // how many chips fit in `room` cells, with `+N` after them for the rest
  function fitting(all, room) {
    let used = 0
    let k = 0
    for (const ch of all) {
      const w = chipW(ch) + (k ? 2 : 0)
      if (used + w + moreW(all.length - k - 1) > room) break
      used += w
      k++
    }
    return k
  }
  function placeChips(r, all, k) {
    c.hiddenFrom = k
    all.slice(0, k).forEach((ch, i) => {
      if (i) r.gap()
      const x0 = r.x
      for (const s of chipRuns(ch)) r.add(s.s, s)
      r.hits.push({ x0, x1: r.x, on: () => toggleChip(ch), tip: chipTip(ch) })
    })
    if (k < all.length) (k ? r.gap() : r).add(`+${all.length - k}`, { d: true }, { on: showValues, tip: `${plural(all.length - k, 'more value')}: each with its toggle and what it means` })
  }
  function addReset(r) {
    if (!changed()) return
    r.right('reset', {}, { on: () => reset(), tip: 'the view as it opens: its color, every value on, the whole time span' })
    r.d.key('r', 'to reset', () => reset(), false, 2)
  }

  // Color by on row `r`: `Color by` (`Color` where the row has no room for both), the choice whole (cut only where it
  // alone has no room), `↗` for a label, the chips in the room left, Reset at R with `withReset`; with `mayWrap`, chips that
  // do not fit beside the name take the row under it, at A2. The row the menu opens under, which the caller ends.
  function control(r, withReset, mayWrap) {
    const d = r.d
    const by = api.by
    const resetW = withReset ? RESET_W : 0
    r.add(nameW() <= d.cols - r.x - resetW ? 'Color by' : 'Color', { d: true }).gap()
    r.add(name(), {}, { on: showMenu, tip: 'choose what colors the view: a field or a label', max: Math.max(4, d.cols - r.x - resetW - arrowW()) })
    if (by && by.label) r.add(' ').add('↗', { fg: COLORS.link }, { on: () => openLabel(by.label), tip: "the label's panel: its definition, its runs and its records" })
    const all = chips()
    const room = d.cols - r.x - 2 - resetW
    const here = fitting(all, room)
    const below = mayWrap && all.length && !here && fitting(all, d.cols - 2) > 0
    if (all.length && !below) {
      r.gap()
      placeChips(r, all, here)
    }
    if (withReset) addReset(r)
    let last = r
    if (below) {
      r.end()
      last = d.row().gap(2)
      placeChips(last, all, fitting(all, d.cols - 2))
    }
    d.key('c', 'to color by', showMenu, false, 0)
    last.menus.push((dd) => drawMenu(dd, api, menuItems(), (it) => it && api.choose(it.key === 'off' ? null : it.key.startsWith('label:') ? { label: it.key.slice(6) } : it.key.slice(6)), 'c', 'to color by it alone', 'Color by', { words: 'to check or uncheck', on: (it) => togglePick(it.key) }))
    last.menus.push((dd) => drawMenu(dd, valuesOwner, valueItems(), (it) => it && toggleChip(it.chip), 'c', 'to turn off or on', by ? by.title : '', { words: 'to turn off or on', on: (it) => toggleChip(it.chip) }))
    return last
  }

  function chipTip(ch) {
    if (ch.value === '\u0000other') return `${ch.members.slice(0, 8).join(', ')}${ch.members.length > 8 ? ', …' : ''}: a click turns them off or on`
    if (ch.value === null) return `${ch.name}: the records that take no value`
    const m = meaningOf(ch.value)
    return `${m ? `${ch.name}: ${m}` : ch.name}${ch.on ? '' : ' (off)'}`
  }

  state.colour = api
  state.resets.push({
    // the view as it opens: colored as it opens, every value on
    changed: () => c.off.size > 0 || c.choice !== home(),
    reset: () => {
      if (c.choice !== home()) c.counts = null
      c.choice = home()
      c.off.clear()
      save()
    },
    after: () => onChange(api),
  })
  return api
}

// the cells Reset takes against R, with its gutter, whether it shows or not
const RESET_W = 7

// ------------------------------------------------------------------------------------------------ the labels' marks

// each record's values of the labels the parts read ({$thimble: 'marks'}, which thimble answers for the labels a query
// names): ref -> {label id: value}, and the labels each ref was asked for, so a label a part reads later is asked again
const marks = { got: new Map(), asked: new Map(), batch: new Map() }

/** A label's value on a record (`record.ref`, or a ref given as a string) once thimble answered for it, else null and
 *  asked for; Color by, Filter by and Rows read a label this way. */
export function labelValue(id, record) {
  const ref = typeof record === 'string' ? record : record && record.ref
  if (!ref) return null
  const got = marks.got.get(ref)
  const asked = marks.asked.get(ref)
  if (!asked || !asked.has(String(id))) needMarks(ref, String(id))
  return got ? got[String(id)] ?? null : null
}

function needMarks(ref, id) {
  const first = !marks.batch.size
  const want = marks.batch.get(ref) || new Set()
  want.add(id)
  marks.batch.set(ref, want)
  if (!first) return
  queueMicrotask(() => {
    const batch = [...marks.batch]
    marks.batch.clear()
    const refs = batch.map(([r]) => r)
    const ids = wantedLabels()
    // asked once for each label, though thimble may hold no value of one that no part reads any more
    for (const [r, w] of batch) marks.asked.set(r, new Set([...(marks.asked.get(r) || []), ...ids, ...w]))
    fetch({ $thimble: 'marks', refs }).then((got) => {
      for (const r of refs) marks.got.set(r, { ...(marks.got.get(r) || {}), ...((got && got[r]) || {}) })
      redraw()
    }, () => {})
  })
}

// ------------------------------------------------------------------------------------------------ the time range

const BARS = ' ▁▂▃▄▅▆▇█'
const TICKS = [1, 5, 15, 30, 60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400, 30 * 86400]
const BREAK = 4 // the cells of a break on a broken scale, drawn ` // ` on the strip and the axis
const MIN_SEG = 3 // the cells a stretch too short to see takes on a broken scale

// the stretches of time that hold data: the sorted times, split where two lie more than `gap` apart
function stretches(sorted, gap) {
  const out = []
  for (const t of sorted) {
    if (out.length && t - out[out.length - 1][1] <= gap) out[out.length - 1][1] = t
    else out.push([t, t])
  }
  return out
}

/** A bar's glyph for `n` of `max`, at least the lowest bar for any record (a square root, so a few records show). */
export function bar(n, max) {
  if (!n || !max) return ' '
  return BARS[Math.max(1, Math.min(8, Math.round(Math.sqrt(n / max) * 8)))]
}

/**
 * The time range: the one control for a view's time (docs/terminal-views.md, "Time"). An overview strip of the data's
 * whole span, each cell its records in the Color by hue most of them take, with the window over it on the selection
 * background and the cells outside it dim. A click on the strip moves the window there; a drag frames a new range,
 * moves the window from inside it, or moves an edge from the edge; `[` `]` pan and `+` `-` zoom. The range opens on
 * the whole span, and thimble keeps a range zoomed in per view. With `gap`, an empty stretch longer than it is a narrow
 * break (` // `) on the strip and on the range's scale, so bursts far apart share one axis, as in the browser; an edge of
 * the range never stays in a break, and `[` `]` `+` `-` move the window on the strip's cells.
 *
 * opts: onChange(range), unit ('s' seconds since 1970, the default, or 'n' a plain number), key (the name it is kept
 * under), min (the shortest range), gap (in the units).
 */
export function timeRange(opts = {}) {
  const key = opts.key || 'time'
  const unit = opts.unit === 'n' ? 'n' : 's'
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {}
  const keptRange = (kept('ranges') || {})[key]
  const r = { times: [], values: [], span: null, marks: [], from: null, to: null, valueOf: null, gap: Number(opts.gap) > 0 ? Number(opts.gap) : 0, segs: null, w: 100 }
  if (Array.isArray(keptRange)) [r.from, r.to] = keptRange
  const save = () => keep('ranges', { ...(kept('ranges') || {}), [key]: r.from === null ? undefined : [r.from, r.to] })
  const span = () => r.span || [0, 1]
  const minLen = () => Math.max(opts.min || (unit === 's' ? 60 : 1), (span()[1] - span()[0]) / 2000)

  function clamp(a, b) {
    const [s0, s1] = span()
    let len = Math.max(minLen(), b - a)
    if (len >= s1 - s0) return [null, null]
    if (a < s0) [a, b] = [s0, s0 + len]
    if (b > s1) [a, b] = [s1 - len, s1]
    return r.segs ? outOfBreaks(a, b, len) : [a, b]
  }

  // an edge in a break moves to the data beside it: the start to where the next stretch begins, the end to where the
  // stretch before it ends; a window inside one break moves to the stretch after it
  function outOfBreaks(a, b, len) {
    const segs = r.segs
    const inBreak = (t) => segs.findIndex((sg, k) => k + 1 < segs.length && t > sg[1] && t < segs[k + 1][0])
    let k = inBreak(a)
    if (k >= 0) a = segs[k + 1][0]
    if (b <= a) b = Math.min(span()[1], a + len)
    k = inBreak(b)
    if (k >= 0) b = segs[k][1] > a ? segs[k][1] : Math.min(span()[1], segs[k + 1][0] + len)
    if (a <= span()[0] && b >= span()[1]) return [null, null]
    return [a, b]
  }

  // the strip's scale over the whole span: linear, or with the breaks
  const whole = (w) => scaleOf(span()[0], span()[1], w, unit, r.segs)

  const api = {
    get from() {
      return r.from ?? span()[0]
    },
    get to() {
      return r.to ?? span()[1]
    },
    get full() {
      return r.from === null
    },
    get span() {
      return span().slice()
    },
    /** New data: `times` (a list), `values` (each record's Color by value, or a function of its index), `span`
     *  ([first, last], else the times'), `marks` ([{t, label}], point events drawn as flags under the chart). The range
     *  is kept where it can be. */
    data(d = {}) {
      if (d.times) r.times = Array.from(d.times)
      if (d.values !== undefined) r.values = d.values
      if (d.marks) r.marks = d.marks.slice()
      if ('gap' in d) r.gap = Number(d.gap) > 0 ? Number(d.gap) : 0
      if (d.span) r.span = [Number(d.span[0]), Number(d.span[1])]
      else if (d.times) {
        let a = Infinity
        let b = -Infinity
        for (const t of r.times) {
          if (t < a) a = t
          if (t > b) b = t
        }
        // no record (a search that matches none): the span and its breaks stay as they were, as in the browser
        if (Number.isFinite(a)) r.span = [a, b > a ? b : a + 1]
      }
      if (!r.times.length && !d.span) {
        if (r.from !== null) [r.from, r.to] = clamp(r.from, r.to)
        redraw()
        return
      }
      r.segs = null
      if (r.gap && r.span && r.times.length) {
        const segs = stretches(r.times.filter((t) => Number.isFinite(t)).sort((x, y) => x - y), r.gap)
        segs[0][0] = Math.min(segs[0][0], r.span[0])
        segs[segs.length - 1][1] = Math.max(segs[segs.length - 1][1], r.span[1])
        if (segs.length > 1) r.segs = segs
      }
      if (r.from !== null) [r.from, r.to] = clamp(r.from, r.to)
      redraw()
    },
    has(t) {
      return t >= api.from && t <= api.to
    },
    /** The range set (`set(a, b)`), or the whole span (`set(null)`); onChange follows. */
    set(a, b) {
      const next = a === null || a === undefined ? [null, null] : clamp(Number(a), Number(b))
      if (next[0] === r.from && next[1] === r.to) return
      ;[r.from, r.to] = next
      save()
      onChange(api)
      redraw()
    },
    fit() {
      api.set(null)
    },
    /** The scale of the range across `cols` cells: `{from, to, cols, x(t), t(x), binOf(t), step, ticks(gap)}`; x(t) the
     *  cell a time falls in, binOf(t) the same or -1 outside the range, step the time a cell spans. */
    scale(cols) {
      return scaleOf(api.from, api.to, Math.max(1, cols | 0), unit, r.segs)
    },
    /** A time in the readout's words, as precise as `step` needs. */
    format(t, step = (api.to - api.from) / 60) {
      return unit === 'n' ? num(t) : when(t, step)
    },
    /** The range's readout: start, end and length, `16 May 04:31 – 05:10 · 39m`. */
    readout() {
      const a = api.from
      const b = api.to
      if (unit === 'n') return `${num(a)} – ${num(b)} · ${num(b - a)}`
      const step = (b - a) / 60
      const aa = when(a, step)
      const bb = when(b, step)
      const sameDay = dayOf(a) === dayOf(b) && step < 86400
      return `${aa} – ${sameDay ? bb.split(' ').slice(2).join(' ') : bb} · ${dur(b - a)}`
    },
    /** The readout row and the overview strip; `gutter` cells before the strip, so it stands over the chart's time
     *  column (a lane's names in the gutter). */
    draw(d, o = {}) {
      const gutter = o.gutter || 0
      const w = Math.max(10, d.cols - gutter)
      d.row().add(api.readout(), { d: true }).end()
      const row = d.row()
      if (gutter) row.gap(gutter)
      r.w = w
      const cells = overview(w)
      const ov = r.segs ? whole(w) : null
      let lo = r.from === null ? 0 : Math.floor(((api.from - span()[0]) / (span()[1] - span()[0])) * w)
      let hi = r.from === null ? w - 1 : Math.min(w - 1, Math.max(lo, Math.ceil(((api.to - span()[0]) / (span()[1] - span()[0])) * w) - 1))
      if (ov && r.from !== null) [lo, hi] = [ov.x(api.from), Math.max(ov.x(api.from), Math.ceil(ov.pos(api.to)) - 1)]
      const x0 = row.x
      cells.forEach((cell, i) => {
        const inside = i >= lo && i <= hi
        // a range zoomed in: its window on the selection background, with its edges `[` `]`, the cells a drag moves
        // them from, and the rest dim
        if (r.from !== null && (i === lo || i === hi)) return row.add(lo === hi ? '|' : i === lo ? '[' : ']', { b: true, bg: COLORS.selected })
        const style = cell.brk ? { fg: COLORS.rule } : cell.colour && cell.colour !== COLORS.dim ? { fg: cell.colour } : { d: true }
        row.add(cell.glyph, { ...style, ...(inside && r.from !== null ? { bg: COLORS.selected } : {}), ...(!inside && !cell.brk ? { d: true } : {}) })
      })
      const sx = ov ? (x) => ov.t(x) : (x) => span()[0] + ((x + 0.5) / w) * (span()[1] - span()[0])
      // a cell's left edge in time, for a drag that frames whole cells
      const edge = ov ? (x) => ov.at(x) : (x) => span()[0] + (x / w) * (span()[1] - span()[0])
      // under the pointer, a cell's time and its records: the strip is a chart, so only its cell is marked (cursor)
      const cellStep = (span()[1] - span()[0]) / w
      const tips = cells.map((cell, i) => (cell.brk ? 'no records in this break' : `${api.format(sx(i), cellStep)}${cell.n ? ` · ${plural(cell.n, 'record')}` : ''}`))
      row.hits.push({
        x0,
        x1: x0 + w,
        cursor: true,
        tips,
        tip: r.from === null ? 'drag to frame a range; + zooms in' : 'drag an edge [ ] or the window, or drag to frame a new range; a click moves the window there',
        on: (x) => {
          const len = api.to - api.from
          if (r.from === null) return
          const t = sx(x)
          api.set(t - len / 2, t + len / 2)
        },
        drag: (a, b) => {
          if (Math.abs(b - a) < 1) return
          const len = api.to - api.from
          if (r.from !== null && a > lo && a < hi) {
            const dt = ((b - a) / w) * (span()[1] - span()[0])
            return api.set(api.from + dt, api.to + dt)
          }
          if (r.from !== null && a === lo) return api.set(Math.min(sx(b), api.to - minLen()), api.to)
          if (r.from !== null && a === hi) return api.set(api.from, Math.max(sx(b), api.from + minLen()))
          void len
          api.set(edge(Math.min(a, b)), edge(Math.max(a, b) + 1))
        },
      })
      row.end()
      bindKeys(d)
    },
  }

  function overview(w) {
    const [s0, s1] = span()
    const n = new Array(w).fill(0)
    const by = Array.from({ length: w }, () => new Map())
    const valueAt = typeof r.values === 'function' ? r.values : (i) => (r.values ? r.values[i] : null)
    const ov = r.segs ? whole(w) : null
    r.times.forEach((t, i) => {
      const x = ov ? ov.x(t) : Math.min(w - 1, Math.max(0, Math.floor(((t - s0) / (s1 - s0)) * w)))
      n[x]++
      const v = valueAt(i)
      const k = v === null || v === undefined ? '' : String(v)
      by[x].set(k, (by[x].get(k) || 0) + 1)
    })
    const max = Math.max(1, ...n)
    const colourOf = hueFn(opts.colour)
    const brk = breakGlyphs(ov)
    return n.map((k, x) => {
      if (brk.has(x)) return { glyph: brk.get(x), brk: true }
      let best = ''
      let bn = 0
      for (const [v, m] of by[x]) if (v !== '' && m > bn) [best, bn] = [v, m]
      return { glyph: bar(k, max), colour: best ? colourOf(best) : null, n: k }
    })
  }

  function bindKeys(d) {
    // on a broken scale the keys move the window on the strip's cells, so it keeps its width there across a break
    const move = (p0, p1) => {
      const ov = whole(r.w)
      const a = Math.max(0, Math.min(r.w, p0))
      const b = Math.max(0, Math.min(r.w, p1))
      if (p0 < 0) return api.set(ov.at(0), ov.at(b - p0))
      if (p1 > r.w) return api.set(ov.at(a - (p1 - r.w)), ov.at(r.w))
      api.set(ov.at(a), ov.at(b))
    }
    const pan = (k) => {
      if (r.from === null) return
      if (r.segs) {
        const ov = whole(r.w)
        const [p0, p1] = [ov.pos(api.from), ov.pos(api.to)]
        const by = (k === ']' ? 1 : -1) * Math.max(1, (p1 - p0) / 4)
        return move(p0 + by, p1 + by)
      }
      const len = api.to - api.from
      const by = (k === ']' ? 1 : -1) * len / 4
      api.set(api.from + by, api.to + by)
    }
    const zoom = (k) => {
      if (r.segs) {
        const ov = whole(r.w)
        const [p0, p1] = [ov.pos(api.from), ov.pos(api.to)]
        const mid = (p0 + p1) / 2
        const len = (p1 - p0) * (k === '+' ? 2 / 3 : 1.5)
        return move(mid - len / 2, mid + len / 2)
      }
      const mid = (api.from + api.to) / 2
      const len = (api.to - api.from) * (k === '+' ? 2 / 3 : 1.5)
      api.set(mid - len / 2, mid + len / 2)
    }
    d.key(['[', ']'], 'to pan', pan)
    d.key(['+', '-'], 'to zoom', zoom)
  }

  state.resets.push({
    changed: () => r.from !== null,
    reset: () => {
      r.from = r.to = null
      save()
    },
    after: () => onChange(api),
  })
  return api
}

// a value's hue from a Color by control, a function, or the view's Color by when none is given
function hueFn(c) {
  if (typeof c === 'function') return c
  const by = c && typeof c.colourOf === 'function' ? c : state.colour
  return by ? (v) => by.colourOf(v) : () => null
}

// the cells of a broken scale's breaks, each with its glyph: ` // ` across the BREAK cells
function breakGlyphs(sc) {
  const out = new Map()
  for (const [g0, g1] of sc ? sc.gaps() : []) for (let x = g0; x < g1; x++) out.set(x, x - g0 === 1 || x - g0 === 2 ? '/' : ' ')
  return out
}

function scaleOf(from, to, cols, unit, segs = null) {
  // the stretches that hold data within the range; a stretch that only touches an end of the range is none
  const parts = []
  for (const [a0, b0] of segs || []) {
    const a = Math.max(from, a0)
    const b = Math.min(to, b0)
    if (b > a || (b === a && a !== from && b !== to)) parts.push([a, b])
  }
  if (parts.length > 1 && cols >= parts.length * (MIN_SEG + BREAK)) return brokenScale(from, to, cols, unit, parts)
  const len = Math.max(1e-9, to - from)
  const step = len / cols
  const x = (t) => Math.min(cols - 1, Math.max(0, Math.floor(((t - from) / len) * cols)))
  return {
    from,
    to,
    cols,
    step,
    x,
    t: (cx) => from + (cx + 0.5) * step,
    /** The position of a time in cells, fractional (0 to cols), and the time at a position. */
    pos: (t) => ((t - from) / len) * cols,
    at: (p) => from + (p / cols) * len,
    broken: false,
    gaps: () => [],
    binOf: (t) => (t < from || t > to ? -1 : x(t)),
    /** Ticks at least `gap` cells apart: `[{t, x, label}]`, the label as precise as the tick step needs, the date on
     *  the first tick and where the day changes. */
    ticks(gap = 14) {
      if (unit === 'n') {
        const raw = (gap * len) / cols
        const p = 10 ** Math.floor(Math.log10(raw))
        const tick = [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw) || 10 * p
        const out = []
        for (let t = Math.ceil(from / tick) * tick; t <= to; t += tick) out.push({ t, x: x(t), label: num(t) })
        return out
      }
      const tick = TICKS.find((s) => s / step >= gap) || TICKS.at(-1)
      const out = []
      let lastDay = ''
      for (let t = Math.ceil(from / tick) * tick; t <= to; t += tick) {
        const day = dayOf(t)
        const label = tick >= 86400 ? when(t, 86400).split(' ').slice(0, 2).join(' ') : day !== lastDay ? when(t, tick) : when(t, tick).split(' ').slice(2).join(' ')
        lastDay = day
        out.push({ t, x: x(t), label })
      }
      return out
    },
  }
}

// a scale with breaks: each stretch its share of the cells by its length (at least MIN_SEG), the empty time between
// two stretches BREAK cells, as the browser's broken scale lays them out
function brokenScale(from, to, cols, unit, parts) {
  const room = cols - BREAK * (parts.length - 1)
  const total = parts.reduce((n, [a, b]) => n + (b - a), 0)
  let ws = parts.map(([a, b]) => (total > 0 ? ((b - a) / total) * room : room / parts.length))
  const short = ws.reduce((n, w) => n + (w < MIN_SEG ? MIN_SEG - w : 0), 0)
  const long = ws.reduce((n, w) => n + (w < MIN_SEG ? 0 : w), 0)
  if (short && long > short) ws = ws.map((w) => (w < MIN_SEG ? MIN_SEG : w - (w / long) * short))
  // whole cells, the cells left over going to the largest remainders
  const whole = ws.map((w) => Math.max(1, Math.floor(w)))
  let left = room - whole.reduce((n, w) => n + w, 0)
  for (const i of ws.map((w, i) => i).sort((a, b) => (ws[b] - Math.floor(ws[b])) - (ws[a] - Math.floor(ws[a])))) {
    if (left <= 0) break
    whole[i]++
    left--
  }
  let c = 0
  const segs = parts.map(([a, b], i) => {
    const sg = { a, b, c0: c, c1: c + whole[i] }
    c += whole[i] + BREAK
    return sg
  })
  const step = total > 0 ? total / room : (to - from) / cols
  const pos = (t) => {
    if (t <= segs[0].a) return segs[0].c0
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i]
      if (t <= g.b) return g.b > g.a ? g.c0 + ((t - g.a) / (g.b - g.a)) * (g.c1 - g.c0) : (g.c0 + g.c1) / 2
      const nx = segs[i + 1]
      if (nx && t < nx.a) return g.c1 + ((t - g.b) / (nx.a - g.b)) * (nx.c0 - g.c1)
    }
    return segs[segs.length - 1].c1
  }
  const at = (p) => {
    if (p <= segs[0].c0) return segs[0].a
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i]
      if (p <= g.c1) return g.a + ((p - g.c0) / (g.c1 - g.c0)) * (g.b - g.a)
      const nx = segs[i + 1]
      if (nx && p < nx.c0) return g.b + ((p - g.c1) / (nx.c0 - g.c1)) * (nx.a - g.b)
    }
    return segs[segs.length - 1].b
  }
  // a time's cell: in its stretch's cells, its last cell for the stretch's end; a time in a break falls in its cells
  const x = (t) => {
    for (const g of segs) if (t >= g.a && t <= g.b) return Math.min(g.c1 - 1, Math.floor(pos(t)))
    return Math.min(cols - 1, Math.max(0, Math.floor(pos(t))))
  }
  return {
    from,
    to,
    cols,
    step,
    x,
    t: (cx) => at(cx + 0.5),
    pos,
    at,
    broken: true,
    /** The breaks, as [first cell, cell after the last]. */
    gaps: () => segs.slice(1).map((g, i) => [segs[i].c1, g.c0]),
    binOf: (t) => (t < from || t > to ? -1 : x(t)),
    /** Ticks at least `gap` cells apart in each stretch: `[{t, x, label}]`, the date on the first tick, the first after
     *  a break and where the day changes. */
    ticks(gap = 14) {
      if (unit === 'n') {
        const raw = gap * step
        const p = 10 ** Math.floor(Math.log10(raw))
        const tick = [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw) || 10 * p
        return segs.flatMap((g) => {
          const out = []
          for (let t = Math.ceil(g.a / tick) * tick; t <= g.b; t += tick) out.push({ t, x: x(t), label: num(t) })
          return out
        })
      }
      const tick = TICKS.find((s) => s / step >= gap) || TICKS.at(-1)
      const out = []
      let lastDay = ''
      for (const g of segs) {
        let first = true
        for (let t = Math.ceil(g.a / tick) * tick; t <= g.b; t += tick) {
          const day = dayOf(t)
          const label = tick >= 86400 ? when(t, 86400).split(' ').slice(0, 2).join(' ') : first || day !== lastDay ? when(t, tick) : when(t, tick).split(' ').slice(2).join(' ')
          lastDay = day
          first = false
          out.push({ t, x: x(t), label, full: tick >= 86400 ? label : when(t, tick) })
        }
      }
      return out
    },
  }
}

/** The chart's axis under it: the ticks' labels dim at their cells, `gutter` cells in, none overlapping; `legend`, in
 *  the gutter before them, the key of the marks the chart draws other than Color by's (`─ running  × failed`): runs, or
 *  entries `{glyph, fg, name, on, toggle, tip}`, each a control that hides or shows its series (dim while off), as a
 *  lanes part gives them (`legend()`); then, with `marks` ([{t, label}]), their labels on a row of their own, each a
 *  control when `onMark(mark)` is given. */
export function axis(d, scale, o = {}) {
  const gutter = o.gutter || 0
  const given = o.legend ? (Array.isArray(o.legend) ? o.legend : [o.legend]) : []
  const toggles = given.filter((e) => e && typeof e === 'object' && 'name' in e)
  // a key whose entries are toggles: in the gutter where all of them fit, else on a row of their own over the axis, so
  // no series loses its entry
  const keyW = toggles.reduce((n, e, i) => n + (i ? 2 : 0) + width(`${e.glyph || '●'} ${e.name}`), 0)
  const own = toggles.length && keyW > gutter - 2
  const keyRow = (row) => {
    toggles.forEach((e, i) => {
      if (i) row.gap()
      const on = e.on !== false
      const x0 = row.x
      row.add(e.glyph || '●', on ? (e.fg ? { fg: e.fg } : {}) : { d: true }).add(` ${e.name}`, { d: true })
      if (e.toggle) row.hits.push({ x0, x1: row.x, on: () => e.toggle(), tip: e.tip || `${on ? 'hide' : 'show'} ${e.name}` })
    })
  }
  if (own) {
    const kr = d.row()
    keyRow(kr)
    kr.end()
  }
  const row = d.row()
  if (toggles.length) {
    if (!own) keyRow(row)
  } else {
    // the legend whole, or none where the gutter has no room for it (the lanes' tips say it too)
    const legend = merged(given.map(segOf).filter(Boolean))
    if (legend.length && lineWidth(legend) <= gutter - 2) row.runsOf(legend)
  }
  row.at(gutter)
  let end = 0
  // a broken scale's breaks are `//` in the rule gray, and no label runs into one
  const gaps = scale.gaps ? scale.gaps() : []
  const items = [
    ...scale.ticks(o.gap || 12).map((tk) => ({ x: tk.x, label: tk.label, full: tk.full, style: { d: true } })),
    ...gaps.map(([g0, g1]) => ({ x: g0 + 1, label: '//', style: { fg: COLORS.rule }, brk: g1 })),
  ].sort((a, b) => a.x - b.x || (a.brk ? -1 : 1))
  // the first label after a break gives the date, even when the stretch's first tick had no room
  let dated = false
  for (const tk of items) {
    if (tk.brk) {
      row.at(gutter + tk.x).add(tk.label, tk.style)
      end = tk.brk
      dated = false
      continue
    }
    // where the time with its date has no room, the date alone, as the browser's axis does
    const fits = (l) => tk.x >= end && tk.x + width(l) <= scale.cols && !gaps.some(([g0, g1]) => tk.x < g1 && tk.x + width(l) > g0)
    const label = !dated && gaps.length && tk.full ? [tk.full, tk.full.split(' ').slice(0, 2).join(' ')].find(fits) : fits(tk.label) ? tk.label : null
    if (!label) continue
    row.at(gutter + tk.x).add(label, tk.style)
    end = tk.x + width(label) + 2
    dated = true
  }
  row.end()
  const marks = (o.marks || []).filter((m) => m.t >= scale.from && m.t <= scale.to).sort((a, b) => a.t - b.t)
  if (!marks.length) return
  const mr = d.row().gap(gutter)
  end = 0
  for (const m of marks) {
    // a label that would run into the one before it stands just after it, near enough to its time, else is left out
    const x = Math.max(scale.x(m.t), end)
    const label = String(m.label)
    if (x - scale.x(m.t) > 12 || x + width(label) > scale.cols) continue
    mr.at(gutter + x).add(label, o.onMark ? {} : { d: true }, o.onMark ? { on: () => o.onMark(m), tip: m.tip || `${label}: ${when(m.t, 60)}` } : { tip: m.tip || `${label}: ${when(m.t, 60)}` })
    end = x + width(label) + 2
  }
  mr.end()
}

/** One row of a chart over time: a cell per bin of the scale, each the bar of its count (of `max`) in the hue of the
 *  value most of its records take; `guide` a time drawn as `┊` in an empty cell. A list of runs. */
export function strip(scale, items, o = {}) {
  const n = new Array(scale.cols).fill(0)
  const by = Array.from({ length: scale.cols }, () => new Map())
  for (const it of items) {
    const x = scale.binOf(o.time ? o.time(it) : it.t)
    if (x < 0) continue
    n[x]++
    const v = o.value ? o.value(it) : null
    const k = v === null || v === undefined ? '' : String(v)
    by[x].set(k, (by[x].get(k) || 0) + 1)
  }
  const max = o.max || Math.max(1, ...n)
  const guide = o.guide === null || o.guide === undefined ? -1 : scale.binOf(o.guide)
  return n.map((k, x) => {
    if (!k) return x === guide ? { s: '┊', fg: COLORS.rule } : { s: ' ' }
    let best = ''
    let bn = 0
    for (const [v, m] of by[x]) if (v !== '' && m > bn) [best, bn] = [v, m]
    const colour = best ? hueFn(o.colour)(best) : null
    // a value with no hue of its own (past six, a label's value that does not color) is dim, as no value is
    return colour && colour !== COLORS.dim ? { s: bar(k, max), fg: colour } : { s: bar(k, max), d: true }
  })
}

/** The most records any bin of the scale holds among several groups (a lane each), so the lanes share one height. */
export function maxBin(scale, groups, time = (it) => it.t) {
  let max = 1
  for (const items of groups) {
    const n = new Map()
    for (const it of items) {
      const x = scale.binOf(time(it))
      if (x < 0) continue
      const k = (n.get(x) || 0) + 1
      n.set(x, k)
      if (k > max) max = k
    }
  }
  return max
}

// ------------------------------------------------------------------------------------------------ the list

/**
 * A list of records with a chosen row (`❯` and the accent), its details in place under it or in a side pane beside it,
 * and the colored track at its right edge when it is taller than its room (docs/terminal-views.md, "The list"). ↑↓
 * choose, Enter or a click opens and closes the chosen row's details, `a` asks a side thread about it; the wheel moves
 * the rows. `span(time)` gives the times of the rows in view, which a lanes part marks on the overview.
 *
 * opts: key(item) its identity; enter (the hint's words, `to open`).
 */
export function list(opts = {}) {
  const keyOf = opts.key || ((it) => it.ref ?? it.id)
  const s = { chosen: null, open: null, top: 0, free: false, items: [], rows: 0, shown: [], shownKey: '' }
  onWheel((by) => {
    s.top = Math.max(0, s.top + by)
    s.free = true
  })
  const api = {
    get chosen() {
      return s.chosen
    },
    get open() {
      return s.open
    },
    /** Choose the item with this key (and show it). */
    choose(key) {
      s.chosen = key
      s.free = false
      redraw()
    },
    /** Open (or with `false`, close) the details of the item with this key, and choose it. */
    show(key, on = true) {
      s.chosen = key
      s.open = on ? key : null
      s.free = false
      redraw()
    },
    /** The chosen item among those last drawn. */
    item() {
      return s.items.find((it) => !it.heading && keyOf(it) === s.chosen) || null
    },
    /** The first and last times of the items in view, `[t0, t1]`, by `time(item)` (`item.t` or `item.time`); null
     *  when none shows. */
    span(time = (it) => (it.t ?? it.time)) {
      const ts = s.shown.map((it) => Number(time(it))).filter((t) => Number.isFinite(t))
      return ts.length ? [Math.min(...ts), Math.max(...ts)] : null
    },
    /** The items in view, as last drawn. */
    get shown() {
      return s.shown.slice()
    },
    /**
     * Draw the list in the rows left (or `o.height`): `o.items` (an item with `heading` is a bold heading row no key
     * chooses), `o.row(item, r, {chosen, open})` adds the item's row to a Row started after its mark, `o.detail(item,
     * d)` draws its details into an inner drawing at A2, `o.value(item)` its Color by value (its mark and the track),
     * `o.colour` (a Color by control, for the hues), `o.ask(item)` `{ref, text}` to ask about it, `o.onOpen(item)` when
     * its details open (fetch what they show), `o.header(r)` a row above the rows that does not scroll (a table's
     * columns' names), `o.empty` the words for no item.
     */
    draw(d, o = {}) {
      const items = o.items || []
      s.items = items
      // what the list shows, named over it: the run, the session or the selection, and how many
      if (o.title) {
        const tr = d.row()
        const count = o.count === undefined || o.count === null ? '' : typeof o.count === 'number' ? num(o.count) : String(o.count)
        tr.add(cut(String(o.title), Math.max(4, d.cols - width(count) - 2)), { b: true })
        if (count) tr.gap().add(count, { d: true })
        tr.end()
      }
      // a side pane open on one of the items: the list at the left, the item's details beside it (or under it in a
      // narrow panel)
      if (o.side && o.side.isOpen) {
        const open = items.find((it) => !it.heading && keyOf(it) === o.side.key)
        if (open) {
          const rest = { ...o, title: null, side: null, sideOpen: o.side }
          o.side.draw(d, (dl) => api.draw(dl, rest), (ds) => (o.detail ? o.detail(open, ds) : null), { title: o.sideTitle ? o.sideTitle(open) : open.ref ? placeWords(open.ref) : '' })
          return
        }
      }
      const pane = o.side || o.sideOpen || null
      // a header row (the columns' names) stands above the rows and does not scroll with them
      if (o.header) {
        const hr = d.row()
        if (o.colour || o.value) hr.gap(2)
        o.header(hr)
        hr.end()
      }
      const height = Math.max(1, Math.min(o.height || d.left, d.left))
      const pickable = items.filter((it) => !it.heading)
      if (!pickable.length) {
        d.row().gap(2).add(o.empty || 'none', { d: true }).end()
        return
      }
      if (!pickable.some((it) => keyOf(it) === s.chosen)) s.chosen = keyOf(pickable[0])
      if (s.open !== null && !pickable.some((it) => keyOf(it) === s.open)) s.open = null
      const colour = o.colour
      const valueOf = o.value || (colour ? (it) => colour.valueOf(it) : null)
      const hueOf = (v) => (colour ? colour.colourOf(v) : null)
      // Color by's choices past the first, each a column of its own beside the track (at most TRACKS_MAX)
      const tracks = colour && Array.isArray(colour.tracks) ? colour.tracks.slice(0, TRACKS_MAX) : []
      // every row of the list, laid out: an item's row, its details' rows under it
      const trackW = 3 + tracks.length
      const inner = new Drawing(d.cols - trackW, 100000, d, 0)
      const spans = [] // [first line, last line, item index]
      items.forEach((it, i) => {
        const y0 = inner.y
        if (it.heading) inner.line([{ s: String(it.heading), ...(it.dim ? { d: true } : { b: true }) }])
        else {
          const key = keyOf(it)
          const ch = key === s.chosen
          const op = pane ? pane.key === key : key === s.open
          const r = inner.row()
          if (ch) r.margin({ s: '❯', fg: COLORS.accent })
          const v = valueOf ? valueOf(it) : null
          if (valueOf && o.mark !== false) r.add(colour ? colour.dot(v).s : '●', colour ? colour.dot(v) : mark(hueOf(v))).gap(1)
          const before = r.runs.length
          if (o.row) o.row(it, r, { chosen: ch, open: op })
          if (colour && colour.tally) colour.tally(it)
          // the chosen row in the accent across its whole width, its dim columns too, as thimble-term's tables mark
          // theirs; a run in a color of its own (a value's hue, a problem, a link) keeps it
          if (ch) for (let k = before; k < r.runs.length; k++) if ((!r.runs[k].fg || r.runs[k].fg === COLORS.text) && r.runs[k].s.trim()) r.runs[k] = { ...r.runs[k], fg: COLORS.accent, d: false }
          r.hits.push({ x0: 0, x1: inner.cols, row: true, on: () => {
            s.chosen = key
            s.free = false
            toggle(it)
          } })
          r.end()
          // lines every item has under its row (a turn's words), at `bodyIndent` cells
          if (o.body) {
            const bd = inner.inner(o.bodyIndent ?? 2, 100000)
            o.body(it, bd, { chosen: ch, open: op })
            inner.put(bd)
          }
          if (op && o.detail && !pane) {
            const dd = inner.inner(2, 100000)
            o.detail(it, dd)
            inner.put(dd)
          }
        }
        spans.push([y0, inner.y - 1, i])
      })
      const total = inner.lines.length
      const at = spans.find(([, , i]) => !items[i].heading && keyOf(items[i]) === s.chosen) || spans[0]
      // the window: the chosen row in view, its details too where they fit, unless the wheel moved it since
      const last = Math.max(0, total - height)
      let top = Math.min(s.top, last)
      if (!s.free) {
        if (at[0] < top) top = at[0]
        const end = Math.min(at[1], at[0] + height - 1)
        if (end >= top + height) top = end - height + 1
        // a heading right above the chosen row comes with it
        if (top === at[0] && top > 0 && items[spans.find(([a]) => a === top - 1)?.[2]]?.heading) top -= 1
        // a row its details keep in view (d.focus) shows, with the chosen row above it where both fit
        const f = inner.focusY
        if (f !== null && f > at[0] && f <= at[1] && f >= top + height) top = f - at[0] < height ? at[0] : f - Math.floor(height / 3)
      }
      s.top = top = Math.max(0, Math.min(top, last))
      // the items in view, which a lanes part drawn above marks on the overview: a change draws again, so it follows
      s.shown = spans.filter(([a, b, i]) => !items[i].heading && b >= top && a < top + height).map(([, , i]) => items[i])
      const shownKey = s.shown.length ? `${keyOf(s.shown[0])}\u0000${keyOf(s.shown[s.shown.length - 1])}` : ''
      if (shownKey !== s.shownKey) {
        s.shownKey = shownKey
        redraw()
      }
      const y0 = d.y
      for (let y = top; y < Math.min(total, top + height); y++) d.lines.push({ margin: inner.lines[y].margin, runs: inner.lines[y].runs })
      for (const h of inner.hits) if (h.y >= top && h.y < top + height) d.hits.push({ ...h, y: h.y - top + y0 })
      if (total > height) drawTrack(d, y0, Math.min(height, total - top), total, top, height, spans, items, valueOf, hueOf, tracks, (line) => {
        const sp = spans.find(([a, b]) => line >= a && line <= b)
        const it = sp && items.slice(sp[2]).find((x) => !x.heading)
        if (it) s.chosen = keyOf(it)
        s.top = line
        s.free = true
      })
      s.rows = height
      const step = (by) => {
        const keys = pickable.map(keyOf)
        const i = keys.indexOf(s.chosen)
        s.chosen = keys[Math.max(0, Math.min(keys.length - 1, i + by))]
        s.free = false
      }
      d.key(['up', 'down'], 'to choose', (k) => step(k === 'up' ? -1 : 1))
      const isOpen = pane ? pane.key !== null && pane.key === s.chosen : s.open !== null && s.open === s.chosen
      d.key('return', isOpen ? 'to close' : opts.enter || 'to open', () => {
        const it = api.item()
        if (it) toggle(it)
      })
      if (o.ask) d.key('a', 'to ask', () => {
        const it = api.item()
        const q = it && o.ask(it)
        if (q) ask(q.ref, q.text)
      })
      function toggle(it) {
        const key = keyOf(it)
        if (pane) {
          // in a side pane, never under the row
          const was = pane.key === key
          if (was) pane.hide()
          else pane.show(key)
          if (!was && o.onOpen) o.onOpen(it)
          return
        }
        s.open = s.open === key ? null : key
        if (s.open !== null && o.onOpen) o.onOpen(it)
      }
    },
  }
  return api
}

// the track beside a list taller than its room (docs/terminal-views.md, "The list"): a column of the whole list, each
// cell its rows' commonest Color by hue (`▌`), the part in view on the selection background; a list many times its
// room adds the zoomed track at the outer edge, the part around the view at a finer scale; each of Color by's choices
// past the first (`tracks`) a column of its own before them, in its own hues. A click goes there.
const TRACKS_MAX = 3
function drawTrack(d, y0, shownRows, total, top, height, spans, items, valueOf, hueOf, tracks, go) {
  const rows = height
  const valueAtLine = new Array(total).fill(undefined)
  for (const [a, , i] of spans) if (!items[i].heading) valueAtLine[a] = valueOf ? valueOf(items[i]) ?? null : null
  const lanes = (tracks || []).map((t) => {
    const at = new Array(total).fill(undefined)
    for (const [a, , i] of spans) if (!items[i].heading) at[a] = t.valueOf(items[i]) ?? null
    return { at, hue: t.colourOf, title: t.title }
  })
  const cellIn = (at, hue, from, to) => {
    const counts = new Map()
    let any = false
    for (let y = Math.floor(from); y < Math.min(total, Math.ceil(to)); y++) {
      if (at[y] === undefined) continue
      any = true
      const k = at[y] === null ? '' : String(at[y])
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    if (!any) return { s: ' ' }
    let best = ''
    let bn = 0
    for (const [v, n] of counts) if (v !== '' && n > bn) [best, bn] = [v, n]
    const h = best ? hue(best) : null
    return h && h !== COLORS.dim ? { s: '▌', fg: h } : { s: '▌', d: true }
  }
  const cellOf = (from, to) => cellIn(valueAtLine, hueOf, from, to)
  const zoom = total > rows * 16
  const zFrom = Math.max(0, Math.min(total - rows * 4, top + height / 2 - rows * 2))
  const zLen = Math.min(total, rows * 4)
  for (let k = 0; k < rows; k++) {
    const line = d.lines[y0 + k]
    if (!line) break
    const a = (k / rows) * total
    const b = ((k + 1) / rows) * total
    const inView = b > top && a < top + height
    const cell = { ...cellOf(a, b), ...(inView ? { bg: COLORS.selected } : {}) }
    const n = lanes.length
    const runs = clipLine(line.runs, d.cols - 3 - n)
    const pad = d.cols - (zoom ? 2 : 1) - n - lineWidth(runs)
    const cells = [cell]
    if (zoom) {
      const za = zFrom + (k / rows) * zLen
      const zb = zFrom + ((k + 1) / rows) * zLen
      cells.unshift({ ...cellOf(za, zb), ...(zb > top && za < top + height ? { bg: COLORS.selected } : {}) })
    }
    cells.unshift(...lanes.map((l) => ({ ...cellIn(l.at, l.hue, a, b), ...(inView ? { bg: COLORS.selected } : {}) })))
    line.runs = merged([...runs, { s: ' '.repeat(Math.max(0, pad)) }, ...cells])
    for (let j = 0; j < n; j++) d.hits.push({ y: y0 + k, x0: d.cols - (zoom ? 2 : 1) - n + j, x1: d.cols - (zoom ? 2 : 1) - n + j + 1, on: () => go(Math.floor(a)), tip: `${lanes[j].title}: rows ${num(Math.floor(a) + 1)}-${num(Math.min(total, Math.ceil(b)))} of ${num(total)}` })
    const x = d.cols - (zoom ? 2 : 1)
    d.hits.push({ y: y0 + k, x0: x + (zoom ? 1 : 0), x1: x + (zoom ? 2 : 1), on: () => go(Math.floor(a)), tip: `rows ${num(Math.floor(a) + 1)}-${num(Math.min(total, Math.ceil(b)))} of ${num(total)}` })
    if (zoom) d.hits.push({ y: y0 + k, x0: x, x1: x + 1, on: () => go(Math.floor(zFrom + (k / rows) * zLen)), tip: 'the rows around the view' })
  }
  void shownRows
}

// ------------------------------------------------------------------------------------------------ columns and details

// the blocks of details a click on `… N more` opened whole, by where they stand and how they start
const openBlocks = new Set()

/**
 * Columns across a width: `specs` [{w, align: 'right', grow: true}], 2-cell gutters, a column that grows taking what
 * is left. `cells(row, values, styles)` adds the values to a Row, each cut to its column; `header(row, names, {sorted,
 * desc, onSort})` the columns' names, dim, `▼` (or `▲`) after the one sorted by, each a control that sorts by it.
 */
export function columns(specs, cols) {
  const fixed = specs.reduce((n, sp) => n + (sp.grow ? 0 : sp.w || 0), 0) + 2 * Math.max(0, specs.length - 1)
  const widths = specs.map((sp) => (sp.grow ? Math.max(sp.min || 8, cols - fixed) : sp.w || 0))
  return {
    widths,
    header(r, names, o = {}) {
      names.forEach((name, i) => {
        if (i) r.gap(2)
        const w = widths[i]
        const mark = o.sorted === i ? (o.desc === false ? ' ▲' : ' ▼') : ''
        const text = cut(String(name), Math.max(1, w - width(mark))) + mark
        const s = specs[i].align === 'right' ? padStart(text, w) : i === names.length - 1 ? text : pad(text, w)
        r.add(s, { d: true }, o.onSort ? { on: () => o.onSort(i), tip: `sort by ${name}` } : {})
      })
      return r
    },
    cells(r, values, styles = []) {
      values.forEach((v, i) => {
        if (i) r.gap(2)
        const w = widths[i]
        const text = String(v ?? '')
        const s = specs[i].align === 'right' ? padStart(text, w) : i === values.length - 1 ? cut(text, w) : pad(text, w)
        r.add(s, styles[i] || {})
      })
      return r
    },
  }
}

/**
 * A record's details, drawn into the inner drawing a list's `detail` gives (A2): `text` its words, wrapped (at most
 * `maxRows`); `blocks` [{text, code, max}] text as the record holds it, such as a command and what it printed or a
 * diff: its lines upright, each cut at the cell edge, at most `max` (8) rows and then `… N more`, which a click opens,
 * `code` in the code color (a command, a query, a path), `problem` in red (what a failed call printed); `facts` [[label, value]] on one row, the labels dim; `groups`
 * [{title, rows: [{when, words, text, on}]}], each row a link to another record; `raw` [[line, text]] its lines as the
 * file holds them; `place` its ref, a link with `↗`; `ask` {ref, text}, `ask about it`, shown only when there is no `place`, whose file view asks.
 */
export function details(d, o = {}) {
  if (o.text) for (const s of wrap(o.text, d.cols, o.maxRows || 6)) d.line(s)
  for (const b of o.blocks || []) {
    const lines = String(b.text ?? '').replace(/\s+$/, '').split('\n')
    if (!lines.join('').trim()) continue
    const key = `${d.y}:${lines.length}:${lines[0]}`
    const max = openBlocks.has(key) ? lines.length : Math.max(1, b.max || 8)
    const shown = lines.length > max + 1 ? lines.slice(0, max) : lines
    for (const l of shown) d.line(b.code ? { s: clip(l, d.cols), fg: COLORS.code } : b.problem ? { s: clip(l, d.cols), fg: COLORS.problem } : clip(l, d.cols))
    if (shown.length < lines.length) {
      const more = `… ${num(lines.length - shown.length)} more`
      d.row().add(more, { d: true }, { on: () => { openBlocks.add(key); redraw() }, tip: 'show every line' }).end()
    }
  }
  // the facts on one row, parted by ` · `; on the rows they need where one is too few, a fact never split
  const facts = (o.facts || []).filter(([, v]) => v !== null && v !== undefined && v !== '')
  let fr = null
  facts.forEach(([k, v]) => {
    const w = width(`${k} ${v}`)
    if (fr && fr.x + 3 + w > d.cols) {
      fr.end()
      fr = null
    }
    if (fr) fr.add(' · ', { d: true })
    else fr = d.row()
    fr.add(`${k} `, { d: true }).add(String(v))
  })
  if (fr) fr.end()
  for (const g of o.groups || []) {
    if (!g.rows || !g.rows.length) continue
    d.line([{ s: g.title, b: true }])
    const ww = Math.min(30, Math.floor(d.cols / 4), Math.max(0, ...g.rows.map((x) => width(x.words || ''))))
    for (const x of g.rows) {
      const r = d.row()
      if (x.when) r.add(x.when, { d: true }).gap()
      if (ww) r.add(pad(cut(x.words || '', ww), ww), { d: true }).gap()
      r.add(cut(x.text || '', Math.max(4, r.room)), {}, x.on ? { on: x.on, tip: x.tip || 'open it in the list' } : {})
      r.end()
    }
  }
  if (o.raw && o.raw.length) {
    const nw = Math.max(...o.raw.map(([n]) => String(n).length))
    for (const [n, text] of o.raw) d.row().add(padStart(n, nw), { d: true }).gap().add(clip(text, d.cols - nw - 2)).end()
  }
  // a record with a place asks from its file view (↗), so `ask about it` shows only for a record without one
  if (o.place) {
    const words = placeIn(o.place, d.cols - 2)
    d.row()
      .add('↗ ', { fg: COLORS.link }, { on: () => open(o.place), tip: 'open its lines' })
      .add(words, { fg: COLORS.link, u: true }, { on: () => open(o.place), tip: 'open its lines' })
      .end()
  } else if (o.ask) d.row().add('ask about it', {}, { on: () => ask(o.ask.ref, o.ask.text), tip: 'ask a side thread about this record' }).end()
}

// ------------------------------------------------------------------------------------------------ search and choices

/**
 * A search field in a row: `/ search` until it is used; `/` or a click starts typing, which the panel's field takes (each
 * change of its text reaches the search whole; Enter ends); onChange(text) after each change.
 */
export function search(opts = {}) {
  const s = { text: '', typing: false }
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {}
  const words = opts.words || 'search'
  const set = (t) => {
    s.text = t
    onChange(t)
    redraw()
  }
  const api = {
    get text() {
      return s.text
    },
    get typing() {
      return s.typing
    },
    set(t) {
      set(String(t ?? ''))
    },
    /** The field added to a row. */
    add(r) {
      const start = () => {
        s.typing = true
        redraw()
      }
      r.add('/ ', s.typing ? {} : { d: true }, { on: start, tip: 'search: type, then Enter' })
      if (s.text || s.typing) r.add(cut(s.text, Math.max(6, Math.min(40, r.room - 4))), {}, { on: start })
      else r.add(words, { d: true }, { on: start, tip: 'search: type, then Enter' })
      if (s.typing) {
        r.add(' ', { inv: true })
        r.d.typing({
          text: s.text,
          onText: (t) => set(t),
          onKey: (k) => {
            if (k === 'return') s.typing = false
            else if (k === 'backspace') {
              if (!s.text) s.typing = false
              else set([...s.text].slice(0, -1).join(''))
            } else if (k.length === 1) set(s.text + k)
            redraw()
          },
          hints: ['Enter to finish'],
        })
      } else r.d.key('/', 'to search', start)
      return r
    },
  }
  state.resets.push({ changed: () => Boolean(s.text), reset: () => { s.text = ''; s.typing = false }, after: () => onChange('') })
  return api
}

/**
 * A choice among values in a row (`incident  INC-312`): its title dim, the value chosen a control that opens a menu
 * of `all` (the words for no choice) and the values; `key` the letter that opens it; onChange(value), null for all.
 * A value is a string or `{name, value, right, indent}`: `right` dim against R in the menu, `indent` the levels (2 cells
 * each) its menu row stands in, for a tree such as runs and their sessions; the row shows its name alone.
 * With `all: false` the menu holds the values alone (the kind of record a view lists): the choice opens on `initial`,
 * else the first value, and Reset puts it back there.
 */
export function choice(opts = {}) {
  const valueOf = (v) => (v !== null && typeof v === 'object' ? v.value ?? v.name : v)
  const some = opts.all !== false
  const first = some ? null : opts.initial !== undefined ? opts.initial : Array.isArray(opts.values) && opts.values.length ? valueOf(opts.values[0]) : null
  const s = { value: first, values: Array.isArray(opts.values) ? opts.values.slice() : [] }
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {}
  const all = opts.all || 'all'
  const api = {
    get value() {
      return s.value
    },
    set values(v) {
      s.values = Array.isArray(v) ? v.slice() : []
    },
    get values() {
      return s.values.slice()
    },
    /** Choose a value (null for all, or the first with `all: false`); onChange follows. */
    set(v) {
      const next = v === undefined || v === null ? first : v
      if (next === s.value) return
      s.value = next
      onChange(next)
      redraw()
    },
    add(r) {
      const items = () => [...(some ? [{ name: all, v: null }] : []), ...s.values.map((v) => (typeof v === 'object' ? { name: v.name, v: valueOf(v), right: v.right, indent: v.indent } : { name: String(v), v }))]
      const open = () => toggleMenu(api, Math.max(0, items().findIndex((it) => it.v === s.value)))
      if (opts.title) r.add(opts.title, { d: true }).gap()
      const shown = items().find((it) => it.v === s.value)
      r.add(shown ? shown.name : some ? all : String(s.value ?? ''), {}, { on: open, tip: opts.tip || `choose ${opts.title || 'one'}` })
      if (opts.key) r.d.key(opts.key, `for ${opts.title || 'the choice'}`, open)
      r.menus.push((d) => drawMenu(d, api, items(), (it) => it && api.set(it.v), opts.key || null, 'to select', opts.title || ''))
      return r
    },
  }
  state.resets.push({ changed: () => s.value !== first, reset: () => { s.value = first }, after: () => onChange(first) })
  return api
}

// ------------------------------------------------------------------------------------------------ the side pane

/**
 * A side pane for a record or a row's children (docs/terminal-views.md, "The side pane"): beside the list where the
 * panel is wide enough for both, a `│` in the rule gray between them, else under the list. A list drawn with `side`
 * opens its items here, never under the row. `<` `>` narrow and widen it (thimble keeps its width per view), Backspace
 * or `close` closes it.
 *
 * opts: key (the name it is kept under), width (its share of the panel's width, 0.42 by default), min (its least cells).
 */
export function side(opts = {}) {
  const name = opts.key || 'side'
  const keptShare = (kept('side') || {})[name]
  const st = { open: null, share: typeof keptShare === 'number' ? keptShare : Number(opts.width) > 0 && Number(opts.width) < 1 ? Number(opts.width) : 0.42 }
  const min = Math.max(24, Number(opts.min) || 34)
  const LIST_MIN = 40 // the list keeps this many cells beside the pane, else the pane goes under it
  const api = {
    /** Whether the pane shows. */
    get isOpen() {
      return st.open !== null
    },
    /** The key of the item it shows, or null. */
    get key() {
      return st.open
    },
    show(key) {
      st.open = key === undefined ? null : key
      redraw()
    },
    hide() {
      st.open = null
      redraw()
    },
    /** The rows left laid out: `left(dl)` draws the list, `right(ds)` the item's details under the pane's title row
     *  (`o.title`, bold, and `close` against R). */
    draw(d, left, right, o = {}) {
      if (st.open === null) return left(d)
      const rows = d.left
      const w = Math.max(min, Math.min(d.cols - LIST_MIN - 3, Math.round(d.cols * st.share)))
      const head = (dr) => {
        const hr = dr.row()
        hr.add(cut(String(o.title || 'details'), Math.max(4, dr.cols - 7)), { b: true })
        hr.right('close', {}, { on: () => api.hide(), tip: 'close the details' })
        hr.end()
      }
      if (d.cols - w - 3 >= LIST_MIN) {
        const L = new Drawing(d.cols - w - 3, rows, d, 0)
        const R = new Drawing(w, rows, d, 0)
        left(L)
        head(R)
        right(R)
        const y0 = d.y
        const n = Math.min(rows, Math.max(L.lines.length, R.lines.length))
        for (let y = 0; y < n; y++) {
          const l = L.lines[y]
          const r = R.lines[y]
          const lr = l ? clipLine(l.runs, L.cols) : []
          const rr = r ? fitLine(r.runs, R.cols) : []
          d.lines.push({ margin: l ? l.margin : null, runs: merged([...lr, { s: ' '.repeat(L.cols - lineWidth(lr) + 1) }, { s: '│', fg: COLORS.rule }, { s: ' ' }, ...rr]) })
        }
        for (const h of L.hits) if (h.y < n) d.hits.push({ ...h, y: h.y + y0 })
        for (const h of R.hits) if (h.y < n) d.hits.push({ ...h, y: h.y + y0, x0: h.x0 + L.cols + 3, x1: Math.min(h.x1, R.cols) + L.cols + 3 })
        d.key(['<', '>'], 'to resize the details', (k) => {
          st.share = Math.max(0.2, Math.min(0.75, st.share + (k === '<' ? 0.05 : -0.05)))
          keep('side', { ...(kept('side') || {}), [name]: Math.round(st.share * 100) / 100 })
        })
      } else {
        // too narrow for both: the list over the pane, a rule between them
        const top = Math.max(3, Math.floor((rows - 1) * 0.45))
        const L = new Drawing(d.cols, top, d, 0)
        left(L)
        d.put(L, 0, Math.min(top, L.lines.length))
        d.rule()
        const R = d.inner(0, Math.max(1, rows - top - 1))
        head(R)
        right(R)
        d.put(R, 0, Math.min(R.rows, R.lines.length))
      }
      d.key('backspace', 'to close the details', () => api.hide())
    },
  }
  state.resets.push({ changed: () => st.open !== null, reset: () => { st.open = null } })
  return api
}

// ------------------------------------------------------------------------------------------------ the divider

/**
 * The divider between the overview and the detail list: `{` `}` give the overview fewer or more rows, and thimble keeps
 * its share per view. `rows(d, fallback)` gives the overview's rows of the rows left (`fallback` until a key moved it)
 * and binds the keys.
 *
 * opts: key (the name it is kept under), min (the least rows of each side, 3).
 */
export function divider(opts = {}) {
  const name = opts.key || 'overview'
  const keptShare = (kept('divider') || {})[name]
  const st = { share: typeof keptShare === 'number' ? keptShare : null }
  const min = Math.max(1, Number(opts.min) || 3)
  return {
    get share() {
      return st.share
    },
    rows(d, fallback) {
      const total = d.left
      const fit = (n) => Math.max(Math.min(min, total), Math.min(total - min, Math.round(n)))
      const n = fit(st.share === null ? fallback : st.share * total)
      d.key(['{', '}'], 'to resize the overview', (k) => {
        st.share = Math.max(0.05, Math.min(0.95, (fit(n + (k === '}' ? 2 : -2))) / Math.max(1, total)))
        keep('divider', { ...(kept('divider') || {}), [name]: Math.round(st.share * 1000) / 1000 })
      })
      return n
    },
  }
}

// ------------------------------------------------------------------------------------------------ Filter by and Rows

// the classes of a label that color or group, as Color by's chips (a regex label's `other` is not one)
function labelClasses(l) {
  const vs = (l && l.values) || []
  const known = vs.some((v) => v && 'highlight' in v)
  return (known ? vs.filter((v) => v.highlight !== false) : vs.length > 1 ? vs.slice(0, -1) : vs).map((v) => String(v.name))
}

// How Filter by or Rows opens until the analyst chooses (`initial`): a field's name, or a list of choices, the first there
// taken, each a field's name or {label: name or id}, a label counting while it is on in Files; else `fallback`. A
// function, so that the choice follows the labels as they come and go.
function opening(opts, fallback) {
  const init = opts.initial
  const starts = Array.isArray(init) ? init : init && typeof init === 'object' ? [init] : init ? [init] : []
  const fields = opts.fields || []
  const norm = (x) => String(x ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const findLabel = (x) => {
    const byId = state.labels.find((l) => String(l.id) === String(x))
    if (byId) return byId
    const named = state.labels.filter((l) => norm(l.name) === norm(x))
    return named.find((l) => l.here !== false) || named[0] || null
  }
  return () => {
    for (const s of starts) {
      if (typeof s === 'string' && fields.some((f) => f.name === s)) return `field:${s}`
      if (s && typeof s === 'object' && s.label !== undefined && s.label !== null) {
        const l = findLabel(s.label)
        if (l && l.on) return `label:${l.id}`
      }
    }
    return fallback
  }
}

// a tally's counts as one string, to tell whether they changed
const tallySig = (t) => JSON.stringify([...t].map(([k, m]) => [k, [...m]]))

// What Filter by and Rows share: the view's fields and every label, the one chosen (`field:<name>`, `label:<id>` or
// `none`), kept per view under `name`, a record's value under it, read as Color by reads it, and the values the records
// drawn take, counted per drawing for the menu's words.
function chooser(opts, name, initial) {
  const fields = (opts.fields || []).map((f) => ({ ...f, title: f.title || f.name }))
  const keptC = kept(name) || {}
  // how it opens: a key, or a function of the labels (`initial` naming a label), followed until the analyst chooses
  const home = typeof initial === 'function' ? initial : () => initial
  const c = {
    choice: typeof keptC.by === 'string' ? keptC.by : home(),
    chosen: typeof keptC.by === 'string',
    off: keptC.off && typeof keptC.off === 'object' ? { ...keptC.off } : {},
    counts: null,
    tally: new Map(),
    tallied: new Map(),
    tallyAt: -1,
    seen: new Set(),
    drawnSig: null, // the counts the toggles last drew, null while none drew any
  }
  const fieldOf = (key) => fields.find((f) => `field:${f.name}` === key) || null
  const labelOf = (key) => state.labels.find((l) => `label:${l.id}` === key) || null
  const settle = () => {
    if (!c.chosen) c.choice = home()
    if (c.choice === 'none' || fieldOf(c.choice) || labelOf(c.choice)) return
    c.choice = home()
  }
  settle()
  state.labelWants.push(() => (labelOf(c.choice) ? [labelOf(c.choice).id] : []))
  const ch = {
    c,
    fields,
    fieldOf,
    labelOf,
    settle,
    save(extra = {}) {
      c.chosen = true
      keep(name, { by: c.choice, ...extra })
    },
    /** {field, title} or {label, title}, or null for none */
    by() {
      const f = fieldOf(c.choice)
      if (f) return { field: f.name, title: f.title }
      const l = labelOf(c.choice)
      return l ? { label: l.id, title: l.name } : null
    },
    valueOf(record, key = c.choice) {
      if (record === null || record === undefined) return null
      const f = fieldOf(key)
      if (f) {
        const v = typeof f.value === 'function' ? f.value(record) : record[f.name]
        return v === undefined || v === null || v === '' || typeof v === 'object' ? null : String(v)
      }
      const l = labelOf(key)
      return l ? labelValue(l.id, record) : null
    },
    tally(record) {
      if (!record || typeof record !== 'object') return
      if (c.tallyAt !== state.drawNo) {
        if (c.tally.size) c.tallied = c.tally
        c.tally = new Map()
        c.seen = new Set()
        c.tallyAt = state.drawNo
        // the toggles drew the counts of the drawing before: once this one is drawn, a change draws again
        queueMicrotask(() => {
          if (c.drawnSig !== null && tallySig(c.tally) !== c.drawnSig) {
            c.drawnSig = null
            redraw()
          }
        })
      }
      if (c.seen.has(record)) return
      c.seen.add(record)
      for (const f of fields) {
        const k = ch.valueOf(record, `field:${f.name}`) ?? ''
        const m = c.tally.get(f.name) || new Map()
        m.set(k, (m.get(k) || 0) + 1)
        c.tally.set(f.name, m)
      }
      const l = labelOf(c.choice)
      if (l) {
        const k = ch.valueOf(record) ?? ''
        const m = c.tally.get(`label:${l.id}`) || new Map()
        m.set(k, (m.get(k) || 0) + 1)
        c.tally.set(`label:${l.id}`, m)
      }
    },
    // the records of the last whole drawing, counted: while a drawing counts, the one before it
    lastTally() {
      return c.tallyAt === state.drawNo ? c.tallied : c.tally
    },
    // the counts of the choice's values: the reader's (counts()), else those of the records last drawn
    counts() {
      if (c.counts) return c.counts
      const f = fieldOf(c.choice)
      const l = labelOf(c.choice)
      const last = ch.lastTally()
      c.drawnSig = tallySig(last)
      const t = last.get(f ? f.name : l ? `label:${l.id}` : '')
      return t ? Object.fromEntries(t) : {}
    },
    // the choice's values in order: a label's classes, else the field's declared values and those its records take,
    // the commonest first; then '' for no value where a record takes none
    values(counts = ch.counts()) {
      const l = labelOf(c.choice)
      const f = fieldOf(c.choice)
      const out = []
      if (l) out.push(...labelClasses(l))
      else if (f) {
        out.push(...(f.values || []).map((v) => String(typeof v === 'object' ? v.name : v)))
        for (const v of Object.keys(counts).filter((k) => k !== '' && !out.includes(k)).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))) out.push(v)
      }
      if (counts[''] || (l && !Object.keys(counts).length)) out.push('')
      return out
    },
    nameOf(v) {
      if (v === '' || v === null || v === undefined) {
        const f = fieldOf(c.choice)
        return f ? `no ${f.title.toLowerCase()}` : 'not marked'
      }
      const f = fieldOf(c.choice)
      return f && typeof f.nameOf === 'function' ? String(f.nameOf(v) ?? v) : String(v)
    },
    meaningOf(v) {
      const f = fieldOf(c.choice)
      if (f) return (f.meanings && f.meanings[v]) || f.description || ''
      const l = labelOf(c.choice)
      const lv = l && (l.values || []).find((x) => x.name === v)
      return (lv && lv.meaning) || ''
    },
    // the menu: none, the fields with their values in words, the labels with theirs and their definition one step away
    menuItems() {
      const words = (names) => (names.length ? [{ s: names.slice(0, 16).join(' · '), d: true }] : [])
      const items = [{ key: 'none', name: 'none', chips: [] }]
      for (const f of fields) {
        const t = ch.lastTally().get(f.name)
        const seen = t ? [...t.entries()].filter(([v]) => v !== '').sort((a, b) => b[1] - a[1]).map(([v]) => v) : []
        const declared = (f.values || []).map((v) => String(typeof v === 'object' ? v.name : v))
        const names = [...new Set([...declared, ...seen])].map((v) => (typeof f.nameOf === 'function' ? String(f.nameOf(v) ?? v) : v))
        items.push({ key: `field:${f.name}`, name: f.title, chips: words(names), about: (w) => wrap(f.description || '', w, 2).filter(Boolean).map((s) => [{ s, d: true }]) })
      }
      const ls = [...state.labels].sort((a, b) => Number(Boolean(b.here)) - Number(Boolean(a.here)))
      if (ls.length) items.push({ heading: true, name: 'labels' })
      for (const l of ls) {
        items.push({
          key: `label:${l.id}`,
          name: l.name,
          chips: words([...labelClasses(l), 'not marked']),
          right: l.kind || '',
          about: (w) => {
            const text = l.text || l.spec || ''
            const rows = text ? wrap(`${l.kind ? `${l.kind} · ` : ''}"${oneLine(text)}"`, w, 2).map((s) => [{ s, d: true }]) : []
            const row = []
            row.push({ s: 'definition', fg: COLORS.link, u: true }, { s: ' ↗', fg: COLORS.link })
            row.hits = [{ x0: 0, x1: width('definition ↗'), on: () => openLabel(l.id), tip: "the label's panel: its definition, its runs and its records" }]
            rows.push(row)
            return rows
          },
        })
      }
      return items
    },
  }
  return ch
}

/**
 * Filter by: which rows show, by a field of the view or a label (docs/terminal-views.md, "Filter by and Rows"). In the
 * top row, `Filter by  Outcome` and the chosen one's values as toggles, `●` while a value shows and `○` while it is off,
 * never in a hue (only Color by colors); `f`, or a click on the choice, opens its menu. The page hides a record whose
 * value is off (`keeps`), or sends `query()` to its reader, which takes it as Color by's.
 *
 * opts: fields [{name, title, description?, values?, meanings?, value?(record), nameOf?(value)}], initial (a field's
 * name; none by default), key (the name it is kept under), onChange(filter).
 */
export function filterBy(opts = {}) {
  const name = opts.key ? `filter:${opts.key}` : 'filter'
  const ch = chooser(opts, name, opening(opts, 'none'))
  const c = ch.c
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {}
  const offOf = () => new Set((c.off[c.choice] || []).map((v) => (v === null ? '' : String(v))))
  const save = () => ch.save({ off: c.off })
  const changed = () => {
    save()
    onChange(api)
    redraw()
  }
  const api = {
    get by() {
      return ch.by()
    },
    get field() {
      const b = ch.by()
      return b && b.field ? b.field : null
    },
    get label() {
      const b = ch.by()
      return b && b.label ? b.label : null
    },
    /** The toggles: `[{value, name, on, n}]`, value null for no value. */
    get values() {
      const counts = ch.counts()
      const off = offOf()
      return ch.values(counts).map((v) => ({ value: v === '' ? null : v, name: ch.nameOf(v), on: !off.has(v), n: counts[v] || 0 }))
    },
    valueOf(record) {
      ch.tally(record)
      return ch.valueOf(record)
    },
    isOn(value) {
      return !offOf().has(value === null || value === undefined ? '' : String(value))
    },
    /** Whether a record shows: its value is on (every record with none). */
    keeps(record) {
      ch.tally(record)
      if (c.choice === 'none') return true
      return api.isOn(ch.valueOf(record))
    },
    tally(record) {
      ch.tally(record)
    },
    /** The choice for the reader, as Color by's: `{field, off}`, `{label, name, off}`, or null for none. */
    query() {
      const b = ch.by()
      if (!b) return null
      const off = [...offOf()].map((v) => (v === '' ? null : v))
      return b.label ? { label: b.label, name: b.title, off } : { field: b.field, off }
    },
    /** The reader's counts of the choice's values (`''` for no value); null counts the records drawn again. */
    counts(map) {
      c.counts = map && typeof map === 'object' ? { ...map } : null
      redraw()
    },
    /** Choose a field by name, a label (`{label}`), or none (null). */
    choose(to) {
      const key = to === null ? 'none' : typeof to === 'object' ? `label:${to.label}` : `field:${to}`
      if (key === c.choice && c.chosen) return
      c.choice = key
      c.chosen = true
      c.counts = null
      ch.settle()
      changed()
    },
    /** Turn a value off or on. */
    toggle(value) {
      const k = value === null || value === undefined ? '' : String(value)
      const off = offOf()
      if (off.has(k)) off.delete(k)
      else off.add(k)
      c.off[c.choice] = [...off]
      changed()
    },
    /** Filter by on a row: its name, the choice, and the values that fit in `o.max` cells (the row's room), `+N` for
     *  the rest, which opens the menu. */
    add(r, o = {}) {
      const room = Math.min(r.room, o.max ?? r.room)
      const x0 = r.x
      const b = ch.by()
      const open = () => toggleMenu(api, Math.max(0, ch.menuItems().findIndex((it) => it.key === c.choice)))
      r.add('Filter by', { d: true }).gap()
      r.add(b ? b.title : 'none', {}, { on: open, tip: 'choose which rows show: a field or a label', max: Math.max(4, room - 12) })
      if (b && b.label) r.add(' ').add('↗', { fg: COLORS.link }, { on: () => openLabel(b.label), tip: "the label's panel: its definition, its runs and its records" })
      const vals = b ? api.values : []
      const chipRuns = (v) => [v.on ? { s: '●' } : { s: '○', d: true }, { s: ' ' }, v.on ? { s: v.name } : { s: v.name, d: true }, ...(v.n ? [{ s: ` ${num(v.n)}`, d: true }] : [])]
      let k = 0
      let used = r.x - x0
      for (const v of vals) {
        const w = 2 + lineWidth(chipRuns(v)) + (k < vals.length - 1 ? 2 + width(`+${vals.length - k - 1}`) : 0)
        if (used + w > room) break
        r.gap()
        const cx = r.x
        for (const run of chipRuns(v)) r.add(run.s, run)
        const m = ch.meaningOf(v.value ?? '')
        r.hits.push({ x0: cx, x1: r.x, on: () => api.toggle(v.value), tip: `${v.name}${m ? `: ${m}` : ''}${v.on ? ': a click hides its rows' : ' (hidden): a click shows its rows'}` })
        used = r.x - x0
        k++
      }
      if (k < vals.length) r.gap().add(`+${vals.length - k}`, { d: true }, { on: open, tip: `${plural(vals.length - k, 'more value')}: open Filter by` })
      r.d.key('f', 'to filter by', open, false, 1)
      r.menus.push((dd) => drawMenu(dd, api, ch.menuItems(), (it) => it && api.choose(it.key === 'none' ? null : it.key.startsWith('label:') ? { label: it.key.slice(6) } : it.key.slice(6)), 'f', 'to filter by', 'Filter by'))
      return r
    },
  }
  state.colorBys.push(() => {
    ch.settle()
    if (ch.by() && ch.by().label) onChange(api)
  })
  state.resets.push({
    changed: () => offOf().size > 0,
    reset: () => {
      c.off = {}
      save()
    },
    after: () => onChange(api),
  })
  return api
}

/**
 * Rows: what the lanes or rows are grouped by, a field of the view or a label (docs/terminal-views.md, "Filter by and
 * Rows"). In the top row, `Rows  Session`; `g`, or a click, opens its menu. `groups(items)` gives the groups in order:
 * a label's classes (each one, so a class added to the label is a new lane), else the field's values, then the records
 * with no value; a field with `parentOf(key)` is a tree, each group under its parent with its guide (`├ ` `└ ` `│ `),
 * a parent no record takes a heading.
 *
 * opts: fields [{name, title, value?(record), nameOf?(key), parentOf?(key)}], initial (the first field by default),
 * key (the name it is kept under), onChange(rows).
 */
export function rows(opts = {}) {
  const name = opts.key ? `rows:${opts.key}` : 'rows'
  const ch = chooser(opts, name, opening(opts, opts.fields && opts.fields.length ? `field:${opts.fields[0].name}` : 'none'))
  const c = ch.c
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {}
  // a record the reader gave its group under the choice keeps it (`group`)
  const groupOf = (record) => (record && typeof record === 'object' && 'group' in record ? (record.group === null || record.group === undefined || record.group === '' ? null : String(record.group)) : ch.valueOf(record))
  const api = {
    get by() {
      return ch.by()
    },
    get field() {
      const b = ch.by()
      return b && b.field ? b.field : null
    },
    get label() {
      const b = ch.by()
      return b && b.label ? b.label : null
    },
    groupOf(record) {
      ch.tally(record)
      return groupOf(record)
    },
    /** The groups of the items, in order: `[{key, value, name, depth, guide, last, heading, parent, children, items}]`. */
    groups(items = []) {
      if (c.choice === 'none') return [{ key: '*', value: null, name: 'all', depth: 0, guide: '', last: true, heading: false, parent: null, children: 0, items: items.slice() }]
      const by = new Map()
      for (const it of items) {
        ch.tally(it)
        const k = groupOf(it) ?? ''
        if (!by.has(k)) by.set(k, [])
        by.get(k).push(it)
      }
      const node = (k, depth, heading = false) => ({ key: k, value: k === '' ? null : k, name: ch.nameOf(k), depth, guide: '', last: true, heading, parent: null, children: 0, items: by.get(k) || [] })
      const l = ch.labelOf(c.choice)
      if (l) {
        const out = labelClasses(l).map((k) => node(k, 0))
        for (const k of by.keys()) if (k !== '' && !out.some((n) => n.key === k)) out.push(node(k, 0))
        if (by.has('') || !out.length) out.push(node('', 0))
        return out
      }
      const f = ch.fieldOf(c.choice)
      if (!f || typeof f.parentOf !== 'function') {
        const order = (f && f.values ? f.values.map((v) => String(typeof v === 'object' ? v.name : v)) : []).filter((k) => by.has(k))
        for (const k of by.keys()) if (k !== '' && !order.includes(k)) order.push(k)
        const out = order.map((k) => node(k, 0))
        if (by.has('')) out.push(node('', 0))
        return out
      }
      // a tree: the groups with records and the parents above them, siblings in the order their records first come
      const parent = new Map()
      const rank = new Map([...by.keys()].map((k, i) => [k, i]))
      for (const k0 of by.keys()) {
        let k = k0
        const seen = new Set()
        while (k !== null && !seen.has(k)) {
          seen.add(k)
          const p = k === '' ? null : f.parentOf(k)
          const pk = p === null || p === undefined || p === '' ? null : String(p)
          parent.set(k, pk)
          k = pk
        }
      }
      const kids = new Map()
      const roots = []
      for (const [k, p] of parent) {
        if (p !== null && parent.has(p) && p !== k) kids.set(p, [...(kids.get(p) || []), k])
        else roots.push(k)
      }
      const place = (k, seen = new Set()) => {
        if (rank.has(k)) return rank.get(k)
        if (seen.has(k)) return Infinity
        seen.add(k)
        return Math.min(Infinity, ...(kids.get(k) || []).map((x) => place(x, seen)))
      }
      const order = (a, b) => (a === '' ? 1 : b === '' ? -1 : place(a) - place(b))
      const out = []
      const walk = (k, depth, lead, last, p) => {
        const n = node(k, depth, !by.has(k))
        n.parent = p
        n.last = last
        n.guide = depth ? `${lead}${last ? '└ ' : '├ '}` : ''
        const ks = (kids.get(k) || []).slice().sort(order)
        n.children = ks.length
        out.push(n)
        ks.forEach((x, i) => walk(x, depth + 1, depth ? `${lead}${last ? '  ' : '│ '}` : '', i === ks.length - 1, k))
      }
      for (const k of roots.sort(order)) walk(k, 0, '', true, null)
      return out
    },
    /** The choice for the reader: `{field}`, `{label, name}`, or null; thimble.colour_value(rows, ref, record) gives a
     *  record's group there. */
    query() {
      const b = ch.by()
      return b ? (b.label ? { label: b.label, name: b.title } : { field: b.field }) : null
    },
    choose(to) {
      const key = to === null ? 'none' : typeof to === 'object' ? `label:${to.label}` : `field:${to}`
      if (key === c.choice && c.chosen) return
      c.choice = key
      c.chosen = true
      ch.settle()
      ch.save()
      onChange(api)
      redraw()
    },
    /** Rows on a row: its name and the choice, which opens the menu. */
    add(r) {
      const b = ch.by()
      const open = () => toggleMenu(api, Math.max(0, ch.menuItems().findIndex((it) => it.key === c.choice)))
      r.add('Rows', { d: true }).gap()
      r.add(b ? b.title : 'none', {}, { on: open, tip: 'choose what the lanes are grouped by: a field or a label', max: Math.max(4, r.room - 2) })
      if (b && b.label) r.add(' ').add('↗', { fg: COLORS.link }, { on: () => openLabel(b.label), tip: "the label's panel: its definition, its runs and its records" })
      r.d.key('g', 'for rows', open, false, 1)
      r.menus.push((dd) => drawMenu(dd, api, ch.menuItems(), (it) => it && api.choose(it.key === 'none' ? null : it.key.startsWith('label:') ? { label: it.key.slice(6) } : it.key.slice(6)), 'g', 'to group by', 'Rows'))
      return r
    },
  }
  // a label's classes or its values changed: its lanes are grouped again
  state.colorBys.unshift(() => {
    const was = c.choice
    ch.settle()
    if ((ch.by() && ch.by().label) || c.choice !== was) onChange(api)
  })
  // the label the lanes are grouped by takes no color when it is turned on: the lanes keep Color by's own choice
  state.holds.push(() => (ch.labelOf(c.choice) ? [ch.labelOf(c.choice).id] : []))
  for (const f of state.rehome) f()
  return api
}

// ------------------------------------------------------------------------------------------------ lanes

/**
 * The overview as lanes on the time range's scale (docs/terminal-views.md, "Lanes"): a lane per group of Rows, its name
 * in the gutter at the left with its tree guide (a top group's `▾` `▸` folds the lanes under it into its own), its
 * records' bars in the Color by hues on one height, `─` in the rule gray where it ran (`band`) and in a record's hue
 * while that record ran (`end`), and `×` in red where most of a cell's records failed (`problem`). Under the pointer a
 * lane marks only its cell, `┊` or the bar in the text color, with the cell's time and records in the tip; a click opens
 * the record nearest there (`onMark`), a click on a name chooses the lane (`onPick`). The list's rows in view are on the
 * selection background across the lanes (`span`, or a list's `span()`). `legend()` is the key for `axis`, each entry a
 * toggle that hides or shows its series.
 *
 * opts: rows (a Rows control) or groups(items), colour (Color by; the view's by default), time(item), end(item),
 * band(lane) [[start, end]], problem(item), onPick(lane), onMark(item), words {band, problem, record}, key.
 */
const EVENT = '▌' // a lane's cell that holds a record, while the lanes draw Events rather than density

export function lanes(opts = {}) {
  const name = opts.key ? `lanes:${opts.key}` : 'lanes'
  const keptL = kept(name) || {}
  const st = {
    chosen: null,
    off: new Set(Array.isArray(keptL.off) ? keptL.off : []),
    folded: new Map(Array.isArray(keptL.folded) ? keptL.folded : []), // key -> true (folded by hand) or false (unfolded)
    top: 0,
    shown: [],
    counts: { band: 0, problem: 0 },
  }
  const words = { band: 'running', problem: 'failed', record: 'record', ...(opts.words || {}) }
  const time = typeof opts.time === 'function' ? opts.time : (it) => (it.t ?? it.time)
  const save = () => keep(name, { off: [...st.off], folded: [...st.folded] })
  const isOn = (series) => !st.off.has(series)
  const toggle = (series) => {
    if (st.off.has(series)) st.off.delete(series)
    else st.off.add(series)
    save()
    redraw()
  }
  // the lanes in `room` rows: a top group with children folds by itself, the largest first, until they fit, the
  // analyst's ▸ ▾ first; then the rows past the room wait behind `… N more`
  function layout(items, room) {
    const nodes = typeof opts.groups === 'function' ? opts.groups(items) : opts.rows ? opts.rows.groups(items) : [{ key: '*', name: 'all', depth: 0, guide: '', items: items.slice(), children: 0 }]
    const tops = nodes.filter((n) => n.depth === 0 && n.children)
    const below = (n) => {
      const i = nodes.indexOf(n)
      let k = i + 1
      while (k < nodes.length && nodes[k].depth > 0) k++
      return nodes.slice(i + 1, k)
    }
    const fold = new Map(tops.map((n) => [n.key, st.folded.get(n.key) === true]))
    const need = () => nodes.filter((n) => n.depth === 0 || !fold.get(topOf(n))).length
    const topOf = (n) => {
      let i = nodes.indexOf(n)
      while (i > 0 && nodes[i].depth > 0) i--
      return nodes[i].key
    }
    for (const t of [...tops].sort((a, b) => below(b).length - below(a).length)) {
      if (need() <= room) break
      if (st.folded.get(t.key) !== false) fold.set(t.key, true)
    }
    const out = []
    for (const n of nodes) {
      if (n.depth > 0 && fold.get(topOf(n))) continue
      const folded = n.depth === 0 && Boolean(fold.get(n.key))
      out.push({ ...n, folded, items: folded ? [...(n.items || []), ...below(n).flatMap((x) => x.items || [])] : n.items || [] })
    }
    return out
  }
  function cells(scale, n, max, span, colour, dense) {
    const out = Array.from({ length: scale.cols }, () => ({ s: ' ' }))
    const gaps = scale.gaps ? scale.gaps() : []
    const inGap = (x) => gaps.some(([g0, g1]) => x >= g0 && x < g1)
    const fill = (a, b, run) => {
      if (b < scale.from || a > scale.to) return
      for (let x = scale.x(Math.max(a, scale.from)); x <= scale.x(Math.min(b, scale.to)); x++) if (!inGap(x)) out[x] = run
    }
    if (typeof opts.band === 'function' && !(n.heading && !n.folded)) {
      const spans = opts.band(n) || []
      if (spans.length) st.counts.band++
      if (isOn('band')) for (const [a, b] of spans) fill(a, b, { s: '─', fg: COLORS.rule })
    }
    const its = n.items.filter((it) => !colour || colour.keeps(it))
    if (typeof opts.end === 'function')
      for (const it of its) {
        const e = opts.end(it)
        if (!(e > time(it)) || e - time(it) < scale.step) continue
        const hue = colour ? colour.colourOf(colour.valueOf(it)) : null
        fill(time(it), e, hue && hue !== COLORS.dim ? { s: '─', fg: hue } : { s: '─', d: true })
      }
    // Density: each cell's bar its records on the lanes' one height; Events: a mark in every cell that holds a record
    strip(scale, its, { value: (it) => (colour ? colour.valueOf(it) : null), colour, max, time }).forEach((run, x) => {
      if (run.s !== ' ') out[x] = dense ? run : { ...run, s: EVENT }
    })
    const per = new Map()
    for (const it of its) {
      const x = scale.binOf(time(it))
      if (x < 0) continue
      const [k, bad] = per.get(x) || [0, 0]
      per.set(x, [k + 1, bad + (typeof opts.problem === 'function' && opts.problem(it) ? 1 : 0)])
    }
    for (const [x, [k, bad]] of per) {
      if (!bad) continue
      st.counts.problem += bad
      if (isOn('problem') && bad * 2 >= k) out[x] = { s: '×', fg: COLORS.problem }
    }
    if (span) {
      const a = scale.binOf(Math.max(span[0], scale.from))
      const b = scale.binOf(Math.min(span[1], scale.to))
      if (span[1] >= scale.from && span[0] <= scale.to) for (let x = Math.max(0, a); x <= Math.max(a, b); x++) out[x] = { ...out[x], bg: COLORS.selected }
    }
    const tips = Array.from({ length: scale.cols }, (_, x) => {
      const [k, bad] = per.get(x) || [0, 0]
      const t = scale.t(x)
      return `${n.name} · ${when(t, Math.max(1, scale.step))}${k ? ` · ${plural(k, words.record)}` : ''}${bad ? ` · ${num(bad)} ${words.problem}` : ''}`
    })
    return { runs: out, tips, its }
  }
  const api = {
    get chosen() {
      return st.chosen
    },
    choose(key) {
      st.chosen = key === undefined ? null : key
      redraw()
    },
    isOn,
    toggle,
    /** The lanes as last drawn. */
    get lanes() {
      return st.shown.slice()
    },
    /** The key for `axis`: each series the lanes drew beside Color by's, a toggle. */
    legend() {
      const out = []
      if (typeof opts.band === 'function' && st.counts.band) out.push({ id: 'band', glyph: '─', fg: COLORS.rule, name: words.band, on: isOn('band'), toggle: () => toggle('band') })
      if (typeof opts.problem === 'function' && st.counts.problem) out.push({ id: 'problem', glyph: '×', fg: COLORS.problem, name: words.problem, on: isOn('problem'), toggle: () => toggle('problem') })
      return out
    },
    /** Draw the lanes: `o.items` (those of the range), `o.scale` (range.scale), `o.gutter` (the names' cells), `o.room`
     *  (rows, the rows left by default), `o.span` ([t0, t1] or a list whose rows in view it marks), `o.density` (false:
     *  Events, a mark `▌` in each cell with a record, in place of the bars of its records). */
    draw(d, o = {}) {
      const items = o.items || []
      const scale = o.scale
      const gutter = o.gutter || 14
      const room = Math.max(1, Math.min(o.room ?? d.left, d.left))
      const colour = opts.colour || state.colour
      const span = o.span && typeof o.span.span === 'function' ? o.span.span(time) : Array.isArray(o.span) ? o.span : null
      const dense = o.density !== false
      const all = layout(items, room)
      st.counts = { band: 0, problem: 0 }
      const groups = all.map((n) => n.items.filter((it) => !colour || colour.keeps(it)))
      const max = maxBin(scale, groups, time)
      // the rows past the room wait behind `… N more`, which shows the next of them
      const fits = all.length <= room ? all.length : Math.max(1, room - 1)
      if (st.top >= all.length || all.length <= room) st.top = 0
      const shown = all.slice(st.top, st.top + fits)
      st.shown = shown
      for (const n of shown) {
        const r = d.row()
        const own = n.depth === 0
        if (own && n.children) r.add(n.folded ? '▸' : '▾', {}, { on: () => { st.folded.set(n.key, !n.folded); save(); redraw() }, tip: n.folded ? 'show the lanes under it' : 'fold the lanes under it into its own' }).gap(1)
        else r.gap(2)
        if (n.guide) r.add(n.guide, { fg: COLORS.rule })
        const nameStyle = st.chosen === n.key ? { fg: COLORS.accent } : n.heading ? { b: true } : {}
        r.add(n.name, nameStyle, {
          on: () => {
            st.chosen = n.key
            if (typeof opts.onPick === 'function') opts.onPick(n)
            redraw()
          },
          tip: `${n.name}: ${plural(n.items.length, words.record)}`,
          max: Math.max(3, gutter - 2 - r.x),
        })
        r.at(gutter)
        if (!(n.heading && !n.folded)) {
          const x0 = r.x
          const lane = cells(scale, n, max, span, colour, dense)
          r.runsOf(lane.runs)
          r.hits.push({
            x0,
            x1: x0 + scale.cols,
            cursor: true,
            tips: lane.tips,
            tip: `${n.name}: a click opens the ${words.record} nearest that time`,
            on: (x) => {
              const t = scale.t(x)
              const near = lane.its.filter((it) => Math.abs(time(it) - t) <= scale.step * 3).sort((a, b) => Math.abs(time(a) - t) - Math.abs(time(b) - t))[0]
              if (near && typeof opts.onMark === 'function') opts.onMark(near)
            },
          })
        }
        r.end()
      }
      if (fits < all.length) {
        const left = all.length - st.top - fits
        const words2 = left > 0 ? `… ${num(left)} more` : '… back to the first'
        d.row().gap(2).add(words2, { d: true }, { on: () => { st.top = left > 0 ? st.top + fits : 0; redraw() }, tip: left > 0 ? 'show the next lanes' : 'show the first lanes' }).end()
      }
    },
  }
  state.resets.push({ changed: () => st.off.size > 0, reset: () => { st.off.clear(); save() } })
  return api
}

// ------------------------------------------------------------------------------------------------ the transcript

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A transcript's turns as thimble-term's file view draws a transcript (docs/terminal-views.md, "The transcript"): per
 * turn its clock dim in a column, `●` and the speaker bold, the words under the name up to three rows, a tool call one
 * dim line `⎿ Bash  pytest -q`; the day on a dim row of its own where it changes. It is a list: ↑↓ choose a turn, Enter
 * opens it (a turn's words whole, a tool call's input and what came back, an error in red), in place or in a side
 * pane (`side`), `a` asks about it, and its track shows where the Color by values are.
 *
 * opts: key (the list's), enter. draw(d, {turns, title, count, colour, side, onOpen, empty}): turns [{ref, t, speaker,
 * kind (text | prompt | tool | thinking | system), tool, text, input, output, error}].
 */
export function transcript(opts = {}) {
  const items = list({ key: (t) => t.ref, enter: opts.enter || 'to open' })
  const clockOf = (t) => (typeof t.t === 'number' && Number.isFinite(t.t) ? hms(t.t) : '')
  const dayOf2 = (t) => {
    if (typeof t.t !== 'number' || !Number.isFinite(t.t)) return ''
    const d = new Date(t.t * 1000)
    return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  }
  const firstLine = (s) => oneLine(String(s ?? '').split('\n').find((l) => l.trim()) || '')
  const api = {
    /** The list under it (`choose`, `show`, `span`). */
    list: items,
    get chosen() {
      return items.chosen
    },
    draw(d, o = {}) {
      const turns = o.turns || []
      const colour = o.colour || null
      const withTime = turns.some((t) => clockOf(t))
      const tw = withTime ? 8 : 0
      const rows = []
      let day = ''
      for (const t of turns) {
        const dd = dayOf2(t)
        if (dd && dd !== day) rows.push({ heading: dd, dim: true })
        if (dd) day = dd
        rows.push(t)
      }
      const indent = (tw ? tw + 2 : 0) + 2
      items.draw(d, {
        items: rows,
        title: o.title,
        count: o.count ?? (o.title ? plural(turns.length, 'turn') : undefined),
        side: o.side,
        mark: false,
        value: colour ? (t) => colour.valueOf(t) : null,
        colour,
        empty: o.empty || 'no turn',
        onOpen: o.onOpen,
        sideTitle: (t) => `${t.speaker || ''}${t.tool ? ` · ${t.tool}` : ''}${clockOf(t) ? ` · ${clockOf(t)}` : ''}`,
        ask: (t) => ({ ref: t.ref, text: t.kind === 'tool' ? `${t.tool || ''} ${t.input || ''}` : t.text || '' }),
        row: (t, r) => {
          if (tw) r.add(pad(clockOf(t), tw), { d: true }).gap()
          if (t.kind === 'tool' || t.kind === 'system') {
            r.add(`⎿ ${t.kind === 'tool' ? `${t.tool || 'tool'}  ${firstLine(t.input)}` : firstLine(t.text)}`, { d: true }, { max: Math.max(6, r.room) })
            return
          }
          const v = colour ? colour.valueOf(t) : null
          r.runsOf(colour ? colour.dot(v) : { s: '●' })
          r.add(' ').add(t.speaker || '(unsigned)', { b: true }, { max: Math.max(4, r.room) })
        },
        bodyIndent: indent,
        body: (t, bd, ctx) => {
          if (t.kind === 'tool' || t.kind === 'system') return
          const text = String(t.text ?? '')
          if (!text.trim()) return
          const open = ctx.open && !o.side
          const style = t.kind === 'thinking' ? { d: true, i: true } : t.error ? { fg: COLORS.problem } : {}
          for (const line of wrap(oneLine(text), bd.cols, open ? 40 : 3)) bd.line({ s: line, ...style })
        },
        detail: (t, dd) => {
          if (t.kind === 'tool') {
            details(dd, {
              blocks: [
                { text: t.input, code: true },
                { text: t.output ?? t.result ?? '', problem: Boolean(t.error) },
              ],
              place: t.ref,
              ask: { ref: t.ref, text: `${t.tool || ''} ${t.input || ''}` },
            })
            return
          }
          if (o.side) details(dd, { text: t.text, maxRows: Math.max(4, dd.left - 3), place: t.ref, ask: { ref: t.ref, text: t.text || '' } })
          else details(dd, { place: t.ref, ask: { ref: t.ref, text: t.text || '' } })
        },
      })
    },
  }
  return api
}

// ------------------------------------------------------------------------------------------------ text

const ANSI_FG = { text: '', inactive: '2', subtle: '90', remember: '34', suggestion: '36', success: '32', error: '31', permission: '35' }
const ANSI_BG = { selectionBg: '48;5;238', userMessageBackground: '48;5;236' }
const ANSI_BG_LIGHT = { selectionBg: '48;5;252', userMessageBackground: '48;5;254' }

function hexRgb(h) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null
}

/** A frame's lines as text: plain, or with `ansi` the styles as escape codes (a light or dark `theme`). */
export function frameText(f, o = {}) {
  const bgs = o.theme === 'light' ? ANSI_BG_LIGHT : ANSI_BG
  return (f.lines || []).map((l) => l.map((sg) => {
    if (!o.ansi) return sg.s
    const codes = []
    if (sg.b) codes.push('1')
    if (sg.d) codes.push('2')
    if (sg.i) codes.push('3')
    if (sg.u) codes.push('4')
    if (sg.inv) codes.push('7')
    if (sg.fg) {
      const rgb = hexRgb(sg.fg)
      if (rgb) codes.push(`38;2;${rgb.join(';')}`)
      else if (ANSI_FG[sg.fg]) codes.push(ANSI_FG[sg.fg])
    }
    if (sg.bg && bgs[sg.bg]) codes.push(bgs[sg.bg])
    return codes.length ? `\x1b[${codes.join(';')}m${sg.s}\x1b[0m` : sg.s
  }).join('').replace(/\s+$/, '')).join('\n')
}
