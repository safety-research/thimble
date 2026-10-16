// The Coverage view (SPEC-v2 J5, 3.9): what this session's tool calls read of the corpus's data files, from
// `thimble state coverage --session <sid> [--folder <rel>]` (C7). At most 10 rows a level, grouped by folder and file type
// (records first, files in brackets, a bar of the files seen, searched and never opened, the size), or one row per file
// at a level of 20 files or fewer. Enter on a folder's row drills into it (the same view one level down, `b` back), on a
// file's row opens 0.8.0's file view; `o` and the title row's `↗` open Files in the browser at the folder.
//
//   home › coverage
//   what this session's tool calls read, searched or never opened
//   saw 2% of records (3 of 13 files)
//   ───────────────────────────────────────────────────────────────
//     folder and type        records          files          seen searched never   size
//   ❯ agents/  .jsonl   1,204 of 48,310    (2 of 12)   ███▓░░░░░░░░░░░░░    1.2 MB
//     seen ■  searched ■  never ■
import type { RenderElement } from 'claude-code'

import type { TermPanel } from './types'
import { MARGIN_W, headerEls, marginKey, pointed, setBrowser, spread, subLine } from './chrome'
import type { Ctx, SurfaceGot } from './ctx'
import type { Line, Seg } from './draw'
import { cut, noControls, width } from './lib'
import { linesEl } from './lines'
import type { LineHit } from './lines'
import { COLORS } from './paint'
import type { PaneEvent } from './panel'
import { drawsView, hintHeight, hintsRow, none, openFile, paneRows, windowList } from './panel'
import { loadsView, navOrigin, openPanel, readSurface, rt, surfaceValue } from './term'

/** A row of `thimble state coverage` (C7). */
export type CoverageRow = { key: string; folder: string; ext: string; path: string | null; files: number; seen: number; searched: number; never: number; records_seen: number; records_total: number | null; bytes: number; drill: boolean }

type CoverageState = { summary?: { line?: string }; folder?: string; rows?: CoverageRow[]; counting?: boolean }

/** The bar's cells: the files seen, searched and never opened in shares of BAR cells. */
const BAR = 20
const num = (n: number) => Math.round(n).toLocaleString('en-US')
const dim = (s: string): Seg => ({ s, fg: COLORS.dim })

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

/** A bar of `w` cells: seen █, searched ▓, never ░, each by its share of the files, the cells left over to the largest. */
export function coverageBar(r: Pick<CoverageRow, 'seen' | 'searched' | 'never' | 'files'>, w = BAR): Seg[] {
  const parts = [r.seen, r.searched, r.never]
  const total = parts.reduce((a, b) => a + b, 0) || r.files
  if (!total) return [{ s: ' '.repeat(w) }]
  const cells = parts.map(n => (n * w) / total)
  const out = cells.map(Math.floor)
  const order = cells.map((c, i) => ({ i, r: c - Math.floor(c) })).sort((a, b) => b.r - a.r)
  for (let k = 0, left = w - out.reduce((a, b) => a + b, 0); k < left; k++) out[order[k % 3]!.i]!++
  return [
    { s: '█'.repeat(out[0]!), fg: COLORS.series[0] },
    { s: '▓'.repeat(out[1]!), fg: COLORS.series[1] },
    { s: '░'.repeat(out[2]!), fg: COLORS.rule },
  ].filter(x => x.s)
}

/** A row's words in its columns: its name (a file's name, or a folder then its type in a column `folderW` wide),
 *  records, files, size. */
function rowCells(r: CoverageRow, folderW: number): { name: string; records: string; files: string; size: string } {
  const name = r.path ? noControls(r.path.split('/').at(-1) ?? r.path) : `${cut(noControls(r.folder || '.'), folderW).padEnd(folderW)}  ${noControls(r.ext || '(none)')}`
  const records = r.records_total === null ? '–' : `${num(r.records_seen)} of ${num(r.records_total)}`
  return { name, records, files: `(${num(r.seen)} of ${num(r.files)})`, size: sizeWords(r.bytes) }
}

/** The rows as lines in a type area `cols` wide: a header row, one line a row (`▸` on a folder's), the legend. The bar
 *  goes first where the columns do not fit, then the files. */
export function coverageLines(rows: readonly CoverageRow[], pick: string, cols: number): { lines: Line[]; hits: { y: number; key: string }[]; picks: string[] } {
  const folderW = Math.min(24, Math.max(1, ...rows.filter(r => !r.path).map(r => width(noControls(r.folder || '.')))))
  const cells = rows.map(r => rowCells(r, folderW))
  const recW = Math.max('records'.length, ...cells.map(c => width(c.records)))
  const filesW = Math.max('files'.length, ...cells.map(c => width(c.files)))
  const sizeW = Math.max('size'.length, ...cells.map(c => width(c.size)))
  const fixed = (bar: boolean, files: boolean) => 2 + recW + 2 + (files ? filesW + 2 : 0) + (bar ? BAR + 2 : 0) + sizeW
  const nameMin = 14
  const bar = cols - fixed(true, true) >= nameMin
  const files = bar || cols - fixed(false, true) >= nameMin
  const nameW = Math.max(8, cols - fixed(bar, files))
  const right = (c: { records: string; files: string; size: string }, r: CoverageRow | null): Line => [
    { s: c.records.padStart(recW) },
    ...(files ? [{ s: '  ' }, dim(c.files.padEnd(filesW))] : []),
    ...(bar ? [{ s: '  ' }, ...(r ? coverageBar(r) : [dim('seen searched never'.padEnd(BAR).slice(0, BAR))])] : []),
    { s: '  ' },
    dim(c.size.padStart(sizeW)),
  ]
  const lines: Line[] = []
  const hits: { y: number; key: string }[] = []
  // the header row: the columns' names, dim
  lines.push(pointed(spread([dim(`  ${rows.some(r => r.path) ? 'file' : 'folder and type'}`)], right({ records: 'records', files: 'files', size: 'size' }, null).map(x => ({ ...x, fg: COLORS.dim })), cols), false))
  rows.forEach((r, i) => {
    const c = cells[i]!
    hits.push({ y: lines.length, key: r.key })
    lines.push(pointed(spread([{ s: r.drill ? '▸ ' : '  ' }, { s: cut(c.name, nameW - 2) }], right(c, r), cols), r.key === pick))
  })
  if (!rows.length) lines.push(pointed([{ s: '  ' }, dim('no data files read yet')], false))
  // the legend, one hue a word
  lines.push(pointed([dim('  seen '), { s: '■', fg: COLORS.series[0] }, dim('  searched '), { s: '■', fg: COLORS.series[1] }, dim('  never '), { s: '■', fg: COLORS.rule }], false))
  return { lines, hits, picks: rows.map(r => r.key) }
}

// the row the keys chose, by the folder shown
const picks = new Map<string, string>()

/** The Coverage view opened in the panel (SPEC-v2 C13), at `folder` ('' or none for the corpus's top). */
export async function openCoverage(cx: Ctx, folder?: string): Promise<void> {
  const f = (folder ?? '').replace(/^\.\/?/, '').replace(/\/+$/, '')
  await openPanel(cx, { view: 'coverage', title: 'Coverage', ...(f ? { path: f } : {}) })
}

/** The state key of a level's coverage. */
const keyOf = (folder: string) => `coverage:${folder}`

async function loadCoverage(cx: Ctx, p: TermPanel): Promise<void> {
  if (!rt.sc) return
  const sid = await cx.sessionId()
  const folder = p.path ?? ''
  await readSurface(cx, keyOf(folder), 'coverage', [...(sid ? ['--session', sid] : []), ...(folder ? ['--folder', folder] : [])])
}

async function drawCoverage(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e)
  const { Box, Text } = els
  const cols = Math.max(30, e.props.bodyColumns)
  const folder = p.path ?? ''
  setBrowser(`files:${folder}`)
  const got = (await surfaceValue<CoverageState>(cx, keyOf(folder))) as SurfaceGot | undefined
  const summary = await cx.coverageSummary()
  const st = got?.ok ? (got.value as CoverageState) : null
  const words = noControls(st?.summary?.line || summary?.line || '')
  const sub: (string | Seg)[] = ["what this session's tool calls read, searched or never opened"]
  const body: RenderElement[] = [...headerEls(els as never, { title: folder ? `${folder}/` : 'Coverage', cols, sub: subLine(sub), more: words || st?.counting ? [<Text key="cov-line" wrap="wrap">{words}{st?.counting ? <Text dimColor>{`${words ? ' · ' : ''}◌ counting records`}</Text> : null}</Text>] : [] })]
  if (!got) return <Box flexDirection="column">{[...body, none(cx, e, '◌ reading what this session read')]}</Box>
  if (!got.ok) return <Box flexDirection="column">{[...body, <Text key="cov-error" color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text>]}</Box>
  const rows = (st?.rows ?? []).filter(r => r && typeof r.key === 'string')
  const pick = rows.find(r => r.key === picks.get(folder))?.key ?? rows[0]?.key ?? ''
  const lay = coverageLines(rows, pick, cols)
  // an open from the view stands on the panel's trail after it (home › coverage › agents/), as a press in the panel does
  const open = async (r: CoverageRow) => {
    if (!r.path && !r.drill) return
    await navOrigin(cx, true)
    await (r.path ? openFile(cx, r.path) : openCoverage(cx, drillFolder(folder, r)))
  }
  const step = (d: number) => {
    const at = lay.picks.indexOf(pick)
    picks.set(folder, lay.picks[Math.max(0, Math.min(lay.picks.length - 1, at + d))] ?? '')
    return cx.bumpPanel()
  }
  const hits: LineHit[] = lay.hits.map(h => ({ y: h.y, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: () => {
    picks.set(folder, h.key)
    const r = rows.find(x => x.key === h.key)
    return r ? open(r) : undefined
  } }))
  const hints = ['↑↓ to choose', ...(rows.some(r => r.drill || r.path) ? ['Enter to open a folder or a file'] : []), 'o to open Files in the browser', ...(folder ? ['b to go back'] : []), 'x to close']
  const room = paneRows() - 1 - body.length - hintHeight(hints, cols)
  const at = lay.lines.findIndex((_, y) => lay.hits.some(h => h.y === y && h.key === pick))
  const win = windowList(`coverage:${folder}`, lay.lines, hits, at, room, () => cx.bumpPanel())
  const onKey = (k: string) => {
    if (k === 'up' || k === 'k') return step(-1)
    if (k === 'down' || k === 'j') return step(1)
    if (k === 'return' || k === 'enter') {
      const r = rows.find(x => x.key === pick)
      return r ? open(r) : undefined
    }
    return undefined
  }
  body.push(linesEl(cx, e, marginKey('coverage-list'), win.lines, win.hits, cols + MARGIN_W, onKey))
  body.push(hintsRow(els as never, hints, cols))
  return <Box flexDirection="column">{body}</Box>
}

/** The Coverage view's read and drawing registered with the panel (views.ts registerPanelViews). */
export function registerCoverageView(): void {
  loadsView('coverage', loadCoverage)
  drawsView('coverage', drawCoverage)
}
