// What Color by gives each record of Files' Transcript and Table modes (colorChoice.ts, Reader): per line, the color of
// its value of the first choice (null for a record with no value, or with its value turned off) and a band per choice for
// its left edge (views/common EdgeBands). Color by only colors: a value turned off takes its color off its records, which
// stay; Filter by is what hides records. Null outside those modes, or with Color by off.
import { createContext } from 'react'

export interface RecordColor {
  /** the first choice's color of the record's value; null for a record with no value or a value turned off */
  color: string | null
  /** one per choice, in the tracks' order: the color of the record's value of that choice, null where it has none. The
   * same array for the same colors (bandsOf), so a row that keeps its colors keeps its props */
  bands: readonly (string | null)[]
}

export const ColorContext = createContext<ReadonlyMap<number, RecordColor> | null>(null)

const BANDS = new Map<string, readonly (string | null)[]>()
/** distinct sets of bands kept, past which the cache starts again */
const BANDS_KEPT = 4096

/** `colors` as the one array every record with these colors shares, kept across renders, so a memoized row given them
 * renders again only when its colors change. */
export function bandsOf(colors: readonly (string | null)[]): readonly (string | null)[] {
  const key = colors.map((c) => c ?? '').join('\n')
  let got = BANDS.get(key)
  if (!got) {
    if (BANDS.size >= BANDS_KEPT) BANDS.clear()
    got = Object.freeze([...colors])
    BANDS.set(key, got)
  }
  return got
}
