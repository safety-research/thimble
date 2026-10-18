// The tour as the page loads it, on demand (shell/TourHost). On the page the analyst opened, only the welcome: a card
// that offers the tour, or says that it didn't open (offerTour). In the tour's frame on thimble's
// demo workspace (lib/tourFrame, shell/TourFrame), the tour itself over the bundled examples, from its first step, on
// the steps this layout can show, in a demo page's words (runTour).
import { askKeyLabel } from '../lib/platform'
import { createTour, type Snaps, type StartOptions, type Tour } from './engine'
import snaps from './examples.json'
import { offerTexts, tourSteps } from './steps'

let tour: Tour | null = null
const theTour = () => (tour ??= createTour(snaps as Snaps))

export interface OfferOptions extends Pick<StartOptions, 'onBegin' | 'onEnd'> {
  /** the page is a demo page (lib/demo) */
  demo: boolean
  /** what the card says: the welcome, or that the tour's frame did not open */
  state: 'offer' | 'failed'
}

/** The card on the analyst's page: the welcome that asks whether to take the tour, or a card that says the tour didn't
 * open and offers only to close (./steps offerTexts). */
export function offerTour(o: OfferOptions): Tour {
  const t = theTour()
  const said = offerTexts(o.state, o.demo)
  t.start([], { welcome: true, title: said.title, says: said.says, begin: said.begin, skip: said.skip, onBegin: o.onBegin, onEnd: o.onEnd })
  return t
}

export interface RunOptions extends Pick<StartOptions, 'showTab' | 'onEnd'> {
  /** the chat column is open: while it is folded the steps about the chat are left out */
  chat: boolean
}

/** The tour's steps, from the first, in the tour's frame: always in a demo page's words, since the frame shows thimble's
 * demo workspace even when a session is attached to it. */
export function runTour(o: RunOptions): Tour {
  const t = theTour()
  // the ask key Settings picks, as the platform writes it (⌘, ⌥, Ctrl or Alt)
  const steps = tourSteps(askKeyLabel(), o.chat)
  t.start(steps, { replay: true, showTab: o.showTab, onEnd: o.onEnd })
  return t
}

/** The tour once it has run, for the browser checks. */
export const currentTour = (): Tour | null => tour
