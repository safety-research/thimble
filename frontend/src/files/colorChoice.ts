// Color by in Files' Transcript mode: what colors the records' left edge and the reader's tracks (Tracks.tsx). The
// choice is Off, a key of the records (one of those the server finds naming a kind or a who over the whole file,
// GET /source/keys, the fields Table view shows), or a label over files that is on. A key's values take the label
// palette by frequency (--label-1 to --label-12, the rest one Other in --label-none); a label's values take the label's
// own colors, its highlighted values only. Each value is a chip that turns its records off (hides them) and on. The
// choice and the values turned off are kept per file in this browser. Pure, but for the storage.
import type { Concept, LabelRow, SourceKey, SourceRecord } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { classesOf, colourVar, litClass, valueOf } from './labels'

export type ColorChoice = { by: 'off' } | { by: 'key'; key: string } | { by: 'label'; id: string }

/** a choice as one string: `off`, `k:<key>` or `l:<label id>` */
export const choiceId = (c: ColorChoice): string => (c.by === 'off' ? 'off' : c.by === 'key' ? `k:${c.key}` : `l:${c.id}`)

export function parseChoice(id: string | null | undefined): ColorChoice | null {
  if (id === 'off') return { by: 'off' }
  if (id?.startsWith('k:')) return { by: 'key', key: id.slice(2) }
  if (id?.startsWith('l:')) return { by: 'label', id: id.slice(2) }
  return null
}

/** the chip of a key's values past the palette */
export const OTHER = '\u0000other'
/** the chip of the records with no value */
export const NONE = '\u0000none'
/** the palette a key's values take, most frequent first */
export const KEY_COLORS = 12

/** A value of the choice as its chip shows it: its name, its count on the file (null when not known), its color (null
 * for the records with no value), and what it means when the label defines it. */
export interface ColorValue {
  id: string
  name: string
  n: number | null
  color: string | null
  meaning?: string | null
}

export const keyColor = (rank: number): string => (rank < KEY_COLORS ? `var(--label-${rank + 1})` : 'var(--label-none)')

/** A key's chips: its commonest values in the palette, then Other for the rest, then the records with none. */
export function keyChips(k: SourceKey): ColorValue[] {
  const out: ColorValue[] = k.values.slice(0, KEY_COLORS).map((v, i) => ({
    id: v.value,
    name: v.value,
    n: v.n,
    color: keyColor(i),
  }))
  const rest = k.values.slice(KEY_COLORS)
  const restN = rest.reduce((a, v) => a + v.n, 0) + k.more.n
  if (rest.length || k.more.values)
    out.push({
      id: OTHER,
      name: 'Other',
      n: restN,
      color: keyColor(KEY_COLORS),
    })
  if (k.none > 0) out.push({ id: NONE, name: `No ${k.key}`, n: k.none, color: null })
  return out
}

/** The meaning a label's definition gives one of its values, written as `'value': what it means`: the words after the
 * colon up to the next value so written, or the end of that sentence; null when it gives none. Pure. */
export function valueMeaning(definition: string | null | undefined, values: readonly string[], value: string): string | null {
  const text = definition ?? ''
  if (!text) return null
  const marks: { at: number; end: number; value: string }[] = []
  for (const v of values) {
    for (const q of ["'", '"', '‘', '“']) {
      const close = q === '‘' ? '’' : q === '“' ? '”' : q
      const token = `${q}${v}${close}:`
      const at = text.indexOf(token)
      if (at >= 0) {
        marks.push({ at, end: at + token.length, value: v })
        break
      }
    }
  }
  marks.sort((a, b) => a.at - b.at)
  const i = marks.findIndex((m) => m.value === value)
  if (i < 0) return null
  const stop = i + 1 < marks.length ? marks[i + 1].at : text.length
  let words = text.slice(marks[i].end, stop).trim()
  const sentence = /[.!?]\s+(?=[A-Z])/.exec(words)
  if (sentence) words = words.slice(0, sentence.index + 1)
  return words.trim() || null
}

/** A label's definition before the first of its values written as `'value': …` (its question), the whole definition
 * when it writes none so. Pure. */
export function definitionLead(definition: string | null | undefined, values: readonly string[]): string {
  const text = (definition ?? '').trim()
  let cut = text.length
  for (const v of values) {
    for (const [q, close] of [
      ["'", "'"],
      ['"', '"'],
      ['‘', '’'],
      ['“', '”'],
    ]) {
      const at = text.indexOf(`${q}${v}${close}:`)
      if (at >= 0 && at < cut) cut = at
    }
  }
  return text.slice(0, cut).trim()
}

/** A label's chips: its highlighted values in its colors, with their counts on the file and their meanings, then the
 * records it does not mark, when there are any or their count is not known. */
export function labelChips(k: Concept, counts: Readonly<Record<string, number>> | undefined, total: number | null): ColorValue[] {
  const classes = classesOf(k)
  const names = classes.map((c) => c.name)
  const lit = classes.filter((c) => c.highlight)
  const out: ColorValue[] = lit.map((c) => ({
    id: c.name,
    name: c.name,
    n: counts ? (counts[c.name] ?? 0) : null,
    color: colourVar(c.color),
    meaning: valueMeaning(k.description, names, c.name),
  }))
  const marked = lit.reduce((a, c) => a + (counts?.[c.name] ?? 0), 0)
  const unmarked = counts && total != null ? Math.max(0, total - marked) : null
  if (unmarked !== 0) out.push({ id: NONE, name: 'Not marked', n: unmarked, color: null })
  return out
}

/** The choice when none is kept: the file's first key with at most the palette's values, else its first key, else Off. */
export function defaultChoice(keys: readonly SourceKey[]): ColorChoice {
  const few = keys.find((k) => k.values.length <= KEY_COLORS && !k.more.values)
  const k = few ?? keys[0]
  return k ? { by: 'key', key: k.key } : { by: 'off' }
}

/** What the reader keeps of Color by per file: the choice (null for the default) and, per choice, the values off. */
export interface ColorKept {
  by: string | null
  off: Record<string, string[]>
}

export const colorKey = (ws: string, path: string): string => storageKey(ws, `colorBy:${path}`)

export function readColor(ws: string, path: string): ColorKept {
  const got = readStorage<Partial<ColorKept> | null>(colorKey(ws, path), null)
  const off: Record<string, string[]> = {}
  if (got?.off && typeof got.off === 'object') for (const [k, v] of Object.entries(got.off)) if (Array.isArray(v)) off[k] = v.filter((x) => typeof x === 'string')
  return { by: typeof got?.by === 'string' ? got.by : null, off }
}

export const writeColor = (ws: string, path: string, kept: ColorKept): void => writeStorage(colorKey(ws, path), kept)

const parsed = new WeakMap<object, unknown>()

/** A record's object: the record itself, or a JSON line's object for a file the server pages as text. */
export function recordObject(rec: SourceRecord): Record<string, unknown> | null {
  const r = rec.record
  if (!r || typeof r !== 'object') return null
  const text = (r as { text?: unknown }).text
  if (typeof text === 'string' && Object.keys(r).length === 1) {
    if (parsed.has(rec)) return parsed.get(rec) as Record<string, unknown> | null
    let obj: unknown = null
    if (text.trim().startsWith('{')) {
      try {
        obj = JSON.parse(text)
      } catch {
        obj = null
      }
    }
    const out = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null
    parsed.set(rec, out)
    return out
  }
  return r as Record<string, unknown>
}

/** A key's value on a record as the server counts it (source_keys._scalar): a short string, a number or a boolean as
 * written; null for none. Pure. */
export function keyValue(rec: SourceRecord, key: string): string | null {
  const v = recordObject(rec)?.[key]
  if (v == null || v === '') return null
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return JSON.stringify(v)
  return typeof v === 'string' ? v : null
}

/** The chip a record's value falls under: its value, Other past the palette's values, or NONE. */
export function chipOfKeyValue(k: SourceKey, value: string | null): string {
  if (value == null) return NONE
  const rank = k.values.findIndex((v) => v.value === value)
  return rank >= 0 && rank < KEY_COLORS ? value : OTHER
}

/** A label's value on a record as its chip: the highlighted value it has, else NONE (not marked, or a value the label
 * does not highlight); undefined while the record's rows have not arrived. */
export function chipOfLabel(k: Concept, row: LabelRow | undefined, arrived: boolean): string | undefined {
  if (!row) return arrived ? NONE : undefined
  return litClass(k, valueOf(row))?.name ?? NONE
}
