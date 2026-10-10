// A chart's ticks in the terminal (pure, no `$`), for draw.ts lineLayout. Numbers tick at round steps, 1, 2 or 5 times a
// power of ten (d3's tickIncrement, which the browser's Vega axes use), and never under 1 for whole data. Times tick at
// clock or calendar steps and are named as the browser's date axis names their span (frontend lib/chartDefaults
// timeFormat): the clock within one day, the day and the clock within three days, the day within 540 days, else the
// month and the year. Seconds tick only over a few minutes; where the span crosses a year, the first tick and the first
// tick of each new year name it. A time is its wall clock as written, whatever zone it names, so a tick falls on the
// hour the data writes (the timeline's and the bars' rule, draw.ts shortTimes).
import { width } from './lib'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** the longest span whose ticks step by seconds and name them */
const FEW_MINUTES = 5 * MIN
const MONTH_DAYS = 30.44
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// the clock's steps, in ms; past a week the steps go by the calendar, in months (a year is 12)
const STEPS = [SEC, 5 * SEC, 15 * SEC, 30 * SEC, MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY]
const MONTH_STEPS = [1, 3, 6, 12, 24, 60, 120, 240, 600, 1200]
// the most ticks one axis makes
const MAX_TICKS = 400

/** An axis's ticks: their values (numbers, or times in ms) and their labels. */
export type Ticks = { at: number[]; labels: string[] }

/** The step of about `count` ticks over `span`: 1, 2 or 5 times a power of ten; at least 1 when `whole`. */
export function niceStep(span: number, count: number, whole = false): number {
  const raw = span / Math.max(1, count)
  if (!(raw > 0) || !Number.isFinite(raw)) return 1
  const p = 10 ** Math.floor(Math.log10(raw))
  const e = raw / p
  const step = (e >= Math.sqrt(50) ? 10 : e >= Math.sqrt(10) ? 5 : e >= Math.SQRT2 ? 2 : 1) * p
  return whole ? Math.max(1, step) : step
}

// the decimals a step's multiples need: 1 for 0.2, 2 for 0.05, none from 1 on
function decimals(step: number): number {
  return step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step) - 1e-9))
}

// the units a large axis names its ticks in, by the largest tick: 10,000 on reads in thousands
const UNITS: [number, number, string][] = [
  [1e9, 1e9, 'B'],
  [1e6, 1e6, 'M'],
  [1e4, 1e3, 'k'],
]

/** A tick's number as precise as the axis's step needs, all of one axis alike: `0.4` to a step of 0.2, `1,500`, and
 *  from 10,000 (`top`, the axis's largest tick) in thousands, millions or billions (`20k`, `1.5M`). */
export function numberLabel(v: number, step: number, top = Math.abs(v)): string {
  const [, div, unit] = UNITS.find(([from]) => top >= from) ?? [1, 1, '']
  if (unit && v === 0) return '0'
  const d = decimals(step / div)
  return `${(v / div || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}${unit}`
}

/** The ticks of about `count` over [lo, hi]: each multiple of niceStep that lies in it, labeled by numberLabel. */
export function numberTicks(lo: number, hi: number, count: number, whole = false): Ticks {
  const step = niceStep(hi - lo, count, whole)
  const d = decimals(step)
  const at: number[] = []
  // each multiple rounded to the step's decimals, so 3 × 0.1 is 0.3; -0 is 0
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9 && at.length < MAX_TICKS; k++) at.push(+(k * step).toFixed(d) || 0)
  const top = Math.max(0, ...at.map(Math.abs))
  return { at, labels: at.map(v => numberLabel(v, step, top)) }
}

const WALL = /^(\d{4})-(\d{2})(?:-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?$/

/** A time as written (`2026-08-28 07:19:34`, `2026-08-28T07:19:34+02:00`, `2026-08-28`, `2026-08`): its wall clock
 *  in ms, read as UTC, whatever zone it names; NaN for any other text. */
export function wallClock(s: string): number {
  const m = WALL.exec(s.trim())
  if (!m) return NaN
  return Date.UTC(+m[1]!, +m[2]! - 1, m[3] ? +m[3] : 1, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7] ? Math.round(+m[7] * 1000) : 0)
}

type Step = { ms: number; months: number }

// the month `i` (the year × 12 + the month) begins, in ms
const monthStart = (i: number) => Date.UTC(Math.floor(i / 12), i % 12, 1)

// the times of a step in [lo, hi]: the clock's steps at their multiples from midnight, two days on the odd days of the
// month, a week on Sundays, months on the first of a month whose number the step divides (a year on January 1), as the
// browser's axis ticks them
function stepped(lo: number, hi: number, st: Step): number[] {
  const out: number[] = []
  if (st.months) {
    const d = new Date(lo)
    let i = d.getUTCFullYear() * 12 + d.getUTCMonth()
    if (monthStart(i) < lo) i++
    for (i = Math.ceil(i / st.months) * st.months; monthStart(i) <= hi && out.length < MAX_TICKS; i += st.months) out.push(monthStart(i))
    return out
  }
  if (st.ms === 2 * DAY || st.ms === 7 * DAY) {
    for (let t = Math.ceil(lo / DAY) * DAY; t <= hi && out.length < MAX_TICKS; t += DAY) {
      const d = new Date(t)
      if (st.ms === DAY * 7 ? d.getUTCDay() === 0 : d.getUTCDate() % 2 === 1 && d.getUTCDate() < 31) out.push(t)
    }
    return out
  }
  for (let t = Math.ceil(lo / st.ms) * st.ms; t <= hi && out.length < MAX_TICKS; t += st.ms) out.push(t)
  return out
}

const two = (n: number) => String(n).padStart(2, '0')

/** The ticks of about `count` over the times [lo, hi] (ms, wall clock as UTC), named as the module note says:
 *  `09:00`, `09:00:30`, `Aug 28 06:00`, `May 24`, `Dec 29, 2019`, `Oct 2019`. */
export function timeTicks(lo: number, hi: number, count: number): Ticks {
  const span = hi - lo
  const a = new Date(lo)
  const b = new Date(hi)
  const sameDay = a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
  const form = sameDay ? 'clock' : span < 3 * DAY ? 'day-clock' : span < 540 * DAY ? 'day' : 'month'
  // a label names no finer part than its form, so its ticks step by at least that part
  const least = form === 'month' ? 28 * DAY : form === 'day' ? DAY : span <= FEW_MINUTES ? SEC : MIN
  const want = Math.max(span / Math.max(1, count), least)
  const ms = STEPS.find(s => s >= want)
  const st: Step = ms ? { ms, months: 0 } : { ms: 0, months: MONTH_STEPS.find(m => m * MONTH_DAYS * DAY >= want) ?? MONTH_STEPS.at(-1)! }
  const at = stepped(lo, hi, st)
  const seconds = !st.months && st.ms < MIN
  const years = a.getUTCFullYear() !== b.getUTCFullYear()
  let before = NaN
  const labels = at.map((t, i) => {
    const d = new Date(t)
    const y = d.getUTCFullYear()
    const named = years && (i === 0 || y !== before)
    before = y
    if (form === 'month') return `${MONTHS[d.getUTCMonth()]} ${y}`
    const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${named ? `, ${y}` : ''}`
    const clock = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${seconds ? `:${two(d.getUTCSeconds())}` : ''}`
    return form === 'clock' ? clock : form === 'day-clock' ? `${day} ${clock}` : day
  })
  return { at, labels }
}

/** Where each label stands on an axis `cols` cells wide, from the axis's first cell: centered on its tick's cell
 *  (`cells`), kept inside the axis; null when two labels would stand closer than 2 cells or one is wider than the
 *  axis. */
export function placeLabels(cells: readonly number[], labels: readonly string[], cols: number): number[] | null {
  const out: number[] = []
  let end = -Infinity
  for (let i = 0; i < labels.length; i++) {
    const w = width(labels[i]!)
    const x = Math.max(0, Math.min(cols - w, cells[i]! - Math.floor(w / 2)))
    if (w > cols || x < end + 2) return null
    out.push(x)
    end = x + w
  }
  return out
}

/** An x axis's ticks over [lo, hi] (numbers, or times in ms), as many as fit `cols` cells with 2 between labels: their
 *  values, labels, cells (`cellOf` a value's) and where each label starts. None when not even one fits. */
export function axisTicks(kind: 'num' | 'time', lo: number, hi: number, cols: number, cellOf: (v: number) => number, whole = false): Ticks & { cells: number[]; x: number[] } {
  for (let count = Math.max(3, Math.floor(cols / 12)); count >= 1; count--) {
    const t = kind === 'time' ? timeTicks(lo, hi, count) : numberTicks(lo, hi, count, whole)
    const cells = t.at.map(cellOf)
    const x = placeLabels(cells, t.labels, cols)
    if (x && t.at.length) return { ...t, cells, x }
  }
  return { at: [], labels: [], cells: [], x: [] }
}
