// The types of svg.js, the renderer of a card program's drawing.
import type { Drawing } from './types'

export interface RegionRect {
  x: number
  y: number
  w: number
  h: number
}
export interface DrawnRegion {
  id: string
  meta: Record<string, unknown>
  rects: RegionRect[]
  link?: boolean
}
export interface Rendered {
  svg: string
  w: number
  h: number
  regions: DrawnRegion[]
  warnings: string[]
  /** what was cut to fit: a text, a title */
  cut: { k: string; s: string }[]
  error?: Drawing['error']
}
export type Measure = (s: string, o?: { size?: number; bold?: boolean; mono?: boolean }) => number

export const SANS: string
export const MONO: string
export function approxMeasure(s: string, o?: { size?: number; bold?: boolean; mono?: boolean }): number
export function canvasMeasure(doc?: Document): Measure
export function renderSvg(
  drawing: Drawing,
  opts?: { w?: number; cw?: number; lh?: number; fs?: number; theme?: 'light' | 'dark'; measure?: Measure; selected?: string | null; hover?: string | null; hits?: boolean },
): Rendered
