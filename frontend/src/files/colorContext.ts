// What Color by gives each record of Files' Transcript mode (colorChoice.ts, Reader): per line, the color of its left edge
// (null for a record with no value) and whether its value is turned off, which hides the record. Null outside the
// Transcript mode, or with Color by off.
import { createContext } from 'react'

export interface RecordColor {
  color: string | null
  hidden: boolean
}

export const ColorContext = createContext<ReadonlyMap<number, RecordColor> | null>(null)
