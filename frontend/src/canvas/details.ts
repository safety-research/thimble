// The card details drawer's pure parts: the outputs of a run as ordered blocks, a bundle's kind, the files a run read
// summarised by folder and pattern, duration and count formats, and the label card drawer's helpers (value order,
// coverage groups, unit words, example counts).
import { ERROR_MIME, asText, isStream, isVegaLite, pickMime, stripAnsi } from '../components/Outputs'
import { FRAME_MIME } from '../lib/dataFrame'
import { matchedCount, unmatchedValues } from '../files/labels'
import type { ConceptCoverage, CoverageFile, LabelRow, MimeBundle, OutputTruncation } from '../lib/types'

/** What a bundle is, by the representation the card would pick from it. */
export type BundleKind = 'stdout' | 'stderr' | 'error' | 'chart' | 'image' | 'table' | 'html' | 'markdown' | 'json' | 'text' | 'unknown'

export function bundleKind(b: MimeBundle | null | undefined): BundleKind {
  if (!b || typeof b !== 'object') return 'unknown'
  if (isStream(b)) return b._stream === 'stderr' ? 'stderr' : 'stdout'
  const mime = pickMime(b)
  if (mime === null) return 'unknown'
  if (mime === ERROR_MIME) return 'error'
  // a frame the backend kept of a DataFrame (lib/dataFrame): the details show it as its table, the rows the card draws
  if (mime === FRAME_MIME) return 'table'
  if (isVegaLite(mime)) return 'chart'
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'text/html') return /<table\b/i.test(asText(b[mime])) ? 'table' : 'html'
  if (mime === 'text/markdown') return 'markdown'
  if (mime === 'application/json') return 'json'
  return 'text'
}

export type DetailBlock =
  | { kind: 'shell'; index: number; stream: 'stdout' | 'stderr'; text: string; truncated: OutputTruncation | null }
  | { kind: 'error'; index: number; ename: string; evalue: string; traceback: string }
  | { kind: 'text'; index: number; text: string; plain: boolean }
  | { kind: 'artifact'; index: number; label: BundleKind; bundle: MimeBundle }

/** The `@out<i>` index a bundle answers to (the backend's cite.output_index): its `_out` when it carries one, else its position. */
export const outputIndex = (b: MimeBundle, position: number): number => (typeof b._out === 'number' && Number.isInteger(b._out) && b._out >= 0 ? b._out : position)

/** The outputs of a run in order, one block each (`index` is what …/outputs/{index}/full takes); an empty bundle makes no block. */
export function detailBlocks(outputs: readonly MimeBundle[] | null | undefined): DetailBlock[] {
  const blocks: DetailBlock[] = []
  ;(outputs ?? []).forEach((b, position) => {
    if (!b || typeof b !== 'object') return
    const index = outputIndex(b, position)
    const kind = bundleKind(b)
    switch (kind) {
      case 'stdout':
      case 'stderr': {
        const text = asText(b['text/plain'])
        const truncated = b.truncated && typeof b.truncated === 'object' ? b.truncated : null
        if (text || truncated) blocks.push({ kind: 'shell', index, stream: kind, text, truncated })
        return
      }
      case 'error': {
        const err = (b[ERROR_MIME] ?? {}) as { ename?: unknown; evalue?: unknown; traceback?: unknown }
        const tb = Array.isArray(err.traceback) ? err.traceback.map((l) => stripAnsi(asText(l))).join('\n') : ''
        blocks.push({ kind: 'error', index, ename: String(err.ename ?? 'Error'), evalue: String(err.evalue ?? ''), traceback: tb })
        return
      }
      case 'chart':
      case 'image':
      case 'table':
      case 'html':
        blocks.push({ kind: 'artifact', index, label: kind, bundle: b })
        return
      case 'markdown':
      case 'json':
      case 'text': {
        const mime = pickMime(b)
        const raw = mime ? b[mime] : ''
        const text = kind === 'json' && typeof raw !== 'string' ? JSON.stringify(raw, null, 2) : asText(raw)
        if (text) blocks.push({ kind: 'text', index, text, plain: mime === 'text/plain' })
        return
      }
      default:
        return
    }
  })
  return blocks
}

// Files a run read that share a folder and a pattern (runs/*/agents/*.jsonl) and the paths it stands for. A group of
// one is the path itself.
export interface InputGroup {
  pattern: string
  paths: string[]
}

const WILD = '*'
const splitPath = (p: string): { dirs: string[]; name: string } => {
  const parts = p.split('/').filter(Boolean)
  return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] ?? p }
}
const extOf = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i) : ''
}

// The files a run read, summarised: grouped by folder and extension, then folders that differ in one part merged into
// one pattern with `*` (runs/batch1-x/agents and runs/batch2-y/agents make runs/*/agents), until none is left; a
// pattern is not merged again. Largest groups first. A `file:` prefix is dropped; a path read twice counts once.
export function groupInputs(reads: readonly string[] | null | undefined): InputGroup[] {
  type G = { dirs: string[]; ext: string; paths: string[] }
  const keyOf = (dirs: string[], ext: string) => `${dirs.join('/')}\u0000${ext}`
  const paths = Array.from(new Set((reads ?? []).map((r) => r.replace(/^file:/, '').trim()).filter(Boolean)))
  let groups = new Map<string, G>()
  for (const p of paths) {
    const { dirs, name } = splitPath(p)
    const ext = extOf(name)
    const key = keyOf(dirs, ext)
    const g = groups.get(key) ?? { dirs, ext, paths: [] }
    g.paths.push(p)
    groups.set(key, g)
  }
  // only groups not yet merged take part, so a pattern never widens again (runs/*/agents and runs/*/prompts stay two)
  const concrete = (g: G) => !g.dirs.includes(WILD)
  for (;;) {
    let best: { keys: string[]; dirs: string[]; ext: string } | null = null
    const list = [...groups.entries()]
    for (const [, g] of list) {
      if (!concrete(g)) continue
      for (let i = 0; i < g.dirs.length; i++) {
        const want = (h: G) => concrete(h) && h.ext === g.ext && h.dirs.length === g.dirs.length && h.dirs.every((x, j) => j === i || x === g.dirs[j])
        const keys = list.filter(([, h]) => want(h)).map(([k]) => k)
        if (keys.length > 1 && (!best || keys.length > best.keys.length)) best = { keys, dirs: g.dirs.map((x, j) => (j === i ? WILD : x)), ext: g.ext }
      }
    }
    if (!best) break
    const merged: G = { dirs: best.dirs, ext: best.ext, paths: best.keys.flatMap((k) => groups.get(k)!.paths) }
    const next = new Map<string, G>()
    for (const [k, g] of groups) if (!best.keys.includes(k)) next.set(k, g)
    next.set(keyOf(merged.dirs, merged.ext), merged)
    groups = next
  }
  const out: InputGroup[] = []
  for (const g of groups.values()) {
    const sorted = [...g.paths].sort()
    if (sorted.length === 1) {
      out.push({ pattern: sorted[0], paths: sorted })
      continue
    }
    const names = new Set(sorted.map((p) => splitPath(p).name))
    const leaf = names.size === 1 ? [...names][0] : `${WILD}${g.ext}`
    out.push({ pattern: [...g.dirs, leaf].join('/'), paths: sorted })
  }
  return out.sort((a, b) => b.paths.length - a.paths.length || (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0))
}

/** `12,340 lines`: the size of a truncated stream, from what the backend keeps about it (line counts). */
export const truncatedSize = (t: OutputTruncation): string => `${t.total_lines.toLocaleString()} lines`

/** Seconds as the chip shows them: two decimals under 1 s, one under 10 s, none over; "" when unknown. */
export function formatDuration(s: number | null | undefined): string {
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) return ''
  if (s < 1) return `${s.toFixed(2)} s`
  if (s < 10) return `${s.toFixed(1)} s`
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  return `${m} m ${String(Math.round(s - m * 60)).padStart(2, '0')} s`
}

// --------------------------------------------------------------------------- the label card's drawer

/** The rows EXAMPLES shows per page, and the most verdicts a prompt apply carries as examples (concepts.EXAMPLES_MAX). */
export const EXAMPLES_PAGE = 5
export const EXAMPLES_MAX = 8

/** The label's values in display order: the declared values first, as declared, then any other value the counts carry, by count. */
export function labelValues(labels: readonly string[] | null | undefined, counts: Readonly<Record<string, number>> | null | undefined): string[] {
  const out: string[] = []
  for (const v of labels ?? []) if (v && !out.includes(v)) out.push(v)
  const extra = Object.keys(counts ?? {}).filter((v) => v && !out.includes(v))
  extra.sort((a, b) => (counts?.[b] ?? 0) - (counts?.[a] ?? 0) || a.localeCompare(b))
  return [...out, ...extra]
}

/** The value EXAMPLES opens on: the current one while it is still a value, else the first value with rows, else the first value; null with none. */
export function pickValue(values: readonly string[], counts: Readonly<Record<string, number>> | null | undefined, current?: string | null): string | null {
  if (current && values.includes(current)) return current
  return values.find((v) => (counts?.[v] ?? 0) > 0) ?? values[0] ?? null
}

/** The values a disagreeing analyst may pick: every value but the row's effective one. */
export const otherValues = (values: readonly string[], value: string | null | undefined): string[] => values.filter((v) => v !== value)

/** A row's effective value: the analyst's verdict when there is one, else the classifier's label. */
export const effectiveValue = (row: Pick<LabelRow, 'label' | 'analyst'>): string | null => row.analyst ?? row.label ?? null

export interface CoverageGroups {
  /** the first files with rows, by path */
  covered: CoverageFile[]
  /** a page of the paths with none, sorted */
  notCovered: string[]
  /** rows over every covered file */
  rows: number
  /** files in the corpus */
  total: number
  /** files with rows */
  nCovered: number
  /** files with none */
  nNotCovered: number
}

/** The paths of the files with no rows a coverage answer lists at a time (backend concepts.COVERAGE_PAGE). */
export const COVERAGE_PAGE = 200

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0)

/** The coverage route's answer for APPLIED TO; null (no coverage yet, or a cell or span unit) groups to nothing. */
export function groupCoverage(cov: Partial<ConceptCoverage> | null | undefined): CoverageGroups {
  const covered = Array.isArray(cov?.files) ? cov.files.filter((f): f is CoverageFile => !!f && typeof f.path === 'string') : []
  const notCovered = Array.isArray(cov?.not_covered) ? cov.not_covered.filter((p): p is string => typeof p === 'string') : []
  return { covered, notCovered, rows: count(cov?.rows), total: count(cov?.n_files), nCovered: count(cov?.n_covered), nNotCovered: count(cov?.n_not_covered) }
}

/** The word for a unit, singular or plural: `record` → `records`, `cell` → `cards`, `span` → `sentences`, `agent` → `files`, `run` → `runs`. */
export function unitWord(unit: string | undefined, n: number): string {
  const one: Record<string, [string, string]> = { record: ['record', 'records'], cell: ['card', 'cards'], span: ['sentence', 'sentences'], agent: ['file', 'files'], run: ['run', 'runs'] }
  const [s, p] = one[unit ?? ''] ?? [unit || 'unit', `${unit || 'unit'}s`]
  return n === 1 ? s : p
}

/** A value's share of the labeled units as the table shows it: whole percents, one decimal at the ends (0.3%, 99.7%); '' with no total. */
export function labelShare(count: number, total: number): string {
  if (!(total > 0) || !(count >= 0)) return ''
  const p = (count / total) * 100
  const s = p > 0 && (p < 10 || p > 90) && p !== 100 ? p.toFixed(1) : Math.round(p).toString()
  return `${s.endsWith('.0') ? s.slice(0, -2) : s}%`
}

/** Each value's share as a label card's table shows it: among the matched units (those whose value is not one of the
 * label's negatives, files/labels unmatchedValues), so the values of interest don't read near 0% beside a huge
 * negative. `matched` is that subset's size; a negative's share is ''. A label with one non-negative value, or with no
 * negatives, shows shares of the whole. */
export interface LabelShares {
  share: Record<string, string>
  matched: number
  total: number
  negatives: Set<string>
}

export function labelShares(labels: readonly string[], counts: Readonly<Record<string, number>> | null | undefined, total: number): LabelShares {
  const values = labelValues(labels, counts)
  const negatives = unmatchedValues(labels)
  const positive = values.filter((v) => !negatives.has(v))
  const matched = matchedCount(labels, counts, total)
  const share: Record<string, string> = {}
  const base = positive.length > 1 ? matched : total
  for (const v of values) share[v] = negatives.has(v) ? '' : labelShare(counts?.[v] ?? 0, base)
  return { share, matched, total, negatives }
}

/** `12,480 records`: the count of labeled units with the unit's word. */
export const unitTotal = (n: number | null | undefined, unit: string | undefined): string => `${(n ?? 0).toLocaleString()} ${unitWord(unit, n ?? 0)}`

/** The scope a unit belongs to, as the APPLIED TO chip names it. */
export function scopeWord(unit: string | undefined): string {
  switch (unit) {
    case 'record':
    case 'agent':
    case 'run':
      return 'files'
    case 'cell':
      return 'canvas'
    case 'span':
      return 'report'
    default:
      return unit || 'files'
  }
}

/** How many examples `apply with N examples` carries: the verdicts, capped at EXAMPLES_MAX. */
export const exampleCount = (nReviewed: number | null | undefined): number => Math.min(EXAMPLES_MAX, Math.max(0, Math.floor(nReviewed ?? 0)))

/** The paths a re-apply runs over: the last run's, else the whole corpus. */
export const reapplyPaths = (last: { paths?: string[] | null } | null | undefined): string[] => (last?.paths?.length ? [...last.paths] : ['**/*'])

// ---- the label card's face (canvas/bodies.tsx LabelBody): its values, glob and examples ----

/** The values a label card's table lists: those some unit got. While a run goes on, or when no value has a unit yet,
 * every value is listed. */
export function shownValues(values: readonly string[], counts: Readonly<Record<string, number>> | null | undefined, running: boolean): string[] {
  const some = values.filter((v) => (counts?.[v] ?? 0) > 0)
  return running || !some.length ? [...values] : some
}

/** the characters of a glob pattern the line under a label card's question shows whole */
const GLOB_SHORT = 28

/** A label's file glob as the line under a card's question shows it: each pattern whole when short, else its file name
 * after `…/`; `full` is every pattern whole, for the hover. */
export function shortGlob(glob: string | null | undefined): { short: string; full: string } {
  const patterns = (glob ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  const short = patterns.map((p) => (p.length <= GLOB_SHORT || !p.includes('/') ? p : `…/${p.slice(p.lastIndexOf('/') + 1)}`))
  return { short: short.join(', '), full: patterns.join(', ') }
}

/** Text with its percent-encoded words decoded (`%2F` as `/`), twice at most for double encoding (`%252C`); a word
 * that does not decode is left as it is. */
export function decodePercents(text: string): string {
  return text.replace(/\S*%[0-9A-Fa-f]{2}\S*/g, (word) => {
    let out = word
    for (let i = 0; i < 2 && /%[0-9A-Fa-f]{2}/.test(out); i++) {
      try {
        out = decodeURIComponent(out)
      } catch {
        break
      }
    }
    return out
  })
}

/** One example of a label value: the words it shows and, when the server found them, the words that earned the unit
 * its value (a regex's match, a span label's quote; GET /concepts/{id}/rows `match`). */
export interface ValueExample {
  text: string
  match?: string
}

const shownText = (t: string): string => decodePercents(t.replace(/\s+/g, ' ').trim())

/** A label row's example when the server found no match: its own words, or null where they would only show how the
 * unit begins (a whole file, a record of a `.json` document, a record cut short with `…`, words with no letter or
 * digit). */
export function unmatchedExample(unit: string | undefined, text: string, ref?: string): ValueExample | null {
  const t = text.trim()
  if (wholeUnit(unit, ref) || !t || t.endsWith('…') || !/[\p{L}\p{N}]/u.test(t)) return null
  return { text: t }
}

/** The values of a label that say nothing matched: one that begins with a negating word (`no flag`, `not a merge`,
 * `none`, `n/a`), or the second of two values. An `other …` value is not one of them. */
export function noMatchValues(labels: readonly string[]): Set<string> {
  return new Set(labels.filter((v, i) => /^(no|not|none|neither|n\/a)\b/i.test(v.trim()) || (labels.length === 2 && i === 1)))
}

/** A value's example candidates: a no-match value (noMatchValues) keeps only examples with the words that earned it. */
export function exampleCandidates(value: string, noMatch: ReadonlySet<string>, xs: readonly ValueExample[]): ValueExample[] {
  return noMatch.has(value) ? xs.filter((x) => !!x.match) : [...xs]
}

/** Whether a label's unit is a whole file or a record of a `.json` document, whose own words begin the file. */
export const wholeUnit = (unit: string | undefined, ref?: string): boolean => unit === 'agent' || unit === 'run' || (!!ref && /\.json#/i.test(ref))

/** A label card's example as it shows: whitespace collapsed, percent-encoding decoded, cut to `max` characters, and the
 * matched words split out. `match` is '' when there is none. */
export function exampleParts(ex: ValueExample, max: number): { before: string; match: string; after: string } {
  const text = shownText(ex.text)
  const match = ex.match ? shownText(ex.match) : ''
  const at = match ? text.indexOf(match) : -1
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, Math.max(0, n)).trimEnd()}…` : t)
  if (at < 0) return { before: cut(text, max), match: '', after: '' }
  const before = text.slice(0, at)
  const shown = cut(match, Math.max(0, max - before.length))
  const room = max - before.length - shown.length
  const after = shown.length < match.length ? '' : cut(text.slice(at + match.length), room)
  return { before, match: shown, after }
}

/** One example per value for a label card: for each value, the first candidate whose words no earlier value already
 * shows. A value whose every candidate repeats another's gets none. */
export function pickExamples(values: readonly string[], candidates: Readonly<Record<string, readonly ValueExample[]>>): Record<string, ValueExample> {
  const out: Record<string, ValueExample> = {}
  const seen: string[] = []
  const words = (t: string) => shownText(t).replace(/^…|…$/g, '').trim()
  const repeats = (t: string) => seen.some((s) => s.includes(t) || t.includes(s))
  for (const v of values) {
    const ex = (candidates[v] ?? []).find((c) => words(c.text) && !repeats(words(c.text)))
    if (!ex) continue
    out[v] = ex
    seen.push(words(ex.text))
  }
  return out
}
