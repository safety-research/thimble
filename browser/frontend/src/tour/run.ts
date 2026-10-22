// The tour as the page loads it, on demand (shell/TourHost): one tour over the bundled examples, started on the steps
// this layout can show, in a demo page's words on a demo page (lib/demo).
import { isDemo } from '../lib/demo'
import { askKeyLabel } from '../lib/platform'
import { createTour, type Snaps, type StartOptions, type Tour } from './engine'
import snaps from './examples.json'
import { tourSteps, welcomeTexts } from './steps'

let tour: Tour | null = null

export interface RunOptions extends Pick<StartOptions, 'showTab' | 'onEnd'> {
  /** the first launch, which asks first */
  welcome: boolean
  /** the chat column is open: while it is folded the steps about the chat are left out */
  chat: boolean
}

export function runTour(o: RunOptions): Tour {
  tour ??= createTour(snaps as Snaps)
  const demo = isDemo()
  // the ask key Settings picks, as the platform writes it (⌘, ⌥, Ctrl or Alt)
  const steps = tourSteps(askKeyLabel(), o.chat, demo)
  tour.start(steps, { welcome: o.welcome, says: welcomeTexts(demo), replay: !o.welcome, showTab: o.showTab, onEnd: o.onEnd })
  return tour
}

