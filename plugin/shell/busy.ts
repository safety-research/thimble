// busy.ts: the work thimble runs beside Claude's own turn, in one place, so the person always sees what runs. Claude
// Code's spinner covers only Claude's main turn; this one line covers the rest, and it is thimble's only sign of work:
// no pane, message or panel draws a spinner or a still ◌ of its own. Each job is a step named in plain words, the
// same words the browser's busy line uses (browser/frontend/src/lib/busy.ts):
//
//   checking citations          the healing pass over an answer's citations (shell.tsx runHeal, healOfText)
//   counting coverage           `thimble coverage`: the bar's count, the Coverage pane, the observer's evidence
//   adding explainers, …        the observer's look, named by the lenses it asks (observer.ts lookWord)
//   writing a longer explainer  an explainer written again at length (expand.ts, by its feature)
//   rewriting / writing a catch-up   a squeeze of a message, or a catch-up of replies (squeeze/term.ts)
//   labeling                    a model label reading records (labels.ts, by its feature)
//   reading labels              `thimble label --json` for the Labels pane (dock.ts)
//   mapping claims              a map of the folder's claims, until its card comes in (claims/term.ts)
//   drawing a card              v's card, until its agent ends (aside.ts)
//   answering: <thread>         a side thread's answer, until its agent ends (thread.ts)
//   opening the citation        `thimble resolve` for a citation the person opened (shell.tsx resolveJson)
//   fixing: <title>             a fix Claude works on, while its record says `working` (fix.ts refreshFixes)
//   turning the fix on, …       `thimble fix <verb>` as the person's own command (fix.ts kernel)
//
//   busy($, word, work)       runs `work` as a job named by its step; its end (or failure) ends the job. tracked()
//                             (telemetry.ts) does this for every model call, so a new call shows without code of its
//                             own.
//   busyWhile($, word, alive) a job that ends when `alive()` says false (checked at each tick): work that another
//                             hook ends, such as a side thread's subagent, whose turn ends in turn.complete.
//   busyNow($)                what the bar shows: the newest job that has run SHOW_MS or more (the step the person
//                             most likely just started), as a turning glyph and its words, `+1` when another job runs
//                             beside it, and its seconds from SECS_MS on. Reading it makes the drawing draw again at
//                             each tick.
//   busySteps()               the steps running now, by their words, the oldest first (for tests).
//
// A job shorter than SHOW_MS never shows, so quick work does not flicker. A failure says itself where it happened
// (failNotice), as before. The times are the session's clock ($.clock), so a test steps them.
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface
type Alive = () => boolean | Promise<boolean>

const BUSY = { plugin: 'thimble', key: 'busy' } as const
export const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
export const SHOW_MS = 300
export const SECS_MS = 3000
const TICK_MS = 120

// what each model call is, as the bar says it, by its telemetry feature
const WORDS: Record<string, string> = {
  observer: 'adding explainers, details, claims',
  'explain-expand': 'writing a longer explainer',
  squeeze: 'rewriting',
  labels: 'labeling',
}

const jobs = new Map<number, { word: string; t0: number; alive?: Alive }>()
let nextId = 1
let frame = 0
let ticking = false

/** The bar's word for a model call of `feature`: its own, or the feature's name. */
export function busyWord(feature: string): string {
  return WORDS[feature] ?? feature.replace(/[-_]/g, ' ')
}

async function begin($: Engine, word: string, alive?: Alive): Promise<number> {
  const id = nextId++
  jobs.set(id, { word, t0: Number(await $.clock.now()), ...(alive ? { alive } : {}) })
  $.clock.after(SHOW_MS, () => { if (jobs.has(id)) tick($) })
  return id
}

function end($: Engine, id: number): void {
  jobs.delete(id)
  if (!jobs.size) void $.state.set(BUSY, { frame, n: 0 }).catch(() => undefined)
}

/** Run `work` as a job the bar shows while it runs. */
export async function busy<R>($: Engine, word: string, work: () => Promise<R>): Promise<R> {
  let id = 0
  try { id = await begin($, word) } catch { /* the work runs unshown */ }
  try {
    return await work()
  } finally {
    if (id) end($, id)
  }
}

/** A job the bar shows until `alive()` says false. */
export async function busyWhile($: Engine, word: string, alive: Alive): Promise<void> {
  try { await begin($, word, alive) } catch { /* unshown */ }
}

/** The jobs whose work another hook ended, taken out. */
async function prune($: Engine): Promise<void> {
  for (const [id, j] of [...jobs]) {
    if (!j.alive) continue
    let on = false
    try { on = await j.alive() } catch { on = false }
    if (!on) end($, id)
  }
}

/** The tick: the glyph turns and the seconds count while a shown job runs; it stops when none does. */
function tick($: Engine): void {
  if (ticking) return
  ticking = true
  const step = async () => {
    await prune($)
    if (!(await shown($))) {
      ticking = false
      void $.state.set(BUSY, { frame, n: 0 }).catch(() => undefined)
      return
    }
    frame += 1
    void $.state.set(BUSY, { frame, n: jobs.size }).catch(() => undefined)
    $.clock.after(TICK_MS, () => { void step() })
  }
  void step()
}

/** The newest job that has run long enough to show, with how many other shown jobs run beside it; or null. */
async function shown($: Engine): Promise<{ word: string; ms: number; more: number } | null> {
  if (!jobs.size) return null
  const now = Number(await $.clock.now())
  const on = [...jobs.values()].filter(j => now - j.t0 >= SHOW_MS)
  let best: { word: string; t0: number } | null = null
  for (const j of on) if (!best || j.t0 > best.t0) best = j
  // the same step twice (two citation checks) counts once
  const more = new Set(on.map(j => j.word)).size - 1
  return best ? { word: best.word, ms: now - best.t0, more } : null
}

/** The glyph's frame now. */
export function spinFrame(): string {
  return SPIN[frame % SPIN.length]!
}

/** What the bar shows now: the glyph, the step's words (with `+1` when another step runs beside it), and the seconds
 *  once they help (from 3 s); null when nothing runs. */
export async function busyNow($: Engine): Promise<{ glyph: string; word: string; short: string; secs: number | null } | null> {
  await $.state.get(BUSY)
  const j = await shown($)
  if (!j) return null
  const more = j.more ? ` +${j.more}` : ''
  return { glyph: spinFrame(), word: `${j.word}${more}`, short: `${briefStep(j.word)}${more}`, secs: j.ms >= SECS_MS ? Math.floor(j.ms / 1000) : null }
}

/** A step's words for a narrow bar: up to its first colon or comma, at most 18 characters (`adding explainers`). */
export function briefStep(word: string): string {
  const w = word.split(/[:,]/)[0]!.trim()
  return [...w].length <= 18 ? w : `${[...w].slice(0, 17).join('').trimEnd()}…`
}

/** The steps running now, by their words, the oldest first. */
export function busySteps(): string[] {
  return [...jobs.values()].sort((a, b) => a.t0 - b.t0).map(j => j.word)
}

/** For tests: the module's memory, cleared. */
export function resetBusy(): void {
  jobs.clear()
  frame = 0
  ticking = false
}
