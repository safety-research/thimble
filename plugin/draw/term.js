// term.js: the terminal renderer. It lays a drawing (kit.js) out in cells, by rules of its own:
//
//   - widths are whole cells; `beside` shares them by flex.js; text wraps at spaces and is cut with … only when a
//     line has no room at all;
//   - a bar is whole ▆ cells (▏ for a value under one cell; stacked parts round cumulatively), every part the same
//     height, so bars on neighboring rows keep a gap between them and only a part's width varies; the number beside
//     it carries the precision, and k.bars names the parts' colors in a key above the rows;
//   - a spark is one cell per value (averaged when there are more values than cells), on eight levels ▁..█;
//   - a plot's lines are braille dots, two across and four down per cell, so a line stays thin; where two series
//     share a cell it takes the color of the one listed first; a dot is four braille dots. The axis is ┤ └ ┴ with
//     round values, a free row between two y labels, and a value on the same row as its label; a plot keeps at least
//     five rows however short the program asked for. The y label and the legend share the top row, and the legend
//     shows each series' mark as the plot draws it (━ for a line, ⠶ for dots);
//   - a table is padded columns, numbers right-aligned, the widest text column shrinking first;
//   - unseen data is ▒ (a medium shade), never blank, so a gap reads as a gap;
//   - the cells of a mark (a bar's width, a spark, a plot's area) carry `m`, and a plot's dots the region of their
//     series (`sr`): a selection recolors a mark's glyph and leaves its cell's ground alone (paint.js), so a selected
//     bar keeps its height and the gap to the next row, and a selected series is its own dots, not the plot's area;
//   - a canvas is replayed as the program placed it; a link is a route of ─ │ ╭ ╮ ╰ ╯ through blank cells that joins its
//     two ends, or is not drawn.
//
// renderTerm(drawing, {w}) -> grid {w, h, rows, regions, marks, cut}
//   rows     h rows of w cells {ch, tone, b?, bg?, ref?, px?, w2?, cont?, m?, sr?}; tone is a palette.js tone
//   regions  [{id, meta, rects: [{x, y, w, h}]}] in the drawing's order; links ([words](#id)) add rects to `id`
//   marks    what was drawn, in tree order and renderer-free (text, values, rows, regions)
//   cut      what did not fit: text cut with …, notes left out, cells clipped
// No `$`, no DOM, no Node: the mod imports it (paint.js turns the rows into Text and Raster elements).
import { distribute } from './flex.js'
import { knobOf } from './handoff.js'

const SPARK = '▁▂▃▄▅▆▇█'
const BAR = '▆'
const MAX_NAT = 400

// ---------------------------------------------------------------- characters
export function wide(cp) {
  if (cp >= 0x1F000 && cp <= 0x1FAFF) return true
  return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x20000 && cp <= 0x3FFFD)
}
const cwOf = ch => wide(ch.codePointAt(0)) ? 2 : 1
export const len = s => Array.from(String(s == null ? '' : s)).reduce((n, ch) => n + (ch === '\n' ? 0 : cwOf(ch)), 0)
const plain = runs => (runs || []).map(r => r.br ? '\n' : r.s).join('')
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const fmtTick = v => !isFinite(v) ? '' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toPrecision(3))

// runs -> items {ch, tone, b, ref, cw} with {br} markers
function items(runs) {
  const out = []
  for (const r of runs || []) {
    if (r.br) { out.push({ br: true }); continue }
    for (const ch of Array.from(r.s)) out.push({ ch, tone: r.tone || 'ink', b: !!r.b, ref: r.ref, cw: cwOf(ch) })
  }
  return out
}
const widthOf = line => line.reduce((n, c) => n + c.cw, 0)
function hardLines(its) { const ls = [[]]; for (const c of its) { if (c.br) ls.push([]); else ls[ls.length - 1].push(c) } return ls }
// cut a line to w cells, with … when anything was left out
function cutLine(line, w) {
  if (widthOf(line) <= w) return { line, cut: false }
  const out = []
  let n = 0
  for (const c of line) { if (n + c.cw > w - 1) break; out.push(c); n += c.cw }
  if (w >= 1) out.push({ ch: '…', tone: 'dim', b: false, cw: 1 })
  return { line: out, cut: true }
}
// greedy word wrap at spaces; a word longer than the line is broken
function wrapLine(line, w) {
  w = Math.max(1, w)
  const lines = []
  let cur = [], curW = 0
  const flush = () => { while (cur.length && cur[cur.length - 1].ch === ' ') { curW -= 1; cur.pop() } lines.push(cur); cur = []; curW = 0 }
  let i = 0
  while (i < line.length) {
    // the next word with the spaces before it
    let j = i
    while (j < line.length && line[j].ch === ' ') j++
    let e = j
    while (e < line.length && line[e].ch !== ' ') e++
    const spaces = line.slice(i, j), word = line.slice(j, e)
    const sw = spaces.length, ww = widthOf(word)
    if (curW + (cur.length ? sw : 0) + ww <= w) {
      if (cur.length) { cur.push(...spaces); curW += sw }
      cur.push(...word); curW += ww
    } else if (ww <= w) {
      if (cur.length) flush()
      cur.push(...word); curW = ww
    } else {
      // break the long word
      if (cur.length && curW + sw < w - 3) { cur.push(...spaces); curW += sw } else if (cur.length) flush()
      for (const c of word) { if (curW + c.cw > w) flush(); cur.push(c); curW += c.cw }
    }
    i = e
  }
  flush()
  return lines
}
function longestWord(line) { let best = 0, cur = 0; for (const c of line) { if (c.ch === ' ') { best = Math.max(best, cur); cur = 0 } else cur += c.cw } return Math.max(best, cur) }

// the lines a text node draws at width w
function textLines(n, w) {
  const its = items(n.runs)
  let lines = []
  let cut = false
  for (const hl of hardLines(its)) {
    if (n.wrap === false) { const r = cutLine(hl, w); cut = cut || r.cut; lines.push(r.line) } else lines.push(...wrapLine(hl, w))
  }
  if (n.max != null && lines.length > n.max) {
    lines = lines.slice(0, n.max)
    const last = lines[lines.length - 1]
    const r = cutLine(last.concat([{ ch: ' ', cw: 1 }, { ch: '…', cw: 1 }]), w)
    lines[lines.length - 1] = widthOf(last) + 1 < w ? last.concat([{ ch: '…', tone: 'dim', b: false, cw: 1 }]) : r.line
    cut = true
  }
  return { lines, cut }
}

// ---------------------------------------------------------------- the grid
class Grid {
  constructor(w, h, dry) {
    this.w = w; this.h = h; this.dry = !!dry
    this.rows = dry ? null : Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: ' ', tone: 'ink' })))
    this.clip = { x0: 0, y0: 0, x1: w, y1: h }
    this.clipped = false
  }
  in(x, y) { return x >= this.clip.x0 && y >= this.clip.y0 && x < this.clip.x1 && y < this.clip.y1 }
  set(x, y, c) {
    if (this.dry) return
    if (!this.in(x, y)) { this.clipped = true; return }
    const old = this.rows[y][x]
    if (old.cont && x > 0 && this.rows[y][x - 1].w2) this.rows[y][x - 1] = { ch: ' ', tone: 'ink' }
    if (old.w2 && x + 1 < this.w) this.rows[y][x + 1] = { ch: ' ', tone: 'ink' }
    this.rows[y][x] = c
  }
  put(x, y, ch, tone, o) {
    const c = { ch, tone: tone || 'ink' }
    if (o) { if (o.b) c.b = true; if (o.bg) c.bg = o.bg; if (o.ref) c.ref = o.ref; if (o.px) c.px = true; if (o.m) c.m = 1 }
    if (cwOf(ch) === 2) {
      if (!this.in(x + 1, y)) { this.set(x, y, Object.assign(c, { ch: '…' })); return 1 }
      c.w2 = true
      this.set(x, y, c)
      this.set(x + 1, y, { ch: '', tone: c.tone, cont: true })
      return 2
    }
    this.set(x, y, c)
    return 1
  }
  // a line of items at (x, y); returns the cells it took
  line(x, y, line) {
    let dx = 0
    for (const c of line) dx += this.put(x + dx, y, c.ch, c.tone, { b: c.b, ref: c.ref })
    return dx
  }
  str(x, y, s, tone, o) { let dx = 0; for (const ch of Array.from(String(s))) dx += this.put(x + dx, y, ch, tone, o); return dx }
  fill(x, y, w, h, ch, tone, o) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.put(x + i, y + j, ch, tone, o) }
  // half-block pixels: y in half cells
  px(x, y2, tone) {
    if (this.dry) return
    const y = Math.floor(y2 / 2)
    if (!this.in(x, y)) { this.clipped = true; return }
    const old = this.rows[y][x]
    const top = y2 % 2 === 0 ? tone : (old.px ? old.pt : null)
    const bot = y2 % 2 === 1 ? tone : (old.px ? old.pb : null)
    let c
    if (top && bot) c = top === bot ? { ch: '█', tone: top } : { ch: '▀', tone: top, bg: bot }
    else if (top) c = { ch: '▀', tone: top }
    else c = { ch: '▄', tone: bot }
    c.px = true; c.pt = top; c.pb = bot
    this.rows[y][x] = c
  }
  pline(x0, y0, x1, y1, tone) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1)
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy, guard = 8000
    for (;;) {
      this.px(x0, y0, tone)
      if ((x0 === x1 && y0 === y1) || !guard--) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
  // braille dots: x in half cells across, y in quarter cells down. The dots of a cell add up; its tone (and its
  // series, sr) is the last one drawn
  dot4(x2, y4, tone, sr) {
    if (this.dry) return
    const x = Math.floor(x2 / 2), y = Math.floor(y4 / 4)
    if (!this.in(x, y)) { this.clipped = true; return }
    const dx = x2 - 2 * x, dy = y4 - 4 * y
    const bit = dy < 3 ? (dx === 0 ? 1 << dy : 1 << (dy + 3)) : (dx === 0 ? 0x40 : 0x80)
    const old = this.rows[y][x]
    const mask = (old.br || 0) | bit
    this.rows[y][x] = { ch: String.fromCharCode(0x2800 + mask), tone, br: mask, px: true, m: 1 }
    if (sr) this.rows[y][x].sr = sr
  }
  line4(x0, y0, x1, y1, tone, sr) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1)
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy, guard = 8000
    for (;;) {
      this.dot4(x0, y0, tone, sr)
      if ((x0 === x1 && y0 === y1) || !guard--) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
  // the cells of a mark's area, drawn or blank, as the mark's (m)
  markArea(x, y, w, h) {
    if (this.dry) return
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (this.in(i, j)) this.rows[j][i].m = 1
  }
  withClip(x0, y0, x1, y1, fn) {
    const prev = this.clip
    this.clip = { x0: Math.max(prev.x0, x0), y0: Math.max(prev.y0, y0), x1: Math.min(prev.x1, x1), y1: Math.min(prev.y1, y1) }
    try { return fn() } finally { this.clip = prev }
  }
}

// ---------------------------------------------------------------- sizes: {min, nat, grow, fixed}
function sizesOf(n, memo) {
  if (!n) return { min: 0, nat: 0, grow: 0 }
  let s = memo.get(n)
  if (s) return s
  s = baseSizes(n, memo)
  // a fixed width, except that a one-line text that is not a right-aligned value may cut itself with … to keep its
  // row inside the width, so the numbers beside it stay whole
  if (n.w != null) s = n.t === 'text' && n.wrap === false && n.align !== 'right' ? { min: Math.min(n.w, 6), nat: n.w, grow: 0 } : { min: n.w, nat: n.w, grow: 0, fixed: n.w }
  if (n.grow != null) s = Object.assign({}, s, { grow: n.grow })
  if (n.minW != null) s = Object.assign({}, s, { min: Math.min(n.minW, s.nat) })
  s.nat = Math.min(MAX_NAT, s.nat)
  s.min = Math.min(s.min, s.nat)
  memo.set(n, s)
  return s
}
function baseSizes(n, memo) {
  const S = k => sizesOf(k, memo)
  switch (n.t) {
    case 'text': {
      const hl = hardLines(items(n.runs))
      const nat = Math.max(0, ...hl.map(widthOf))
      if (n.wrap === false) return { min: Math.min(nat, 6), nat, grow: 0 }
      return { min: Math.min(nat, Math.max(1, Math.min(16, ...hl.map(longestWord)))), nat, grow: 0 }
    }
    case 'stack': {
      const ks = (n.kids || []).map(S)
      return { min: Math.max(0, ...ks.map(k => k.min)), nat: Math.max(0, ...ks.map(k => k.nat)), grow: Math.max(0, ...ks.map(k => k.grow)) }
    }
    case 'beside': {
      const ks = (n.kids || []).map(S)
      const g = (n.gap || 0) * Math.max(0, ks.length - 1)
      return { min: ks.reduce((a, k) => a + k.min, g), nat: ks.reduce((a, k) => a + k.nat, g), grow: Math.max(0, ...ks.map(k => k.grow)) }
    }
    case 'frame': {
      const k = S(n.kid)
      const head = len(plain(n.title)) + (n.right ? len(plain(n.right)) + 3 : 0) + 6
      return { min: Math.max(k.min + 4, Math.min(head, 12)), nat: Math.max(k.nat + 4, head), grow: k.grow }
    }
    case 'region': return S(n.kid)
    case 'space': return { min: n.w, nat: n.w, grow: 0, fixed: n.w }
    case 'rule': return { min: 1, nat: 1, grow: 1 }
    case 'bar': return { min: 4, nat: 12, grow: 1 }
    case 'spark': { const nat = Math.min(n.values.length || 1, 80); return { min: Math.min(nat, 8), nat, grow: 0 } }
    case 'plot': return { min: 16, nat: 48, grow: 1 }
    case 'table': { const t = tableCols(n, Infinity); return { min: t.min, nat: t.total, grow: 0 } }
    case 'unseen': return { min: 1, nat: Math.max(8, n.label ? len(n.label) + 4 : 0), grow: 1 }
    case 'canvas': return { min: n.w, nat: n.w, grow: 0, fixed: n.w }
  }
  return { min: 0, nat: 0, grow: 0 }
}
// the width a child takes in a column of width w
function widthIn(s, w) { return s.fixed != null ? Math.min(s.fixed, w) : s.grow > 0 ? w : Math.min(s.nat, w) }

// ---------------------------------------------------------------- tables: the column plan
function tableCols(n, avail) {
  const gap = 2
  const cellW = n.rows.map(r => r.cells.map(c => widthOf(items(c))))
  const head = n.head !== false
  const wd = n.cols.map((c, j) => c.w != null ? c.w : Math.max(head ? len(c.label) : 1, ...cellW.map(r => r[j] || 0), 1))
  const total = () => wd.reduce((s, x) => s + x, 0) + gap * Math.max(0, wd.length - 1)
  const min = n.cols.reduce((s, c, j) => s + Math.min(wd[j], 6), 0) + gap * Math.max(0, wd.length - 1)
  const nat = total()
  if (isFinite(avail)) {
    let guard = 4000
    while (total() > avail && guard--) {
      let k = -1, best = -1
      for (let j = 0; j < wd.length; j++) if (n.cols[j].align !== 'right' && wd[j] > best && wd[j] > 6 && n.cols[j].w == null) { best = wd[j]; k = j }
      if (k < 0) for (let j = 0; j < wd.length; j++) if (wd[j] > best && wd[j] > 3) { best = wd[j]; k = j }
      if (k < 0) break
      wd[k]--
    }
  }
  return { wd, gap, total: isFinite(avail) ? total() : nat, min }
}

// ---------------------------------------------------------------- paint
function paint(n, g, x, y, w, cx) {
  if (!n || w <= 0) return 0
  const S = k => sizesOf(k, cx.memo)
  const mark = m => { if (!g.dry) cx.marks.push(m) }
  const cut = c => { if (!g.dry) cx.cut.push(c) }
  switch (n.t) {
    case 'text': {
      const { lines, cut: wasCut } = textLines(n, w)
      lines.forEach((l, i) => {
        const lw = widthOf(l)
        const dx = n.align === 'right' ? w - lw : n.align === 'center' ? Math.floor((w - lw) / 2) : 0
        g.line(x + dx, y + i, l)
        if (!g.dry) linkRects(l, x + dx, y + i, cx)
      })
      mark({ k: 'text', s: plain(n.runs) })
      if (wasCut) cut({ k: 'text', s: plain(n.runs) })
      return lines.length
    }
    case 'stack': {
      let yy = y
      ;(n.kids || []).forEach((k, i) => {
        if (i && n.gap) yy += n.gap
        const kw = widthIn(S(k), w)
        const dx = n.align === 'right' ? w - kw : n.align === 'center' ? Math.floor((w - kw) / 2) : 0
        yy += paint(k, g, x + dx, yy, kw, cx)
      })
      return yy - y
    }
    case 'beside': {
      const kids = n.kids || []
      const ws = distribute(kids.map(S), w, n.gap || 0, true)
      const hs = kids.map((k, i) => heightOf(k, ws[i], cx))
      const H = Math.max(0, ...hs)
      let xx = x
      kids.forEach((k, i) => {
        const dy = n.align === 'bottom' ? H - hs[i] : n.align === 'middle' ? Math.floor((H - hs[i]) / 2) : 0
        paint(k, g, xx, y + dy, ws[i], cx)
        xx += ws[i] + (n.gap || 0)
      })
      return H
    }
    case 'frame': {
      const kw = widthIn(S(n.kid), Math.max(0, w - 4))
      const kh = heightOf(n.kid, kw, cx)
      const h = kh + 2
      const tone = n.tone || 'rule'
      if (!g.dry) {
        g.put(x, y, '╭', tone); g.put(x + w - 1, y, '╮', tone); g.put(x, y + h - 1, '╰', tone); g.put(x + w - 1, y + h - 1, '╯', tone)
        g.fill(x + 1, y, w - 2, 1, '─', tone); g.fill(x + 1, y + h - 1, w - 2, 1, '─', tone)
        g.fill(x, y + 1, 1, h - 2, '│', tone); g.fill(x + w - 1, y + 1, 1, h - 2, '│', tone)
        // ╭─ title ──────── right ─╮ : the title first; the right text takes what is left, at least half when cut
        const avail = w - 6
        const tl = n.title ? len(plain(n.title)) : 0, rl = n.right ? len(plain(n.right)) : 0
        let tRoom = tl, rRoom = rl
        if (tl + (rl ? rl + 3 : 0) > avail) {
          rRoom = rl ? Math.max(0, Math.min(rl, Math.max(Math.floor(avail / 2) - 2, avail - tl - 3))) : 0
          tRoom = Math.max(0, avail - (rRoom ? rRoom + 3 : 0))
        }
        if (n.title && tRoom > 0) {
          const r = cutLine(items(n.title), tRoom)
          g.put(x + 2, y, ' ', tone); g.line(x + 3, y, r.line); g.put(x + 3 + widthOf(r.line), y, ' ', tone)
          linkRects(r.line, x + 3, y, cx)
          if (r.cut) cut({ k: 'title', s: plain(n.title) })
        }
        if (n.right && rRoom > 0) {
          const r = cutLine(items(n.right), rRoom)
          const rw = widthOf(r.line)
          g.put(x + w - 4 - rw, y, ' ', tone); g.line(x + w - 3 - rw, y, r.line); g.put(x + w - 3, y, ' ', tone)
          linkRects(r.line, x + w - 3 - rw, y, cx)
          if (r.cut) cut({ k: 'frame-right', s: plain(n.right) })
        }
        if (n.bottom) {
          const r = cutLine(items(n.bottom), Math.max(0, w - 6))
          if (r.line.length) { g.put(x + 2, y + h - 1, ' ', tone); g.line(x + 3, y + h - 1, r.line); g.put(x + 3 + widthOf(r.line), y + h - 1, ' ', tone); linkRects(r.line, x + 3, y + h - 1, cx) }
        }
      }
      if (n.title) mark({ k: 'title', s: plain(n.title) })
      if (n.right) mark({ k: 'text', s: plain(n.right) })
      g.withClip(x + 1, y + 1, x + w - 1, y + h - 1, () => paint(n.kid, g, x + 2, y + 1, kw, cx))
      if (n.bottom) mark({ k: 'text', s: plain(n.bottom) })
      return h
    }
    case 'region': {
      mark({ k: 'region', id: n.id })
      const h = paint(n.kid, g, x, y, w, cx)
      if (!g.dry) addRect(cx, n.id, n.meta, { x, y, w, h })
      return h
    }
    case 'space': return n.h
    case 'rule': { g.fill(x, y, w, 1, '─', n.tone || 'rule'); return 1 }
    case 'bar': {
      drawBar(g, x, y, w, n.value, n.max, n.tone, n.parts, n.track)
      mark({ k: 'bar', v: n.value, max: n.max, parts: n.parts ? n.parts.map(p => p.value) : undefined })
      // a part with a region of its own (drawn from a row): the cells it covers, at least one
      if (n.parts && n.parts.some(p => p.region)) {
        const m = n.max > 0 ? n.max : 1
        let cum = 0, from = 0
        for (const p of n.parts) {
          cum += p.value
          const to = Math.round(clamp(cum / m, 0, 1) * w)
          if (p.region) {
            mark({ k: 'region', id: p.region })
            if (!g.dry) addRect(cx, p.region, p.meta, { x: x + Math.min(from, Math.max(0, w - 1)), y, w: Math.max(1, to - from), h: 1 })
          }
          from = to
        }
      }
      return 1
    }
    case 'spark': {
      const cw = Math.max(1, Math.min(w, n.w != null ? n.w : n.values.length))
      drawSpark(g, x, y, cw, n.values, n.min, n.max, n.tone, n.tones)
      mark({ k: 'spark', values: n.values })
      return 1
    }
    case 'plot': return paintPlot(n, g, x, y, w, cx, mark)
    case 'table': {
      const t = tableCols(n, w)
      const xs = []
      let xx = x
      t.wd.forEach(cw => { xs.push(xx); xx += cw + t.gap })
      const tw = Math.min(w, t.total)
      let yy = y
      if (n.head !== false) {
        n.cols.forEach((c, j) => {
          const l = cutLine(items([{ s: c.label, tone: 'dim' }]), t.wd[j])
          const dx = c.align === 'right' ? t.wd[j] - widthOf(l.line) : 0
          g.line(xs[j] + dx, yy, l.line)
        })
        mark({ k: 'head', cells: n.cols.map(c => c.label) })
        yy++
      }
      n.rows.forEach(r => {
        r.cells.forEach((cell, j) => {
          const l = cutLine(items(cell), t.wd[j])
          const dx = n.cols[j].align === 'right' ? t.wd[j] - widthOf(l.line) : 0
          g.line(xs[j] + dx, yy, l.line)
          if (l.cut) cut({ k: 'cell', s: plain(cell) })
        })
        if (r.region) mark({ k: 'region', id: r.region })
        mark({ k: 'row', cells: r.cells.map(plain) })
        if (r.region && !g.dry) addRect(cx, r.region, r.meta, { x, y: yy, w: tw, h: 1 })
        yy++
      })
      if (n.more) { g.str(x, yy, `+ ${n.more.toLocaleString('en-US')} more rows`, 'dim'); mark({ k: 'more', n: n.more }); yy++ }
      return yy - y
    }
    case 'unseen': {
      const h = n.h || 1
      g.fill(x, y, w, h, '▒', 'unseen')
      if (n.label) { const l = ' ' + n.label + ' '; const lw = Math.min(len(l), w); g.str(x + Math.max(0, Math.floor((w - lw) / 2)), y + Math.floor((h - 1) / 2), l.slice(0, lw), 'dim') }
      mark({ k: 'unseen', label: n.label || '' })
      return h
    }
    case 'canvas': return paintCanvas(n, g, x, y, w, cx, mark, cut)
  }
  return 0
}
function heightOf(n, w, cx) {
  let m = cx.heights.get(n)
  if (!m) { m = new Map(); cx.heights.set(n, m) }
  if (m.has(w)) return m.get(w)
  const h = paint(n, cx.dryGrid, 0, 0, w, cx)
  m.set(w, h)
  return h
}
function addRect(cx, id, meta, r) {
  if (r.w <= 0 || r.h <= 0) return
  let e = cx.regions.get(id)
  if (!e) { e = { id, meta: meta || {}, rects: [] }; cx.regions.set(id, e) }
  e.rects.push(r)
}
function linkRects(line, x, y, cx) {
  let dx = 0, cur = null
  for (const c of line) {
    if (c.ref) {
      if (cur && cur.ref === c.ref && cur.x + cur.w === x + dx) cur.w += c.cw
      else { cur = { ref: c.ref, x: x + dx, w: c.cw }; cx.links.push(Object.assign(cur, { y })) }
    } else cur = null
    dx += c.cw
  }
}

// ---------------------------------------------------------------- marks drawn with cells
function drawBar(g, x, y, w, value, max, tone, parts, track) {
  try { drawBarCells(g, x, y, w, value, max, tone, parts, track) } finally { g.markArea(x, y, w, 1) }
}
function drawBarCells(g, x, y, w, value, max, tone, parts, track) {
  if (!isFinite(value) || tone === 'unseen') { g.fill(x, y, w, 1, '▒', 'unseen'); return }
  const m = max > 0 ? max : 1
  if (parts) {
    // every part is the same glyph, so the parts of one bar have one height and differ only in width; their names
    // are in the key k.bars draws above the rows
    let cum = 0, from = 0
    for (const p of parts) {
      cum += p.value
      const to = Math.round(clamp(cum / m, 0, 1) * w)
      g.fill(x + from, y, to - from, 1, p.tone === 'unseen' ? '▒' : BAR, p.tone)
      from = to
    }
    if (from === 0 && value > 0) g.put(x, y, '▏', parts[0] ? parts[0].tone : tone)
    return
  }
  const cells = Math.round(clamp(value / m, 0, 1) * w)
  if (cells === 0 && value > 0) g.put(x, y, '▏', tone)
  g.fill(x, y, cells, 1, BAR, tone)
  if (track) g.fill(x + Math.max(cells, value > 0 ? 1 : 0), y, w - Math.max(cells, value > 0 ? 1 : 0), 1, '·', 'rule')
}
export function resample(values, n) {
  if (values.length === n) return values.slice()
  const out = []
  if (values.length > n) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * values.length / n), b = Math.max(a + 1, Math.floor((i + 1) * values.length / n))
      const f = values.slice(a, b).filter(v => v !== null && isFinite(v))
      out.push(f.length ? f.reduce((s, v) => s + v, 0) / f.length : null)
    }
    return out
  }
  for (let i = 0; i < n; i++) out.push(values[Math.min(values.length - 1, Math.floor(i * values.length / n))])
  return out
}
function drawSpark(g, x, y, w, values, mn, mx, tone, tones) {
  const vals = resample(values, w)
  const same = vals.length === values.length
  vals.forEach((v, i) => {
    if (v === null || !isFinite(v)) { g.put(x + i, y, '▒', 'unseen'); return }
    const j = clamp(Math.floor((v - mn) / ((mx - mn) || 1) * 8), 0, 7)
    g.put(x + i, y, SPARK[j], same && tones && tones[i] ? tones[i] : tone)
  })
  g.markArea(x, y, w, 1)
}

// ---------------------------------------------------------------- plot: braille lines with an axis
/** Round values for an axis from lo to hi: about `n` steps of 1, 2 or 5 times a power of ten. */
export function niceTicks(lo, hi, n) {
  const span = hi - lo
  if (!(span > 0)) return { step: 1, ticks: [lo] }
  const raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map(q => q * p).find(q => q >= raw * 0.999) || 10 * p
  const ticks = []
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) ticks.push(+v.toPrecision(12))
  return { step, ticks }
}

// the fewest data rows a plot draws, whatever height the program asked for: on fewer, values a few steps apart share a
// row, and a series from 2.5 to 10 on a 0–10 scale reads as flat on the zero line
const MIN_PLOT_ROWS = 5

function paintPlot(n, g, x, y, w, cx, mark) {
  const S = n.series
  const xs = n.x || {}, ys = n.y || {}
  const xlog = !!xs.log
  const okX = v => isFinite(v) && (!xlog || v > 0)
  const all = []
  S.forEach(s => s.pts.forEach(p => { if (okX(p[0])) all.push(p) }))
  const tx = v => xlog ? Math.log10(v) : v
  const xv = all.map(p => p[0])
  let xmin = okX(xs.min) ? xs.min : xv.length ? Math.min(...xv) : 0
  let xmax = okX(xs.max) ? xs.max : xv.length ? Math.max(...xv) : 1
  if (xmax === xmin) xmax = xlog ? xmin * 10 : xmin + 1
  const yv = all.map(p => p[1]).filter(v => v !== null && isFinite(v))
  let ymin = isFinite(ys.min) ? ys.min : yv.length ? Math.min(...yv) : 0
  let ymax = isFinite(ys.max) ? ys.max : yv.length ? Math.max(...yv) : 1
  if (ymax === ymin) ymax = ymin + 1
  // the legend: one entry per named series, on the top row beside the y label when it fits there, else under the axis
  const legend = n.legend !== false && (S.length > 1 || S.some(s => s.name))
  const entries = legend ? S.map(s => ({ s, w: 2 + len(s.name || '') })) : []
  const legendW = entries.reduce((t, e) => t + e.w, 0) + Math.max(0, entries.length - 1) * 3
  const ylab = ys.label || ''
  const top = ylab || legend ? 1 : 0
  const legendTop = legend && (ylab ? len(ylab) + 3 : 0) + legendW <= w
  const bottom = legend && !legendTop ? 1 : 0
  const ph = Math.max(MIN_PLOT_ROWS, n.h - 2 - top - bottom)
  const h = ph + 2 + top + bottom
  // y in rows from the top of the plot area: the top value at the middle of the first row, the bottom value at the
  // middle of the last row, so a tick's label and the points at its value share a row, and points at the bottom
  // value sit beside its label, above the axis line
  const yAt = (v, lo, hi) => 0.5 + (hi - clamp(v, lo, hi)) / ((hi - lo) || 1) * (ph - 1)
  // round values on y: the most ticks that leave a row free between two labels, so the labels spread over the plot's
  // rows; inside the data's own range when two or more fit there, else with an end the program did not set out to
  // the next round value, as the browser draws it
  const fit = (extend, least) => {
    for (let k = Math.ceil(ph / 2); k >= 1; k--) {
      const step = niceTicks(ymin, ymax, k).step
      const lo = extend && !isFinite(ys.min) ? Math.floor(ymin / step + 1e-9) * step : ymin
      const hi = extend && !isFinite(ys.max) ? Math.ceil(ymax / step - 1e-9) * step : ymax
      const ts = niceTicks(lo, hi, (hi - lo) / step).ticks.filter(t => t >= lo - 1e-9 && t <= hi + 1e-9)
      if (ts.length >= least && ts.every((t, i) => i === 0 || Math.floor(yAt(ts[i - 1], lo, hi)) - Math.floor(yAt(t, lo, hi)) >= 2)) return { lo, hi, ts }
    }
    return null
  }
  const fitted = fit(false, 2) || fit(true, 2) || fit(false, 1) || { lo: ymin, hi: ymax, ts: [] }
  ymin = fitted.lo; ymax = fitted.hi
  const yticks = fitted.ts
  const yu = v => yAt(v, ymin, ymax)
  const ylabels = yticks.map(fmtTick)
  const yw = Math.max(1, ...ylabels.map(len))
  const ox = yw + 1
  const pw = Math.max(2, w - ox)
  const oy = top
  // braille: two dots across and four down per cell
  const col = v => Math.round((tx(v) - tx(xmin)) / ((tx(xmax) - tx(xmin)) || 1) * (pw - 1))
  const col2 = v => Math.round((tx(v) - tx(xmin)) / ((tx(xmax) - tx(xmin)) || 1) * (pw * 2 - 1))
  const row4 = v => clamp(Math.floor(yu(v) * 4), 0, ph * 4 - 1)
  // a series drawn as dots (the program asked for dots, or it has one point) shows a dot in the legend too
  const asDots = s => !!n.dots || s.pts.filter(p => okX(p[0]) && p[1] !== null).length === 1
  if (!g.dry) {
    if (ylab) g.str(x, y, ylab.slice(0, w), 'dim')
    const tickRow = new Map()
    yticks.forEach((t, i) => { const r = Math.floor(yu(t)); if (!tickRow.has(r)) tickRow.set(r, ylabels[i]) })
    for (let r = 0; r < ph; r++) {
      const lab = tickRow.get(r)
      if (lab) g.str(x + yw - len(lab), y + oy + r, lab, 'dim')
      g.put(x + yw, y + oy + r, lab ? '┤' : '│', 'rule')
    }
    const ay = y + oy + ph
    g.put(x + yw, ay, '└', 'rule')
    g.fill(x + yw + 1, ay, pw - 1, 1, '─', 'rule')
    let ticks = []
    if (Array.isArray(xs.ticks)) ticks = xs.ticks
    else if (xlog) { for (let e = Math.ceil(Math.log10(xmin) - 1e-9); e <= Math.floor(Math.log10(xmax) + 1e-9); e++) ticks.push({ at: Math.pow(10, e) }) }
    else {
      const span = xmax - xmin, step0 = Math.pow(10, Math.floor(Math.log10(span / 5 || 1)))
      let step = [1, 2, 5, 10].map(q => q * step0).find(q => span / q <= 6) || step0 * 10
      if (xv.length && xv.every(Number.isInteger)) step = Math.max(1, Math.round(step))
      for (let v = Math.ceil(xmin / step) * step; v <= xmax + 1e-9; v += step) ticks.push({ at: +v.toPrecision(10) })
    }
    let lastEnd = -1
    ticks.forEach(t => {
      if (!okX(t.at)) return
      const c = col(t.at)
      if (c < 0 || c >= pw) return
      g.put(x + ox + c, ay, '┴', 'rule')
      const s = t.label != null ? t.label : fmtTick(t.at)
      const start = clamp(ox + c - Math.floor((len(s) - 1) / 2), 0, w - len(s))
      if (start <= lastEnd + 1) return
      g.str(x + start, ay + 1, s, 'dim')
      lastEnd = start + len(s) - 1
    })
    if (xs.label && w - len(xs.label) > lastEnd + 2) g.str(x + w - len(xs.label), ay + 1, xs.label, 'dim')
    // later series first, so the first series is on top: a cell two series share takes its color
    g.withClip(x + ox, y + oy, x + ox + pw, y + oy + ph, () => {
      S.slice().reverse().forEach(s => {
        const P = s.pts.filter(p => okX(p[0])).sort((a, b) => a[0] - b[0])
        const dots = asDots(s)
        let prev = null
        for (const p of P) {
          if (p[1] === null) { prev = null; continue }
          const X = (x + ox) * 2 + col2(p[0]), Y = (y + oy) * 4 + row4(p[1])
          // a dot is four braille dots, both across its cell and two down, centered on its value
          if (dots) { const X0 = X - (X % 2), Y0 = (y + oy) * 4 + clamp(Math.round(yu(p[1]) * 4 - 1), 0, ph * 4 - 2); [0, 1].forEach(i => [0, 1].forEach(j => g.dot4(X0 + i, Y0 + j, s.tone, s.region))) }
          else if (prev) g.line4(prev[0], prev[1], X, Y, s.tone, s.region)
          else g.dot4(X, Y, s.tone, s.region)
          prev = [X, Y]
        }
      })
    })
    g.markArea(x + ox, y + oy, pw, ph)
  }
  // legend, one entry per series; a series with an id is a region (its legend entry and the plot area)
  const ly = legendTop ? y : y + h - 1
  let lx = legendTop ? x + w - legendW : x + ox
  S.forEach(s => {
    if (s.region) mark({ k: 'region', id: s.region })
    mark({ k: 'series', name: s.name, n: s.pts.length })
    const area = () => { if (s.region && !g.dry) addRect(cx, s.region, s.meta, { x: x + ox, y: y + oy, w: pw, h: ph }) }
    if (!legend) { area(); return }
    const name = s.name || ''
    if (lx + 2 + len(name) > x + w) { area(); return }
    if (!g.dry) { g.put(lx, ly, asDots(s) ? '⠶' : '━', s.tone); g.str(lx + 2, ly, name, s.tone) }
    if (s.region && !g.dry) addRect(cx, s.region, s.meta, { x: lx, y: ly, w: 2 + len(name), h: 1 })
    lx += 2 + len(name) + 3
  })
  return h
}

// ---------------------------------------------------------------- canvas: the program's own cells
// the box-drawing glyph of a cell by the sides its line leaves through: up 1, right 2, down 4, left 8
const SIDE_GLYPH = { 10: '─', 5: '│', 6: '╭', 12: '╮', 3: '╰', 9: '╯', 7: '├', 13: '┤', 14: '┬', 11: '┴', 15: '┼' }
const sideTo = (a, b) => (b.x > a.x ? 2 : b.x < a.x ? 8 : b.y > a.y ? 4 : 1)
/**
 * The cells of a link from (x0, y0) to (x1, y1), its ends left out, each {x, y, ch, sides}. It is straight when the ends
 * share a row or a column; else it goes across, then up or down at one column, then across again (`turn` 'v': down,
 * across at one row, down), so each glyph joins the next: ─ │ and the corners ╭ ╮ ╰ ╯. A diagonal step (╲ next to ─)
 * leaves a gap the eye reads as a broken line. `at` is the column (or row) of the middle leg; the middle by default.
 */
export function linkCells(x0, y0, x1, y1, turn, at) {
  const across = turn !== 'v'
  const mid = at != null ? at : across ? Math.round((x0 + x1) / 2) : Math.round((y0 + y1) / 2)
  const way = across ? [[mid, y0], [mid, y1], [x1, y1]] : [[x0, mid], [x1, mid], [x1, y1]]
  const P = [{ x: x0, y: y0 }]
  let guard = 8000
  for (const [tx, ty] of way) {
    let { x, y } = P[P.length - 1]
    while ((x !== tx || y !== ty) && guard--) {
      if (x !== tx) x += Math.sign(tx - x)
      else y += Math.sign(ty - y)
      P.push({ x, y })
    }
  }
  const out = []
  for (let i = 1; i < P.length - 1; i++) {
    const sides = sideTo(P[i], P[i - 1]) | sideTo(P[i], P[i + 1])
    out.push({ x: P[i].x, y: P[i].y, ch: SIDE_GLYPH[sides] || '─', sides })
  }
  return out
}

function paintCanvas(n, g, x, y, w, cx, mark, cut) {
  const cw = Math.min(n.w, w)
  if (n.w > w) cut({ k: 'canvas', w: n.w, room: w })
  let draws = 0
  // the cells this canvas's links took, so two links that share a cell join there
  const lines = new Map()
  g.withClip(x, y, x + cw, y + n.h, () => {
    for (const op of n.ops) {
      switch (op[0]) {
        case 'put': g.put(x + op[1], y + op[2], op[3], op[4], { b: op[5] === 1, bg: op[6] }); draws++; break
        case 'text': {
          const [, tx, ty, runs, align, max] = op
          let line = items(runs)
          let wasCut = false
          if (max != null) { const r = cutLine(line, max); line = r.line; wasCut = r.cut }
          const lw = widthOf(line)
          const sx = align === 'right' ? tx - lw + 1 : align === 'center' ? tx - Math.floor(lw / 2) : tx
          g.line(x + sx, y + ty, line)
          if (!g.dry) linkRects(line, x + sx, y + ty, cx)
          mark({ k: 'text', s: plain(runs) })
          if (wasCut) cut({ k: 'text', s: plain(runs) })
          break
        }
        case 'fill': g.fill(x + op[1], y + op[2], op[3], op[4], op[5], op[6]); draws++; break
        case 'hline': g.fill(x + op[1], y + op[2], op[3], 1, op[4], op[5]); draws++; break
        case 'vline': g.fill(x + op[1], y + op[2], 1, op[3], op[4], op[5]); draws++; break
        case 'box': {
          const [, bx, by, bw, bh, tone, title, f] = op
          if (bw < 2 || bh < 2) break
          if (f && f.fill && bw > 2 && bh > 2) g.fill(x + bx + 1, y + by + 1, bw - 2, bh - 2, ' ', 'ink')
          g.put(x + bx, y + by, '╭', tone); g.put(x + bx + bw - 1, y + by, '╮', tone)
          g.put(x + bx, y + by + bh - 1, '╰', tone); g.put(x + bx + bw - 1, y + by + bh - 1, '╯', tone)
          g.fill(x + bx + 1, y + by, bw - 2, 1, '─', tone); g.fill(x + bx + 1, y + by + bh - 1, bw - 2, 1, '─', tone)
          g.fill(x + bx, y + by + 1, 1, bh - 2, '│', tone); g.fill(x + bx + bw - 1, y + by + 1, 1, bh - 2, '│', tone)
          if (title && bw > 6) { const r = cutLine(items(title), bw - 6); g.put(x + bx + 2, y + by, ' ', tone); g.line(x + bx + 3, y + by, r.line); g.put(x + bx + 3 + widthOf(r.line), y + by, ' ', tone); mark({ k: 'title', s: plain(title) }) }
          draws++
          break
        }
        case 'bg': {
          // the ground of cells already drawn
          if (!g.dry) for (let j = 0; j < op[4]; j++) for (let i = 0; i < op[3]; i++) { const cx0 = x + op[1] + i, cy0 = y + op[2] + j; if (g.in(cx0, cy0)) g.rows[cy0][cx0] = Object.assign({}, g.rows[cy0][cx0], { bg: op[5] }) }
          draws++
          break
        }
        case 'px': g.px(x + op[1], y * 2 + op[2], op[3]); draws++; break
        case 'line': g.pline(x + op[1], y * 2 + op[2], x + op[3], y * 2 + op[4], op[5]); draws++; break
        case 'dot': {
          // the nearest cell's glyph; a dot that is a part is that one cell
          const [, dx0, dy0, tone, f] = op
          const cx0 = Math.round(dx0), cy0 = Math.round(dy0)
          g.put(x + cx0, y + cy0, f.glyph || (f.hollow ? '○' : f.size >= 2 ? '◉' : '●'), tone, { b: !!f.bold, bg: f.bg })
          if (f.label) {
            // its words from the cell after the next, on blank cells only
            if (!g.dry) Array.from(f.label).forEach((ch, i) => { const gx = x + cx0 + 2 + i, gy = y + cy0; if (g.in(gx, gy) && g.rows[gy][gx].ch === ' ') g.put(gx, gy, ch, f.labelTone) })
            mark({ k: 'text', s: f.label })
          }
          if (f.region) {
            mark({ k: 'region', id: f.region })
            if (!g.dry && cx0 >= 0 && cy0 >= 0 && cx0 < cw && cy0 < n.h) addRect(cx, f.region, f.meta, { x: x + cx0, y: y + cy0, w: 1, h: 1 })
          }
          draws++
          break
        }
        case 'link': {
          // a link joins its two ends or is not drawn: the first route whose cells are all blank, or lines of this
          // canvas's links (which then meet as ┬ ┤ ┼); across first for a wide link, down first for a tall one, then
          // the other, then with its middle leg beside either end. Dashed: every other straight cell.
          if (g.dry) break
          const [x0, y0, x1, y1] = [op[1], op[2], op[3], op[4]].map(Math.round)
          const sx = Math.sign(x1 - x0), sy = Math.sign(y1 - y0)
          const free = p => {
            const gx = x + p.x, gy = y + p.y
            if (!g.in(gx, gy)) return false
            const c = g.rows[gy][gx]
            return lines.has(gx + ',' + gy) || (c.ch === ' ' && !c.bg)
          }
          const first = Math.abs(x1 - x0) >= Math.abs(y1 - y0) ? 'h' : 'v', other = first === 'h' ? 'v' : 'h'
          const tries = [[first], [other], ['h', x0 + sx], ['h', x1 - sx], ['v', y0 + sy], ['v', y1 - sy]]
          const route = tries.map(([t, at]) => linkCells(x0, y0, x1, y1, t, at)).find(cs => cs.every(free))
          if (!route) break
          route.forEach((p, i) => {
            const gx = x + p.x, gy = y + p.y, key = gx + ',' + gy
            const had = lines.get(key)
            const sides = (had ? had.sides : 0) | p.sides
            const tone = had ? had.tone : op[5]
            lines.set(key, { sides, tone })
            if (op[6].dash && !had && (sides === 10 || sides === 5) && i % 2) return
            g.put(gx, gy, op[6].dash && sides === 10 ? '╌' : op[6].dash && sides === 5 ? '╎' : SIDE_GLYPH[sides] || '─', tone)
          })
          draws++
          break
        }
        case 'bar': drawBar(g, x + op[1], y + op[2], op[3], op[4], op[5], op[6]); mark({ k: 'bar', v: op[4], max: op[5] }); break
        case 'spark': drawSpark(g, x + op[1], y + op[2], Math.max(1, op[3]), op[4], op[5], op[6], op[7]); mark({ k: 'spark', values: op[4] }); break
        case 'region': {
          mark({ k: 'region', id: op[1] })
          if (!g.dry) {
            const rx = Math.max(0, op[2]), ry = Math.max(0, op[3])
            const rw = Math.min(op[2] + op[4], cw) - rx, rh = Math.min(op[3] + op[5], n.h) - ry
            addRect(cx, op[1], op[6], { x: x + rx, y: y + ry, w: rw, h: rh })
          }
          break
        }
      }
    }
  })
  mark({ k: 'canvas', w: n.w, h: n.h, draws })
  return n.h
}

// ---------------------------------------------------------------- entry
/**
 * Lay a drawing out in cells.
 * @param {object} drawing from kit.js
 * @param {{w?: number}} [opts] the width in cells (default: the width the program ran at)
 */
export function renderTerm(drawing, opts = {}) {
  const W = Math.max(8, Math.floor(opts.w || drawing.w || 96))
  const cx = { memo: new WeakMap(), heights: new WeakMap(), regions: new Map(), links: [], marks: [], cut: [] }
  cx.dryGrid = new Grid(W, 1, true)
  const root = drawing.root
  const s = sizesOf(root, cx.memo)
  const w = widthIn(s, W)
  const h = heightOf(root, w, cx)
  const g = new Grid(w, h)
  paint(root, g, 0, 0, w, cx)
  // regions in the drawing's order, then any link that points at an id no region drew (a cite or examples set)
  const regions = []
  const seen = new Set()
  for (const r of drawing.regions || []) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const e = cx.regions.get(r.id)
    regions.push({ id: r.id, meta: r.meta || {}, rects: e ? e.rects.slice() : [] })
  }
  for (const l of cx.links) {
    let e = regions.find(r => r.id === l.ref)
    if (!e) {
      const meta = {}
      if (drawing.cites && drawing.cites[l.ref]) { meta.cite = l.ref; meta.label = drawing.cites[l.ref].text || l.ref }
      else if (drawing.examples && drawing.examples[l.ref]) { meta.examples = l.ref; meta.label = drawing.examples[l.ref].label || l.ref }
      else if (knobOf(drawing, l.ref)) { const c = knobOf(drawing, l.ref); meta.knob = c.id; meta.label = `${c.label} ${c.shown[c.i]}` }
      else meta.label = l.ref
      e = { id: l.ref, meta, rects: [], link: true }
      regions.push(e)
    }
    e.rects.push({ x: l.x, y: l.y, w: l.w, h: 1 })
  }
  if (g.clipped) cx.cut.push({ k: 'clip' })
  return { w, h, rows: g.rows, regions, marks: cx.marks, cut: cx.cut, warnings: drawing.warnings || [], error: drawing.error }
}

/** The grid as plain text, one line per row, trailing spaces trimmed. */
export function gridText(grid) {
  return grid.rows.map(r => r.filter(c => !c.cont).map(c => c.ch).join('').replace(/\s+$/, '')).join('\n')
}

/** The region at cell (x, y): the smallest one there, or null. */
export function regionAt(grid, x, y) {
  let best = null, area = Infinity
  for (const r of grid.regions) for (const q of r.rects) {
    if (x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h && q.w * q.h < area) { best = r; area = q.w * q.h }
  }
  return best
}

/** The id of the region after (dir 1) or before (dir -1) `id` in reading order, for tab and arrow keys. */
export function nextRegion(grid, id, dir = 1) {
  const list = grid.regions.filter(r => r.rects.length).slice().sort((a, b) => a.rects[0].y - b.rects[0].y || a.rects[0].x - b.rects[0].x)
  if (!list.length) return null
  const i = list.findIndex(r => r.id === id)
  if (i < 0) return list[dir > 0 ? 0 : list.length - 1].id
  return list[(i + dir + list.length) % list.length].id
}

