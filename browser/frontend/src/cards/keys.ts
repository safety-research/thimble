// Letters typed at an empty message box, as the terminal routes them at an empty prompt (plugin/hooks/keys.ts): v first,
// when the chat shown has an answer to draw (v draws a card of it), then a card the chat shows that lists the letter
// (the card last clicked, else the newest), else the letter types as any letter. One word window for every key: a
// letter typed within WORD_MS after taken keys undoes them and puts the whole word in the box, so "very" or "sort" still
// type; a card's own keys in a row are not a word. v waits out the window before it starts, so a word that starts with
// v starts nothing.
import { cardsApi } from '../lib/api'
import { bus } from '../lib/bus'

export const WORD_MS = 350
/** The letters the page keeps for itself at an empty message box, which a card never gets (backend cards.OWN_KEYS). */
export const OWN_KEYS = ['v']

/** A card the chat shows: its keys, its element (to tell whether it is on screen) and when it was last clicked. */
interface Shown {
  ws: string
  id: string
  keys: readonly string[]
  el: HTMLElement
  at: number
  clicked: number
}

const shown = new Map<string, Shown>()
let order = 0

/** A card on screen says which keys it takes; call the returned function when it goes. */
export function showCard(ws: string, id: string, keys: readonly string[], el: HTMLElement): () => void {
  const was = shown.get(id)
  shown.set(id, { ws, id, keys, el, at: was?.at ?? ++order, clicked: was?.clicked ?? 0 })
  return () => {
    if (shown.get(id)?.el === el) shown.delete(id)
  }
}

/** The analyst clicked a card: its keys come first from now on. */
export function focusCard(id: string): void {
  const c = shown.get(id)
  if (c) c.clicked = Date.now()
}

/** Whether `el` shows in the chat's scrolled list now. */
function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  const list = el.closest('.chat-list')?.getBoundingClientRect()
  const top = list?.top ?? 0
  const bottom = list?.bottom ?? window.innerHeight
  return r.height > 0 && r.bottom > top && r.top < bottom
}

/** The card a letter goes to: among the cards on screen that list it, the one clicked last, else the newest. */
export function cardFor(key: string): Shown | null {
  const takers = [...shown.values()].filter((c) => c.keys.includes(key) && onScreen(c.el))
  if (!takers.length) return null
  return takers.sort((a, b) => b.clicked - a.clicked || b.at - a.at)[0]
}

/** The chat whose last answer v draws now, as the chat panel says it (vTarget): null while it runs or has none. */
let vNow: { ws: string; chat: string } | null = null
export function setVTarget(t: { ws: string; chat: string } | null): void {
  vNow = t
}

/** Start v on the chat's last answer; a refusal (no answer, one already drawing) is a toast in the server's words. */
export function startV(ws: string, chat: string): void {
  cardsApi.v(ws, chat).catch((e: Error) => bus.emit('toast', { text: `v did not start: ${e.message.replace(/^\d{3} /, '')}`, kind: 'error' }))
}

/** A card's key, sent; the card draws its answer (Card.tsx hears `cardDrawn`). */
async function sendKey(c: Shown, key: string): Promise<void> {
  try {
    bus.emit('cardDrawn', { id: c.id, drawing: await cardsApi.event(c.ws, c.id, 'key', { key }) })
  } catch (e) {
    bus.emit('toast', { text: `The card did not take ${key}: ${(e as Error).message}`, kind: 'error' })
  }
}

/** The keys taken in the word window open now, and how to give them back. */
let open: { at: number; keys: string; card: string | null; v: number | null } | null = null

function closeWindow(): void {
  if (open?.v != null) window.clearTimeout(open.v)
  open = null
}

/** A letter typed at an empty message box: true when it was taken (the box gets nothing now), false when it types.
 * `type(text)` puts a word in the box, when a later letter showed the keys before it were a word. */
export function keyAtEmpty(key: string, type: (text: string) => void): boolean {
  if (!/^\p{L}$/u.test(key)) return false
  const now = Date.now()
  if (open && now - open.at < WORD_MS) {
    const sameCard = open.card != null && !!cardFor(key) && cardFor(key)?.id === open.card
    if (!sameCard) {
      // a word: the keys taken before give back, and the word is typed
      const word = open.keys + key
      if (open.card) {
        const c = shown.get(open.card)
        const n = open.keys.length
        if (c) void cardsApi.event(c.ws, c.id, 'undo', { n }).then((d) => bus.emit('cardDrawn', { id: c.id, drawing: d }), () => undefined)
      }
      closeWindow()
      type(word)
      return true
    }
  } else closeWindow()
  if (key === 'v' && !open && vNow) {
    const target = vNow
    const v = window.setTimeout(() => {
      if (open?.v === v) {
        open = null
        startV(target.ws, target.chat)
      }
    }, WORD_MS)
    open = { at: now, keys: 'v', card: null, v }
    return true
  }
  if (OWN_KEYS.includes(key)) return false
  const c = cardFor(key)
  if (!c) return false
  open = { at: now, keys: (open?.card === c.id ? open.keys : '') + key, card: c.id, v: null }
  void sendKey(c, key)
  return true
}
