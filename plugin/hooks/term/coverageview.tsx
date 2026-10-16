// The Coverage view (SPEC-v2 J5, 3.9; the owner's notes of 10-16, "Coverage + checks feedback"): what this session's
// tool calls saw or searched of the corpus, from `thimble state coverage --session <sid> [--folder <rel>] [--match
// <group>]` (C7). One level a view: a row per folder and type, per name pattern (`agent-*.jsonl`) or per file, every
// group listed (the list scrolls; no `other`). Each row counts one unit, named in the row: records (rows or lines) for
// data files, files for images, binaries and documents. Seen and searched each show a count and a percent, in their
// colors; a totals row under the list holds the corpus's denominators, one line per unit. Enter on a folder's row
// drills into the folder, on a pattern's or a type's row lists its files (`b` back), on a file's row opens 0.8.0's file
// view; `o` and the title row's `↗` open Files in the browser at the folder.
//
//   home › coverage
//   what this session's tool calls saw or searched
//   ──────────────────────────────────────────────────────────────────────────────────
//       folder          files               seen        searched            total    size
//   ❯ ▸ agents/         agent-*.jsonl    800  16%      400   8%      4,800 records  520 KB
//       (top level)     events.jsonl     140 100%        0   0%        140 records    7 KB
//     ▸ images/day-1/   .png               1 3.3%        0   0%         30 files     1 MB
//       ────────────────────────────────────────────────────────────────────────────
//       total                            940  15%      400   6%      6,140 records
//                                          1 2.7%        0   0%         37 files
import type { RenderElement } from 'claude-code'

import type { CoverageTotal, TermPanel } from './types'
import { MARGIN_W, headerEls, marginKey, pointed, setBrowser, subLine } from './chrome'
import type { Ctx, SurfaceGot } from './ctx'
import type { Line, Seg } from './draw'
import { cut, noControls, width } from './lib'
import { linesEl } from './lines'
import type { LineHit } from './lines'
import { COLORS } from './paint'
import type { PaneEvent } from './panel'
import { drawsView, hintHeight, hintsRow, none, openFile, paneRows, windowList } from './panel'
import { loadsView, navOrigin, openPanel, readSurface, rt, surfaceValue } from './term'

/** What a row counts: records (rows or lines of data files) or files (images, binaries, documents). */
export type CoverageUnit = CoverageTotal['unit']
export type { CoverageTotal }

/** A row of `thimble state coverage` (C7): a folder's files of one type, a name pattern's files, or one file. */
export type CoverageRow = {
  key: string
  folder: string
  ext: string
  path: string | null
  files: number
  seen: number
  searched: number
  never: number
  records_seen: number
  records_total: number | null
  bytes: number
  drill: boolean
  unit?: CoverageUnit
  records_searched?: number
  name?: string
  match?: string | null
}


type CoverageState = { summary?: { line?: string; totals?: CoverageTotal[] }; folder?: string; match?: string | null; rows?: CoverageRow[]; more?: number; counting?: boolean }

const num = (n: number) => Math.round(n).toLocaleString('en-US')
const dim = (s: string): Seg => ({ s, fg: COLORS.dim })
const GAP = 2
const UNIT_W = 'records'.length

/** A share in words, as coverage.py `percent` says it: `0%`, `<0.01%`, two decimals below 0.1% and one below 1% (cut,
 *  so a share never reads as the next step up), else a whole percent (`99%` for nearly all, `100%` only for all). */
export function percent(part: number, total: number): string {
  if (!(total > 0) || !(part > 0)) return '0%'
  if (part >= total) return '100%'
  const p = (100 * part) / total
  if (p < 0.01) return '<0.01%'
  if (p < 0.1) return `${(Math.floor(p * 100) / 100).toFixed(2)}%`
  if (p < 1) return `${(Math.floor(p * 10) / 10).toFixed(1)}%`
  return `${Math.min(99, Math.round(p))}%`
}

/** A size in words (`1.2 MB`). */
export function sizeWords(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`
}

/** The folder a drill-in opens: a row's folder under the level shown, without its trailing `/`. */
export function drillFolder(current: string, row: Pick<CoverageRow, 'folder'>): string {
  const f = row.folder.replace(/\/+$/, '')
  const cur = current.replace(/\/+$/, '')
  if (!cur || f === cur || f.startsWith(`${cur}/`)) return f
  return `${cur}/${f}`
}

/** A row's counts in its one unit: seen, searched and the total (null while the records are being counted). */
export function measure(r: CoverageRow): { unit: CoverageUnit; seen: number; searched: number; total: number | null } {
  const unit: CoverageUnit = r.unit ?? 'records'
  if (unit === 'files') return { unit, seen: r.seen, searched: r.searched, total: r.files }
  return { unit, seen: r.records_seen, searched: r.records_searched ?? 0, total: r.records_total }
}

/** The folder in the folder column: `(top level)` for the corpus's top, else the folder with its `/`. */
export function folderWords(folder: string): string {
  const f = noControls(folder).replace(/^\.\/?/, '').replace(/\/+$/, '')
  return f ? `${f}/` : '(top level)'
}

/** A path cut to `w` cells in its middle, the first folder and as many of the last ones as fit kept
 *  (`images/…/2025-04-02/`). */
export function cutPath(p: string, w: number): string {
  if (width(p) <= w) return p
  const slash = p.endsWith('/') ? '/' : ''
  const parts = p.replace(/\/+$/, '').split('/')
  for (let k = parts.length - 2; k >= 1; k--) {
    const s = `${parts[0]}/…/${parts.slice(parts.length - k).join('/')}${slash}`
    if (width(s) <= w) return s
  }
  const last = `…/${parts.at(-1)}${slash}`
  return width(last) <= w ? last : cut(p, w)
}

/** A unit's word for a count: `records` and `files`, `record` and `file` for one. */
export function unitWord(unit: CoverageUnit, n: number): string {
  return n === 1 ? unit.replace(/s$/, '') : unit
}

/** A row's name: its file's name, its pattern, or its type. */
function nameOf(r: CoverageRow): string {
  return noControls(r.name ?? (r.path ? r.path.split('/').at(-1) ?? r.path : r.ext || '(none)'))
}

type Cells = { mark: string; folder: string; name: string; unit: CoverageUnit | null; seen: number | null; searched: number | null; total: number | null; counting: boolean; size: string; label?: boolean }

/** The layout a type area allows: folder and files in two columns or in one, the size, and in the narrowest panes each
 *  row on two lines (its folder and files whole, then its numbers), with the counts while they fit. */
type Tier = { split: boolean; size: boolean; two?: boolean; counts: boolean }
const TIERS: Tier[] = [
  { split: true, size: true, counts: true },
  { split: true, size: false, counts: true },
  { split: false, size: false, counts: true },
  { split: false, size: false, counts: true, two: true },
  { split: false, size: false, counts: false, two: true },
]
/** The indent of a two-line row's numbers, under its name. */
const TWO_INDENT = 4

/** The rows, the corpus's totals and a note of the rows left out, as lines in a type area `cols` wide: the header (seen
 *  and searched in their colors, which the numbers keep), one line a row (`▸` on one that drills in), and under the list
 *  a rule and one totals line per unit. Where the columns do not fit the size goes first, then folder and files share a
 *  column, then each row takes two lines so its names stay whole, and last the counts go (the percents stay). */
export function coverageLines(rows: readonly CoverageRow[], pick: string, cols: number, o: { totals?: readonly CoverageTotal[]; drilled?: boolean; more?: number; level?: string } = {}): { head: Line[]; lines: Line[]; totals: Line[]; hits: { y: number; key: string }[]; picks: string[] } {
  // the folder the view shows names the files right in it dim, as `(top level)` is: the title already says where
  const here = folderWords(o.level ?? '')
  const cells: Cells[] = rows.map(r => {
    const m = measure(r)
    return { mark: r.drill ? '▸ ' : '  ', folder: folderWords(r.folder), name: nameOf(r), unit: m.unit, seen: m.seen, searched: m.searched, total: m.total, counting: m.total === null, size: sizeWords(r.bytes) }
  })
  const totals: Cells[] = (o.totals ?? []).map((t, i) => {
    const counting = t.unit === 'records' && t.counted === false
    return { mark: '  ', folder: i === 0 ? (o.drilled ? 'corpus total' : 'total') : '', name: '', unit: t.unit, seen: counting ? null : t.seen, searched: counting ? null : t.searched, total: counting ? null : t.total, counting, size: '', label: true }
  })
  const all = [...cells, ...totals]
  const pctOf = (n: number | null, c: Cells) => (n === null || c.total === null ? '' : percent(n, c.total))
  const countW = (k: 'seen' | 'searched') => Math.max(1, ...all.map(c => (c[k] === null ? 0 : width(num(c[k]!)))))
  const pctW = (k: 'seen' | 'searched') => Math.max(2, ...all.map(c => width(pctOf(c[k], c))))
  const sc = countW('seen'), sp = pctW('seen'), xc = countW('searched'), xp = pctW('searched')
  const totalNumW = Math.max(1, ...all.map(c => (c.total === null ? (c.counting ? width('counting') - UNIT_W - 1 : 0) : width(num(c.total)))))
  const totalW = Math.max('total'.length, totalNumW + 1 + UNIT_W)
  const sizeW = Math.max('size'.length, ...cells.map(c => width(c.size)))
  const folderW = Math.min(30, Math.max('folder'.length, ...all.map(c => width(c.folder))))
  const colW = (t: Tier) => ({ seen: Math.max('seen'.length, t.counts ? sc + 1 + sp : sp), searched: Math.max('searched'.length, t.counts ? xc + 1 + xp : xp) })
  const numbersW = (t: Tier) => {
    const w = colW(t)
    return w.seen + GAP + w.searched + GAP + totalW + (t.size ? GAP + sizeW : 0)
  }
  const fixed = (t: Tier) => 2 + (t.split ? folderW + GAP : 0) + GAP + numbersW(t)
  // the first layout in which every name is whole (a name up to 24 cells; folder and name up to 28 in one column)
  const both = (c: Cells) => (c.folder === '(top level)' || c.folder === here ? c.name : `${c.folder} ${c.name}`)
  const nameNeed = Math.min(24, Math.max(...cells.map(c => width(c.name)), 'files'.length))
  const bothNeed = Math.min(28, Math.max(...cells.map(c => width(both(c))), 'folder · files'.length))
  const fits = (t: Tier) => (t.two ? 2 + TWO_INDENT + numbersW(t) <= cols : cols - fixed(t) >= (t.split ? nameNeed : bothNeed))
  const tier = TIERS.find(fits) ?? TIERS.at(-1)!
  const w = colW(tier)
  const nameW = tier.two ? cols - 2 : Math.max(6, cols - fixed(tier))
  const numCell = (c: Cells, k: 'seen' | 'searched', fg: string): Seg[] => {
    const n = c[k]
    const colw = k === 'seen' ? w.seen : w.searched
    if (n === null) return [{ s: ' '.repeat(colw) }]
    const words = tier.counts ? `${num(n).padStart(k === 'seen' ? sc : xc)} ${pctOf(n, c).padStart(k === 'seen' ? sp : xp)}` : pctOf(n, c).padStart(k === 'seen' ? sp : xp)
    return [{ s: words.padStart(colw), ...(n > 0 ? { fg } : { fg: COLORS.dim }) }]
  }
  const totalCell = (c: Cells): Seg[] => {
    if (c.counting) return [dim('counting'.padStart(totalW))]
    if (c.total === null || c.unit === null) return [{ s: ' '.repeat(totalW) }]
    return [{ s: num(c.total).padStart(totalW - UNIT_W - 1) }, dim(` ${unitWord(c.unit, c.total).padEnd(UNIT_W)}`)]
  }
  const numbers = (c: Cells): Line => [
    ...numCell(c, 'seen', COLORS.series[0]!),
    { s: ' '.repeat(GAP) },
    ...numCell(c, 'searched', COLORS.series[1]!),
    { s: ' '.repeat(GAP) },
    ...totalCell(c),
    ...(tier.size ? [{ s: ' '.repeat(GAP) }, dim(c.size.padStart(sizeW))] : []),
  ]
  /** The folder and the files' name in `room` cells: the folder dim and cut in its middle before the name is cut; the
   *  files at the top, and those right in the folder the view shows (its title names it), by their names alone. */
  const where = (c: Cells, room: number): Seg[] => {
    if (c.label) return [{ s: cut(c.folder, room).padEnd(room), b: true }]
    if (c.folder === '(top level)' || c.folder === here) return [{ s: cut(c.name, room).padEnd(room) }]
    const keep = Math.min(width(c.name), Math.max(8, room - width(c.folder) - 1))
    const f = cutPath(c.folder, Math.max(4, room - keep - 1))
    const rest = Math.max(1, room - width(f) - 1)
    return [dim(f), { s: ' ' }, { s: cut(c.name, rest).padEnd(rest) }]
  }
  const firstCells = (c: Cells): Seg[] => {
    if (!tier.split) return where(c, nameW)
    const folder = c.label ? { s: cut(c.folder, folderW).padEnd(folderW), b: true } : c.folder === '(top level)' || c.folder === here ? dim(cutPath(c.folder, folderW).padEnd(folderW)) : { s: cutPath(c.folder, folderW).padEnd(folderW) }
    return [folder, { s: ' '.repeat(GAP) }, { s: cut(c.name, nameW).padEnd(nameW) }]
  }
  /** A row's lines: one, or in the narrowest panes its names then its numbers under them. */
  const rowLines = (c: Cells): Line[] => {
    if (!tier.two) return [[{ s: c.mark }, ...firstCells(c), { s: ' '.repeat(GAP) }, ...numbers(c)]]
    const name: Line = [{ s: c.mark }, ...where(c, nameW)]
    const nums: Line = [{ s: ' '.repeat(2 + TWO_INDENT) }, ...numbers(c)]
    return c.label && !c.folder ? [nums] : c.label ? [name, nums] : [name, nums]
  }
  // the header: the columns' names, dim, with seen and searched in their colors (the legend)
  const numbersHead: Seg[] = [{ s: 'seen'.padStart(w.seen), fg: COLORS.series[0] }, { s: ' '.repeat(GAP) }, { s: 'searched'.padStart(w.searched), fg: COLORS.series[1] }, { s: ' '.repeat(GAP) }, dim('total'.padStart(totalW)), ...(tier.size ? [{ s: ' '.repeat(GAP) }, dim('size'.padStart(sizeW))] : [])]
  const head: Line[] = tier.two
    ? [pointed([{ s: '  ' }, dim(cut('folder · files', nameW))], false), pointed([{ s: ' '.repeat(2 + TWO_INDENT) }, ...numbersHead], false)]
    : [pointed([{ s: '  ' }, ...(tier.split ? [dim('folder'.padEnd(folderW)), { s: ' '.repeat(GAP) }, dim('files'.padEnd(nameW))] : [dim(cut('folder · files', nameW).padEnd(nameW))]), { s: ' '.repeat(GAP) }, ...numbersHead], false)]
  const lines: Line[] = []
  const hits: { y: number; key: string }[] = []
  rows.forEach((r, i) => {
    rowLines(cells[i]!).forEach((l, k) => {
      hits.push({ y: lines.length, key: r.key })
      lines.push(k === 0 ? pointed(l, r.key === pick) : pointed(l, false))
    })
  })
  if (o.more && o.more > 0) lines.push(pointed([{ s: '  ' }, dim(cut(`… ${num(o.more)} more not listed here (the list holds the first ${num(rows.length)})`, cols - 2))], false))
  const totalLines: Line[] = totals.length ? [pointed([{ s: '  ' }, { s: '─'.repeat(Math.max(1, cols - 2)), fg: COLORS.rule }], false), ...totals.flatMap(t => rowLines(t).map(l => pointed(l, false)))] : []
  return { head, lines, totals: totalLines, hits, picks: rows.map(r => r.key) }
}

// the row the keys chose, by the level shown
const picks = new Map<string, string>()

/** The Coverage view opened in the panel (SPEC-v2 C13), at `folder` ('' or none for the corpus's top), or at one group
 *  of that folder's files (`match`: a name pattern, or a type such as `.md`). */
export async function openCoverage(cx: Ctx, folder?: string, match?: string | null): Promise<void> {
  const f = (folder ?? '').replace(/^\.\/?/, '').replace(/\/+$/, '')
  await openPanel(cx, { view: 'coverage', title: 'Coverage', ...(f ? { path: f } : {}), ...(match ? { match } : {}) })
}

/** The state key of a level's coverage. */
const keyOf = (folder: string, match: string) => (match ? `coverage:${JSON.stringify([folder, match])}` : `coverage:${folder}`)

async function loadCoverage(cx: Ctx, p: TermPanel): Promise<void> {
  if (!rt.sc) return
  const sid = await cx.sessionId()
  const folder = p.path ?? ''
  const match = p.match ?? ''
  await readSurface(cx, keyOf(folder, match), 'coverage', [...(sid ? ['--session', sid] : []), ...(folder ? ['--folder', folder] : []), ...(match ? ['--match', match] : [])])
}

/** The view's title: the folder shown, and the group of its files when one is shown. */
export function coverageTitle(folder: string, match?: string | null): string {
  // a group by its folder's last name (the step before it names the whole folder) and its pattern or type
  if (match) return folder ? `${folder.split('/').at(-1)}/${match}` : match
  return folder ? `${folder}/` : 'Coverage'
}

async function drawCoverage(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e)
  const { Box, Text } = els
  const cols = Math.max(30, e.props.bodyColumns)
  const folder = p.path ?? ''
  const match = p.match ?? ''
  setBrowser(`files:${folder}`)
  const got = (await surfaceValue<CoverageState>(cx, keyOf(folder, match))) as SurfaceGot | undefined
  const st = got?.ok ? (got.value as CoverageState) : null
  const totals = st?.summary?.totals ?? (await cx.coverageSummary())?.totals ?? []
  const sub: (string | Seg)[] = ["what this session's tool calls saw or searched"]
  const body: RenderElement[] = [...headerEls(els as never, { title: coverageTitle(folder, match), cols, sub: subLine(sub), more: st?.counting ? [<Text key="cov-line" dimColor wrap="wrap">◌ counting records</Text>] : [] })]
  if (!got) return <Box flexDirection="column">{[...body, none(cx, e, '◌ reading what this session read')]}</Box>
  if (!got.ok) return <Box flexDirection="column">{[...body, <Text key="cov-error" color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text>]}</Box>
  const rows = (st?.rows ?? []).filter(r => r && typeof r.key === 'string')
  const pickKey = keyOf(folder, match)
  const pick = rows.find(r => r.key === picks.get(pickKey))?.key ?? rows[0]?.key ?? ''
  const lay = coverageLines(rows, pick, cols, { totals, drilled: Boolean(folder || match), more: st?.more ?? 0, level: folder })
  // an open from the view stands on the panel's trail after it (home › coverage › agents/), as a press in the panel does
  const open = async (r: CoverageRow) => {
    if (!r.path && !r.drill) return
    await navOrigin(cx, true)
    if (r.path) return openFile(cx, r.path)
    return r.match ? openCoverage(cx, r.folder, r.match) : openCoverage(cx, drillFolder(folder, r))
  }
  const step = (d: number) => {
    const at = lay.picks.indexOf(pick)
    picks.set(pickKey, lay.picks[Math.max(0, Math.min(lay.picks.length - 1, at + d))] ?? '')
    return cx.bumpPanel()
  }
  const hits: LineHit[] = lay.hits.map(h => ({ y: h.y, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: () => {
    picks.set(pickKey, h.key)
    const r = rows.find(x => x.key === h.key)
    return r ? open(r) : undefined
  } }))
  const hints = ['↑↓ to choose', ...(rows.some(r => r.drill || r.path) ? ['Enter to open a folder, a group or a file'] : []), 'o to open Files in the browser', ...(folder || match ? ['b to go back'] : []), 'x to close']
  const onKey = (k: string) => {
    if (k === 'up' || k === 'k') return step(-1)
    if (k === 'down' || k === 'j') return step(1)
    if (k === 'return' || k === 'enter') {
      const r = rows.find(x => x.key === pick)
      return r ? open(r) : undefined
    }
    return undefined
  }
  if (rows.length) body.push(linesEl(cx, e, marginKey('coverage-head'), lay.head, [], cols + MARGIN_W))
  const room = paneRows() - 1 - body.length - (rows.length ? lay.head.length - 1 : 0) - lay.totals.length - hintHeight(hints, cols)
  const at = lay.lines.findIndex((_, y) => lay.hits.some(h => h.y === y && h.key === pick))
  const win = windowList(`coverage:${pickKey}`, lay.lines, hits, at, room, () => cx.bumpPanel())
  if (rows.length) body.push(linesEl(cx, e, marginKey('coverage-list'), win.lines, win.hits, cols + MARGIN_W, onKey))
  else body.push(none(cx, e, st?.counting ? '◌ listing the corpus' : 'no files here count for coverage'))
  if (rows.length && lay.totals.length) body.push(linesEl(cx, e, marginKey('coverage-totals'), lay.totals, [], cols + MARGIN_W))
  body.push(hintsRow(els as never, hints, cols))
  return <Box flexDirection="column">{body}</Box>
}

/** The Coverage view's read and drawing registered with the panel (views.ts registerPanelViews). */
export function registerCoverageView(): void {
  loadsView('coverage', loadCoverage)
  drawsView('coverage', drawCoverage)
}
