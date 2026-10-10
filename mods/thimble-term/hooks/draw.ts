// Layouts as styled lines, shared by the surface modules (the interactive chips and cards) and the hooks module (the
// static drawing where no Client runs). Each layout takes the width it may use and the item under the pointer, and
// returns its lines and a hit test from a cell to an item. The `note` and `text` kinds (noteLayout, textLayout) are the
// cards drawn as their words.
import { axisTicks, numberTicks, ownTicks, placeLabels, wallClock } from './axis'
import { cut, cw, fmt, formatted, quoted, width } from './lib'
import type { Run, TableRuns } from './lib'
import { COLORS } from './paint'
import { hueOf } from './labels'

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
export type CardLabel = { slug: string; name: string; values: string[]; marks?: Record<string, string>; stale?: boolean; colors?: Record<string, number> }
/** A label card's own label (cell.ts labelCard, from `thimble state label`): how its records were labeled and how many. */
export type LabelInfo = { slug: string; name: string; kind: string; values: string[]; labeled: number; total: number; trial: boolean; paths?: string[]; colors?: Record<string, number> }
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
  /** a line card's x axis's own ticks, as its x values are written (Vega-Lite's `axis.values`: thimble.chart's at each
   *  time of weekly or monthly data), which the axis names in place of round ones */
  xTicks?: (string | number)[]
  events?: { time: string; label: string; ref: string; shown?: string }[]
  examples?: CardExample[]
  nodes?: DiagramNode[]
  edges?: DiagramEdge[]
  labels?: CardLabel[]
  label?: LabelInfo
  /** a table's number formats by column (the frame's `view.formats`, backend frames.py) */
  formats?: Record<string, string>
}

/** What the mod is doing to a card now: running its script, or why the last run failed. */
export type CardMeta = { busy?: string; error?: string }

/** What a pointer can pick on a card: what the readout says, the citation a click puts in the prompt, the place it
 *  opens, and how it reaches the gestures (`kind` and `text`, the shown value or words, of its Target). */
export type Item = { label: string; value: string; cite: string; open: string; kind: 'mark' | 'row' | 'record' | 'node'; text: string }

export type Layout = { lines: Line[]; items: Item[]; hit: (x: number, y: number) => number }

/** The first palette hue: the marks of a chart with no colour field, which is one series (SPEC.md, "The visual
 *  system", rule 12). */
export const ONE = COLORS.series[0]!

// ---------------------------------------------------------------------------------------- text width

// the cells a character takes, a string's width and the one cut of thimble-term (lib.ts)
export { cut, cw, width }

// a byte of a UTF-8 sequence after its first, as Windows-1252 shows it
const CP1252: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f }
const CONT = '[\\u0080-\\u00bf\\u0152\\u0153\\u0160\\u0161\\u0178\\u017d\\u017e\\u0192\\u02c6\\u02dc\\u2013\\u2014\\u2018-\\u201a\\u201c-\\u201e\\u2020-\\u2022\\u2026\\u2030\\u2039\\u203a\\u20ac\\u2122]'
const MOJIBAKE = new RegExp(`[\\u00c2-\\u00df]${CONT}|[\\u00e0-\\u00ef]${CONT}{2}|[\\u00f0-\\u00f4]${CONT}{3}`, 'g')

/**
 * Text whose UTF-8 bytes were once read as Windows-1252 or Latin-1 and saved again ("mÃ¶chten"), each such character
 * back as written ("möchten"); a run that is not one UTF-8 character is kept. For display only.
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

/** `s` in at most `max` lines of `n` columns, each broken at the last space that fits (a word wider than a line broken
 *  where the line ends); the last line cut with `…` when words are left. */
export function wrapRows(s: string, n: number, max: number): string[] {
  if (max <= 1) return [cut(s.replace(/\s+/g, ' ').trim(), n)]
  const words = s.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (let i = 0; i < words.length; i++) {
    let word = words[i]!
    const next = cur ? `${cur} ${word}` : word
    if (width(next) <= n) {
      cur = next
      continue
    }
    if (cur) {
      lines.push(cur)
      cur = ''
    }
    // a word wider than a line: its cells up to the line's end, the rest on the next
    while (width(word) > n && lines.length < max - 1) {
      let k = 0
      let w = 0
      for (const ch of word) {
        if (w + cw(ch) > n) break
        w += cw(ch)
        k += ch.length
      }
      lines.push(word.slice(0, k))
      word = word.slice(k)
    }
    cur = word
    if (lines.length >= max - 1) {
      // the last line takes the rest
      cur = [cur, ...words.slice(i + 1)].join(' ')
      break
    }
  }
  if (cur) lines.push(lines.length >= max - 1 ? cut(cur, n) : cur)
  return lines.slice(0, max)
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

// ---------------------------------------------------------------------------------------- cards

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

export function bar(v: number, max: number, w: number): string {
  if (max <= 0 || w <= 0) return ''
  const n8 = Math.max(v !== 0 ? 1 : 0, Math.round((Math.abs(v) / max) * w * 8))
  return '█'.repeat(Math.floor(n8 / 8)) + EIGHTHS[n8 % 8]!
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

/** A share in whole percent, so shares side by side read alike (`7%` beside `93%`): one decimal under 1%, `<0.1%` below
 *  that, and `>99%` for a part that rounds to the whole. */
export function share(a: number, b: number): string {
  if (!b || !a) return '0%'
  const p = (100 * a) / b
  if (p < 0.1) return '<0.1%'
  if (p < 1) return `${p.toFixed(1)}%`
  const r = Math.round(p)
  return r >= 100 && a < b ? '>99%' : `${r}%`
}

/** The shares of parts of a whole, each in whole percent as `share` writes it, those of 1% or more rounded so they add
 *  up to 100% when the parts make the whole (largest remainders; live check term-fix9, low quirk: a label card showed
 *  38% and 63%). */
export function shares(parts: readonly number[], total: number): string[] {
  const out = parts.map(a => share(a, total))
  if (!total || parts.reduce((a, b) => a + b, 0) !== total) return out
  // only parts all written in whole percent: a share under 1% or over 99% keeps its own words (`0.4%`, `>99%`)
  const ps = parts.map(a => (100 * a) / total)
  if (ps.some(p => p > 0 && (p < 1 || p >= 99.5))) return out
  const r = ps.map(p => Math.floor(p))
  const order = ps.map((p, i) => ({ i, rest: p - Math.floor(p) })).filter(x => x.rest > 0).sort((a, b) => b.rest - a.rest)
  for (let k = 0, left = 100 - r.reduce((a, b) => a + b, 0); k < order.length && left > 0; k++, left--) r[order[k]!.i]!++
  return ps.map((p, i) => (p > 0 ? `${r[i]}%` : out[i]!))
}

/** The color of a label's value, as the label panel draws it: the color its class has (`colors`, labels.ts hueOf: the
 *  browser's label colors, the analyst's choice among them, 0 dim), else the categorical palette in the label's order,
 *  and the last value of two or more, the one that is not the category, dim. */
export function valueColour(values: readonly string[], value: string, colors?: Record<string, number>): string | undefined {
  const i = values.indexOf(value)
  if (i < 0) return undefined
  if (colors && typeof colors[value] === 'number') return hueOf(colors[value]!)
  return values.length > 1 && i === values.length - 1 ? COLORS.dim : COLORS.series[i % COLORS.series.length]
}

/** The labels a card shows: a label card's own, else those its script read. */
export function cardLabels(card: CardData): CardLabel[] {
  if (card.kind === 'label' && card.label) return [{ slug: card.label.slug, name: card.label.name, values: card.label.values, ...(card.label.colors ? { colors: card.label.colors } : {}) }]
  return card.labels ?? []
}

/** The colour a mark takes from the labels the card read: its record's value (`ref`), else the value its name is. */
function classColour(card: CardData, name?: string, ref?: string): string | undefined {
  for (const l of cardLabels(card)) {
    const v = (ref ? l.marks?.[ref] : undefined) ?? (name !== undefined && l.values.includes(name) ? name : undefined)
    if (v !== undefined) return valueColour(l.values, v, l.colors)
  }
  return undefined
}

/** A place as the analyst reads it: `revisions.jsonl line 10566`, `lines 3-8`, `row 12`, `results.json item 4`, `the
 *  command's output line 3`; never `#L` or a command's id. A card's place is named by its question by the caller. */
export function placeWords(ref: string): string {
  const call = /^call:[A-Za-z0-9_-]+(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(ref)
  if (call) return `the command's output${call[1] ? ` ${call[2] && call[2] !== call[1] ? `lines ${call[1]}-${call[2]}` : `line ${call[1]}`}` : ''}`
  const at = ref.indexOf('#')
  if (at < 0) return ref
  const path = ref.slice(0, at)
  const frag = ref.slice(at + 1)
  // a line, a range of lines, or a passage of a line (`L2.b0:c0-120`, a block of a JSON line and its characters), which
  // reads as its line
  const lines = /^L(\d+)(?:-L?(\d+)|\.b\d+(?::c\d+-\d+)?)?$/.exec(frag)
  if (lines) return `${path} ${lines[2] && lines[2] !== lines[1] ? `lines ${lines[1]}-${lines[2]}` : `line ${lines[1]}`}`
  const row = /^row=(\d+)$/.exec(frag)
  if (row) return `${path} row ${row[1]}`
  // a JSON list's item, counted from 1 as the file's view counts them
  const item = /^\/(?:[^/]+\/)?(\d+)$/.exec(frag)
  if (item && !path.startsWith('card:')) return `${path} item ${Number(item[1]) + 1}`
  return ref
}

/** A place in words in `n` columns: its file's path cut, its line or row kept ("revisi… line 10904"). */
export function cutRef(ref: string, n: number): string {
  const words = placeWords(ref)
  if (width(words) <= n) return words
  const frag = / (?:line|lines|row) [\d-]+$/.exec(words)?.[0] ?? ''
  return frag && n - width(frag) >= 4 ? `${cut(words.slice(0, words.length - frag.length), n - width(frag))}${frag}` : cut(words, n)
}

/**
 * The card's label rows, under its title, one per label: "label" dim, the label's name in blue and underlined, then a
 * blue ↗ (a press on either opens the label in the panel), then its values each after a ● in its hue. A label card's
 * row stops after the ↗, since its bars name the values. `hover`: the slug of the label under the pointer, its name and
 * ↗ in inverse. `hots`: where each row's name and ↗ stand, the cells a press opens the label from.
 */
export function labelHead(card: CardData, cols: number, hover = ''): { lines: Line[]; slugs: string[]; hots: { x0: number; x1: number }[] } {
  const lines: Line[] = []
  const slugs: string[] = []
  const hots: { x0: number; x1: number }[] = []
  for (const l of cardLabels(card)) {
    const on = l.slug === hover
    const head: Line = [{ s: 'label  ', fg: COLORS.dim }]
    const nameW = Math.max(8, Math.min(width(l.name), Math.floor(cols * 0.55)))
    const x0 = lineWidth(head)
    head.push({ s: cut(l.name, nameW), fg: COLORS.link, u: true, ...(on ? { inv: true } : {}) }, { s: ' ' }, { s: '↗', fg: COLORS.link, ...(on ? { inv: true } : {}) })
    hots.push({ x0, x1: lineWidth(head) })
    const tail: Line = []
    if (!(card.kind === 'label' && card.label)) {
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
        tail.push({ s: '  ' }, { s: '●', fg: valueColour(l.values, v, l.colors) }, { s: ` ${v}` })
        w += entry
      })
    }
    if (l.stale) tail.push({ s: '  changed since', fg: COLORS.dim })
    const line = [...head, ...tail]
    lines.push(lineWidth(line) > cols && tail.length ? [...head, { s: cut(tail.map(x => x.s).join(''), Math.max(1, cols - lineWidth(head))), fg: COLORS.dim }] : line)
    slugs.push(l.slug)
  }
  return { lines, slugs, hots }
}

/** The bars a bar card draws: every row of its first MAX_BARS labels, in the order the rows come (cell.ts sortedBars),
 *  and how many labels are left out. A label's rows of several groups (the chart's colour field) stand on the label's
 *  one row, stacked, as the browser stacks them. The layout's items are these rows, in this order. */
export function barRows(card: CardData): { rows: BarRow[]; more: number } {
  const all = (card.rows ?? []) as BarRow[]
  const labels = [...new Set(all.map(r => r.label))]
  const keep = new Set(labels.slice(0, MAX_BARS))
  return { rows: all.filter(r => keep.has(r.label)), more: labels.length - keep.size }
}

/** A bar's label as the browser's axis draws it: timestamps all in one form (`May 24`, the time only when one is not
 *  midnight, shortTimes); any other label as written. */
function barNames(labels: readonly string[]): string[] {
  return labels.length && labels.every(l => STAMP.test(l.trim())) ? shortTimes(labels) : [...labels]
}

function barLayout(card: CardData, cols: number, hover: number): Layout {
  const { rows, more } = barRows(card)
  const col = card.y || 'value'
  const groups = [...new Set(rows.map(r => r.group).filter(Boolean))]
  // one row per label, the label's rows (one per group) stacked on it in the data's order
  const labels = [...new Set(rows.map(r => r.label))]
  const ofLabel = new Map<string, number[]>()
  rows.forEach((r, i) => ofLabel.set(r.label, [...(ofLabel.get(r.label) ?? []), i]))
  const names = barNames(labels)
  const nameOf = new Map(labels.map((l, j) => [l, names[j]!]))
  const totals = labels.map(l => ofLabel.get(l)!.reduce((a, i) => a + rows[i]!.value, 0))
  // a label card's counts as its panel writes them, each with its share of all
  const own = card.kind === 'label'
  const sum = own ? (card.total ?? rows.reduce((a, r) => a + r.value, 0)) : 0
  // a count reads with thousands separators from 1,000, as everywhere the mod draws one
  const shown = (v: number) => (own || (Number.isInteger(v) && Math.abs(v) >= 1000) ? count(v) : fmt(v))
  const parts = own ? shares(totals, sum) : []
  const shareW = own ? Math.max(...parts.map(x => x.length)) + 2 : 0
  const valueW = Math.max(...totals.map(t => shown(t).length), 1)
  // 2-cell gutters after the names and before the numbers (rule 3)
  const room = cols - valueW - 4 - shareW
  // the bars keep two fifths of the room; a label longer than the rest takes two lines
  const labelW = Math.min(Math.max(4, ...names.map(n => width(n))), Math.max(8, room - Math.max(12, Math.ceil(room * 0.4))))
  const barW = Math.max(4, room - labelW)
  const max = Math.max(...totals.map(t => Math.abs(t)), 0)
  const lines: Line[] = []
  const owner: number[] = []
  // where each label's bars stand on its row: [x0, x1) per row of the data, from the content's edge
  const spans: { x0: number; x1: number; i: number }[][] = []
  const items: Item[] = rows.map(r => {
    // a stacked bar's readout names its group too (`May 24 · page saved`)
    const name = nameOf.get(r.label) ?? r.label
    const group = groups.length > 1 && r.group && r.group !== r.label ? ` · ${r.group}` : ''
    return {
      label: `${name}${group}`,
      value: `${shown(r.value)} ${col}`,
      cite: cite(fmt(r.value), `card:${card.id}#${col}/${r.label}`),
      open: `card:${card.id}#${col}/${r.label}`,
      kind: 'mark',
      text: shown(r.value),
    }
  })
  labels.forEach((l, j) => {
    const ids = ofLabel.get(l)!
    const on = ids.includes(hover)
    // a hue for a value of the card's colour field (its groups, or a label it read); with no colour field the bars are
    // one series, in the first hue (rule 20); the bar under the pointer turns the text colour
    const hueOf = (r: BarRow) => classColour(card, r.group || r.label) ?? (groups.length ? COLORS.series[Math.max(0, groups.indexOf(r.group)) % COLORS.series.length]! : ONE)
    const segs: Seg[] = []
    const mine: { x0: number; x1: number; i: number }[] = []
    let x = labelW + 2
    if (ids.length === 1) {
      const b = bar(rows[ids[0]!]!.value, max, barW)
      segs.push({ s: b, fg: on ? COLORS.text : hueOf(rows[ids[0]!]!) })
      mine.push({ x0: x, x1: x + width(b), i: ids[0]! })
    } else {
      // stacked: each group's part in whole cells, the last in eighths, so the bar is as long as its total's
      let cells = 0
      ids.forEach((i, k) => {
        const v = Math.abs(rows[i]!.value)
        let s: string
        if (k < ids.length - 1) {
          const n = max > 0 ? Math.max(v ? 1 : 0, Math.round((v / max) * barW)) : 0
          s = '█'.repeat(n)
          cells += n
        } else {
          const n8 = max > 0 ? Math.max(cells * 8 + (v ? 1 : 0), Math.round((Math.abs(totals[j]!) / max) * barW * 8)) - cells * 8 : 0
          s = '█'.repeat(Math.floor(n8 / 8)) + EIGHTHS[n8 % 8]!
        }
        if (!s) return
        segs.push({ s, fg: i === hover ? COLORS.text : hueOf(rows[i]!) })
        mine.push({ x0: x, x1: x + width(s), i })
        x += width(s)
      })
    }
    const b = segs.map(g => g.s).join('')
    const [first, second] = fold(names[j]!, labelW)
    // the label of the mark under the pointer in inverse; a label card's bars are parts of a whole, on a track to it
    const track = own ? '─'.repeat(Math.max(0, barW - width(b))) : ''
    lines.push([
      { s: first!, inv: on },
      { s: ' '.repeat(Math.max(0, labelW - width(first!)) + 2) },
      ...segs,
      ...(track ? [{ s: track, fg: COLORS.rule }] : []),
      { s: ' '.repeat(Math.max(2, barW - width(b) - width(track) + 2)) },
      { s: pad(shown(totals[j]!), valueW, true) },
      ...(own ? [{ s: pad(parts[j]!, shareW, true), fg: COLORS.dim }] : []),
    ])
    owner.push(j)
    spans.push(mine)
    if (second) {
      lines.push([{ s: second, inv: on }])
      owner.push(j)
    }
  })
  if (more > 0) lines.push([{ s: `… ${more} more`, fg: COLORS.dim }])
  if (card.total !== undefined) lines.push([{ s: 'all  ', fg: COLORS.dim }, { s: shown(card.total) }])
  // a label card's state while no run of it ended: `◌ labeling 3,000 of 4,579`, `stopped at 3,150 of 4,579`
  if (own && card.note) lines.push(card.note.startsWith('◌') ? [{ s: card.note }] : [{ s: card.note, fg: COLORS.dim }])
  // the legend on its own row under the chart; none when a label it read names the groups on its label row
  const named = new Set(cardLabels(card).flatMap(l => l.values))
  if (groups.length && !groups.every(g => named.has(g))) lines.push(...flow(groups.map((g, j) => [{ s: '● ', fg: classColour(card, g) ?? COLORS.series[j % COLORS.series.length] }, { s: g }]), cols))
  // a row's one bar is the row's mark; on a stacked row the part under the pointer, the nearest part off the bar
  const hit = (x: number, y: number): number => {
    const j = owner[y]
    if (j === undefined) return -1
    const mine = spans[j]!
    if (mine.length <= 1) return mine[0]?.i ?? ofLabel.get(labels[j]!)![0]!
    const inside = mine.find(m => x >= m.x0 && x < m.x1)
    if (inside) return inside.i
    return x < mine[0]!.x0 ? mine[0]!.i : mine.at(-1)!.i
  }
  return { lines, items, hit }
}

const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

// a time as its wall clock (axis.ts wallClock), so the ticks fall on the hours the data writes
function xNumber(v: string | number, kind: 'num' | 'time' | 'cat', i: number): number {
  if (kind === 'num') return Number(v)
  if (kind === 'time') return wallClock(String(v))
  return i
}

function lineLayout(card: CardData, cols: number, hover: number, plotRows = 10): Layout {
  const series = (card.series ?? []).filter(s => s.points.length > 0)
  const all = series.flatMap(s => s.points)
  const xs = all.map(p => p[0])
  const kind: 'num' | 'time' | 'cat' = xs.every(x => typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))))
    ? 'num'
    : xs.every(x => typeof x === 'string' && !Number.isNaN(wallClock(x)))
      ? 'time'
      : 'cat'
  // categorical x: one position per distinct value, in first-seen order
  const cats = kind === 'cat' ? [...new Set(xs.map(String))] : []
  const xOf = (p: [string | number, number], i: number) => (kind === 'cat' ? cats.indexOf(String(p[0])) : xNumber(p[0], kind, i))
  // an x as the axis and the readout name it: times as a bar's labels read (barNames), any other x as written; a
  // citation keeps the x as the card's rows hold it
  const stamps = kind === 'time' ? [...new Set(xs.map(String))] : []
  const names = barNames(stamps)
  const named = new Map(stamps.map((t, i) => [t, names[i]!]))
  const xName = (x: string | number) => named.get(String(x)) ?? String(x)
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
  const H = plotRows * 4
  const py = (y: number) => Math.round(((y1 - y) / (y1 - y0)) * (H - 1))
  // the y ticks at round steps, whole for whole data (axis.ts), each on the row its value's points are drawn on, with a
  // blank row between two
  const yTicks = new Map<number, string>()
  const whole = yv.every(v => Number.isInteger(v))
  for (let count = Math.max(2, Math.floor(plotRows / 3)); count >= 1 && !yTicks.size; count--) {
    const t = numberTicks(y0, y1, count, whole)
    const rows = t.at.map(v => py(v) >> 2)
    if (rows.every((r, i) => i === 0 || Math.abs(r - rows[i - 1]!) >= 2)) rows.forEach((r, i) => yTicks.set(r, t.labels[i]!))
  }
  const yW = Math.max(1, ...[...yTicks.values()].map(l => width(l))) + 1
  const pw = Math.max(10, cols - yW - 1)
  const W = pw * 2
  const bits: number[][] = Array.from({ length: plotRows }, () => new Array<number>(pw).fill(0))
  const owner: number[][] = Array.from({ length: plotRows }, () => new Array<number>(pw).fill(-1))
  const px = (x: number) => (x1 === x0 ? Math.floor(W / 2) : Math.round(((x - x0) / (x1 - x0)) * (W - 1)))
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
      items.push({ label: xName(p[0]), value: `${s.name} ${amount(p[1])}`, cite: cite(fmt(p[1]), `card:${card.id}#${s.name}/${xLabel}`), open: `card:${card.id}#${s.name}/${xLabel}`, kind: 'mark', text: amount(p[1]) })
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
  // a chart with no colour field is one series, in the first hue (rule 12); with several, each its hue
  const seriesColour = (si: number) => classColour(card, series[si]?.name) ?? (series.length > 1 ? COLORS.series[si % COLORS.series.length]! : ONE)
  const lines: Line[] = []
  for (let r = 0; r < plotRows; r++) {
    const yl = yTicks.get(r)
    const row: Line = [{ s: pad(yl ?? '', yW - 1, true) + ' ', fg: COLORS.dim }, { s: yl === undefined ? '│' : '┤', fg: COLORS.rule }]
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
  // the x labels, dim, each under a ┬ on the axis: numbers and times at the axis's own values, else at round steps
  // (axis.ts), as many as fit with 2 cells between; one x alone named under its point; categories at the ends and the
  // middle
  const ticks: { cell: number; x: number; label: string }[] = []
  if (kind !== 'cat' && x1 > x0) {
    const cellOf = (v: number) => px(v) >> 1
    const own = ownTicks(kind, (card.xTicks ?? []).map((v, i) => xNumber(v, kind, i)), x0, x1, pw, cellOf)
    const t = own.at.length ? own : axisTicks(kind, x0, x1, pw, cellOf, kind === 'num' && xv.every(v => Number.isInteger(v)))
    t.at.forEach((_, i) => ticks.push({ cell: t.cells[i]!, x: t.x[i]!, label: t.labels[i]! }))
  } else if (kind !== 'cat' && all.length) {
    const label = xName(all[0]![0])
    const at = placeLabels([px(x0) >> 1], [label], pw)
    if (at) ticks.push({ cell: px(x0) >> 1, x: at[0]!, label })
  }
  const rule = new Array<string>(pw).fill('─')
  for (const t of ticks) rule[t.cell] = '┬'
  lines.push([{ s: ' '.repeat(yW) + '└' + rule.join(''), fg: COLORS.rule }])
  let xl = ''
  if (kind === 'cat') {
    const first = cats[0] ?? ''
    const last = cats.at(-1) ?? ''
    const xsAt = series.flatMap(s => s.points.map((p, i) => ({ label: xName(p[0]), x: px(xOf(p, i)) >> 1 })))
    const mid = xsAt.reduce<{ label: string; x: number } | null>((m, q) => (!m || Math.abs(q.x - pw / 2) < Math.abs(m.x - pw / 2) ? q : m), null)
    xl = first.length + last.length + 2 <= pw ? first + ' '.repeat(pw - first.length - last.length) + last : first
    if (mid && mid.label !== first && mid.label !== last && xl.length === pw) {
      const m0 = Math.round(pw / 2 - width(mid.label) / 2)
      if (m0 >= width(first) + 2 && m0 + width(mid.label) + 2 <= pw - width(last)) xl = xl.slice(0, m0) + mid.label + xl.slice(m0 + mid.label.length)
    }
  } else for (const t of ticks) xl += ' '.repeat(Math.max(0, t.x - width(xl))) + t.label
  lines.push([{ s: ' '.repeat(yW + 1) + xl, fg: COLORS.dim }])
  if (series.length > 1) lines.push(...flow(series.map((s, si) => [{ s: '● ', fg: seriesColour(si) }, { s: s.name }]), cols))
  return { lines, items, hit: (x, y) => nearest(x, y) }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?$/

/**
 * Timestamps as a timeline shows them, all in one form: "Jun 18 21:26", the year only when the events span more than
 * one, the time only when one is not midnight, seconds only when two events share a minute. The clock reads as written
 * (no time zone conversion). Times that are not all ISO dates are kept as they are.
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
    const day = `${MONTHS[Number(p[2]) - 1] ?? p[2]} ${Number(p[3])}${years.size > 1 ? `, ${p[1]}` : ''}`
    if (!clock) return day
    return `${day} ${p[4] ?? '00'}:${p[5] ?? '00'}${secs ? `:${p[6] ?? '00'}` : ''}`
  })
}

/**
 * Times of a transcript's turns as its time column shows them: the clock alone (`07:40:01`; seconds only when a time
 * has them), and the day (`Jun 18, 2026`) on each turn where it changes, which the column shows on a row of its own. Times
 * that are not all ISO stamps stay as written, with no day. An empty time stays empty.
 */
export function turnTimes(times: readonly string[]): { clock: string; day: string }[] {
  const parts = times.map(t => (t.trim() ? STAMP.exec(t.trim()) : null))
  if (times.some((t, i) => t.trim() && !parts[i]) || !parts.some(Boolean)) return times.map(t => ({ clock: t, day: '' }))
  const secs = parts.some(p => p && (p[6] ?? '00') !== '00')
  let last = ''
  return parts.map(p => {
    if (!p) return { clock: '', day: '' }
    const key = `${p[1]}-${p[2]}-${p[3]}`
    const day = key === last ? '' : `${MONTHS[Number(p[2]) - 1] ?? p[2]} ${Number(p[3])}, ${p[1]}`
    last = key
    const clock = p[4] === undefined ? '' : `${p[4]}:${p[5] ?? '00'}${secs ? `:${p[6] ?? '00'}` : ''}`
    return { clock, day }
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
  // with a label read, each event's value as a dot in its colour, and an event the label does not mark dim; with none,
  // every event's dot in the first hue
  const valued = cardLabels(card).length > 0
  const mark = (e: { label: string; ref: string }) => classColour(card, e.label, e.ref) ?? (valued ? COLORS.dim : ONE)
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
    // each event a ● on the axis, in the first hue, or in its value's hue when the card read a label (dim for an event
    // the label does not mark); the one under the pointer in inverse
    lines.push(cells.map((c): Seg => (c >= 0 ? { s: '●', fg: mark(evs[c]!), ...(c === hover ? { inv: true } : {}) } : { s: '─', fg: COLORS.rule })))
    const a = shown[times.indexOf(t0)]!
    const b = shown[times.indexOf(t1)]!
    // the axis's two ends named under them, both or neither: the list right under the axis already names them when its
    // first row is the start and its last the end
    if (!(times[0] === t0 && times[times.length - 1] === t1)) {
      lines.push([{ s: `${a}${' '.repeat(Math.max(2, aw - width(a) - width(b)))}${b}`, fg: COLORS.dim }])
      axisRows = 2
    } else axisRows = 1
  }
  // one row per event: its time dim at the content's edge, under the axis's start time (in inverse under the
  // pointer), its ● in hue, its words, and a blue ↗ when it has a record a click opens
  const tW = Math.min(Math.max(...shown.map(t => width(t))), 22)
  const owner: number[] = lines.map(() => -1)
  evs.forEach((e, i) => {
    const on = i === hover
    const label = fold(e.label, Math.max(8, cols - tW - 6))
    const arrow: Seg[] = e.ref ? [{ s: ' ' }, { s: '↗', fg: COLORS.link }] : []
    const time = pad(shown[i]!, tW)
    lines.push([on ? { s: time, inv: true } : { s: time, fg: COLORS.dim }, { s: '  ' }, { s: '●', fg: mark(e) }, { s: ' ' }, { s: label[0]! }, ...(label.length === 1 ? arrow : [])])
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

/** A padded cell as a table's header draws it: its words bold, the spaces around them plain. */
export function boldCell(cell: string): Seg[] {
  const body = cell.trim()
  if (!body) return [{ s: cell }]
  const at = cell.indexOf(body)
  return [{ s: cell.slice(0, at) }, { s: body, b: true }, { s: cell.slice(at + body.length) }].filter(x => x.s)
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
  // each number in its column's format, as the browser's table writes it (FrameTable's cellText): `1,446`
  const text = (v: Cell, h: string): string => (typeof v === 'number' ? formatted(v, card.formats?.[h]) ?? fmt(v) : fmt(v))
  const cells = rows.map(r => heads.map((h, c) => text(r[c] ?? null, h)))
  // a blank cell does not make a column of numbers text
  const numeric = heads.map((_, c) => rows.every(r => typeof r[c] === 'number' || r[c] === null || (typeof r[c] === 'string' && !r[c].trim())))
  const { ws, packed, gap } = tableGeometry(heads, cells, numeric, cols)
  const blocks = n ? (packed.length ? packed : [[]]).map(b => [0, ...b]) : []
  const items: Item[] = []
  rows.forEach(r =>
    heads.forEach((h, c) => {
      // the value as the card shows it; the row named by its label unformatted, as the backend names it in a ref
      const v = text(r[c] ?? null, h)
      const ref = `card:${card.id}#${h}/${fmt(r[0])}`
      items.push({ label: `${text(r[0] ?? null, heads[0] ?? '')} · ${h}`, value: v, cite: c === 0 ? v : cite(v, ref), open: ref, kind: c === 0 ? 'row' : 'mark', text: v })
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
    // the column names bold, a rule in the rule grey under each as wide as its column, the rows right under it; the
    // words of the cell under the pointer in inverse
    for (let j = 0; j < hl; j++) push(join(cs, (c, i) => boldCell(pad(head[i]![j - hl + head[i]!.length] ?? '', ws[c]!, numeric[c]))), -1, bi)
    push(join(cs, c => [{ s: '─'.repeat(ws[c]!), fg: COLORS.rule }]), -1, bi)
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

/** A record's place as a link: a blue ↗, then its place in words, blue and underlined, in inverse while the record is
 *  under the pointer. */
function placeLink(ref: string, n: number, on: boolean): Seg[] {
  return [{ s: '↗', fg: COLORS.link }, { s: ' ' }, { s: cutRef(ref, Math.max(4, n - 2)), fg: COLORS.link, u: true, ...(on ? { inv: true } : {}) }]
}

/** A record's own words in quotation marks, in at most `max` rows of `room` columns; words that do not fit end in
 *  `…"`. */
function quoteLines(words: string, room: number, max: number): string[] {
  // in quotation marks of a kind the words do not hold (lib.ts quoted)
  const q = quoted(words)
  const close = q === words ? '' : q.at(-1)!
  const lines = wrapCell(q, room, max).filter(Boolean)
  const last = lines.at(-1)
  if (last && last.endsWith('…')) {
    // cut at a word, as every cut, with room for the `…` and the closing mark after it
    const t = last.slice(0, -1).trimEnd()
    const kept = width(t) + 1 + close.length <= room ? t : cut(t, room - close.length).slice(0, -1)
    lines[lines.length - 1] = `${kept.replace(/[\s,;:.!?]+$/, '')}…${close}`
  }
  return lines
}

/**
 * Example records: per record, a ● at the content's edge (in its value's hue when a label the card read marks it, dim
 * when it marks it not, else the first hue) and thimble's note after it, regular; under the note, 2 cells in, the
 * record's words in quotation marks and italic, up to three rows, then ↗ and its place in blue and underlined, on the
 * quote's last row where it fits, else on the row under it. A blank row between records.
 */
function exampleLayout(card: CardData, cols: number, hover: number): Layout {
  const exs = (card.examples ?? []).slice(0, 8)
  const lines: Line[] = []
  const owner: number[] = []
  const items: Item[] = exs.map(e => ({ label: placeWords(e.ref), value: e.note || e.quote.slice(0, 60), cite: `[[${e.ref}]]`, open: e.ref, kind: 'record', text: e.note || e.quote }))
  const valued = cardLabels(card).length > 0
  const room = Math.max(10, cols - 2)
  exs.forEach((e, i) => {
    const on = i === hover
    if (i) {
      lines.push([])
      owner.push(-1)
    }
    const glyph: Seg = { s: '● ', fg: classColour(card, e.value, e.ref) ?? (valued ? COLORS.dim : ONE) }
    const rows: Line[] = []
    const lead = () => (rows.length ? { s: '  ' } : glyph)
    const note = e.note ? wrapCell(e.note.replace(/\s+/g, ' ').trim(), room, 3).filter(Boolean) : []
    for (const t of note) rows.push([lead(), { s: t }])
    const words = demojibake(e.quote).replace(/\s+/g, ' ').trim()
    const quote = words ? quoteLines(words, room, 3) : []
    for (const t of quote) rows.push([lead(), { s: t, i: true }])
    // the place after the quote's last row (or the note's, with no quote) when it fits there with a gutter
    const last = rows.at(-1)
    const want = 2 + width(placeWords(e.ref))
    if (last && lineWidth(last) + 2 + want <= cols) last.push({ s: '  ' }, ...placeLink(e.ref, cols - lineWidth(last) - 2, on))
    else rows.push([lead(), ...placeLink(e.ref, room, on)])
    for (const r of rows) {
      lines.push(r)
      owner.push(i)
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
  // ports and arrows on the borders: ↓ where an edge reaches its target's top, ↑ where one drawn against the layers
  // reaches its target's bottom (SPEC.md, "The visual system", section 5: ▼ ▲ name a table's sorted column)
  segs.forEach(s => {
    const k = s.edge
    const { rev } = dirs[k]!
    const lu = rowOf.get(s.up.key)!
    if (s.up.node >= 0) {
      const c = grid[top[lu]! + bh[lu]! - 1]![s.xa]!
      Object.assign(c, rev ? { ch: '↑', kind: 'arrow', item: N + k } : { ch: c.ch === '↑' ? '↑' : '┬', kind: c.ch === '↑' ? 'arrow' : 'box' })
    }
    if (s.low.node >= 0) {
      const c = grid[top[lu + 1]!]![s.xb]!
      Object.assign(c, rev ? { ch: c.ch === '↓' ? '↓' : '┴', kind: c.ch === '↓' ? 'arrow' : 'box' } : { ch: '↓', kind: 'arrow', item: N + k })
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
        value: [n.detail, n.ref ? placeWords(n.ref) : ''].filter(Boolean).join(' · '),
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

// thimble-term: a card drawn as its words. `note` is prose (a note card, a custom card's text), wrapped to the card's
// width (SPEC.md rule 7: no measure); `text` is a card's printed output or a listing, its lines as written and cut
// at the card's width, the first MAX_TEXT_ROWS of them.
export const MAX_TEXT_ROWS = 24

function noteLayout(card: CardData, cols: number): Layout {
  const w = Math.max(10, cols)
  const lines: Line[] = []
  for (const para of card.note.split('\n')) {
    if (!para.trim()) {
      if (lines.length && lines.at(-1)!.length) lines.push([])
      continue
    }
    for (const t of wrapCell(para.replace(/\s+/g, ' ').trim(), w, 999)) lines.push([{ s: t }])
  }
  while (lines.length && !lines.at(-1)!.length) lines.pop()
  return { lines, items: [], hit: () => -1 }
}

function textLayout(card: CardData, cols: number): Layout {
  const all = card.note.replace(/\s+$/, '').split('\n')
  const lines: Line[] = all.slice(0, MAX_TEXT_ROWS).map(t => [{ s: cut(t.replace(/\t/g, '  '), Math.max(4, cols)) }])
  if (all.length > MAX_TEXT_ROWS) lines.push([{ s: `… ${all.length - MAX_TEXT_ROWS} more lines`, fg: COLORS.dim }])
  return { lines, items: [], hit: () => -1 }
}

export function cardLayout(card: CardData, cols: number, hover: number, plotRows?: number): Layout {
  switch (card.kind) {
    case 'note':
      return noteLayout(card, cols)
    case 'text':
      return textLayout(card, cols)
    case 'bar':
      return barLayout(card, cols, hover)
    case 'label':
      // a label card is a bar card of its label's counts; its records live in the label panel; a label with no run says
      // so, dim after the not-started glyph, as home draws it
      if (!(card.rows ?? []).length && card.note) return { lines: [card.note.startsWith('◌') ? [{ s: card.note }] : [{ s: '○ ', fg: COLORS.dim }, { s: card.note, fg: COLORS.dim }]], items: [], hit: () => -1 }
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
