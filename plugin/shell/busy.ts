// busy.ts: the work thimble runs beside Claude's own turn, in one place, so the person always sees that something
// runs. Claude Code's spinner covers only Claude's main turn; this covers the rest (the observer, an explainer
// written longer, a squeeze, a label run, the citation check, a side thread's answer).
//
//   busy($, word, work)       runs `work` as a job named by a word or two ("explaining", "rewriting"); its end (or
//                             failure) ends the job. tracked() (telemetry.ts) does this for every model call, so a new
//                             call shows without code of its own.
//   busyWhile($, word, alive) a job that ends when `alive()` says false (checked at each tick): work that another
//                             hook ends, such as a side thread's subagent, whose turn ends in turn.complete.
//   busyNow($)                what the bar shows: the newest job that has run SHOW_MS or more, as a turning glyph and
//                             its word, with its seconds from SECS_MS on. Reading it makes the drawing draw again at
//                             each tick.
//   busyGlyph($)              the same glyph alone, for a line that says the work in place (the tray's explainer).
//   spinFrame()               the glyph's frame now: every spinner of thimble's turns with this one timer, so the
//                             frames match (the squeeze's message line).
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
  observer: 'adding explainers and details',
  'explain-expand': 'explaining',
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

/** The newest job that has run long enough to show, or null. */
async function shown($: Engine): Promise<{ word: string; ms: number } | null> {
  if (!jobs.size) return null
  const now = Number(await $.clock.now())
  let best: { word: string; t0: number } | null = null
  for (const j of jobs.values()) if (now - j.t0 >= SHOW_MS && (!best || j.t0 > best.t0)) best = j
  return best ? { word: best.word, ms: now - best.t0 } : null
}

/** The glyph's frame now, for every spinner of thimble's. */
export function spinFrame(): string {
  return SPIN[frame % SPIN.length]!
}

/** What the bar shows now: the glyph, the word, and the seconds once they help (from 3 s); null when nothing runs. */
export async function busyNow($: Engine): Promise<{ glyph: string; word: string; secs: number | null } | null> {
  await $.state.get(BUSY)
  const j = await shown($)
  if (!j) return null
  return { glyph: spinFrame(), word: j.word, secs: j.ms >= SECS_MS ? Math.floor(j.ms / 1000) : null }
}

/** The turning glyph alone, for a line that says the work in its place; null when nothing runs. */
export async function busyGlyph($: Engine): Promise<string | null> {
  return (await busyNow($))?.glyph ?? null
}

/** For tests: the module's memory, cleared. */
export function resetBusy(): void {
  jobs.clear()
  frame = 0
  ticking = false
}
