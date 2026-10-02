// Layouts as styled lines, shared by the surface modules (the interactive chips and cards) and the hooks module (the
// static drawing where no Client runs). Each layout takes the width it may use and the item under the pointer, and
// returns its lines and a hit test from a cell to an item.
import { fmt } from './lib'
import type { Run, TableRuns } from './lib'
import { COLORS } from './paint'

export { COLORS }

export type Seg = { s: string; fg?: string; bg?: string; b?: boolean; d?: boolean; i?: boolean; u?: boolean; inv?: boolean }
export type Line = Seg[]

export type ChipView = { label: string; status: string; mark: string; tip: string }

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
  events?: { time: string; label: string; ref: string }[]
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

// ---------------------------------------------------------------------------------------- paragraphs with chips

export type ChipSpan = { line: number; x0: number; x1: number; chip: number }
export type ParaLayout = { lines: Line[]; spans: ChipSpan[] }

/** A rich block wrapped to `cols`: words flow, each citation is one chip that never breaks. */
export function paraLayout(
  block: { prefix: string; heading: number; quote: boolean; runs: Run[] },
  chips: ChipView[],
  cols: number,
  hover: number,
): ParaLayout {
  const lead = block.quote ? '│ ' : block.prefix
  const indent = block.quote ? '│ ' : ' '.repeat(width(block.prefix))
  const room = Math.max(10, cols - width(lead))
  type Tok = { seg: Seg; space: boolean; chip: number }
  const toks: Tok[] = []
  let k = 0
  for (const r of block.runs) {
    if (r.cite) {
      const c = chips[k] ?? { label: r.text, status: 'pending', mark: '', tip: '' }
      const on = k === hover
      toks.push({ seg: { s: ` ${c.label}${c.mark} `, fg: COLORS.chipFg, bg: statusColor(c.status), b: true, inv: on, u: on }, space: false, chip: k })
      k++
      continue
    }
    for (const part of r.text.split(/(\s+)/)) {
      if (!part) continue
      const space = /^\s+$/.test(part)
      const style: Seg = { s: space ? ' ' : part }
      if (r.b || block.heading) style.b = true
      if (r.i) style.i = true
      if (r.u) style.u = true
      if (r.code) style.fg = COLORS.code
      toks.push({ seg: style, space, chip: -1 })
    }
  }
  const lines: Line[] = []
  const spans: ChipSpan[] = []
  let cur: Line = []
  let used = 0
  const newLine = () => {
    while (cur.length && cur.at(-1)!.s === ' ') {
      cur.pop()
    }
    lines.push(cur)
    cur = []
    used = 0
  }
  for (const t of toks) {
    const w = width(t.seg.s)
    if (t.space) {
      if (used > 0 && used + 1 <= room) {
        cur.push(t.seg)
        used += 1
      }
      continue
    }
    if (used > 0 && used + w > room) newLine()
    // a word longer than the line is cut into pieces
    let s = t.seg.s
    while (width(s) > room && t.chip < 0) {
      const head = cut(s, room + 1).slice(0, -1)
      cur.push({ ...t.seg, s: head })
      newLine()
      s = s.slice(head.length)
    }
    if (t.chip >= 0) spans.push({ line: lines.length, x0: width(lead) + used, x1: width(lead) + used + w, chip: t.chip })
    cur.push({ ...t.seg, s })
    used += width(s)
  }
  if (cur.length || lines.length === 0) newLine()
  const dimLead: Seg = { s: lead, fg: block.quote ? COLORS.dim : undefined, b: !block.quote && block.heading > 0 }
  return {
    lines: lines.map((l, i) => [i === 0 ? dimLead : { s: indent, fg: block.quote ? COLORS.dim : undefined }, ...l]),
    spans,
  }
}

/** A table block in aligned columns, the header bold over a rule, each citation one chip. Columns wider than `cols`
 *  allows are narrowed from the widest, their text cut; a chip is never cut (one that does not fit is left out). */
export function mdTableLayout(table: TableRuns, chips: ChipView[], cols: number, hover: number): ParaLayout {
  const GAP = 2
  let k = 0
  const grid: { segs: Seg[]; chip: number }[][][] = table.rows.map((row, r) =>
    row.map(cell =>
      cell.map(run => {
        if (run.cite) {
          const c = chips[k] ?? { label: run.text, status: 'pending', mark: '', tip: '' }
          const on = k === hover
          return { segs: [{ s: ` ${c.label}${c.mark} `, fg: COLORS.chipFg, bg: statusColor(c.status), b: true, inv: on, u: on }], chip: k++ }
        }
        const seg: Seg = { s: run.text.replace(/\s+/g, ' ') }
        if (run.b || r === 0) seg.b = true
        if (run.i) seg.i = true
        if (run.u) seg.u = true
        if (run.code) seg.fg = COLORS.code
        return { segs: [seg], chip: -1 }
      }),
    ),
  )
  const ncol = Math.max(...grid.map(r => r.length))
  const cellW = (cell: { segs: Seg[] }[] | undefined) => (cell ?? []).reduce((n, p) => n + lineWidth(p.segs), 0)
  const w = Array.from({ length: ncol }, (_, c) => Math.max(1, ...grid.map(r => cellW(r[c]))))
  const room = Math.max(ncol, cols - GAP * (ncol - 1))
  while (w.reduce((a, b) => a + b, 0) > room) {
    const widest = w.indexOf(Math.max(...w))
    if (w[widest]! <= 4) break
    w[widest]!--
  }
  const lines: Line[] = []
  const spans: ChipSpan[] = []
  grid.forEach((row, r) => {
    const line: Line = []
    let x = 0
    for (let c = 0; c < ncol; c++) {
      const parts = row[c] ?? []
      const fill = Math.max(0, w[c]! - cellW(parts))
      const align = table.align[c] ?? 'left'
      const before = align === 'right' ? fill : align === 'center' ? Math.floor(fill / 2) : 0
      if (c > 0) {
        line.push({ s: ' '.repeat(GAP) })
        x += GAP
      }
      if (before) line.push({ s: ' '.repeat(before) })
      let used = before
      for (const p of parts) {
        const pw = lineWidth(p.segs)
        if (used + pw > w[c]!) {
          if (p.chip >= 0 || w[c]! - used < 2) break
          line.push({ ...p.segs[0]!, s: cut(p.segs[0]!.s, w[c]! - used) })
          used = w[c]!
          break
        }
        if (p.chip >= 0) spans.push({ line: lines.length, x0: x + used, x1: x + used + pw, chip: p.chip })
        line.push(...p.segs)
        used += pw
      }
      if (w[c]! > used) line.push({ s: ' '.repeat(w[c]! - used) })
      x += w[c]!
    }
    lines.push(line)
    if (r === 0 && grid.length > 1) lines.push([{ s: w.map(n => '─'.repeat(n)).join(' '.repeat(GAP)), fg: COLORS.rule }])
  })
  return { lines, spans }
}

/** A rich block's layout: a table's columns, or a paragraph's flowing words. */
export function blockLayout(
  block: { prefix: string; heading: number; quote: boolean; runs: Run[]; table?: TableRuns },
  chips: ChipView[],
  cols: number,
  hover: number,
): ParaLayout {
  return block.table ? mdTableLayout(block.table, chips, cols, hover) : paraLayout(block, chips, cols, hover)
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
    kind: 'mark',
    text: fmt(r.value),
  }))
  rows.forEach((r, i) => {
    const on = i === hover
    const color = on ? COLORS.accent : r.value < 0 ? COLORS.negative : COLORS.series[Math.max(0, groups.indexOf(r.group)) % COLORS.series.length]!
    const b = bar(r.value, max, barW)
    lines.push([
      { s: pad(r.label, labelW), fg: on ? COLORS.accent : COLORS.dim, b: on },
      { s: ' ' },
      { s: b, fg: color },
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
    kind: e.ref ? 'record' : 'mark',
    text: e.ref ? e.label : e.time,
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
      { s: pad(e.time, tW), fg: on ? COLORS.accent : COLORS.dim, b: on },
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
      const ref = `card:${card.id}#${h}/${fmt(r[0])}`
      items.push({ label: `${fmt(r[0])} · ${h}`, value: v, cite: c === 0 ? v : cite(v, ref), open: ref, kind: c === 0 ? 'row' : 'mark', text: v })
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
        { s: cell(fmt(r[c]), c), bg: ri === hr ? COLORS.cursor : undefined, b: ri === hr && c === hc, u: ri === hr && c === hc },
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
  const items: Item[] = exs.map(e => ({ label: e.ref, value: e.note || e.quote.slice(0, 60), cite: `[[${e.ref}]]`, open: e.ref, kind: 'record', text: e.note || e.quote }))
  exs.forEach((e, i) => {
    const on = i === hover
    const color = on ? COLORS.accent : COLORS.series[0]
    lines.push([{ s: '▍ ', fg: color }, ...(e.note ? [{ s: cut(e.note, cols - 4 - width(e.ref) - 2), b: true }, { s: '  ' }] : []), { s: e.ref, fg: on ? COLORS.link : COLORS.dim, u: on }])
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

// ---------------------------------------------------------------------------------------- diagrams

export const MAX_NODES = 40
export const MAX_EDGES = 80
const NODE_LABEL = 24 // characters of a node's label its box shows; the readout has the whole label
const NODE_LABEL_MIN = 12
const EDGE_INLINE = 24 // a longer edge label, or one with no room beside its edge, is a numbered note under the drawing

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
 * A diagram drawn with box-drawing characters, top to bottom, a layer of nodes to a row (layerGraph). A row too wide
 * for the card cuts its labels, then moves nodes to a row of their own. An edge runs from a port on its source's bottom
 * border to its target's top border, where the arrow is (an edge drawn against the layers has its arrow at the top
 * end); an edge across several rows passes each one as a vertical line. Between two rows each edge that bends takes a
 * track of its own. A short edge label is written beside its edge, a long one is a numbered note under the drawing.
 * Items: the nodes in order, then the edges.
 */
function diagramLayout(card: CardData, cols: number, hover: number): Layout {
  const nodes = (card.nodes ?? []).slice(0, MAX_NODES)
  const ids = nodes.map(n => n.id)
  const at = new Map(ids.map((id, i) => [id, i]))
  const edges = (card.edges ?? []).slice(0, MAX_EDGES).filter(e => at.has(e.source) && at.has(e.target) && e.source !== e.target)
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

  // boxes: a row too wide for the card cuts its labels down to NODE_LABEL_MIN characters first
  const labelW = nodes.map(n => Math.max(1, Math.min(width(n.label), NODE_LABEL, cols - 4)))
  const boxW = (i: number) => labelW[i]! + 4
  const GAP = 3
  for (let l = 0; l <= depth(); l++) {
    const row = ids.map((_, i) => i).filter(i => layer.get(ids[i]!) === l)
    if (row.reduce((a, i) => a + boxW(i), 0) + GAP * Math.max(0, row.length - 1) <= cols) continue
    const each = Math.max(NODE_LABEL_MIN, Math.floor((cols - GAP * (row.length - 1)) / row.length) - 4)
    for (const i of row) labelW[i] = Math.min(labelW[i]!, each)
  }

  // entries of each row: nodes and the points where longer edges pass; segments join entries of adjacent rows
  type Entry = { key: string; node: number; edge: number; w: number; x: number }
  type SegT = { edge: number; up: Entry; low: Entry; xa: number; xb: number; track: number }
  const gaps = (r: Entry[]) => r.slice(0, -1).map((en, i) => (en.node < 0 || r[i + 1]!.node < 0 ? 2 : GAP))
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
  // then a row still too wide, with the lines passing it, moves nodes to a row of its own below: nodes with no edge
  // onward first, each taking its box off the row and adding a line for each edge reaching it from above
  let built = build()
  for (let guard = 0; guard < N; guard++) {
    const over = built.rows.findIndex(r => r.filter(en => en.node >= 0).length > 1 && rowWidth(r) > cols)
    if (over < 0) break
    const r = built.rows[over]!
    const onward = (i: number) => edges.some((e, k) => at.get(e.source) === i && built.dirs[k]!.top === i)
    const order = r.filter(en => en.node >= 0).map(en => en.node).sort((a, b) => Number(onward(b)) - Number(onward(a)) || a - b)
    let w = rowWidth(r)
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

  // order each row by the mean position of its neighbours, a few sweeps down and up
  const pos = new Map<string, number>()
  const index = () => rows.forEach(r => r.forEach((en, i) => pos.set(en.key, i)))
  index()
  const mean = (xs: number[], dflt: number) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : dflt)
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let l = 1; l < rows.length; l++) {
      rows[l]!.sort((a, b) => mean((ups.get(a.key) ?? []).map(s => pos.get(s.up.key)!), pos.get(a.key)!) - mean((ups.get(b.key) ?? []).map(s => pos.get(s.up.key)!), pos.get(b.key)!))
      index()
    }
    for (let l = rows.length - 2; l >= 0; l--) {
      rows[l]!.sort((a, b) => mean((lows.get(a.key) ?? []).map(s => pos.get(s.low.key)!), pos.get(a.key)!) - mean((lows.get(b.key) ?? []).map(s => pos.get(s.low.key)!), pos.get(b.key)!))
      index()
    }
  }

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

  // ports: a node's edges leave its bottom border and reach its top border at columns spread about its centre, or
  const spread = (en: Entry, list: SegT[], other: (s: SegT) => Entry, set: (s: SegT, x: number) => void) => {
    const sorted = [...list].sort((a, b) => centre(other(a)) - centre(other(b)))
    if (en.node < 0) {
      for (const s of sorted) set(s, en.x)
      return
    }
    // more than three edges share one port, so they fan out from one track as a bus
    const k = sorted.length
    const step = k > 1 && k <= 3 ? Math.max(0, Math.min(4, Math.floor((en.w - 3) / (k - 1)))) : 0
    const first = Math.round(centre(en) - (step * (k - 1)) / 2)
    sorted.forEach((s, j) => set(s, Math.min(en.x + en.w - 2, Math.max(en.x + 1, first + j * step))))
  }
  for (const r of rows) {
    for (const en of r) {
      spread(en, lows.get(en.key) ?? [], s => s.low, (s, x) => (s.xa = x))
      spread(en, ups.get(en.key) ?? [], s => s.up, (s, x) => (s.xb = x))
    }
  }

  // tracks: a bending segment's horizontal run, on a row of the channel no other unrelated run overlaps; a segment whose
  // top column another's bottom column shares runs above it, so their verticals do not meet
  const related = (a: SegT, b: SegT) => a.edge === b.edge || (a.up === b.up && a.xa === b.xa) || (a.low === b.low && a.xb === b.xb)
  const channels = rows.slice(0, -1).map((_, l) => {
    const mine = segs.filter(s => rowOf.get(s.up.key) === l)
    let left = mine.filter(s => s.xa !== s.xb).sort((a, b) => Math.min(a.xa, a.xb) - Math.min(b.xa, b.xb))
    let tracks = 0
    while (left.length) {
      let free = left.filter(s => !left.some(o => o !== s && o.xa === s.xb && !related(o, s)))
      if (!free.length) free = [left[0]!]
      const on: SegT[] = []
      for (const s of free) {
        const [a0, a1] = [Math.min(s.xa, s.xb), Math.max(s.xa, s.xb)]
        const fits = on.every(o => related(o, s) || a1 < Math.min(o.xa, o.xb) || Math.max(o.xa, o.xb) < a0)
        if (fits) {
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
    y += 3 + (heights[l] ?? 0)
  })
  const H = y
  const Wd = Math.max(1, ...rows.flatMap(r => r.map(en => en.x + en.w)))

  // the grid: each cell's line directions per segment, then boxes and text over them
  type Mark = { seg: number; d: number }
  type CellT = { marks: Mark[]; ch?: string; item: number; kind: 'line' | 'box' | 'label' | 'arrow' | 'text' | '' ; b?: boolean; i?: boolean }
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
    const y0 = top[l]! + 3
    const h = heights[l]!
    if (s.up.node < 0) for (let k = 0; k < 3; k++) mark(s.xa, top[l]! + k, si, U | D)
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
  // boxes
  rows.forEach((r, l) => {
    for (const en of r) {
      if (en.node < 0) continue
      const i = en.node
      const label = cut(nodes[i]!.label, labelW[i]!)
      const inner = en.w - 2
      const lines = ['╭' + '─'.repeat(inner) + '╮', '│ ' + label + ' '.repeat(Math.max(0, inner - 1 - width(label))) + '│', '╰' + '─'.repeat(inner) + '╯']
      lines.forEach((text, k) => {
        let x = en.x
        for (const ch of text) {
          const c = grid[top[l]! + k]?.[x]
          if (c) Object.assign(c, { ch, item: i, kind: k === 1 && x > en.x + 1 && x < en.x + en.w - 2 ? 'text' : 'box', marks: [] })
          x += 1
        }
      })
    }
  })
  // ports and arrows on the borders
  segs.forEach(s => {
    const k = s.edge
    const { rev } = dirs[k]!
    const lu = rowOf.get(s.up.key)!
    if (s.up.node >= 0) {
      const c = grid[top[lu]! + 2]![s.xa]!
      Object.assign(c, rev ? { ch: '▲', kind: 'arrow', item: N + k } : { ch: c.ch === '▲' ? '▲' : '┬', kind: c.ch === '▲' ? 'arrow' : 'box' })
    }
    if (s.low.node >= 0) {
      const c = grid[top[lu + 1]!]![s.xb]!
      Object.assign(c, rev ? { ch: c.ch === '▼' ? '▼' : '┴', kind: c.ch === '▼' ? 'arrow' : 'box' } : { ch: '▼', kind: 'arrow', item: N + k })
    }
  })

  // edge labels: on the edge's horizontal run when it is long enough, else beside its last vertical in the channel's
  // label row, else a numbered note
  const free = (x: number, yy: number) => x >= 0 && x < cols && (grid[yy]?.[x] === undefined || (grid[yy]![x]!.kind === '' && !grid[yy]![x]!.marks.length))
  const write = (x: number, yy: number, text: string, item: number) => {
    let cx = x
    for (const ch of text) {
      while (grid[yy]!.length <= cx) grid[yy]!.push({ marks: [], item: -1, kind: '' })
      Object.assign(grid[yy]![cx]!, { ch, item, kind: 'label', i: true, marks: [] })
      cx += 1
    }
  }
  const notes: { n: number; edge: number }[] = []
  edges.forEach((e, k) => {
    if (!e.label) return
    const s = lastSeg[k]!
    const l = rowOf.get(s.up.key)!
    const y0 = top[l]! + 3
    const text = e.label
    const w = width(text)
    let placed = false
    if (w <= EDGE_INLINE && s.xa !== s.xb && Math.abs(s.xb - s.xa) - 1 >= w + 2) {
      const t = y0 + s.track
      const x = Math.min(s.xa, s.xb) + 1 + Math.floor((Math.abs(s.xb - s.xa) - 1 - (w + 2)) / 2)
      let clear = true
      for (let cx = x; cx < x + w + 2; cx++) clear &&= grid[t]![cx]!.marks.every(m => segs[m.seg]!.edge === k && m.d === (L | R))
      if (clear) {
        write(x, t, ` ${text} `, N + k)
        placed = true
      }
    }
    const row = y0 + heights[l]! - 1
    // a place beside the vertical with a blank cell on each side of the text
    const fits = (x0: number, n: number) => {
      if (x0 < 0 || x0 + n > cols) return false
      for (let cx = x0 - 1; cx <= x0 + n; cx++) if (cx >= 0 && cx < cols && !free(cx, row)) return false
      return true
    }
    const beside = (n: number) => (fits(s.xb + 2, n) ? s.xb + 2 : fits(s.xb - 1 - n, n) ? s.xb - 1 - n : -1)
    if (!placed && w <= EDGE_INLINE) {
      const x = beside(w)
      if (x >= 0) {
        write(x, row, text, N + k)
        placed = true
      }
    }
    if (placed) return
    const n = notes.length + 1
    notes.push({ n, edge: k })
    const x = beside(String(n).length)
    if (x >= 0) write(x, row, String(n), N + k)
  })

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
        seg = { s: ch, fg: on ? COLORS.accent : COLORS.dim, b: on, i: c.kind === 'label' }
      } else seg = { s: ch }
      const prev = line.at(-1)
      if (prev && prev.fg === seg.fg && prev.b === seg.b && prev.i === seg.i) prev.s += seg.s
      else line.push(seg)
    }
    return line
  })
  for (const { n, edge } of notes) {
    const e = edges[edge]!
    const on = edge === hotEdge
    const head = `${n}  ${cut(nodes[at.get(e.source)!]!.label, 28)} → ${cut(nodes[at.get(e.target)!]!.label, 28)}: `
    lines.push([{ s: head, fg: on ? COLORS.accent : COLORS.dim, b: on }, { s: cut(e.label ?? '', Math.max(10, cols - width(head))), i: true, fg: on ? COLORS.accent : undefined }])
    owners.push(new Array<number>(cols).fill(N + edge))
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
