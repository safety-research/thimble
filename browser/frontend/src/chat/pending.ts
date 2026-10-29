// What asked for the chat while its column was folded: the shell opens the column and holds the request here, and the
// chat panel, once mounted and listening, takes it (a thread opened from the canvas, a followed call). Also text offered
// to a thread's composer from outside the chat (a failed fix's Ask Claude, chat/FixStrip), held until the composer takes
// it: as it mounts, and at each offer while it is mounted (chat/Composer).
import { bus, type Events } from '../lib/bus'

type Held = { event: 'openChat'; payload: Events['openChat'] } | { event: 'openRef'; payload: Events['openRef'] }

let held: Held[] = []

/** Keep a request for the chat panel that is not mounted yet. */
export function holdForChat(h: Held): void {
  held.push(h)
}

/** Text for a thread's composer. */
export interface Offer {
  thread: string
  text: string
}
let offers: Offer[] = []
const takers = new Set<() => void>()

/** Offer `text` to `thread`'s composer, which takes it now if it is mounted, else once it is. */
export function offerDraft(thread: string, text: string): void {
  offers.push({ thread, text })
  for (const take of [...takers]) take()
}

/** The text offered since the last take, which no other composer then takes. */
export function takeDrafts(): Offer[] {
  const list = offers
  offers = []
  return list
}

/** Call `take` at each offer; returns the unsubscribe. */
export function onDraftOffered(take: () => void): () => void {
  takers.add(take)
  return () => void takers.delete(take)
}

/** Send the held requests again, now that the chat panel listens. */
export function replayHeld(): void {
  const list = held
  held = []
  for (const h of list) {
    if (h.event === 'openChat') bus.emit('openChat', h.payload)
    else bus.emit('openRef', h.payload)
  }
}
