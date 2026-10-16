// The panel's fixtures: fixtures.ts, plus what the panel's views read in 0.9.0 (SPEC-v2 C7-C9, C12, C13) and the
// values the transcript's lane keeps in `$.state` (citations drawn, comments on answers, coverage, settings), which a
// test answers here through `state.get` until that lane writes them.
//
//   panelWorld(on)        world() with `thimble state coverage | label-unsure | answer-comments` and `thimble open`
//                         answered from `p`, and the transcript's state values answered from `p.t`
//   aboveAt(columns)      the band above the prompt as Claude Code mounts it
//   paneAt(columns)       the panel's pane, docked
import type { On } from 'claude-code'

import type { AnswerComment, CiteRow, CoverageSummary, FeatureSettings } from '../types'
import type { CoverageRow } from '../coverageview'
import { CLI, world } from './fixtures'
import type { World } from './fixtures'

export * from './fixtures'

export const PANEL = 'thimble'

/** What the transcript's lane would keep in `$.state` (C13), as a test sets it. */
export type Transcript = { citeIndex: CiteRow[]; answerComments: AnswerComment[]; coverageSummary: CoverageSummary | null; settings: FeatureSettings | null; checksRunning: number; verdicts: Record<string, Record<string, unknown>> }

/** A row of `thimble state coverage` (C7). */
export type { CoverageRow }

export type PanelWorld = World & {
  t: Transcript
  /** `thimble state coverage` by `--folder` ('' for the top), or `<folder>|<match>` for a group of a folder's files */
  coverage: Record<string, { rows: CoverageRow[]; counting?: boolean; more?: number }>
  /** `thimble state label-unsure`: each label's counts, and its rows by kind (no-fit first, then unsure) */
  unsure: { id: string; name: string; noFit: number; unsure: number; total: number; rows: { ref: string; value: string | null; confidence: number | null; kind: 'no-fit' | 'unsure'; text: string }[] }[]
  /** what `thimble open` prints (C12), and each open's argv */
  open: Record<string, unknown>
  pressed: string[][]
  /** files that exist for `fs.stat` beyond the stamps (a claim file once claimed) */
  exists: Set<string>
  /** what went on the clipboard */
  copied: string[]
}

export const SUMMARY: CoverageSummary = {
  files: { seen: 3, searched: 1, never: 9, total: 13 },
  records: { seen: 1344, searched: 400, total: 48_450, counted: true },
  totals: [
    { unit: 'records', seen: 1344, searched: 400, total: 48_450, counted: true, files: 12, files_seen: 3, files_searched: 1 },
    { unit: 'files', seen: 1, searched: 0, total: 31 },
  ],
  line: 'seen 3% · searched 0.8% of records',
}

/** A row of `thimble state coverage` with the fields a test leaves out at their empty values. */
export function covRow(o: Partial<CoverageRow> & Pick<CoverageRow, 'key'>): CoverageRow {
  return { folder: '', ext: '', path: null, files: 1, seen: 0, searched: 0, never: 0, records_seen: 0, records_searched: 0, records_total: null, bytes: 0, drill: false, unit: 'records', name: '', match: null, ...o }
}

export const COVERAGE_TOP: CoverageRow[] = [
  covRow({ key: 'forge.db', path: 'forge.db', ext: '.db', name: 'forge.db', searched: 1, records_searched: 587, records_total: 587, bytes: 2_100_000 }),
  covRow({ key: 'dir:agents|.jsonl', folder: 'agents', ext: '.jsonl', name: 'agent-*.jsonl', files: 12, seen: 2, searched: 1, never: 9, records_seen: 1204, records_searched: 400, records_total: 48_310, bytes: 1_200_000, drill: true }),
  covRow({ key: 'dir:images/day-1|.png', folder: 'images/day-1', ext: '.png', name: '.png', unit: 'files', files: 30, seen: 1, never: 29, bytes: 900_000, drill: true }),
  covRow({ key: 'events.jsonl', path: 'events.jsonl', ext: '.jsonl', name: 'events.jsonl', seen: 1, records_seen: 140, records_total: 140, bytes: 40_000 }),
  covRow({ key: 'grp:|run_*.jsonl', ext: '.jsonl', name: 'run_*.jsonl', files: 300, never: 300, records_total: 600, bytes: 30_000, drill: true, match: 'run_*.jsonl' }),
]

export const COVERAGE_AGENTS: CoverageRow[] = [
  covRow({ key: 'agents/agent-01.jsonl', folder: 'agents', ext: '.jsonl', path: 'agents/agent-01.jsonl', name: 'agent-01.jsonl', seen: 1, records_seen: 900, records_total: 4000, bytes: 100_000 }),
  covRow({ key: 'agents/agent-02.jsonl', folder: 'agents', ext: '.jsonl', path: 'agents/agent-02.jsonl', name: 'agent-02.jsonl', seen: 1, records_seen: 304, records_total: 4000, bytes: 100_000 }),
  covRow({ key: 'agents/agent-03.jsonl', folder: 'agents', ext: '.jsonl', path: 'agents/agent-03.jsonl', name: 'agent-03.jsonl', searched: 1, records_searched: 4000, records_total: 4000, bytes: 100_000 }),
]

export const COVERAGE_RUNS: CoverageRow[] = Array.from({ length: 3 }, (_, i) => covRow({ key: `run_000${i}.jsonl`, ext: '.jsonl', path: `run_000${i}.jsonl`, name: `run_000${i}.jsonl`, records_total: 2, bytes: 100 }))

/** A comment of the Important details check on a passage of an answer (C9, as the transcript's lane keeps it). */
export function comment(id: string, over: Partial<AnswerComment> = {}): AnswerComment {
  return {
    id,
    check: 'important-details',
    checkName: 'Important details',
    color: 2,
    about: 'it looks for what a reader would likely miss',
    turn: 'r1',
    row: 'r1',
    ref: `answer:r1#s${id.replace(/\D/g, '') || '1'}`,
    start: 0,
    end: 60,
    quote: 'After 19 June there are 0 new messages to other agents on any page.',
    text: 'The label could not read 899 revisions whose text the dump hides.',
    details: '',
    status: 'open',
    at: '2026-10-16T16:06:00Z',
    ...over,
  }
}

/** world() with the panel's reads (see the file's head), which answer ahead of world()'s. */
export function panelWorld(on: On, opts: { mode?: string; ws?: string | null } = {}): PanelWorld {
  const extra = {
    t: { citeIndex: [], answerComments: [], coverageSummary: null, settings: null, checksRunning: 0, verdicts: {} } as Transcript,
    coverage: { '': { rows: COVERAGE_TOP }, agents: { rows: COVERAGE_AGENTS }, '|run_*.jsonl': { rows: COVERAGE_RUNS, more: 297 } } as PanelWorld['coverage'],
    unsure: [] as PanelWorld['unsure'],
    open: { ok: true, port: 29321, url: 'http://127.0.0.1:29321/?ws=wiki&ref=home', opened: true, remote: false, tunnel: null, et: null, link_file: null, claim_file: '/home/a/.thimble/open/x.claimed', proxy: false } as Record<string, unknown>,
    pressed: [] as string[][],
    exists: new Set<string>(),
    copied: [] as string[],
  }
  const out = (v: unknown, code = 0) => ({ value: { exitCode: code, stdout: JSON.stringify(v), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  // the world the test holds: what a test sets on it is what these answer
  let w: PanelWorld | null = null
  const x = () => (w ?? extra) as PanelWorld
  // the panel's reads, ahead of world()'s answers (`fallback`)
  const run = (e: { argv: readonly string[] }, fallback: () => unknown): unknown => {
    const argv = [...e.argv]
    if (argv[0] !== CLI) return fallback()
    if (argv[1] === 'open') {
      w?.calls.push(argv)
      x().pressed.push(argv)
      return out(x().open)
    }
    if (argv[1] !== 'state') return fallback()
    const what = argv[2]
    const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? '' : '')
    if (what === 'coverage') {
      w?.calls.push(argv)
      const folder = arg('--folder')
      const match = arg('--match')
      const got = x().coverage[match ? `${folder}|${match}` : folder] ?? { rows: [] }
      return out({ summary: x().t.coverageSummary ?? SUMMARY, folder, match: match || null, rows: got.rows, more: got.more ?? 0, counting: Boolean(got.counting) })
    }
    if (what === 'label-unsure') {
      w?.calls.push(argv)
      const id = arg('--label')
      const n = Number(arg('--n') || 20)
      const offset = Number(arg('--offset') || 0)
      if (!id) return out({ labels: x().unsure.map(l => ({ id: l.id, name: l.name, noFit: l.noFit, unsure: l.unsure, total: l.total })) })
      const l = x().unsure.find(x => x.id === id)
      return out({ labels: l ? [{ id: l.id, name: l.name, noFit: l.noFit, unsure: l.unsure, total: l.total, rows: l.rows.slice(offset, offset + n) }] : [] })
    }
    if (what === 'answer-comments') return out({ comments: [], running: [] })
    return fallback()
  }
  const stat = (e: { path: string }, fallback: () => unknown): unknown => (x().exists.has(e.path) ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : fallback())
  // world()'s hooks of these events wrapped by the panel's (an event is hooked once on a test's `on`)
  const wrapped = ((ev: string, ...rest: unknown[]) => {
    const h = rest.at(-1) as ($: unknown, e: never, next: unknown) => unknown
    const head = rest.slice(0, -1)
    if (ev === 'process.run') return (on as unknown as (...a: unknown[]) => unknown)(ev, ...head, ($: unknown, e: never, next: unknown) => run(e, () => h($, e, next)))
    if (ev === 'fs.stat') return (on as unknown as (...a: unknown[]) => unknown)(ev, ...head, ($: unknown, e: never, next: unknown) => stat(e, () => h($, e, next)))
    if (ev === 'ui.copy')
      return (on as unknown as (...a: unknown[]) => unknown)(ev, ...head, ($: unknown, e: { text?: unknown }, next: unknown) => {
        x().copied.push(String(e.text ?? ''))
        return h($, e as never, next)
      })
    return (on as unknown as (...a: unknown[]) => unknown)(ev, ...rest)
  }) as unknown as On
  // this session's id, as Claude Code names its transcript
  on('session.id', (() => ({ value: 's1' })) as never)
  // the transcript's values, as its lane would keep them
  on('state.get', { plugin: PANEL, key: 'citeIndex' } as never, (() => ({ value: { value: x().t.citeIndex, version: 1 } })) as never)
  on('state.get', { plugin: PANEL, key: 'answerComments' } as never, (() => ({ value: { value: x().t.answerComments, version: 1 } })) as never)
  on('state.get', { plugin: PANEL, key: 'coverageSummary' } as never, (() => ({ value: { value: x().t.coverageSummary, version: 1 } })) as never)
  on('state.get', { plugin: PANEL, key: 'settings' } as never, (() => ({ value: { value: x().t.settings, version: 1 } })) as never)
  on('state.get', { plugin: PANEL, key: 'checksRunning' } as never, (() => ({ value: { value: x().t.checksRunning, version: 1 } })) as never)
  // a chat citation's verdict, as the reply's drawing would have it checked, by lib.ts cid of its raw spelling
  on('state.get', { plugin: PANEL, key: 'verdicts' } as never, (($: unknown, e: { id?: string }, next: (e: unknown) => unknown) => (e.id && x().t.verdicts[e.id] ? { value: { value: x().t.verdicts[e.id], version: 1 } } : next(e))) as never)
  w = Object.assign(world(wrapped, opts), extra)
  return w
}

/** Every feature on but those named. */
export function featuresOff(...off: (keyof FeatureSettings)[]): FeatureSettings {
  const all: FeatureSettings = { autoActivate: true, viewProposals: true, labels: true, checks: true, citationMarks: true, coverage: true, cardCheck: true }
  for (const k of off) all[k] = false
  return all
}

/** The band above the prompt, `columns` wide. */
export const aboveAt = (columns: number) => ({ plugin: PANEL, component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns, rows: 40 }, props: { hasSurvey: false, isWorking: false, view: {}, bodyColumns: columns } }) as never

/** The panel's pane, docked, its body `body` columns wide. */
export const paneAt = (body = 96, rows = 40) => ({ plugin: PANEL, component: 'Pane', requestId: PANEL, surface: 'terminal', viewport: { columns: 184 - body, rows: rows + 4 }, props: { title: 'thimble', isFocused: true, bodyColumns: body, placement: 'dock', scroll: { bodyRows: rows }, view: {} } }) as never

/** The words a drawn tree shows, without the hidden keys' labels (their Boxes no row tall). */
export function words(tree: unknown): string {
  const walk = (n: unknown): string => {
    if (typeof n === 'string') return n
    if (Array.isArray(n)) return n.map(walk).join('')
    if (!n || typeof n !== 'object') return ''
    const o = n as { props?: { label?: unknown; children?: unknown; height?: unknown; width?: unknown }; children?: unknown }
    if (o.props?.height === 0) return ''
    // a Button's label is its words (the kit puts the words of its children there too)
    if (typeof o.props?.label === 'string') return o.props.label
    return walk(o.children ?? o.props?.children)
  }
  return walk(tree)
}

/** A press that opens the browser, as the person makes it: the panel opened by `/thimble <args>` (home with none), and
 *  its title row's `↗` pressed (panel.tsx wayRow), which opens the view's object. */
export async function pressBrowser($: { command: { run: (e: never) => Promise<unknown> }; ui: { mount: (e: never) => Promise<unknown> } }, w: { clock: { settle: () => Promise<void> } }, args = ''): Promise<void> {
  await $.command.run({ command: 'thimble:thimble', args } as never)
  await w.clock.settle()
  const m = (await $.ui.mount(paneAt(96))) as { press: (t: { key: string }) => Promise<void>; unmount: () => Promise<void> }
  await m.press({ key: 'way-browser' })
  await w.clock.settle()
  await m.unmount()
}
