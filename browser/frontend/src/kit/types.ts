// A card program's drawing as the toolkit returns it (browser/kit/kit.js DrawKit.run): plain JSON that the server
// keeps with the card's run and the page draws (svg.js). Only the fields the page reads are typed.

export interface Knob {
  id: string
  label: string
  values: unknown[]
  i: number
}

export interface Drawing {
  kit: number
  w: number
  h: number
  mode?: string
  title?: string
  root: unknown
  regions?: { id: string; meta?: Record<string, unknown> }[]
  cites?: Record<string, unknown>
  examples?: Record<string, unknown>
  warnings?: string[]
  controls?: Knob[]
  /** the handlers the program declared (k.on): `press:<id>`, `press`, `brush`, a key */
  on?: { name: string; label?: string }[]
  /** the state the program's handlers answered with, which the next run reads */
  state?: Record<string, unknown>
  /** what a handler asked the analyst's next question to carry (k.ask) */
  ask?: { label?: string; text?: string } | null
  error?: { name: string; message: string; line?: number | null; fix?: string } | null
}

/** A program card's run as the server keeps it (canvas.KIT_MIME): the drawing of its data at `w` columns. */
export interface KitRun {
  drawing: Drawing
  data: unknown
  w: number
}

export const KIT_MIME = 'application/vnd.thimble.kit+json'
