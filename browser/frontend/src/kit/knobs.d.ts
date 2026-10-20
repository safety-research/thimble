// The types of knobs.js.
import type { Drawing, Knob } from './types'

export function knobOf(drawing: Drawing, id: string): (Knob & { shown: string[] }) | null
export function turn(drawing: Drawing, state: Record<string, unknown> | undefined, id: string | null, step: number): Record<string, unknown>
