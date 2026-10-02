// Layouts as styled lines, shared by the surface modules (the interactive chips and cards) and the hooks module (the
// static drawing where no Client runs). Each layout takes the width it may use and the item under the pointer, and
// returns its lines and a hit test from a cell to an item.
import { fmt } from './lib'
import type { Run, TableRuns } from './lib'
import { COLORS } from './paint'

export { COLORS }

export type Seg = { s: string; fg?: string; bg?: string; b?: boolean; d?: boolean; i?: boolean; u?: boolean; inv?: boolean }
export type Line = Seg[]

export type BarRow = { label: string; value: number; group: string }
export type Cell = string | number | boolean | null
export type CardParam = { name: string; value: string | number; default: string | number; choices: (string | number)[] }
export type DiagramNode = { id: string; label: string; ref?: string; detail?: string }
export type DiagramEdge = { source: string; target: string; label?: string }
export type CardData = {
  id: string
  kind: string
  question: string
  x: string
  y: string
  note: string
  source: { script?: string; sha1?: string; index?: number }
  params?: CardParam[]
  rows?: (BarRow | Cell[])[]
  total?: number
  columns?: string[]
  series?: { name: string; points: [string | number, number][] }[]
  events?: { time: string; label: string; ref: string; shown?: string }[]
  examples?: { ref: string; quote: string; note: string }[]
  nodes?: DiagramNode[]
  edges?: DiagramEdge[]
}

/** What the mod is doing to a card now: running its script, or why the last run failed. */
export type CardMeta = { busy?: string; error?: string }

/** What a pointer can pick on a card: what the readout says, the citation a click puts in the prompt, the place it
 *  opens, and how it reaches the gestures (`kind` and `text`, the shown value or words, of its Target). */
export type Item = { label: string; value: string; cite: string; open: string; kind: 'mark' | 'row' | 'record' | 'node'; text: string }

export type Layout = { lines: Line[]; items: Item[]; hit: (x: number, y: number) => number }

// ---------------------------------------------------------------------------------------- text width

export function cw(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c === 0) return 0
  if (
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
  ) return 2
  return 1
}

export function width(s: string): number {
  let n = 0
  for (const ch of s) n += cw(ch)
  return n
}

export function cut(s: string, n: number): string {
  if (width(s) <= n) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    if (w + cw(ch) > n - 1) break
    out += ch
    w += cw(ch)
  }
  return `${out}…`
}

/** `s` in at most two lines of `n` columns: broken at the last space that fits, else as wrapLabel breaks a word; the
 *  second line cut. */
export function fold(s: string, n: number): string[] {
  const t = s.replace(/\s+/g, ' ').trim()
  if (width(t) <= n) return [t]
  let w = 0
  let sp = -1
  let i = 0
  for (const ch of t) {
    if (w + cw(ch) > n) break
    if (ch === ' ' && w > n / 3) sp = i
    w += cw(ch)
    i += ch.length
  }
  if (t[i] === ' ') sp = i
  if (sp < 0) return wrapLabel(t, n)
  return [t.slice(0, sp), cut(t.slice(sp + 1), n)]
}

function pad(s: string, n: number, right = false): string {
  const c = cut(s, n)
  const fill = ' '.repeat(Math.max(0, n - width(c)))
  return right ? fill + c : c + fill
}

export function lineWidth(l: Line): number {
  return l.reduce((n, s) => n + width(s.s), 0)
}

/** `lines` with a background on the cells [x0, x1) of each span's line, segments split where a span starts or ends. */
export function shade(lines: readonly Line[], spans: readonly { line: number; x0: number; x1: number }[], bg: string): Line[] {
  return lines.map((l, y) => {
    const mine = spans.filter(s => s.line === y && s.x1 > s.x0)
    if (!mine.length) return l
    const on = (x: number) => mine.some(s => x >= s.x0 && x < s.x1)
    const out: Line = []
    let x = 0
    for (const seg of l) {
      let run = ''
      let runOn = false
      const flush = () => {
        if (run) out.push(runOn ? { ...seg, s: run, bg } : { ...seg, s: run })
        run = ''
      }
      for (const ch of seg.s) {
        const o = on(x)
        if (run && o !== runOn) flush()
        runOn = o
        run += ch
        x += cw(ch)
      }
      flush()
    }
    return out
  })
}

/** A layout's lines with item `i` shaded as the open menu's target: the row or column the layout lights for it, or
 *  else the cells that hit it. */
export function menuShade(lay: Layout, i: number): Line[] {
  if (i < 0) return lay.lines
  if (lay.lines.some(l => l.some(s => s.bg === COLORS.cursor))) return lay.lines.map(l => l.map(s => (s.bg === COLORS.cursor ? { ...s, bg: COLORS.menu } : s)))
  const spans: { line: number; x0: number; x1: number }[] = []
  lay.lines.forEach((l, y) => {
    const w = lineWidth(l)
    let x0 = -1
    for (let x = 0; x <= w; x++) {
      const on = x < w && lay.hit(x, y) === i
      if (on && x0 < 0) x0 = x
      if (!on && x0 >= 0) {
        spans.push({ line: y, x0, x1: x })
        x0 = -1
      }
    }
  })
  return shade(lay.lines, spans, COLORS.menu)
}

// ---------------------------------------------------------------------------------------- cards

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

function bar(v: number, max: number, w: number): string {
  if (max <= 0 || w <= 0) return ''
  const n8 = Math.max(v !== 0 ? 1 : 0, Math.round((Math.abs(v) / max) * w * 8))
  return '█'.repeat(Math.floor(n8 / 8)) + EIGHTHS[n8 % 8]!
}

function compact(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${fmt(+(v / 1e9).toFixed(1))}B`
  if (a >= 1e6) return `${fmt(+(v / 1e6).toFixed(1))}M`
  if (a >= 1e5) return `${fmt(+(v / 1e3).toFixed(0))}k`
  if (a >= 1e4) return `${fmt(+(v / 1e3).toFixed(1))}k`
  return fmt(+v.toPrecision(4))
}

function cite(display: string, ref: string): string {
  return `[[${display}|${ref}]]`
}

export const MAX_BARS = 30
export const MAX_TABLE_ROWS = 15

function barLayout(card: CardData, cols: number, hover: number): Layout {
  const rows = ((card.rows ?? []) as BarRow[]).slice(0, MAX_BARS)
  const more = (card.rows?.length ?? 0) - rows.length
  const col = card.y || 'value'
  const groups = [...new Set(rows.map(r => r.group).filter(Boolean))]
  const valueW = Math.max(...rows.map(r => fmt(r.value).length), 1)
  const room = cols - valueW - 3
  // the bars keep two fifths of the room; a label longer than the rest takes two lines
  const labelW = Math.min(Math.max(4, ...rows.map(r => width(r.label))), Math.max(8, room - Math.max(12, Math.ceil(room * 0.4))))
  const barW = Math.max(4, room - labelW)
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 0)
  const lines: Line[] = []
  const owner: number[] = []
  const items: Item[] = rows.map(r => ({
    label: r.label,
    value: `${fmt(r.value)} ${col}`,
    cite: cite(fmt(r.value), `card:${card.id}#${col}/${r.label}`),
    open: `card:${card.id}#${col}/${r.label}`,
    kind: 'mark',
    text: fmt(r.value),
  }))
  rows.forEach((r, i) => {
    const on = i === hover
    const color = on ? COLORS.accent : r.value < 0 ? COLORS.negative : COLORS.series[Math.max(0, groups.indexOf(r.group)) % COLORS.series.length]!
    const b = bar(r.value, max, barW)
    const [first, second] = fold(r.label, labelW)
    const style = { fg: on ? COLORS.accent : COLORS.dim, b: on }
    lines.push([
      { s: pad(first!, labelW), ...style },
      { s: ' ' },
      { s: b, fg: color },
      { s: ' '.repeat(Math.max(1, barW - width(b) + 1)) },
      { s: pad(fmt(r.value), valueW, true), b: on },
    ])
    owner.push(i)
    if (second) {
      lines.push([{ s: pad(second, labelW), ...style }])
      owner.push(i)
    }
  })
  const foot: Seg[] = []
  if (more > 0) foot.push({ s: `… ${more} more rows  `, fg: COLORS.dim })
  if (card.total !== undefined) foot.push({ s: `all: ${fmt(card.total)}  `, fg: COLORS.dim })
  groups.forEach((g, j) => foot.push({ s: '■ ', fg: COLORS.series[j % COLORS.series.length] }, { s: `${g}  `, fg: COLORS.dim }))
  if (foot.length) lines.push(foot)
  return { lines, items, hit: (_x, y) => owner[y] ?? -1 }
}

const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

function xNumber(v: string | number, kind: 'num' | 'time' | 'cat', i: number): number {
  if (kind === 'num') return Number(v)
  if (kind === 'time') return Date.parse(String(v).replace(' ', 'T'))
  return i
}

function lineLayout(card: CardData, cols: number, hover: number, plotRows = 10): Layout {
  const series = (card.series ?? []).filter(s => s.points.length > 0)
  const all = series.flatMap(s => s.points)
  const xs = all.map(p => p[0])
  const kind: 'num' | 'time' | 'cat' = xs.every(x => typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))))
    ? 'num'
    : xs.every(x => typeof x === 'string' && /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2}(:\d{2})?)?/.test(x) && !Number.isNaN(Date.parse(x.replace(' ', 'T'))))
      ? 'time'
      : 'cat'
  // categorical x: one position per distinct value, in first-seen order
  const cats = kind === 'cat' ? [...new Set(xs.map(String))] : []
  const xOf = (p: [string | number, number], i: number) => (kind === 'cat' ? cats.indexOf(String(p[0])) : xNumber(p[0], kind, i))
  const xv = series.flatMap(s => s.points.map((p, i) => xOf(p, i)))
  const yv = all.map(p => p[1])
  const x0 = Math.min(...xv)
  const x1 = Math.max(...xv)
  let y0 = Math.min(...yv, 0 < Math.min(...yv) && Math.min(...yv) < Math.max(...yv) * 0.3 ? 0 : Math.min(...yv))
  let y1 = Math.max(...yv)
  if (y0 === y1) {
    y0 -= 1
    y1 += 1
  }
  const labels = [compact(y1), compact((y0 + y1) / 2), compact(y0)]
  const yW = Math.max(...labels.map(l => l.length)) + 1
  const pw = Math.max(10, cols - yW - 1)
  const W = pw * 2
  const H = plotRows * 4
  const bits: number[][] = Array.from({ length: plotRows }, () => new Array<number>(pw).fill(0))
  const owner: number[][] = Array.from({ length: plotRows }, () => new Array<number>(pw).fill(-1))
  const px = (x: number) => (x1 === x0 ? Math.floor(W / 2) : Math.round(((x - x0) / (x1 - x0)) * (W - 1)))
  const py = (y: number) => Math.round(((y1 - y) / (y1 - y0)) * (H - 1))
  const plot = (dx: number, dy: number, s: number) => {
    if (dx < 0 || dy < 0 || dx >= W || dy >= H) return
    const cx = dx >> 1
    const cy = dy >> 2
    bits[cy]![cx]! |= DOT[dy & 3]![dx & 1]!
    owner[cy]![cx] = s
  }
  series.forEach((s, si) => {
    const pts = s.points.map((p, i) => [px(xOf(p, i)), py(p[1])] as const).sort((a, b) => a[0] - b[0])
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i]!
      if (i === 0 || pts.length === 1) plot(ax, ay, si)
      if (i === 0) continue
      const [bx0, by0] = pts[i - 1]!
      const steps = Math.max(Math.abs(ax - bx0), Math.abs(ay - by0), 1)
      for (let t = 0; t <= steps; t++) plot(Math.round(bx0 + ((ax - bx0) * t) / steps), Math.round(by0 + ((ay - by0) * t) / steps), si)
    }
  })
  // the point nearest the pointer's column, per series; items are every point of every series, in order
  const items: Item[] = []
  const at: { s: number; i: number; cx: number; cy: number }[] = []
  series.forEach((s, si) =>
    s.points.forEach((p, i) => {
      const xLabel = String(p[0])
      items.push({ label: xLabel, value: `${s.name} ${fmt(p[1])}`, cite: cite(fmt(p[1]), `card:${card.id}#${s.name}/${xLabel}`), open: `card:${card.id}#${s.name}/${xLabel}`, kind: 'mark', text: fmt(p[1]) })
      at.push({ s: si, i, cx: px(xOf(p, i)) >> 1, cy: py(p[1]) >> 2 })
    }),
  )
  const nearest = (x: number, y: number): number => {
    const cx = x - yW - 1
    if (cx < 0 || cx >= pw || y < 0 || y >= plotRows) return -1
    let best = -1
    let score = Infinity
    at.forEach((a, j) => {
      const d = Math.abs(a.cx - cx) * 4 + Math.abs(a.cy - y)
      if (d < score) {
        score = d
        best = j
      }
    })
    return best
  }
  const hot = hover >= 0 ? at[hover] : undefined
  const lines: Line[] = []
  for (let r = 0; r < plotRows; r++) {
    const yl = r === 0 ? labels[0]! : r === plotRows - 1 ? labels[2]! : r === Math.floor((plotRows - 1) / 2) ? labels[1]! : ''
    const row: Line = [{ s: yl.padStart(yW - 1) + ' ', fg: COLORS.dim }, { s: '│', fg: COLORS.rule }]
    for (let c = 0; c < pw; c++) {
      const b = bits[r]![c]!
      const o = owner[r]![c]!
      const isHot = hot && c === hot.cx
      const isPoint = hot && c === hot.cx && r === hot.cy
      row.push({
        s: b ? String.fromCodePoint(0x2800 + b) : isHot ? '┊' : ' ',
        fg: isPoint ? COLORS.accent : b ? COLORS.series[Math.max(0, o) % COLORS.series.length] : COLORS.dim,
        bg: isHot ? COLORS.cursor : undefined,
        b: Boolean(isPoint),
      })
    }
    lines.push(row)
  }
  const first = kind === 'cat' ? cats[0] ?? '' : String(series[0]?.points[0]?.[0] ?? '')
  const lastPts = series[0]?.points ?? []
  const last = kind === 'cat' ? cats.at(-1) ?? '' : String(lastPts.at(-1)?.[0] ?? '')
  const axis = ' '.repeat(yW) + '└' + '─'.repeat(pw)
  lines.push([{ s: axis, fg: COLORS.rule }])
  const xl = first.length + last.length + 2 <= pw ? first + ' '.repeat(pw - first.length - last.length) + last : first
  lines.push([{ s: ' '.repeat(yW + 1) + xl, fg: COLORS.dim }])
  if (series.length > 1) lines.push(series.flatMap((s, si) => [{ s: '━ ', fg: COLORS.series[si % COLORS.series.length] }, { s: `${s.name}  `, fg: COLORS.dim }]))
  return { lines, items, hit: (x, y) => nearest(x, y) }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?$/

/**
 * Timestamps as a timeline shows them, all in one form: "18 Jun 21:26", the year only when the events span more than
 * one, the time only when one is not midnight, seconds only when two events share a minute. The clock reads as written
 * (no time zone conversion). Times that are not all ISO dates are kept as they are. helper/tcard.py has the same rule.
 */
export function shortTimes(times: readonly string[]): string[] {
  const parts = times.map(t => STAMP.exec(t.trim()))
  if (!parts.length || parts.some(p => !p)) return [...times]
  const ps = parts as RegExpExecArray[]
  const years = new Set(ps.map(p => p[1]))
  const clock = ps.some(p => (p[4] ?? '00') !== '00' || (p[5] ?? '00') !== '00' || (p[6] ?? '00') !== '00')
  const minute = (p: RegExpExecArray) => `${p[1]}-${p[2]}-${p[3]} ${p[4] ?? '00'}:${p[5] ?? '00'}`
  const secs = ps.some(p => ps.some(q => minute(p) === minute(q) && (p[6] ?? '00') !== (q[6] ?? '00')))
  return ps.map(p => {
    const day = `${Number(p[3])} ${MONTHS[Number(p[2]) - 1] ?? p[2]}${years.size > 1 ? ` ${p[1]}` : ''}`
    if (!clock) return day
    return `${day} ${p[4] ?? '00'}:${p[5] ?? '00'}${secs ? `:${p[6] ?? '00'}` : ''}`
  })
}

function timelineLayout(card: CardData, cols: number, hover: number): Layout {
  const evs = (card.events ?? []).slice(0, 30)
  const times = evs.map(e => Date.parse(e.time.replace(' ', 'T')))
  const isTime = times.every(t => !Number.isNaN(t))
  // the form the card helper wrote beside each time, else the same rule applied here
  const fallback = shortTimes(evs.map(e => e.time))
  const shown = evs.map((e, i) => e.shown || fallback[i]!)
  const lines: Line[] = []
  const items: Item[] = evs.map((e, i) => ({
    label: shown[i]!,
    value: e.label,
    cite: e.ref ? `[[${e.ref}]]` : cite(shown[i]!, `card:${card.id}#time/${i + 1}`),
    open: e.ref || `card:${card.id}#time/${i + 1}`,
    kind: e.ref ? 'record' : 'mark',
    text: e.ref ? e.label : shown[i]!,
  }))
  let axisRows = 0
  if (isTime && evs.length > 1) {
    const t0 = Math.min(...times)
    const t1 = Math.max(...times)
    const aw = Math.max(10, cols - 2)
    const cells = new Array<number>(aw).fill(-1)
    times.forEach((t, i) => {
      const x = t1 === t0 ? 0 : Math.round(((t - t0) / (t1 - t0)) * (aw - 1))
      cells[x] = cells[x] === -1 || i === hover ? i : cells[x]!
    })
    lines.push([
      { s: ' ' },
      ...cells.map((c): Seg => (c >= 0 ? { s: '●', fg: c === hover ? COLORS.accent : COLORS.series[0], b: c === hover } : { s: '─', fg: COLORS.rule })),
    ])
    const a = shown[times.indexOf(t0)]!
    const b = shown[times.indexOf(t1)]!
    lines.push([{ s: ` ${a}${' '.repeat(Math.max(1, aw - width(a) - width(b)))}${b}`, fg: COLORS.dim }])
    axisRows = 2
  }
  const tW = Math.min(Math.max(...shown.map(t => width(t))), 22)
  const owner: number[] = lines.map(() => -1)
  evs.forEach((e, i) => {
    const on = i === hover
    const label = fold(e.label, Math.max(8, cols - tW - 6))
    const arrow: Seg[] = e.ref ? [{ s: ' ↗', fg: COLORS.dim }] : []
    lines.push([
      { s: on ? '▶ ' : '  ', fg: COLORS.accent },
      { s: pad(shown[i]!, tW, isTime), fg: on ? COLORS.accent : COLORS.dim, b: on },
      { s: '  ' },
      { s: label[0]!, b: on },
      ...(label.length === 1 ? arrow : []),
    ])
    owner.push(i)
    if (label[1]) {
      lines.push([{ s: ' '.repeat(tW + 4) }, { s: label[1], b: on }, ...arrow])
      owner.push(i)
    }
  })
  return { lines, items, hit: (_x, y) => owner[y] ?? -1 }
}

function tableLayout(card: CardData, cols: number, hover: number): Layout {
  const heads = card.columns ?? []
  const all = (card.rows ?? []) as Cell[][]
  const rows = all.slice(0, MAX_TABLE_ROWS)
  const numeric = heads.map((_, c) => rows.every(r => typeof r[c] === 'number' || r[c] === null))
  const nat = heads.map((h, c) => Math.max(width(h), ...rows.map(r => width(fmt(r[c])))))
  const gap = 2
  // the widest columns narrow until the table fits; a cell wider than its column takes two lines
  const ws = nat.map(n => Math.min(n, cols))
  while (ws.reduce((a, b) => a + b, 0) + gap * (ws.length - 1) > cols && Math.max(...ws) > 6) ws[ws.indexOf(Math.max(...ws))]! -= 1
  const xs: number[] = []
  ws.reduce((x, w) => (xs.push(x), x + w + gap), 0)
  const items: Item[] = []
  rows.forEach(r =>
    heads.forEach((h, c) => {
      const v = fmt(r[c])
      const ref = `card:${card.id}#${h}/${fmt(r[0])}`
      items.push({ label: `${fmt(r[0])} · ${h}`, value: v, cite: c === 0 ? v : cite(v, ref), open: ref, kind: c === 0 ? 'row' : 'mark', text: v })
    }),
  )
  const hr = hover >= 0 ? Math.floor(hover / Math.max(1, heads.length)) : -1
  const hc = hover >= 0 ? hover % Math.max(1, heads.length) : -1
  const cell = (s: string, c: number) => pad(s, ws[c]!, numeric[c])
  // a row's cells, each in one or two lines
  const parts = (r: string[]) => r.map((s, c) => (numeric[c] ? [s] : fold(s, ws[c]!)))
  const lines: Line[] = []
  const owner: number[] = []
  // a header folds whatever its column holds, so a number column's name is not cut
  const head = heads.map((h, c) => fold(h, ws[c]!))
  for (let k = 0; k < Math.max(...head.map(p => p.length)); k++) {
    lines.push(heads.flatMap((_, c): Seg[] => [{ s: cell(head[c]![k] ?? '', c), b: true }, ...(c < heads.length - 1 ? [{ s: '  ' }] : [])]))
    owner.push(-1)
  }
  lines.push([{ s: ws.map(w => '─'.repeat(w)).join('  '), fg: COLORS.rule }])
  owner.push(-1)
  rows.forEach((r, ri) => {
    const p = parts(heads.map((_, c) => fmt(r[c])))
    const bg = ri === hr ? COLORS.cursor : undefined
    for (let k = 0; k < Math.max(...p.map(q => q.length)); k++) {
      lines.push(
        heads.flatMap((_, c): Seg[] => [
          { s: cell(p[c]![k] ?? '', c), bg, b: ri === hr && c === hc, u: ri === hr && c === hc && k < p[c]!.length },
          ...(c < heads.length - 1 ? [{ s: '  ', bg }] : []),
        ]),
      )
      owner.push(ri)
    }
  })
  if (all.length > rows.length) lines.push([{ s: `… ${all.length - rows.length} more rows`, fg: COLORS.dim }])
  return {
    lines,
    items,
    hit: (x, y) => {
      const ri = owner[y] ?? -1
      if (ri < 0) return -1
      let c = xs.findIndex((x0, i) => x >= x0 && x < x0 + ws[i]! + (i < ws.length - 1 ? gap : 0))
      if (c < 0) c = 0
      return ri * heads.length + c
    },
  }
}

function exampleLayout(card: CardData, cols: number, hover: number): Layout {
  const exs = (card.examples ?? []).slice(0, 8)
  const lines: Line[] = []
  const owner: number[] = []
  const items: Item[] = exs.map(e => ({ label: e.ref, value: e.note || e.quote.slice(0, 60), cite: `[[${e.ref}]]`, open: e.ref, kind: 'record', text: e.note || e.quote }))
  exs.forEach((e, i) => {
    const on = i === hover
    const color = on ? COLORS.accent : COLORS.series[0]
    const room = Math.max(10, cols - 4)
    // the note in up to two lines, its record after it where it fits, else on a line of its own
    const ref: Seg = { s: e.ref, fg: on ? COLORS.link : COLORS.dim, u: on }
    const note = e.note ? (width(e.note) + 2 + width(e.ref) <= room ? [e.note] : fold(e.note, room)) : []
    note.forEach((t, k) => {
      const last = k === note.length - 1 && width(t) + 2 + width(e.ref) <= room
      lines.push([{ s: '▍ ', fg: color }, { s: t, b: true }, ...(last ? [{ s: '  ' }, ref] : [])])
      owner.push(i)
    })
    if (!note.length || width(note.at(-1)!) + 2 + width(e.ref) > room) {
      lines.push([{ s: '▍ ', fg: color }, ref])
      owner.push(i)
    }
    const words = e.quote.replace(/\s+/g, ' ').trim()
    let rest = words
    let n = 0
    while (rest && n < 4) {
      let take = rest
      if (width(take) > room) {
        const sp = take.lastIndexOf(' ', room)
        take = take.slice(0, sp > room / 2 ? sp : room)
      }
      rest = rest.slice(take.length).trimStart()
      n++
      lines.push([{ s: '▍ ', fg: color }, { s: n === 4 && rest ? `${take.slice(0, room - 1)}…` : take, i: true }])
      owner.push(i)
    }
    if (i < exs.length - 1) {
      lines.push([])
      owner.push(-1)
    }
  })
  return { lines, items, hit: (_x, y) => owner[y] ?? -1 }
}

// ---------------------------------------------------------------------------------------- diagrams

export const MAX_NODES = 40
export const MAX_EDGES = 80
const NODE_LABEL = 24 // columns of a label line; a longer label takes two lines, and the readout has the whole label
const NODE_LABEL_MIN = 12
const NODE_LABEL_MAX = 40
const EDGE_INLINE = 24 // a longer edge label, or one with no place of its own beside its edge, is a numbered note

/**
 * Nodes in layers by dependency, as thimble's canvas lays out a diagram: a node with no incoming edge sits in layer 0,
 * every other one layer past its furthest predecessor. A cycle is broken at the node with the fewest unplaced
 * predecessors.
 */
export function layerGraph(ids: readonly string[], edges: readonly DiagramEdge[]): Map<string, number> {
  const known = new Set(ids)
  const preds = new Map<string, Set<string>>(ids.map(id => [id, new Set<string>()]))
  for (const e of edges) if (known.has(e.source) && known.has(e.target) && e.source !== e.target) preds.get(e.target)!.add(e.source)
  const layer = new Map<string, number>()
  const left = new Set(ids)
  while (left.size) {
    let placed = 0
    for (const id of [...left]) {
      const ps = [...preds.get(id)!]
      if (ps.every(p => layer.has(p))) {
        layer.set(id, ps.reduce((m, p) => Math.max(m, layer.get(p)! + 1), 0))
        left.delete(id)
        placed++
      }
    }
    if (placed) continue
    const unplaced = (id: string) => [...preds.get(id)!].filter(p => !layer.has(p)).length
    const pick = [...left].sort((a, b) => unplaced(a) - unplaced(b))[0]!
    layer.set(pick, [...preds.get(pick)!].reduce((m, p) => (layer.has(p) ? Math.max(m, layer.get(p)! + 1) : m), 0))
    left.delete(pick)
  }
  return layer
}

/**
 * A node's label in at most two lines of at most `w` columns: one line when it fits, else broken at a space, a case
 * change, a digit run or after punctuation, as evenly as it goes (a space preferred); a second line still too long is
 * cut.
 */
export function wrapLabel(label: string, w: number): string[] {
  const s = label.replace(/\s+/g, ' ').trim()
  if (width(s) <= w) return [s]
  const chars = [...s]
  let best: [string, string] | null = null
  let score = Number.POSITIVE_INFINITY
  for (let i = 1; i < chars.length; i++) {
    const a = chars[i - 1]!
    const b = chars[i]!
    const space = b === ' '
    if (a === ' ') continue
    if (!space && !(/[a-z]/.test(a) && /[A-Z]/.test(b)) && !(/[A-Za-z]/.test(a) && /[0-9]/.test(b)) && !/[-_/.:,;)]/.test(a)) continue
    const l1 = chars.slice(0, i).join('')
    const l2 = chars.slice(space ? i + 1 : i).join('')
    if (!l2 || width(l1) > w) continue
    const sc = Math.max(width(l1), width(l2)) + (width(l2) > w ? 1000 : 0) + (space ? 0 : 2)
    if (sc < score) {
      score = sc
      best = [l1, l2]
    }
  }
  if (!best) {
    // no break fits: split inside the word, the first line as full as the halves allow
    const half = Math.min(w, Math.ceil(width(s) / 2))
    let l1 = ''
    for (const ch of chars) {
      if (width(l1) + cw(ch) > half) break
      l1 += ch
    }
    best = [l1, s.slice(l1.length)]
  }
  return [best[0], cut(best[1], w)]
}

/** Lefts for a row of boxes of widths `w`, each as near its wanted centre as the gaps allow, inside [0, room]. */
function placeRow(w: readonly number[], want: readonly number[], room: number, gap: readonly number[]): number[] {
  const x = w.map((wi, i) => Math.round(want[i]! - wi / 2))
  for (let i = 0; i < x.length; i++) x[i] = Math.max(x[i]!, i ? x[i - 1]! + w[i - 1]! + gap[i - 1]! : 0)
  for (let i = x.length - 1; i >= 0; i--) x[i] = Math.min(x[i]!, i < x.length - 1 ? x[i + 1]! - gap[i]! - w[i]! : room - w[i]!)
  for (let i = 0; i < x.length; i++) x[i] = Math.max(x[i]!, i ? x[i - 1]! + w[i - 1]! + gap[i - 1]! : 0)
  return x
}

const U = 1
const D = 2
const L = 4
const R = 8
const JOIN: Record<number, string> = {
  [U | D]: '│', [L | R]: '─', [D | R]: '╭', [D | L]: '╮', [U | R]: '╰', [U | L]: '╯',
  [U | D | R]: '├', [U | D | L]: '┤', [D | L | R]: '┬', [U | L | R]: '┴', [U | D | L | R]: '┼',
  [U]: '│', [D]: '│', [L]: '─', [R]: '─',
}

/**
 * A diagram drawn with box-drawing characters, top to bottom, a layer of nodes to a row (layerGraph), each node then
 * moved to the row between its neighbours that makes its edges shortest. A row too wide for the card wraps its labels
 * to two lines, then cuts them, then moves nodes to a row of their own; a drawing still too wide is laid out again
 * with narrower gaps and labels (FITS). Each edge has a
 * port of its own on its source's bottom border and its target's top border, where the arrow is (an edge drawn
 * against the layers has its arrow at the top end); a box with many edges is widened to keep its ports apart. An edge
 * across several rows passes each one as a vertical line. Between two rows each edge that bends takes a track of its
 * own, ordered so that verticals cross no horizontal run where an order allows it. Rows are ordered to cross as few
 * edges as the heuristics find: sweeps by the mean place of neighbours, then swaps and moves within a row.
 *
 * An edge's label stands where it can belong to no other edge: on the edge's own horizontal run, or beside its own last
 * vertical with clear space around it. Otherwise it is a numbered note under the drawing, and the number is written on
 * the edge's own line. Items: the nodes in order, then the edges.
 */
function diagramGrid(nodes: DiagramNode[], edges: DiagramEdge[], cols: number, fit: Fit): Grid {
  const ids = nodes.map(n => n.id)
  const at = new Map(ids.map((id, i) => [id, i]))
  const N = nodes.length
  const layer = layerGraph(ids, edges)
  const depth = () => Math.max(0, ...layer.values())
  const insertRow = (after: number) => {
    for (const [id, l] of layer) if (l > after) layer.set(id, l + 1)
  }
  // an edge between two nodes of one row (left by a broken cycle): its target moves to a row of its own below
  for (let guard = 0; guard < N; guard++) {
    const flat = edges.find(e => layer.get(e.source) === layer.get(e.target))
    if (!flat) break
    const l = layer.get(flat.source)!
    insertRow(l)
    layer.set(flat.target, l + 1)
  }
  // a node with more edges below it than above moves down to just above its nearest neighbour below, and one with more
  // above moves up, so fewer lines pass rows
  const nbrs = ids.map((id, i) => edges.flatMap(e => (at.get(e.source) === i ? [e.target] : at.get(e.target) === i ? [e.source] : [])))
  for (let pass = 0, moved = true; pass < N && moved; pass++) {
    moved = false
    ids.forEach((id, i) => {
      const l = layer.get(id)!
      const ls = nbrs[i]!.map(o => layer.get(o)!)
      const up = ls.filter(x => x < l)
      const down = ls.filter(x => x > l)
      const to = down.length > up.length ? Math.min(...down) - 1 : up.length > down.length && up.length ? Math.max(...up) + 1 : l
      if (to !== l) {
        layer.set(id, to)
        moved = true
      }
    })
  }
  // rows left empty close up
  const used = [...new Set(layer.values())].sort((a, b) => a - b)
  for (const [id, l] of layer) layer.set(id, used.indexOf(l))

  // boxes: wide enough for the label and for a blank column between ports; a row too wide for the card wraps its
  // labels to two lines of at least NODE_LABEL_MIN columns, then cuts them
  const lab = nodes.map(n => wrapLabel(n.label, Math.max(1, Math.min(fit.label, cols - 4))))
  const labW = (i: number) => Math.max(1, ...lab[i]!.map(width))
  const portW = nodes.map((_, i) => {
    let up = 0
    let down = 0
    for (const e of edges) {
      const fwd = layer.get(e.source)! < layer.get(e.target)!
      if (at.get(fwd ? e.source : e.target) === i) down++
      if (at.get(fwd ? e.target : e.source) === i) up++
    }
    const k = Math.max(up, down)
    return k > 1 ? Math.min(cols, 2 * k + 1) : 0
  })
  const boxW = (i: number) => Math.max(labW(i) + 4, portW[i]!)
  const GAP = fit.gap
  for (let l = 0; l <= depth(); l++) {
    const row = ids.map((_, i) => i).filter(i => layer.get(ids[i]!) === l)
    if (row.reduce((a, i) => a + boxW(i), 0) + GAP * Math.max(0, row.length - 1) <= cols) continue
    const each = Math.max(Math.min(NODE_LABEL_MIN, fit.label), Math.floor((cols - GAP * (row.length - 1)) / row.length) - 4)
    for (const i of row) lab[i] = wrapLabel(nodes[i]!.label, Math.min(labW(i), each))
  }

  // entries of each row: nodes and the points where longer edges pass; segments join entries of adjacent rows
  type Entry = { key: string; node: number; edge: number; w: number; x: number }
  type SegT = { edge: number; up: Entry; low: Entry; xa: number; xb: number; track: number }
  const gaps = (r: Entry[]) => r.slice(0, -1).map((en, i) => (en.node < 0 && r[i + 1]!.node < 0 ? fit.pass : en.node < 0 || r[i + 1]!.node < 0 ? fit.side : GAP))
  const rowWidth = (r: Entry[]) => r.reduce((a, en) => a + en.w, 0) + gaps(r).reduce((a, b) => a + b, 0)
  const build = () => {
    const rows: Entry[][] = Array.from({ length: depth() + 1 }, () => [])
    nodes.forEach((_, i) => rows[layer.get(ids[i]!)!]!.push({ key: `n${i}`, node: i, edge: -1, w: boxW(i), x: 0 }))
    const dirs = edges.map(e => {
      const rev = layer.get(e.source)! > layer.get(e.target)!
      return { rev, top: at.get(rev ? e.target : e.source)!, bottom: at.get(rev ? e.source : e.target)! }
    })
    const entryOf = new Map<string, Entry>()
    for (const r of rows) for (const en of r) entryOf.set(en.key, en)
    const segs: SegT[] = []
    edges.forEach((_, k) => {
      const { top, bottom } = dirs[k]!
      const l0 = layer.get(ids[top]!)!
      const l1 = layer.get(ids[bottom]!)!
      let prev = entryOf.get(`n${top}`)!
      for (let l = l0 + 1; l <= l1; l++) {
        let cur: Entry
        if (l === l1) cur = entryOf.get(`n${bottom}`)!
        else {
          cur = { key: `d${k}.${l}`, node: -1, edge: k, w: 1, x: 0 }
          rows[l]!.push(cur)
        }
        segs.push({ edge: k, up: prev, low: cur, xa: 0, xb: 0, track: -1 })
        prev = cur
      }
    })
    return { rows, dirs, segs }
  }
  // then a row still too wide, with the lines passing it, moves nodes to a row of their own below: nodes with no edge
  // onward first, each taking its box off the row and adding a line for each edge reaching it from above. A strict fit
  // counts the widest gap between every two entries, as their order may put a line between each two boxes.
  const wrapWidth = (r: Entry[]) => (fit.strict ? r.reduce((a, en) => a + en.w, 0) + Math.max(fit.gap, fit.side) * (r.length - 1) : rowWidth(r))
  let built = build()
  for (let guard = 0; guard < 2 * N; guard++) {
    const over = built.rows.findIndex(r => r.filter(en => en.node >= 0).length > 1 && wrapWidth(r) > cols)
    if (over < 0) break
    const r = built.rows[over]!
    const onward = (i: number) => edges.some((e, k) => at.get(e.source) === i && built.dirs[k]!.top === i)
    const order = r.filter(en => en.node >= 0).map(en => en.node).sort((a, b) => Number(onward(b)) - Number(onward(a)) || a - b)
    let w = wrapWidth(r)
    const move: number[] = []
    while (w > cols && order.length > 1) {
      const i = order.pop()!
      const reaching = edges.filter((e, k) => built.dirs[k]!.bottom === i && layer.get(ids[built.dirs[k]!.top]!)! < over).length
      w -= boxW(i) + GAP - reaching * 3
      move.push(i)
    }
    insertRow(over)
    for (const i of move) layer.set(ids[i]!, over + 1)
    built = build()
  }
  const { rows, dirs, segs } = built
  const rowOf = new Map<string, number>()
  rows.forEach((r, l) => r.forEach(en => rowOf.set(en.key, l)))
  const ups = new Map<string, SegT[]>()
  const lows = new Map<string, SegT[]>()
  for (const s of segs) {
    lows.set(s.up.key, [...(lows.get(s.up.key) ?? []), s])
    ups.set(s.low.key, [...(ups.get(s.low.key) ?? []), s])
  }
  // a row of boxes is as tall as its tallest label
  const bh = rows.map(r => Math.max(3, ...r.filter(en => en.node >= 0).map(en => lab[en.node]!.length + 2)))

  // order each row by the mean position of its neighbours, sweeps down and up, keeping the order that crosses fewest
  // edges; then swap neighbours in a row, and move each entry to its best place in its row, while that removes
  // crossings. From a few starting orders (as given, reversed, depth first from the top row, shuffled), the best kept.
  const pos = new Map<string, number>()
  const indexRow = (r: Entry[]) => r.forEach((en, i) => pos.set(en.key, i))
  const index = () => rows.forEach(indexRow)
  const mean = (xs: number[], dflt: number) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : dflt)
  const between = rows.slice(0, -1).map((_, l) => segs.filter(s => rowOf.get(s.up.key) === l))
  // pairs of segments between rows l and l + 1 whose ends lie in opposite orders
  const crossings = (l: number) => {
    const list = between[l]
    if (!list?.length) return 0
    const pairs = list.map(s => [pos.get(s.up.key)!, pos.get(s.low.key)!] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const seen: number[] = new Array<number>(rows[l + 1]!.length).fill(0)
    let n = 0
    for (let i = 0, j = 0; i < pairs.length; i = j) {
      while (j < pairs.length && pairs[j]![0] === pairs[i]![0]) j++
      for (let k = i; k < j; k++) for (let p = pairs[k]![1] + 1; p < seen.length; p++) n += seen[p]!
      for (let k = i; k < j; k++) seen[pairs[k]![1]] = seen[pairs[k]![1]]! + 1
    }
    return n
  }
  const total = () => rows.reduce((n, _, l) => n + crossings(l), 0)
  const sortBy = (r: Entry[], near: Map<string, SegT[]>, other: (s: SegT) => Entry) => {
    const key = new Map(r.map(en => [en, mean((near.get(en.key) ?? []).map(s => pos.get(other(s).key)!), pos.get(en.key)!)]))
    r.sort((a, b) => key.get(a)! - key.get(b)!)
    indexRow(r)
  }
  // within one row, with the rows above and below fixed: the crossings among the segments of u and v when u stands left
  // of v, from the places of their other ends
  const improveRow = (r: Entry[]): boolean => {
    const k = r.length
    if (k < 2) return false
    const ends = r.map(en => [(ups.get(en.key) ?? []).map(s => pos.get(s.up.key)!), (lows.get(en.key) ?? []).map(s => pos.get(s.low.key)!)])
    const id = new Map(r.map((en, i) => [en, i]))
    const memo = new Int32Array(k * k).fill(-1)
    const c = (u: Entry, v: Entry) => {
      const i = id.get(u)!
      const j = id.get(v)!
      if (memo[i * k + j]! >= 0) return memo[i * k + j]!
      let n = 0
      for (let side = 0; side < 2; side++) for (const x of ends[i]![side]!) for (const y of ends[j]![side]!) if (x > y) n++
      memo[i * k + j] = n
      return n
    }
    let better = false
    for (let i = 0; i + 1 < r.length; i++) {
      if (c(r[i + 1]!, r[i]!) < c(r[i]!, r[i + 1]!)) {
        ;[r[i], r[i + 1]] = [r[i + 1]!, r[i]!]
        better = true
      }
    }
    for (const en of [...r]) {
      const from = r.indexOf(en)
      r.splice(from, 1)
      let cost = r.reduce((n, w) => n + c(en, w), 0)
      const costs = [cost]
      for (const w of r) costs.push((cost += c(w, en) - c(en, w)))
      let to = from
      costs.forEach((n, i) => {
        if (n < costs[to]!) to = i
      })
      r.splice(to, 0, en)
      if (to !== from) better = true
    }
    indexRow(r)
    return better
  }
  const orderFrom = (start: Entry[][]) => {
    rows.forEach((r, l) => r.splice(0, r.length, ...start[l]!))
    index()
    let best = rows.map(r => [...r])
    let least = total()
    for (let sweep = 0; sweep < 8 && least > 0; sweep++) {
      for (let l = 1; l < rows.length; l++) sortBy(rows[l]!, ups, s => s.up)
      for (let l = rows.length - 2; l >= 0; l--) sortBy(rows[l]!, lows, s => s.low)
      const n = total()
      if (n < least) {
        least = n
        best = rows.map(r => [...r])
      }
    }
    rows.forEach((r, l) => r.splice(0, r.length, ...best[l]!))
    index()
    for (let pass = 0, better = least > 0; pass < 10 && better; pass++) {
      better = false
      for (const r of rows) better = improveRow(r) || better
    }
    return { rows: rows.map(r => [...r]), n: total() }
  }
  const given = rows.map(r => [...r])
  const dfs: Entry[][] = rows.map(() => [])
  const seenKeys = new Set<string>()
  const visit = (en: Entry) => {
    if (seenKeys.has(en.key)) return
    seenKeys.add(en.key)
    dfs[rowOf.get(en.key)!]!.push(en)
    for (const s of lows.get(en.key) ?? []) visit(s.low)
  }
  for (const r of given) for (const en of r) visit(en)
  let seed = 1
  const shuffled = () =>
    given.map(r => {
      const out = [...r]
      for (let i = out.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) % 2147483648
        const j = seed % (i + 1)
        ;[out[i], out[j]] = [out[j]!, out[i]!]
      }
      return out
    })
  // fewer starts for a large drawing, so its first draw stays quick
  const entries = given.reduce((n, r) => n + r.length, 0)
  const starts = [() => given.map(r => [...r].reverse()), () => dfs, shuffled, shuffled, shuffled, shuffled].slice(0, entries <= 150 ? 6 : entries <= 400 ? 2 : 0)
  let found = orderFrom(given)
  for (const start of starts) {
    if (!found.n) break
    const o = orderFrom(start())
    if (o.n < found.n) found = o
  }
  rows.forEach((r, l) => r.splice(0, r.length, ...found.rows[l]!))
  index()

  // x: packed, then each row pulled toward its neighbours' centres
  const centre = (en: Entry) => en.x + (en.w - 1) / 2
  for (const r of rows) placeRow(r.map(en => en.w), r.map(() => 0), Number.POSITIVE_INFINITY, gaps(r)).forEach((x, i) => (r[i]!.x = x))
  const room = Math.max(cols, ...rows.map(rowWidth))
  const pull = (l: number, near: Map<string, SegT[]>, other: (s: SegT) => Entry) => {
    const r = rows[l]!
    const want = r.map(en => mean((near.get(en.key) ?? []).map(s => centre(other(s))), centre(en)) + 0.5)
    placeRow(r.map(en => en.w), want, room, gaps(r)).forEach((x, i) => (r[i]!.x = x))
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < rows.length; l++) pull(l, ups, s => s.up)
    for (let l = rows.length - 2; l >= 0; l--) pull(l, lows, s => s.low)
  }
  for (let l = 1; l < rows.length; l++) pull(l, ups, s => s.up)
  // left-aligned, with up to 12 columns kept free on the left for labels where the width allows
  const minX = Math.min(...rows.flatMap(r => r.map(en => en.x)))
  const maxX = Math.max(...rows.flatMap(r => r.map(en => en.x + en.w)))
  const shift = Math.max(0, minX - Math.max(0, Math.min(12, cols - (maxX - minX))))
  for (const r of rows) for (const en of r) en.x -= shift

  // ports: a node's edges leave its bottom border and reach its top border at columns spread about its centre, in the
  // order of the entries at their other ends; only a box too narrow for them all makes them share one port as a bus
  const spread = (en: Entry, list: SegT[], other: (s: SegT) => Entry, set: (s: SegT, x: number) => void) => {
    const sorted = [...list].sort((a, b) => centre(other(a)) - centre(other(b)))
    if (en.node < 0) {
      for (const s of sorted) set(s, en.x)
      return
    }
    const k = sorted.length
    const step = k > 1 ? Math.max(0, Math.min(4, Math.floor((en.w - 3) / (k - 1)))) : 0
    const first = Math.round(centre(en) - (step * (k - 1)) / 2)
    sorted.forEach((s, j) => set(s, Math.min(en.x + en.w - 2, Math.max(en.x + 1, first + j * step))))
  }
  const ports = () => {
    for (const r of rows) {
      for (const en of r) {
        spread(en, lows.get(en.key) ?? [], s => s.low, (s, x) => (s.xa = x))
        spread(en, ups.get(en.key) ?? [], s => s.up, (s, x) => (s.xb = x))
      }
    }
  }
  ports()
  // each row below the first pulled once more, toward the ports above it rather than the boxes' centres
  for (let l = 1; l < rows.length; l++) {
    const r = rows[l]!
    const want = r.map(en => mean((ups.get(en.key) ?? []).map(s => s.xa), centre(en)) + 0.5)
    placeRow(r.map(en => en.w), want, room, gaps(r)).forEach((x, i) => (r[i]!.x = x))
    ports()
  }
  // an edge whose other end lies above or below its box's border runs straight: its port moves there, when that keeps
  // its order among the box's other ports and a blank column beside each
  const straighten = (en: Entry, list: SegT[], s: SegT, end: 'xa' | 'xb', x: number): boolean => {
    if (en.node < 0 || x < en.x + 1 || x > en.x + en.w - 2) return false
    const cur = s[end]
    if (list.some(o => o !== s && o[end] === cur)) return false
    for (const o of list) {
      if (o === s) continue
      if ((o[end] < cur && o[end] >= x - 1) || (o[end] > cur && o[end] <= x + 1)) return false
    }
    s[end] = x
    return true
  }
  // a point where a longer edge passes a row moves under the port above it, where the row leaves room
  const fitsAt = (en: Entry, x: number): boolean => {
    const r = rows[rowOf.get(en.key)!]!
    const i = r.indexOf(en)
    const g = gaps(r)
    if (x < 0 || x + en.w > room) return false
    return !(i > 0 && x < r[i - 1]!.x + r[i - 1]!.w + g[i - 1]!) && !(i < r.length - 1 && x + en.w + g[i]! > r[i + 1]!.x)
  }
  const shiftPass = (en: Entry, x: number): boolean => {
    if (!fitsAt(en, x)) return false
    en.x = x
    for (const o of ups.get(en.key) ?? []) o.xb = x
    for (const o of lows.get(en.key) ?? []) o.xa = x
    return true
  }
  // or over the port below it, and a straight line above it moves along: the points above it, up to the port it leaves
  const carry = (en: Entry, x: number, depth = 0): boolean => {
    if (!fitsAt(en, x)) return false
    const u = (ups.get(en.key) ?? [])[0]
    if (u && u.xa === u.xb && depth < rows.length) {
      if (u.up.node >= 0 ? !straighten(u.up, lows.get(u.up.key)!, u, 'xa', x) : !carry(u.up, x, depth + 1)) return false
    }
    return shiftPass(en, x)
  }
  for (const r of between) {
    // rightmost first, then leftmost first, so a point moving toward its port is not held by one that moves too
    for (const order of [[...r].sort((a, b) => b.xa - a.xa), [...r].sort((a, b) => a.xa - b.xa)]) {
      for (const s of order) if (s.xa !== s.xb && s.low.node < 0) shiftPass(s.low, s.xa)
    }
    for (const s of r) {
      if (s.xa !== s.xb && !straighten(s.up, lows.get(s.up.key)!, s, 'xa', s.xb)) straighten(s.low, ups.get(s.low.key)!, s, 'xb', s.xa)
    }
  }
  // a box whose lines would run straight a column or two over moves there, where its row leaves room
  for (const r of rows) {
    for (const en of r) {
      if (en.node < 0) continue
      const mine = [...(ups.get(en.key) ?? []).map(s => [s, 'xb'] as const), ...(lows.get(en.key) ?? []).map(s => [s, 'xa'] as const)]
      const straight = (d: number) => mine.filter(([s, end]) => (end === 'xb' ? s.xb + d === s.xa : s.xa + d === s.xb)).length
      let best = 0
      for (const d of [-1, 1, -2, 2]) if (straight(d) > straight(best) && fitsAt(en, en.x + d)) best = d
      if (!best) continue
      en.x += best
      for (const [s, end] of mine) s[end] += best
    }
  }
  // bottom up, each point that still bends below moves over the port below it, where it can
  for (const r of [...between].reverse()) {
    for (const order of [[...r].sort((a, b) => b.xb - a.xb), [...r].sort((a, b) => a.xb - b.xb)]) {
      for (const s of order) if (s.xa !== s.xb && s.up.node < 0) carry(s.up, s.xb)
    }
  }

  // a drawing that moved past the card's right edge moves back into the columns left free on its left
  const over = Math.min(Math.min(...rows.flatMap(r => r.map(en => en.x))), Math.max(...rows.flatMap(r => r.map(en => en.x + en.w))) - cols)
  if (over > 0) {
    for (const r of rows) for (const en of r) en.x -= over
    for (const sg of segs) {
      sg.xa -= over
      sg.xb -= over
    }
  }

  // tracks: a bending segment's horizontal run, on a row of the channel no other unrelated run overlaps. A segment whose
  // top column lies within another's run runs above it, and one whose bottom column does runs below it, so their lines
  // do not cross; where both hold, a crossing cannot be avoided
  const related = (a: SegT, b: SegT) => a.edge === b.edge || (a.up === b.up && a.xa === b.xa) || (a.low === b.low && a.xb === b.xb)
  const lo = (s: SegT) => Math.min(s.xa, s.xb)
  const hi = (s: SegT) => Math.max(s.xa, s.xb)
  const channels = rows.slice(0, -1).map((_, l) => {
    const mine = between[l]!
    const bend = mine.filter(s => s.xa !== s.xb)
    const above = new Map(bend.map(s => [s, new Set<SegT>()]))
    for (const p of bend) {
      for (const q of bend) {
        if (p === q || related(p, q)) continue
        if (q.xa >= lo(p) && q.xa <= hi(p)) above.get(p)!.add(q)
        if (q.xb >= lo(p) && q.xb <= hi(p)) above.get(q)!.add(p)
      }
    }
    let left = [...bend].sort((a, b) => lo(a) - lo(b))
    let tracks = 0
    while (left.length) {
      const placed = new Set(bend.filter(s => s.track >= 0))
      const waiting = (s: SegT) => [...above.get(s)!].filter(q => !placed.has(q)).length
      let ready = left.filter(s => waiting(s) === 0)
      if (!ready.length) {
        // every segment waits: one on a cycle of waits goes first (its crossing cannot be avoided), not one that only
        // waits for a cycle, which would cross a line it need not
        const onCycle = (s: SegT) => {
          const seen = new Set<SegT>()
          const stack = [...above.get(s)!].filter(q => !placed.has(q))
          while (stack.length) {
            const q = stack.pop()!
            if (q === s) return true
            if (seen.has(q)) continue
            seen.add(q)
            for (const r of above.get(q)!) if (!placed.has(r)) stack.push(r)
          }
          return false
        }
        const cyc = left.filter(onCycle)
        ready = [(cyc.length ? cyc : left).reduce((a, b) => (waiting(b) < waiting(a) ? b : a))]
      }
      const on: SegT[] = []
      for (const s of ready) {
        if (on.every(o => related(o, s) || hi(s) < lo(o) || hi(o) < lo(s))) {
          s.track = tracks
          on.push(s)
        }
      }
      left = left.filter(s => s.track < 0)
      tracks++
    }
    return { segs: mine, tracks }
  })
  const lastSeg = edges.map((_, k) => segs.filter(s => s.edge === k).at(-1)!)
  const labelled = (l: number) => channels[l]!.segs.some(s => s === lastSeg[s.edge] && edges[s.edge]!.label)
  const heights = channels.map((c, l) => Math.max(1, c.tracks + (labelled(l) ? 1 : 0)))
  const top: number[] = []
  let y = 0
  rows.forEach((_, l) => {
    top.push(y)
    y += bh[l]! + (heights[l] ?? 0)
  })
  const H = y
  const Wd = Math.max(1, ...rows.flatMap(r => r.map(en => en.x + en.w)))

  // the grid: each cell's line directions per segment, then boxes and text over them
  type Mark = { seg: number; d: number }
  type CellT = { marks: Mark[]; ch?: string; item: number; kind: 'line' | 'box' | 'label' | 'arrow' | 'text' | ''; num?: boolean }
  const grid: CellT[][] = Array.from({ length: H }, () => Array.from({ length: Wd }, () => ({ marks: [], item: -1, kind: '' as const })))
  const mark = (x: number, yy: number, seg: number, d: number) => {
    const c = grid[yy]?.[x]
    if (!c) return
    const m = c.marks.find(q => q.seg === seg)
    if (m) m.d |= d
    else c.marks.push({ seg, d })
  }
  segs.forEach((s, si) => {
    const l = rowOf.get(s.up.key)!
    const y0 = top[l]! + bh[l]!
    const h = heights[l]!
    if (s.up.node < 0) for (let k = 0; k < bh[l]!; k++) mark(s.xa, top[l]! + k, si, U | D)
    if (s.xa === s.xb) {
      for (let k = 0; k < h; k++) mark(s.xa, y0 + k, si, U | D)
      return
    }
    const t = y0 + s.track
    for (let yy = y0; yy < t; yy++) mark(s.xa, yy, si, U | D)
    const dir = s.xb > s.xa ? 1 : -1
    mark(s.xa, t, si, U | (dir > 0 ? R : L))
    for (let x = s.xa + dir; x !== s.xb; x += dir) mark(x, t, si, L | R)
    mark(s.xb, t, si, D | (dir > 0 ? L : R))
    for (let yy = t + 1; yy < y0 + h; yy++) mark(s.xb, yy, si, U | D)
  })
  for (const c of grid.flat()) {
    if (!c.marks.length) continue
    c.kind = 'line'
    c.item = N + segs[c.marks[0]!.seg]!.edge
    const groups: Mark[][] = []
    for (const m of c.marks) {
      const g = groups.find(gr => gr.some(o => related(segs[o.seg]!, segs[m.seg]!)))
      if (g) g.push(m)
      else groups.push([m])
    }
    const bits = groups.map(g => g.reduce((a, m) => a | m.d, 0))
    // two unrelated lines crossing: the vertical one is drawn whole, so it does not read as a junction
    const vert = groups.findIndex((_, j) => bits[j] === (U | D))
    if (groups.length > 1 && vert >= 0 && bits.some(b => b === (L | R))) {
      c.ch = '│'
      c.item = N + segs[groups[vert]![0]!.seg]!.edge
    } else c.ch = JOIN[bits.reduce((a, b) => a | b, 0)] ?? '┼'
  }
  // boxes, each label line centred
  rows.forEach((r, l) => {
    for (const en of r) {
      if (en.node < 0) continue
      const i = en.node
      const inner = en.w - 2
      const h = bh[l]!
      const text = lab[i]!
      const first = Math.floor((h - 2 - text.length) / 2)
      for (let k = 0; k < h; k++) {
        let line: string
        if (k === 0) line = '╭' + '─'.repeat(inner) + '╮'
        else if (k === h - 1) line = '╰' + '─'.repeat(inner) + '╯'
        else {
          const t = text[k - 1 - first] ?? ''
          const left = 1 + Math.floor((inner - 2 - width(t)) / 2)
          line = '│' + ' '.repeat(left) + t + ' '.repeat(Math.max(0, inner - left - width(t))) + '│'
        }
        let x = en.x
        for (const ch of line) {
          const c = grid[top[l]! + k]?.[x]
          const inside = k > 0 && k < h - 1 && x > en.x && x < en.x + en.w - 1
          if (c) Object.assign(c, { ch, item: i, kind: inside ? 'text' : 'box', marks: [] })
          x += 1
        }
      }
    }
  })
  // ports and arrows on the borders
  segs.forEach(s => {
    const k = s.edge
    const { rev } = dirs[k]!
    const lu = rowOf.get(s.up.key)!
    if (s.up.node >= 0) {
      const c = grid[top[lu]! + bh[lu]! - 1]![s.xa]!
      Object.assign(c, rev ? { ch: '▲', kind: 'arrow', item: N + k } : { ch: c.ch === '▲' ? '▲' : '┬', kind: c.ch === '▲' ? 'arrow' : 'box' })
    }
    if (s.low.node >= 0) {
      const c = grid[top[lu + 1]!]![s.xb]!
      Object.assign(c, rev ? { ch: c.ch === '▼' ? '▼' : '┴', kind: c.ch === '▼' ? 'arrow' : 'box' } : { ch: '▼', kind: 'arrow', item: N + k })
    }
  })

  // edge labels: on the edge's own horizontal run when it is long enough, else beside its own last vertical with clear
  // cells around, else a numbered note whose number is written on a cell of the edge's own line
  const free = (x: number, yy: number) => x >= 0 && x < cols && (grid[yy]?.[x] === undefined || (grid[yy]![x]!.kind === '' && !grid[yy]![x]!.marks.length))
  const write = (x: number, yy: number, text: string, item: number, num = false) => {
    let cx = x
    for (const ch of text) {
      while (grid[yy]!.length <= cx) grid[yy]!.push({ marks: [], item: -1, kind: '' })
      Object.assign(grid[yy]![cx]!, { ch, item, kind: 'label', num, marks: [] })
      cx += 1
    }
  }
  const notes: { n: number; edge: number }[] = []
  edges.forEach((e, k) => {
    if (!e.label) return
    const s = lastSeg[k]!
    const l = rowOf.get(s.up.key)!
    const y0 = top[l]! + bh[l]!
    const text = e.label
    const w = width(text)
    const own = (x: number, yy: number, d: number) => {
      const c = grid[yy]?.[x]
      return Boolean(c && c.kind === 'line' && c.marks.length && c.marks.every(m => segs[m.seg]!.edge === k && m.d === d))
    }
    if (w <= EDGE_INLINE && s.xa !== s.xb && Math.abs(s.xb - s.xa) - 1 >= w + 2) {
      const t = y0 + s.track
      const x = lo(s) + 1 + Math.floor((Math.abs(s.xb - s.xa) - 1 - (w + 2)) / 2)
      let clear = true
      for (let cx = x; cx < x + w + 2; cx++) clear &&= own(cx, t, L | R)
      if (clear) return write(x, t, ` ${text} `, N + k)
    }
    // beside the vertical: one blank cell between them and four past the text, on a vertical no other edge shares
    const row = y0 + heights[l]! - 1
    const alone = !segs.some(o => o !== s && o.low === s.low && o.xb === s.xb)
    const clearRun = (a: number, b: number) => {
      for (let cx = a; cx <= b; cx++) if (cx < cols && !free(cx, row)) return false
      return true
    }
    if (alone && w <= EDGE_INLINE) {
      const right = s.xb + 2
      if (right + w <= cols && clearRun(s.xb + 1, right + w + 3)) return write(right, row, text, N + k)
      const left = s.xb - 1 - w
      if (left >= 0 && clearRun(Math.max(0, left - 4), s.xb - 1)) return write(left, row, text, N + k)
    }
    const n = notes.length + 1
    notes.push({ n, edge: k })
    // the number on the edge's own vertical, nearest the arrow first, else on its own horizontal run
    const digits = String(n)
    // not beside another number, nor within four cells of a label's words
    const crowded = (x: number, yy: number) => {
      for (let cx = x - 4; cx < x + digits.length + 4; cx++) {
        const c = grid[yy]?.[cx]
        if (c?.kind === 'label' && (!c.num || cx === x - 1 || cx === x + digits.length)) return true
      }
      return false
    }
    const cells: [number, number, boolean][] = []
    grid.forEach((r, yy) => r.forEach((_, x) => {
      if (own(x, yy, U | D)) cells.push([x, yy, true])
      else if (own(x, yy, L | R)) cells.push([x, yy, false])
    }))
    cells.sort((a, b) => Number(b[2]) - Number(a[2]) || b[1] - a[1])
    for (const [x, yy, vertical] of cells) {
      let fits = !crowded(x, yy)
      for (let j = 1; j < digits.length && fits; j++) fits = vertical ? free(x + j, yy) : own(x + j, yy, L | R)
      if (fits) {
        write(x, yy, digits, N + k, true)
        break
      }
    }
  })

  return { grid, notes, width: Math.max(Wd, ...grid.map(r => r.length)) }
}

/** `text` in lines broken at spaces: the first `first` columns wide (0: none), the rest `w`, at most `max` in all, the
 *  last cut. */
function noteLines(text: string, first: number, w: number, max: number): string[] {
  const out: string[] = first ? [] : ['']
  let rest = text.replace(/\s+/g, ' ').trim()
  while (rest && out.length < max) {
    const room = out.length || !first ? w : first
    if (out.length === max - 1 || width(rest) <= room) {
      out.push(cut(rest, room))
      break
    }
    const sp = rest.lastIndexOf(' ', room)
    const take = sp > room / 2 ? rest.slice(0, sp) : cut(rest, room).slice(0, -1)
    out.push(take)
    rest = rest.slice(take.length).trimStart()
  }
  return out
}

type GridCell = { ch?: string; item: number; kind: 'line' | 'box' | 'label' | 'arrow' | 'text' | ''; num?: boolean }
type Grid = { grid: GridCell[][]; notes: { n: number; edge: number }[]; width: number }

/** Gaps between boxes, between a box and a passing line, and between two passing lines; the widest label line; and
 *  whether a row wraps by its widest possible width. */
type Fit = { gap: number; side: number; pass: number; label: number; strict?: boolean }
const FITS: Fit[] = [
  { gap: 3, side: 2, pass: 1, label: NODE_LABEL },
  { gap: 2, side: 1, pass: 1, label: 16 },
  { gap: 1, side: 1, pass: 1, label: NODE_LABEL_MIN },
  { gap: 1, side: 1, pass: 0, label: 8 },
  { gap: 1, side: 1, pass: 0, label: 8, strict: true },
]

// the last few drawings, so a pointer move repaints without laying the diagram out again
const grids = new Map<string, Grid>()

function diagramLayout(card: CardData, cols: number, hover: number): Layout {
  const nodes = (card.nodes ?? []).slice(0, MAX_NODES)
  const at = new Map(nodes.map((n, i) => [n.id, i]))
  const edges = (card.edges ?? []).slice(0, MAX_EDGES).filter(e => at.has(e.source) && at.has(e.target) && e.source !== e.target)
  const N = nodes.length
  const key = JSON.stringify([cols, nodes, edges])
  let g = grids.get(key)
  if (!g) {
    for (const fit of FITS) {
      g = diagramGrid(nodes, edges, cols, fit)
      if (g.width <= cols) break
    }
    // a label NODE_LABEL's two lines would cut gets a wider box, up to NODE_LABEL_MAX, when that fits no taller
    const cutAt = (label: string, w: number) => !label.endsWith('…') && wrapLabel(label, w).at(-1)!.endsWith('…')
    let need = NODE_LABEL
    for (const n of nodes) while (need < NODE_LABEL_MAX && cutAt(n.label, need)) need++
    if (need > NODE_LABEL && g!.width <= cols) {
      const wide = diagramGrid(nodes, edges, cols, { ...FITS[0]!, label: need })
      if (wide.width <= cols && wide.grid.length <= g!.grid.length) g = wide
    }
    grids.set(key, g!)
    if (grids.size > 16) grids.delete(grids.keys().next().value!)
  }
  const { grid, notes } = g!

  // the grid as lines; the hovered node or edge drawn in the accent colour
  const hotNode = hover >= 0 && hover < N ? hover : -1
  const hotEdge = hover >= N ? hover - N : -1
  const owners: number[][] = grid.map(r => r.map(c => c.item))
  const lines: Line[] = grid.map(r => {
    const line: Line = []
    for (const c of r) {
      const ch = c.ch ?? ' '
      let seg: Seg
      if (c.kind === 'text') seg = { s: ch, b: c.item === hotNode, fg: c.item === hotNode ? COLORS.accent : undefined }
      else if (c.kind === 'box') seg = { s: ch, fg: c.item === hotNode ? COLORS.accent : COLORS.dim, b: c.item === hotNode }
      else if (c.kind === 'line' || c.kind === 'arrow' || c.kind === 'label') {
        const on = c.item - N === hotEdge && hotEdge >= 0
        seg = { s: ch, fg: on ? COLORS.accent : COLORS.dim, b: on || Boolean(c.num), i: c.kind === 'label' && !c.num }
      } else seg = { s: ch }
      const prev = line.at(-1)
      if (prev && prev.fg === seg.fg && prev.b === seg.b && prev.i === seg.i) prev.s += seg.s
      else line.push(seg)
    }
    return line
  })
  // a note: its number, its edge's ends and its label, the label wrapped under the ends to four lines in all
  for (const { n, edge } of notes) {
    const e = edges[edge]!
    const on = edge === hotEdge
    const num = `${n}  `
    const room = Math.max(8, cols - width(num))
    const [src, tgt] = [nodes[at.get(e.source)!]!.label, nodes[at.get(e.target)!]!.label]
    let ends = `${src} → ${tgt}: `
    if (width(ends) > room) {
      // the shorter end whole where it fits in half the room, the longer one in the rest
      const both = room - 5
      const sw = Math.max(3, Math.min(width(src), Math.max(Math.floor(both / 2), both - width(tgt))))
      ends = `${cut(src, sw)} → ${cut(tgt, Math.max(3, both - sw))}: `
    }
    const left = room - width(ends)
    const first = left >= 10 || left >= width(e.label ?? '') ? left : 0
    const label = noteLines(e.label ?? '', first, room, first ? 4 : 5)
    const style = { fg: on ? COLORS.accent : COLORS.dim, b: on }
    const text = { i: true, fg: on ? COLORS.accent : undefined }
    lines.push([{ s: num + ends, ...style }, ...(first && label[0] ? [{ s: label.shift()!, ...text }] : [])])
    if (!first) label.shift()
    for (const l of label) lines.push([{ s: ' '.repeat(width(num)) + l, ...text }])
    for (let k = 0; k <= label.length; k++) owners.push(new Array<number>(cols).fill(N + edge))
  }
  const items: Item[] = [
    ...nodes.map(
      (n): Item => ({
        label: n.label,
        value: [n.detail, n.ref].filter(Boolean).join(' · '),
        cite: n.ref ? `[[${n.ref}]]` : cite(n.label, `card:${card.id}#node/${n.id}`),
        open: n.ref || `card:${card.id}#node/${n.id}`,
        kind: 'node',
        text: n.label,
      }),
    ),
    ...edges.map(
      (e, k): Item => ({
        label: `${nodes[at.get(e.source)!]!.label} → ${nodes[at.get(e.target)!]!.label}`,
        value: e.label ?? '',
        cite: `[[card:${card.id}#edge/${k + 1}]]`,
        open: `card:${card.id}#edge/${k + 1}`,
        kind: 'mark',
        text: '',
      }),
    ),
  ]
  return { lines, items, hit: (x, yy) => owners[yy]?.[x] ?? -1 }
}

export function cardLayout(card: CardData, cols: number, hover: number, plotRows?: number): Layout {
  switch (card.kind) {
    case 'bar':
      return barLayout(card, cols, hover)
    case 'line':
      return lineLayout(card, cols, hover, plotRows)
    case 'timeline':
      return timelineLayout(card, cols, hover)
    case 'table':
      return tableLayout(card, cols, hover)
    case 'example':
      return exampleLayout(card, cols, hover)
    case 'diagram':
      return diagramLayout(card, cols, hover)
    default:
      return { lines: [[{ s: `unknown card kind ${card.kind}`, fg: COLORS.dim }]], items: [], hit: () => -1 }
  }
}
