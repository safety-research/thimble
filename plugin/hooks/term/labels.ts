// The label panel's parts that draw nothing themselves (SPEC.md, section 7, "The label panel"):
//
// - the colors of a label's values: its classes' colors, the browser's --label-1..18 (paint.ts LABEL_HUES, then
//   PICKED_HUES) by the names show_label takes (backend concepts.COLOUR_NAMES), 0 dim, and the picker's places around
//   the color wheel (backend/app/label_wheel.json);
// - the held-out agreement line, in the browser's words (frontend canvas/details.ts agreementLine);
// - the words of the label panel's scope row and pattern note (oneOf, regexNote);
// - what the panel asks of `thimble state label` (`--rows`, the records of a value its `… N more` asked for);
// - the label deleted last, whose delete the labels list offers to undo (`thimble act label-undelete`);
// - each label's records with no category fit and those it is unsure of (`thimble state label-unsure --label <id> --n
//   <n>`, SPEC-v2 C8), no-fit first, then unsure by confidence, which the label editor shows first, UNSURE_PAGE more at
//   each `↓ more`; home and the labels list draw their counts in each label's bar (home.ts labelBlocks);
// - the values whose records fit no category (noFitValues).
import { COLORS, LABEL_HUES, PICKED_HUES } from './paint'

/** The label colors by the names show_label takes, in the palette's order: `blue` is color 1, `cyan` 12, then red,
 *  purple and pink (13 to 18), which a value takes only when the analyst picks it (backend concepts.COLOUR_NAMES). */
export const COLOR_NAMES = ['blue', 'orange', 'green', 'sky blue', 'olive', 'teal', 'brown', 'navy', 'grass green', 'cerulean', 'chestnut', 'cyan', 'red', 'dark red', 'purple', 'dark purple', 'pink', 'dark pink'] as const

/** The picker's places around the color wheel, as the browser's pickers show them: a column per hue (red, orange, gold,
 *  green, teal, sky, blue, purple, pink), its light place above its dark (backend/app/label_wheel.json). */
export const LABEL_WHEEL: readonly (readonly [number, number])[] = [[13, 14], [2, 11], [5, 7], [9, 3], [12, 6], [4, 10], [1, 8], [15, 16], [17, 18]]

const ONE: Record<string, string> = { lines: 'line', entries: 'entry', rows: 'row', pages: 'page', records: 'record', files: 'file', 'run folders': 'run folder', cards: 'card', sentences: 'sentence' }

/** A unit's word for one of them (`line` for `lines`), as the label panel counts a label's records. */
export function oneOf(noun: string): string {
  return ONE[noun] ?? noun
}

/** What a pattern gives, under it in the label panel: a match the first value, the rest the second; case-sensitive
 *  unless the pattern turns that off (`(?i)`), as Python's re reads it (backend concepts._compiled). */
export function regexNote(values: readonly string[], pattern: string): string {
  const ci = /\(\?[aiLmsux]*i[aiLmsux]*\)/.test(pattern)
  return `a match is ${values[0] ?? 'yes'}, the rest ${values[1] ?? 'no'} · ${ci ? 'case-insensitive' : 'case-sensitive'}`
}

/** A value of a label as the concept keeps it: its name, its color (1 to 18, 0 for none) and whether Files marks it. */
export type LabelClass = { name?: string; color?: number | null; highlight?: boolean }

/** Each value's color by its name, from a label's classes; undefined when it has none, so the colors follow the
 *  values' order (draw.ts valueColour). */
export function classColors(classes: readonly LabelClass[] | null | undefined): Record<string, number> | undefined {
  if (!Array.isArray(classes) || !classes.length) return undefined
  const out: Record<string, number> = {}
  for (const c of classes) if (c && typeof c.name === 'string' && typeof c.color === 'number') out[c.name] = c.color
  return Object.keys(out).length ? out : undefined
}

/** The hue of label color `n`: LABEL_HUES for 1 to 12, PICKED_HUES for 13 to 18 (red, purple, pink, only as the
 *  analyst picked them), dim for 0 (a value with no color). */
export function hueOf(n: number): string {
  if (n > LABEL_HUES.length && n <= LABEL_HUES.length + PICKED_HUES.length) return PICKED_HUES[n - LABEL_HUES.length - 1]!
  return n > 0 ? LABEL_HUES[(n - 1) % LABEL_HUES.length]! : COLORS.dim
}

/** The name of label color `n` (1 to 18), as show_label takes it; '' for 0 and for a number that is no color. */
export function colorName(n: number | undefined): string {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? (COLOR_NAMES[n - 1] ?? '') : ''
}

/** The label's agreement with the values the analyst set, not counting those its runs took as examples (the concept's
 *  `calibration`), in the browser's words; '' when no value was set. */
export function agreementLine(cal: { n?: number; agreed?: number; taught?: number } | null | undefined): string {
  if (!cal) return ''
  const n = cal.n ?? 0
  const taught = cal.taught ?? 0
  const given = taught ? `, not counting the ${taught.toLocaleString('en-US')} given as examples` : ''
  if (n > 0) return `${Math.round(((cal.agreed ?? 0) / n) * 100)}% agreed on ${n.toLocaleString('en-US')} ${n === 1 ? 'value' : 'values'} you set${given}`
  return taught ? `your ${taught.toLocaleString('en-US')} ${taught === 1 ? 'value was' : 'values were'} given as examples, so none tests the label yet` : ''
}

/** How many records the examples show of a value beyond those `thimble state label` gives (LABEL_ROWS), by
 *  `<label>\n<value>`: what each `… N more` asked for. */
export const labelRows = new Map<string, number>()

/** The records of a value one `… N more` adds. */
export const MORE_ROWS = 10

/** The arguments of `thimble state label` for label `id`: its id, and `--rows` with the records its values' `… N more`
 *  asked for. */
export function labelArgs(id: string): string[] {
  const asked: Record<string, number> = {}
  for (const [k, n] of labelRows) {
    const at = k.indexOf('\n')
    if (k.slice(0, at) === id) asked[k.slice(at + 1)] = n
  }
  return Object.keys(asked).length ? [id, '--rows', JSON.stringify(asked)] : [id]
}

/** The label deleted last from its panel, whose delete the labels list offers to undo, with why an undo was refused;
 *  null for none. */
export let labelGone: { id: string; name: string; error?: string } | null = null

export function setLabelGone(gone: { id: string; name: string; error?: string } | null): void {
  labelGone = gone
}

/** The values that say nothing (backend concepts.QUIET_VALUES). */
const QUIET_VALUES = new Set(['no', 'none', 'other', 'no match', 'not', 'neither', 'n/a', 'unknown'])

/** The values whose records fit no category, as the label's no-fit count takes them (backend concepts.no_fit_values):
 *  the values that say nothing (`other`, `none`) of a label with two or more that say something; none of a label with
 *  one (`yes` and `no`), whose quiet value is an answer. */
export function noFitValues(values: readonly string[]): Set<string> {
  const quiet = (v: string) => QUIET_VALUES.has(v.toLowerCase())
  return new Set(values.filter(v => !quiet(v)).length > 1 ? values.filter(quiet) : [])
}

/** A label's record with no category fit (value none, off its list, or failed) or one it is unsure of (C8). */
export type UnsureRow = { ref: string; value: string | null; confidence: number | null; kind: 'no-fit' | 'unsure'; text: string }

/** The records a label's unsure list shows at first, and how many more each `↓ more` asks for. */
export const UNSURE_PAGE = 3

/** How many of each label's unsure records the panel shows (UNSURE_PAGE until a `↓ more`). */
export const unsureShown = new Map<string, number>()

/** The surface key a label's unsure records are kept under. */
export function unsureKey(id: string): string {
  return `label-unsure:${id}`
}

/** The arguments of `thimble state label-unsure` for label `id`: the records shown so far. */
export function unsureArgs(id: string): string[] {
  return ['--label', id, '--n', String(unsureShown.get(id) ?? UNSURE_PAGE)]
}

/** A label's counts and its records as `thimble state label-unsure --label` printed them. */
export function unsureOf(v: unknown): { noFit: number; unsure: number; total: number; rows: UnsureRow[] } {
  const l = Array.isArray((v as { labels?: unknown })?.labels) ? ((v as { labels: Record<string, unknown>[] }).labels[0] ?? {}) : {}
  const rows = (Array.isArray(l.rows) ? (l.rows as Record<string, unknown>[]) : []).filter(r => r && typeof r.ref === 'string').map(r => ({
    ref: String(r.ref),
    value: typeof r.value === 'string' ? r.value : null,
    confidence: typeof r.confidence === 'number' ? r.confidence : null,
    kind: r.kind === 'no-fit' ? ('no-fit' as const) : ('unsure' as const),
    text: typeof r.text === 'string' ? r.text : '',
  }))
  return { noFit: Number(l.noFit) || 0, unsure: Number(l.unsure) || 0, total: Number(l.total) || rows.length, rows }
}

/** A record's state in words: `no fit`, or `unsure 0.31`. */
export function unsureWords(r: UnsureRow): string {
  return r.kind === 'no-fit' ? 'no fit' : `unsure${r.confidence !== null ? ` ${r.confidence.toFixed(2)}` : ''}`
}
