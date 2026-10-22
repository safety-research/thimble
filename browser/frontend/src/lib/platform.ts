// The modifier keys of the platform the page runs on. On a Mac the shortcuts use ⌘. Elsewhere ⌘ is the Windows or
// Super key, which Linux desktops keep for themselves (Super with a click or a drag moves a window in GNOME), so Ctrl
// does the same there, and the Windows or Super key still works where the desktop leaves it to the page. On a Mac Ctrl
// with a click opens the context menu, so there Ctrl is not the pointer's key.
//
// The ask key: the key held with a click to ask about what it points at (pointer/CmdPointer), which Settings chooses
// (thimble's config `askKey`, shell/SettingsPopover): "meta", ⌘ (Ctrl or the Windows or Super key elsewhere), by
// default, or "alt", ⌥ (Alt elsewhere). The other key places a card freely on the canvas while it is dragged
// (freeKeyHeld). The choice is kept in browser storage too, so a page opened again knows it before the settings load.

/** Whether the page runs on a Mac (or an iPad or iPhone), from the browser's platform. */
export function isMacPlatform(platform: string | undefined = currentPlatform()): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? '')
}

function currentPlatform(): string {
  if (typeof navigator === 'undefined') return ''
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return hinted || navigator.platform || navigator.userAgent || ''
}

/** The key held with a click to ask: ⌘ (Ctrl off a Mac), or ⌥ (Alt off a Mac). */
export type AskKey = 'meta' | 'alt'
const STORED = 'thimble.askKey'

const readStored = (): AskKey => {
  try {
    return globalThis.localStorage?.getItem(STORED) === 'alt' ? 'alt' : 'meta'
  } catch {
    return 'meta'
  }
}

let askKey: AskKey = readStored()
const subs = new Set<() => void>()

/** The ask key chosen now. */
export const getAskKey = (): AskKey => askKey

/** Records the ask key the settings name (anything but "alt" is "meta"), for this page and the next one opened here. */
export function setAskKey(key: string | null | undefined): void {
  const next: AskKey = key === 'alt' ? 'alt' : 'meta'
  try {
    globalThis.localStorage?.setItem(STORED, next)
  } catch {
    /* the choice holds for this page */
  }
  if (next === askKey) return
  askKey = next
  subs.forEach((f) => f())
}

/** Calls `fn` each time the ask key changes; returns the unsubscribe. */
export function onAskKey(fn: () => void): () => void {
  subs.add(fn)
  return () => void subs.delete(fn)
}

/** Whether the shortcuts' modifier is held in the event: ⌘ on a Mac, Ctrl or the Windows or Super key elsewhere. */
export function modKeyHeld(e: { metaKey: boolean; ctrlKey: boolean }, mac: boolean = isMacPlatform()): boolean {
  return mac ? e.metaKey : e.metaKey || e.ctrlKey
}

/** Whether `key` (a KeyboardEvent's `key`) is the shortcuts' modifier itself. */
export function isModKey(key: string, mac: boolean = isMacPlatform()): boolean {
  return key === 'Meta' || (!mac && key === 'Control')
}

/** Whether the pointer's modifier, the ask key, is held in the event: for "meta" ⌘ on a Mac, Ctrl or the Windows or
 * Super key elsewhere; for "alt" ⌥, or Alt. */
export function pointKeyHeld(e: { metaKey: boolean; ctrlKey: boolean; altKey?: boolean }, mac: boolean = isMacPlatform(), key: AskKey = askKey): boolean {
  return key === 'alt' ? !!e.altKey : modKeyHeld(e, mac)
}

/** Whether `key` (a KeyboardEvent's `key`) is the pointer's modifier, the ask key, itself. */
export function isPointKey(key: string, mac: boolean = isMacPlatform(), ask: AskKey = askKey): boolean {
  return ask === 'alt' ? key === 'Alt' : isModKey(key, mac)
}

/** Whether the key that places a card freely on the canvas is held: of ⌘ (Ctrl) and ⌥ (Alt), the one that is not the
 * ask key. */
export function freeKeyHeld(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }, mac: boolean = isMacPlatform(), key: AskKey = askKey): boolean {
  return key === 'alt' ? modKeyHeld(e, mac) : e.altKey
}

/** The ask key as the platform writes it: ⌘ or ⌥ on a Mac, Ctrl or Alt elsewhere. */
export function askKeyLabel(mac: boolean = isMacPlatform(), key: AskKey = askKey): string {
  return key === 'alt' ? (mac ? '⌥' : 'Alt') : mac ? '⌘' : 'Ctrl'
}

/** A shortcut as the platform writes it: `⌘G` on a Mac, `Ctrl+G` elsewhere. */
export function shortcutLabel(key: string, mac: boolean = isMacPlatform()): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`
}
