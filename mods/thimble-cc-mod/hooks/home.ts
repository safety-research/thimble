// The home panel (/thimble-home, and the breadcrumb's first step): one panel listing what this folder's sessions made,
// as thimble's workbench lists them in its tabs: views (built, building, proposed), reports, side threads (those with
// answers not yet read first), cards grouped by the question they answered, labels with their counts, and the files
// with what this session read of them. Each is a click away from the panel that opens it. The sections stacked, each
// with its first items and "… N more"; the header offers a compact index instead, every section in two columns, a
// section's full list opening under it.
//
// This file lays the panel out as styled lines and their hit regions, without `$`; register.tsx gathers the data
// (homeData), draws the lines in the Client homeview.tsx and acts on a click. It follows the visual system
// (views/SPEC.md, section 7, "Home"): a heading at A0, its name regular and its count dim, a blank row above it; an
// item's state glyph at A0 and its name at A2, regular (bold only while it is new: a thread's unread answer), its
// category in the panel's shared column and its number against the right edge, its secondary text dim at A2; a
// question's cards at A4, their kind as a word in the category column.
import type { Line, Seg } from './draw'
import { cut, lineWidth, valueColour, width } from './draw'
import { COLORS } from './paint'

export type SectionId = 'views' | 'reports' | 'threads' | 'cards' | 'labels' | 'files'
export type HomeLayoutName = 'stacked' | 'index'
export const HOME_LAYOUTS: readonly HomeLayoutName[] = ['stacked', 'index']

/** What a click opens: an item in its own panel, or a section's full list in the panel that lists it. */
export type HomeOpen =
  | { kind: 'view'; slug: string; built: boolean }
  | { kind: 'report'; slug: string }
  | { kind: 'thread'; id: string }
  | { kind: 'card'; id: string }
  | { kind: 'label'; name: string }
  | { kind: 'file'; path: string }
  | { kind: 'pane'; view: 'views' | 'reports' | 'threads' | 'labels' | 'coverage'; title: string }

export type HomeAct = { op: 'open'; open: HomeOpen } | { op: 'layout'; layout: HomeLayoutName } | { op: 'fold'; sec: SectionId } | { op: 'more'; sec: SectionId } | { op: 'pick'; sec: SectionId | '' }

/** What the analyst chose: the layout, the stacked sections folded and shown whole, the section the index opens. */
export type HomeUi = { layout: HomeLayoutName; folded: string[]; more: string[]; pick: string }

// ------------------------------------------------------------------------------------------------ the data

export type HomeView = { slug: string; name: string; state: string; words: string; files: string[]; unit: string; drawable: boolean; left: number; at: number }
export type HomeReport = { slug: string; title: string; form: string; state: string; cards: number; tools: number; at: number }
export type HomeThread = { id: string; title: string; about: string; words: string; tone: string; unread: number; earlier: boolean; at: number }
export type HomeCard = { id: string; kind: string; question: string }
/** Cards by the question they answered: an answer's prompt, a side thread's question, a report's title, or none. */
export type HomeCardGroup = { head: string; from: 'answer' | 'thread' | 'report' | 'other'; cards: HomeCard[]; at: number }
export type HomeLabel = { slug: string; name: string; kind: string; trial: boolean; counts: Record<string, number>; values: string[]; paths: string[]; running: boolean }
export type HomeFile = { file: string; records: number | null; size: number; seen: number; state: 'read' | 'scanned' | 'untouched'; ranges: number[][] }
export type HomeData = {
  views: HomeView[]
  reports: HomeReport[]
  threads: HomeThread[]
  cardGroups: HomeCardGroup[]
  labels: HomeLabel[]
  files: HomeFile[]
  coverage: string
}

/** The cards of answers, threads and reports, each under the first question that made it (`groups` in the order the
 *  questions were asked), then the cards no question names. A group whose cards all stand under an earlier one is
 *  left out. Newest first. */
export function groupCards(groups: readonly HomeCardGroup[], all: readonly HomeCard[]): HomeCardGroup[] {
  const placed = new Set<string>()
  const out: HomeCardGroup[] = []
  for (const g of [...groups].sort((a, b) => a.at - b.at)) {
    const cards = g.cards.filter(c => !placed.has(c.id))
    for (const c of cards) placed.add(c.id)
    if (cards.length) out.push({ ...g, cards })
  }
  const rest = all.filter(c => !placed.has(c.id))
  const sorted = out.reverse()
  if (rest.length) sorted.push({ head: 'cards no answer shows', from: 'other', cards: rest, at: 0 })
  return sorted
}

// ------------------------------------------------------------------------------------------------ the rows

type Glyph = { mark: string; fg?: string; d?: boolean }

/** One item: its state glyph, its title (bold while `fresh`: new since the analyst last opened it), its category (in the
 *  panel's shared column), its figure at the right (a number in the text colour, `dimRight` for words), a stacked bar
 *  before the figure, its secondary line, the shorter figure the index shows, and what a click on it does. A question
 *  of the cards has where it was asked as its category and holds its cards (`kids`). */
export type HomeRow = { key: string; glyph: Glyph | null; title: string; fresh?: boolean; cat?: string; right?: string; dimRight?: boolean; bar?: { n: number; fg: string }[]; meta?: Seg[]; short?: string; kids?: HomeRow[]; act: HomeAct }

/** A section: its heading's name and count, `news` in bold after them (a count of what is new), `unit` the name of the
 *  number column at the right, the items the stacked layout shows before "… N more" when not STACK_FIRST's. `summary`
 *  and `brief` say in words what the glyphs show (for the tests and the thread a section is asked about). */
export type HomeSection = { id: SectionId; name: string; count: number; news?: string; unit?: string; summary: Seg[]; brief?: Seg[]; rows: HomeRow[]; pane?: HomeOpen; first?: number }

// state glyphs (views/SPEC.md, "The visual system", section 5): done ● and working ◌ in the text colour, not started ○
// dim, a problem × or ! in red
const DONE: Glyph = { mark: '●' }
const WORKING: Glyph = { mark: '◌' }
const NOT_STARTED: Glyph = { mark: '○', d: true }

export function num(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`
}

const dim = (s: string): Seg => ({ s, fg: COLORS.dim })
const sep = (): Seg => dim(' · ')

/** Words parted by a dim dot, each its own colour when given. */
function joined(parts: (Seg | string | null | undefined | false)[]): Seg[] {
  const out: Seg[] = []
  for (const p of parts) {
    if (!p) continue
    if (out.length) out.push(sep())
    out.push(typeof p === 'string' ? dim(p) : p)
  }
  return out
}

const ACTIVE_VIEW = new Set(['building', 'checking', 'reviewing', 'revising'])

function viewGlyph(v: HomeView): Glyph {
  if (v.state === 'failed') return { mark: '×', fg: COLORS.problem }
  if (v.left) return { mark: '!', fg: COLORS.problem }
  if (ACTIVE_VIEW.has(v.state)) return WORKING
  if (v.state === 'built' || (v.state === 'stopped' && v.drawable)) return DONE
  return NOT_STARTED
}

/** A view's state words where its glyph already says what they would: without "built", "proposed" or "failed". */
function afterMark(words: string): string {
  return words.replace(/^(built|proposed)(\s·\s|$)/, '').replace(/^failed:\s*/, '')
}

/** A view's state in a word or two, for the index and the section's count. */
function viewWord(v: HomeView): string {
  if (v.state === 'failed') return 'failed'
  if (v.state === 'built' || (v.state === 'stopped' && v.drawable)) return 'built'
  if (ACTIVE_VIEW.has(v.state)) return v.drawable ? 'built · in review' : 'building'
  return 'proposed'
}

function countBy(words: readonly string[], order: readonly string[]): string[] {
  const by = new Map<string, number>()
  for (const w of words) by.set(w, (by.get(w) ?? 0) + 1)
  return order.filter(w => by.has(w)).map(w => `${by.get(w)} ${w}`)
}

function viewsSection(vs: readonly HomeView[]): HomeSection {
  const sorted = [...vs].sort((a, b) => b.at - a.at)
  const words = sorted.map(v => viewWord(v).replace(' · in review', ''))
  return {
    id: 'views',
    name: 'Views',
    count: vs.length,
    summary: joined(countBy(words, ['built', 'building', 'proposed', 'failed'])),
    pane: { kind: 'pane', view: 'views', title: 'Views' },
    rows: sorted.map(v => ({
      key: `view:${v.slug}`,
      glyph: viewGlyph(v),
      title: v.name,
      right: afterMark(v.words),
      dimRight: true,
      // in the index, only what the glyph does not say
      short: ACTIVE_VIEW.has(v.state) && v.drawable ? 'in review' : '',
      meta: joined([v.files.join(', '), v.unit]),
      act: { op: 'open', open: { kind: 'view', slug: v.slug, built: v.drawable } },
    })),
  }
}

function reportsSection(rs: readonly HomeReport[]): HomeSection {
  const sorted = [...rs].sort((a, b) => b.at - a.at)
  const word = (r: HomeReport) => (r.state === 'writing' ? 'writing' : r.state === 'error' ? 'failed' : 'written')
  return {
    id: 'reports',
    name: 'Reports',
    count: rs.length,
    summary: joined(countBy(sorted.map(word), ['written', 'writing', 'failed'])),
    pane: { kind: 'pane', view: 'reports', title: 'Reports' },
    rows: sorted.map(r => ({
      key: `report:${r.slug}`,
      glyph: r.state === 'writing' ? WORKING : r.state === 'error' ? { mark: '×', fg: COLORS.problem } : DONE,
      title: r.title,
      cat: r.form,
      short: r.state === 'writing' ? 'writing' : r.form,
      // what the glyph does not say (◌ writing, × failed, ● written): its tool calls while writing, its cards
      meta: joined([r.state === 'writing' ? plural(r.tools, 'tool call') : '', r.cards ? plural(r.cards, 'card') : '']),
      act: { op: 'open', open: { kind: 'report', slug: r.slug } },
    })),
  }
}

function threadsSection(ts: readonly HomeThread[]): HomeSection {
  // the threads with answers not yet read first, then the newest
  const sorted = [...ts].sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.at - a.at)
  const fresh = ts.filter(t => t.unread).length
  const running = ts.filter(t => t.tone === 'run').length
  return {
    id: 'threads',
    name: 'Side threads',
    count: ts.length,
    // every thread with new answers shows, however many
    first: Math.max(STACK_FIRST.threads, fresh),
    ...(fresh ? { news: `${num(fresh)} new` } : {}),
    summary: joined([fresh ? `${fresh} with new answers` : '', running ? `${running} answering` : '', ts.some(t => t.earlier) ? `${ts.filter(t => t.earlier).length} from earlier sessions` : '']),
    pane: { kind: 'pane', view: 'threads', title: 'Side threads' },
    rows: sorted.map(t => ({
      key: `thread:${t.id}`,
      glyph: t.tone === 'run' ? WORKING : t.tone === 'problem' ? { mark: '×', fg: COLORS.problem } : t.tone === 'ok' || t.unread ? DONE : NOT_STARTED,
      title: t.title,
      // an answer not yet read: its name bold, until the thread is opened
      fresh: t.unread > 0,
      short: t.tone === 'run' ? 'answering' : '',
      meta: joined([t.words, t.about, t.earlier ? 'earlier session' : '']),
      act: { op: 'open', open: { kind: 'thread', id: t.id } },
    })),
  }
}

// where a question was asked, in the category column
const FROM_TAG: Record<HomeCardGroup['from'], string> = { answer: 'main', thread: 'thread', report: 'report', other: '' }

function cardsSection(groups: readonly HomeCardGroup[]): HomeSection {
  const n = groups.reduce((k, g) => k + g.cards.length, 0)
  const by = (from: HomeCardGroup['from']) => groups.filter(g => g.from === from).reduce((k, g) => k + g.cards.length, 0)
  return {
    id: 'cards',
    name: 'Cards',
    count: n,
    summary: joined([by('answer') ? `${num(by('answer'))} in main` : '', by('thread') ? `${num(by('thread'))} in side threads` : '', by('report') ? `${num(by('report'))} in reports` : '']),
    brief: joined([groups.length ? `from ${plural(groups.filter(g => g.from !== 'other').length, 'question')}` : '']),
    rows: groups.map((g, i) => {
      // a card's kind as a word in the category column: card kinds have no glyphs
      const kids: HomeRow[] = g.cards.map(c => ({
        key: `card:${c.id}`,
        glyph: null,
        title: c.question,
        cat: c.kind,
        act: { op: 'open', open: { kind: 'card', id: c.id } },
      }))
      const first = g.cards[0]
      return {
        key: `cards:${i}`,
        glyph: null,
        cat: FROM_TAG[g.from],
        title: g.head,
        right: plural(g.cards.length, 'card'),
        short: plural(g.cards.length, 'card'),
        kids,
        act: g.cards.length === 1 && first ? { op: 'open', open: { kind: 'card', id: first.id } } : { op: 'pick', sec: 'cards' },
      }
    }),
  }
}

const BAR_W = 12

/** A label's counts as a bar of BAR_W cells, each value in its colour as the label panel draws it (draw.ts valueColour). */
function countBar(values: readonly string[], counts: Record<string, number>): { n: number; fg: string }[] {
  const total = values.reduce((k, v) => k + (counts[v] ?? 0), 0)
  if (!total) return []
  const cells = values.map(v => ((counts[v] ?? 0) * BAR_W) / total)
  const out = cells.map(c => Math.floor(c))
  // the cells left go to the largest remainders, so the bar is BAR_W wide
  const order = cells.map((c, i) => ({ i, r: c - Math.floor(c) })).sort((a, b) => b.r - a.r)
  for (let k = 0, left = BAR_W - out.reduce((a, b) => a + b, 0); k < left; k++) out[order[k % order.length]!.i]!++
  return values.map((v, i) => ({ n: out[i]!, fg: valueColour(values, v)! })).filter(x => x.n > 0)
}

function labelsSection(ls: readonly HomeLabel[]): HomeSection {
  return {
    id: 'labels',
    name: 'Labels',
    count: ls.length,
    summary: joined(countBy(ls.map(l => (l.running ? 'running' : l.trial ? 'trial' : 'on every record')), ['on every record', 'trial', 'running'])),
    pane: { kind: 'pane', view: 'labels', title: 'Labels' },
    rows: ls.map(l => {
      const labeled = l.values.reduce((k, v) => k + (l.counts[v] ?? 0), 0)
      // a legend: each value's ● in its hue, its word dim as the rest of the secondary row, its count dim
      const legend: Seg[] = []
      l.values.forEach((v, i) => {
        if (i) legend.push(dim('  '))
        legend.push({ s: '● ', fg: valueColour(l.values, v) }, dim(`${v} ${num(l.counts[v] ?? 0)}`))
      })
      return {
        key: `label:${l.slug}`,
        glyph: l.running ? WORKING : DONE,
        title: l.name,
        bar: countBar(l.values, l.counts),
        right: num(labeled),
        short: `${l.trial ? 'trial · ' : ''}${num(labeled)}`,
        meta: [...joined([l.kind, l.trial ? 'trial' : '', l.paths.join(', ')]), dim('  '), ...legend],
        act: { op: 'open', open: { kind: 'label', name: l.name } },
      }
    }),
  }
}

function filesSection(fs: readonly HomeFile[], coverage: string): HomeSection {
  const order = { untouched: 0, scanned: 1, read: 2 } as const
  const sorted = [...fs].sort((a, b) => order[a.state] - order[b.state] || b.size - a.size)
  return {
    id: 'files',
    name: 'Files',
    count: fs.length,
    unit: 'records',
    summary: joined([coverage || 'nothing read yet']),
    brief: joined([fs.length ? `${num(fs.filter(f => f.state === 'read').length)} of ${num(fs.length)} read` : '']),
    pane: { kind: 'pane', view: 'coverage', title: 'Coverage' },
    rows: sorted.map(f => {
      const total = f.records ?? 0
      const share = f.state === 'read' && total ? f.seen / total : 0
      const pct = share >= 0.1 ? `${Math.round(share * 100)}%` : share > 0 ? (share >= 0.001 ? `${(share * 100).toFixed(1)}%` : '<0.1%') : ''
      // a file never opened is a state (○), not a warning
      const what: Seg = f.state === 'untouched' ? dim('never opened') : f.state === 'scanned' ? dim('counted by code, no record read') : dim(`${num(f.seen)} read${pct ? ` (${pct})` : ''}${f.ranges.length ? ` · lines ${rangeText(f.ranges)}` : ''}`)
      return {
        key: `file:${f.file}`,
        glyph: f.state === 'read' ? DONE : NOT_STARTED,
        title: f.file,
        right: f.records !== null ? num(f.records) : `${num(f.size)} B`,
        short: f.state === 'untouched' ? 'never opened' : f.state === 'scanned' ? 'counted' : pct || 'read',
        meta: [what],
        act: { op: 'open', open: { kind: 'file', path: f.file } },
      }
    }),
  }
}

function rangeText(ranges: readonly number[][], n = 3): string {
  const shown = ranges.slice(0, n).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
  return `${shown.join(', ')}${ranges.length > n ? ` and ${ranges.length - n} more` : ''}`
}

/** Every section, in the order of thimble's workbench: what it built, what it wrote, what it asked, then its parts. */
export function homeSections(d: HomeData): HomeSection[] {
  return [viewsSection(d.views), reportsSection(d.reports), threadsSection(d.threads), cardsSection(d.cardGroups), labelsSection(d.labels), filesSection(d.files, d.coverage)]
}

// ------------------------------------------------------------------------------------------------ the layout

/** A region a click acts on: its line, its cells, and whether the pointer lights its row (else it is underlined). */
export type HomeHit = { y: number; x0: number; x1: number; row: boolean; act: HomeAct }
export type HomeLayout = { lines: Line[]; hits: HomeHit[] }

/** The first items a stacked section shows before "… N more" (the cards: questions). */
const STACK_FIRST: Record<SectionId, number> = { views: 3, reports: 3, threads: 3, cards: 3, labels: 3, files: 4 }
/** The items a section shows in the index. */
const INDEX_FIRST = 4
const GAP = 2

class Lines {
  lines: Line[] = []
  hits: HomeHit[] = []
  push(l: Line, hit?: Omit<HomeHit, 'y'>): void {
    if (hit) this.hits.push({ ...hit, y: this.lines.length })
    this.lines.push(l)
  }
  blank(): void {
    if (this.lines.length && this.lines.at(-1)!.length) this.lines.push([])
  }
}

/** `l` cut to `w` cells, its last segment ending in "…" when cut. */
function fit(l: Line, w: number): Line {
  if (lineWidth(l) <= w) return l
  const out: Line = []
  let left = w
  for (const s of l) {
    if (left <= 0) break
    const sw = width(s.s)
    if (sw <= left) {
      out.push(s)
      left -= sw
    } else {
      out.push({ ...s, s: cut(s.s, left) })
      left = 0
    }
  }
  return out
}

/** `left` with `right` set against the right edge at `w`. The left part is cut first, so the right stays whole (an
 *  item's figure); with `keepLeft` the right part is (a heading's summary). */
function spread(left: Line, right: Line, w: number, keepLeft = false): Line {
  if (!lineWidth(right)) return fit(left, w)
  const r = keepLeft ? fit(right, Math.max(0, w - lineWidth(left) - 2)) : right
  const rw = lineWidth(r)
  const l = fit(left, Math.max(0, w - rw - 2))
  return [...l, { s: ' '.repeat(Math.max(rw ? 2 : 0, w - lineWidth(l) - rw)) }, ...r]
}

/** The two cells a state glyph hangs in: the glyph and a space, or two spaces for an item with no state. */
function glyphSeg(g: Glyph | null): Seg[] {
  if (!g) return [{ s: '  ' }]
  return [{ s: g.mark, ...(g.fg ? { fg: g.fg } : {}), ...(g.d ? { fg: COLORS.dim } : {}) }, { s: ' ' }]
}

/** A section's heading at A0: its name regular, its count dim after a gutter, what is new in bold after another; at the
 *  right the name of its number column, dim. No marker. */
function headingLine(sec: HomeSection, w: number): Line {
  const head: Line = [{ s: sec.name }, dim(`  ${num(sec.count)}`), ...(sec.news ? [{ s: '  ' }, { s: sec.news, b: true }] : [])]
  return spread(head, sec.unit ? [dim(sec.unit)] : [], w, true)
}

/** The panel's shared columns: where the category column starts and how wide the figures at the right are. */
type Cols = { cat: number; catW: number }

function sharedCols(sections: readonly HomeSection[], w: number): Cols {
  const rows = sections.flatMap(s => s.rows.flatMap(r => [r, ...(r.kids ?? [])]))
  const catW = Math.min(10, Math.max(0, ...rows.map(r => width(r.cat ?? ''))))
  const rightW = Math.min(Math.floor(w / 3), Math.max(0, ...rows.map(r => (r.dimRight ? 0 : width(r.right ?? '')))))
  return { cat: Math.max(20, w - rightW - 2 - catW - (catW ? 2 : 0)), catW }
}

/** An item's line at `x`: its glyph hanging, its title (bold while new), its category at the shared column, its figure
 *  and bar against the right edge. */
function itemLine(row: HomeRow, x: number, w: number, cols: Cols, short = false): Line {
  const fig = short ? row.short : row.right
  const right: Line = [
    ...(!short && row.bar?.length ? [...row.bar.map(b => ({ s: '█'.repeat(b.n), fg: b.fg })), ...(fig ? [{ s: '  ' }] : [])] : []),
    ...(fig ? [row.dimRight || short ? dim(fig) : { s: fig }] : []),
  ]
  const lead: Line = [...(x ? [{ s: ' '.repeat(x) }] : []), ...glyphSeg(row.glyph)]
  const title: Seg = { s: row.title, ...(row.fresh ? { b: true } : {}) }
  if (short || !row.cat || !cols.catW) return spread([...lead, title], right, w)
  // the title cut before the category column, the category at it, the figure against the right edge
  const titleW = Math.max(8, cols.cat - lineWidth(lead) - 2)
  const left: Line = [...lead, { ...title, s: cut(row.title, titleW) }]
  const pad = Math.max(2, cols.cat - lineWidth(left))
  return spread([...left, { s: ' '.repeat(pad) }, { s: row.cat }], right, w)
}

/** An item as the stacked layout draws it: its line, its secondary line at A2, its cards at A4. */
function itemLines(out: Lines, row: HomeRow, w: number, cols: Cols): void {
  out.push(itemLine(row, 0, w, cols), { x0: 0, x1: w, row: true, act: row.act })
  if (row.meta?.length) out.push([{ s: '  ' }, ...fit(row.meta, w - 2)], { x0: 0, x1: w, row: true, act: row.act })
  for (const k of row.kids ?? []) out.push(itemLine(k, 2, w, cols), { x0: 2, x1: w, row: true, act: k.act })
}

function moreLine(out: Lines, sec: HomeSection, shown: number, whole: boolean, w: number): void {
  const left = sec.rows.length - shown
  if (left > 0) out.push([{ s: '  ' }, dim(`… ${num(left)} more`)], { x0: 2, x1: 2 + width(`… ${num(left)} more`), row: false, act: { op: 'more', sec: sec.id } })
  else if (whole && sec.rows.length > (sec.first ?? STACK_FIRST[sec.id])) out.push([{ s: '  ' }, { s: 'fewer' }], { x0: 2, x1: 7, row: false, act: { op: 'more', sec: sec.id } })
  void w
}

/** A section drawn whole or folded (its heading alone), as the stacked layout and the index's open section draw it. */
function stackedSection(out: Lines, sec: HomeSection, ui: HomeUi, w: number, cols: Cols, headAct: HomeAct, open: boolean, all = false): void {
  out.push(headingLine(sec, w), { x0: 0, x1: w, row: true, act: headAct })
  if (!open) return
  if (!sec.rows.length) {
    out.push([{ s: '  ' }, dim('none')])
    return
  }
  const whole = all || ui.more.includes(sec.id)
  const rows = whole ? sec.rows : sec.rows.slice(0, sec.first ?? STACK_FIRST[sec.id])
  for (const r of rows) itemLines(out, r, w, cols)
  if (!all) moreLine(out, sec, rows.length, whole, w)
}

/** The title row: `Home` and what the panel holds, dim; the two layouts against the right edge, 2 cells apart, the one
 *  shown on the selection background; then the rule. The path row above it names the panel ("home"). */
function headerLine(out: Lines, sections: readonly HomeSection[], ui: HomeUi, w: number): void {
  const counts = sections.map(s => plural(s.count, s.id === 'threads' ? 'thread' : s.name.toLowerCase().replace(/s$/, ''))).join(' · ')
  const tabs: Line = []
  const spans: { x0: number; x1: number; layout: HomeLayoutName }[] = []
  let tw = 0
  for (const name of HOME_LAYOUTS) {
    if (tabs.length) {
      tabs.push({ s: '  ' })
      tw += 2
    }
    tabs.push({ s: name, ...(ui.layout === name ? { bg: COLORS.selected } : {}) })
    spans.push({ x0: tw, x1: tw + name.length, layout: name })
    tw += name.length
  }
  const line = spread([{ s: 'Home' }, dim(`  ${counts}`)], tabs, w)
  const at = lineWidth(line) - tw
  const y = out.lines.length
  out.push(line)
  for (const s of spans) out.hits.push({ y, x0: at + s.x0, x1: at + s.x1, row: false, act: { op: 'layout', layout: s.layout } })
  out.push([{ s: '─'.repeat(w), fg: COLORS.rule }])
}

/** The stacked layout: every section under its heading, its first items with their secondary lines, and "… N more". */
function stacked(sections: readonly HomeSection[], ui: HomeUi, w: number): HomeLayout {
  const out = new Lines()
  headerLine(out, sections, ui, w)
  const cols = sharedCols(sections, w)
  sections.forEach((sec, i) => {
    if (i) out.blank()
    stackedSection(out, sec, ui, w, cols, { op: 'fold', sec: sec.id }, !ui.folded.includes(sec.id))
  })
  return { lines: out.lines, hits: out.hits }
}

/** One section of the index at `w` cells: its heading and its first items on a line each, the one picked on the
 *  selection background. */
function indexBlock(sec: HomeSection, picked: boolean, w: number): HomeLayout {
  const out = new Lines()
  const head = headingLine({ ...sec, unit: undefined }, w)
  out.push(picked ? head.map(x => ({ ...x, bg: COLORS.selected })) : head, { x0: 0, x1: w, row: true, act: { op: 'pick', sec: picked ? '' : sec.id } })
  if (!sec.rows.length) out.push([{ s: '  ' }, dim('none')])
  for (const r of sec.rows.slice(0, INDEX_FIRST)) out.push(itemLine(r, 0, w, { cat: 0, catW: 0 }, true), { x0: 0, x1: w, row: true, act: r.act })
  const left = sec.rows.length - INDEX_FIRST
  if (left > 0) out.push([{ s: '  ' }, dim(`… ${num(left)} more`)], { x0: 2, x1: 2 + width(`… ${num(left)} more`), row: false, act: { op: 'pick', sec: sec.id } })
  return { lines: out.lines, hits: out.hits }
}

/** Blocks one under another, a blank line between them. */
function column(blocks: readonly HomeLayout[]): HomeLayout {
  const out = new Lines()
  blocks.forEach((b, i) => {
    if (i) out.push([])
    const y0 = out.lines.length
    out.lines.push(...b.lines)
    out.hits.push(...b.hits.map(h => ({ ...h, y: h.y + y0 })))
  })
  return { lines: out.lines, hits: out.hits }
}

/** The index: every section in two columns, the second at A0 + ⌈T/2⌉, an item a line; the section picked is drawn
 *  whole under them, after a blank row. */
function index(sections: readonly HomeSection[], ui: HomeUi, w: number): HomeLayout {
  const out = new Lines()
  headerLine(out, sections, ui, w)
  const colW = Math.ceil(w / 2) - GAP
  const blocks = sections.map(s => indexBlock(s, ui.pick === s.id, colW))
  // the sections in their order, the left column taking them until it holds about half the lines
  const total = blocks.reduce((k, b) => k + b.lines.length + 1, 0)
  let split = 0
  for (let h = 0; split < blocks.length - 1 && h + blocks[split]!.lines.length + 1 <= total / 2 + 1; split++) h += blocks[split]!.lines.length + 1
  split = Math.max(1, split)
  const left = column(blocks.slice(0, split))
  const right = column(blocks.slice(split))
  const y0 = out.lines.length
  for (let y = 0; y < Math.max(left.lines.length, right.lines.length); y++) {
    const l = left.lines[y] ?? []
    out.lines.push([...l, { s: ' '.repeat(Math.max(0, colW - lineWidth(l)) + GAP) }, ...(right.lines[y] ?? [])])
  }
  out.hits.push(...left.hits.map(h => ({ ...h, y: h.y + y0 })), ...right.hits.map(h => ({ ...h, y: h.y + y0, x0: h.x0 + colW + GAP, x1: h.x1 + colW + GAP })))
  const sec = sections.find(s => s.id === ui.pick)
  if (sec) {
    out.push([])
    stackedSection(out, sec, ui, w, sharedCols([sec], w), { op: 'pick', sec: '' }, true, true)
  }
  return { lines: out.lines, hits: out.hits }
}

export function homeLayout(d: HomeData, ui: HomeUi, w: number): HomeLayout {
  const sections = homeSections(d)
  return ui.layout === 'index' ? index(sections, ui, w) : stacked(sections, ui, w)
}

/** The UI state after an act that changes it (an act that opens something leaves it as it is). */
export function homeReduce(ui: HomeUi, act: HomeAct): HomeUi {
  const flip = (xs: string[], x: string) => (xs.includes(x) ? xs.filter(y => y !== x) : [...xs, x])
  switch (act.op) {
    case 'layout':
      return { ...ui, layout: act.layout }
    case 'fold':
      return { ...ui, folded: flip(ui.folded, act.sec) }
    case 'more':
      return { ...ui, more: flip(ui.more, act.sec) }
    case 'pick':
      return { ...ui, pick: act.sec }
    default:
      return ui
  }
}

/** The lines as plain text, for the tests. */
export function plainLines(lines: readonly Line[]): string[] {
  return lines.map(l => l.map(s => s.s).join('').replace(/\s+$/, ''))
}
