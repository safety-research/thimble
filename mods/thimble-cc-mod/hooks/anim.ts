// Animation frames for playing a card: pure functions from a card, its width and the animation's progress t in [0, 1]
// to the Layout cardLayout draws. Each frame is the finished drawing with parts held back or grown, so t = 1 with no
// focus is exactly cardLayout(card, cols, -1), and every frame has the same lines as the finished one.
import { MAX_BARS, MAX_NODES, MAX_TABLE_ROWS, amount, bar, cardLayout, cw, lineWidth, pad, shade, width } from './draw'
import type { BarRow, CardData, Cell, Item, Layout, Line, Seg } from './draw'
import { fmt } from './lib'
import { COLORS } from './paint'

/** A value a caption cites, by the names its card uses: a line's series and x, a bar's or a table's row (and a
 *  table's column as `series`), a timeline's event (1-based, or its record), an example's record (1-based, or its
 *  ref), a diagram's node id or edge (1-based). */
export type Focus = { series?: string; x?: string | number; row?: string | number; event?: string | number; node?: string; edge?: number }

const clamp = (v: number) => Math.max(0, Math.min(1, v))
const ease = (p: number) => 1 - (1 - clamp(p)) ** 3
const same = (a: unknown, b: unknown) => {
  const s = String(a)
  const t = String(b)
  return s === t || (s.trim() !== '' && t.trim() !== '' && Number(s) === Number(t)) || s.toLowerCase() === t.toLowerCase()
}
const ordinal = (v: unknown, n: number) => (v !== undefined && String(v).trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= n ? Number(v) - 1 : -1)

/** Item i of n's progress when the n start one after another, each taking `span` of the time. */
function stagger(t: number, i: number, n: number, span: number): number {
  if (n <= 1) return clamp(t)
  return clamp((t - (i * (1 - span)) / (n - 1)) / span)
}

// ---------------------------------------------------------------------------------------- cells

type Px = { ch: string; w: number; seg: Seg }

const STYLE = ['fg', 'bg', 'b', 'd', 'i', 'u', 'inv'] as const

function cellsOf(l: Line): Px[] {
  const out: Px[] = []
  for (const seg of l) for (const ch of seg.s) out.push({ ch, w: cw(ch), seg })
  return out
}

function lineOf(px: Px[]): Line {
  const out: Line = []
  for (const p of px) {
    const prev = out.at(-1)
    if (prev && STYLE.every(k => prev[k] === p.seg[k])) prev.s += p.ch
    else {
      const seg: Seg = { s: p.ch }
      for (const k of STYLE) if (p.seg[k] !== undefined) (seg as Record<string, unknown>)[k] = p.seg[k]
      out.push(seg)
    }
  }
  return out
}

const blank = (p: Px): Px => ({ ch: ' '.repeat(p.w), w: p.w, seg: { s: '' } })

/** `l` with each cell at column x replaced by what `f` returns, a blank where it returns null. */
function mapLine(l: Line, f: (x: number, p: Px) => Px | null): Line {
  let x = 0
  return lineOf(
    cellsOf(l).map(p => {
      const r = f(x, p)
      x += p.w
      return r ?? blank(p)
    }),
  )
}

/** `l` moved right by `by` columns, cut at `cols`. */
function shift(l: Line, by: number, cols: number): Line {
  const out: Px[] = by > 0 ? [{ ch: ' '.repeat(Math.min(by, cols)), w: Math.min(by, cols), seg: { s: '' } }] : []
  let x = Math.min(by, cols)
  for (const p of cellsOf(l)) {
    if (x + p.w > cols) break
    out.push(p)
    x += p.w
  }
  return lineOf(out)
}

/** `text` written over `l` from column x, the line padded with blanks to reach it. */
function stamp(l: Line, x: number, text: string, style: Omit<Seg, 's'>): Line {
  const px = cellsOf(l)
  const end = x + width(text)
  const out: Px[] = []
  let at = 0
  for (const p of px) {
    const a = at
    at += p.w
    if (at <= x) out.push(p)
    else {
      // a wide character the text starts inside of leaves a blank
      if (a < x) out.push({ ch: ' '.repeat(x - a), w: x - a, seg: p.seg })
      break
    }
  }
  const filled = out.reduce((n, p) => n + p.w, 0)
  if (filled < x) out.push({ ch: ' '.repeat(x - filled), w: x - filled, seg: { s: '' } })
  for (const ch of text) out.push({ ch, w: cw(ch), seg: { s: '', ...style } })
  at = 0
  for (const p of px) {
    const a = at
    at += p.w
    if (a >= end) out.push(p)
    else if (at > end) out.push({ ch: ' '.repeat(at - end), w: at - end, seg: p.seg })
  }
  return lineOf(out)
}

/** The cells of a layout that hit item k, as spans for shade. */
function spansOf(lay: Layout, lines: Line[], k: number): { line: number; x0: number; x1: number }[] {
  const spans: { line: number; x0: number; x1: number }[] = []
  lines.forEach((l, y) => {
    const w = lineWidth(l)
    let x0 = -1
    for (let x = 0; x <= w; x++) {
      const on = x < w && lay.hit(x, y) === k
      if (on && x0 < 0) x0 = x
      if (!on && x0 >= 0) {
        spans.push({ line: y, x0, x1: x })
        x0 = -1
      }
    }
  })
  return spans
}

// the value a caption cites: on the selection background, the current one among those shown
const LIT: Omit<Seg, 's'> = { bg: COLORS.selected }

// ---------------------------------------------------------------------------------------- focus

/** The item of `items` (cardLayout's, for this card) that a focus names, -1 for none. */
export function focusItem(card: CardData, items: readonly Item[], f: Focus): number {
  switch (card.kind) {
    case 'line': {
      const x = f.x ?? f.row
      if (x === undefined) return -1
      let i = 0
      for (const s of (card.series ?? []).filter(s => s.points.length > 0)) {
        for (const p of s.points) {
          if ((f.series === undefined || same(s.name, f.series)) && same(p[0], x)) return i
          i++
        }
      }
      return -1
    }
    case 'bar':
    case 'label': {
      const key = f.row ?? f.x
      if (key === undefined) return -1
      // a label card is a bar card of its counts: its records are the label panel's
      return ((card.rows ?? []) as BarRow[]).slice(0, MAX_BARS).findIndex(r => same(r.label, key))
    }
    case 'table': {
      const key = f.row ?? f.x
      const heads = card.columns ?? []
      const r = key === undefined ? -1 : ((card.rows ?? []) as Cell[][]).slice(0, MAX_TABLE_ROWS).findIndex(row => same(fmt(row[0]), key))
      if (r < 0) return -1
      const c = f.series === undefined ? 0 : Math.max(0, heads.findIndex(h => same(h, f.series)))
      return r * heads.length + c
    }
    case 'timeline': {
      const evs = (card.events ?? []).slice(0, 30)
      const key = f.event ?? f.row
      if (key === undefined) return -1
      const n = ordinal(key, evs.length)
      return n >= 0 ? n : evs.findIndex(e => (e.ref && e.ref === key) || same(e.time, key) || (e.shown !== undefined && same(e.shown, key)))
    }
    case 'example': {
      const exs = (card.examples ?? []).slice(0, 8)
      const key = f.row ?? f.event
      if (key === undefined) return -1
      const n = ordinal(key, exs.length)
      return n >= 0 ? n : exs.findIndex(e => e.ref === key)
    }
    case 'diagram': {
      if (f.node !== undefined) return (card.nodes ?? []).slice(0, MAX_NODES).findIndex(n => String(n.id) === f.node || (n.ref !== undefined && n.ref === f.node))
      if (f.edge !== undefined) return items.findIndex(it => it.open === `card:${card.id}#edge/${f.edge}`)
      return -1
    }
    default:
      return -1
  }
}

/** The focus a citation's place names on this card: a card value (card:<id>#<column>/<row>) or a record the card
 *  shows (an example's, an event's or a node's ref); undefined when it names nothing on it. */
export function focusFromRef(card: CardData, ref: string): Focus | undefined {
  const pre = `card:${card.id}#`
  const longest = (names: string[], rest: string) => names.filter(n => rest.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0]
  if (ref.startsWith(pre)) {
    const rest = ref.slice(pre.length)
    switch (card.kind) {
      case 'diagram':
        if (rest.startsWith('node/')) return { node: rest.slice(5) }
        if (rest.startsWith('edge/')) return { edge: Number(rest.slice(5)) }
        return undefined
      case 'timeline':
        return rest.startsWith('time/') ? { event: Number(rest.slice(5)) } : undefined
      case 'line': {
        const s = longest((card.series ?? []).map(s => s.name), rest)
        return s === undefined ? undefined : { series: s, x: rest.slice(s.length + 1) }
      }
      case 'bar':
      case 'label': {
        const col = card.y || 'value'
        return rest.startsWith(`${col}/`) ? { row: rest.slice(col.length + 1) } : undefined
      }
      case 'table': {
        const h = longest(card.columns ?? [], rest)
        return h === undefined ? undefined : { series: h, row: rest.slice(h.length + 1) }
      }
      default:
        return undefined
    }
  }
  if (card.kind === 'example' && (card.examples ?? []).some(e => e.ref === ref)) return { row: ref }
  if (card.kind === 'timeline') {
    const i = (card.events ?? []).findIndex(e => e.ref === ref)
    if (i >= 0) return { event: i + 1 }
  }
  if (card.kind === 'diagram') {
    const n = (card.nodes ?? []).find(n => n.ref === ref)
    if (n) return { node: n.id }
  }
  return undefined
}

// ---------------------------------------------------------------------------------------- frames

/** Bars grow from zero one after another, each value counting up with its bar. */
function barFrame(card: CardData, lay: Layout, t: number): Line[] {
  const rows = ((card.rows ?? []) as BarRow[]).slice(0, MAX_BARS)
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 0)
  return lay.lines.map((l, y) => {
    const i = lay.hit(0, y)
    if (i < 0 || l.length !== 5) return l
    const r = rows[i]!
    const p = stagger(t, i, rows.length, 0.45)
    const g = ease(p)
    // the bar's cells and the 2-cell gutter after it, as barLayout drew them
    const barW = width(l[2]!.s) + width(l[3]!.s) - 2
    const b = bar(r.value * g, max, barW)
    const places = fmt(r.value).split('.')[1]?.length ?? 0
    const v = p <= 0 ? '' : p >= 1 ? amount(r.value) : amount(Number((r.value * g).toFixed(places)))
    return [l[0]!, l[1]!, { ...l[2]!, s: b }, { s: ' '.repeat(Math.max(2, barW - width(b) + 2)) }, { ...l[4]!, s: pad(v, width(l[4]!.s), true) }]
  })
}

const AXES = 0.25

/** Axes first (the y axis up, the x axis across, then their labels), then each series traced left to right at half a
 *  cell's resolution. */
function lineFrame(lay: Layout, t: number): Line[] {
  const axisY = lay.lines.findIndex(l => l.some(s => s.s.includes('└')))
  if (axisY < 0) return lay.lines
  const yW = width(lay.lines[0]![0]!.s)
  const pw = lineWidth(lay.lines[axisY]!) - yW - 1
  const pa = ease(t / AXES)
  const dots = Math.floor(clamp((t - AXES) / (1 - AXES)) * 2 * pw)
  return lay.lines.map((l, y) => {
    if (y < axisY) {
      const axisOn = axisY - y <= Math.ceil(pa * axisY)
      return mapLine(l, (x, p) => {
        if (x < yW) return pa >= 1 ? p : null
        if (x === yW) return axisOn ? p : null
        const col = x - yW - 1
        const code = p.ch.codePointAt(0)!
        if (2 * col + 1 < dots) return p
        if (2 * col < dots && code > 0x2800 && code <= 0x28ff) {
          const left = (code - 0x2800) & 0x47
          return left ? { ...p, ch: String.fromCodePoint(0x2800 + left) } : null
        }
        return null
      })
    }
    if (y === axisY) {
      const shown = Math.round(pa * (pw + 1))
      return mapLine(l, (x, p) => (x < yW || x - yW < shown ? p : null))
    }
    if (y === axisY + 1) return pa >= 1 ? l : []
    return l
  })
}

/** The point a line chart's focus lights, labelled with its value beside, above or below it, where the label covers
 *  the fewest marks. */
function lineLabel(lines: Line[], text: string): Line[] {
  const axisY = lines.findIndex(l => l.some(s => s.s.includes('└')))
  const label = ` ${text} `
  const w = width(label)
  const covered = (y: number, x: number) => {
    let n = 0
    let c = 0
    for (const s of lines[y]!) {
      for (const ch of s.s) {
        if (c >= x && c < x + w && ch.trim() && ch !== '┊') n++
        c += cw(ch)
      }
    }
    return n
  }
  for (let y = 0; y < axisY; y++) {
    let x = 0
    for (const s of lines[y]!) {
      if (s.inv) {
        const lo = width(lines[y]![0]!.s) + 1
        const hi = lineWidth(lines[y]!)
        const spots = [
          [y, x + 2],
          [y, x - 1 - w],
          [y - 1, x - Math.floor(w / 2)],
          [y + 1, x - Math.floor(w / 2)],
        ].map(([yy, xx]) => [yy!, Math.max(lo, Math.min(hi - w, xx!))] as const)
        const fits = spots.filter(([yy, xx]) => yy >= 0 && yy < axisY && xx >= lo && xx + w <= hi && !(yy === y && xx <= x && x < xx + w))
        if (!fits.length) return lines
        const [ly, lx] = fits.reduce((a, b) => (covered(b[0], b[1]) < covered(a[0], a[1]) ? b : a))
        return lines.map((l, k) => (k === ly ? stamp(l, lx, label, LIT) : l))
      }
      x += width(s.s)
    }
  }
  return lines
}

/** A cursor sweeps the time axis and each event appears as it passes; with no time axis, events appear in order. */
function timelineFrame(card: CardData, lay: Layout, t: number, cols: number): Line[] {
  const evs = (card.events ?? []).slice(0, 30)
  const times = evs.map(e => Date.parse(e.time.replace(' ', 'T')))
  const axis = evs.length > 1 && times.every(x => !Number.isNaN(x))
  const t0 = Math.min(...times)
  const t1 = Math.max(...times)
  const at = evs.map((_, i) => (axis ? (t1 === t0 ? 0 : (times[i]! - t0) / (t1 - t0)) : evs.length > 1 ? i / (evs.length - 1) : 0))
  const sweep = clamp(t / 0.9)
  const aw = axis ? lineWidth(lay.lines[0]!) - 1 : Math.max(10, cols - 2)
  const cursor = Math.round(sweep * (aw - 1))
  const passed = (i: number) => Math.round(at[i]! * (aw - 1)) <= cursor
  return lay.lines.map((l, y) => {
    if (axis && y === 0) {
      return mapLine(l, (x, p) => {
        const j = x - 1
        if (j < 0) return p
        if (j === cursor && sweep < 1) return { ...p, ch: '│', seg: { s: '', fg: COLORS.rule } }
        if (j > cursor && p.ch === '●') return { ...p, ch: '─', seg: { s: '', fg: COLORS.rule } }
        return p
      })
    }
    if (axis && y === 1) return l
    const i = lay.hit(0, y)
    if (i < 0) return l
    if (!passed(i)) return []
    // an event just passed is dim for a moment
    return sweep < 1 && sweep - at[i]! < 0.08 ? l.map(s => ({ ...s, d: true })) : l
  })
}

/** The time a timeline's focus names, written under its dot on the dates line. */
function timelineLabel(card: CardData, lines: Line[], k: number, label: string, cols: number): Line[] {
  const evs = (card.events ?? []).slice(0, 30)
  const times = evs.map(e => Date.parse(e.time.replace(' ', 'T')))
  if (evs.length < 2 || times.some(x => Number.isNaN(x))) return lines
  const t0 = Math.min(...times)
  const t1 = Math.max(...times)
  const aw = lineWidth(lines[0]!) - 1
  const dot = 1 + (t1 === t0 ? 0 : Math.round(((times[k]! - t0) / (t1 - t0)) * (aw - 1)))
  const text = ` ${label} `
  const x = Math.max(0, Math.min(Math.min(cols, aw + 1) - width(text), dot - Math.floor(width(text) / 2)))
  return lines.map((l, y) => (y === 1 ? stamp(l, x, text, LIT) : l))
}

/** The heading first, then rows top down, each dim for a moment as it appears. */
function tableFrame(card: CardData, lay: Layout, t: number): Line[] {
  const heads = Math.max(1, (card.columns ?? []).length)
  const n = Math.min(((card.rows ?? []) as Cell[][]).length, MAX_TABLE_ROWS)
  const lastRow = lay.lines.reduce((m, _, y) => (lay.hit(0, y) >= 0 ? y : m), -1)
  return lay.lines.map((l, y) => {
    const item = lay.hit(0, y)
    if (item < 0) return y > lastRow && lastRow >= 0 && t < 0.9 ? [] : l
    const start = n > 1 ? (Math.floor(item / heads) / n) * 0.85 : 0
    if (t < start) return []
    return t < 1 && t - start < 0.1 ? l.map(s => ({ ...s, d: true })) : l
  })
}

/** Records slide in from the right one after another; then a highlight runs along each one's quoted words. */
function exampleFrame(card: CardData, lay: Layout, t: number, cols: number): Line[] {
  const n = Math.min((card.examples ?? []).length, 8)
  const slide = Math.min(24, Math.floor(cols / 2))
  // each record's quoted cells, counted in order, for the highlight's place
  const seen = new Map<number, number>()
  const total = new Map<number, number>()
  lay.lines.forEach((l, y) => {
    const i = lay.hit(0, y)
    if (i >= 0) total.set(i, (total.get(i) ?? 0) + l.filter(s => s.i).reduce((a, s) => a + width(s.s), 0))
  })
  return lay.lines.map((l, y) => {
    const i = lay.hit(0, y)
    if (i < 0) return l
    const p = stagger(t, i, n, 0.5)
    if (p <= 0) return []
    if (p < 0.5) return shift(l, Math.round((1 - ease(p / 0.5)) * slide), cols)
    const band = ((p - 0.5) / 0.5) * ((total.get(i) ?? 0) + 12)
    let q = seen.get(i) ?? 0
    const out = mapLine(l, (_x, px) => {
      if (!px.seg.i) return px
      const on = q >= band - 12 && q < band
      q += px.w
      return on ? { ...px, seg: { ...px.seg, bg: COLORS.selected } } : px
    })
    seen.set(i, q)
    return out
  })
}

/** Nodes layer by layer, top down; then the edges drawn downward, their labels and notes with them. */
function diagramFrame(card: CardData, lay: Layout, t: number): Line[] {
  const N = Math.min((card.nodes ?? []).length, MAX_NODES)
  const top = new Map<number, number>()
  let lo = Infinity
  let hi = -Infinity
  lay.lines.forEach((l, y) => {
    const w = lineWidth(l)
    for (let x = 0; x < w; x++) {
      const k = lay.hit(x, y)
      if (k < 0) continue
      if (k < N) {
        if (!top.has(k)) top.set(k, y)
      } else {
        lo = Math.min(lo, y)
        hi = Math.max(hi, y)
      }
    }
  })
  const layers = [...new Set(top.values())].sort((a, b) => a - b)
  const NODES = 0.5
  const nodeAt = (k: number) => (layers.length > 1 ? (layers.indexOf(top.get(k)!) / layers.length) * NODES : 0)
  const reach = lo + clamp((t - NODES) / (1 - NODES)) * (hi - lo + 1) - 1
  return lay.lines.map((l, y) =>
    mapLine(l, (x, p) => {
      const k = lay.hit(x, y)
      if (k < 0) return p
      if (k < N) {
        const s = nodeAt(k)
        if (t < s) return null
        return t < 1 && t - s < 0.08 ? { ...p, seg: { ...p.seg, d: true } } : p
      }
      if (y <= reach) return p
      // an arrow not drawn yet leaves its box's border whole, once the box is there
      const shown = (j: number) => j >= 0 && j < N && t >= nodeAt(j)
      return (p.ch === '↓' || p.ch === '↑') && (shown(lay.hit(x - 1, y)) || shown(lay.hit(x + 1, y))) ? { ...p, ch: '─', seg: { s: '', fg: COLORS.dim } } : null
    }),
  )
}

/**
 * A card's drawing at progress t in [0, 1] of its animation: bars grow, a line traces after its axes, a cursor sweeps
 * a timeline, a table's rows and an example's records arrive in order, a diagram's nodes come layer by layer before
 * its edges. t = 1 with no focus is cardLayout(card, cols, -1). A focus lights the value it names (the mark as the
 * pointer lights it, on a highlight) and labels a line's point and a timeline's event with their value. Every line is
 * at most `cols` wide, as cardLayout's are.
 */
export function animFrame(card: CardData, cols: number, t: number, focus?: Focus, plotRows?: number): Layout {
  const T = clamp(Number.isFinite(t) ? t : 1)
  const plain = cardLayout(card, cols, -1, plotRows)
  const k = focus ? focusItem(card, plain.items, focus) : -1
  if (T >= 1 && k < 0) return plain
  const lay = k < 0 ? plain : cardLayout(card, cols, k, plotRows)
  let lines: Line[]
  switch (card.kind) {
    case 'bar':
      lines = barFrame(card, lay, T)
      break
    case 'line':
      lines = lineFrame(lay, T)
      break
    case 'timeline':
      lines = timelineFrame(card, lay, T, cols)
      break
    case 'table':
      lines = tableFrame(card, lay, T)
      break
    case 'example':
      lines = exampleFrame(card, lay, T, cols)
      break
    case 'diagram':
      lines = diagramFrame(card, lay, T)
      break
    default:
      lines = lay.lines
  }
  if (k >= 0 && T >= 1) {
    const label = lay.items[k]!.text || lay.items[k]!.label
    if (card.kind === 'line') lines = lineLabel(lines, label)
    else if (card.kind === 'example') lines = lines.map((l, y) => (lay.hit(0, y) === k ? l.map(s => (s.i ? { ...s, bg: COLORS.selected } : s)) : l))
    else {
      // the lit mark on the selection background alone: inverse is the pointer's (views/SPEC.md, rule 18)
      lines = shade(lines.map(l => l.map(s => (s.inv ? { ...s, inv: false } : s))), spansOf(lay, lines, k), COLORS.selected)
      if (card.kind === 'timeline') lines = timelineLabel(card, lines, k, lay.items[k]!.label, cols)
    }
  }
  const at = (x: number, y: number) => {
    let c = 0
    for (const s of lines[y] ?? []) {
      for (const ch of s.s) {
        if (x >= c && x < c + cw(ch)) return ch
        c += cw(ch)
      }
    }
    return ' '
  }
  return { lines, items: lay.items, hit: T >= 1 ? lay.hit : (x, y) => (at(x, y).trim() ? lay.hit(x, y) : -1) }
}

/**
 * A card's frame in at most `room` lines, for a scene shorter than its card: the header over the lit item `k` (the
 * lines above its run of rows: a table's header and rule, or a later block's own), then a run of rows that holds the
 * item, and a dim line for what is left out above or below. Lines are kept or left out whole, a row with all its lines,
 * so every row shown is drawn as the card draws it.
 */
export function cropFrame(card: CardData, frame: Layout, cols: number, room: number, k = -1, plotRows?: number): Line[] {
  const lines = frame.lines
  const n = lines.length
  if (n <= room) return lines
  if (room < 4) return lines.slice(0, Math.max(0, room))
  // the finished drawing's hit test: a row not yet arrived in the frame is still its row
  const plain = cardLayout(card, cols, -1, plotRows)
  const lay = plain.lines.length === n ? plain : frame
  const along = (y: number, want?: number) => {
    const w = lineWidth(lay.lines[y] ?? [])
    for (let x = 0; x < w; x++) {
      const i = lay.hit(x, y)
      if (want === undefined ? i >= 0 : i === want) return i
    }
    return -1
  }
  const owner = lines.map((_, y) => along(y))
  let lo = -1
  if (k >= 0) for (let y = 0; y < n && lo < 0; y++) if (along(y, k) === k) lo = y
  let hi = lo
  while (lo >= 0 && owner[lo]! >= 0 && owner[hi + 1] === owner[lo]) hi++
  // the header: the lines above the run of rows the lit row is in, less the blank line between blocks
  let fb = lo >= 0 ? lo : Math.max(0, owner.findIndex(i => i >= 0))
  while (fb > 0 && owner[fb - 1]! >= 0) fb--
  let hb = fb
  while (hb > 0 && owner[hb - 1]! < 0) hb--
  while (hb < fb && !lineWidth(lines[hb]!)) hb++
  const pre = hb > 0 ? 1 : 0
  fb = Math.min(fb, hb + room - pre - 3)
  // a window of rows below it that starts and ends between rows, the lit row in its middle
  const starts = (y: number) => y >= n || owner[y]! < 0 || owner[y] !== owner[y - 1]
  const body = room - pre - (fb - hb)
  let s = fb
  let e = fb + body - 1
  if (lo >= 0 && hi >= e) {
    let w = body - 2
    s = Math.max(fb + 1, lo - Math.max(0, Math.floor((w - (hi - lo + 1)) / 2)))
    if (s + w >= n) {
      w = body - 1
      s = Math.max(fb + 1, n - w)
    }
    while (s < lo && !starts(s)) s++
    e = Math.min(n, s + w)
  }
  while (e < n && e - 1 > Math.max(s, hi) && (owner[e - 1]! < 0 || !starts(e))) e--
  const shown = new Set([...owner.slice(hb, fb), ...owner.slice(s, e)])
  // what is left out: its rows not shown elsewhere, or its lines (an earlier block's, above a later block's header)
  const left = (a: number, b: number, where: 'above' | 'below', lines = false): Line => {
    const rows = lines ? 0 : new Set(owner.slice(a, b).filter(i => i >= 0 && !shown.has(i))).size
    const [m, unit] = rows ? [rows, 'row'] : [b - a, 'line']
    const what = `${unit}${m === 1 ? '' : 's'}`
    return [{ s: where === 'above' ? `… ${m} ${what} above` : `… ${m} more ${what}`, fg: COLORS.dim }]
  }
  return [
    ...(pre ? [left(0, hb, 'above', true)] : []),
    ...lines.slice(hb, fb),
    ...(s > fb ? [left(fb, s, 'above')] : []),
    ...lines.slice(s, e),
    ...(e < n ? [left(e, n, 'below')] : []),
  ]
}
