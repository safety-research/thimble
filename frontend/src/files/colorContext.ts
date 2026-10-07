// What Color by gives each record of Files' Transcript and Table modes (colorChoice.ts, Reader): per line, the color of
// its left edge (null for a record with no value) and whether its value is turned off, which hides the record. Null
// outside those modes, or with Color by off.
import { createContext } from 'react'

export interface RecordColor {
  color: string | null
  hidden: boolean
}

export const ColorContext = createContext<ReadonlyMap<number, RecordColor> | null>(null)
