// counts.ts: the bar's counts, counted after each of main's turns: how much of the folder's files Claude touched
// (`thimble coverage --json`: read, searched, counted or computed over; a file only listed by name is not touched)
// and how many labels the folder has. No model call. The coverage is counted for Claude's own session, as the
// person's command (core/env.ts runThimble), one count at a time per folder; the last one is kept for the coverage
// pane (lastCoverage).
import type { EngineInterface } from 'claude-code'

import { labelsDir, rootHere, runThimble, startDir, type Ran } from '../core/env'
import { featureOn } from '../settings/features.mjs'
import { sessionKey } from '../hooks/conversation'
import { busy } from './busy'
import { failNotice } from './fix'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const COUNTS = { plugin: 'thimble', key: 'counts' } as const

/** How long one count of the folder's coverage may run. The first count of a big folder reads every row of its
 *  tables (about a minute for 18 GB of records); the kernel keeps the row counts, so later counts are quick. A count
 *  stopped early keeps nothing, so a short limit would stop every count of such a folder (10 minutes is the most
 *  Claude Code allows). */
export const COVER_TIMEOUT_MS = 600000
const counting = new Map<string, Promise<Ran>>()
const queued = new Map<string, Promise<Ran>>()
let last: Any = null
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

async function countLabels($: Engine, root: string | null): Promise<number> {
  if (!root) return 0
  try {
    const xs = await $.fs.list((await labelsDir($, root)) ?? `${root.replace(/\/+$/, '')}/thimble/labels`)
    return xs.filter(x => x.name.endsWith('.json') && !x.name.startsWith('.')).length
  } catch {
    return 0
  }
}

/** The folder coverage counts: the one under analysis, else the one the session started in (never the home folder). */
async function coverageRoot($: Engine): Promise<string | null> {
  const root = await rootHere($)
  if (root) return root
  const start = await startDir($)
  return start && start !== String((await $.env.get('HOME')) || '').replace(/\/+$/, '') ? start : null
}

/** Count again: the bar's coverage and labels, while the `counts` switch is on. A first count that fails says so once. */
export async function recount($: Engine): Promise<void> {
  if (!featureOn('counts')) return
  const root = await coverageRoot($)
  let coverage = ((await $.state.get(COUNTS)).value ?? null)?.coverage ?? null
  if (root) {
    try {
      const session = await sessionKey($)
      const r = await busy($, 'counting coverage', () => coverageOf($, root, session))
      let got: Any
      try {
        got = JSON.parse(r.stdout)
      } catch {
        throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-1)[0]?.slice(0, 200) || 'thimble coverage gave nothing')
      }
      last = got
      const files = Number(got.total?.files) || 0
      const touched = Number(got.total?.touched_files) || 0
      coverage = files ? `${percent(touched / files)} (${touched.toLocaleString('en-US')}/${files.toLocaleString('en-US')} files)` : null
    } catch (err) {
      if (!failedOnce) failNotice($, `× Coverage could not be counted: ${String((err as Error)?.message || err).slice(0, 200)}.`)
      failedOnce = true
    }
  }
  await $.state.set(COUNTS, { coverage, labels: await countLabels($, await rootHere($)) })
}

/** The bar's counts as last counted, or null. */
export async function countsNow($: Engine): Promise<{ coverage: string | null; labels: number } | null> {
  return ((await $.state.get(COUNTS)).value ?? null) as { coverage: string | null; labels: number } | null
}
