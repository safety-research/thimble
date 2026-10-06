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
/** A label a card's script read (tcard.label): its values, and the value of each record the card names (`marks`, by
 *  ref). `stale`: the label changed after the card was made (register.tsx sets it). */
export type CardLabel = { slug: string; name: string; values: string[]; marks?: Record<string, string>; stale?: boolean }
/** A label card's own label (helper/labels.py): how its records were labeled and how many. */
export type LabelInfo = { slug: string; name: string; kind: string; values: string[]; labeled: number; total: number; trial: boolean; paths?: string[] }
/** An example: its record, its words, and on a label card its value now, why, and whether the analyst set or agreed
 *  with it (`set`; `was` the value the label gave). */
export type CardExample = { ref: string; quote: string; note: string; value?: string; why?: string; set?: boolean; was?: string }
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
  examples?: CardExample[]
  nodes?: DiagramNode[]
  edges?: DiagramEdge[]
  labels?: CardLabel[]
  label?: LabelInfo
}

/** What the mod is doing to a card now: running its script, or why the last run failed. */
export type CardMeta = { busy?: string; error?: string }

/** What a pointer can pick on a card: what the readout says, the citation a click puts in the prompt, the place it
 *  opens, and how it reaches the gestures (`kind` and `text`, the shown value or words, of its Target). */
export type Item = { label: string; value: string; cite: string; open: string; kind: 'mark' | 'row' | 'record' | 'node'; text: string }

/** What a press on a label card's controls does: set an example's value (its own value: agree), show the other values
 *  to pick from, or put them away. */
export type LabelAct = { op: 'verdict'; slug: string; ref: string; value: string } | { op: 'choose'; ref: string } | { op: 'cancel' }
/** A control of a layout: the cells [x0, x1) of its line, a key the hover names it by, and what a press does. */
export type Hot = { line: number; x0: number; x1: number; key: string; act: LabelAct }

export type Layout = { lines: Line[]; items: Item[]; hit: (x: number, y: number) => number; hots?: Hot[] }
/** A label card's state in its Client: the hovered control, the example whose other values show, and a verdict sent
 *  but not yet in the card (`pending`: `<ref>=<value>`). */
export type LabelUi = { act?: string; choose?: string; pending?: string }

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

// a byte of a UTF-8 sequence after its first, as Windows-1252 shows it (helper/refs.py _CONT)
const CP1252: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f }
const CONT = '[\\u0080-\\u00bf\\u0152\\u0153\\u0160\\u0161\\u0178\\u017d\\u017e\\u0192\\u02c6\\u02dc\\u2013\\u2014\\u2018-\\u201a\\u201c-\\u201e\\u2020-\\u2022\\u2026\\u2030\\u2039\\u203a\\u20ac\\u2122]'
const MOJIBAKE = new RegExp(`[\\u00c2-\\u00df]${CONT}|[\\u00e0-\\u00ef]${CONT}{2}|[\\u00f0-\\u00f4]${CONT}{3}`, 'g')

/**
 * Text whose UTF-8 bytes were once read as Windows-1252 or Latin-1 and saved again ("mÃ¶chten"), each such character
 * back as written ("möchten"); a run that is not one UTF-8 character is kept. For display only. helper/refs.py
 * demojibake has the same rule.
 */
export function demojibake(s: string): string {
  if (!/[\u00c2-\u00f4]/.test(s)) return s
  return s.replace(MOJIBAKE, run => {
    const bytes = [...run].map(ch => CP1252[ch.codePointAt(0)!] ?? ch.codePointAt(0)!)
    const lead = bytes[0]!
    const n = bytes.length
    let cp = lead & (n === 2 ? 0x1f : n === 3 ? 0x0f : 0x07)
    for (const b of bytes.slice(1)) {
      if ((b & 0xc0) !== 0x80) return run
      cp = (cp << 6) | (b & 0x3f)
    }
    // an overlong form, a surrogate or past Unicode is not a character UTF-8 writes
    const least = n === 2 ? 0x80 : n === 3 ? 0x800 : 0x10000
    if (cp < least || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return run
    return String.fromCodePoint(cp)
  })
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

export function pad(s: string, n: number, right = false): string {
  const c = cut(s, n)
  const fill = ' '.repeat(Math.max(0, n - width(c)))
  return right ? fill + c : c + fill
}

export function lineWidth(l: Line): number {
  return l.reduce((n, s) => n + width(s.s), 0)
}

/** A legend's entries in as many lines of at most `cols` columns as they need, two spaces between entries on a line;
 *  an entry wider than a line alone has its last segment cut. */
function flow(entries: readonly Line[], cols: number): Line[] {
  const lines: Line[] = []
  let cur: Line = []
  let w = 0
  for (const entry of entries) {
    let e = entry
    let ew = lineWidth(e)
    if (ew > cols && e.length) {
      const last = e.at(-1)!
      e = [...e.slice(0, -1), { ...last, s: cut(last.s, Math.max(1, cols - (ew - width(last.s)))) }]
      ew = lineWidth(e)
    }
    if (cur.length && w + 2 + ew > cols) {
      lines.push(cur)
      cur = []
      w = 0
    }
    if (cur.length) {
      cur.push({ s: '  ' })
      w += 2
    }
    cur.push(...e)
    w += ew
  }
  if (cur.length) lines.push(cur)
  return lines
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
  return shade(lay.lines, spans, COLORS.selected)
}

// ---------------------------------------------------------------------------------------- cards

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

export function bar(v: number, max: number, w: number): string {
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
  return amount(+v.toPrecision(4))
}

/** A number as the mod draws a count: thousands separators from 1,000 on a whole number, else as written. */
export function amount(v: number): string {
  return Number.isInteger(v) && Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : fmt(v)
}

function cite(display: string, ref: string): string {
  return `[[${display}|${ref}]]`
}

export const MAX_BARS = 30
export const MAX_TABLE_ROWS = 15

// ---------------------------------------------------------------------------------------- labels on cards

/** A count with thousands separators, as the label panel writes it. */
export function count(n: number): string {
  return n.toLocaleString('en-US')
}

/** A share as the label panel writes it (harness.tsx pct). */
export function share(a: number, b: number): string {
  if (!b || !a) return '0%'
  const p = (100 * a) / b
  return p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`
}

/** The colour of a label's value, as the label panel draws it: the categorical palette in the label's order, and the
 *  last value of two or more, the one that is not the category, dim. */
export function valueColour(values: readonly string[], value: string): string | undefined {
  const i = values.indexOf(value)
  if (i < 0) return undefined
  return values.length > 1 && i === values.length - 1 ? COLORS.dim : COLORS.series[i % COLORS.series.length]
}

/** The labels a card shows: a label card's own, else those its script read. */
export function cardLabels(card: CardData): CardLabel[] {
  if (card.kind === 'label' && card.label) return [{ slug: card.label.slug, name: card.label.name, values: card.label.values }]
  return card.labels ?? []
}

/** The colour a mark takes from the labels the card read: its record's value (`ref`), else the value its name is. */
function classColour(card: CardData, name?: string, ref?: string): string | undefined {
  for (const l of cardLabels(card)) {
    const v = (ref ? l.marks?.[ref] : undefined) ?? (name !== undefined && l.values.includes(name) ? name : undefined)
    if (v !== undefined) return valueColour(l.values, v)
  }
  return undefined
}

/** A place as the analyst reads it: `revisions.jsonl line 10566`, `lines 3-8`, `row 12`; any other as written. */
export function placeWords(ref: string): string {
  const at = ref.indexOf('#')
  if (at < 0) return ref
  const path = ref.slice(0, at)
  const frag = ref.slice(at + 1)
  const lines = /^L(\d+)(?:-L?(\d+))?$/.exec(frag)
  if (lines) return `${path} ${lines[2] && lines[2] !== lines[1] ? `lines ${lines[1]}-${lines[2]}` : `line ${lines[1]}`}`
  const row = /^row=(\d+)$/.exec(frag)
  if (row) return `${path} row ${row[1]}`
  return ref
}

/** A place in words in `n` columns: its file's path cut, its line or row kept ("revisi… line 10904"). */
export function cutRef(ref: string, n: number): string {
  const words = placeWords(ref)
  if (width(words) <= n) return words
  const frag = / (?:line|lines|row) [\d-]+$/.exec(words)?.[0] ?? ''
  return frag && n - width(frag) >= 4 ? `${cut(words.slice(0, words.length - frag.length), n - width(frag))}${frag}` : cut(words, n)
}

/** What the label line of a label card says after the name, in `n` columns: how its records were labeled, how many,
 *  and of which files; when it is too long the files go first, then how. */
function labelScope(l: LabelInfo, n: number): string {
  const kind = l.kind === 'prompt' ? 'a model read each record' : l.kind === 'regex' ? 'a regex matched each record' : l.kind === 'code' ? 'code decided each record' : l.kind
  const files = (l.paths ?? []).length ? ` of ${(l.paths ?? []).length > 2 ? `${l.paths!.slice(0, 2).join(', ')} +${l.paths!.length - 2}` : l.paths!.join(', ')}` : ''
  const many = l.trial ? `a trial on ${count(l.labeled)} of ${count(l.total)} records` : `all ${count(l.labeled)} records`
  const whole = [kind, `${many}${files}`].filter(Boolean).join(' · ')
  const shorter = [kind, many].filter(Boolean).join(' · ')
  return width(whole) <= n ? whole : width(shorter) <= n ? shorter : cut(many, n)
}

/**
 * The card's label lines, under its question, one per label: "label", the label's name (a press opens it in the
 * panel), then its values each after a dot in its colour; on a label card, how its records were labeled instead, since
 * its bars name the values. `hover`: the slug of the label under the pointer, its name lit.
 */
export function labelHead(card: CardData, cols: number, hover = ''): { lines: Line[]; slugs: string[] } {
  const lines: Line[] = []
  const slugs: string[] = []
  for (const l of cardLabels(card)) {
    const on = l.slug === hover
    const head: Line = [{ s: 'label  ', fg: COLORS.dim }]
    const nameW = Math.max(8, Math.min(width(l.name), Math.floor(cols * 0.55)))
    head.push({ s: cut(l.name, nameW), ...(on ? { inv: true } : {}) })
    let tail: Line
    if (card.kind === 'label' && card.label) tail = [{ s: `  ${labelScope(card.label, Math.max(1, cols - lineWidth(head) - 2))}`, fg: COLORS.dim }]
    else {
      tail = []
      const room = cols - lineWidth(head) - (l.stale ? 16 : 0)
      let w = 0
      l.values.forEach((v, i) => {
        const entry = width(v) + 4
        if (w < 0) return
        const left = l.values.length - i - 1
        if (w + entry + (left ? 4 : 0) > room) {
          tail.push({ s: `  +${l.values.length - i}`, fg: COLORS.dim })
          w = -1
          return
        }
        tail.push({ s: '  ●', fg: valueColour(l.values, v) }, { s: ` ${v}` })
        w += entry
      })
    }
    if (l.stale) tail.push({ s: '  changed since', fg: COLORS.dim })
    const line = [...head, ...tail]
    lines.push(lineWidth(line) > cols ? [...head, { ...tail[0]!, s: cut(tail.map(x => x.s).join(''), Math.max(1, cols - lineWidth(head))) }] : line)
    slugs.push(l.slug)
  }
  return { lines, slugs }
}

function barLayout(card: CardData, cols: number, hover: number): Layout {
  const rows = ((card.rows ?? []) as BarRow[]).slice(0, MAX_BARS)
  const more = (card.rows?.length ?? 0) - rows.length
  const col = card.y || 'value'
  const groups = [...new Set(rows.map(r => r.group).filter(Boolean))]
  // a label card's counts as its panel writes them, each with its share of all
  const own = card.kind === 'label'
  const sum = own ? (card.total ?? rows.reduce((a, r) => a + r.value, 0)) : 0
  // a count reads with thousands separators from 1,000, as everywhere the mod draws one
  const shown = (v: number) => (own || (Number.isInteger(v) && Math.abs(v) >= 1000) ? count(v) : fmt(v))
  const shareW = own ? Math.max(...rows.map(r => share(r.value, sum).length)) + 2 : 0
  const valueW = Math.max(...rows.map(r => shown(r.value).length), 1)
  // 2-cell gutters after the names and before the numbers (rule 3)
  const room = cols - valueW - 4 - shareW
  // the bars keep two fifths of the room; a label longer than the rest takes two lines
  const labelW = Math.min(Math.max(4, ...rows.map(r => width(r.label))), Math.max(8, room - Math.max(12, Math.ceil(room * 0.4))))
  const barW = Math.max(4, room - labelW)
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 0)
  const lines: Line[] = []
  const owner: number[] = []
  const items: Item[] = rows.map(r => ({
    label: r.label,
    value: `${shown(r.value)} ${col}`,
    cite: cite(fmt(r.value), `card:${card.id}#${col}/${r.label}`),
    open: `card:${card.id}#${col}/${r.label}`,
    kind: 'mark',
    text: shown(r.value),
  }))
  rows.forEach((r, i) => {
    const on = i === hover
    // a hue only for a value of the card's colour field (its groups, or a label it read); a mark no colour names is
    // dim (rule 20)
    const color = classColour(card, r.group || r.label) ?? (groups.length ? COLORS.series[Math.max(0, groups.indexOf(r.group)) % COLORS.series.length]! : COLORS.dim)
    const b = bar(r.value, max, barW)
    const [first, second] = fold(r.label, labelW)
    // the label of the mark under the pointer in inverse; a label card's bars are parts of a whole, on a track to it
    const track = own ? '─'.repeat(Math.max(0, barW - width(b))) : ''
    lines.push([
      { s: first!, inv: on },
      { s: ' '.repeat(Math.max(0, labelW - width(first!)) + 2) },
      { s: b, fg: color },
      ...(track ? [{ s: track, fg: COLORS.rule }] : []),
      { s: ' '.repeat(Math.max(2, barW - width(b) - width(track) + 2)) },
      { s: pad(shown(r.value), valueW, true) },
      ...(own ? [{ s: pad(share(r.value, sum), shareW, true), fg: COLORS.dim }] : []),
    ])
    owner.push(i)
    if (second) {
      lines.push([{ s: second, inv: on }])
      owner.push(i)
    }
  })
  if (more > 0) lines.push([{ s: `… ${more} more`, fg: COLORS.dim }])
  if (card.total !== undefined) lines.push([{ s: 'all  ', fg: COLORS.dim }, { s: shown(card.total) }])
  // the legend on its own row under the chart; none when a label it read names the groups on its label row
  const named = new Set(cardLabels(card).flatMap(l => l.values))
  if (groups.length && !groups.every(g => named.has(g))) lines.push(...flow(groups.map((g, j) => [{ s: '● ', fg: classColour(card, g) ?? COLORS.series[j % COLORS.series.length] }, { s: g }]), cols))
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
      items.push({ label: xLabel, value: `${s.name} ${amount(p[1])}`, cite: cite(fmt(p[1]), `card:${card.id}#${s.name}/${xLabel}`), open: `card:${card.id}#${s.name}/${xLabel}`, kind: 'mark', text: amount(p[1]) })
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
  // one series with no label is dim: a hue names a value of the colour field, and a mark no colour names is dim
  const seriesColour = (si: number) => classColour(card, series[si]?.name) ?? (series.length > 1 ? COLORS.series[si % COLORS.series.length]! : COLORS.dim)
  const lines: Line[] = []
  for (let r = 0; r < plotRows; r++) {
    const yl = r === 0 ? labels[0]! : r === plotRows - 1 ? labels[2]! : r === Math.floor((plotRows - 1) / 2) ? labels[1]! : ''
    const row: Line = [{ s: yl.padStart(yW - 1) + ' ', fg: COLORS.dim }, { s: '│', fg: COLORS.rule }]
    for (let c = 0; c < pw; c++) {
      const b = bits[r]![c]!
      const o = owner[r]![c]!
      const isHot = hot && c === hot.cx
      const isPoint = hot && c === hot.cx && r === hot.cy
      // the pointer's column a ┊ in the rule grey, the point under it in inverse
      row.push({
        s: b ? String.fromCodePoint(0x2800 + b) : isHot ? '┊' : ' ',
        fg: b ? seriesColour(Math.max(0, o)) : COLORS.rule,
        ...(isPoint ? { inv: true } : {}),
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
  if (series.length > 1) lines.push(...flow(series.map((s, si) => [{ s: '● ', fg: seriesColour(si) }, { s: s.name }]), cols))
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
  // with a label read, each event's value as a dot in its colour, and an event the label does not mark dim
  const valued = cardLabels(card).length > 0
  if (isTime && evs.length > 1) {
    const t0 = Math.min(...times)
    const t1 = Math.max(...times)
    // the axis takes the card's width from its A0, its end times under its ends
    const aw = Math.max(10, cols)
    const cells = new Array<number>(aw).fill(-1)
    times.forEach((t, i) => {
      const x = t1 === t0 ? 0 : Math.round(((t - t0) / (t1 - t0)) * (aw - 1))
      cells[x] = cells[x] === -1 || i === hover ? i : cells[x]!
    })
    // each event a ● on the axis, in its value's hue when the card read a label, else dim (a mark no colour names);
    // the one under the pointer in inverse
    lines.push(cells.map((c): Seg => (c >= 0 ? { s: '●', fg: classColour(card, evs[c]!.label, evs[c]!.ref) ?? COLORS.dim, ...(c === hover ? { inv: true } : {}) } : { s: '─', fg: COLORS.rule })))
    const a = shown[times.indexOf(t0)]!
    const b = shown[times.indexOf(t1)]!
    lines.push([{ s: `${a}${' '.repeat(Math.max(2, aw - width(a) - width(b)))}${b}`, fg: COLORS.dim }])
    axisRows = 2
  }
  const tW = Math.min(Math.max(...shown.map(t => width(t))), 22)
  const owner: number[] = lines.map(() => -1)
  evs.forEach((e, i) => {
    const on = i === hover
    const label = fold(e.label, Math.max(8, cols - tW - 6))
    // a bare ↗: the event has a record a click opens
    const arrow: Seg[] = e.ref ? [{ s: ' ↗' }] : []
    const dot = valued ? classColour(card, e.label, e.ref) : undefined
    // its value's ● hanging at the left when the card read a label; its time dim, in inverse under the pointer
    const time = pad(shown[i]!, tW, isTime)
    lines.push([
      dot ? { s: '● ', fg: dot } : { s: '  ' },
      on ? { s: time, inv: true } : { s: time, fg: COLORS.dim },
      { s: '  ' },
      { s: label[0]! },
      ...(label.length === 1 ? arrow : []),
    ])
    owner.push(i)
    if (label[1]) {
      lines.push([{ s: ' '.repeat(tW + 4) }, { s: label[1] }, ...arrow])
      owner.push(i)
    }
  })
  return { lines, items, hit: (_x, y) => owner[y] ?? -1 }
}

// ---------------------------------------------------------------------------------------- tables

// columns between a table's columns: two, or one where that saves a cut, a broken word or a block
const GAPS = [2, 1]

/** A piece of a cell, where a table's line may end before it: `sp`, a space comes before it; `r`, how much a break
 *  before it costs the reader: 0 at a space, 1 at a space after a word of symbols alone (so `A + B` breaks as `A` /
 *  `+ B`) or after a hyphen or slash that follows a letter, 2 inside a word, between the parts of a name. */
type Piece = { t: string; sp: boolean; r: number }

const SYMBOLS = /^[^\p{L}\p{N}]+$/u

/** `s` as pieces: its words, and inside a word the parts before a capital that follows a lower-case letter or a digit
 *  that follows two letters, after a hyphen or slash that follows a letter, after an underscore, and after a dot
 *  between letters. A date, a time, a number or a line's ref (#L1234) stays one piece. */
const pieced = new Map<string, Piece[]>()

function pieces(s: string): Piece[] {
  const known = pieced.get(s)
  if (known) return known
  if (pieced.size > 4000) pieced.clear()
  const out: Piece[] = []
  const words = s.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  words.forEach((word, wi) => {
    const ch = [...word]
    let cur = ''
    let r = wi > 0 && SYMBOLS.test(words[wi - 1]!) && !SYMBOLS.test(word) ? 1 : 0
    let sp = wi > 0
    ch.forEach((c, i) => {
      const a = ch[i - 1] ?? ''
      const b = ch[i - 2] ?? ''
      const soft = /\p{L}/u.test(b) && /[-/]/.test(a)
      const hard =
        (/\p{Ll}/u.test(a) && /\p{Lu}/u.test(c)) ||
        (/\p{L}/u.test(b) && /\p{L}/u.test(a) && /\d/.test(c)) ||
        (/\p{L}/u.test(b) && a === '_') ||
        (/\p{L}/u.test(b) && a === '.' && /\p{L}/u.test(c))
      if ((soft || hard) && cur) {
        out.push({ t: cur, sp, r })
        sp = false
        r = soft ? 1 : 2
        cur = ''
      }
      cur += c
    })
    out.push({ t: cur, sp, r })
  })
  pieced.set(s, out)
  return out
}

function joinPieces(ps: readonly Piece[]): string {
  return ps.reduce((a, p, i) => `${a}${i && p.sp ? ' ' : ''}${p.t}`, '')
}

/** Pieces joined where a break would cost more than `most`: the units a line may end between. */
function units(ps: readonly Piece[], most: number): Piece[] {
  const out: Piece[] = []
  for (const p of ps) {
    const last = out.at(-1)
    if (last && p.r > most) out[out.length - 1] = { ...last, t: `${last.t}${p.sp ? ' ' : ''}${p.t}` }
    else out.push({ ...p })
  }
  return out
}

/** Units in lines of `w` columns, as many to a line as fit; from line `max` on, the rest on the last line. The lines and
 *  the most a break among them costs. */
function fill(us: readonly Piece[], w: number, max: number): { lines: string[]; r: number } {
  const lines: string[] = []
  let r = 0
  let cur = us[0]?.t ?? ''
  for (const u of us.slice(1)) {
    const next = `${cur}${u.sp ? ' ' : ''}${u.t}`
    if (width(next) <= w || lines.length >= max - 1) cur = next
    else {
      lines.push(cur)
      cur = u.t
      r = Math.max(r, u.r)
    }
  }
  lines.push(cur)
  return { lines, r }
}

type Wrapped = { lines: string[]; cut: boolean; r: number }

/** `s` in at most `max` lines of `w` columns, broken between words where they fit, else after a hyphen or slash, and
 *  inside a word only where a word alone is wider than `w`; what does not fit is cut on the last line. Two lines that
 *  hold it all are balanced, at the cheapest break. */
export function wrapCell(s: string, w: number, max: number): string[] {
  return wrapped(s, w, max).lines
}

const wraps = new Map<string, Wrapped>()

/** wrapCell's lines, whether any of `s` is cut from them, and the most a break among them costs (`r` of a Piece). */
function wrapped(s: string, w: number, max: number): Wrapped {
  const key = `${w} ${max} ${s}`
  const known = wraps.get(key)
  if (known) return known
  if (wraps.size > 8000) wraps.clear()
  const ps = pieces(s)
  let out: Wrapped | null = null
  for (const most of [0, 1, 2]) {
    const f = fill(units(ps, most), w, max)
    if (f.lines.every(l => width(l) <= w)) {
      out = { lines: f.lines, cut: false, r: f.r }
      break
    }
  }
  if (!out) {
    const f = fill(ps, w, max)
    out = { lines: f.lines.map(l => cut(l, w)), cut: true, r: f.r }
  }
  if (out.lines.length === 2 && !out.cut) {
    let score = Number.POSITIVE_INFINITY
    for (let i = 1; i < ps.length; i++) {
      const a = joinPieces(ps.slice(0, i))
      const b = joinPieces(ps.slice(i))
      const sc = ps[i]!.r * 1000 + Math.max(width(a), width(b))
      if (ps[i]!.r <= out.r && width(a) <= w && width(b) <= w && sc < score) {
        score = sc
        out = { lines: [a, b], cut: false, r: ps[i]!.r }
      }
    }
  }
  wraps.set(key, out)
  return out
}

/** The fewest columns that hold `s` in at most `max` lines with nothing cut and no break costing more than `most`. */
function fitWidth(s: string, max: number, most = 1): number {
  const us = units(pieces(s), most)
  if (!us.length) return 0
  let lo = Math.max(...us.map(u => width(u.t)))
  let hi = Math.max(lo, width(joinPieces(us)))
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (fill(us, mid, max + 1).lines.length <= max) hi = mid
    else lo = mid + 1
  }
  return lo
}

type TableGeometry = { k: number; ws: number[]; packed: number[][]; gap: number }

const geometries = new Map<string, TableGeometry>()

/** Where a table's columns go in `cols` columns (see tableLayout): the first column's width `k`, each column's width,
 *  and the other columns in blocks. Kept by the table's text and width, as a pointer's moves draw it again and again. */
function tableGeometry(heads: readonly string[], cells: readonly string[][], numeric: readonly boolean[], cols: number): TableGeometry {
  const key = JSON.stringify([cols, heads, cells, numeric])
  const known = geometries.get(key)
  if (known) return known
  if (geometries.size > 64) geometries.clear()
  const n = heads.length
  if (!n) return { k: 0, ws: [], packed: [], gap: GAPS[0]! }
  const whole = heads.map((_, c) => Math.max(0, ...cells.map(r => width(r[c]!))))
  const nat = heads.map((h, c) => Math.max(width(h), whole[c]!))
  // the narrowest a column can be with no word broken: its header in three lines, its other cells in two, a number whole
  const floor = heads.map((h, c) => Math.max(fitWidth(h, 3), ...cells.map(r => (numeric[c] ? width(r[c]!) : fitWidth(r[c]!, 2)))))
  const others = heads.map((_, c) => c).slice(1)
  /** Beside a first column k wide, `gap` between columns: the blocks the other columns fill at their narrowest, then
   *  each column's width, widened by what its block has left: text columns towards their whole cells, the smallest
   *  gaps first, then the headers to as few lines as it allows. */
  const geometry = (k: number, gap: number): TableGeometry => {
    const room = cols - k - gap
    const ws = heads.map((_, c) => (c === 0 ? k : Math.max(1, Math.min(floor[c]!, room))))
    const packed: number[][] = []
    let cur: number[] = []
    let used = 0
    for (const c of others) {
      if (cur.length && used + gap + ws[c]! > room) {
        packed.push(cur)
        cur = []
        used = 0
      }
      used += (cur.length ? gap : 0) + ws[c]!
      cur.push(c)
    }
    if (cur.length) packed.push(cur)
    for (const b of packed) {
      let left = room - b.reduce((a, c) => a + ws[c]!, 0) - gap * (b.length - 1)
      for (const c of b.filter(c => !numeric[c]).sort((p, q) => whole[p]! - ws[p]! - (whole[q]! - ws[q]!))) {
        const add = Math.max(0, Math.min(left, whole[c]! - ws[c]!))
        ws[c] = ws[c]! + add
        left -= add
      }
      for (let l = Math.max(1, wrapCell(heads[0]!, k, 3).length); l <= 3; l++) {
        const want = b.map(c => Math.max(0, Math.min(fitWidth(heads[c]!, l), room) - ws[c]!))
        if (want.reduce((a, x) => a + x, 0) > left) continue
        b.forEach((c, i) => (ws[c] = ws[c]! + want[i]!))
        break
      }
      // a header still broken after a hyphen takes what is left to break between words only
      for (const c of b) {
        const need = fitWidth(heads[c]!, 3, 0) - ws[c]!
        if (need > 0 && need <= left && wrapped(heads[c]!, ws[c]!, 3).r > 0) {
          ws[c] = ws[c]! + need
          left -= need
        }
      }
    }
    return { k, ws, packed, gap }
  }
  // what a geometry costs, in this order: the characters its cut cells and headers hide, the words it breaks, its
  // blocks, a narrow gap, the words it breaks after a hyphen or slash, and the lines it takes; null once it hides or
  // breaks more than `bound`
  const cost = (g: TableGeometry, bound: number[]): number[] | null => {
    let hidden = 0
    let broken = 0
    let soft = 0
    let tall = 0
    const blocks = g.packed.length ? g.packed : [[]]
    const see = (s: string, c: number, max: number, count: boolean): number => {
      if (numeric[c] && max === 2) {
        hidden += Math.max(0, width(s) - g.ws[c]!)
        return 1
      }
      const w = wrapped(s, g.ws[c]!, max)
      if (count) {
        if (w.cut) hidden += Math.max(1, width(s) - w.lines.reduce((a, l) => a + width(l) - 1, 0))
        if (w.r > 1) broken += 1
        else if (w.r > 0 && /[-/]/.test(s)) soft += 1
      }
      return w.lines.length
    }
    const over = () => bound.length > 0 && (hidden > bound[0]! || (hidden === bound[0] && broken > bound[1]!))
    for (const [bi, b] of blocks.entries()) {
      const cs = [0, ...b]
      // the first column is the same in every block: what it hides or breaks counts once
      tall += 1 + Math.max(...cs.map(c => see(heads[c]!, c, 3, c > 0 || bi === 0)))
      for (const r of cells) {
        tall += Math.max(...cs.map(c => see(r[c]!, c, 2, c > 0 || bi === 0)))
        if (over()) return null
      }
    }
    return [hidden, broken, blocks.length, g.gap < GAPS[0]! ? 1 : 0, soft, tall]
  }
  const less = (a: number[], b: number[]) => {
    const i = a.findIndex((x, j) => x !== b[j])
    return i >= 0 && a[i]! < b[i]!
  }
  // the first column at each width from the narrowest that cuts nothing to its whole width, with each gap: the geometry
  // that costs least, the widest of those
  const narrowest = Math.max(fitWidth(heads[0]!, 3, 2), ...cells.map(r => (numeric[0] ? width(r[0]!) : fitWidth(r[0]!, 2, 2))))
  const kLo = n > 1 ? Math.max(1, Math.min(narrowest, cols - 2)) : Math.min(nat[0]!, cols)
  const kHi = n > 1 ? Math.max(kLo, Math.min(nat[0]!, cols - 2)) : kLo
  let best: TableGeometry | null = null
  let least: number[] = []
  for (const gap of n > 1 ? GAPS : GAPS.slice(0, 1)) {
    const most = n > 1 ? cols - gap - 1 : cols
    for (let k = Math.min(kHi, most); k >= Math.min(kLo, most); k--) {
      const g = geometry(k, gap)
      const c = cost(g, least)
      if (c && (!best || less(c, least))) {
        best = g
        least = c
      }
    }
  }
  const out = best ?? geometry(kLo, GAPS[0]!)
  geometries.set(key, out)
  return out
}

/**
 * A table in `cols` columns. A word is broken only where it alone is wider than its column: a column is never
 * narrower than its widest number, its header in three lines or its other cells in two, broken between words; the first
 * column, which names the rows, then takes all it can, and the others widen with what is left. Columns that do not fit
 * beside each other go into blocks one under another, each led by the first column, as R prints a wide data frame.
 */
function tableLayout(card: CardData, cols: number, hover: number): Layout {
  const heads = card.columns ?? []
  const n = heads.length
  const all = (card.rows ?? []) as Cell[][]
  const rows = all.slice(0, MAX_TABLE_ROWS)
  const cells = rows.map(r => heads.map((_, c) => fmt(r[c])))
  // a blank cell does not make a column of numbers text
  const numeric = heads.map((_, c) => rows.every(r => typeof r[c] === 'number' || r[c] === null || (typeof r[c] === 'string' && !r[c].trim())))
  const { ws, packed, gap } = tableGeometry(heads, cells, numeric, cols)
  const blocks = n ? (packed.length ? packed : [[]]).map(b => [0, ...b]) : []
  const items: Item[] = []
  rows.forEach(r =>
    heads.forEach((h, c) => {
      const v = fmt(r[c])
      const ref = `card:${card.id}#${h}/${fmt(r[0])}`
      items.push({ label: `${fmt(r[0])} · ${h}`, value: v, cite: c === 0 ? v : cite(v, ref), open: ref, kind: c === 0 ? 'row' : 'mark', text: v })
    }),
  )
  const hr = hover >= 0 ? Math.floor(hover / Math.max(1, n)) : -1
  const hc = hover >= 0 ? hover % Math.max(1, n) : -1
  const lines: Line[] = []
  const owner: number[] = [] // the row a line draws, -1 for none
  const within: number[] = [] // the block a line is in
  const push = (l: Line, ri: number, bi: number) => {
    lines.push(l)
    owner.push(ri)
    within.push(bi)
  }
  const join = (cs: number[], segs: (c: number, i: number) => Seg[]): Line => cs.flatMap((c, i): Seg[] => [...segs(c, i), ...(i < cs.length - 1 ? [{ s: ' '.repeat(gap) }] : [])])
  blocks.forEach((cs, bi) => {
    if (bi) push([], -1, bi)
    // the headers sit on the rule: a shorter one starts lower
    const head = cs.map(c => wrapCell(heads[c]!, ws[c]!, 3))
    const hl = Math.max(...head.map(h => h.length))
    // the column names dim, with no rule under them; the words of the cell under the pointer in inverse
    for (let j = 0; j < hl; j++) push(join(cs, (c, i) => [{ s: pad(head[i]![j - hl + head[i]!.length] ?? '', ws[c]!, numeric[c]), fg: COLORS.dim }]), -1, bi)
    cells.forEach((r, ri) => {
      const p = cs.map(c => (numeric[c] ? [r[c]!] : wrapCell(r[c]!, ws[c]!, 2)))
      for (let j = 0; j < Math.max(...p.map(q => q.length)); j++) {
        push(
          join(cs, (c, i) => {
            const cell = pad(p[i]![j] ?? '', ws[c]!, numeric[c])
            const body = cell.trim()
            if (!(ri === hr && c === hc && body)) return [{ s: cell }]
            const before = cell.indexOf(body)
            return [{ s: cell.slice(0, before) }, { s: body, inv: true }, { s: cell.slice(before + body.length) }].filter(x => x.s)
          }),
          ri,
          bi,
        )
      }
    })
  })
  if (all.length > rows.length) push([{ s: `… ${all.length - rows.length} more`, fg: COLORS.dim }], -1, -1)
  const lefts = blocks.map(cs => {
    const xs: number[] = []
    cs.reduce((x, c) => (xs.push(x), x + ws[c]! + gap), 0)
    return xs
  })
  return {
    lines,
    items,
    hit: (x, y) => {
      const ri = owner[y] ?? -1
      if (ri < 0) return -1
      const cs = blocks[within[y]!]!
      const i = lefts[within[y]!]!.findIndex((x0, j) => x >= x0 && x < x0 + ws[cs[j]!]! + (j < cs.length - 1 ? gap : 0))
      return ri * n + cs[Math.max(0, i)]!
    },
  }
}

/** A record's head: its value's ● hanging at the left (none for a record of no colour field), its words, then `↗` and
 *  its place underlined, a link to the record; the place in inverse while the record is under the pointer. */
function recordHead(glyph: Seg | null, words: Seg[], ref: string, on: boolean, room: number): Line {
  const lead: Seg = glyph ?? { s: '  ' }
  const used = 2 + words.reduce((n, w) => n + width(w.s), 0) + (words.length ? 2 : 0) + 2
  const place = cutRef(ref, Math.max(8, room - used))
  return [lead, ...words, ...(words.length ? [{ s: '  ' }] : []), { s: '↗ ' }, { s: place, u: true, ...(on ? { inv: true } : {}) }]
}

function exampleLayout(card: CardData, cols: number, hover: number): Layout {
  const exs = (card.examples ?? []).slice(0, 8)
  const lines: Line[] = []
  const owner: number[] = []
  const items: Item[] = exs.map(e => ({ label: e.ref, value: e.note || e.quote.slice(0, 60), cite: `[[${e.ref}]]`, open: e.ref, kind: 'record', text: e.note || e.quote }))
  exs.forEach((e, i) => {
    const on = i === hover
    // each record's ● hanging at A0 on its first row, in its value's hue when a label the card read marks it, else dim
    // (a mark no colour names), so the records part without blank rows; its words in italic, its own among the model's
    const colour = classColour(card, e.value, e.ref)
    const glyph: Seg = { s: '● ', fg: colour ?? COLORS.dim }
    const room = Math.max(10, cols - 2)
    // the note on the head's row with the place where it fits, else on rows of its own above it
    const note = e.note ? (width(e.note) + 4 + Math.min(24, width(placeWords(e.ref))) <= room ? [e.note] : fold(e.note, room)) : []
    const beside = note.length === 1 && width(note[0]!) + 4 + Math.min(24, width(placeWords(e.ref))) <= room
    if (beside) lines.push(recordHead(glyph, [{ s: note[0]! }], e.ref, on, cols))
    else {
      note.forEach((t, k) => lines.push([k === 0 && glyph ? glyph : { s: '  ' }, { s: t }]))
      lines.push(recordHead(note.length ? null : glyph, [], e.ref, on, cols))
    }
    for (let k = 0; k < (beside ? 1 : note.length + 1); k++) owner.push(i)
    for (const t of wrapCell(demojibake(e.quote).replace(/\s+/g, ' ').trim(), room, 3).filter(Boolean)) {
      lines.push([{ s: '  ' }, { s: t, i: true }])
      owner.push(i)
    }
  })
  return { lines, items, hit: (_x, y) => owner[y] ?? -1 }
}

// ---------------------------------------------------------------------------------------- label cards

/**
 * A label card (the label tool's, helper/labels.py): its count of each value as bars in the values' colours with each
 * share on a track to the whole, then the records it picked, each with its value's ●, its value, its place, its words
 * and why, and the controls that judge it: "agree" keeps its value as the analyst's, "disagree" sets the other value
 * (or shows the others to pick from). A record the analyst judged says so in place of the controls. Items: the bars,
 * then the records.
 */
function labelLayout(card: CardData, cols: number, hover: number, ui: LabelUi = {}): Layout {
  const l = card.label
  const bars = barLayout(card, cols, hover)
  const nBars = bars.items.length
  const exs = (card.examples ?? []).slice(0, 8)
  if (!l || !exs.length) return bars
  const lines: Line[] = [...bars.lines]
  const owner: number[] = bars.lines.map((_, y) => bars.hit(0, y))
  const hots: Hot[] = []
  const items: Item[] = [...bars.items, ...exs.map((e): Item => ({ label: e.ref, value: e.value ?? '', cite: `[[${e.ref}]]`, open: e.ref, kind: 'record', text: e.quote }))]
  const room = Math.max(10, cols - 2)
  const pending = ui.pending ? ui.pending.split('=') : null
  const push = (line: Line, own: number) => {
    lines.push(line)
    owner.push(own)
  }
  /** A record's head line with, at its end, its controls (each a hot region, two cells apart) or what the analyst
   *  did; where they do not fit beside it, the head alone, its place cut, and they on a line of their own under it. */
  const withControls = (line: Line, ctrls: { s: string; key: string; act: LabelAct }[], own: number): void => {
    const w = ctrls.reduce((a, c) => a + width(c.s), 0) + 2 * Math.max(0, ctrls.length - 1)
    const fit = (l: Line, n: number): Line => {
      const over = lineWidth(l) - n
      if (over <= 0) return l
      // the place is the last segment: cut it, not the value, keeping its line
      const last = l.at(-1)!
      return [...l.slice(0, -1), { ...last, s: cutRef(last.s, Math.max(4, width(last.s) - over)) }]
    }
    // beside the head when the place keeps a dozen cells, else under it
    const beside = lineWidth(line) - width(line.at(-1)!.s) + Math.min(12, width(line.at(-1)!.s)) + 2 + w <= cols
    const head = beside ? fit(line, cols - w - 2) : fit(line, cols)
    let x = beside ? cols - w : 2
    const out: Line = beside ? [...head, { s: ' '.repeat(x - lineWidth(head)) }] : [{ s: '  ' }]
    if (!beside) push(head, own)
    ctrls.forEach((c, k) => {
      if (k) {
        out.push({ s: '  ' })
        x += 2
      }
      // a control in the text colour, in inverse under the pointer; what the analyst did, dim
      const on = Boolean(c.key) && ui.act === c.key
      out.push(c.key ? { s: c.s, ...(on ? { inv: true } : {}) } : { s: c.s, fg: COLORS.dim })
      if (c.key) hots.push({ line: lines.length, x0: x, x1: x + width(c.s), key: c.key, act: c.act })
      x += width(c.s)
    })
    push(out, own)
  }
  push([], -1)
  exs.forEach((e, i) => {
    const k = nBars + i
    const on = k === hover
    const value = e.value ?? ''
    const others = l.values.filter(v => v !== value)
    const head = recordHead({ s: '● ', fg: valueColour(l.values, value) ?? COLORS.dim }, [{ s: value }], e.ref, on, cols * 4)
    const waiting = pending && pending[0] === e.ref
    if (waiting) withControls(head, [{ s: '◌ saving', key: '', act: { op: 'cancel' } }], k)
    else if (e.set) withControls(head, [{ s: e.was && e.was !== value ? '✓ set by you' : '✓ agreed', key: '', act: { op: 'cancel' } }], k)
    else if (ui.choose === e.ref) withControls(head, [{ s: 'cancel', key: `cancel:${e.ref}`, act: { op: 'cancel' } }], k)
    else
      withControls(
        head,
        [
          { s: 'agree', key: `agree:${e.ref}`, act: { op: 'verdict', slug: l.slug, ref: e.ref, value } },
          { s: 'disagree', key: `disagree:${e.ref}`, act: others.length === 1 ? { op: 'verdict', slug: l.slug, ref: e.ref, value: others[0]! } : { op: 'choose', ref: e.ref } },
        ],
        k,
      )
    // the other values to pick from, after "it is"
    if (ui.choose === e.ref && !e.set && !waiting) {
      const line: Line = [{ s: '  it is', fg: COLORS.dim }]
      let x = lineWidth(line)
      for (const v of others) {
        const s = `● ${v}`
        if (x + 2 + width(s) > cols) {
          push(line.splice(0), k)
          line.push({ s: '   ' })
          x = 3
        } else {
          line.push({ s: '  ' })
          x += 2
        }
        const key = `set:${e.ref}=${v}`
        const lit = ui.act === key
        line.push({ s: '● ', fg: valueColour(l.values, v) ?? COLORS.dim }, { s: v, ...(lit ? { inv: true } : {}) })
        hots.push({ line: lines.length, x0: x, x1: x + width(s), key, act: { op: 'verdict', slug: l.slug, ref: e.ref, value: v } })
        x += width(s)
      }
      push(line, k)
    }
    // its words in italic in up to three lines, then why the label gave its value; no blank row between records
    const words = demojibake(e.quote).replace(/\s+/g, ' ').trim()
    const wrapped = words ? wrapCell(words, room, 3) : []
    wrapped.forEach(t => push([{ s: '  ' }, { s: t, i: true }], k))
    if (e.why && !(e.set && e.was && e.was !== value)) push([{ s: `  why  ${cut(e.why.replace(/\s+/g, ' ').trim(), room - 5)}`, fg: COLORS.dim }], k)
  })
  return { lines, items, hots, hit: (_x, y) => owner[y] ?? -1 }
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

  // the grid as lines: boxes, lines and arrows in the rule grey, node text in the text colour, edge labels and note
  // numbers dim; the node or edge under the pointer has its words in inverse
  const hotNode = hover >= 0 && hover < N ? hover : -1
  const hotEdge = hover >= N ? hover - N : -1
  const owners: number[][] = grid.map(r => r.map(c => c.item))
  const lines: Line[] = grid.map(r => {
    const line: Line = []
    for (const c of r) {
      const ch = c.ch ?? ' '
      let seg: Seg
      if (c.kind === 'text') seg = c.item === hotNode && ch !== ' ' ? { s: ch, inv: true } : { s: ch }
      else if (c.kind === 'box' || c.kind === 'line' || c.kind === 'arrow') seg = { s: ch, fg: COLORS.rule }
      else if (c.kind === 'label') seg = c.item - N === hotEdge && hotEdge >= 0 && ch !== ' ' ? { s: ch, inv: true } : { s: ch, fg: COLORS.dim }
      else seg = { s: ch }
      const prev = line.at(-1)
      if (prev && prev.fg === seg.fg && !prev.inv === !seg.inv) prev.s += seg.s
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
    const style = { fg: COLORS.dim }
    const text: Omit<Seg, 's'> = on ? { inv: true } : { fg: COLORS.dim }
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

export function cardLayout(card: CardData, cols: number, hover: number, plotRows?: number, ui?: LabelUi): Layout {
  switch (card.kind) {
    case 'bar':
      return barLayout(card, cols, hover)
    case 'label':
      return labelLayout(card, cols, hover, ui)
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
