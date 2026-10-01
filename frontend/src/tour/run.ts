// The tour as the page loads it, on demand (shell/TourHost): one tour over the bundled examples, started on the steps
// this layout can show.
import { isMacPlatform } from '../lib/platform'
import { createTour, type Snaps, type StartOptions, type Tour } from './engine'
import snaps from './examples.json'
import { tourSteps } from './steps'

let tour: Tour | null = null

export interface RunOptions extends Pick<StartOptions, 'showTab' | 'onEnd'> {
  /** the first launch, which asks first */
  welcome: boolean
  /** the chat column is open: while it is folded the steps about the chat are left out */
  chat: boolean
}

export function runTour(o: RunOptions): Tour {
  tour ??= createTour(snaps as Snaps)
  const steps = tourSteps(isMacPlatform() ? '⌘' : 'Ctrl', o.chat)
  tour.start(steps, { welcome: o.welcome, replay: !o.welcome, showTab: o.showTab, onEnd: o.onEnd })
  return tour
}

/** The tour once it has run, for the browser checks. */
export const currentTour = (): Tour | null => tour
