// layout.js: a card's drawing as lines of text. The runner (runner.mjs) turns a card's view into a plain tree of Box,
// Text and Button nodes, `{t, p, c}`; this module lays that tree out on a grid of cells at a width, as Claude Code's
// terminal lays out the same tree, and returns the lines. It is the text copy Claude reads after each card call, and
// the drawing a renderer without Claude Code's own (the browser, later) can use.
//
//   layoutLines(tree, width)  {lines, cut}: the lines, trailing spaces removed, and the numbers of the lines that hold
//                             cells past the width (cut there, as the terminal cuts them). The tree is laid out in a
//                             column Box `width` cells wide, the box client.tsx draws it in.
//   wrapText(text, cols, mode) a text's rows: wrapped at words, or cut with …
//   buttonText(p, c)          what a Button shows: `[ label ]`, or the label alone when plain
//   textWidth(s)              the cells a string takes: 2 for a wide character, 0 for a combining mark
//
// The layout is flexbox as Yoga computes it, for the props the card tool names: Box flexDirection (row by default, as
// in Claude Code), flexGrow, flexShrink (1 by default), flexWrap, width and height as cells or percent, min sizes,
// padding, margin, gap, borders, justifyContent, alignItems and alignSelf, display none, position absolute,
// overflow hidden; Text wrap (word wrap, or cut with … at the end, start or middle) with nested Text runs; Button as
// `[ label ]`, or its label alone when plain. Places and sizes are rounded to whole cells as Claude Code rounds them.
// Pure: no Node, no `$`.

const UNDEF = 0
const EXACT = 1
const AT_MOST = 2

const BORDERS = {
  single: ['┌', '─', '┐', '│', '│', '└', '─', '┘'],
  round: ['╭', '─', '╮', '│', '│', '╰', '─', '╯'],
  double: ['╔', '═', '╗', '║', '║', '╚', '═', '╝'],
  bold: ['┏', '━', '┓', '┃', '┃', '┗', '━', '┛'],
  singleDouble: ['╓', '─', '╖', '║', '║', '╙', '─', '╜'],
  doubleSingle: ['╒', '═', '╕', '│', '│', '╘', '═', '╛'],
  classic: ['+', '-', '+', '|', '|', '+', '-', '+'],
  arrow: ['↘', '↓', '↙', '→', '←', '↗', '↑', '↖'],
  dashed: ['┌', '╌', '┐', '╎', '╎', '└', '╌', '┘'],
  quote: [' ', ' ', ' ', '▎', ' ', ' ', ' ', ' '],
}
const SPACE = { xs: 1, sm: 1, md: 2, lg: 3, xl: 4 }

// ------------------------------------------------------------------------------------------------- text widths

/** A code point's cells: 0 for combining marks and zero-width characters, 2 for wide and fullwidth ones. */
function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d ||
    (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x20000 && cp <= 0x3fffd) ||
    cp === 0x231a || cp === 0x231b || cp === 0x23f0 || cp === 0x23f3 || cp === 0x2614 || cp === 0x2615 ||
    (cp >= 0x2648 && cp <= 0x2653) || cp === 0x267f || cp === 0x2693 || cp === 0x26a1 || cp === 0x26aa || cp === 0x26ab ||
    cp === 0x26bd || cp === 0x26be || cp === 0x26c4 || cp === 0x26c5 || cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea ||
    cp === 0x26f2 || cp === 0x26f3 || cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || cp === 0x2705 || cp === 0x270a ||
    cp === 0x270b || cp === 0x2728 || cp === 0x274c || cp === 0x274e || (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf || cp === 0x2b1b || cp === 0x2b1c || cp === 0x2b50 ||
    cp === 0x2b55 || (cp >= 0x1f1e6 && cp <= 0x1f1ff) || (cp >= 0x1fa70 && cp <= 0x1faff)) return 2
  return 1
}

export function textWidth(s) {
  let w = 0
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0))
  return w
}

// ------------------------------------------------------------------------------------------------- wrapping

/** One word cut into rows of at most `cols` cells, the first row continuing `rows`' last (wrap-ansi's hard wrap). */
function wrapWord(rows, word, cols) {
  let visible = textWidth(rows[rows.length - 1])
  const chars = [...word]
  chars.forEach((ch, i) => {
    const w = textWidth(ch)
    if (visible + w <= cols) rows[rows.length - 1] += ch
    else {
      rows.push(ch)
      visible = 0
    }
    visible += w
    if (visible === cols && i < chars.length - 1) {
      rows.push('')
      visible = 0
    }
  })
  if (!visible && rows[rows.length - 1].length > 0 && rows.length > 1) rows[rows.length - 2] += rows.pop()
}

/** One line wrapped at `cols` cells, words kept whole where they fit and spaces kept (wrap-ansi, hard, no trim). When
 *  a row is full, the space before the next word starts the next row and counts in its length, but is not drawn, as
 *  Claude Code draws it. */
function wrapLine(line, cols) {
  const words = line.split(' ')
  const lengths = words.map(textWidth)
  const rows = ['']
  const opened = new Set()
  words.forEach((word, i) => {
    let len = textWidth(rows[rows.length - 1])
    if (i !== 0) {
      if (len >= cols) {
        rows.push('')
        opened.add(rows.length - 1)
        len = 0
      }
      rows[rows.length - 1] += ' '
      len++
    }
    if (lengths[i] > cols) {
      const left = cols - len
      const startHere = 1 + Math.floor((lengths[i] - left - 1) / cols)
      const startNext = Math.floor((lengths[i] - 1) / cols)
      if (startNext < startHere) rows.push('')
      wrapWord(rows, word, cols)
      return
    }
    if (len + lengths[i] > cols && len > 0 && lengths[i] > 0) rows.push('')
    rows[rows.length - 1] += word
  })
  return rows.map((r, i) => (opened.has(i) && r.startsWith(' ') ? r.slice(1) : r))
}

/** The first `n` cells of a string, never splitting a wide character. */
function headCells(s, n) {
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = textWidth(ch)
    if (w + cw > n) break
    out += ch
    w += cw
  }
  return out
}

/** The last `n` cells of a string. */
function tailCells(s, n) {
  const chars = [...s]
  let out = ''
  let w = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = textWidth(chars[i])
    if (w + cw > n) break
    out = chars[i] + out
    w += cw
  }
  return out
}

/** A line cut to `cols` cells with … at the end, the start or the middle. */
function truncate(s, cols, where) {
  const w = textWidth(s)
  if (w <= cols) return s
  if (cols < 1) return ''
  if (cols === 1) return '…'
  if (where === 'start') return '…' + tailCells(s, cols - 1)
  if (where === 'middle') {
    const head = headCells(s, Math.floor(cols / 2))
    const tail = tailCells(s, cols - 1 - textWidth(head))
    return headCells(s, cols - 1 - textWidth(tail)) + '…' + tail
  }
  return headCells(s, cols - 1) + '…'
}

/** A text's rows at `cols` cells by its wrap mode. */
export function wrapText(text, cols, mode = 'wrap') {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  if (mode === 'wrap' || mode === 'wrap-trim') return lines.flatMap(l => (textWidth(l) <= cols ? [l] : wrapLine(l, Math.max(1, cols))))
  if (mode === 'end' || mode === 'middle' || String(mode).startsWith('truncate')) {
    const where = mode === 'truncate-middle' || mode === 'middle' ? 'middle' : mode === 'truncate-start' ? 'start' : 'end'
    return lines.map(l => truncate(l, cols, where))
  }
  return lines
}

/** A text's size: unwrapped when it fits (or the width is not given), else wrapped at the width. */
function measureText(node, avail, mode) {
  const lines = node.text.split('\n')
  const natural = Math.max(0, ...lines.map(textWidth))
  if (mode === UNDEF || natural <= avail) return { w: natural, h: node.text === '' ? 0 : lines.length }
  const cols = avail >= 1 ? Math.floor(avail + 1e-6) : avail
  const rows = wrapText(node.text, cols, node.wrap)
  return { w: Math.max(0, ...rows.map(textWidth)), h: rows.length }
}

// ------------------------------------------------------------------------------------------------- the tree

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v in SPACE ? SPACE[v] : undefined)

/** A size prop: cells, or a percent of `of` rounded to a whole cell; undefined when not given or `of` is not known. */
function size(v, of) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v)
  if (typeof v === 'string' && /^\d+(\.\d+)?%$/.test(v.trim())) return of === undefined ? undefined : Math.round((of * parseFloat(v)) / 100)
  return undefined
}

function edges(p, name) {
  const all = num(p[name]) ?? 0
  const x = num(p[`${name}X`])
  const y = num(p[`${name}Y`])
  return {
    l: num(p[`${name}Left`]) ?? x ?? all,
    r: num(p[`${name}Right`]) ?? x ?? all,
    t: num(p[`${name}Top`]) ?? y ?? all,
    b: num(p[`${name}Bottom`]) ?? y ?? all,
  }
}

/** The text of a Text's or a Button's children: strings, numbers and nested Text runs, joined. */
function flatText(c) {
  if (c == null || c === false || c === true) return ''
  if (typeof c === 'string' || typeof c === 'number') return String(c)
  if (Array.isArray(c)) return c.map(flatText).join('')
  if (typeof c === 'object') return flatText(c.c)
  return ''
}

/** The text a Button draws: `[ label ]`, or the label alone when plain. */
export function buttonText(p, c) {
  const label = flatText(c) || (p.label == null ? '' : String(p.label))
  return p.plain ? label : `[ ${label} ]`
}

/** The layout node of a tree node. */
function build(n) {
  if (n == null || n === false || n === true) return null
  if (typeof n === 'string' || typeof n === 'number') return { kind: 'text', p: {}, text: String(n), wrap: 'wrap' }
  if (Array.isArray(n)) return build({ t: 'Box', p: {}, c: n })
  const p = n.p && typeof n.p === 'object' ? n.p : {}
  if (p.display === 'none') return null
  if (n.t === 'Text') return { kind: 'text', p: {}, text: flatText(n.c), wrap: p.wrap || 'wrap' }
  // Claude Code draws a Button as a Box that neither shrinks nor stretches, around its text
  if (n.t === 'Button') return build({ t: 'Box', p: { flexShrink: 0, alignSelf: 'flex-start' }, c: [{ t: 'Text', p: {}, c: [buttonText(p, n.c)] }] })
  const kids = (Array.isArray(n.c) ? n.c : n.c == null ? [] : [n.c]).map(build).filter(Boolean)
  const border = typeof p.borderStyle === 'string' && BORDERS[p.borderStyle] ? p.borderStyle : null
  return {
    kind: 'box', p, kids, border,
    row: p.flexDirection === 'row' || p.flexDirection === 'row-reverse' || p.flexDirection === undefined,
    reverse: p.flexDirection === 'row-reverse' || p.flexDirection === 'column-reverse',
    pad: edges(p, 'padding'),
    bw: {
      l: border && p.borderLeft !== false ? 1 : 0, r: border && p.borderRight !== false ? 1 : 0,
      t: border && p.borderTop !== false ? 1 : 0, b: border && p.borderBottom !== false ? 1 : 0,
    },
  }
}

const margin = n => edges(n.p, 'margin')
const grow = n => (typeof n.p.flexGrow === 'number' ? Math.max(0, n.p.flexGrow) : 0)
const shrink = n => (typeof n.p.flexShrink === 'number' ? Math.max(0, n.p.flexShrink) : 1)
const alignOf = (parent, kid) => (kid.p.alignSelf && kid.p.alignSelf !== 'auto' ? kid.p.alignSelf : parent.p.alignItems || 'stretch')
const inFlow = k => k.p.position !== 'absolute'

/** The size of a node in the room given, and, with `place`, the places of everything inside it (node.lay). */
function compute(node, W, wMode, H, hMode, place) {
  if (node.kind === 'text') {
    const m = measureText(node, W, wMode)
    const out = { w: wMode === EXACT ? W : m.w, h: hMode === EXACT ? H : m.h }
    if (place) node.lay = { ...out }
    return out
  }
  const { pad, bw } = node
  const ph = pad.l + pad.r + bw.l + bw.r
  const pv = pad.t + pad.b + bw.t + bw.b
  const innerW = wMode === UNDEF ? undefined : Math.max(0, W - ph)
  const innerH = hMode === UNDEF ? undefined : Math.max(0, H - pv)
  const row = node.row
  const mainInner = row ? innerW : innerH
  const mainMode = row ? wMode : hMode
  const crossInner = row ? innerH : innerW
  const crossMode = row ? hMode : wMode
  const gapMain = num(row ? node.p.columnGap : node.p.rowGap) ?? num(node.p.gap) ?? 0
  const gapCross = num(row ? node.p.rowGap : node.p.columnGap) ?? num(node.p.gap) ?? 0
  const kids = node.kids.filter(inFlow)
  if (node.reverse) kids.reverse()

  // each child's base size along the main axis
  const items = kids.map(k => {
    const m = margin(k)
    const mm = row ? m.l + m.r : m.t + m.b
    const mc = row ? m.t + m.b : m.l + m.r
    const defMain = size(row ? k.p.width : k.p.height, mainInner)
    const defCross = size(row ? k.p.height : k.p.width, crossInner)
    let basis
    if (defMain !== undefined) basis = defMain
    else if (row) {
      const r = compute(k, mainInner ?? 0, mainInner === undefined ? UNDEF : AT_MOST, defCross ?? 0, defCross === undefined ? UNDEF : EXACT, false)
      basis = r.w
    } else {
      const stretch = alignOf(node, k) === 'stretch' && crossMode === EXACT
      const cw = defCross ?? (stretch ? Math.max(0, crossInner - mc) : crossInner)
      const cm = defCross !== undefined || stretch ? EXACT : crossInner === undefined ? UNDEF : AT_MOST
      basis = compute(k, cw ?? 0, cm, mainInner ?? 0, mainInner === undefined ? UNDEF : AT_MOST, false).h
    }
    const minMain = size(row ? k.p.minWidth : k.p.minHeight, mainInner) ?? 0
    const own = k.kind === 'box' ? (row ? k.pad.l + k.pad.r + k.bw.l + k.bw.r : k.pad.t + k.pad.b + k.bw.t + k.bw.b) : 0
    return { k, m, mm, mc, defCross, basis: Math.max(basis, minMain, own), min: Math.max(minMain, own) }
  })

  // lines: one, or as many as flexWrap needs
  const lines = []
  let cur = []
  let used = 0
  for (const it of items) {
    const add = it.basis + it.mm + (cur.length ? gapMain : 0)
    if (node.p.flexWrap && node.p.flexWrap !== 'nowrap' && mainInner !== undefined && cur.length && used + add > mainInner) {
      lines.push(cur)
      cur = []
      used = 0
    }
    used += cur.length ? it.basis + it.mm + gapMain : it.basis + it.mm
    cur.push(it)
  }
  if (cur.length || !lines.length) lines.push(cur)

  let contentMain = 0
  let contentCross = 0
  const placed = []
  for (const line of lines) {
    const sumBase = line.reduce((a, it) => a + it.basis + it.mm, 0) + gapMain * Math.max(0, line.length - 1)
    const growTotal = line.reduce((a, it) => a + grow(it.k), 0)
    let free = 0
    if (mainInner !== undefined && (mainMode === EXACT || sumBase > mainInner || growTotal > 0)) free = mainInner - sumBase
    for (const it of line) it.main = it.basis
    if (free > 0 && growTotal > 0) {
      for (const it of line) it.main += (free * grow(it.k)) / growTotal
    } else if (free < 0) {
      let left = -free
      let open = line.filter(it => shrink(it.k) > 0 && it.main > it.min)
      // shrink in proportion to shrink × base size; an item that reaches its least size stops, and the rest go on
      for (let pass = 0; pass < 8 && left > 1e-9 && open.length; pass++) {
        const scaled = open.reduce((a, it) => a + shrink(it.k) * it.basis, 0)
        if (scaled <= 0) break
        let took = 0
        for (const it of open) {
          const want = (left * shrink(it.k) * it.basis) / scaled
          const can = it.main - it.min
          const give = Math.min(want, can)
          it.main -= give
          took += give
        }
        left -= took
        open = open.filter(it => it.main > it.min + 1e-9)
      }
    }
    const mainUsed = line.reduce((a, it) => a + it.main + it.mm, 0) + gapMain * Math.max(0, line.length - 1)
    const remaining = mainInner !== undefined && mainMode === EXACT ? Math.max(0, mainInner - mainUsed) : 0

    // each child at its main size; its cross size from its content, or the line's when it stretches
    for (const it of line) {
      const k = it.k
      const stretch = alignOf(node, k) === 'stretch' && it.defCross === undefined
      const crossAvail = crossInner === undefined ? undefined : Math.max(0, crossInner - it.mc)
      const cm = it.defCross !== undefined ? EXACT : stretch && crossMode === EXACT && lines.length === 1 ? EXACT : crossAvail === undefined ? UNDEF : AT_MOST
      const cv = it.defCross ?? crossAvail ?? 0
      const r = row ? compute(k, it.main, EXACT, cv, cm, false) : compute(k, cv, cm, it.main, EXACT, false)
      it.cross = row ? r.h : r.w
    }
    const lineCross = crossMode === EXACT && lines.length === 1 ? crossInner : Math.max(0, ...line.map(it => it.cross + it.mc))
    for (const it of line) {
      const stretch = alignOf(node, it.k) === 'stretch' && it.defCross === undefined
      if (stretch) it.cross = Math.max(0, lineCross - it.mc)
    }

    // places along the main axis
    const n = line.length
    const jc = node.p.justifyContent || 'flex-start'
    let lead = 0
    let between = 0
    if (remaining > 0) {
      if (jc === 'center') lead = remaining / 2
      else if (jc === 'flex-end') lead = remaining
      else if (jc === 'space-between') between = n > 1 ? remaining / (n - 1) : 0
      else if (jc === 'space-around') { between = remaining / n; lead = between / 2 }
      else if (jc === 'space-evenly') { between = remaining / (n + 1); lead = between }
    }
    let pos = lead
    for (const it of line) {
      const al = alignOf(node, it.k)
      const room = lineCross - it.cross - it.mc
      const off = al === 'center' ? room / 2 : al === 'flex-end' ? room : 0
      placed.push({ it, main: pos + (row ? it.m.l : it.m.t), cross: contentCross + off + (row ? it.m.t : it.m.l) })
      pos += it.main + it.mm + gapMain + between
    }
    contentMain = Math.max(contentMain, mainUsed)
    contentCross += lineCross + (lines.length > 1 ? gapCross : 0)
  }
  if (lines.length > 1) contentCross -= gapCross

  const fit = (v, mode, avail, extra) => (mode === EXACT ? avail : mode === AT_MOST ? Math.min(avail, v + extra) : v + extra)
  const outW = fit(row ? contentMain : contentCross, wMode, W, ph)
  const outH = fit(row ? contentCross : contentMain, hMode, H, pv)
  if (!place) return { w: outW, h: outH }

  node.lay = { w: outW, h: outH }
  const ox = bw.l + pad.l
  const oy = bw.t + pad.t
  for (const { it, main, cross } of placed) {
    const k = it.k
    const w = row ? it.main : it.cross
    const h = row ? it.cross : it.main
    compute(k, w, EXACT, h, EXACT, true)
    k.lay.x = ox + (row ? main : cross)
    k.lay.y = oy + (row ? cross : main)
  }
  // an absolute child: against the padding box, by its offsets, at its own size
  for (const k of node.kids.filter(x => !inFlow(x))) {
    const w = size(k.p.width, innerW)
    const h = size(k.p.height, innerH)
    const r = compute(k, w ?? innerW ?? 0, w !== undefined ? EXACT : innerW === undefined ? UNDEF : AT_MOST, h ?? 0, h !== undefined ? EXACT : UNDEF, false)
    compute(k, r.w, EXACT, r.h, EXACT, true)
    const left = num(k.p.left)
    const right = num(k.p.right)
    const top = num(k.p.top)
    const bottom = num(k.p.bottom)
    k.lay.x = left !== undefined ? bw.l + left : right !== undefined ? outW - bw.r - right - r.w : ox
    k.lay.y = top !== undefined ? bw.t + top : bottom !== undefined ? outH - bw.b - bottom - r.h : oy
  }
  return { w: outW, h: outH }
}

// ------------------------------------------------------------------------------------------------- painting

function grid(width) {
  const rows = []
  const past = new Set()
  const ensure = y => { while (rows.length <= y) rows.push(new Array(width).fill(' ')) }
  return {
    rows,
    get cut() { return [...past].sort((a, b) => a - b) },
    put(x, y, s, clip) {
      if (y < 0) return
      if (clip && (y < clip.y0 || y >= clip.y1)) return
      ensure(y)
      let cx = x
      for (const ch of s) {
        const w = textWidth(ch)
        if (w === 0) continue
        const visible = !clip || (cx >= clip.x0 && cx + w <= clip.x1)
        if (visible && cx >= 0 && cx + w <= width) {
          rows[y][cx] = ch
          if (w === 2) rows[y][cx + 1] = ''
        } else if (visible && cx + w > width) past.add(y)
        cx += w
      }
    },
    height(y) { ensure(y - 1) },
  }
}

// Places and sizes are kept in fractions of a cell until here, and rounded to whole cells as Claude Code rounds them: a
// box's place in its parent and its size to the nearest cell, a text's place down to the cell it falls in, and its
// width down to the whole cells it was measured with.
function paint(node, g, x0, y0, clip) {
  const text = node.kind === 'text'
  const cell = text ? v => Math.floor(v + 1e-6) : Math.round
  const x = x0 + cell(node.lay.x || 0)
  const y = y0 + cell(node.lay.y || 0)
  const w = cell(node.lay.w)
  const h = cell(node.lay.h)
  if (node.kind === 'text') {
    const rows = wrapText(node.text, Math.max(0, w), node.wrap)
    rows.forEach((r, i) => g.put(x, y + i, r, clip))
    return
  }
  if (h > 0) g.height(y + h)
  if (node.border && w > 0 && h > 0) {
    const [tl, top, tr, left, right, bl, bottom, br] = BORDERS[node.border]
    const { bw } = node
    if (bw.t) g.put(x, y, (bw.l ? tl : top) + top.repeat(Math.max(0, w - 2)) + (bw.r && w > 1 ? tr : top), clip)
    for (let i = bw.t; i < h - bw.b; i++) {
      if (bw.l) g.put(x, y + i, left, clip)
      if (bw.r && w > 1) g.put(x + w - 1, y + i, right, clip)
    }
    if (bw.b && h > 1) g.put(x, y + h - 1, (bw.l ? bl : bottom) + bottom.repeat(Math.max(0, w - 2)) + (bw.r && w > 1 ? br : bottom), clip)
  }
  let inner = clip
  if (node.p.overflow === 'hidden' || node.p.overflowX === 'hidden' || node.p.overflowY === 'hidden') {
    const c = { x0: x + node.bw.l, x1: x + w - node.bw.r, y0: y + node.bw.t, y1: y + h - node.bw.b }
    inner = clip ? { x0: Math.max(c.x0, clip.x0), x1: Math.min(c.x1, clip.x1), y0: Math.max(c.y0, clip.y0), y1: Math.min(c.y1, clip.y1) } : c
  }
  for (const k of node.kids) if (k.lay) paint(k, g, x, y, inner)
}

/** The tree as the card's region holds it: a column Box `width` cells wide. */
function cardRoot(tree, width) {
  return { t: 'Box', p: { flexDirection: 'column', width }, c: [tree] }
}

/** The lines a tree draws at `width` cells, as the card's region lays it out. */
export function layoutLines(tree, width) {
  const cols = Math.max(1, Math.floor(width))
  const root = build(cardRoot(tree, cols))
  compute(root, cols, EXACT, 0, UNDEF, true)
  root.lay.x = 0
  root.lay.y = 0
  const g = grid(cols)
  g.height(Math.round(root.lay.h))
  paint(root, g, 0, 0, null)
  const lines = g.rows.map(r => r.join('').replace(/\s+$/, ''))
  return { lines, cut: g.cut.map(y => y + 1) }
}
