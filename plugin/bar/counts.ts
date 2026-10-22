// counts.ts: the bar's counts, counted after each of main's turns, beside the conversation (the prompt never waits on
// them): how much of the folder's files Claude touched (`thimble coverage --json`: read, searched, counted or computed
// over; a file only listed by name is not touched), and how many labels the folder has (`thimble label --json`). No
// model call. Both run as the person's command (core/env.ts runThimble), so nothing they read counts as Claude's; the
// coverage is of Claude's own session. One count runs at a time per folder. The last coverage is kept for the coverage
// pane (lastCoverage), and the state's `gen` changes with each count, so what shows it draws again.
import type { EngineInterface } from 'claude-code'

import { rootHere, runThimble, startDir, type Ran } from '../core/env'
import { featureOn } from '../settings/features.mjs'
import { sessionKey } from '../hooks/conversation'
import { busy } from './busy'
import { failNotice } from './fix'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type Counts = { coverage: string | null; labels: number; gen: number; error: string | null }

const COUNTS = { plugin: 'thimble', key: 'counts' } as const

/** How long one count of the folder's coverage may run. The first count of a big folder reads every row of its
 *  tables (about a minute for 18 GB of records); the kernel keeps the row counts, so later counts are quick. A count
 *  stopped early keeps nothing, so a short limit would stop every count of such a folder (10 minutes is the most
 *  Claude Code allows). */
export const COVER_TIMEOUT_MS = 600000
const counting = new Map<string, Promise<Ran>>()
const queued = new Map<string, Promise<Ran>>()
let last: Any = null
let asked = false
let failedOnce = false

/** `thimble coverage --json` of the session's reads in `root`, one count at a time per folder. A count asked for
 *  while one runs is one more count after it (that one began before the newest reads), shared by everyone who asks
 *  meanwhile: so at most one runs and one waits, and the last answer has every read. */
export function coverageOf($: Engine, root: string, session: string): Promise<Ran> {
  const key = `${root}\n${session}`
  const cur = counting.get(key)
  if (cur) {
    let next = queued.get(key)
    if (!next) {
      next = cur.catch(() => undefined).then(() => { queued.delete(key); return coverageOf($, root, session) })
      queued.set(key, next)
    }
    return next
  }
  const p = runThimble($, root, ['coverage', '--json'], { session, timeoutMs: COVER_TIMEOUT_MS }).finally(() => { counting.delete(key) })
  counting.set(key, p)
  return p
}

/** The last coverage counted, as `thimble coverage --json` gave it, or null. */
export function lastCoverage(): Any {
  return last
}

/** A share as the bar says it: 34%, a decimal under 1%, and 100% only when all. */
export function percent(part: number): string {
  if (!(part > 0)) return '0%'
  if (part >= 1) return '100%'
  const p = 100 * part
  if (p < 0.01) return '<0.01%'
  if (p < 0.1) return `${(Math.floor(p * 100) / 100).toFixed(2)}%`
  if (p < 1) return `${(Math.floor(p * 10) / 10).toFixed(1)}%`
  return `${Math.min(99, Math.round(p))}%`
}

/** `part` of `all` files as the bar says it: `43% (3/7 files)`. */
export function shareOfFiles(part: number, all: number): string {
  return `${percent(all ? part / all : 0)} (${part.toLocaleString('en-US')}/${all.toLocaleString('en-US')} ${all === 1 ? 'file' : 'files'})`
}

/** The folder coverage counts: the one under analysis, else the one the session started in (never the home folder). */
async function coverageRoot($: Engine): Promise<string | null> {
  const root = await rootHere($)
  if (root) return root
  const start = await startDir($)
  return start && start !== String((await $.env.get('HOME')) || '').replace(/\/+$/, '') ? start : null
}

/** The last line a failed command said, for a notice. */
const lastLine = (r: Ran) => (r.stderr || r.stdout).trim().split('\n').slice(-1)[0]?.slice(0, 200) || ''

/** The folder's labels, as the kernel lists them. */
async function countLabels($: Engine, root: string): Promise<number> {
  const r = await runThimble($, root, ['label', '--json'])
  try {
    const v = JSON.parse(r.stdout)
    return Array.isArray(v) ? v.length : 0
  } catch {
    throw new Error(lastLine(r) || 'thimble label gave nothing')
  }
}

/** Count again: the bar's coverage and labels, while Labels and coverage is on. A count that fails says so once per
 *  load of the plugin, on the failure line; the pane shows its reason until a count works. */
export async function recount($: Engine): Promise<void> {
  if (!featureOn('counts')) return
  asked = true
  const root = await coverageRoot($)
  if (!root) return
  const was = await countsNow($)
  let coverage = was?.coverage ?? null
  let labels = was?.labels ?? 0
  let error: string | null = null
  try {
    const session = await sessionKey($)
    const r = await busy($, 'counting coverage', () => coverageOf($, root, session))
    let got: Any
    try {
      got = JSON.parse(r.stdout)
    } catch {
      throw new Error(lastLine(r) || 'thimble coverage gave nothing')
    }
    last = got
    const files = Number(got.total?.files) || 0
    coverage = files ? shareOfFiles(Number(got.total?.touched_files) || 0, files) : null
    labels = await countLabels($, root)
  } catch (err) {
    error = String((err as Error)?.message || err).slice(0, 200)
    if (!failedOnce) failNotice($, `Coverage could not be counted: ${error}`)
    failedOnce = true
  }
  await $.state.set(COUNTS, { coverage, labels, gen: (was?.gen ?? 0) + 1, error })
}

/** The bar found nothing counted in this load of the plugin (a new session, a reload, the switch just turned on):
 *  count once, a moment after the drawing. */
export function needCounts($: Engine): void {
  if (asked || !featureOn('counts')) return
  asked = true
  $.clock.after(0, () => { void recount($).catch(() => undefined) })
}

/** The bar's counts as last counted, or null. */
export async function countsNow($: Engine): Promise<Counts | null> {
  return ((await $.state.get(COUNTS)).value ?? null) as Counts | null
}
