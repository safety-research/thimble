// The feature switches in the terminal UI (term-transcript lane, build spec 3.6): /config's thimble rows kept in step
// with thimble's config file (`thimble features`), the push in config.set and the compare-and-pull at session.start,
// at activation and when the config file changes.
//
// SCAFFOLD STUB (C13): settingsNow answers every switch on (0.8.0's behavior). Nothing here runs at import.
import type { Ctx } from './ctx'
import type { FeatureSettings } from './contracts'

/** Every switch at its default: on. */
export const DEFAULT_SETTINGS: FeatureSettings = { autoActivate: true, viewProposals: true, labels: true, checks: true, citationMarks: true, coverage: true, cardCheck: true }

/** The feature switches as thimble holds them now. */
export async function settingsNow(_cx: Ctx): Promise<FeatureSettings> {
  return { ...DEFAULT_SETTINGS }
}
