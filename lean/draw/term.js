// term.js: the terminal renderer. It lays a drawing (kit.js) out in cells, by rules of its own:
//
//   - widths are whole cells; `beside` shares them by flex.js; text wraps at spaces and is cut with … only when a
//     line has no room at all;
//   - a bar is whole ▆ cells (▏ for a value under one cell; stacked parts round cumulatively), so bars on
//     neighboring rows keep a gap between them; the number beside it carries the precision;
//   - a spark is one cell per value (averaged when there are more values than cells), on eight levels ▁..█;
//   - a plot is half-block pixels, two per cell down, with an axis of ┤ └ ┴ and the end values;
//   - a table is padded columns, numbers right-aligned, the widest text column shrinking first;
//   - unseen data is ▒ (a medium shade), never blank, so a gap reads as a gap;
//   - a canvas is replayed as the program placed it.
//
// renderTerm(drawing, {w}) -> grid {w, h, rows, regions, marks, cut}
//   rows     h rows of w cells {ch, tone, b?, bg?, ref?, px?, w2?, cont?}; tone is a palette.js tone
//   regions  [{id, meta, rects: [{x, y, w, h}]}] in the drawing's order; links ([words](#id)) add rects to `id`
//   marks    what was drawn, in tree order and renderer-free (text, values, rows, regions): svg.js returns the same
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
    if (o) { if (o.b) c.b = true; if (o.bg) c.bg = o.bg; if (o.ref) c.ref = o.ref; if (o.px) c.px = true }
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
  if (n.w != null) s = { min: n.w, nat: n.w, grow: 0, fixed: n.w }
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
  if (!isFinite(value) || tone === 'unseen') { g.fill(x, y, w, 1, '▒', 'unseen'); return }
  const m = max > 0 ? max : 1
  if (parts) {
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
}

// ---------------------------------------------------------------- plot: half-block pixels with an axis
function paintPlot(n, g, x, y, w, cx, mark) {
  const h = n.h
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
  const ymin = isFinite(ys.min) ? ys.min : yv.length ? Math.min(...yv) : 0
  let ymax = isFinite(ys.max) ? ys.max : yv.length ? Math.max(...yv) : 1
  if (ymax === ymin) ymax = ymin + 1
  const legend = n.legend !== false && (S.length > 1 || S.some(s => s.name)) ? 1 : 0
  const yl = [fmtTick(ymax), fmtTick(ymin)]
  const yw = Math.max(len(yl[0]), len(yl[1]))
  const ox = yw + 1
  const oy = ys.label ? 1 : 0
  const ph = Math.max(1, h - 2 - legend - oy)
  const pw = Math.max(2, w - ox)
  const PH = ph * 2
  const col = v => Math.round((tx(v) - tx(xmin)) / ((tx(xmax) - tx(xmin)) || 1) * (pw - 1))
  const row = v => Math.round((ymax - clamp(v, ymin, ymax)) / ((ymax - ymin) || 1) * (PH - 1))
  if (!g.dry) {
    if (ys.label) g.str(x, y, ys.label.slice(0, w), 'dim')
    for (let r = 0; r < ph; r++) {
      const lab = r === 0 ? yl[0] : r === ph - 1 ? yl[1] : ''
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
    // later series first, so the first series is on top
    g.withClip(x + ox, y + oy, x + ox + pw, y + oy + ph, () => {
      S.slice().reverse().forEach(s => {
        const P = s.pts.filter(p => okX(p[0])).sort((a, b) => a[0] - b[0])
        let prev = null
        for (const p of P) {
          if (p[1] === null) { prev = null; continue }
          const cxp = x + ox + col(p[0]), cyp = (y + oy) * 2 + row(p[1])
          if (prev && !n.dots) g.pline(prev[0], prev[1], cxp, cyp, s.tone)
          else g.px(cxp, cyp, s.tone)
          prev = [cxp, cyp]
        }
      })
    })
  }
  // legend, one entry per series; a series with an id is a region (its legend entry and the plot area)
  let lx = x + ox
  const ly = y + h - 1
  S.forEach(s => {
    if (s.region) mark({ k: 'region', id: s.region })
    mark({ k: 'series', name: s.name, n: s.pts.length })
    if (!legend) { if (s.region && !g.dry) addRect(cx, s.region, s.meta, { x: x + ox, y: y + oy, w: pw, h: ph }); return }
    const name = s.name || ''
    if (lx + 2 + len(name) > x + w) { if (s.region && !g.dry) addRect(cx, s.region, s.meta, { x: x + ox, y: y + oy, w: pw, h: ph }); return }
    if (!g.dry) { g.put(lx, ly, '▀', s.tone); g.str(lx + 2, ly, name, s.region ? 'accent' : 'ink') }
    if (s.region && !g.dry) addRect(cx, s.region, s.meta, { x: lx, y: ly, w: 2 + len(name), h: 1 })
    lx += 2 + len(name) + 3
  })
  return h
}

// ---------------------------------------------------------------- canvas: the program's own cells
function paintCanvas(n, g, x, y, w, cx, mark, cut) {
  const cw = Math.min(n.w, w)
  if (n.w > w) cut({ k: 'canvas', w: n.w, room: w })
  let draws = 0
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
          const [, bx, by, bw, bh, tone, title] = op
          if (bw < 2 || bh < 2) break
          g.put(x + bx, y + by, '╭', tone); g.put(x + bx + bw - 1, y + by, '╮', tone)
          g.put(x + bx, y + by + bh - 1, '╰', tone); g.put(x + bx + bw - 1, y + by + bh - 1, '╯', tone)
          g.fill(x + bx + 1, y + by, bw - 2, 1, '─', tone); g.fill(x + bx + 1, y + by + bh - 1, bw - 2, 1, '─', tone)
          g.fill(x + bx, y + by + 1, 1, bh - 2, '│', tone); g.fill(x + bx + bw - 1, y + by + 1, 1, bh - 2, '│', tone)
          if (title && bw > 6) { const r = cutLine(items(title), bw - 6); g.put(x + bx + 2, y + by, ' ', tone); g.line(x + bx + 3, y + by, r.line); g.put(x + bx + 3 + widthOf(r.line), y + by, ' ', tone); mark({ k: 'title', s: plain(title) }) }
          draws++
          break
        }
        case 'px': g.px(x + op[1], y * 2 + op[2], op[3]); draws++; break
        case 'line': g.pline(x + op[1], y * 2 + op[2], x + op[3], y * 2 + op[4], op[5]); draws++; break
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

