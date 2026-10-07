// The home panel (/thimble-home, and the path row's first step): one panel listing what this folder's sessions made,
// as thimble's workbench lists them in its tabs: views (built, building, proposed), reports, side threads (those with
// answers not yet read first), cards grouped by the question that made them, labels with their counts, and the files
// by folder with what this session read of them. Each is a click away from the panel that opens it. A file in the
// `listed` state counts neither its records nor its reading: it shows its kind and its size.
//
// This file lays the panel out as styled lines and their hit regions, without `$`; register.tsx gathers the data
// (homeData), draws the lines in the Client homeview.tsx and acts on a click or a key. It follows the visual system
// (SPEC.md, section 7, "Home"): one column; the title `Home`; a section heading bold with its count dim in
// parentheses and `N new` in green, a blank row above it; an item's state glyph at A0 and its name at A2, regular,
// its metadata dim against the right edge and `new` in green there while it is new; card groups and folders that fold
// with `▸ ▾`, the newest group and the first folder open. Each line starts with the 2-cell margin, where `❯` marks the
// row the keys chose.
import type { Line, Seg } from './draw'
import { lineWidth, share as pct, valueColour, width, wrapRows } from './draw'
import { ACCENT, FRESH, MARGIN_W, fitTo, headingLine, hintLines, pointed, ruleLine, spread } from './chrome'
import { COLORS } from './paint'
import { cutMiddle, quoted } from './lib'

export type SectionId = 'views' | 'reports' | 'threads' | 'cards' | 'labels' | 'files'

/** What a click opens: an item in its own panel, or a section's own panel. */
export type HomeOpen =
  | { kind: 'view'; slug: string; built: boolean }
  | { kind: 'report'; slug: string; title?: string }
  | { kind: 'thread'; id: string }
  | { kind: 'card'; id: string }
  | { kind: 'label'; name: string }
  | { kind: 'file'; path: string }
  | { kind: 'pane'; view: 'views' | 'reports' | 'threads' | 'labels' | 'coverage'; title: string; folder?: string }

/** A click's act: open something, fold or unfold a card group or a folder (`key`, `open` as it is drawn now), show a
 *  section whole. */
export type HomeAct = { op: 'open'; open: HomeOpen } | { op: 'fold'; key: string; open: boolean } | { op: 'more'; sec: SectionId; next?: string }

/** What the analyst chose: the groups and folders folded or unfolded against their default (the newest group and the
 *  first folder open), the sections shown whole, and the row the keys chose (its key). */
export type HomeUi = { folded: string[]; unfolded: string[]; more: string[]; pick: string }

export const HOME_UI_EMPTY: HomeUi = { folded: [], unfolded: [], more: [], pick: '' }

// ------------------------------------------------------------------------------------------------ the data

/** `term`: built with a terminal program (view.term.js), so the panel draws it (hooks/viewhost.ts). */
export type HomeView = { slug: string; name: string; state: string; words: string; files: string[]; unit: string; drawable: boolean; left: number; at: number; fresh?: boolean; term?: boolean }
export type HomeReport = { slug: string; title: string; form: string; state: string; cards: number; tools: number; at: number; fresh?: boolean }
export type HomeThread = { id: string; title: string; about: string; words: string; tone: string; unread: number; earlier: boolean; at: number }
/** `fresh`: made since home was last opened, `new` in green at R as every new item. */
export type HomeCard = { id: string; kind: string; question: string; fresh?: boolean }
/** Cards by the question they answered: an answer's prompt, a side thread's question, a report's title, or none. */
export type HomeCardGroup = { head: string; from: 'answer' | 'thread' | 'report' | 'other'; cards: HomeCard[]; at: number }
/** `ran`: whether the label has a run, as its panel's `last run on …` or `not run yet` says (a label a stopped thread
 *  left is none); absent is true. */
export type HomeLabel = { slug: string; name: string; kind: string; trial: boolean; counts: Record<string, number>; values: string[]; paths: string[]; running: boolean; ran?: boolean; state?: string; fresh?: boolean; colors?: Record<string, number> }
/** thimble-term: a file whose reading thimble does not count (`listed`) has no state glyph and shows its kind. */
export type HomeFile = { file: string; records: number | null; size: number; seen: number; state: 'read' | 'scanned' | 'untouched' | 'listed'; ranges: number[][]; kind?: string }
export type HomeData = {
  views: HomeView[]
  reports: HomeReport[]
  threads: HomeThread[]
  cardGroups: HomeCardGroup[]
  labels: HomeLabel[]
  files: HomeFile[]
  coverage: string
  /** the folder's own name, which heads the files at its top */
  root?: string
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
 *  against the right edge, `new` in green there, a bar before the figure; a secondary row at A2; what a click does. A
 *  row with `kids` folds (`fold`: its key, `open`: shown open). */
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
  bar?: { n: number; fg: string }[]
  meta?: Seg[]
  kids?: HomeRow[]
  fold?: string
  open?: boolean
  depth?: number
  more?: number
  act: HomeAct
}

/** A section: its heading's name and count, what is new, the panel its heading opens, the column heads at the right,
 *  and its rows. `summary` says in words what the glyphs show (for the tests and a thread about the panel). */
export type HomeSection = { id: SectionId; name: string; count: number; news?: number; heads?: Seg[]; summary: Seg[]; rows: HomeRow[]; pane?: HomeOpen; coverage?: string }

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

/** The cells a label's bar takes at most, and the fewest it is drawn in: a narrower bar is left out. */
const BAR_W = 20
const BAR_MIN = 6
/** The cells of a row's name a bar leaves it at least, or the whole name when it is shorter: a name is cut at a word,
 *  so a bar that left it fewer cells cut most names to their first word. */
const NAME_KEEP = 24

/** A label's counts, each value with its colour as the label panel draws it (draw.ts valueColour): the bar's parts,
 *  their cells set when the row is laid out at its width (barCells). */
function countBar(values: readonly string[], counts: Record<string, number>, colors?: Record<string, number>): { n: number; fg: string }[] {
  return values.map(v => ({ n: counts[v] ?? 0, fg: valueColour(values, v, colors)! })).filter(x => x.n > 0)
}

/** A bar's parts in `w` cells by their counts, the cells left over given to the largest remainders, so the bar is `w`
 *  wide. */
function barCells(parts: readonly { n: number; fg: string }[], w: number): { n: number; fg: string }[] {
  const total = parts.reduce((k, p) => k + p.n, 0)
  if (!total || w <= 0) return []
  const cells = parts.map(p => (p.n * w) / total)
  const out = cells.map(c => Math.floor(c))
  const order = cells.map((c, i) => ({ i, r: c - Math.floor(c) })).sort((a, b) => b.r - a.r)
  for (let k = 0, left = w - out.reduce((a, b) => a + b, 0); k < left; k++) out[order[k % order.length]!.i]!++
  return parts.map((p, i) => ({ n: out[i]!, fg: p.fg })).filter(x => x.n > 0)
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
    rows: ls.map(l => {
      const labeled = l.values.reduce((k, v) => k + (l.counts[v] ?? 0), 0)
      // a label with no run says so, as its panel does, with no bar and no counts (live check term-fix7, new quirk 6:
      // home showed `yes 0 · no 0` and 0 for a label a stopped thread left)
      // one whose first run is going says so (no counts yet)
      if (l.ran === false && !labeled)
        return {
          key: `label:${l.slug}`,
          glyph: l.running ? WORKING : NOT_STARTED,
          title: l.name,
          fresh: l.fresh,
          right: rightOf([l.running ? 'labeling' : 'not run yet'], l.fresh),
          meta: joined([l.kind, l.paths.join(', ')]),
          act: { op: 'open', open: { kind: 'label', name: l.name } },
        }
      // a legend: each value's ● in its hue, its word and count dim as the rest of the secondary row
      const legend: Seg[] = []
      l.values.forEach((v, i) => {
        if (i) legend.push(dim('  '))
        legend.push({ s: '● ', fg: valueColour(l.values, v, l.colors) }, dim(`${v} ${num(l.counts[v] ?? 0)}`))
      })
      // what its runs say: a run going (`◌ labeling 3,000 of 4,579`), a first run stopped part way (`stopped at 3,150 of
      // 4,579`), else what the last run covered (live check term-fix9, quirk 4)
      const runWords = l.state || (l.trial ? `a sample of ${num(labeled)}` : 'every record')
      return {
        key: `label:${l.slug}`,
        // its ● in the label's color, as the label panel draws it beside its name
        glyph: l.running ? WORKING : { mark: '●', fg: labelHue(l.values, l.colors) },
        title: l.name,
        fresh: l.fresh,
        bar: countBar(l.values, l.counts, l.colors),
        right: [{ s: num(labeled) }, ...(l.fresh ? [{ s: '  ' }, { s: 'new', fg: FRESH }] : [])],
        meta: [...joined([l.kind, runWords, l.paths.join(', ')]), dim('  '), ...legend],
        act: { op: 'open', open: { kind: 'label', name: l.name } },
      }
    }),
  }
}

/** A share of records read, in whole percent as every share (draw.ts share). */
function share(seen: number, total: number): string {
  if (!total || !seen) return ''
  return pct(seen, total)
}

/** thimble-term: a size in words (`756 KB`), for a file whose records are not counted. */
function sizeWords(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`
}

/** The files at most an open folder lists before `… N more`. */
const FOLDER_FILES = 20

function filesSection(fs: readonly HomeFile[], root: string, ui: HomeUi): HomeSection {
  const by = new Map<string, HomeFile[]>()
  // a folder by the name the file browser gives it: its path in the corpus (`collusion-wiki/`), and the corpus's own
  // files under the corpus folder's name
  for (const f of fs) {
    const cut = f.file.lastIndexOf('/')
    const folder = cut < 0 ? `${root}/` : `${f.file.slice(0, cut)}/`
    by.set(folder, [...(by.get(folder) ?? []), f])
  }
  // the corpus's own folder first, the others in natural order, as the file browser lists them
  const top = `${root}/`
  const folders = [...by.entries()].sort(([a], [b]) => (a === b ? 0 : a === top ? -1 : b === top ? 1 : a.localeCompare(b, undefined, { numeric: true })))
  const recs = (xs: readonly HomeFile[]) => xs.reduce((k, f) => k + (f.records ?? 0), 0)
  const seen = (xs: readonly HomeFile[]) => xs.reduce((k, f) => k + Math.min(f.seen, f.records ?? 0), 0)
  const cols = (records: string, read: string): Seg[] => [{ s: records }, { s: '  ' }, dim(read)]
  // thimble-term: where no reading is counted, the columns are the files' kind (text, left) then size (a number, on R)
  const listed = fs.length > 0 && fs.every(f => f.state === 'listed')
  return {
    id: 'files',
    name: 'Files',
    count: fs.length,
    heads: listed ? [dim('type'), { s: '  ' }, dim('size')] : [dim('records'), { s: '  ' }, dim('read')],
    summary: joined([fs.length && !listed ? `${num(fs.filter(f => f.state === 'read').length)} of ${num(fs.length)} read` : '']),
    pane: { kind: 'pane', view: 'coverage', title: 'Coverage' },
    rows: folders.map(([folder, files], i) => {
      const fold = `files:${folder}`
      const open = isOpen(ui, fold, i === 0)
      const sorted = [...files].sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }))
      return {
        key: `folder:${folder}`,
        glyph: { mark: open ? '▾' : '▸' },
        title: folder,
        // its count of files dim after its name, as the file browser shows it; under the columns only what they head
        after: [dim(`  ${num(files.length)}`)],
        right: listed ? [{ s: '' }, { s: '  ' }, dim(sizeWords(files.reduce((k, f) => k + f.size, 0)))] : cols(num(recs(files)), share(seen(files), recs(files)) || '0%'),
        fold,
        open,
        // a folder of 21 shows all 21: `… 1 more` would take the row the file takes
        more: sorted.length > FOLDER_FILES + 1 ? sorted.length - FOLDER_FILES : 0,
        kids: sorted.slice(0, sorted.length > FOLDER_FILES + 1 ? FOLDER_FILES : sorted.length).map(f => ({
          key: `file:${f.file}`,
          // a listed file has no state glyph: a blank in its place keeps its name at A4
          glyph: f.state === 'listed' ? { mark: ' ' } : f.state === 'read' ? DONE : NOT_STARTED,
          title: f.file.split('/').at(-1) ?? f.file,
          right: f.state === 'listed' ? [dim(f.kind ?? ''), { s: '  ' }, dim(sizeWords(f.size))] : cols(f.records !== null ? num(f.records) : `${num(f.size)} B`, f.state === 'read' ? share(f.seen, f.records ?? 0) || '0%' : f.state === 'scanned' ? 'counted' : ''),
          act: { op: 'open', open: { kind: 'file', path: f.file } } as HomeAct,
        })),
        act: { op: 'fold', key: fold, open },
      }
    }),
  }
}

/** Whether a group or folder shows open: its default unless the analyst folded or unfolded it. */
function isOpen(ui: HomeUi, key: string, byDefault: boolean): boolean {
  return byDefault ? !ui.folded.includes(key) : ui.unfolded.includes(key)
}

/** Every section, in the order of thimble's workbench: what it built, what it wrote, what it asked, then its parts. */
export function homeSections(d: HomeData, ui: HomeUi = HOME_UI_EMPTY): HomeSection[] {
  return [viewsSection(d.views), reportsSection(d.reports), threadsSection(d.threads), cardsSection(d.cardGroups, ui), labelsSection(d.labels), { ...filesSection(d.files, d.root || 'folder', ui), ...(d.coverage ? { coverage: d.coverage } : {}) }]
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

/** An item's line at `x`: its glyph hanging, its name, its bar and figure against the right edge. The bar takes what
 *  the name leaves (NAME_KEEP cells of it, or all of a shorter one), up to BAR_W cells, and is left out under BAR_MIN:
 *  in a narrow pane the name stays readable (live check term-fix10, new quirk 6: `● age…  ████████████████████  1,900`). */
function itemLine(row: HomeRow, x: number, w: number): Line {
  const lead: Line = [...(x ? [{ s: ' '.repeat(x) }] : []), ...glyphSeg(row.glyph)]
  const barRoom = w - lineWidth(lead) - Math.min(NAME_KEEP, width(row.title)) - lineWidth(row.after ?? []) - 2 - lineWidth(row.right ?? []) - 2
  const barW = Math.min(BAR_W, barRoom)
  const bar: Line = row.bar?.length && barW >= BAR_MIN ? [...barCells(row.bar, barW).map(b => ({ s: '█'.repeat(b.n), fg: b.fg })), { s: '  ' }] : []
  const left: Line = [...lead, { s: row.title }, ...(row.after ?? [])]
  // the full right part (a thread's subject) whenever the title keeps TITLE_MIN cells beside it, the title cut at a word
  // to make room; else the shorter right part (live check term-fix6, quirk 10: `about 602` was left out beside a long
  // question)
  const full: Line = [...bar, ...(row.right ?? [])]
  const room = w - lineWidth(full) - 2 - (lineWidth(left) - width(row.title))
  const chosen = row.short && lineWidth(left) + 2 + lineWidth(full) > w && room < Math.min(TITLE_MIN, width(row.title)) ? [...bar, ...row.short] : full
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

/** The figures of a section's rows set in shared columns: each row's right part padded so its last column ends on R
 *  and the columns before it line up (the files' records and share). */
function alignRight(sec: HomeSection): void {
  if (sec.id !== 'files') return
  const rows = sec.rows.flatMap(r => [r, ...(r.kids ?? [])])
  // the files' right parts are [count?, gap, records, gap, read]: pad records and read to their columns
  const parts = rows.map(r => r.right ?? [])
  const first = sec.heads?.[0]?.s.trim() || 'records'
  const recW = Math.max(width(first), ...parts.map(p => width(p.at(-3)?.s ?? '')))
  const readW = Math.max(width(sec.heads?.at(-1)?.s.trim() || 'read'), ...parts.map(p => width(p.at(-1)?.s ?? '')))
  // text aligns left, numbers right: a listed file's kind is text (its first column), its size a number
  const textFirst = first === 'type'
  for (const r of rows) {
    const p = r.right ?? []
    if (p.length < 3) continue
    const rec = p.at(-3)!
    const read = p.at(-1)!
    r.right = [...p.slice(0, -3), { ...rec, s: textFirst ? rec.s.padEnd(recW) : rec.s.padStart(recW) }, { s: '  ' }, { ...read, s: read.s.padStart(readW) }]
  }
  const last = sec.heads?.at(-1)?.s.trim() || 'read'
  sec.heads = [dim(textFirst ? first.padEnd(recW) : first.padStart(recW)), { s: '  ' }, dim(last.padStart(readW))]
}

/** A row without `new` in a section where some row has it: its right part ends where the others' words end, before the
 *  cells `new` takes (live check term-fix9, low quirk: `table  new` beside `table` put the kinds in two columns). */
function besideNew(r: HomeRow): HomeRow {
  const pad = (xs: Seg[] | undefined) => (xs?.length ? [...xs, { s: ' '.repeat(NEW_W) }] : xs)
  return r.fresh ? r : { ...r, right: pad(r.right), short: pad(r.short) }
}
const NEW_W = '  new'.length

/** The cells of a file's name the type column never cuts: a name up to this long is whole beside the column, or the
 *  column goes. */
export const NAME_WHOLE = 32

/** The files section without its type column, when beside it a file's name (up to NAME_WHOLE cells) would be cut (live
 *  check term-fix10, new quirk 6: `agent-c…` beside the column); else as it is. */
function withoutType(sec: HomeSection, w: number): HomeSection {
  if (sec.id !== 'files' || sec.heads?.[0]?.s.trim() !== 'type') return sec
  const files = sec.rows.flatMap(r => r.kids ?? [])
  const longest = Math.max(0, ...files.map(f => width(f.title)))
  const rightW = Math.max(0, ...files.map(f => lineWidth(f.right ?? [])))
  if (w - 4 - 2 - rightW >= Math.min(NAME_WHOLE, longest)) return sec
  const sizeOnly = (r: HomeRow): HomeRow => ({ ...r, ...(r.right && r.right.length >= 3 ? { right: [...r.right.slice(0, -3), r.right.at(-1)!] } : {}), ...(r.kids ? { kids: r.kids.map(sizeOnly) } : {}) })
  return { ...sec, heads: sec.heads.slice(-1), rows: sec.rows.map(sizeOnly) }
}

function sectionLines(out: Lines, sec: HomeSection, ui: HomeUi, w: number): void {
  alignRight(sec)
  sec = withoutType(sec, w)
  if (sec.rows.some(r => r.fresh || (r.open && r.kids?.some(k => k.fresh)))) sec = { ...sec, rows: sec.rows.map(r => ({ ...besideNew(r), ...(r.kids ? { kids: r.kids.map(besideNew) } : {}) })) }
  const head = headingLine(sec.name, sec.count, sec.news ?? 0)
  out.push(spread(head, sec.heads ?? [], w), sec.pane ? { x0: 0, x1: lineWidth(head), row: false, act: { op: 'open', open: sec.pane } } : undefined)
  // the orientation's coverage line, dim under the Files heading, whole up to four rows
  if (sec.coverage) for (const l of wrapRows(sec.coverage, Math.max(10, w - 2), 4)) out.push([{ s: '  ' }, dim(l)])
  if (!sec.rows.length) {
    out.push([{ s: '  ' }, dim('none')])
    return
  }
  const whole = ui.more.includes(sec.id) || sec.rows.length <= FIRST + 1
  const shown = whole ? sec.rows : sec.rows.slice(0, FIRST)
  for (const r of shown) {
    out.push(itemLine(r, 0, w), { x0: 0, x1: w, row: true, act: r.act, pick: r.key })
    if (r.meta?.length) out.push([{ s: '  ' }, ...fitTo(r.meta, w - 2)], { x0: 0, x1: w, row: true, act: r.act })
    if (r.kids && r.open) {
      // a group's cards at A2 under its name; a folder's files with their glyphs at A2 and their names at A4
      for (const k of r.kids) out.push(itemLine(k, k.glyph ? 2 : 0, w), { x0: 2, x1: w, row: true, act: k.act, pick: k.key })
      // a folder's `… N more` is a row the keys choose too: Enter shows the folder whole in the file browser
      if (r.more) out.push([{ s: '    ' }, dim(`… ${num(r.more)} more`)], { x0: 4, x1: 4 + width(`… ${num(r.more)} more`), row: false, act: { op: 'open', open: { kind: 'pane', view: 'coverage', title: 'Coverage', folder: r.title } }, pick: `more:${r.key}` })
    }
  }
  // the section's `… N more` is a row the keys choose: Enter or Space shows the section whole, the choice on its first
  // row shown then (live check term-fix9, quirk 6: ↑↓ skipped it, so two groups of 18 cards could not be reached)
  const left = sec.rows.length - shown.length
  if (left > 0) out.push([{ s: '  ' }, dim(`… ${num(left)} more`)], { x0: 2, x1: 2 + width(`… ${num(left)} more`), row: false, act: { op: 'more', sec: sec.id, next: sec.rows[shown.length]!.key }, pick: `more:${sec.id}` })
}

/** The whole panel below its path row: the title `Home`, the rule, every section, the key hints (`hints`: HOME_HINTS
 *  while the panel holds the keys, else what gives it them). */
export function homeLayout(d: HomeData, ui: HomeUi, w: number, hints: readonly string[] = HOME_HINTS): HomeLayout {
  const sections = homeSections(d, ui)
  // the row the keys chose: the one named, else the first
  const first = sections.flatMap(s => s.rows.slice(0, 1).map(r => r.key))[0] ?? ''
  const out = new Lines(ui.pick || first)
  out.push([{ s: 'Home', fg: ACCENT, b: true }])
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

