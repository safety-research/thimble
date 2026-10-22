// busy.ts: the work thimble runs beside Claude's own turn, in one place, so the person always sees what runs. Claude
// Code's spinner covers only Claude's main turn; this one line covers the rest, and it is thimble's only sign of work:
// no pane, message or panel draws a spinner of its own. Each job is a step named in plain words:
//
//   checking marks              the checker fork over a reply's marks (marks/checker.ts)
//   drawing a card              the designer fork v started, until it ends (designer/v.ts)
//   counting coverage           `thimble coverage`: the bar's count, the coverage pane (bar/counts.ts)
//   labeling <name>             a --prompt label's model reads (labels/labels.ts)
//   fixing: <title>             a fix Claude works on, while its record says `working` (bar/fix.ts refreshFixes)
//   turning the fix on, …       `thimble fix <verb>` as the person's own command (bar/fix.ts)
//
//   busy($, word, work)       runs `work` as a job named by its step; its end (or failure) ends the job. tracked()
//                             (telemetry.ts) does this for every model call, so a new call shows without code of its
//                             own.
//   busyWhile($, word, alive) a job that ends when `alive()` says false (checked at each tick): work that another
//                             hook ends, such as a fork, whose turn ends in turn.complete.
//   busyNow($)                what the bar shows: the newest job that has run SHOW_MS or more (the step the person
//                             most likely just started), as a turning glyph and its words, `+1` when another job runs
//                             beside it, and its seconds from SECS_MS on. Reading it makes the drawing draw again at
//                             each tick.
//   busySteps()               the steps running now, by their words, the oldest first (fix.ts starts a fix's step once).
//
// A job shorter than SHOW_MS never shows, so quick work does not flicker. A failure says itself where it happened
// (failNotice). The times are the session's clock ($.clock), so a test steps them.
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface
type Alive = () => boolean | Promise<boolean>

const BUSY = { plugin: 'thimble', key: 'busy' } as const
export const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const SHOW_MS = 300
const SECS_MS = 3000
const TICK_MS = 120

const jobs = new Map<number, { word: string; t0: number; alive?: Alive }>()
let nextId = 1
let frame = 0
let ticking = false

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
  // the same step twice (two checks of marks) counts once
  const more = new Set(on.map(j => j.word)).size - 1
  return best ? { word: best.word, ms: now - best.t0, more } : null
}

/** The glyph's frame now. */
function spinFrame(): string {
  return SPIN[frame % SPIN.length]!
}

/** What the bar shows now: the glyph, the step's words (with `+1` when another step runs beside it), and the seconds
 *  once they help (from 3 s); null when nothing runs. */
export async function busyNow($: Engine): Promise<{ glyph: string; word: string; secs: number | null } | null> {
  await $.state.get(BUSY)
  const j = await shown($)
  if (!j) return null
  const more = j.more ? ` +${j.more}` : ''
  return { glyph: spinFrame(), word: `${j.word}${more}`, secs: j.ms >= SECS_MS ? Math.floor(j.ms / 1000) : null }
}

/** The steps running now, by their words, the oldest first. */
export function busySteps(): string[] {
  return [...jobs.values()].sort((a, b) => a.t0 - b.t0).map(j => j.word)
}
