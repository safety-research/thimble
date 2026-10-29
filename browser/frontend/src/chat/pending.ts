// What asked for the chat while its column was folded: the shell opens the column and holds the request here, and the
// chat panel, once mounted and listening, takes it (a thread opened from the canvas, a followed call).
import { bus, type Events } from '../lib/bus'

type Held = { event: 'openChat'; payload: Events['openChat'] } | { event: 'openRef'; payload: Events['openRef'] }

let held: Held[] = []

/** Keep a request for the chat panel that is not mounted yet. */
export function holdForChat(h: Held): void {
  held.push(h)
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
