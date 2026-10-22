// A table card's DataFrame as the backend keeps it (backend/app/frames.py): a FRAME_MIME bundle in the card's outputs
// with the rows shown, each column's type, the row-name column (`label`), and `view` (visible columns, number formats,
// rows left out). canvas/FrameTable reads only these. Numbers are formatted with d3-format in the backend's formats,
// which produce the same strings (frames.show), so the card shows the string the citation check compared. Pure.
import { format as d3format } from 'd3-format'
import type { MimeBundle } from './types'

export const FRAME_MIME = 'application/vnd.thimble.frame+json'

export type FieldType = 'quantitative' | 'temporal' | 'nominal' | 'ordinal'
export type Cellv = string | number | boolean | null

export interface FrameView {
  columns: string[]
  formats: Record<string, string>
  more: number
}

export interface Frame {
  columns: string[]
  types: Record<string, FieldType>
  index: string | null
  label: string | null
  rows: Cellv[][]
  total: number
  view: FrameView
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** A stored frame read tolerantly: null when it is not a frame. */
export function asFrame(v: unknown): Frame | null {
  const f = obj(v)
  if (!f || !Array.isArray(f.columns) || !Array.isArray(f.rows)) return null
  const columns = f.columns.map(String)
  const view = obj(f.view) ?? {}
  const types: Record<string, FieldType> = {}
  for (const [k, t] of Object.entries(obj(f.types) ?? {})) if (t === 'quantitative' || t === 'temporal' || t === 'nominal' || t === 'ordinal') types[k] = t
  const formats: Record<string, string> = {}
  for (const [k, s] of Object.entries(obj(view.formats) ?? {})) if (typeof s === 'string') formats[k] = s
  const label = typeof f.label === 'string' ? f.label : null
  return {
    columns,
    types,
    index: typeof f.index === 'string' ? f.index : null,
    label,
    rows: (f.rows as unknown[]).filter(Array.isArray) as Cellv[][],
    total: typeof f.total === 'number' ? f.total : (f.rows as unknown[]).length,
    view: {
      columns: Array.isArray(view.columns) ? strings(view.columns) : columns.filter((c) => c !== label),
      formats,
      more: typeof view.more === 'number' ? view.more : 0,
    },
  }
}

export const isFrameBundle = (b: MimeBundle | null | undefined): boolean => !!b && typeof b === 'object' && FRAME_MIME in b

const formatters = new Map<string, ((n: number) => string) | null>()
/** A formatter for a d3-format specifier, null when the specifier is not one. Cached. */
export function formatter(spec: string): ((n: number) => string) | null {
  if (!formatters.has(spec)) {
    let fn: ((n: number) => string) | null = null
    try {
      fn = d3format(spec)
    } catch {
      fn = null
    }
    formatters.set(spec, fn)
  }
  return formatters.get(spec)!
}

/** One value as a card shows it: a number in its column's format, anything else as its text, a missing value as
 * empty. */
export function cellText(v: Cellv | undefined, fmt?: string): string {
  if (v == null) return ''
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v)
    const fn = fmt ? formatter(fmt) : null
    return fn ? fn(v) : String(v)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return v
}
