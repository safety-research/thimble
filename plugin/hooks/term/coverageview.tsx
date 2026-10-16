// The Coverage view (SPEC-v2 J5, 3.9; the owner's notes of 10-16, "Coverage + checks feedback" and "Coverage polish
// round 2"): what Claude read or searched in this session, from `thimble state coverage --session <sid> [--folder
// <rel>] [--match <group>]` (C7). One level a view: a row per folder and type, per name pattern (`agent-*.jsonl`) or per
// file, every group listed (the list scrolls; no `other`), in one name column: a file at the top by its name alone, a
// nested row with its folder dim before its name or pattern. Each row counts one unit, named in the row: lines for
// line-based text, entries for a JSON document's values and a database's rows, files for everything else. Read (it
// entered Claude's context) and searched (a search ran over it and only matches came back) each show a count and a
// percent, in their colors; a wide pane says so in a legend under the subtitle. A totals row under the list holds the
// corpus's denominators, one line per unit. Enter on a folder's row drills into the folder, on a pattern's or a type's
// row lists its files (`b` back), on a file's row opens 0.8.0's file view; `o` and the title row's `↗` open Files in
// the browser at the folder.
//
//   home › Coverage
//   what Claude read or searched in this session
//   read: entered Claude's context · searched: a search ran over it, only matches came back
//   ──────────────────────────────────────────────────────────────────────────────────────
//       folder · files                   read      searched            total
//   ❯ ▸ agents/ agent-*.jsonl         800  16%    400   8%      4,800 lines
//       events.jsonl                  140 100%      0   0%        140 lines
//       forge.db                        0   0%    587 100%        587 entries
//     ▸ images/day-1/ .png              1 3.3%      0   0%         30 files
//       ──────────────────────────────────────────────────────────────────
//       total                         940  15%    400   6%      6,140 lines
//                                       0   0%    587 100%        587 entries
//                                       1 2.7%      0   0%         37 files
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

/** What a row counts: lines (line-based text), entries (a JSON document's values, a database's rows) or files. */
export type CoverageUnit = CoverageTotal['unit']
export type { CoverageTotal }

/** A row of `thimble state coverage` (C7): a folder's files of one type, a name pattern's files, or one file. `seen`
 *  counts the files read; `records_*` count lines or entries, the row's unit. */
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

/** The legend a wide pane shows under the subtitle: what read and searched mean. */
export const LEGEND = "read: entered Claude's context · searched: a search ran over it, only matches came back"
/** The legend as a line: read and searched in their colors, the rest dim. */
function legendLine(): Line {
  return [{ s: 'read', fg: COLORS.series[0] }, dim(": entered Claude's context · "), { s: 'searched', fg: COLORS.series[1] }, dim(': a search ran over it, only matches came back')]
}
/** The list rows a pane keeps, at least, before it shows the legend (or all of the list's, when fewer). */
const LEGEND_ROWS = 8

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

/** The folder a drill-in opens: a row's folder under the level shown, without its trailing `/`. */
export function drillFolder(current: string, row: Pick<CoverageRow, 'folder'>): string {
  const f = row.folder.replace(/\/+$/, '')
  const cur = current.replace(/\/+$/, '')
  if (!cur || f === cur || f.startsWith(`${cur}/`)) return f
  return `${cur}/${f}`
}

/** A row's counts in its one unit: read (`seen`), searched and the total (null while its lines or entries are being
 *  counted). */
export function measure(r: CoverageRow): { unit: CoverageUnit; seen: number; searched: number; total: number | null } {
  const unit: CoverageUnit = r.unit ?? 'lines'
  if (unit === 'files') return { unit, seen: r.seen, searched: r.searched, total: r.files }
  return { unit, seen: r.records_seen, searched: r.records_searched ?? 0, total: r.records_total }
}

/** The folder before a row's name: the folder with its `/`, or none for the corpus's top. */
export function folderWords(folder: string): string {
  const f = noControls(folder).replace(/^\.\/?/, '').replace(/\/+$/, '')
  return f ? `${f}/` : ''
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

const ONE: Record<string, string> = { lines: 'line', entries: 'entry', files: 'file' }
/** A unit's word for a count: `lines`, `entries` and `files`; `line`, `entry` and `file` for one. */
export function unitWord(unit: CoverageUnit, n: number): string {
  return n === 1 ? (ONE[unit] ?? unit) : unit
}

/** A row's name: its file's name, its pattern, or its type. */
function nameOf(r: CoverageRow): string {
  return noControls(r.name ?? (r.path ? r.path.split('/').at(-1) ?? r.path : r.ext || '(none)'))
}

type Cells = { mark: string; folder: string; name: string; unit: CoverageUnit | null; read: number | null; searched: number | null; total: number | null; counting: boolean; label?: string }

/** The layout a type area allows: each row on one line, or in the narrowest panes on two (its name whole, then its
 *  numbers), with the counts while they fit. */
type Tier = { two: boolean; counts: boolean }
const TIERS: Tier[] = [
  { two: false, counts: true },
  { two: true, counts: true },
  { two: true, counts: false },
]
/** The indent of a two-line row's numbers, under its name. */
const TWO_INDENT = 4

/** The rows, the corpus's totals and a note of the rows left out, as lines in a type area `cols` wide: the header (read
 *  and searched in their colors, which the numbers keep), one line a row (`▸` on one that drills in) in one name column,
 *  and under the list a rule and one totals line per unit. Where a row does not fit on one line it takes two, so its
 *  name stays whole, and last the counts go (the percents and the units stay). `wide`: each row on one line with its
 *  counts, the layout in which the view may show its legend. */
export function coverageLines(rows: readonly CoverageRow[], pick: string, cols: number, o: { totals?: readonly CoverageTotal[]; drilled?: boolean; more?: number; level?: string } = {}): { head: Line[]; lines: Line[]; units: { key: string | null; lines: Line[] }[]; totals: Line[]; hits: { y: number; key: string }[]; picks: string[]; wide: boolean } {
  // the folder the view shows names the files right in it no more than the top's: the title already says where
  const here = folderWords(o.level ?? '')
  const cells: Cells[] = rows.map(r => {
    const m = measure(r)
    return { mark: r.drill ? '▸ ' : '  ', folder: folderWords(r.folder), name: nameOf(r), unit: m.unit, read: m.seen, searched: m.searched, total: m.total, counting: m.total === null }
  })
  const totals: Cells[] = (o.totals ?? []).map((t, i) => {
    const counting = t.unit !== 'files' && t.counted === false
    return { mark: '  ', folder: '', name: '', unit: t.unit, read: counting ? null : t.seen, searched: counting ? null : t.searched, total: counting ? null : t.total, counting, label: i === 0 ? (o.drilled ? 'corpus total' : 'total') : '' }
  })
  const all = [...cells, ...totals]
  const pctOf = (n: number | null, c: Cells) => (n === null || c.total === null ? '' : percent(n, c.total))
  const countW = (k: 'read' | 'searched') => Math.max(1, ...all.map(c => (c[k] === null ? 0 : width(num(c[k]!)))))
  const pctW = (k: 'read' | 'searched') => Math.max(2, ...all.map(c => width(pctOf(c[k], c))))
  const rc = countW('read'), rp = pctW('read'), xc = countW('searched'), xp = pctW('searched')
  const unitW = Math.max(1, ...all.map(c => (c.total === null || c.unit === null ? 0 : width(unitWord(c.unit, c.total)))))
  const totalNumW = Math.max(1, ...all.map(c => (c.total === null ? (c.counting ? width('counting') - unitW - 1 : 0) : width(num(c.total)))))
  const totalW = Math.max('total'.length, totalNumW + 1 + unitW)
  const colW = (t: Tier) => ({ read: Math.max('read'.length, t.counts ? rc + 1 + rp : rp), searched: Math.max('searched'.length, t.counts ? xc + 1 + xp : xp) })
  const numbersW = (t: Tier) => {
    const w = colW(t)
    return w.read + GAP + w.searched + GAP + totalW
  }
  const fixed = (t: Tier) => 2 + GAP + numbersW(t)
  // the first layout in which every name is whole (a folder and its name up to 28 cells)
  const both = (c: Cells) => (!c.folder || c.folder === here ? c.name : `${c.folder} ${c.name}`)
  const bothNeed = Math.min(28, Math.max(...cells.map(c => width(both(c))), 'folder · files'.length))
  const fits = (t: Tier) => (t.two ? 2 + TWO_INDENT + numbersW(t) <= cols : cols - fixed(t) >= bothNeed)
  const tier = TIERS.find(fits) ?? TIERS.at(-1)!
  const w = colW(tier)
  const nameW = tier.two ? cols - 2 : Math.max(6, cols - fixed(tier))
  const numCell = (c: Cells, k: 'read' | 'searched', fg: string): Seg[] => {
    const n = c[k]
    const colw = k === 'read' ? w.read : w.searched
    if (n === null) return [{ s: ' '.repeat(colw) }]
    const words = tier.counts ? `${num(n).padStart(k === 'read' ? rc : xc)} ${pctOf(n, c).padStart(k === 'read' ? rp : xp)}` : pctOf(n, c).padStart(k === 'read' ? rp : xp)
    return [{ s: words.padStart(colw), ...(n > 0 ? { fg } : { fg: COLORS.dim }) }]
  }
  const totalCell = (c: Cells): Seg[] => {
    if (c.counting) return [dim('counting'.padStart(totalW))]
    if (c.total === null || c.unit === null) return [{ s: ' '.repeat(totalW) }]
    return [{ s: num(c.total).padStart(totalW - unitW - 1) }, dim(` ${unitWord(c.unit, c.total).padEnd(unitW)}`)]
  }
  const numbers = (c: Cells): Line => [
    ...numCell(c, 'read', COLORS.series[0]!),
    { s: ' '.repeat(GAP) },
    ...numCell(c, 'searched', COLORS.series[1]!),
    { s: ' '.repeat(GAP) },
    ...totalCell(c),
  ]
  /** A row's name in `room` cells: a nested row's folder dim and cut in its middle before its name is cut; a file at
   *  the top, and one right in the folder the view shows (its title names it), by its name alone. */
  const where = (c: Cells, room: number): Seg[] => {
    if (c.label !== undefined) return [{ s: cut(c.label, room).padEnd(room), b: true }]
    if (!c.folder || c.folder === here) return [{ s: cut(c.name, room).padEnd(room) }]
    const keep = Math.min(width(c.name), Math.max(8, room - width(c.folder) - 1))
    const f = cutPath(c.folder, Math.max(4, room - keep - 1))
    const rest = Math.max(1, room - width(f) - 1)
    return [dim(f), { s: ' ' }, { s: cut(c.name, rest).padEnd(rest) }]
  }
  /** A row's lines: one, or in the narrowest panes its name then its numbers under it. */
  const rowLines = (c: Cells): Line[] => {
    if (!tier.two) return [[{ s: c.mark }, ...where(c, nameW), { s: ' '.repeat(GAP) }, ...numbers(c)]]
    const nums: Line = [{ s: ' '.repeat(2 + TWO_INDENT) }, ...numbers(c)]
    return c.label === '' ? [nums] : [[{ s: c.mark }, ...where(c, nameW)], nums]
  }
  // the header: the columns' names, dim, with read and searched in their colors (the legend's colors)
  const numbersHead: Seg[] = [{ s: 'read'.padStart(w.read), fg: COLORS.series[0] }, { s: ' '.repeat(GAP) }, { s: 'searched'.padStart(w.searched), fg: COLORS.series[1] }, { s: ' '.repeat(GAP) }, dim('total'.padStart(totalW))]
  const head: Line[] = tier.two
    ? [pointed([{ s: '  ' }, dim(cut('folder · files', nameW))], false), pointed([{ s: ' '.repeat(2 + TWO_INDENT) }, ...numbersHead], false)]
    : [pointed([{ s: '  ' }, dim(cut('folder · files', nameW).padEnd(nameW)), { s: ' '.repeat(GAP) }, ...numbersHead], false)]
  // each row's lines as one unit, so a list cut to the pane cuts between rows, never inside one
  const units: { key: string | null; lines: Line[] }[] = rows.map((r, i) => ({ key: r.key, lines: rowLines(cells[i]!).map((l, k) => (k === 0 ? pointed(l, r.key === pick) : pointed(l, false))) }))
  if (o.more && o.more > 0) units.push({ key: null, lines: [pointed([{ s: '  ' }, dim(cut(`… ${num(o.more)} more not listed here (the list holds the first ${num(rows.length)})`, cols - 2))], false)] })
  const lines: Line[] = []
  const hits: { y: number; key: string }[] = []
  for (const u of units) {
    for (const l of u.lines) {
      if (u.key !== null) hits.push({ y: lines.length, key: u.key })
      lines.push(l)
    }
  }
  const totalLines: Line[] = totals.length ? [pointed([{ s: '  ' }, { s: '─'.repeat(Math.max(1, cols - 2)), fg: COLORS.rule }], false), ...totals.flatMap(t => rowLines(t).map(l => pointed(l, false)))] : []
  return { head, lines, units, totals: totalLines, hits, picks: rows.map(r => r.key), wide: !tier.two && tier.counts }
}

/** A list of units (a row's one or two lines) cut to `room` lines by windowList over one line a unit, then each unit
 *  drawn whole: the counts of the rows cut off above and below count rows, and no row is cut in half. */
export function windowUnits(key: string, units: readonly { key: string | null; lines: Line[] }[], at: number, room: number, run: (key: string) => (() => Promise<void> | void), bump: () => Promise<void>, cols: number): { lines: Line[]; hits: LineHit[] } {
  const per = Math.max(1, ...units.map(u => u.lines.length))
  const firsts = units.map(u => u.lines[0]!)
  const unitHits: LineHit[] = units.flatMap((u, i) => (u.key === null ? [] : [{ y: i, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: run(u.key) }]))
  // two-line units: the slots leave a line for each count row and two for each unit
  const slots = per === 1 ? room : Math.floor((room - 2) / per) + 1
  // windowList draws a list of fewer than 5 rows whole, as for a pane whose rows are not known; a short pane whose rows
  // are known still cuts it, so the totals and the hints under it stay in view
  if (room > 0 && slots < 5 && units.reduce((n, u) => n + u.lines.length, 0) > room) return shortWindow(units, at, room, per, run, cols)
  const win = windowList(key, firsts, unitHits, at, slots, bump)
  const which = new Map(firsts.map((l, i) => [l, i]))
  const lines: Line[] = []
  const hits: LineHit[] = []
  win.lines.forEach((l, y) => {
    const i = which.get(l)
    const hs = win.hits.filter(h => h.y === y)
    for (const ul of i === undefined ? [l] : units[i]!.lines) {
      for (const h of hs) hits.push({ ...h, y: lines.length })
      lines.push(ul)
    }
  })
  return { lines, hits }
}

/** A list cut to a short pane's `room` lines: the whole rows around the chosen one (`at`), as many as leave a line for
 *  one dim count row under them, which counts the rows cut off above and below (`↑ 3 more · ↓ 1 more`). */
function shortWindow(units: readonly { key: string | null; lines: Line[] }[], at: number, room: number, per: number, run: (key: string) => (() => Promise<void> | void), cols: number): { lines: Line[]; hits: LineHit[] } {
  const n = Math.max(1, Math.floor((room - 1) / per))
  const top = Math.max(0, Math.min(units.length - n, Math.max(0, at) - n + 1))
  const lines: Line[] = []
  const hits: LineHit[] = []
  for (const u of units.slice(top, top + n)) {
    for (const l of u.lines) {
      if (u.key !== null) hits.push({ y: lines.length, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: run(u.key) })
      lines.push(l)
    }
  }
  const down = units.length - top - n
  const words = [top > 0 ? `↑ ${num(top)} more` : '', down > 0 ? `↓ ${num(down)} more` : ''].filter(Boolean).join(' · ')
  if (words) lines.push(pointed([{ s: '  ' }, dim(words)], false))
  return { lines, hits }
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
  const sub: (string | Seg)[] = ['what Claude read or searched in this session']
  const counting: RenderElement[] = st?.counting ? [<Text key="cov-line" dimColor wrap="wrap">◌ counting lines and entries</Text>] : []
  const header = (more: RenderElement[]) => headerEls(els as never, { title: coverageTitle(folder, match), cols, sub: subLine(sub), more })
  if (!got) return <Box flexDirection="column">{[...header(counting), none(cx, e, '◌ reading what this session read')]}</Box>
  if (!got.ok) return <Box flexDirection="column">{[...header(counting), <Text key="cov-error" color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text>]}</Box>
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
  const run = (key: string) => () => {
    picks.set(pickKey, key)
    const r = rows.find(x => x.key === key)
    return r ? open(r) : undefined
  }
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
  // the lines the list has room for under the header (its subtitle, `more` and its rule), the column names, the totals
  // and the hints
  const roomUnder = (more: number) => paneRows() - 1 - (2 + more) - (rows.length ? lay.head.length : 0) - lay.totals.length - hintHeight(hints, cols)
  // the legend in a wide pane only: what gives way first, before a row goes to two lines or the list loses a row
  const legend = rows.length > 0 && lay.wide && width(LEGEND) <= cols && roomUnder(counting.length + 1) >= Math.min(lay.lines.length, LEGEND_ROWS)
  const more = [...(legend ? [linesEl(cx, e, 'coverage-legend', [legendLine()], [], cols)] : []), ...counting]
  const body: RenderElement[] = [...header(more)]
  if (rows.length) body.push(linesEl(cx, e, marginKey('coverage-head'), lay.head, [], cols + MARGIN_W))
  const room = roomUnder(more.length)
  const win = windowUnits(`coverage:${pickKey}`, lay.units, lay.units.findIndex(u => u.key === pick), room, run, () => cx.bumpPanel(), cols)
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
