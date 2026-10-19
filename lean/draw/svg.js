// svg.js: the browser renderer. It lays a drawing (kit.js) out in pixels, with type, by rules of its own:
//
//   - a column the program counts in (k.w, a `w` option) is `cw` pixels, so the object keeps its proportions, but
//     text is set in a proportional font, measured, and wrapped by its real width;
//   - a bar is a rectangle as long as its value (not its cells), stacked parts exact, unseen data hatched;
//   - a spark is a line through its values, a plot real axes and lines;
//   - a table sets its numbers right-aligned in tabular figures, under a hairline;
//   - a canvas keeps the program's cell grid, but draws what it can read as meaning: box-drawing lines as strokes,
//     block glyphs as rectangles, half-block pixels and lines at their positions, its bars and sparks from values.
//
// renderSvg(drawing, {w, cw, lh, fs, theme, measure, selected, hover}) -> {svg, w, h, regions, marks, cut}
//   regions  [{id, meta, rects: [{x, y, w, h}]}] in pixels, in the drawing's order (the same ids term.js gives)
//   marks    the same list term.js returns for the same drawing: what was drawn, renderer-free
// Pure: no DOM unless `measure` uses one (canvasMeasure below). In Node it measures with approxMeasure.
import { distribute } from './flex.js'
import { knobOf } from './handoff.js'
import { hex } from './palette.js'

export const SANS = '"Instrument Sans", Inter, -apple-system, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif'
export const MONO = '"JetBrains Mono", "SF Mono", Menlo, "DejaVu Sans Mono", monospace'
const LEVEL = '▁▂▃▄▅▆▇█'
const LEFT = { '▏': 1, '▎': 2, '▍': 3, '▌': 4, '▋': 5, '▊': 6, '▉': 7 }
const SHADE = { '░': 1, '▒': 2, '▓': 3 }
const plain = runs => (runs || []).map(r => r.br ? '\n' : r.s).join('')
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const r1 = v => Math.round(v * 100) / 100
// a bar part's words in place, as term.js says them: its label and value, else its label, when they fit
/** The words a stacked bar's part shows in place: its label with its value, else its label, else none. They are
 *  measured in the type they are drawn in and fit the part's width with `pad` at each side, so they never run into
 *  the next part. */
function inPlace(label, value, room, measure, pad) {
  const l = String(label).trim()
  const v = isFinite(value) ? (Math.abs(value) >= 1000 ? Math.round(value).toLocaleString('en-US') : String(Math.round(value * 100) / 100)) : ''
  for (const s of [v ? `${l} ${v}` : l, l]) if (s && measure(s) + 2 * pad <= room) return s
  return ''
}
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// a text's own type as an inline style: the drawing's stylesheet sets every text's size and face, which a font-size or
// font-family attribute does not override, so a text measured in a size of its own is drawn in that size
const typeStyle = o => {
  const s = [o.size ? `font-size:${r1(o.size)}px` : '', o.mono ? `font-family:${MONO.replace(/"/g, "'")}` : ''].filter(Boolean).join(';')
  return s ? ` style="${s}"` : ''
}
const fmtTick = v => !isFinite(v) ? '' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toPrecision(3))

// ---------------------------------------------------------------- measuring type
// Widths of a Helvetica-like face in em, for measuring where there is no canvas (Node, tests).
const NARROW = 'il.,:;|!\'`ijl'
const SEMI = 'fjrtI()[]{}" -'
const WIDE = 'mwMW@%'
export function approxMeasure(s, o = {}) {
  const size = o.size || 13
  let em = 0
  for (const ch of Array.from(String(s))) {
    if (o.mono) { em += 0.6; continue }
    if (/[0-9]/.test(ch)) em += 0.556
    else if (NARROW.includes(ch)) em += 0.24
    else if (SEMI.includes(ch)) em += 0.31
    else if (WIDE.includes(ch)) em += 0.86
    else if (/[A-Z]/.test(ch)) em += 0.66
    else if (/[a-z]/.test(ch)) em += 0.52
    else if (ch.codePointAt(0) >= 0x2E80) em += 1
    else em += 0.58
  }
  return em * size * (o.bold ? 1.05 : 1)
}
/** A measure function for a page: the canvas's own metrics for the font the SVG sets. */
export function canvasMeasure(doc) {
  const ctx = (doc || document).createElement('canvas').getContext('2d')
  const cache = new Map()
  return (s, o = {}) => {
    const font = `${o.bold ? 600 : 400} ${o.size || 13}px ${o.mono ? MONO : SANS}`
    const key = font + '|' + s
    let v = cache.get(key)
    if (v == null) { ctx.font = font; v = ctx.measureText(String(s)).width; cache.set(key, v) }
    return v
  }
}

// ---------------------------------------------------------------- text: pieces, words, lines
function textPieces(runs) {
  const out = []
  for (const r of runs || []) {
    if (r.br) { out.push({ br: true }); continue }
    for (const part of String(r.s).split(/( +)/)) if (part) out.push({ s: part, tone: r.tone || 'ink', b: !!r.b, ref: r.ref, sp: /^ +$/.test(part) })
  }
  return out
}
// hard lines of words; a word is the pieces between spaces (it may change style midway)
function hardWords(runs) {
  const lines = [[]]
  let word = null
  for (const p of textPieces(runs)) {
    if (p.br) { word = null; lines.push([]); continue }
    if (p.sp) { word = null; lines[lines.length - 1].push({ sp: true, pieces: [p] }); continue }
    if (!word) { word = { pieces: [] }; lines[lines.length - 1].push(word) }
    word.pieces.push(p)
  }
  return lines
}

// ---------------------------------------------------------------- entry
/**
 * Lay a drawing out in pixels and draw it as SVG.
 * @param {object} drawing from kit.js
 * @param {{w?: number, cw?: number, lh?: number, fs?: number, theme?: 'light'|'dark', measure?: Function,
 *          selected?: string, hover?: string, hits?: boolean}} [opts]
 */
export function renderSvg(drawing, opts = {}) {
  const cw = opts.cw || 7.8, lh = opts.lh || 20, fs = opts.fs || 13
  const theme = opts.theme || 'light'
  const M = opts.measure || approxMeasure
  const C = t => hex(t, theme)
  const W = (opts.w || drawing.w || 96) * cw
  const PADX = 14
  const bh = Math.round(lh * 0.55), by = (lh - bh) / 2
  const id = 'dk' + Math.random().toString(36).slice(2, 8)
  const memo = new WeakMap(), heights = new WeakMap()
  const cx = { regions: new Map(), links: [], marks: [], cut: [] }
  const mw = (s, o) => M(s, Object.assign({ size: fs }, o))
  const piecesW = ps => ps.reduce((a, p) => a + mw(p.s, { bold: p.b }), 0)
  const base = (y, size) => y + lh / 2 + (size || fs) * 0.35

  // ------------------------------------------------ text lines at width w
  function textLines(n, w) {
    const lines = []
    let cut = false
    for (const hl of hardWords(n.runs)) {
      if (n.wrap === false) {
        const ps = hl.flatMap(t => t.pieces)
        const r = capPieces(ps, w)
        cut = cut || r.cut
        lines.push(r.pieces)
        continue
      }
      let cur = [], curW = 0
      const flush = () => { while (cur.length && cur[cur.length - 1].sp) { curW -= cur[cur.length - 1].w; cur.pop() } lines.push(cur.map(t => t.pieces).flat()); cur = []; curW = 0 }
      for (const t of hl) {
        t.w = piecesW(t.pieces)
        if (t.sp) { if (cur.length) { cur.push(t); curW += t.w } continue }
        if (curW + t.w <= w + 0.5 || !cur.length) {
          if (t.w > w && !cur.length) {
            // a word longer than the line: break it by characters
            let ps = [], pw = 0
            for (const p of t.pieces) for (const ch of Array.from(p.s)) {
              const cwid = mw(ch, { bold: p.b })
              if (pw + cwid > w && ps.length) { lines.push(ps); ps = []; pw = 0 }
              const last = ps[ps.length - 1]
              if (last && last.tone === p.tone && last.b === p.b && last.ref === p.ref) last.s += ch; else ps.push(Object.assign({}, p, { s: ch }))
              pw += cwid
            }
            cur = [{ pieces: ps, w: pw }]; curW = pw
            continue
          }
          cur.push(t); curW += t.w
        } else { flush(); cur.push(t); curW = t.w }
      }
      flush()
    }
    if (n.max != null && lines.length > n.max) {
      const keep = lines.slice(0, n.max)
      const r = capPieces(keep[keep.length - 1].concat([{ s: ' …', tone: 'dim', b: false }]), w)
      keep[keep.length - 1] = r.pieces
      return { lines: keep, cut: true }
    }
    return { lines, cut }
  }
  // pieces cut to w pixels with …
  function capPieces(ps, w) {
    if (piecesW(ps) <= w + 0.5) return { pieces: ps, cut: false }
    const ell = mw('…')
    const out = []
    let used = 0
    for (const p of ps) {
      let s = ''
      for (const ch of Array.from(p.s)) { const c = mw(ch, { bold: p.b }); if (used + c > w - ell) break; s += ch; used += c }
      if (s) out.push(Object.assign({}, p, { s }))
      if (s.length < Array.from(p.s).length) break
    }
    out.push({ s: '…', tone: 'dim', b: false })
    return { pieces: out, cut: true }
  }
  function textSVG(ps, x, y, anchor, o) {
    o = o || {}
    const size = o.size || fs
    let spans = ''
    for (const p of ps) {
      const attrs = [`fill="${C(p.tone || 'ink')}"`]
      if (p.b) attrs.push('font-weight="600"')
      if (p.ref) attrs.push('text-decoration="underline"')
      spans += `<tspan ${attrs.join(' ')}>${xml(p.s)}</tspan>`
    }
    return `<text x="${r1(x)}" y="${r1(base(y, size))}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${typeStyle(o)} xml:space="preserve">${spans}</text>`
  }
  function linkRects(ps, x, y, dry) {
    if (dry) return
    let dx = 0
    for (const p of ps) {
      const pw = mw(p.s, { bold: p.b })
      if (p.ref) {
        const last = cx.links[cx.links.length - 1]
        if (last && last.ref === p.ref && last.y === y && Math.abs(last.x + last.w - (x + dx)) < 0.5) last.w += pw
        else cx.links.push({ ref: p.ref, x: x + dx, y, w: pw, h: lh })
      }
      dx += pw
    }
  }

  // ------------------------------------------------ sizes in pixels
  function sizes(n) {
    if (!n) return { min: 0, nat: 0, grow: 0 }
    let s = memo.get(n)
    if (s) return s
    s = baseSizes(n)
    if (n.w != null) s = { min: n.w * cw, nat: n.w * cw, grow: 0, fixed: n.w * cw }
    if (n.grow != null) s = Object.assign({}, s, { grow: n.grow })
    if (n.minW != null) s = Object.assign({}, s, { min: Math.min(n.minW * cw, s.nat) })
    s.min = Math.min(s.min, s.nat)
    memo.set(n, s)
    return s
  }
  function baseSizes(n) {
    switch (n.t) {
      case 'text': {
        const hl = hardWords(n.runs)
        const nat = Math.max(0, ...hl.map(l => l.reduce((a, t) => a + piecesW(t.pieces), 0)))
        if (n.wrap === false) return { min: Math.min(nat, 6 * cw), nat, grow: 0 }
        const word = Math.max(1, ...hl.flatMap(l => l.filter(t => !t.sp).map(t => piecesW(t.pieces))))
        return { min: Math.min(nat, Math.min(word, 16 * cw)), nat, grow: 0 }
      }
      case 'stack': { const ks = (n.kids || []).map(sizes); return { min: Math.max(0, ...ks.map(k => k.min)), nat: Math.max(0, ...ks.map(k => k.nat)), grow: Math.max(0, ...ks.map(k => k.grow)) } }
      case 'beside': {
        const ks = (n.kids || []).map(sizes)
        const g = (n.gap || 0) * cw * Math.max(0, ks.length - 1)
        return { min: ks.reduce((a, k) => a + k.min, g), nat: ks.reduce((a, k) => a + k.nat, g), grow: Math.max(0, ...ks.map(k => k.grow)) }
      }
      case 'frame': {
        const k = sizes(n.kid)
        const head = (n.title ? piecesW(textPieces(n.title)) : 0) + (n.right ? piecesW(textPieces(n.right)) + 24 : 0) + 40
        return { min: Math.max(k.min + 2 * PADX, Math.min(head, 12 * cw)), nat: Math.max(k.nat + 2 * PADX, head), grow: k.grow }
      }
      case 'region': return sizes(n.kid)
      case 'space': return { min: n.w * cw, nat: n.w * cw, grow: 0, fixed: n.w * cw }
      case 'rule': return { min: cw, nat: cw, grow: 1 }
      case 'bar': return { min: 4 * cw, nat: 12 * cw, grow: 1 }
      case 'spark': { const nat = Math.min(n.values.length || 1, 80) * cw; return { min: Math.min(nat, 8 * cw), nat, grow: 0 } }
      case 'plot': return { min: 16 * cw, nat: 48 * cw, grow: 1 }
      case 'table': { const t = tablePlan(n, Infinity); return { min: t.min, nat: t.total, grow: 0 } }
      case 'unseen': return { min: cw, nat: Math.max(8 * cw, n.label ? mw(n.label) + 4 * cw : 0), grow: 1 }
      case 'canvas': return { min: n.w * cw, nat: n.w * cw, grow: 0, fixed: n.w * cw }
    }
    return { min: 0, nat: 0, grow: 0 }
  }
  const widthIn = (s, w) => s.fixed != null ? Math.min(s.fixed, w) : s.grow > 0 ? w : Math.min(s.nat, w)
  function heightOf(n, w) {
    let m = heights.get(n)
    if (!m) { m = new Map(); heights.set(n, m) }
    const key = Math.round(w * 100)
    if (m.has(key)) return m.get(key)
    const h = paint(n, null, 0, 0, w)
    m.set(key, h)
    return h
  }
  function tablePlan(n, avail) {
    const gap = 2 * cw
    const head = n.head !== false
    const cellW = n.rows.map(r => r.cells.map(c => piecesW(textPieces(c))))
    const wd = n.cols.map((c, j) => c.w != null ? c.w * cw : Math.max(head ? mw(c.label) : 0, ...cellW.map(r => r[j] || 0), cw))
    const total = () => wd.reduce((s, x) => s + x, 0) + gap * Math.max(0, wd.length - 1)
    const min = wd.reduce((s, x) => s + Math.min(x, 6 * cw), 0) + gap * Math.max(0, wd.length - 1)
    if (isFinite(avail)) {
      let over = total() - avail
      // the widest text column gives first, as in the terminal
      for (let guard = 0; over > 0.5 && guard < 200; guard++) {
        let k = -1, best = -1
        for (let j = 0; j < wd.length; j++) if (n.cols[j].align !== 'right' && wd[j] > best && wd[j] > 6 * cw && n.cols[j].w == null) { best = wd[j]; k = j }
        if (k < 0) for (let j = 0; j < wd.length; j++) if (wd[j] > best && wd[j] > 3 * cw) { best = wd[j]; k = j }
        if (k < 0) break
        const take = Math.min(over, wd[k] - 6 * cw > 0 ? wd[k] - 6 * cw : wd[k] - 3 * cw)
        wd[k] -= Math.max(1, take)
        over = total() - avail
      }
    }
    return { wd, gap, total: total(), min }
  }

  // ------------------------------------------------ paint (out == null measures)
  const L = { bg: [], frame: [], mark: [], text: [], over: [] }
  // brush areas (k.plot's brush, a canvas's c.brush): where a drag reads as a range of values
  const brushes = []
  function paint(n, out, x, y, w) {
    if (!n || w <= 0) return 0
    const dry = !out
    const mark = m => { if (!dry) cx.marks.push(m) }
    const cut = c => { if (!dry) cx.cut.push(c) }
    switch (n.t) {
      case 'text': {
        const { lines, cut: wasCut } = textLines(n, w)
        if (!dry) lines.forEach((ps, i) => {
          if (!ps.length) return
          const anchor = n.align === 'right' ? 'end' : n.align === 'center' ? 'middle' : 'start'
          const tx = anchor === 'end' ? x + w : anchor === 'middle' ? x + w / 2 : x
          L.text.push(textSVG(ps, tx, y + i * lh, anchor))
          const pw = piecesW(ps)
          linkRects(ps, anchor === 'end' ? x + w - pw : anchor === 'middle' ? x + (w - pw) / 2 : x, y + i * lh)
        })
        mark({ k: 'text', s: plain(n.runs) })
        if (wasCut) cut({ k: 'text', s: plain(n.runs) })
        return lines.length * lh
      }
      case 'stack': {
        let yy = y
        ;(n.kids || []).forEach((k, i) => {
          if (i && n.gap) yy += n.gap * lh
          const kw = widthIn(sizes(k), w)
          const dx = n.align === 'right' ? w - kw : n.align === 'center' ? (w - kw) / 2 : 0
          yy += paint(k, out, x + dx, yy, kw)
        })
        return yy - y
      }
      case 'beside': {
        const kids = n.kids || []
        const ws = distribute(kids.map(sizes), w, (n.gap || 0) * cw, false)
        const hs = kids.map((k, i) => heightOf(k, ws[i]))
        const H = Math.max(0, ...hs)
        let xx = x
        kids.forEach((k, i) => {
          const dy = n.align === 'bottom' ? H - hs[i] : n.align === 'middle' ? (H - hs[i]) / 2 : 0
          paint(k, out, xx, y + dy, ws[i])
          xx += ws[i] + (n.gap || 0) * cw
        })
        return H
      }
      case 'frame': {
        const kw = widthIn(sizes(n.kid), Math.max(0, w - 2 * PADX))
        const kh = heightOf(n.kid, kw)
        const top = lh + 4, bottom = n.bottom ? lh : 12
        const h = top + kh + bottom
        const tone = n.tone || 'rule'
        if (!dry) {
          L.frame.push(`<rect x="${r1(x + 0.5)}" y="${r1(y + lh / 2 + 0.5)}" width="${r1(w - 1)}" height="${r1(h - lh / 2 - (n.bottom ? lh / 2 : 0) - 1)}" rx="6" fill="none" stroke="${C(tone)}" stroke-width="1"/>`)
          const tw = n.title ? piecesW(textPieces(n.title)) : 0
          const rRoom = Math.max(0, w - 2 * PADX - (n.title ? Math.min(tw, (w - 2 * PADX) / 2) + 24 : 0))
          if (n.title) {
            const r = capPieces(textPieces(n.title), Math.max(0, w - 2 * PADX - (n.right ? Math.min(piecesW(textPieces(n.right)), rRoom) + 24 : 0)))
            const pw = piecesW(r.pieces)
            L.frame.push(`<rect x="${r1(x + PADX - 5)}" y="${r1(y + 1)}" width="${r1(pw + 10)}" height="${lh - 2}" fill="${C('paper')}"/>`)
            L.text.push(textSVG(r.pieces, x + PADX, y, 'start'))
            linkRects(r.pieces, x + PADX, y)
            if (r.cut) cut({ k: 'title', s: plain(n.title) })
          }
          if (n.right) {
            const r = capPieces(textPieces(n.right), rRoom)
            const pw = piecesW(r.pieces)
            L.frame.push(`<rect x="${r1(x + w - PADX - pw - 5)}" y="${r1(y + 1)}" width="${r1(pw + 10)}" height="${lh - 2}" fill="${C('paper')}"/>`)
            L.text.push(textSVG(r.pieces, x + w - PADX, y, 'end'))
            linkRects(r.pieces, x + w - PADX - pw, y)
            if (r.cut) cut({ k: 'frame-right', s: plain(n.right) })
          }
          if (n.bottom) {
            const r = capPieces(textPieces(n.bottom), w - 2 * PADX)
            const pw = piecesW(r.pieces)
            const yb = y + h - lh
            L.frame.push(`<rect x="${r1(x + PADX - 5)}" y="${r1(yb + 1)}" width="${r1(pw + 10)}" height="${lh - 2}" fill="${C('paper')}"/>`)
            L.text.push(textSVG(r.pieces, x + PADX, yb, 'start'))
            linkRects(r.pieces, x + PADX, yb)
          }
        }
        if (n.title) mark({ k: 'title', s: plain(n.title) })
        if (n.right) mark({ k: 'text', s: plain(n.right) })
        paint(n.kid, out, x + PADX, y + top, kw)
        if (n.bottom) mark({ k: 'text', s: plain(n.bottom) })
        return h
      }
      case 'region': {
        mark({ k: 'region', id: n.id })
        const h = paint(n.kid, out, x, y, w)
        if (!dry) addRect(n.id, n.meta, { x, y, w, h })
        return h
      }
      case 'space': return n.h * lh
      case 'rule': { if (!dry) L.mark.push(hl(x, x + w, y + lh / 2, n.tone || 'rule', '─')); return lh }
      case 'bar': {
        if (!dry) drawBar(x, y, w, n.value, n.max, n.tone, n.parts, n.track)
        mark({ k: 'bar', v: n.value, max: n.max, parts: n.parts ? n.parts.map(p => p.value) : undefined })
        // a part with a region of its own (drawn from a row): the span it covers, at least a few pixels
        if (n.parts && n.parts.some(p => p.region)) {
          const m = n.max > 0 ? n.max : 1
          let cum = 0
          for (const p of n.parts) {
            const a = clamp(cum / m, 0, 1) * w
            cum += p.value
            const b = clamp(cum / m, 0, 1) * w
            if (p.region) {
              mark({ k: 'region', id: p.region })
              if (!dry) addRect(p.region, p.meta, { x: x + Math.min(a, Math.max(0, w - 4)), y, w: Math.max(4, b - a), h: lh })
            }
          }
        }
        return lh
      }
      case 'spark': {
        const sw = Math.max(cw, Math.min(w, (n.w != null ? n.w : n.values.length) * cw))
        if (!dry) drawSpark(x, y, sw, n.values, n.min, n.max, n.tone)
        mark({ k: 'spark', values: n.values })
        return lh
      }
      case 'plot': return paintPlot(n, dry, x, y, w, mark)
      case 'table': {
        const t = tablePlan(n, w)
        const xs = []
        let xx = x
        t.wd.forEach(cwid => { xs.push(xx); xx += cwid + t.gap })
        const tw = Math.min(w, t.total)
        let yy = y
        if (n.head !== false) {
          if (!dry) {
            n.cols.forEach((c, j) => {
              const r = capPieces([{ s: c.label, tone: 'dim', b: false }], t.wd[j])
              L.text.push(textSVG(r.pieces, c.align === 'right' ? xs[j] + t.wd[j] : xs[j], yy, c.align === 'right' ? 'end' : 'start'))
            })
            L.mark.push(hl(x, x + tw, yy + lh - 0.5, 'rule', '─'))
          }
          mark({ k: 'head', cells: n.cols.map(c => c.label) })
          yy += lh
        }
        n.rows.forEach(r => {
          if (!dry) r.cells.forEach((cell, j) => {
            const res = capPieces(textPieces(cell), t.wd[j])
            const right = n.cols[j].align === 'right'
            L.text.push(textSVG(res.pieces, right ? xs[j] + t.wd[j] : xs[j], yy, right ? 'end' : 'start'))
            linkRects(res.pieces, right ? xs[j] + t.wd[j] - piecesW(res.pieces) : xs[j], yy)
            if (res.cut) cut({ k: 'cell', s: plain(cell) })
          })
          if (r.region) mark({ k: 'region', id: r.region })
          mark({ k: 'row', cells: r.cells.map(plain) })
          if (r.region && !dry) addRect(r.region, r.meta, { x, y: yy, w: tw, h: lh })
          yy += lh
        })
        if (n.more) {
          if (!dry) L.text.push(textSVG([{ s: `+ ${n.more.toLocaleString('en-US')} more rows`, tone: 'dim' }], x, yy, 'start'))
          mark({ k: 'more', n: n.more })
          yy += lh
        }
        return yy - y
      }
      case 'unseen': {
        const h = (n.h || 1) * lh
        if (!dry) {
          const one = (n.h || 1) === 1
          L.mark.push(`<rect x="${r1(x)}" y="${r1(one ? y + by : y)}" width="${r1(w)}" height="${r1(one ? bh : h)}" rx="2" fill="url(#${id}-hatch)"/>`)
          if (n.label) {
            const lw = Math.min(mw(n.label), w)
            L.text.push(`<rect x="${r1(x + (w - lw) / 2 - 4)}" y="${r1(y + h / 2 - lh / 2 + 3)}" width="${r1(lw + 8)}" height="${lh - 6}" fill="${C('paper')}"/>`)
            L.text.push(textSVG(capPieces([{ s: n.label, tone: 'dim' }], w).pieces, x + w / 2, y + h / 2 - lh / 2, 'middle'))
          }
        }
        mark({ k: 'unseen', label: n.label || '' })
        return h
      }
      case 'canvas': return paintCanvas(n, dry, x, y, w, mark, cut)
    }
    return 0
  }
  function addRect(rid, meta, r) {
    if (r.w <= 0 || r.h <= 0) return
    let e = cx.regions.get(rid)
    if (!e) { e = { id: rid, meta: meta || {}, rects: [] }; cx.regions.set(rid, e) }
    e.rects.push(r)
  }
  function hl(x0, x1, yy, tone, ch) {
    const sw = ch === '━' ? 2.5 : ch === '═' ? 1 : 1
    const dash = '╌┄┈'.includes(ch) ? ' stroke-dasharray="4 3"' : ch === '·' ? ' stroke-dasharray="1 3"' : ''
    const y0 = Math.round(yy) + 0.5
    if (ch === '═') return `<path d="M${r1(x0)},${y0 - 2}H${r1(x1)}M${r1(x0)},${y0 + 2}H${r1(x1)}" stroke="${C(tone)}" fill="none"/>`
    return `<line x1="${r1(x0)}" y1="${y0}" x2="${r1(x1)}" y2="${y0}" stroke="${C(tone)}" stroke-width="${sw}"${dash}/>`
  }
  function vl(xx, y0, y1, tone, ch) {
    const sw = ch === '┃' ? 2.5 : 1
    const dash = '╎┆┊'.includes(ch) ? ' stroke-dasharray="4 3"' : ''
    const x0 = Math.round(xx) + 0.5
    return `<line x1="${x0}" y1="${r1(y0)}" x2="${x0}" y2="${r1(y1)}" stroke="${C(tone)}" stroke-width="${sw}"${dash}/>`
  }
  function drawBar(x, y, w, value, max, tone, parts, track) {
    if (!isFinite(value) || tone === 'unseen') { L.mark.push(`<rect x="${r1(x)}" y="${r1(y + by)}" width="${r1(w)}" height="${bh}" rx="2" fill="url(#${id}-hatch)"/>`); return }
    const m = max > 0 ? max : 1
    if (track) L.mark.push(`<line x1="${r1(x)}" y1="${r1(y + lh / 2)}" x2="${r1(x + w)}" y2="${r1(y + lh / 2)}" stroke="${C('rule')}" stroke-dasharray="1 3"/>`)
    if (parts) {
      let cum = 0
      parts.forEach((p, i) => {
        const a = clamp(cum / m, 0, 1) * w
        cum += p.value
        const b = clamp(cum / m, 0, 1) * w
        if (b - a <= 0) return
        const seam = i < parts.length - 1 ? 1 : 0
        L.mark.push(p.tone === 'unseen'
          ? `<rect x="${r1(x + a)}" y="${r1(y + by)}" width="${r1(Math.max(0.5, b - a - seam))}" height="${bh}" fill="url(#${id}-hatch)"/>`
          : `<rect x="${r1(x + a)}" y="${r1(y + by)}" width="${r1(Math.max(0.5, b - a - seam))}" height="${bh}" fill="${C(p.tone)}"/>`)
        // a labelled part with room says what it is in place, as the terminal does, so the card needs no legend; its
        // words are measured in their own size and drawn in it, so they stay inside the part
        const size = Math.max(9, bh - 2)
        const words = p.label != null && p.tone !== 'unseen' ? inPlace(p.label, p.value, b - a - seam, t => mw(t, { size }), cw) : ''
        if (words) L.text.push(`<text x="${r1(x + a + cw)}" y="${r1(y + by + bh - 2)}"${typeStyle({ size })} fill="${C('paper')}" xml:space="preserve">${xml(words)}</text>`)
      })
      return
    }
    const bw = clamp(value / m, 0, 1) * w
    if (value > 0) L.mark.push(`<rect x="${r1(x)}" y="${r1(y + by)}" width="${r1(Math.max(1.5, bw))}" height="${bh}" rx="${r1(Math.min(2, bw / 2))}" fill="${C(tone)}"/>`)
  }
  function drawSpark(x, y, w, values, mn, mx, tone) {
    const n = values.length
    if (!n) return
    const px = i => x + (n === 1 ? w / 2 : 1.5 + i / (n - 1) * (w - 3))
    const py = v => y + lh - 3 - clamp((v - mn) / ((mx - mn) || 1), 0, 1) * (lh - 6)
    const segs = []
    let seg = []
    values.forEach((v, i) => {
      if (v === null || !isFinite(v)) { if (seg.length) segs.push(seg); seg = []; L.mark.push(`<rect x="${r1(px(i) - 2)}" y="${r1(y + lh - 7)}" width="4" height="4" fill="url(#${id}-hatch)"/>`); return }
      seg.push([px(i), py(v)])
    })
    if (seg.length) segs.push(seg)
    const col = C(tone)
    for (const s of segs) {
      if (s.length > 1) {
        const pts = s.map(p => `${r1(p[0])},${r1(p[1])}`).join(' ')
        L.mark.push(`<path d="M${r1(s[0][0])},${r1(y + lh - 3)} L${pts.replace(/ /g, ' L')} L${r1(s[s.length - 1][0])},${r1(y + lh - 3)} Z" fill="${col}" opacity=".14"/>`)
        L.mark.push(`<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`)
      }
      const last = s[s.length - 1]
      L.mark.push(`<circle cx="${r1(last[0])}" cy="${r1(last[1])}" r="2" fill="${col}"/>`)
    }
  }

  // ------------------------------------------------ plot: axes, lines, a legend for named series
  function paintPlot(n, dry, x, y, w, mark) {
    const h = n.h * lh
    const S = n.series
    const xs = n.x || {}, ys = n.y || {}
    const xlog = !!xs.log
    const okX = v => isFinite(v) && (!xlog || v > 0)
    const all = []
    S.forEach(s => s.pts.forEach(p => { if (okX(p[0])) all.push(p) }))
    const tx = v => xlog ? Math.log10(v) : v
    const xv = all.map(p => p[0])
    const xmin = okX(xs.min) ? xs.min : xv.length ? Math.min(...xv) : 0
    let xmax = okX(xs.max) ? xs.max : xv.length ? Math.max(...xv) : 1
    if (xmax === xmin) xmax = xlog ? xmin * 10 : xmin + 1
    const yv = all.map(p => p[1]).filter(v => v !== null && isFinite(v))
    const ymin = isFinite(ys.min) ? ys.min : yv.length ? Math.min(...yv) : 0
    let ymax = isFinite(ys.max) ? ys.max : yv.length ? Math.max(...yv) : 1
    if (ymax === ymin) ymax = ymin + 1
    const legend = n.legend !== false && (S.length > 1 || S.some(s => s.name)) ? 1 : 0
    const yl = [fmtTick(ymax), fmtTick(ymin)]
    const yw = Math.max(mw(yl[0], { size: fs - 1 }), mw(yl[1], { size: fs - 1 })) + 6
    const ox = x + yw, oy = y + (ys.label ? lh : 0) + 6
    const ph = Math.max(lh, h - (ys.label ? lh : 0) - 6 - lh - legend * lh - 4)
    const pw = Math.max(2 * cw, w - yw - 4)
    const col = v => ox + (tx(v) - tx(xmin)) / ((tx(xmax) - tx(xmin)) || 1) * pw
    const row = v => oy + (ymax - clamp(v, ymin, ymax)) / ((ymax - ymin) || 1) * ph
    if (!dry && n.brush) brushes.push({ id: n.brush.id, x: ox, y: oy, w: pw, h: ph, min: xmin, max: xmax, log: xlog })
    if (!dry) {
      if (ys.label) L.text.push(textSVG([{ s: ys.label, tone: 'dim' }], x, y, 'start', { size: fs - 1 }))
      L.text.push(textSVG([{ s: yl[0], tone: 'dim' }], ox - 6, oy - lh / 2, 'end', { size: fs - 1 }))
      L.text.push(textSVG([{ s: yl[1], tone: 'dim' }], ox - 6, oy + ph - lh / 2, 'end', { size: fs - 1 }))
      L.mark.push(hl(ox, ox + pw, oy, 'rule', '·'))
      L.mark.push(hl(ox, ox + pw, oy + ph, 'rule', '─'))
      L.mark.push(vl(ox, oy, oy + ph, 'rule', '│'))
      let ticks = []
      if (Array.isArray(xs.ticks)) ticks = xs.ticks
      else if (xlog) { for (let e = Math.ceil(Math.log10(xmin) - 1e-9); e <= Math.floor(Math.log10(xmax) + 1e-9); e++) ticks.push({ at: Math.pow(10, e) }) }
      else {
        const span = xmax - xmin, step0 = Math.pow(10, Math.floor(Math.log10(span / 5 || 1)))
        let step = [1, 2, 5, 10].map(q => q * step0).find(q => span / q <= 6) || step0 * 10
        if (xv.length && xv.every(Number.isInteger)) step = Math.max(1, Math.round(step))
        for (let v = Math.ceil(xmin / step) * step; v <= xmax + 1e-9; v += step) ticks.push({ at: +v.toPrecision(10) })
      }
      let lastEnd = -Infinity
      ticks.forEach(t => {
        if (!okX(t.at)) return
        const tx0 = col(t.at)
        if (tx0 < ox - 0.5 || tx0 > ox + pw + 0.5) return
        L.mark.push(vl(tx0 - 0.5, oy + ph, oy + ph + 4, 'rule', '│'))
        const s = t.label != null ? t.label : fmtTick(t.at)
        const sw = mw(s, { size: fs - 1 })
        if (tx0 - sw / 2 <= lastEnd + 6) return
        L.text.push(textSVG([{ s, tone: 'dim' }], tx0, oy + ph + 2, 'middle', { size: fs - 1 }))
        lastEnd = tx0 + sw / 2
      })
      if (xs.label) {
        const sw = mw(xs.label, { size: fs - 1 })
        if (ox + pw - sw > lastEnd + 10) L.text.push(textSVG([{ s: xs.label, tone: 'dim' }], ox + pw, oy + ph + 2, 'end', { size: fs - 1 }))
      }
      S.slice().reverse().forEach(s => {
        const P = s.pts.filter(p => okX(p[0])).sort((a, b) => a[0] - b[0])
        const c = C(s.tone)
        if (n.dots) { P.forEach(p => { if (p[1] !== null) L.mark.push(`<circle cx="${r1(col(p[0]))}" cy="${r1(row(p[1]))}" r="2.5" fill="${c}"/>`) }); return }
        let seg = []
        const flush = () => {
          if (seg.length > 1) L.mark.push(`<polyline points="${seg.join(' ')}" fill="none" stroke="${c}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>`)
          else if (seg.length === 1) { const [a, b] = seg[0].split(','); L.mark.push(`<circle cx="${a}" cy="${b}" r="2" fill="${c}"/>`) }
          seg = []
        }
        P.forEach(p => { if (p[1] === null) flush(); else seg.push(`${r1(col(p[0]))},${r1(row(p[1]))}`) })
        flush()
      })
    }
    let lx = ox
    const ly = y + h - lh
    S.forEach(s => {
      if (s.region) mark({ k: 'region', id: s.region })
      mark({ k: 'series', name: s.name, n: s.pts.length })
      const area = { x: ox, y: oy, w: pw, h: ph }
      if (!legend) { if (s.region && !dry) addRect(s.region, s.meta, area); return }
      const name = s.name || ''
      const nw = 18 + mw(name)
      if (lx + nw > x + w) { if (s.region && !dry) addRect(s.region, s.meta, area); return }
      if (!dry) {
        L.mark.push(`<rect x="${r1(lx)}" y="${r1(ly + lh / 2 - 1.5)}" width="12" height="3" rx="1" fill="${C(s.tone)}"/>`)
        L.text.push(textSVG([{ s: name, tone: s.region ? 'accent' : 'ink' }], lx + 18, ly, 'start'))
      }
      if (s.region && !dry) addRect(s.region, s.meta, { x: lx, y: ly, w: nw, h: lh })
      lx += nw + 2 * cw
    })
    return h
  }

  // ------------------------------------------------ canvas: the program's cells, drawn by what they mean
  function paintCanvas(n, dry, x, y, w, mark, cut) {
    const rh = lh
    const cwid = Math.min(n.w * cw, w)
    if (n.w * cw > w + 0.5) cut({ k: 'canvas', w: n.w, room: Math.floor(w / cw) })
    const X = c => x + c * cw, Y = r => y + r * rh
    let draws = 0
    const glyph = (cx0, cy0, ch, tone, o) => {
      if (ch === ' ') { if (o && o.bg) L.mark.push(`<rect x="${r1(X(cx0))}" y="${r1(Y(cy0))}" width="${r1(cw)}" height="${rh}" fill="${C(o.bg)}"/>`); return }
      const gx = X(cx0), gy = Y(cy0)
      if (o && o.bg && ch !== '▀') L.mark.push(`<rect x="${r1(gx)}" y="${r1(gy)}" width="${r1(cw)}" height="${rh}" fill="${C(o.bg)}" opacity=".25"/>`)
      const li = LEVEL.indexOf(ch)
      if (li >= 0) { const hh = (li + 1) / 8 * rh; L.mark.push(`<rect x="${r1(gx)}" y="${r1(gy + rh - hh)}" width="${r1(cw + 0.3)}" height="${r1(hh)}" fill="${C(tone)}"/>`); return }
      if (ch === '▀') { L.mark.push(`<rect x="${r1(gx)}" y="${r1(gy)}" width="${r1(cw + 0.3)}" height="${rh / 2}" fill="${C(tone)}"/>`); if (o && o.bg) L.mark.push(`<rect x="${r1(gx)}" y="${r1(gy + rh / 2)}" width="${r1(cw + 0.3)}" height="${rh / 2}" fill="${C(o.bg)}"/>`); return }
      if (ch === '▄') { L.mark.push(`<rect x="${r1(gx)}" y="${r1(gy + rh / 2)}" width="${r1(cw + 0.3)}" height="${rh / 2}" fill="${C(tone)}"/>`); return }
      if (LEFT[ch]) { L.mark.push(`<rect x="${r1(gx)}" y="${r1(gy + by)}" width="${r1(LEFT[ch] / 8 * cw)}" height="${bh}" fill="${C(tone)}"/>`); return }
      if (SHADE[ch]) { L.mark.push(`<rect x="${r1(gx)}" y="${r1(gy + by)}" width="${r1(cw)}" height="${bh}" fill="url(#${id}-hatch)"/>`); return }
      const box = boxPath(ch, gx, gy, cw, rh)
      if (box) { L.mark.push(`<path d="${box.d}" fill="none" stroke="${C(tone)}" stroke-width="${box.sw}"${box.dash ? ' stroke-dasharray="4 3"' : ''}/>`); return }
      if (ch === '●') { L.mark.push(`<circle cx="${r1(gx + cw / 2)}" cy="${r1(gy + rh / 2)}" r="3.4" fill="${C(tone)}"/>`); return }
      if (ch === '◉') { L.mark.push(`<circle cx="${r1(gx + cw / 2)}" cy="${r1(gy + rh / 2)}" r="5" fill="${C(tone)}"/>`); return }
      if (ch === '○') { L.mark.push(`<circle cx="${r1(gx + cw / 2)}" cy="${r1(gy + rh / 2)}" r="3" fill="none" stroke="${C(tone)}"/>`); return }
      if (ch === '■') { L.mark.push(`<rect x="${r1(gx + cw / 2 - 4)}" y="${r1(gy + rh / 2 - 4)}" width="8" height="8" rx="1" fill="${C(tone)}"/>`); return }
      L.text.push(`<text x="${r1(gx + cw / 2)}" y="${r1(base(gy))}" text-anchor="middle" fill="${C(tone)}"${o && o.b ? ' font-weight="600"' : ''}>${xml(ch)}</text>`)
    }
    for (const op of n.ops) {
      switch (op[0]) {
        case 'put': if (!dry) glyph(op[1], op[2], op[3], op[4], { b: op[5] === 1, bg: op[6] }); draws++; break
        case 'text': {
          const [, tx0, ty0, runs, align, max] = op
          if (!dry) {
            let ps = textPieces(runs)
            let wasCut = false
            if (max != null) { const r = capPieces(ps, max * cw); ps = r.pieces; wasCut = r.cut }
            if (wasCut) cut({ k: 'text', s: plain(runs) })
            const anchor = align === 'right' ? 'end' : align === 'center' ? 'middle' : 'start'
            const ax = align === 'right' ? X(tx0 + 1) : align === 'center' ? X(tx0 + 0.5) : X(tx0)
            L.text.push(textSVG(ps, ax, Y(ty0), anchor))
            const pw = piecesW(ps)
            linkRects(ps, anchor === 'end' ? ax - pw : anchor === 'middle' ? ax - pw / 2 : ax, Y(ty0))
          }
          mark({ k: 'text', s: plain(runs) })
          break
        }
        case 'fill': {
          const [, fx, fy, fw, fh, ch, tone] = op
          if (!dry && fw > 0 && fh > 0) {
            if ('█■'.includes(ch)) for (let j = 0; j < fh; j++) L.mark.push(`<rect x="${r1(X(fx))}" y="${r1(Y(fy + j) + (ch === '█' ? 0 : by))}" width="${r1(fw * cw)}" height="${ch === '█' ? rh : bh}" fill="${C(tone)}"/>`)
            // a lower block is as tall as the terminal draws it, as c.put draws it: a height is a value
            else if (LEVEL.includes(ch)) for (let j = 0; j < fh; j++) { const hh = (LEVEL.indexOf(ch) + 1) / 8 * rh; L.mark.push(`<rect x="${r1(X(fx))}" y="${r1(Y(fy + j) + rh - hh)}" width="${r1(fw * cw + 0.3)}" height="${r1(hh)}" fill="${C(tone)}"/>`) }
            else if (SHADE[ch]) L.mark.push(`<rect x="${r1(X(fx))}" y="${r1(Y(fy) + (fh === 1 ? by : 0))}" width="${r1(fw * cw)}" height="${fh === 1 ? bh : fh * rh}" fill="url(#${id}-hatch)"/>`)
            else if (ch === ' ') L.mark.push(`<rect x="${r1(X(fx))}" y="${r1(Y(fy))}" width="${r1(fw * cw)}" height="${fh * rh}" fill="${C('paper')}"/>`)
            else if ('─━╌┄┈═·'.includes(ch)) for (let j = 0; j < fh; j++) L.mark.push(hl(X(fx), X(fx + fw), Y(fy + j) + rh / 2, tone, ch))
            else for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) glyph(fx + i, fy + j, ch, tone)
          }
          draws++
          break
        }
        case 'hline': {
          const [, hx, hy, hw, ch, tone] = op
          if (!dry && hw > 0) { if ('─━╌┄┈═·'.includes(ch)) L.mark.push(hl(X(hx), X(hx + hw), Y(hy) + rh / 2, tone, ch)); else for (let i = 0; i < hw; i++) glyph(hx + i, hy, ch, tone) }
          draws++
          break
        }
        case 'vline': {
          const [, vx, vy, vh, ch, tone] = op
          if (!dry && vh > 0) { if ('│┃╎┆┊'.includes(ch)) L.mark.push(vl(X(vx) + cw / 2 - 0.5, Y(vy), Y(vy + vh), tone, ch)); else for (let j = 0; j < vh; j++) glyph(vx, vy + j, ch, tone) }
          draws++
          break
        }
        case 'box': {
          const [, bx, by0, bw, bh0, tone, title, f] = op
          if (bw < 2 || bh0 < 2) break
          // an opaque box covers the marks drawn before it (a callout); an open one is a frame under them
          if (!dry) (f && f.fill ? L.mark : L.frame).push(`<rect x="${r1(X(bx) + cw / 2)}" y="${r1(Y(by0) + rh / 2)}" width="${r1((bw - 1) * cw)}" height="${r1((bh0 - 1) * rh)}" rx="5" fill="${f && f.fill ? C('paper') : 'none'}" stroke="${C(tone)}"/>`)
          if (title && bw > 6) {
            if (!dry) {
              const r = capPieces(textPieces(title), (bw - 6) * cw)
              L.frame.push(`<rect x="${r1(X(bx + 3) - 4)}" y="${r1(Y(by0) + 1)}" width="${r1(piecesW(r.pieces) + 8)}" height="${rh - 2}" fill="${C('paper')}"/>`)
              L.text.push(textSVG(r.pieces, X(bx + 3), Y(by0), 'start'))
            }
            mark({ k: 'title', s: plain(title) })
          }
          draws++
          break
        }
        case 'bg': if (!dry && op[3] > 0 && op[4] > 0) L.bg.push(`<rect x="${r1(X(op[1]) - 2)}" y="${r1(Y(op[2]) + 1)}" width="${r1(op[3] * cw + 4)}" height="${r1(op[4] * rh - 2)}" rx="5" fill="${C(op[5])}"/>`); draws++; break
        case 'px': if (!dry) L.mark.push(`<rect x="${r1(X(op[1]))}" y="${r1(y + op[2] * rh / 2)}" width="${r1(cw + 0.3)}" height="${r1(rh / 2 + 0.3)}" fill="${C(op[3])}"/>`); draws++; break
        case 'line': if (!dry) L.mark.push(`<line x1="${r1(X(op[1]) + cw / 2)}" y1="${r1(y + op[2] * rh / 2 + rh / 4)}" x2="${r1(X(op[3]) + cw / 2)}" y2="${r1(y + op[4] * rh / 2 + rh / 4)}" stroke="${C(op[5])}" stroke-width="2" stroke-linecap="round"/>`); draws++; break
        case 'dot': {
          // a circle exactly where the program put it (a fraction of a cell too); a part's hit area is the dot
          const [, dx0, dy0, tone, f] = op
          const pcx = X(dx0) + cw / 2, pcy = Y(dy0) + rh / 2
          const rad = f.size >= 3 ? 8.5 : f.size >= 2 ? 6.4 : 4.4
          if (!dry) {
            if (f.bg) L.mark.push(`<circle cx="${r1(pcx)}" cy="${r1(pcy)}" r="${r1(rad + 4.5)}" fill="${C(f.bg)}"/>`)
            if (f.glyph && !'●◉○'.includes(f.glyph)) glyph(Math.round(dx0), Math.round(dy0), f.glyph, tone, { b: !!f.bold })
            else if (f.hollow) L.mark.push(`<circle cx="${r1(pcx)}" cy="${r1(pcy)}" r="${r1(rad)}" fill="${C('paper')}" stroke="${C(tone)}" stroke-width="1.4"/>`)
            else L.mark.push(`<circle cx="${r1(pcx)}" cy="${r1(pcy)}" r="${r1(rad + (f.bold ? 0.6 : 0))}" fill="${C(tone)}"/>`)
            if (f.label) L.text.push(`<text x="${r1(pcx + rad + 3)}" y="${r1(pcy - 1)}"${typeStyle({ size: fs * 0.85 })} fill="${C(f.labelTone)}">${xml(f.label)}</text>`)
          }
          if (f.label) mark({ k: 'text', s: f.label })
          if (f.region) {
            mark({ k: 'region', id: f.region })
            const hit = Math.max(rad + 4, 7)
            if (!dry && dx0 >= -0.5 && dy0 >= -0.5 && dx0 < n.w && dy0 < n.h) addRect(f.region, f.meta, { x: pcx - hit, y: pcy - hit, w: 2 * hit, h: 2 * hit })
          }
          draws++
          break
        }
        case 'link': {
          // a thin straight stroke between the two points, under the dots and marks; dashed for a weak tie
          if (!dry) L.frame.push(`<line x1="${r1(X(op[1]) + cw / 2)}" y1="${r1(Y(op[2]) + rh / 2)}" x2="${r1(X(op[3]) + cw / 2)}" y2="${r1(Y(op[4]) + rh / 2)}" stroke="${C(op[5])}" stroke-width="1.1"${op[6].dash ? ' stroke-dasharray="4 3"' : ''} stroke-linecap="round"/>`)
          draws++
          break
        }
        case 'bar': if (!dry) drawBar(X(op[1]), Y(op[2]), op[3] * cw, op[4], op[5], op[6]); mark({ k: 'bar', v: op[4], max: op[5] }); break
        case 'spark': if (!dry) drawSpark(X(op[1]), Y(op[2]), Math.max(1, op[3]) * cw, op[4], op[5], op[6], op[7]); mark({ k: 'spark', values: op[4] }); break
        case 'brush': if (!dry) brushes.push({ id: op[1], x: X(op[2]), y: Y(op[3]), w: op[4] * cw, h: op[5] * rh, min: op[6], max: op[7], log: !!op[8] }); break
        case 'region': {
          mark({ k: 'region', id: op[1] })
          if (!dry) {
            const rx = Math.max(0, op[2]), ry = Math.max(0, op[3])
            const rw = Math.min((op[2] + op[4]) * cw, cwid) - rx * cw, rhh = (Math.min(op[3] + op[5], n.h) - ry) * rh
            addRect(op[1], op[6], { x: X(rx), y: Y(ry), w: rw, h: rhh })
          }
          break
        }
      }
    }
    mark({ k: 'canvas', w: n.w, h: n.h, draws })
    return n.h * rh
  }

  // ------------------------------------------------ run it
  const root = drawing.root
  const w = widthIn(sizes(root), W)
  const h = heightOf(root, w)
  paint(root, {}, 0, 0, w)
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
    e.rects.push({ x: l.x, y: l.y, w: l.w, h: l.h })
  }
  // the selected and the hovered region, tinted under the marks
  const tint = (rid, color, op) => {
    const r = regions.find(q => q.id === rid)
    if (r) r.rects.forEach(q => L.bg.push(`<rect x="${r1(q.x - 3)}" y="${r1(q.y)}" width="${r1(q.w + 6)}" height="${r1(q.h)}" rx="3" fill="${color}" opacity="${op}"/>`))
  }
  if (opts.hover && opts.hover !== opts.selected) tint(opts.hover, C('hover'), 1)
  if (opts.selected) tint(opts.selected, C('select'), 1)
  const hits = opts.hits === false ? '' : `<g class="dk-hits">${regions.slice().sort((a, b) => area(b) - area(a)).flatMap(r => r.rects.map(q => `<rect data-region="${xml(r.id)}" x="${r1(q.x)}" y="${r1(q.y)}" width="${r1(q.w)}" height="${r1(q.h)}" fill="transparent"/>`)).join('')}</g>`
  const defs = `<defs><pattern id="${id}-hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)"><rect width="4" height="4" fill="${theme === 'light' ? '#f4f2ed' : '#2a2926'}"/><line x1="0" y1="0" x2="0" y2="4" stroke="${C('unseen')}" stroke-width="1.6"/></pattern></defs>`
  const style = `<style>#${id} text{font-family:${SANS};font-size:${fs}px;font-variant-numeric:tabular-nums;font-kerning:normal}</style>`
  const svg = `<svg id="${id}" class="dk" xmlns="http://www.w3.org/2000/svg" width="${r1(w)}" height="${r1(h)}" viewBox="0 0 ${r1(w)} ${r1(h)}">${defs}${style}` +
    `<g class="dk-bg">${L.bg.join('')}</g><g class="dk-frames">${L.frame.join('')}</g><g class="dk-marks">${L.mark.join('')}</g><g class="dk-text">${L.text.join('')}</g>${brushSVG(brushes)}${hits}</svg>`
  return { svg, w, h, regions, brushes, marks: cx.marks, cut: cx.cut, warnings: drawing.warnings || [], error: drawing.error }
}
const area = r => r.rects.reduce((s, q) => s + q.w * q.h, 0)
// each brush area as a transparent rect that says how its x reads (draw/browser/events.js turns a drag on it into
// {type: 'brush', id, from, to}); a crosshair cursor says it takes a drag
const brushSVG = list => (list.length ? `<g class="dk-brushes">${list.map(b => `<rect class="dk-brush" data-brush="${xml(b.id)}" data-min="${b.min}" data-max="${b.max}"${b.log ? ' data-log="1"' : ''} x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}" fill="transparent" style="cursor:crosshair"/>`).join('')}</g>` : '')

// box-drawing glyphs as strokes through the cell's middle (light, heavy and dashed)
function boxPath(ch, x, y, cw, rh) {
  const cx = Math.round(x + cw / 2) + 0.5, cy = Math.round(y + rh / 2) + 0.5
  const L = `M${r1(x)},${cy}H${cx}`, R = `M${cx},${cy}H${r1(x + cw)}`, U = `M${cx},${r1(y)}V${cy}`, D = `M${cx},${cy}V${r1(y + rh)}`
  const rad = Math.min(4, cw / 2)
  const light = {
    '─': L + R, '│': U + D, '┌': R + D, '┐': L + D, '└': R + U, '┘': L + U, '├': U + D + R, '┤': U + D + L, '┬': L + R + D, '┴': L + R + U, '┼': L + R + U + D,
    '╭': `M${r1(x + cw)},${cy}H${r1(cx + rad)}Q${cx},${cy} ${cx},${r1(cy + rad)}V${r1(y + rh)}`, '╮': `M${r1(x)},${cy}H${r1(cx - rad)}Q${cx},${cy} ${cx},${r1(cy + rad)}V${r1(y + rh)}`,
    '╰': `M${r1(x + cw)},${cy}H${r1(cx + rad)}Q${cx},${cy} ${cx},${r1(cy - rad)}V${r1(y)}`, '╯': `M${r1(x)},${cy}H${r1(cx - rad)}Q${cx},${cy} ${cx},${r1(cy - rad)}V${r1(y)}`,
    '╴': L, '╶': R, '╵': U, '╷': D,
  }
  const heavy = { '━': L + R, '┃': U + D, '┏': R + D, '┓': L + D, '┗': R + U, '┛': L + U, '┣': U + D + R, '┫': U + D + L, '┳': L + R + D, '┻': L + R + U, '╋': L + R + U + D }
  const dashed = { '╌': L + R, '┄': L + R, '┈': L + R, '╎': U + D, '┆': U + D, '┊': U + D }
  if (light[ch]) return { d: light[ch], sw: 1 }
  if (heavy[ch]) return { d: heavy[ch], sw: 2.5 }
  if (dashed[ch]) return { d: dashed[ch], sw: 1, dash: true }
  return null
}
