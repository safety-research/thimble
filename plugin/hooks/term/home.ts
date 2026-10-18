// The home panel (/thimble, and the title row's first step): one panel listing what this session read and what this
// folder's sessions made, in SPEC-v2 J4's order, after, on Claude Code's main screen only (which takes no clicks), the
// rows above the prompt that wait for the analyst, each opening its acts on keys (bug hunt F1): coverage (what Claude read or searched of the data files),
// citations (the problems first), labels with the distribution of their values, side threads (those
// with answers not yet read first), views (built, building, proposed), the checks' open comments on answers, cards
// grouped by the question that made them, and documents. Each heading opens its section's view, each row the panel that
// shows it. A section of a feature that is off is left out. The terminal has no file browser: Coverage
// lists the files, and a file's lines show only to verify a citation, a label's records or a card's source.
//
// This file lays the panel out as styled lines and their hit regions, without `$`; register.tsx gathers the data
// (homeData), draws the lines in the Client homeview.tsx and acts on a click or a key. It follows the visual system
// (SPEC.md, section 7, "Home"): one column under the title row's `Home`; a section heading bold with its count dim in
// parentheses and `N new` in green, a blank row above it; an item's state glyph at A0 and its name at A2, regular,
// its metadata dim against the right edge and `new` in green there while it is new; card groups and folders that fold
// with `▸ ▾`, the newest group open. Each line starts with the 2-cell margin, where `❯` marks the
// row the keys chose.
import type { Line, Seg } from './draw'
import { lineWidth, valueColour, width } from './draw'
import { FRESH, MARGIN_W, fitTo, headingLine, hintLines, pointed, ruleLine, spread } from './chrome'
import { COLORS } from './paint'
import { plainProse } from './cite'
import { curlyQuotes, cutMiddle, quoted } from './lib'
import { noFitValues } from './labels'

export type SectionId = 'waiting' | 'coverage' | 'citations' | 'checks' | 'views' | 'reports' | 'threads' | 'cards' | 'labels'

/** What a click opens: an item in its own panel, or a section's own panel. */
export type HomeOpen =
  | { kind: 'view'; slug: string; built: boolean }
  | { kind: 'report'; slug: string; title?: string }
  | { kind: 'thread'; id: string }
  | { kind: 'card'; id: string }
  | { kind: 'label'; name: string }
  | { kind: 'cite'; ref: string; display: string | null; card?: string }
  | { kind: 'comment'; id: string }
  | { kind: 'waiting'; key: string; label: string }
  | { kind: 'pane'; view: 'views' | 'reports' | 'threads' | 'labels' | 'coverage' | 'citations' | 'checks'; title: string }

/** A click's act: open something, fold or unfold a card group (`key`, `open` as it is drawn now), show a section
 *  whole. */
export type HomeAct = { op: 'open'; open: HomeOpen } | { op: 'fold'; key: string; open: boolean } | { op: 'more'; sec: SectionId; next?: string }

/** What the analyst chose: the groups folded or unfolded against their default (the newest group open), the sections
 *  shown whole, and the row the keys chose (its key). */
export type HomeUi = { folded: string[]; unfolded: string[]; more: string[]; pick: string }

export const HOME_UI_EMPTY: HomeUi = { folded: [], unfolded: [], more: [], pick: '' }

// ------------------------------------------------------------------------------------------------ the data

/** `term`: built with a terminal program (view.term.js), so the panel draws it (hooks/viewhost.ts). */
/** `term`: it has a terminal page; `page`, for a built view without one, where that page stands (views.page_state:
 *  building, failed, missing or none) and `pageWhy` why (the failed build's error). */
export type HomeView = { slug: string; name: string; state: string; words: string; files: string[]; unit: string; drawable: boolean; left: number; at: number; fresh?: boolean; term?: boolean; page?: string; pageWhy?: string }
export type HomeReport = { slug: string; title: string; form: string; state: string; cards: number; tools: number; at: number; fresh?: boolean }
export type HomeThread = { id: string; title: string; about: string; words: string; tone: string; unread: number; earlier: boolean; at: number }
/** `fresh`: made since home was last opened, `new` in green at R as every new item. */
export type HomeCard = { id: string; kind: string; question: string; fresh?: boolean }
/** Cards by the question they answered: an answer's prompt, a side thread's question, a report's title, or none. */
export type HomeCardGroup = { head: string; from: 'answer' | 'thread' | 'report' | 'other'; cards: HomeCard[]; at: number }
/** `ran`: whether the label has a run, as its panel's `last run on …` or `not run yet` says (a label a stopped thread
 *  left is none); absent is true. */
export type HomeLabel = { slug: string; name: string; kind: string; trial: boolean; counts: Record<string, number>; values: string[]; paths: string[]; running: boolean; ran?: boolean; state?: string; fresh?: boolean; colors?: Record<string, number>; noFit?: number; unsure?: number }
/** A citation as home lists it (citesview.tsx): its value, its place in words, how it stands, the card it is on. */
export type HomeCite = { key: string; value: string; place: string; verdict: string; why: string; ref: string; card?: string; n?: number }
/** A check's open comment on a passage of an answer (C9): the passage as the answer wrote it (`quote`) and its anchor
 *  (`ref`, `answer:<turn>#s<n>`). */
export type HomeComment = { id: string; check: string; colour: string; quote: string; ref?: string }
/** A row above the prompt that waits for the analyst (band.tsx waitItems): its key, its label (`view proposal`,
 *  `notice`, `browser`) and what it says. */
export type HomeWait = { key: string; label: string; title: string }
export type HomeData = {
  views: HomeView[]
  reports: HomeReport[]
  threads: HomeThread[]
  cardGroups: HomeCardGroup[]
  labels: HomeLabel[]
  /** this session's coverage line (`read 2% · searched 41% of the data`), '' while it read no data file; null when
   *  coverage is off */
  coverage: string | null
  /** the session's citations, the problems first; null when citation marks are off */
  cites?: HomeCite[] | null
  /** the checks' open comments on answers; null when checks are off */
  comments?: HomeComment[] | null
  /** labels are off: no Labels section */
  noLabels?: boolean
  /** the rows above the prompt, on Claude Code's main screen only, which takes no clicks (bug hunt F1): home lists them
   *  first, each opening its acts with keys; null in fullscreen, where the rows take clicks */
  waiting?: HomeWait[] | null
  /** the sections whose lists are not read yet, which say so rather than `none` (bug hunt J9: `Cards (0) none` for 5 s
   *  with 6 cards in the workspace) */
  reading?: SectionId[]
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
  if (rest.length) sorted.push({ head: 'other cards', from: 'other', cards: rest, at: 0 })
  return sorted
}

// ------------------------------------------------------------------------------------------------ the rows

type Glyph = { mark: string; fg?: string }

/** One row of a section: its glyph (or fold marker) at A0, its name at A2 (or A4 under a folder), its metadata dim
 *  against the right edge, `new` in green there; a secondary row at A2; what a click does. A row with `kids` folds
 *  (`fold`: its key, `open`: shown open). A label's row is laid out with the section's other labels (`label`,
 *  labelBlocks). */
export type HomeRow = {
  key: string
  glyph: Glyph | null
  title: string
  /** dim words right after the title (a folder's count of files) */
  after?: Seg[]
  /** what stands at R in place of `right` when `right` would cut the title (a thread's row without its subject) */
  short?: Seg[]
  /** cut in its middle, so its end shows: a card of a group whose questions share their first words (lib.ts cutMiddle) */
  middle?: boolean
  fresh?: boolean
  right?: Seg[]
  meta?: Seg[]
  label?: HomeLabel
  kids?: HomeRow[]
  fold?: string
  open?: boolean
  depth?: number
  act: HomeAct
}

/** A section: its heading's name and count, what is new, the panel its heading opens, the column heads at the right,
 *  and its rows. `summary` says in words what the glyphs show (for the tests and a thread about the panel). */
/** `reading`: its list is not read yet (the panel opened before the session's first read): `◌ reading`, no count. */
export type HomeSection = { id: SectionId; name: string; count: number; news?: number; heads?: Seg[]; summary: Seg[]; rows: HomeRow[]; pane?: HomeOpen; reading?: boolean }

// state glyphs (SPEC.md, "The visual system", section 5): done ● and working ◌ in the text colour, not started ○
// dim, a problem × or ! in red
const DONE: Glyph = { mark: '●' }
const WORKING: Glyph = { mark: '◌' }
const NOT_STARTED: Glyph = { mark: '○', fg: COLORS.dim }

export function num(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`
}

const dim = (s: string): Seg => ({ s, fg: COLORS.dim })

/** Words parted by a dim dot, each dim unless it is a segment of its own. */
function joined(parts: (Seg | string | null | undefined | false)[]): Seg[] {
  const out: Seg[] = []
  for (const p of parts) {
    if (!p) continue
    if (out.length) out.push(dim(' · '))
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

/** A view's state words where its glyph already says what they would: without "built", "proposed", "not built" or
 *  "failed". */
function afterMark(words: string): string {
  return words.replace(/^(built|proposed|not built)(\s·\s|$)/, '').replace(/^failed:\s*/, '')
}

function countBy(words: readonly string[], order: readonly string[]): string[] {
  const by = new Map<string, number>()
  for (const w of words) by.set(w, (by.get(w) ?? 0) + 1)
  return order.filter(w => by.has(w)).map(w => `${by.get(w)} ${w}`)
}

/** What stands against the right edge: the metadata dim, then `new` in green while the item is new. */
function rightOf(meta: (string | null | undefined | false)[], fresh?: boolean): Seg[] {
  const m = joined(meta)
  return [...m, ...(fresh ? [...(m.length ? [{ s: '  ' }] : []), { s: 'new', fg: FRESH }] : [])]
}

function viewsSection(vs: readonly HomeView[]): HomeSection {
  const sorted = [...vs].sort((a, b) => b.at - a.at)
  const word = (v: HomeView) => (v.state === 'failed' ? 'failed' : v.state === 'built' || (v.state === 'stopped' && v.drawable) ? 'built' : ACTIVE_VIEW.has(v.state) ? (v.drawable ? 'built' : 'building') : 'proposed')
  return {
    id: 'views',
    name: 'Views',
    count: vs.length,
    news: vs.filter(v => v.fresh).length,
    summary: joined(countBy(sorted.map(word), ['built', 'building', 'proposed', 'failed'])),
    pane: { kind: 'pane', view: 'views', title: 'Views' },
    rows: sorted.map(v => ({
      key: `view:${v.slug}`,
      glyph: viewGlyph(v),
      title: v.name,
      fresh: v.fresh,
      right: rightOf([v.files.join(', '), afterMark(v.words)], v.fresh),
      // without its files where they would cut its name
      short: rightOf([afterMark(v.words)], v.fresh),
      act: { op: 'open', open: { kind: 'view', slug: v.slug, built: v.drawable } },
    })),
  }
}

function reportsSection(rs: readonly HomeReport[]): HomeSection {
  const sorted = [...rs].sort((a, b) => b.at - a.at)
  const word = (r: HomeReport) => (r.state === 'writing' ? 'writing' : r.state === 'error' ? 'failed' : 'written')
  return {
    id: 'reports',
    // the browser's word for them, which the list panel and the path use too
    name: 'Documents',
    count: rs.length,
    news: rs.filter(r => r.fresh).length,
    summary: joined(countBy(sorted.map(word), ['written', 'writing', 'failed'])),
    pane: { kind: 'pane', view: 'reports', title: 'Documents' },
    rows: sorted.map(r => ({
      key: `report:${r.slug}`,
      glyph: r.state === 'writing' ? WORKING : r.state === 'error' ? { mark: '×', fg: COLORS.problem } : DONE,
      title: r.title,
      fresh: r.fresh,
      // what the glyph does not say (◌ writing, × failed, ● written): its kind, its tool calls while writing, its cards
      right: rightOf([r.form, r.state === 'writing' && r.tools ? plural(r.tools, 'tool call') : '', r.cards ? plural(r.cards, 'card') : ''], r.fresh),
      act: { op: 'open', open: { kind: 'report', slug: r.slug, title: r.title } },
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
    name: 'Threads',
    count: ts.length,
    news: fresh,
    summary: joined([fresh ? `${fresh} with new answers` : '', running ? `${running} answering` : '', ts.some(t => t.earlier) ? `${ts.filter(t => t.earlier).length} from earlier sessions` : '']),
    pane: { kind: 'pane', view: 'threads', title: 'Threads' },
    rows: sorted.map(t => ({
      key: `thread:${t.id}`,
      glyph: t.tone === 'run' ? WORKING : t.tone === 'problem' ? { mark: '×', fg: COLORS.problem } : t.tone === 'ok' || t.unread ? DONE : NOT_STARTED,
      title: t.title,
      fresh: t.unread > 0,
      // what it is about, then `earlier session`, dim at R (on its one row); without its subject when that would cut
      // its question
      right: rightOf([t.about, t.earlier ? 'earlier session' : ''], t.unread > 0),
      short: rightOf([t.earlier ? 'earlier session' : ''], t.unread > 0),
      act: { op: 'open', open: { kind: 'thread', id: t.id } },
    })),
  }
}

/** What a group of cards holds, in words: the question it answered, the report or the thread it stands in. */
function groupName(g: HomeCardGroup): string {
  const head = g.head.replace(/\s+/g, ' ').trim()
  if (g.from === 'answer') return `answer to ${quoted(head)}`
  if (g.from === 'report') return `in the report ${quoted(head)}`
  if (g.from === 'thread') return `in the thread ${/^["“]/.test(head) ? head : quoted(head)}`
  return head
}

/** The fewest characters of first words a group's questions share before its rows are cut in their middle. */
const SHARED_HEAD = 16

/** Whether two or more questions share their first SHARED_HEAD characters or more, whole words, and differ after. */
function sharedHead(qs: readonly string[]): boolean {
  if (qs.length < 2) return false
  let n = 0
  const first = qs[0]!
  while (n < first.length && qs.every(q => q[n] === first[n])) n++
  const head = first.slice(0, n)
  const words = head.includes(' ') ? head.slice(0, head.lastIndexOf(' ')) : ''
  return words.length >= SHARED_HEAD && qs.some(q => q !== first)
}

function cardsSection(groups: readonly HomeCardGroup[], ui: HomeUi): HomeSection {
  const n = groups.reduce((k, g) => k + g.cards.length, 0)
  const by = (from: HomeCardGroup['from']) => groups.filter(g => g.from === from).reduce((k, g) => k + g.cards.length, 0)
  return {
    id: 'cards',
    name: 'Cards',
    count: n,
    news: groups.reduce((k, g) => k + g.cards.filter(c => c.fresh).length, 0),
    summary: joined([by('answer') ? `${num(by('answer'))} in answers` : '', by('thread') ? `${num(by('thread'))} in side threads` : '', by('report') ? `${num(by('report'))} in reports` : '']),
    rows: groups.map((g, i) => {
      const fold = `cards:${g.from}:${g.head}`
      const open = isOpen(ui, fold, i === 0)
      return {
        key: `group:${fold}`,
        glyph: { mark: open ? '▾' : '▸' },
        title: groupName(g),
        right: [dim(plural(g.cards.length, 'card'))],
        fold,
        open,
        kids: g.cards.map(c => ({ key: `card:${c.id}`, glyph: null, title: c.question, fresh: c.fresh, right: rightOf([c.kind], c.fresh), ...(sharedHead(g.cards.map(x => x.question)) ? { middle: true } : {}), act: { op: 'open', open: { kind: 'card', id: c.id } } })),
        act: { op: 'fold', key: fold, open },
      }
    }),
  }
}

/** A label's color, as the label panel's ● beside its name shows it: its first value's (its class's color when it has
 *  `colors`), else the first series hue. */
export function labelHue(values: readonly string[], colors?: Record<string, number>): string {
  const hue = values.length ? valueColour(values, values[0]!, colors) : undefined
  return hue && hue !== COLORS.dim ? hue : COLORS.series[0]!
}

function labelsSection(ls: readonly HomeLabel[]): HomeSection {
  return {
    id: 'labels',
    name: 'Labels',
    count: ls.length,
    // the labels new since home was last seen, as the toast counts them (live check term-fix9, low quirk)
    news: ls.filter(l => l.fresh).length,
    summary: joined(countBy(ls.map(l => (l.running ? 'running' : l.ran === false ? (l.state?.startsWith('stopped') ? 'stopped' : 'not run yet') : l.trial ? 'on a sample' : 'on every record')), ['on every record', 'on a sample', 'running', 'stopped', 'not run yet'])),
    pane: { kind: 'pane', view: 'labels', title: 'Labels' },
    // each label's rows are its distribution (labelBlocks), laid out with the others' so their bars stand in one column
    rows: ls.map(l => ({ key: `label:${l.slug}`, glyph: null, title: l.name, fresh: l.fresh, label: l, act: { op: 'open', open: { kind: 'label', name: l.name } } })),
  }
}

// ------------------------------------------------------------------------------------------------ a label's distribution

/** A part of a label's distribution, as its bar and its legend draw it: a value's records (`█` in the value's color), or
 *  the records no category fit that no value names (`░`, gray: no value, or a failed one). */
export type LabelPart = { name: string; n: number; fg: string; mark: string }

/** The bar's marks: a value's records, its unsure share, the records no category fit and no value names. */
export const VALUE_MARK = '█'
export const UNSURE_MARK = '▒'
export const NO_FIT_MARK = '░'

/** A label's distribution: each value with its count and color (its values in their order, then any value off its
 *  list), then `no fit` for the records no category fit that no value names (the label's no-fit count less the records
 *  of its no-fit values, labels.ts noFitValues). `unsure`: the records it is unsure of, which are among its values that
 *  answer (the others are no fit), and `answers` those values. */
export function labelParts(l: HomeLabel): { parts: LabelPart[]; unsure: number; answers: Set<string>; total: number } {
  const off = Object.keys(l.counts).filter(k => !l.values.includes(k))
  const quiet = noFitValues(l.values)
  const values = [...l.values, ...off]
  const parts: LabelPart[] = values.map(v => ({ name: v, n: l.counts[v] ?? 0, fg: valueColour(l.values, v, l.colors) ?? COLORS.dim, mark: VALUE_MARK }))
  const named = values.filter(v => quiet.has(v) || off.includes(v)).reduce((k, v) => k + (l.counts[v] ?? 0), 0)
  const rest = Math.max(0, (l.noFit ?? 0) - named)
  if (rest) parts.push({ name: 'no fit', n: rest, fg: COLORS.dim, mark: NO_FIT_MARK })
  const answers = new Set(l.values.filter(v => !quiet.has(v)))
  const answered = [...answers].reduce((k, v) => k + (l.counts[v] ?? 0), 0)
  const shown = parts.filter(p => p.n > 0)
  return { parts: shown, unsure: Math.min(l.unsure ?? 0, answered), answers, total: shown.reduce((k, p) => k + p.n, 0) }
}

/** `n` cells shared by `weights`, the cells left over given to the largest remainders; with `floor1`, every non-zero
 *  weight gets a cell while there are cells for each, taken back from the largest. */
function shareCells(weights: readonly number[], n: number, floor1 = false): number[] {
  const total = weights.reduce((k, x) => k + x, 0)
  if (!total || n <= 0) return weights.map(() => 0)
  const exact = weights.map(x => (x * n) / total)
  const out = exact.map(c => Math.floor(c))
  const order = exact.map((c, i) => ({ i, r: c - Math.floor(c) })).filter(x => x.r > 0).sort((a, b) => b.r - a.r)
  for (let k = 0, left = n - out.reduce((a, b) => a + b, 0); k < left && order.length; k++) out[order[k % order.length]!.i]!++
  if (floor1 && weights.filter(x => x > 0).length <= n)
    weights.forEach((x, i) => {
      if (x <= 0 || out[i]) return
      out[i] = 1
      const big = out.reduce((b, c, j) => (c > out[b]! ? j : b), 0)
      out[big]!--
    })
  return out
}

/** A label's bar in `w` cells: each part in its color by its share of the total, at least one cell each; the records
 *  the label is unsure of drawn `▒` at the end of the values that answer, shared by their counts (the counts do not say
 *  which value each has). */
export function labelBar(d: ReturnType<typeof labelParts>, w: number): Line {
  const cells = shareCells(d.parts.map(p => p.n), w, true)
  const answering = d.parts.map((p, i) => (d.answers.has(p.name) && p.mark === VALUE_MARK ? cells[i]! : 0))
  const answered = d.parts.reduce((k, p) => k + (d.answers.has(p.name) && p.mark === VALUE_MARK ? p.n : 0), 0)
  const hatch = d.unsure && answered ? Math.max(1, Math.round((answering.reduce((a, b) => a + b, 0) * d.unsure) / answered)) : 0
  const unsure = shareCells(answering, Math.min(hatch, answering.reduce((a, b) => a + b, 0)))
  const out: Line = []
  d.parts.forEach((p, i) => {
    const u = Math.min(unsure[i]!, cells[i]!)
    if (cells[i]! - u) out.push({ s: p.mark.repeat(cells[i]! - u), fg: p.fg })
    if (u) out.push({ s: UNSURE_MARK.repeat(u), fg: p.fg })
  })
  return out
}

/** A label laid out as its rows: its name row (glyph, name, its kind and scope dim where they fit, its bar, its total)
 *  and its legend rows. */
export type LabelBlock = { name: Line; legend: Line[] }

/** The legend rows a label takes at most; what does not fit is `+N more`. */
export const LEGEND_ROWS = 2
/** The cells of a bar: BAR_SHARE of the row, at least BAR_MIN, at most BAR_MAX; under BAR_MIN no bar. */
const BAR_SHARE = 0.3
const BAR_MAX = 40
const BAR_MIN = 8
/** The fewest cells of a label's name a bar leaves it (a shorter name, all of it). */
const NAME_KEEP = 16
/** The cells between legend entries. */
const LEGEND_GAP = 3

/** Words cut at a word to `n` cells with `…`; a first word longer than `n` cut where it must. */
function wordCut(s: string, n: number): string {
  if (width(s) <= n) return s
  const words = s.split(/(\s+)/)
  let out = ''
  for (const x of words) {
    if (width(out + x) > n - 1) break
    out += x
  }
  out = out.trimEnd()
  if (out) return `${out}…`
  let head = ''
  for (const ch of s) {
    if (width(head + ch) > n - 1) break
    head += ch
  }
  return `${head}…`
}

/** The fewest cells a legend's names keep before more values go to `+N more`. */
const LEGEND_NAME_MIN = 8

/** A label's legend: each value's ● in its color, its name, its count, then `▒ unsure` (the records it is unsure of,
 *  among its values) and `░ no fit`, in columns of one width, as many to a row as fit, `rows` rows at most, then `+N
 *  more`. When they do not all fit, `unsure` and `no fit` stay and then the values with the most records, in their
 *  order. The names' column is the width that shows the most values, a value cut at a word counting as none; of two
 *  that show as many, the wider. */
function legendLines(d: ReturnType<typeof labelParts>, w: number, rows = LEGEND_ROWS): Line[] {
  const item = (p: LabelPart) => ({ mark: p.mark === VALUE_MARK ? '●' : p.mark, fg: p.fg, name: p.name, n: p.n })
  const items = [...d.parts.filter(p => p.mark === VALUE_MARK).map(item), ...(d.unsure ? [{ mark: UNSURE_MARK, fg: COLORS.dim, name: 'unsure', n: d.unsure }] : []), ...d.parts.filter(p => p.mark !== VALUE_MARK).map(item)]
  if (!items.length) return []
  // the order they stay in: unsure and no fit, then by their counts
  const rank = items.map((x, i) => ({ i, first: x.mark !== '●', n: x.n })).sort((a, b) => Number(b.first) - Number(a.first) || b.n - a.n || a.i - b.i)
  const keep = (k: number) => {
    const kept = new Set(rank.slice(0, k).map(r => r.i))
    return items.filter((_, i) => kept.has(i))
  }
  const room = w - 2
  const cw = Math.max(...items.map(x => num(x.n).length))
  const longest = Math.min(Math.max(...items.map(x => width(x.name))), Math.max(1, room - 4 - cw))
  const perOf = (nw: number) => Math.max(1, Math.floor((room + LEGEND_GAP) / (2 + nw + 2 + cw + LEGEND_GAP)))
  const shownOf = (per: number) => (items.length <= per * rows ? items.length : per * rows - 1)
  let nw = longest
  let best = -1
  for (let x = longest; x >= Math.min(longest, LEGEND_NAME_MIN); x--) {
    const shown = shownOf(perOf(x))
    const score = shown - keep(shown).filter(i => width(i.name) > x).length
    if (score > best) [nw, best] = [x, score]
  }
  const per = perOf(nw)
  const shown = keep(shownOf(per))
  const more = `+${num(items.length - shown.length)} more`
  const out: Line[] = []
  for (let r = 0; r * per < shown.length; r++) {
    const l: Line = [{ s: '  ' }]
    shown.slice(r * per, (r + 1) * per).forEach((x, k) => {
      if (k) l.push({ s: ' '.repeat(LEGEND_GAP) })
      const name = wordCut(x.name, nw)
      l.push({ s: `${x.mark} `, fg: x.fg }, { s: name }, { s: ' '.repeat(nw - width(name) + 2) }, { s: num(x.n).padStart(cw), fg: COLORS.dim })
    })
    out.push(l)
  }
  // what is left, in the last row's free slot (a row of its own when one value fills a row)
  if (shown.length < items.length) {
    const last = out.at(-1)
    if (!last || (lineWidth(last) + LEGEND_GAP + width(more) > w && out.length < rows)) out.push([{ s: '  ' }, { s: more, fg: COLORS.dim }])
    else last.push({ s: ' '.repeat(LEGEND_GAP) }, { s: more, fg: COLORS.dim })
  }
  return out
}

/** What a label's run says beside its name, when its counts are not of a whole run: a run going, a first run stopped
 *  part way, a sample. */
function runNote(l: HomeLabel, total: number): string {
  if (l.state) return l.state.replace(/^◌ /, '')
  return l.trial ? `a sample of ${num(total)}` : ''
}

/** Labels laid out together in `w` cells (home's Labels section and the labels list): each its name row and its
 *  legend (legendLines, `rows` rows at most). The name row: its glyph and name, its kind, run and files dim in a column
 *  after the longest name where they fit (fewer of them, else none), its bar at the same column and of the same width
 *  as every other's, its total against the right edge in one column, then `new` while it is new. A label with no counts
 *  says `not run yet` (or `labeling`) where the bar and total stand, with no legend. */
export function labelBlocks(ls: readonly HomeLabel[], w: number, rows = LEGEND_ROWS): LabelBlock[] {
  const ds = ls.map(labelParts)
  const nw = ls.some(l => l.fresh) ? NEW_W : 0
  const tw = Math.max(1, ...ds.map(d => (d.total ? num(d.total).length : 0)))
  const longest = Math.max(1, ...ls.map(l => width(l.name)))
  // BAR_SHARE of the row, less where the names would keep fewer than NAME_KEEP cells; none under BAR_MIN
  const bw = Math.min(BAR_MAX, Math.round(w * BAR_SHARE), w - 2 - Math.min(NAME_KEEP, longest) - 2 - 2 - tw - nw)
  const barW = bw >= BAR_MIN ? bw : 0
  // the cells right of the names, the same on every row: the bar, the total, `new`
  const right = (barW ? barW + 2 : 0) + tw + nw
  const nameW = Math.max(1, Math.min(longest, w - 2 - 2 - right))
  return ls.map((l, i) => {
    const d = ds[i]!
    const glyph: Seg = l.running ? { s: '◌' } : d.total ? { s: '●', fg: labelHue(l.values, l.colors) } : { s: '○', fg: COLORS.dim }
    // `new` after the total, or its cells blank in a section where some label is new
    const fresh: Line = l.fresh ? [{ s: '  ' }, { s: 'new', fg: FRESH }] : nw ? [{ s: ' '.repeat(nw) }] : []
    // at the bar's place: the bar and the total, or the words that say why there is none
    const tail: Line = d.total ? [...(barW ? [...labelBar(d, barW), { s: '  ' }] : []), { s: num(d.total).padStart(tw) }, ...fresh] : [dim(l.running ? 'labeling' : 'not run yet'), ...fresh]
    const name = wordCut(l.name, Math.max(1, Math.min(nameW, w - 2 - 2 - lineWidth(tail))))
    const note = d.total ? runNote(l, d.total) : ''
    const room = w - 2 - nameW - 2 - 2 - Math.max(right, lineWidth(tail))
    const meta = [[l.kind, note, l.paths.join(', ')], [l.kind, note], [note], [l.kind]].map(m => m.filter(Boolean).join(' · ')).find(m => m && width(m) <= room) ?? ''
    const left: Line = [glyph, { s: ' ' }, { s: name }, ...(meta ? [{ s: ' '.repeat(nameW - width(name) + 2) }, dim(meta)] : [])]
    return { name: [...left, { s: ' '.repeat(Math.max(2, w - lineWidth(left) - lineWidth(tail))) }, ...tail], legend: d.total ? legendLines(d, w, rows) : [] }
  })
}

/** Waiting (bug hunt F1): on Claude Code's main screen, which takes no clicks, the rows above the prompt that wait for
 *  the analyst, first: the view proposal, the notices and the browser's SSH row, each a row that Enter opens with its
 *  acts on keys (the `waiting` view). A notice's glyph is a red `!`, as its row's label is red. */
function waitingSection(ws: readonly HomeWait[]): HomeSection {
  return {
    id: 'waiting',
    name: 'Above the prompt',
    count: ws.length,
    summary: [],
    rows: ws.map(w => ({
      key: `waiting:${w.key}`,
      glyph: w.label === 'notice' ? { mark: '!', fg: COLORS.problem } : null,
      title: w.title,
      right: rightOf([w.label]),
      act: { op: 'open', open: { kind: 'waiting', key: w.key, label: w.label } },
    })),
  }
}

/** Coverage (SPEC-v2 J5): this session's coverage line, its heading opening the Coverage view. */
function coverageSection(line: string): HomeSection {
  return {
    id: 'coverage',
    name: 'Coverage',
    count: line ? 1 : 0,
    summary: [],
    pane: { kind: 'pane', view: 'coverage', title: 'Coverage' },
    rows: line ? [{ key: 'coverage:line', glyph: null, title: line, act: { op: 'open', open: { kind: 'pane', view: 'coverage', title: 'Coverage' } } }] : [],
  }
}

/** Citations (SPEC-v2 3.8): the session's citations, the problems first, each with how it stands. */
function citationsSection(cs: readonly HomeCite[]): HomeSection {
  const bad = cs.filter(c => c.verdict !== 'ok' && c.verdict !== 'pending')
  const ok = cs.filter(c => c.verdict === 'ok').length
  return {
    id: 'citations',
    name: 'Citations',
    count: cs.length,
    summary: joined([ok ? `${num(ok)} found` : '', bad.length ? `${num(bad.length)} with problems` : '']),
    pane: { kind: 'pane', view: 'citations', title: 'Citations' },
    rows: cs.map(c => {
      const problem = c.verdict !== 'ok' && c.verdict !== 'pending'
      return {
        key: `cite:${c.key}`,
        glyph: problem ? { mark: c.verdict === 'typed' || c.verdict === 'quiet' ? '!' : '×', fg: COLORS.problem } : c.verdict === 'pending' ? WORKING : DONE,
        title: c.value || c.place,
        // a chip's place is its title (a card by its question): not said again
        right: rightOf([c.value ? c.place : '', problem ? c.why || c.verdict : '', c.card ? `card ${c.n}` : '']),
        act: { op: 'open', open: { kind: 'cite', ref: c.ref, display: c.value || null, ...(c.card ? { card: c.card } : {}) } },
      }
    }),
  }
}

/** Checks (SPEC-v2 J7): the checks' open comments on passages of answers, one row per passage with its comments'
 *  count and their checks, the flag in its first check's color; the passage in plain words with its chips
 *  (plainProse), in straight quotation marks as every row's, its own straight ones curly. The section's count is the
 *  comments', as the thimble line's. */
function checksSection(cs: readonly HomeComment[]): HomeSection {
  const passages = new Map<string, HomeComment[]>()
  for (const c of cs) {
    const key = c.ref || c.quote
    passages.set(key, [...(passages.get(key) ?? []), c])
  }
  return {
    id: 'checks',
    name: 'Checks',
    count: cs.length,
    summary: [],
    pane: { kind: 'pane', view: 'checks', title: 'Checks' },
    rows: [...passages.values()].map(([c, ...more]) => ({
      key: `comment:${c!.id}`,
      glyph: { mark: '⚑', fg: c!.colour },
      title: quoted(curlyQuotes(plainProse(c!.quote).replace(/\s+/g, ' ').trim())),
      right: rightOf([more.length ? `${num(more.length + 1)} comments` : '', ...new Set([c!, ...more].map(x => x.check))]),
      act: { op: 'open', open: { kind: 'comment', id: c!.id } },
    })),
  }
}

/** Whether a group shows open: its default unless the analyst folded or unfolded it. */
function isOpen(ui: HomeUi, key: string, byDefault: boolean): boolean {
  return byDefault ? !ui.folded.includes(key) : ui.unfolded.includes(key)
}

/** Every section, in SPEC-v2 J4's order: on the main screen what waits above the prompt, then what this session read and
 *  how its citations and labels stand, what it asked and made, what the checks said, then its cards and documents. A section of a feature that is off is left out
 *  (coverage, citations, labels, checks), and so are coverage, citations and checks while they hold nothing. */
export function homeSections(d: HomeData, ui: HomeUi = HOME_UI_EMPTY): HomeSection[] {
  // the sections of what this session read, its citations and the checks' comments show once they hold something
  const sections = [
    ...(d.waiting?.length ? [waitingSection(d.waiting)] : []),
    ...(d.coverage ? [coverageSection(d.coverage)] : []),
    ...(d.cites?.length ? [citationsSection(d.cites)] : []),
    ...(d.noLabels ? [] : [labelsSection(d.labels)]),
    threadsSection(d.threads),
    viewsSection(d.views),
    ...(d.comments?.length ? [checksSection(d.comments)] : []),
    cardsSection(d.cardGroups, ui),
    reportsSection(d.reports),
  ]
  return d.reading?.length ? sections.map(sec => (d.reading!.includes(sec.id) && !sec.rows.length ? { ...sec, reading: true } : sec)) : sections
}

// ------------------------------------------------------------------------------------------------ the layout

/** A region a click acts on: its line, its cells, and whether the pointer lights its row (else it is a control, which
 *  the pointer inverts). `pick`: the key of the row it stands for, which the keys step through. */
export type HomeHit = { y: number; x0: number; x1: number; row: boolean; act: HomeAct; pick?: string }
/** `hintRows`: how many of its last lines are the key hints (chrome.ts hintLines); `heads`: the line of each section's
 *  heading. */
export type HomeLayout = { lines: Line[]; hits: HomeHit[]; picks: { key: string; act: HomeAct }[]; hintRows: number; heads: number[] }

/** The items a section shows before `… N more` (card groups and folders count as items). */
export const FIRST = 5

export const HOME_HINTS = ['↑↓ to choose', 'Enter to open', 'Space to fold', 'x to close']

class Lines {
  lines: Line[] = []
  hits: HomeHit[] = []
  picks: HomeLayout['picks'] = []
  constructor(readonly pick: string) {}
  /** A line of the type area, its margin before it: `❯` when it is the row the keys chose. */
  push(l: Line, hit?: Omit<HomeHit, 'y'>): void {
    const on = Boolean(hit?.pick) && hit!.pick === this.pick
    if (hit) this.hits.push({ ...hit, x0: hit.x0 + MARGIN_W, x1: hit.x1 + MARGIN_W, y: this.lines.length })
    if (hit?.pick) this.picks.push({ key: hit.pick, act: hit.act })
    this.lines.push(pointed(l, on))
  }
  blank(): void {
    if (this.lines.length && lineWidth(this.lines.at(-1)!) > MARGIN_W) this.lines.push([])
  }
}

/** The two cells a glyph or fold marker hangs in, or two spaces. */
function glyphSeg(g: Glyph | null): Seg[] {
  if (!g) return [{ s: '  ' }]
  return [{ s: g.mark, ...(g.fg ? { fg: g.fg } : {}) }, { s: ' ' }]
}

/** The fewest cells of a row's title kept beside its full right part (itemLine). */
const TITLE_MIN = 32

/** An item's line at `x`: its glyph hanging, its name, its metadata against the right edge. */
function itemLine(row: HomeRow, x: number, w: number): Line {
  const lead: Line = [...(x ? [{ s: ' '.repeat(x) }] : []), ...glyphSeg(row.glyph)]
  const left: Line = [...lead, { s: row.title }, ...(row.after ?? [])]
  // the full right part (a thread's subject) whenever the title keeps TITLE_MIN cells beside it, the title cut at a word
  // to make room; else the shorter right part (live check term-fix6, quirk 10: `about 602` was left out beside a long
  // question)
  const full: Line = row.right ?? []
  const room = w - lineWidth(full) - 2 - (lineWidth(left) - width(row.title))
  const chosen = row.short && lineWidth(left) + 2 + lineWidth(full) > w && room < Math.min(TITLE_MIN, width(row.title)) ? row.short : full
  // the right part never takes the title's first cells: it is cut where it would leave the title fewer than 12
  const keep = Math.min(width(row.title), 12) + lineWidth(left) - width(row.title)
  const right = lineWidth(chosen) + 2 + keep > w ? fitTo(chosen, Math.max(0, w - 2 - keep)) : chosen
  // a row whose end tells it from the rows beside it, cut in its middle
  if (row.middle) {
    const fit = w - lineWidth(right) - 2 - (lineWidth(left) - width(row.title))
    if (fit > 0 && width(row.title) > fit) return spread([...lead, { s: cutMiddle(row.title, fit) }, ...(row.after ?? [])], right, w)
  }
  return spread(left, right, w)
}

/** A row without `new` in a section where some row has it: its right part ends where the others' words end, before the
 *  cells `new` takes (live check term-fix9, low quirk: `table  new` beside `table` put the kinds in two columns). */
function besideNew(r: HomeRow): HomeRow {
  const pad = (xs: Seg[] | undefined) => (xs?.length ? [...xs, { s: ' '.repeat(NEW_W) }] : xs)
  return r.fresh ? r : { ...r, right: pad(r.right), short: pad(r.short) }
}
const NEW_W = '  new'.length

function sectionLines(out: Lines, sec: HomeSection, ui: HomeUi, w: number): void {
  if (sec.rows.some(r => r.fresh || (r.open && r.kids?.some(k => k.fresh)))) sec = { ...sec, rows: sec.rows.map(r => ({ ...besideNew(r), ...(r.kids ? { kids: r.kids.map(besideNew) } : {}) })) }
  const head = headingLine(sec.name, sec.reading ? undefined : sec.count, sec.news ?? 0)
  out.push(spread(head, sec.heads ?? [], w), sec.pane ? { x0: 0, x1: lineWidth(head), row: false, act: { op: 'open', open: sec.pane } } : undefined)
  if (!sec.rows.length) {
    out.push([{ s: '  ' }, dim(sec.reading ? '◌ reading' : 'none')])
    return
  }
  const whole = ui.more.includes(sec.id) || sec.rows.length <= FIRST + 1
  const shown = whole ? sec.rows : sec.rows.slice(0, FIRST)
  // the labels shown, laid out together: their bars in one column
  const labeled = shown.filter(r => r.label)
  const blocks = new Map(labelBlocks(labeled.map(r => r.label!), w).map((b, i) => [labeled[i]!.key, b]))
  for (const r of shown) {
    const b = blocks.get(r.key)
    if (b) {
      out.push(b.name, { x0: 0, x1: w, row: true, act: r.act, pick: r.key })
      for (const l of b.legend) out.push(l, { x0: 0, x1: w, row: true, act: r.act })
      continue
    }
    out.push(itemLine(r, 0, w), { x0: 0, x1: w, row: true, act: r.act, pick: r.key })
    if (r.meta?.length) out.push([{ s: '  ' }, ...fitTo(r.meta, w - 2)], { x0: 0, x1: w, row: true, act: r.act })
    if (r.kids && r.open) {
      // a group's cards at A2 under its name
      for (const k of r.kids) out.push(itemLine(k, k.glyph ? 2 : 0, w), { x0: 2, x1: w, row: true, act: k.act, pick: k.key })
    }
  }
  // the section's `… N more` is a row the keys choose: Enter or Space shows the section whole, the choice on its first
  // row shown then (live check term-fix9, quirk 6: ↑↓ skipped it, so two groups of 18 cards could not be reached)
  const left = sec.rows.length - shown.length
  if (left > 0) out.push([{ s: '  ' }, dim(`… ${num(left)} more`)], { x0: 2, x1: 2 + width(`… ${num(left)} more`), row: false, act: { op: 'more', sec: sec.id, next: sec.rows[shown.length]!.key }, pick: `more:${sec.id}` })
}

/** The whole panel below its title row (`Home`, the path's one step): the rule, every section, the key hints
 *  (`hints`: HOME_HINTS while the panel holds the keys, else what gives it them). */
export function homeLayout(d: HomeData, ui: HomeUi, w: number, hints: readonly string[] = HOME_HINTS): HomeLayout {
  const sections = homeSections(d, ui)
  // the row the keys chose: the one named, else the first
  const first = sections.flatMap(s => s.rows.slice(0, 1).map(r => r.key))[0] ?? ''
  const out = new Lines(ui.pick || first)
  out.push(ruleLine(w))
  const heads: number[] = []
  sections.forEach((sec, i) => {
    if (i) out.blank()
    heads.push(out.lines.length)
    sectionLines(out, sec, ui, w)
  })
  const hintRows = hintLines(hints, w)
  for (const l of hintRows) out.push(l)
  return { lines: out.lines, hits: out.hits, picks: out.picks, hintRows: hintRows.length, heads }
}

/** The UI state after an act that changes it (an act that opens something leaves it as it is). */
export function homeReduce(ui: HomeUi, act: HomeAct): HomeUi {
  const without = (xs: string[], x: string) => xs.filter(y => y !== x)
  switch (act.op) {
    case 'fold':
      return act.open ? { ...ui, folded: [...without(ui.folded, act.key), act.key], unfolded: without(ui.unfolded, act.key) } : { ...ui, folded: without(ui.folded, act.key), unfolded: [...without(ui.unfolded, act.key), act.key] }
    case 'more':
      return { ...ui, more: ui.more.includes(act.sec) ? without(ui.more, act.sec) : [...ui.more, act.sec] }
    default:
      return ui
  }
}

/** The row the keys choose after `key` (up or down, home or end), from the layout's rows in order. */
export function homePick(lay: HomeLayout, ui: HomeUi, key: string): string {
  const keys = lay.picks.map(p => p.key)
  if (!keys.length) return ui.pick
  const at = Math.max(0, keys.indexOf(ui.pick || keys[0]!))
  const to = key === 'up' || key === 'k' ? at - 1 : key === 'down' || key === 'j' ? at + 1 : key === 'home' ? 0 : key === 'end' ? keys.length - 1 : at
  return keys[Math.max(0, Math.min(keys.length - 1, to))]!
}

/** The lines as plain text, for the tests: without the margin's two cells. */
export function plainLines(lines: readonly Line[]): string[] {
  return lines.map(l => l.map(s => s.s).join('').slice(MARGIN_W).replace(/\s+$/, ''))
}

