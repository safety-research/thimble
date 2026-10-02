// Layouts as styled lines, shared by the surface modules (the interactive chips and cards) and the hooks module (the
// static drawing where no Client runs). Each layout takes the width it may use and the item under the pointer, and
// returns its lines and a hit test from a cell to an item.
import { fmt } from './lib'

export type Seg = { s: string; fg?: string; bg?: string; b?: boolean; d?: boolean; i?: boolean; u?: boolean; inv?: boolean }
export type Line = Seg[]

export type BarRow = { label: string; value: number; group: string }
export type Cell = string | number | boolean | null
export type CardParam = { name: string; value: string | number; default: string | number; choices: (string | number)[] }
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
  events?: { time: string; label: string; ref: string }[]
  examples?: { ref: string; quote: string; note: string }[]
}

/** What the analyst did to a card, from .thimble-chat/notes/<id>.json, and what the mod is doing to it now. */
export type CardMeta = { starred?: boolean; hidden?: boolean; edited?: boolean; busy?: string; error?: string }

/** One thing a pointer can pick on a card: what the readout says and what a click puts in the prompt or opens. */
export type Item = { label: string; value: string; cite: string; open: string }

export type Layout = { lines: Line[]; items: Item[]; hit: (x: number, y: number) => number }

export const COLORS = {
  series: ['#5ba3e0', '#e8a33d', '#6cc644', '#d16ba5', '#9f8fef', '#4ec9b0'],
  accent: '#ffd166',
  dim: '#8b949e',
  rule: '#3d444d',
  cursor: '#30363d',
  code: '#e6b450',
  chip: { ok: '#2d7d46', differs: '#a8730f', missing: '#b3392f', unchecked: '#57606a', pending: '#57606a' } as Record<string, string>,
  chipFg: '#ffffff',
}

export function statusColor(status: string): string {
  return COLORS.chip[status] ?? COLORS.chip.pending!
}

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

function pad(s: string, n: number, right = false): string {
  const c = cut(s, n)
  const fill = ' '.repeat(Math.max(0, n - width(c)))
  return right ? fill + c : c + fill
}

export function lineWidth(l: Line): number {
  return l.reduce((n, s) => n + width(s.s), 0)
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
  const labelW = Math.min(Math.max(4, ...rows.map(r => width(r.label))), Math.max(8, Math.floor(cols / 3)), 28)
  const valueW = Math.max(...rows.map(r => fmt(r.value).length), 1)
  const barW = Math.max(4, cols - labelW - valueW - 3)
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 0)
  const lines: Line[] = []
  const items: Item[] = rows.map(r => ({
    label: r.label,
    value: `${fmt(r.value)} ${col}`,
    cite: cite(fmt(r.value), `card:${card.id}#${col}/${r.label}`),
    open: `card:${card.id}#${col}/${r.label}`,
  }))
  rows.forEach((r, i) => {
    const on = i === hover
    const color = on ? COLORS.accent : COLORS.series[Math.max(0, groups.indexOf(r.group)) % COLORS.series.length]!
    const b = bar(r.value, max, barW)
    lines.push([
      { s: pad(r.label, labelW), d: !on, b: on },
      { s: ' ' },
      { s: b, fg: r.value < 0 ? '#e5534b' : color },
      { s: ' '.repeat(Math.max(1, barW - width(b) + 1)) },
      { s: pad(fmt(r.value), valueW, true), b: on },
    ])
  })
  const foot: Seg[] = []
  if (more > 0) foot.push({ s: `… ${more} more rows  `, fg: COLORS.dim })
  if (card.total !== undefined) foot.push({ s: `all: ${fmt(card.total)}  `, fg: COLORS.dim })
  groups.forEach((g, j) => foot.push({ s: '■ ', fg: COLORS.series[j % COLORS.series.length] }, { s: `${g}  `, fg: COLORS.dim }))
  if (foot.length) lines.push(foot)
  return { lines, items, hit: (_x, y) => (y >= 0 && y < rows.length ? y : -1) }
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
      items.push({ label: xLabel, value: `${s.name} ${fmt(p[1])}`, cite: cite(fmt(p[1]), `card:${card.id}#${s.name}/${xLabel}`), open: `card:${card.id}#${s.name}/${xLabel}` })
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
        fg: isPoint ? COLORS.accent : b ? COLORS.series[Math.max(0, o) % COLORS.series.length] : COLORS.rule,
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

function timelineLayout(card: CardData, cols: number, hover: number): Layout {
  const evs = (card.events ?? []).slice(0, 30)
  const times = evs.map(e => Date.parse(e.time.replace(' ', 'T')))
  const isTime = times.every(t => !Number.isNaN(t))
  const lines: Line[] = []
  const items: Item[] = evs.map((e, i) => ({
    label: e.time,
    value: e.label,
    cite: e.ref ? `[[${e.ref}]]` : cite(e.time, `card:${card.id}#time/${i + 1}`),
    open: e.ref || `card:${card.id}#time/${i + 1}`,
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
    const a = evs[times.indexOf(t0)]!.time
    const b = evs[times.indexOf(t1)]!.time
    lines.push([{ s: ` ${a}${' '.repeat(Math.max(1, aw - a.length - b.length))}${b}`, fg: COLORS.dim }])
    axisRows = 2
  }
  const tW = Math.min(Math.max(...evs.map(e => width(e.time))), 22)
  evs.forEach((e, i) => {
    const on = i === hover
    lines.push([
      { s: on ? '▶ ' : '  ', fg: COLORS.accent },
      { s: pad(e.time, tW), fg: on ? COLORS.accent : COLORS.dim },
      { s: '  ' },
      { s: cut(e.label, Math.max(8, cols - tW - 6)), b: on },
      ...(e.ref ? [{ s: ' ↗', fg: COLORS.dim }] : []),
    ])
  })
  return { lines, items, hit: (_x, y) => (y >= axisRows && y - axisRows < evs.length ? y - axisRows : -1) }
}

function tableLayout(card: CardData, cols: number, hover: number): Layout {
  const heads = card.columns ?? []
  const all = (card.rows ?? []) as Cell[][]
  const rows = all.slice(0, MAX_TABLE_ROWS)
  const numeric = heads.map((_, c) => rows.every(r => typeof r[c] === 'number' || r[c] === null))
  const nat = heads.map((h, c) => Math.max(width(h), ...rows.map(r => width(fmt(r[c])))))
  const gap = 2
  let ws = nat.map(n => Math.min(n, 40))
  while (ws.reduce((a, b) => a + b, 0) + gap * (ws.length - 1) > cols && Math.max(...ws) > 6) {
    const j = ws.indexOf(Math.max(...ws))
    ws = ws.map((w, i) => (i === j ? w - 1 : w))
  }
  const xs: number[] = []
  ws.reduce((x, w) => (xs.push(x), x + w + gap), 0)
  const items: Item[] = []
  rows.forEach(r =>
    heads.forEach((h, c) => {
      const v = fmt(r[c])
      items.push({ label: `${fmt(r[0])} · ${h}`, value: v, cite: c === 0 ? v : cite(v, `card:${card.id}#${h}/${fmt(r[0])}`), open: `card:${card.id}#${h}/${fmt(r[0])}` })
    }),
  )
  const hr = hover >= 0 ? Math.floor(hover / Math.max(1, heads.length)) : -1
  const hc = hover >= 0 ? hover % Math.max(1, heads.length) : -1
  const cell = (s: string, c: number) => pad(s, ws[c]!, numeric[c])
  const lines: Line[] = []
  lines.push(heads.flatMap((h, c): Seg[] => [{ s: cell(h, c), b: true }, ...(c < heads.length - 1 ? [{ s: '  ' }] : [])]))
  lines.push([{ s: ws.map(w => '─'.repeat(w)).join('  '), fg: COLORS.rule }])
  rows.forEach((r, ri) => {
    lines.push(
      heads.flatMap((_, c): Seg[] => [
        { s: cell(fmt(r[c]), c), bg: ri === hr ? COLORS.cursor : undefined, fg: ri === hr && c === hc ? COLORS.accent : c === 0 ? undefined : undefined, b: ri === hr && c === hc },
        ...(c < heads.length - 1 ? [{ s: '  ', bg: ri === hr ? COLORS.cursor : undefined }] : []),
      ]),
    )
  })
  if (all.length > rows.length) lines.push([{ s: `… ${all.length - rows.length} more rows`, fg: COLORS.dim }])
  return {
    lines,
    items,
    hit: (x, y) => {
      const ri = y - 2
      if (ri < 0 || ri >= rows.length) return -1
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
  const items: Item[] = exs.map(e => ({ label: e.ref, value: e.note || e.quote.slice(0, 60), cite: `[[${e.ref}]]`, open: e.ref }))
  exs.forEach((e, i) => {
    const on = i === hover
    const color = on ? COLORS.accent : COLORS.series[0]
    lines.push([{ s: '▍ ', fg: color }, ...(e.note ? [{ s: cut(e.note, cols - 4 - width(e.ref) - 2), b: true }, { s: '  ' }] : []), { s: e.ref, fg: COLORS.dim, u: on }])
    owner.push(i)
    const words = e.quote.replace(/\s+/g, ' ').trim()
    const room = Math.max(10, cols - 4)
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
    default:
      return { lines: [[{ s: `unknown card kind ${card.kind}`, fg: COLORS.dim }]], items: [], hit: () => -1 }
  }
}

/** What a card's readout says when nothing is under the pointer. */
export function cardHint(card: CardData): string {
  switch (card.kind) {
    case 'bar':
      return 'hover a bar to read it, click to cite it'
    case 'line':
      return 'hover the line to read a point, click to cite it'
    case 'table':
      return 'hover a cell to read it, click to cite it'
    case 'timeline':
      return 'hover an event, click to open its record'
    case 'example':
      return 'click a record to open it'
    default:
      return ''
  }
}
