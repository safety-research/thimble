// coverage.tsx: the coverage pane (core/pane.ts kind `coverage`): what this session did with the folder's files, from
// the last `thimble coverage --json` (bar/counts.ts lastCoverage; engine/kernel/coverage.py says what each measure
// is). The bar's `r coverage …` opens it, by a click or r.
//
// Overview first: two labeled bars of the folder's files, those read into Claude's context and those searched or
// computed over (the bar's count). Then the folders as a tree, each with its files and the same two measures, in its
// files' own unit (records, rows, lines, pages, whole files), as a line above the columns says, and how many of its
// files Claude touched (a search
// whose lines are not known touches a file without a share of it): those Claude touched first. A press on a folder opens it
// one level (and closes it again); its files nothing touched are one line, which opens to their names. A press on a
// file shows its path (with its first line read), so the terminal can open it, and what was read of it.
//
//   state: paneView/coverage {open: folders open (and `rest:<folder>` for their untouched files), file: the file shown}
import type { EngineInterface } from 'claude-code'

import { countsNow, lastCoverage, percent, shareOfFiles } from '../bar/counts'
import { cut, textWidth } from '../core/text.js'
import { featureOn } from '../settings/features.mjs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const VIEW = { plugin: 'thimble', key: 'paneView', id: 'coverage' } as const
type View = { open: string[]; file: string | null }

/** The colors of the two measures. */
const READ = 'suggestion'
const SEARCHED = 'inactive'
/** Cells of a row's bar at most, and of the overview's at least. */
const BAR = 8
/** Names of untouched files listed when their line is opened, at most. */
const REST_MAX = 200

type Unit = { units: number; seen: number; model: number; computed: number }
type Node = { path: string; files: number; touched: number; units: Map<string, Unit>; readSum: number; countedSum: number; kids: Map<string, Node> }

/** A file's status as the kernel names it (kernel/coverage.py ORDER), in the pane's words. */
const SAID: Record<string, string> = { seen: 'read', model: 'model', searched: 'searched', computed: 'computed', named: 'counted' }
/** Cells of the touched column: `12/340` for a folder, `searched` for a file. */
const TOUCHED = 9

/** A count in a few cells: 9,812, 41k, 1.0M. */
const short = (n: number) => (n < 10000 ? n.toLocaleString('en-US') : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`)

const node = (path: string): Node => ({ path, files: 0, touched: 0, units: new Map(), readSum: 0, countedSum: 0, kids: new Map() })
const len = textWidth
const pad = (s: string, n: number, right = false) => { const t = cut(s, n); const sp = ' '.repeat(Math.max(0, n - len(t))); return right ? sp + t : t + sp }
/** A file's folder as the kernel names it (`runs/r04/`, `./` at the top). */
const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : './')
const nameOf = (p: string) => p.replace(/\/$/, '').slice(p.replace(/\/$/, '').lastIndexOf('/') + 1) + (p.endsWith('/') ? '/' : '')

/** The folder tree of the kernel's groups (one per folder that holds files): each folder adds its files and measures to
 *  itself and every folder above it. */
function folderTree(groups: Any[]): Node {
  const root = node('')
  for (const g of groups || []) {
    const folder = String(g.folder || './')
    const parts = folder === './' ? [] : folder.replace(/\/$/, '').split('/')
    const chain = [root]
    let at = root
    parts.forEach((_, i) => {
      const p = `${parts.slice(0, i + 1).join('/')}/`
      if (!at.kids.has(p)) at.kids.set(p, node(p))
      at = at.kids.get(p)!
      chain.push(at)
    })
    const files = Number(g.files) || 0
    for (const n of chain) {
      n.files += files
      n.touched += Number(g.touched) || 0
      n.readSum += (Number(g.read_share) || 0) * files
      n.countedSum += (Number(g.counted_share) || 0) * files
      for (const u of g.units || []) {
        const m = n.units.get(u.unit) ?? { units: 0, seen: 0, model: 0, computed: 0 }
        m.units += Number(u.units) || 0
        m.seen += Number(u.seen) || 0
        m.model += Number(u.model) || 0
        m.computed += Number(u.computed) || 0
        n.units.set(u.unit, m)
      }
    }
  }
  return root
}

/** A folder's two measures, as the kernel measures a group: in its files' unit when they share one, else the mean of
 *  its files' shares. */
function measures(n: Node): { read: number; searched: number } {
  const us = [...n.units.values()]
  if (us.length === 1 && us[0]!.units) {
    const u = us[0]!
    return { read: Math.min(1, u.seen / u.units), searched: Math.min(1, (u.seen + u.model + u.computed) / u.units) }
  }
  return n.files ? { read: n.readSum / n.files, searched: n.countedSum / n.files } : { read: 0, searched: 0 }
}

const byTouch = (a: Node, b: Node) => b.touched - a.touched || b.files - a.files || a.path.localeCompare(b.path)

export async function drawCoverage($: EngineInterface, e: Any, _args: unknown, els: Any): Promise<unknown> {
  const { Box, Button, Text } = els
  const W = Math.max(40, Number(e.props?.bodyColumns) || 80)
  const counts = await countsNow($)
  const cov = lastCoverage()
  if (!featureOn('counts')) return Text({ dimColor: true, wrap: 'wrap', children: 'Labels and coverage is off. Turn it on in /thimble-settings to count what Claude read.' })
  const failed = counts?.error ? Text({ key: 'failed', color: 'error', wrap: 'wrap', children: `× ${counts.error}${cov ? ' Below is the last count.' : ''}` }) : null
  if (!cov) return failed ?? Text({ dimColor: true, children: 'Counting what Claude touched…' })
  const view = ((await $.state.get(VIEW)).value ?? { open: [], file: null }) as View
  const open = new Set(view.open)
  const setView = (v: Partial<View>) => $.state.set(VIEW, { ...view, ...v })
  const flip = (key: string) => () => { const next = new Set(open); if (next.has(key)) next.delete(key); else next.add(key); return setView({ open: [...next] }) }

  const total = cov.total || {}
  const all = Number(total.files) || 0
  const bar = (share: number, w: number, color: string, k: string) => {
    const n = share > 0 ? Math.max(1, Math.min(w, Math.round(share * w))) : 0
    return [Text({ key: `${k}-on`, color, children: '█'.repeat(n) }), Text({ key: `${k}-off`, dimColor: true, children: '░'.repeat(w - n) })]
  }
  // the overview's bars as wide as the row leaves them, up to 24 cells; in a narrow pane its label stands on a row of
  // its own, so the counts are never cut
  const said = (part: number) => shareOfFiles(part, all)
  const saidW = Math.max(len(said(Number(total.seen_files) || 0)), len(said(Number(total.touched_files) || 0)))
  const labelW = W - 30 - saidW >= BAR ? 28 : 0
  const big = Math.max(BAR, Math.min(24, W - labelW - 2 - saidW))
  const overview = (label: string, part: number, color: string, k: string) => {
    const counts = [...bar(all ? part / all : 0, big, color, k), Text({ key: `${k}-n`, children: `  ${said(part)}` })]
    if (labelW) return Text({ key: k, wrap: 'truncate-end', children: [Text({ key: `${k}-label`, children: pad(label, labelW) }), ...counts] })
    return Box({ key: k, flexDirection: 'column', children: [Text({ key: `${k}-label`, children: label }), Text({ key: `${k}-bar`, wrap: 'truncate-end', children: counts })] })
  }

  // the rows: a folder's own row, its sub-folders and its files when open
  const tree = folderTree(cov.groups || [])
  const files = (cov.files || []) as Any[]
  const untouched: string[] = Array.isArray(cov.untouched?.path) ? cov.untouched.path : []
  // a row is its name, the touched column and two measures (a bar and its percent): in a narrow pane the bars give
  // way first, so a name keeps 14 cells and the row never wraps
  const barW = Math.max(2, Math.min(BAR, Math.floor((W - 19 - TOUCHED - 14) / 2)))
  const nameW = (depth: number) => Math.max(6, W - 2 * depth - 20 - TOUCHED - 2 * barW)
  const measureCells = (m: { read: number; searched: number }, k: string) => [
    Text({ key: `${k}-g1`, children: ' ' }), ...bar(m.read, barW, READ, `${k}-r`), Text({ key: `${k}-rp`, children: pad(percent(m.read), 7, true) }),
    Text({ key: `${k}-g2`, children: '  ' }), ...bar(m.searched, barW, SEARCHED, `${k}-s`), Text({ key: `${k}-sp`, children: pad(percent(m.searched), 7, true) }),
  ]
  const rows: Any[] = []
  // a row of a folder or a file: its name, then its columns; a name too long for its column stands whole on a line of
  // its own above them, since names that start alike differ at their end (`…__specified`, `…__underspecified`)
  const named = (key: string, label: string, lead: string, name: string, depth: number, look: Any, onPress: () => unknown, cells: Any[]) => {
    const w = nameW(depth)
    if (len(name) <= w) {
      rows.push(Button({ key, plain: true, label, onPress, children: [Text({ key: 'n', ...look, children: `${lead}${pad(name, w)} ` }), ...cells] }))
      return
    }
    rows.push(Button({ key: `${key}:name`, plain: true, label, onPress, children: [Text({ key: 'n', ...look, children: `${lead}${cut(name, W - len(lead), true)}` })] }))
    rows.push(Button({ key, plain: true, label, onPress, children: [Text({ key: 'n', children: ' '.repeat(len(lead) + w + 1) }), ...cells] }))
  }
  const fileRows = (folder: string, depth: number) => {
    const ind = '  '.repeat(depth)
    const mine = files.filter(f => folderOf(String(f.path)) === folder).sort((a, b) => (b.counted_share || 0) - (a.counted_share || 0) || String(a.path).localeCompare(String(b.path)))
    for (const f of mine) {
      const path = String(f.path)
      const shown = view.file === path
      named(`file:${path}`, path, `${ind}  `, nameOf(path), depth, shown ? { bold: true } : {}, () => setView({ file: shown ? null : path }), [
        Text({ key: 'f', dimColor: true, children: pad(SAID[String(f.status)] || '', TOUCHED, true) }),
        ...measureCells({ read: Number(f.read_share) || 0, searched: Number(f.counted_share) || 0 }, 'm'),
      ])
      if (shown) {
        const first = Array.isArray(f.ranges) && f.ranges.length ? Number(f.ranges[0][0]) : 0
        // the whole path where it fits on one line (a terminal opens it), else the folder's own
        const line = first ? `:${first}` : ''
        const at = `${String(cov.root || '').replace(/\/+$/, '')}/${path}${line}`
        const ranges = (f.ranges || []).slice(0, 12).map((r: number[]) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`)).join(', ')
        rows.push(Box({ key: `detail:${path}`, flexDirection: 'column', marginLeft: 2 * depth + 4, children: [
          Text({ key: 'path', wrap: 'truncate-start', children: at.length <= W - 2 * depth - 4 ? at : `${path}${line}` }),
          Text({ key: 'said', dimColor: true, wrap: 'wrap', children: `${String(f.said || '')}${ranges && (f.unit === 'lines' || f.unit === 'records') ? ` · lines ${ranges}` : ''}` }),
        ] }))
      }
    }
    // the folder's files nothing touched: one line, which opens to their names
    const n = untouched.filter(p => folderOf(p) === folder)
    const own = (cov.groups || []).find((g: Any) => g.folder === folder)
    const rest = Math.max(n.length, (Number(own?.files) || 0) - mine.length)
    if (!rest) return
    const key = `rest:${folder}`
    rows.push(Button({ key, plain: true, label: `${rest} files, none touched`, onPress: flip(key), children: [Text({ key: 'r', dimColor: true, children: `${ind}  ${open.has(key) ? '▾' : '▸'} ${rest.toLocaleString('en-US')} ${rest === 1 ? 'file' : 'files'}, none touched` })] }))
    if (open.has(key)) {
      for (const p of n.slice(0, REST_MAX)) rows.push(Text({ key: `u:${p}`, dimColor: true, children: `${ind}      ${cut(nameOf(p), W - 2 * depth - 6)}` }))
      if (rest > Math.min(n.length, REST_MAX)) rows.push(Text({ key: `u-more:${folder}`, dimColor: true, children: `${ind}      and ${(rest - Math.min(n.length, REST_MAX)).toLocaleString('en-US')} more` }))
    }
  }
  const folderRows = (at: Node, depth: number) => {
    for (const k of [...at.kids.values()].sort(byTouch)) {
      const isOpen = open.has(k.path)
      named(`dir:${k.path}`, k.path, `${'  '.repeat(depth)}${isOpen ? '▾' : '▸'} `, nameOf(k.path), depth, k.touched ? {} : { dimColor: true }, flip(k.path), [
        Text({ key: 'f', dimColor: true, children: pad(`${short(k.touched)}/${short(k.files)}`, TOUCHED, true) }),
        ...measureCells(measures(k), 'm'),
      ])
      if (isOpen) {
        folderRows(k, depth + 1)
        fileRows(k.path, depth + 1)
      }
    }
  }
  folderRows(tree, 0)
  fileRows('./', 0)

  return Box({ flexDirection: 'column', width: W, children: [
    Text({ key: 'title', bold: true, children: 'Coverage' }),
    ...(failed ? [failed] : []),
    overview("read into Claude's context", Number(total.seen_files) || 0, READ, 'o-read'),
    overview('searched or computed over', Number(total.touched_files) || 0, SEARCHED, 'o-searched'),
    Text({ key: 'gap', children: ' ' }),
    Text({ key: 'units', dimColor: true, wrap: 'wrap', children: 'files: touched of all · read, searched: the share of their lines or records' }),
    Text({ key: 'head', dimColor: true, children: `  ${pad('folder', nameW(0))} ${pad('files', TOUCHED, true)} ${pad('read', barW + 7)}  ${pad('searched', barW + 7)}` }),
    ...rows,
  ] })
}
