// counts.ts: the bar's counts, counted after each of main's turns, beside the conversation (the prompt never waits on
// them): how much of the folder's files Claude touched (`thimble coverage --json`: read, searched or computed
// over; a file only listed by name is not touched), and how many labels the folder has (`thimble label --json`). No
// model call. Both run as the person's command (core/env.ts runThimble), so nothing they read counts as Claude's; the
// coverage is of Claude's own session. One count runs at a time per folder. The last coverage is kept for the coverage
// pane (lastCoverage), and the state's `gen` changes with each count, so what shows it draws again.
//
// The last count is kept in the conversation's folder too (coverage.json, core/layout.mjs): a load of the plugin (a
// reload, a setting changed, a resumed session) shows it on the bar and in the pane while the new count runs. A count
// that a reload stopped goes on in the next: the kernel keeps each file it counted, and the bar's time for the count
// goes on from when it began (the state's `since`, which a reload keeps).
import type { EngineInterface } from 'claude-code'

import { readKept, rootHere, runThimble, startDir, writeKept, type Ran } from '../core/env'
import { featureOn } from '../settings/features.mjs'
import { sessionKey } from '../hooks/conversation'
import { busy } from './busy'
import { failCleared, failNotice } from './notice'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** `since`: when the count that runs began (the session's clock), null while none runs. */
export type Counts = { coverage: string | null; labels: number; gen: number; error: string | null; since?: number | null }

const COUNTS = { plugin: 'thimble', key: 'counts' } as const
/** The conversation's last count of a folder, in its folder: the bar's words, the labels and the kernel's record (the
 *  pane's). */
const LAST_FILE = 'coverage.json'
type LastCount = { root: string; coverage: string | null; labels: number; record: Any }

/** How long one run of `thimble coverage` may take (10 minutes is the most Claude Code allows), and the seconds after
 *  which the kernel stops counting the folder's files, keeps what it counted and says how far it got, so that the run
 *  ends in that time. The first count of a big folder on a slow disk reads every file, which can take longer: it then
 *  runs again at once and goes on from where it stopped, while each run counts more of the folder. */
export const COVER_TIMEOUT_MS = 600000
export const COVER_WITHIN_S = 480
const counting = new Map<string, Promise<Ran>>()
const queued = new Map<string, Promise<Ran>>()
let last: Any = null
let asked = false

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
  const p = countAll($, root, session).finally(() => { counting.delete(key) })
  counting.set(key, p)
  return p
}

/** One count, in as many runs as the kernel needs: a run that stopped at its time with files left to count runs again,
 *  and one that counted no more of them than the run before ends the count, saying why. */
async function countAll($: Engine, root: string, session: string): Promise<Ran> {
  let before = -1
  for (;;) {
    const r = await runThimble($, root, ['coverage', '--json', '--within', String(COVER_WITHIN_S)], { session, timeoutMs: COVER_TIMEOUT_MS })
    const left = stillCounting(r)
    if (!left) return r
    if (left.counted <= before) throw new Error(`counting the folder's ${left.files.toLocaleString('en-US')} files went no further in ${COVER_WITHIN_S / 60} minutes`)
    before = left.counted
  }
}

/** The kernel's word that it stopped counting at its time, with how many of the folder's files it has counted; null
 *  for any other result. */
function stillCounting(r: Ran): { counted: number; files: number } | null {
  if (r.code !== 0 || r.stdout.length > 300) return null
  try {
    const c = JSON.parse(r.stdout)?.counting
    return c && Number.isFinite(Number(c.counted)) ? { counted: Number(c.counted), files: Number(c.files) || 0 } : null
  } catch {
    return null
  }
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

/** The coverage of a folder with nothing to count (no files, or a count that printed nothing and ended well): the bar
 *  names no coverage, and the pane says the folder holds no files. */
const EMPTY_COVERAGE = { files: [], untouched: {}, groups: [], types: [], total: { files: 0, touched_files: 0, seen_files: 0 } }

/** The folder coverage counts: the one under analysis, else the one the session started in (never the home folder). */
export async function coverageRoot($: Engine): Promise<string | null> {
  const root = await rootHere($)
  if (root) return root
  const start = await startDir($)
  return start && start !== String((await $.env.get('HOME')) || '').replace(/\/+$/, '') ? start : null
}

/** A command's record read as JSON, or an error that says in words why there is none: the last line of its errors,
 *  else its exit. Its output itself is never the reason, since it is the record cut short. A command that ended well
 *  and printed nothing has nothing to count: `empty`, when given, is its record. */
function record(r: Ran, what: string, empty?: Any): Any {
  if (empty !== undefined && r.code === 0 && !r.stdout.trim() && !r.stderr.trim()) return empty
  try {
    return JSON.parse(r.stdout)
  } catch {
    const said = r.stderr.trim().split('\n').slice(-1)[0]?.slice(0, 160)
    throw new Error(said || (r.code ? `${what} stopped with exit code ${r.code}` : r.cut ? `${what} gave a record longer than Claude Code reads (4 MiB)` : `${what} gave no record thimble could read`))
  }
}

/** The folder's labels, as the kernel lists them. */
async function countLabels($: Engine, root: string): Promise<number> {
  const v = record(await runThimble($, root, ['label', '--json']), 'thimble label')
  return Array.isArray(v) ? v.length : 0
}

/** What the person can do about a count that failed. Each of Claude's replies counts again, and the failure line goes
 *  once a count works, so a failure that stays is thimble's to fix. */
const FIX = 'Type /thimble-fix to ask for a fix.'

/** Count again: the bar's coverage and labels, while Coverage or Labels is on, each on its own. A count that fails
 *  says so on the failure line, and the pane shows its reason above the last count until a count works. */
export async function recount($: Engine): Promise<void> {
  if (!featureOn('coverage') && !featureOn('labels')) return
  asked = true
  const root = await coverageRoot($)
  if (!root) return
  const session = await sessionKey($)
  const was = await whileCounting($, root)
  let coverage = was.coverage
  let labels = was.labels
  let error: string | null = null
  const why = (err: unknown) => String((err as Error)?.message || err).slice(0, 200).replace(/\.$/, '')
  let got: Any = null
  try {
    got = record(await busy($, 'counting coverage', () => coverageOf($, root, session), was.since ?? undefined), 'thimble coverage', EMPTY_COVERAGE)
    const files = Number(got.total?.files) || 0
    coverage = files ? shareOfFiles(Number(got.total?.touched_files) || 0, files) : null
  } catch (err) {
    error = `Coverage could not be counted: ${why(err)}. ${FIX}`
  }
  try {
    labels = await countLabels($, root)
  } catch (err) {
    error ??= `The labels could not be counted: ${why(err)}. ${FIX}`
  }
  // a count of a conversation the session left (a /clear, a /resume) while it ran: the new one counts its own
  if (session !== (await sessionKey($))) return
  if (got) {
    last = got
    await writeKept($, LAST_FILE, { root, coverage, labels, record: got } satisfies LastCount).catch(() => undefined)
  }
  if (error) failNotice($, error, 'coverage')
  const counts = { coverage, labels, gen: was.gen + 1, error, since: null }
  await $.state.set(COUNTS, counts)
  kept = { counts }
  if (!error) await failCleared($, 'coverage')
}

/** What the bar and the pane show while a count runs, set in the state: the last count, this load's, else the one the
 *  conversation kept of `root` (at a reload, a setting changed, a resumed session); and when the count began. A count
 *  that a reload stopped goes on in this one (the kernel kept each file it counted), so its time goes on too. */
async function whileCounting($: Engine, root: string): Promise<Counts> {
  const was = await countsNow($)
  const counts: Counts = { coverage: was?.coverage ?? null, labels: was?.labels ?? 0, gen: (was?.gen ?? 0) + 1, error: was?.error ?? null, since: was?.since ?? Number(await $.clock.now()) }
  if (!last || !counts.coverage) {
    const k = await readKept<LastCount>($, LAST_FILE)
    if (k?.root === root && k.record) {
      last ??= k.record
      if (!counts.coverage) Object.assign(counts, { coverage: k.coverage ?? null, labels: Number(k.labels) || 0 })
    }
  }
  await $.state.set(COUNTS, counts)
  kept = { counts }
  return counts
}

/** A /clear or a /resume (hooks/turnover.ts): the bar and the coverage pane show nothing of the earlier conversation,
 *  and the new one is counted once, a moment after (from the hook that noticed it), its last count shown meanwhile. */
export async function turnCounts($: Engine): Promise<void> {
  last = null
  asked = false
  await $.state.set(COUNTS, null)
  kept = { counts: null }
  needCounts($)
}

/** Nothing is counted yet in this load of the plugin (a new or resumed session, a reload, the switch just turned on,
 *  which loads the plugin again): count once, a moment after. Asked from a hook (register.ts at session.start,
 *  turnCounts), never from a drawing: Claude Code stops every call a drawing's hook made that still runs when a newer
 *  drawing replaces it, as at a resume (the marks and claims read back, a light theme read for the first time), and
 *  a count asked from there ended `aborted`. With both switches off, a count a reload stopped does not go on: a later
 *  one keeps no time from it. */
export function needCounts($: Engine): void {
  if (asked) return
  if (!featureOn('coverage') && !featureOn('labels')) {
    void countsNow($).then(c => (c?.since != null ? $.state.set(COUNTS, { ...c, since: null }) : undefined)).catch(() => undefined)
    return
  }
  asked = true
  $.clock.after(0, () => { void recount($).catch(() => undefined) })
}

/** The bar's counts as last counted, or null. */
export async function countsNow($: Engine): Promise<Counts | null> {
  return ((await $.state.get(COUNTS)).value ?? null) as Counts | null
}

// The counts as this module last wrote or read them: it alone writes them, so the copy is the state's. r and l at an
// empty prompt read the copy (bar.tsx barKeys), since a key's hook has a few milliseconds of its own time. A drawing
// reads the state itself (countsNow), so a change draws again.
let kept: { counts: Counts | null } | null = null

export async function keptCounts($: Engine): Promise<Counts | null> {
  return (kept ?? (kept = { counts: await countsNow($) })).counts
}
