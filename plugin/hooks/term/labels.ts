// The label panel's parts that draw nothing themselves (SPEC.md, section 7, "The label panel"):
//
// - the colors of a label's values: its classes' colors, the browser's --label-1..18 (paint.ts LABEL_HUES, then
//   PICKED_HUES) by the names show_label takes (backend concepts.COLOUR_NAMES), 0 dim, and the picker's places around
//   the color wheel (backend/app/label_wheel.json);
// - the held-out agreement line, in the browser's words (frontend canvas/details.ts agreementLine);
// - what the panel asks of `thimble state label` (`--rows`, the records of a value its `… N more` asked for);
// - the label deleted last, whose delete the labels list offers to undo (`thimble act label-undelete`).
import { COLORS, LABEL_HUES, PICKED_HUES } from './paint'

/** The label colors by the names show_label takes, in the palette's order: `blue` is color 1, `cyan` 12, then red,
 *  purple and pink (13 to 18), which a value takes only when the analyst picks it (backend concepts.COLOUR_NAMES). */
export const COLOR_NAMES = ['blue', 'orange', 'green', 'sky blue', 'olive', 'teal', 'brown', 'navy', 'grass green', 'cerulean', 'chestnut', 'cyan', 'red', 'dark red', 'purple', 'dark purple', 'pink', 'dark pink'] as const

/** The picker's places around the color wheel, as the browser's pickers show them: a column per hue (red, orange, gold,
 *  green, teal, sky, blue, purple, pink), its light place above its dark (backend/app/label_wheel.json). */
export const LABEL_WHEEL: readonly (readonly [number, number])[] = [[13, 14], [2, 11], [5, 7], [9, 3], [12, 6], [4, 10], [1, 8], [15, 16], [17, 18]]

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
