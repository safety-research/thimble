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
    this.typer = null
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
    const runs = (Array.isArray(content) ? content : [content]).map(segOf).filter(Boolean)
    const y = this.lines.length
    this.lines.push({ margin: margin ? segOf(margin) : null, runs: clipLine(merged(runs), this.cols) })
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

  /** A drawing `cols` wide whose lines stand `indent` cells in from this one's edge (a row's details at A2), to be
   *  put in with `put`. */
  inner(indent = 2, rows = this.left) {
    return new Drawing(this.cols - indent, rows, this, indent)
  }

  /** The lines of an inner drawing, in at this one's row. */
  put(inner, from = 0, to = inner.lines.length) {
    const y0 = this.lines.length
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
   *  words the pointer shows under it, `opts.row` a hit as wide as the row. */
  add(text, style = {}, opts = {}) {
    let s = String(text ?? '')
    if (opts.max !== undefined) s = cut(s, opts.max)
    if (!s) return this
    const w = width(s)
    this.runs.push({ ...style, s })
    if (opts.on || opts.tip || opts.drag) this.hits.push({ x0: this.x, x1: this.x + w, on: opts.on, tip: opts.tip, drag: opts.drag, row: opts.row })
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
  colourLabels: () => [],
  colorBys: [],
  colour: null, // the view's Color by, whose hues a time range and a strip take by default
  lastOpen: null,
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
  let error = state.error
  if (!error && state.drawFn) {
    try {
      state.drawFn(d)
    } catch (e) {
      error = describe(e)
    }
  }
  if (error) return errorFrame(error)
  const seq = ++state.frameSeq
  state.binds = d.binds.filter((b) => b.keys.length)
  state.typer = d.typer
  const lines = d.lines.slice(0, state.rows)
  const hits = d.hits.filter((h) => h.y < lines.length && h.x1 > h.x0)
  state.hits.set(seq, hits)
  for (const k of [...state.hits.keys()]) if (k < seq - 4) state.hits.delete(k)
  const keys = [...new Set(state.binds.flatMap((b) => b.keys))]
  const shownBinds = d.typer ? [] : [...state.binds].sort((a, b) => keyOrder(a.keys) - keyOrder(b.keys) || a.rank - b.rank).filter((b) => b.words)
  const hints = d.typer ? d.typer.hints.slice() : shownBinds.map((b) => `${keyWords(b.keys)} ${b.words}`)
  const out = {
    seq,
    ack: state.ack,
    lines: lines.map(wireLine),
    hits: hits.map((h) => ({ y: h.y, x0: h.x0 + 2, x1: Math.min(h.x1, state.cols) + 2, ...(h.row ? { row: true } : {}), ...(h.tip ? { tip: String(h.tip) } : {}), ...(h.drag ? { drag: true } : {}) })),
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
  if (state.textMode) out.text = frameText(out, { ansi: state.textMode === 'ansi', cols: state.cols })
  return out
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
    state.pending.set(id, { resolve, reject, key })
    send({ t: 'query', id, q: query === undefined ? null : query, labels: state.colourLabels() })
  })
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
      lastOpen: null, colourLabels: () => [], colorBys: [], colour: null,
    })
    openMenu = null
    openBlocks.clear()
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

/** A menu's rows under its control: `❯` and the accent on the chosen one, ↑↓ choose, Enter picks, `close` (the key that
 *  opened it) closes it; under the chosen row its `about` lines, dim. */
function drawMenu(d, owner, items, onPick, closeKey, pickWords) {
  const m = menuOf(owner)
  if (!m) return
  m.pick = Math.max(0, Math.min(items.length - 1, m.pick))
  const nameW = Math.min(28, Math.max(8, ...items.map((it) => width(it.name) + 2 * (it.indent || 0)))) + 2
  items.forEach((it, i) => {
    if (it.heading) {
      d.line([{ s: it.name, d: true }])
      return
    }
    const sel = i === m.pick
    const r = d.row()
    if (sel) r.margin({ s: '❯', fg: COLORS.accent })
    if (it.indent) r.gap(2 * it.indent)
    r.add(pad(it.name, Math.max(1, nameW - 2 * (it.indent || 0))), sel ? { fg: COLORS.accent } : {}, { on: () => { m.pick = i; pick(i) }, row: true })
    if (it.chips) r.runsOf(clipLine(it.chips, Math.max(0, r.room - (it.right ? width(it.right) + 2 : 0))))
    if (it.right) r.right(it.right, { d: true })
    r.end()
    if (sel && it.about) for (const l of it.about(d.cols - nameW)) d.line([{ s: ' '.repeat(nameW) }, ...(Array.isArray(l) ? l : [l]).map(segOf)], (l.hits || []).map((h) => ({ ...h, x0: h.x0 + nameW, x1: h.x1 + nameW })))
  })
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
  d.key('return', pickWords, () => pick(m.pick), true)
  if (closeKey) d.key(closeKey, 'to close', () => toggleMenu(owner), true, 0)
}

// ------------------------------------------------------------------------------------------------ Color by

/**
 * Color by: the one control for the view's color, in its top row (docs/terminal-views.md, "Color by"). It lists Off,
 * the view's fields and every label over files; the chosen field's values are chips with their counts, which a click
 * turns off and on; a label's definition is one step away (its name's `↗` opens the label's panel, and the menu shows
 * it under the label's row).
 *
 * opts: fields [{name, title, description?, values?, meanings?, value?(record)}], initial (a field's name), chips
 * ('filter' hides the records of a value turned off, 'highlight' dims them; the page does either, from isOn), onChange.
 */
export function colorBy(opts = {}) {
  const fields = (opts.fields || []).map((f) => ({ ...f, title: f.title || f.name }))
  const keptBy = kept('colour')
  const startKey = fields.length ? `field:${opts.initial || fields[0].name}` : 'off'
  const c = {
    choice: keptBy && typeof keptBy.by === 'string' ? keptBy.by : startKey,
    off: new Set(keptBy && Array.isArray(keptBy.off) ? keptBy.off.map((v) => (v === null ? '' : String(v))) : []),
    counts: null,
    hues: new Map(), // field -> value -> hue
    marks: new Map(), // ref -> {label id: value}, from {$thimble: 'marks'}
    asked: new Set(),
  }
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {}
  const fieldOf = (key) => fields.find((f) => `field:${f.name}` === key)
  const labelOf = (key) => state.labels.find((l) => `label:${l.id}` === key)
  // a label the workspace no longer has, or a field the view dropped, gives way to the first field
  const settle = () => {
    if (c.choice === 'off' || fieldOf(c.choice) || labelOf(c.choice)) return
    c.choice = startKey
    c.off.clear()
  }
  settle()
  state.colorBys.push(settle)
  const save = () => keep('colour', { by: c.choice, off: [...c.off].map((v) => (v === '' ? null : v)) })
  state.colourLabels = () => (labelOf(c.choice) ? [labelOf(c.choice).id] : [])

  function labelHue(l, v) {
    const names = (l.values || []).map((x) => x.name)
    const i = names.indexOf(v)
    if (i < 0) return null
    return names.length > 1 && i === names.length - 1 ? COLORS.dim : SERIES[i % SERIES.length]
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
      if ('value' in record) return record.value === undefined || record.value === '' ? null : record.value
      const ref = typeof record === 'string' ? record : record.ref
      if (!ref) return null
      const m = c.marks.get(ref)
      if (!m) {
        need(ref)
        return null
      }
      return m[l.id] ?? null
    },
    /** A value's hue (a palette color), dim for a label's catch-all value and a value past six, null for Off and for
     *  no value. */
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
    /** The chips: `[{value, name, colour, on, n}]`, `value` null for no value; none for Off. */
    get values() {
      return chips()
    },
    /** The top row's Color by control and its chips, added to a row (the row's room is theirs). */
    add(row) {
      addControl(row)
      return row
    },
    /** The top row on its own: Color by, its chips, and Reset at R. */
    draw(d, before = null) {
      const r = d.row()
      if (before) before(r)
      addControl(r)
      r.end()
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

  function need(ref) {
    if (c.asked.has(ref)) return
    c.asked.add(ref)
    const batch = (c.batch = c.batch || [])
    batch.push(ref)
    if (batch.length > 1) return
    queueMicrotask(() => {
      const refs = c.batch.splice(0)
      fetch({ $thimble: 'marks', refs }).then((got) => {
        for (const r of refs) c.marks.set(r, (got && got[r]) || {})
        redraw()
      }, () => {})
    })
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
    const names = f ? fieldValues(f) : (l.values || []).map((x) => x.name)
    const out = []
    const other = { value: '\u0000other', name: 'other', colour: null, on: true, n: 0, members: [] }
    for (const v of names) {
      const n = counts[v] || 0
      if (f && !c.hues.get(f.name).get(v)) {
        other.n += n
        other.members.push(v)
        continue
      }
      if (c.counts && !n && !c.off.has(v) && !(f && (f.values || []).some((x) => (typeof x === 'object' ? x.name : x) === v))) continue
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

  // the menu: Off, the fields, then the labels, each with its values as chips; under the chosen one what it is
  function menuItems() {
    const items = [{ key: 'off', name: 'Off', chips: [{ s: 'no color', d: true }] }]
    for (const f of fields) {
      const vals = previewValues(f)
      items.push({ key: `field:${f.name}`, name: f.title, chips: vals, about: (w) => wrap(f.description || '', w, 2).map((s) => [{ s, d: true }]) })
    }
    const ls = [...state.labels].sort((a, b) => Number(Boolean(b.here)) - Number(Boolean(a.here)))
    if (ls.length) items.push({ heading: true, name: 'labels' })
    for (const l of ls) {
      const vals = (l.values || []).flatMap((v, i) => [...(i ? [{ s: '  ' }] : []), mark(labelHue(l, v.name)), { s: ` ${v.name}` }])
      items.push({
        key: `label:${l.id}`,
        name: l.name,
        chips: vals,
        right: l.kind || '',
        about: (w) => {
          const text = l.text || l.spec || ''
          const rows = wrap(text ? `${l.kind ? `${l.kind} · ` : ''}"${oneLine(text)}"` : l.kind || '', Math.max(10, w - 14), 2).map((s) => [{ s, d: true }])
          const last = rows.length ? rows[rows.length - 1] : (rows[0] = [])
          const x = lineWidth(last) + 2
          last.push({ s: '  ' }, { s: 'definition', fg: COLORS.link, u: true }, { s: ' ↗', fg: COLORS.link })
          last.hits = [{ x0: x, x1: x + width('definition ↗'), on: () => openLabel(l.id), tip: "the label's panel: its definition, its runs and its records" }]
          return rows
        },
      })
    }
    return items
  }

  // a field's values in the menu: those it took on the page, else those it declares or gives meanings for, in the
  // hues they take (or would take, the first six), else what the field is
  function previewValues(f) {
    let names = fieldValues(f).filter((v) => c.hues.get(f.name).get(v))
    let hueOf = (v) => c.hues.get(f.name).get(v)
    if (!names.length && f.meanings) {
      names = Object.keys(f.meanings)
      hueOf = (v) => SERIES[names.indexOf(v)] || null
    }
    if (!names.length) return [{ s: f.description ? cut(f.description, 60) : '', d: true }]
    return names.slice(0, HUES).flatMap((v, i) => [...(i ? [{ s: '  ' }] : []), mark(hueOf(v)), { s: ` ${v}` }])
  }

  function addControl(r) {
    const by = api.by
    r.add('Color by', { d: true }).gap()
    const name = by ? by.title : 'Off'
    r.add(name, {}, { on: () => toggleMenu(api, menuItems().findIndex((it) => it.key === c.choice)), tip: 'choose what colors the view: a field or a label' })
    if (by && by.label) r.add(' ').add('↗', { fg: COLORS.link }, { on: () => openLabel(by.label), tip: "the label's panel: its definition, its runs and its records" })
    // the chips take the row's room but Reset's, which keeps its place whether it shows or not
    const resetW = width('reset') + 2
    const room = r.d.cols - r.x - resetW - 2
    const all = chips()
    if (all.length) r.gap()
    let used = 0
    let shown = 0
    for (const ch of all) {
      const w = lineWidth(chipRuns(ch)) + (shown ? 2 : 0)
      const moreW = shown < all.length - 1 ? width(` +${all.length - shown - 1}`) + 2 : 0
      if (used + w + moreW > room) break
      if (shown) r.gap()
      const x0 = r.x
      for (const s of chipRuns(ch)) r.add(s.s, s)
      r.hits.push({ x0, x1: r.x, on: () => toggleChip(ch), tip: chipTip(ch) })
      used += w
      shown++
    }
    if (shown < all.length) r.gap().add(`+${all.length - shown}`, { d: true }, { on: () => toggleMenu(api, menuItems().findIndex((it) => it.key === c.choice)), tip: `${plural(all.length - shown, 'more value')}: open Color by` })
    if (changed()) {
      r.right('reset', {}, { on: () => reset(), tip: 'the view as it opens: every value on, the whole time span' })
      r.d.key('r', 'to reset', () => reset(), false, 2)
    }
    r.d.key('c', 'to color by', () => toggleMenu(api, menuItems().findIndex((it) => it.key === c.choice)), false, 0)
    r.menus.push((d) => drawMenu(d, api, menuItems(), (it) => it && api.choose(it.key === 'off' ? null : it.key.startsWith('label:') ? { label: it.key.slice(6) } : it.key.slice(6)), 'c', 'to color by'))
  }

  function chipTip(ch) {
    if (ch.value === '\u0000other') return `${ch.members.slice(0, 8).join(', ')}${ch.members.length > 8 ? ', …' : ''}: a click turns them off or on`
    if (ch.value === null) return `${ch.name}: the records that take no value`
    const m = meaningOf(ch.value)
    return `${m ? `${ch.name}: ${m}` : ch.name}${ch.on ? '' : ' (off)'}`
  }

  state.colour = api
  state.resets.push({
    changed: () => c.off.size > 0,
    reset: () => {
      c.off.clear()
      save()
    },
    after: () => onChange(api),
  })
  return api
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
        const style = cell.brk ? { fg: COLORS.rule } : cell.colour && cell.colour !== COLORS.dim ? { fg: cell.colour } : { d: true }
        row.add(cell.glyph, { ...style, ...(inside && r.from !== null ? { bg: COLORS.selected } : {}), ...(!inside && !cell.brk ? { d: true } : {}) })
      })
      const sx = ov ? (x) => ov.t(x) : (x) => span()[0] + ((x + 0.5) / w) * (span()[1] - span()[0])
      // a cell's left edge in time, for a drag that frames whole cells
      const edge = ov ? (x) => ov.at(x) : (x) => span()[0] + (x / w) * (span()[1] - span()[0])
      row.hits.push({
        x0,
        x1: x0 + w,
        tip: r.from === null ? 'drag to frame a range; [ ] pan and + - zoom' : 'drag to frame a range, or drag the window; a click moves it there',
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
      return { glyph: bar(k, max), colour: best ? colourOf(best) : null }
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

/** The chart's axis under it: the ticks' labels dim at their cells, `gutter` cells in, none overlapping; `legend`, runs
 *  in the gutter before them, the key of the marks the chart draws other than Color by's (`─ running  × failed`); then,
 *  with `marks` ([{t, label}]), their labels on a row of their own, each a control when `onMark(mark)` is given. */
export function axis(d, scale, o = {}) {
  const gutter = o.gutter || 0
  const row = d.row()
  if (o.legend && gutter > 2) row.runsOf(clipLine(merged((Array.isArray(o.legend) ? o.legend : [o.legend]).map(segOf).filter(Boolean)), gutter - 2))
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
    return colour && colour !== COLORS.dim ? { s: bar(k, max), fg: colour } : { s: bar(k, max), d: !colour }
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
 * A list of records with a chosen row (`❯` and the accent), its details in place under it, and the colored track at
 * its right edge when it is taller than its room (docs/terminal-views.md, "The list"). ↑↓ choose, Enter or a click opens
 * and closes the chosen row's details, `a` asks a side thread about it; the wheel moves the rows.
 *
 * opts: key(item) its identity; enter (the hint's words, `to open`).
 */
export function list(opts = {}) {
  const keyOf = opts.key || ((it) => it.ref ?? it.id)
  const s = { chosen: null, open: null, top: 0, free: false, items: [], rows: 0 }
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
      // every row of the list, laid out: an item's row, its details' rows under it
      const trackW = 3
      const inner = new Drawing(d.cols - trackW, 100000, d, 0)
      const spans = [] // [first line, last line, item index]
      items.forEach((it, i) => {
        const y0 = inner.y
        if (it.heading) inner.line([{ s: String(it.heading), b: true }])
        else {
          const key = keyOf(it)
          const ch = key === s.chosen
          const op = key === s.open
          const r = inner.row()
          if (ch) r.margin({ s: '❯', fg: COLORS.accent })
          const v = valueOf ? valueOf(it) : null
          if (valueOf) r.add(colour ? colour.dot(v).s : '●', colour ? colour.dot(v) : mark(hueOf(v))).gap(1)
          const before = r.runs.length
          if (o.row) o.row(it, r, { chosen: ch, open: op })
          if (ch) for (let k = before; k < r.runs.length; k++) if (!r.runs[k].fg && !r.runs[k].d && r.runs[k].s.trim()) r.runs[k] = { ...r.runs[k], fg: COLORS.accent }
          r.hits.push({ x0: 0, x1: inner.cols, row: true, on: () => {
            s.chosen = key
            s.free = false
            toggle(it)
          } })
          r.end()
          if (op && o.detail) {
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
      }
      s.top = top = Math.max(0, Math.min(top, last))
      const y0 = d.y
      for (let y = top; y < Math.min(total, top + height); y++) d.lines.push({ margin: inner.lines[y].margin, runs: inner.lines[y].runs })
      for (const h of inner.hits) if (h.y >= top && h.y < top + height) d.hits.push({ ...h, y: h.y - top + y0 })
      if (total > height) drawTrack(d, y0, Math.min(height, total - top), total, top, height, spans, items, valueOf, hueOf, (line) => {
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
      d.key('return', s.open !== null && s.open === s.chosen ? 'to close' : opts.enter || 'to open', () => {
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
        s.open = s.open === key ? null : key
        if (s.open !== null && o.onOpen) o.onOpen(it)
      }
    },
  }
  return api
}

// the track beside a list taller than its room (docs/terminal-views.md, "The list"): a column of the whole list, each
// cell its rows' commonest Color by hue (`▌`), the part in view on the selection background; a list many times its
// room adds the zoomed track at the outer edge, the part around the view at a finer scale. A click goes there.
function drawTrack(d, y0, shownRows, total, top, height, spans, items, valueOf, hueOf, go) {
  const rows = height
  const valueAtLine = new Array(total).fill(undefined)
  for (const [a, , i] of spans) if (!items[i].heading) valueAtLine[a] = valueOf ? valueOf(items[i]) : null
  const cellOf = (from, to) => {
    const counts = new Map()
    let any = false
    for (let y = Math.floor(from); y < Math.min(total, Math.ceil(to)); y++) {
      if (valueAtLine[y] === undefined) continue
      any = true
      const k = valueAtLine[y] === null ? '' : String(valueAtLine[y])
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    if (!any) return { s: ' ' }
    let best = ''
    let bn = 0
    for (const [v, n] of counts) if (v !== '' && n > bn) [best, bn] = [v, n]
    const hue = best ? hueOf(best) : null
    return hue && hue !== COLORS.dim ? { s: '▌', fg: hue } : { s: '▌', d: true }
  }
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
    const runs = clipLine(line.runs, d.cols - 3)
    const pad = d.cols - (zoom ? 2 : 1) - lineWidth(runs)
    const cells = [cell]
    if (zoom) {
      const za = zFrom + (k / rows) * zLen
      const zb = zFrom + ((k + 1) / rows) * zLen
      cells.unshift({ ...cellOf(za, zb), ...(zb > top && za < top + height ? { bg: COLORS.selected } : {}) })
    }
    line.runs = merged([...runs, { s: ' '.repeat(Math.max(0, pad)) }, ...cells])
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
 * `code` in the code color (a command, a query, a path); `facts` [[label, value]] on one row, the labels dim; `groups`
 * [{title, rows: [{when, words, text, on}]}], each row a link to another record; `raw` [[line, text]] its lines as the
 * file holds them; `place` its ref, a link with `↗`; `ask` {ref, text}, `ask about it`.
 */
export function details(d, o = {}) {
  if (o.text) for (const s of wrap(o.text, d.cols, o.maxRows || 6)) d.line(s)
  for (const b of o.blocks || []) {
    const lines = String(b.text ?? '').replace(/\s+$/, '').split('\n')
    if (!lines.join('').trim()) continue
    const key = `${d.y}:${lines.length}:${lines[0]}`
    const max = openBlocks.has(key) ? lines.length : Math.max(1, b.max || 8)
    const shown = lines.length > max + 1 ? lines.slice(0, max) : lines
    for (const l of shown) d.line(b.code ? { s: clip(l, d.cols), fg: COLORS.code } : clip(l, d.cols))
    if (shown.length < lines.length) {
      const more = `… ${num(lines.length - shown.length)} more`
      d.row().add(more, { d: true }, { on: () => { openBlocks.add(key); redraw() }, tip: 'show every line' }).end()
    }
  }
  const facts = (o.facts || []).filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (facts.length) {
    const r = d.row()
    facts.forEach(([k, v], i) => {
      if (i) r.add(' · ', { d: true })
      r.add(`${k} `, { d: true }).add(String(v))
    })
    r.end()
  }
  for (const g of o.groups || []) {
    if (!g.rows || !g.rows.length) continue
    d.line([{ s: g.title, b: true }])
    const ww = Math.min(30, Math.max(0, ...g.rows.map((x) => width(x.words || ''))))
    for (const x of g.rows) {
      const r = d.row()
      if (x.when) r.add(x.when, { d: true }).gap()
      if (ww) r.add(pad(x.words || '', ww), { d: true }).gap()
      r.add(cut(x.text || '', Math.max(4, r.room)), {}, x.on ? { on: x.on, tip: x.tip || 'open it in the list' } : {})
      r.end()
    }
  }
  if (o.raw && o.raw.length) {
    const nw = Math.max(...o.raw.map(([n]) => String(n).length))
    for (const [n, text] of o.raw) d.row().add(padStart(n, nw), { d: true }).gap().add(clip(text, d.cols - nw - 2)).end()
  }
  if (o.place || o.ask) {
    const r = d.row()
    if (o.place) {
      // a place too long for the row, beside `ask about it`, drops its folders, then is cut
      const room = d.cols - 2 - (o.ask ? width('ask about it') + 2 : 0)
      let words = placeWords(o.place)
      if (width(words) > room) words = `…/${placeWords(String(o.place).replace(/^[^#]*\//, ''))}`
      r.add('↗ ', { fg: COLORS.link }, { on: () => open(o.place), tip: 'open its lines' })
      r.add(clip(words, room), { fg: COLORS.link, u: true }, { on: () => open(o.place), tip: 'open its lines' })
    }
    if (o.ask) {
      if (o.place) r.gap()
      r.add('ask about it', {}, { on: () => ask(o.ask.ref, o.ask.text), tip: 'ask a side thread about this record' })
    }
    r.end()
  }
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
 */
export function choice(opts = {}) {
  const s = { value: null, values: Array.isArray(opts.values) ? opts.values.slice() : [] }
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
    /** Choose a value (null for all); onChange follows. */
    set(v) {
      const next = v === undefined ? null : v
      if (next === s.value) return
      s.value = next
      onChange(next)
      redraw()
    },
    add(r) {
      const items = () => [{ name: all, v: null }, ...s.values.map((v) => (typeof v === 'object' ? { name: v.name, v: v.value ?? v.name, right: v.right, indent: v.indent } : { name: String(v), v }))]
      const open = () => toggleMenu(api, Math.max(0, items().findIndex((it) => it.v === s.value)))
      if (opts.title) r.add(opts.title, { d: true }).gap()
      const shown = items().find((it) => it.v === s.value)
      r.add(shown ? shown.name : all, {}, { on: open, tip: opts.tip || `choose ${opts.title || 'one'}` })
      if (opts.key) r.d.key(opts.key, `for ${opts.title || 'the choice'}`, open)
      r.menus.push((d) => drawMenu(d, api, items(), (it) => it && api.set(it.v), opts.key || null, 'to select'))
      return r
    },
  }
  state.resets.push({ changed: () => s.value !== null, reset: () => { s.value = null }, after: () => onChange(null) })
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
