// A cited record's key facts: when it was written, who wrote it, and the page or thread it belongs to. Read from the
// resolved ref (GET /corpora/{c}/ref): the server's record meta, then the record's own top-level fields by name. A time
// reads as the record wrote it, in its own zone, never the browser's. The claim's words are marked where the record
// holds them. Pure.
import { valueSpan } from '../lib/tableCell'
import type { ResolvedRef } from '../lib/types'
import type { QuotePart } from './quotes'

export type FactKind = 'time' | 'who' | 'where'

export interface RecordFact {
  kind: FactKind
  /** the field it was read from */
  key: string
  /** as shown: a time in words (formatTime), else the value */
  text: string
  /** the value as the record stores it */
  raw: string
  /** the claim's words name it (factMatches) */
  hit?: boolean
}

// each fact's fields, in the order they are tried; the first one a record holds gives the fact
const TIME_KEYS = ['timestamp', 'time', 'ts', 'created_at', 'createdAt', 'datetime', 'date', 'sent_at', 'posted_at', 'write_date', 'updated_at', 'start_time', 'started_at']
const WHO_KEYS = ['author', 'actor_label', 'actor', 'user', 'username', 'user_name', 'sender', 'from', 'speaker', 'editor', 'agent', 'label', 'by']
const WHERE_KEYS = ['thread_title', 'page_title', 'page', 'title', 'subject', 'channel', 'thread', 'name']
/** The resolved ref kinds that are one record, which have facts; a range spans several records, so it has none. */
export const FACT_KINDS: ReadonlySet<string> = new Set(['record', 'block', 'span', 'row'])

/** a value longer than this is text, not a fact */
const FACT_MAX = 120

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A time's parts as written: its date, its clock when it has one, and its zone. */
export interface TimeParts {
  y: number
  mo: number
  d: number
  h?: number
  mi?: number
  s?: number
  /** `UTC`, an offset such as `+02:00`, or '' for none */
  zone: string
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i

/** A stored time read into its parts: an ISO date or date and time, or a Unix time in seconds or milliseconds (read in
 * UTC); null for anything else. Pure. */
export function parseTime(v: unknown): TimeParts | null {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{10}(?:\d{3})?(?:\.\d+)?$/.test(v.trim()))) {
    const n = Number(v)
    const ms = n >= 1e9 && n < 1e11 ? n * 1000 : n >= 1e12 && n < 1e14 ? n : NaN
    if (!Number.isFinite(ms)) return null
    const t = new Date(ms)
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), zone: 'UTC' }
  }
  if (typeof v !== 'string') return null
  const m = ISO.exec(v.trim())
  if (!m) return null
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const z = (m[7] ?? '').toUpperCase()
  const zone = !z ? '' : z === 'Z' || z === 'UTC' || z === 'GMT' || /^[+-]00:?00$/.test(z) ? 'UTC' : z.length === 5 ? `${z.slice(0, 3)}:${z.slice(3)}` : z
  const out: TimeParts = { y: Number(m[1]), mo, d, zone }
  if (m[4] != null) {
    out.h = Number(m[4])
    out.mi = Number(m[5])
    if (m[6] != null) out.s = Number(m[6])
  }
  return out
}

const two = (n: number) => String(n).padStart(2, '0')

/** A time in words as the record wrote it: `Jun 18, 2026, 18:21:02 UTC`, the clock and the zone only when it has them.
 * Pure. */
export function formatTime(t: TimeParts): string {
  const date = `${MONTHS[t.mo - 1]} ${t.d}, ${t.y}`
  if (t.h == null) return date
  const clock = `${two(t.h)}:${two(t.mi ?? 0)}${t.s != null ? `:${two(t.s)}` : ''}`
  return `${date}, ${clock}${t.zone ? ` ${t.zone}` : ''}`
}

/** Whether a text is a JSON list or object (a nested value kept as text), which is no fact; `[Mod1]` is a name. */
const isJsonText = (s: string): boolean => {
  if (!/^[[{]/.test(s)) return false
  try {
    const v: unknown = JSON.parse(s)
    return typeof v === 'object' && v !== null
  } catch {
    return false
  }
}

const shortValue = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s && s.length <= FACT_MAX && !s.includes('\n') && !isJsonText(s) ? s : null
}

/** The fields a record's facts are read from: its own top-level fields, with the server's meta over them (the meta names
 * an agent's transcript by its agent, which the record itself does not say). */
function fieldsOf(r: Pick<ResolvedRef, 'record' | 'meta'>): Record<string, unknown> | null {
  const rec = r.record && typeof r.record === 'object' && !Array.isArray(r.record) ? (r.record as Record<string, unknown>) : null
  const meta = r.meta && typeof r.meta === 'object' ? r.meta : null
  if (!rec && !meta) return null
  return { ...(rec ?? {}), ...(meta ?? {}) }
}

/** A record's facts: its time, who wrote it and where it belongs, each once, in that order; none for a record with no
 * such field (a line of a text file). Pure. */
export function recordFacts(r: Pick<ResolvedRef, 'record' | 'meta'>): RecordFact[] {
  const f = fieldsOf(r)
  if (!f) return []
  const out: RecordFact[] = []
  for (const key of TIME_KEYS) {
    const t = parseTime(f[key])
    if (t) {
      out.push({ kind: 'time', key, text: formatTime(t), raw: String(f[key]) })
      break
    }
  }
  const pick = (kind: FactKind, keys: string[]) => {
    for (const key of keys) {
      const v = shortValue(f[key])
      if (v && !out.some((x) => x.raw === v)) {
        out.push({ kind, key, text: v, raw: v })
        return
      }
    }
  }
  pick('who', WHO_KEYS)
  pick('where', WHERE_KEYS)
  return out
}

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const monthOf = (w: string): number => MONTHS.findIndex((m) => w.toLowerCase().startsWith(m.toLowerCase())) + 1

/** The dates and clock times a claim's words name: `March 3`, `3 March 2026`, `2026-03-03`, `18:21`, `18:21:02`. */
function namedTimes(value: string): { dates: { mo: number; d: number; y?: number }[]; clocks: { h: number; mi: number; s?: number }[] } {
  const dates: { mo: number; d: number; y?: number }[] = []
  for (const m of value.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'gi'))) dates.push({ mo: monthOf(m[1]), d: Number(m[2]), ...(m[3] ? { y: Number(m[3]) } : {}) })
  for (const m of value.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\b(?:\\s+(\\d{4}))?`, 'gi'))) dates.push({ mo: monthOf(m[2]), d: Number(m[1]), ...(m[3] ? { y: Number(m[3]) } : {}) })
  for (const m of value.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) dates.push({ y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) })
  const clocks: { h: number; mi: number; s?: number }[] = []
  for (const m of value.matchAll(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g)) clocks.push({ h: Number(m[1]), mi: Number(m[2]), ...(m[3] ? { s: Number(m[3]) } : {}) })
  return { dates, clocks }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Whether a claim's words name the fact: they hold its value (an author's name, `18:21:02`), or, for a time, every date
 * and clock time they name is the fact's (`March 3` for 2026-03-03T18:21:02Z). Pure. */
export function factMatches(fact: RecordFact, value: string | undefined): boolean {
  const v = norm(value ?? '')
  if (v.length < 2) return false
  // three letters or more, so a short word of the claim is not found inside a name
  if (v.length >= 3 && (norm(fact.text).includes(v) || norm(fact.raw).includes(v))) return true
  if (fact.kind === 'who' || fact.kind === 'where') return v.includes(norm(fact.raw)) && norm(fact.raw).length >= 3
  const t = parseTime(fact.raw)
  if (!t) return false
  const { dates, clocks } = namedTimes(value ?? '')
  if (!dates.length && !clocks.length) return false
  const dateOk = dates.every((d) => d.mo === t.mo && d.d === t.d && (d.y == null || d.y === t.y))
  const clockOk = clocks.every((c) => t.h != null && c.h === t.h && c.mi === t.mi && (c.s == null || c.s === t.s))
  return dateOk && clockOk
}

/** The facts with those the claim's words name marked. Pure. */
export function markFacts(facts: readonly RecordFact[], value: string | undefined): RecordFact[] {
  return facts.map((f) => (factMatches(f, value) ? { ...f, hit: true } : f))
}

/** Where a claim's words sit in a text: as valueSpan finds them (a number with or without its commas), else the same
 * words in any case; null when the text does not hold them. Pure. */
export function findValue(text: string, value: string): [number, number] | null {
  const v = value.trim()
  if (v.length < 2) return null
  const exact = valueSpan(text, v)
  // a number is found only whole, as valueSpan finds it, never inside a longer one
  if (exact || /^[-−]?[0-9][0-9,]*(?:\.[0-9]+)?%?$/.test(v)) return exact
  const at = text.toLowerCase().indexOf(v.toLowerCase())
  return at >= 0 ? [at, at + v.length] : null
}

/** A record's parts with the claim's words marked in the first part whose text holds them (a passage keeps its own
 * highlight, so a span ref's parts are left as they are). Pure. */
export function markValue(parts: readonly QuotePart[], value: string | undefined): QuotePart[] {
  const v = (value ?? '').trim()
  if (!v || parts.some((p) => p.kind === 'span')) return [...parts]
  let done = false
  return parts.map((p) => {
    if (done || !(p.kind === 'text' || p.kind === 'code' || p.kind === 'field')) return p
    const at = findValue(p.text, v)
    if (!at) return p
    done = true
    return { ...p, mark: at }
  })
}
