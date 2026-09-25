// The modifier key of the platform the page runs on. On a Mac the pointer (pointer/CmdPointer) and the shortcuts use ⌘.
// Elsewhere ⌘ is the Windows or Super key, which Linux desktops keep for themselves (Super with a click or a drag moves
// a window in GNOME), so Ctrl does the same there, and the Windows or Super key still works where the desktop leaves it
// to the page. On a Mac Ctrl with a click opens the context menu, so there Ctrl is not the pointer's key.

/** Whether the page runs on a Mac (or an iPad or iPhone), from the browser's platform. */
export function isMacPlatform(platform: string | undefined = currentPlatform()): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? '')
}

function currentPlatform(): string {
  if (typeof navigator === 'undefined') return ''
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return hinted || navigator.platform || navigator.userAgent || ''
}

/** Whether the pointer's modifier is held in the event: ⌘ on a Mac, Ctrl or the Windows or Super key elsewhere. */
export function pointKeyHeld(e: { metaKey: boolean; ctrlKey: boolean }, mac: boolean = isMacPlatform()): boolean {
  return mac ? e.metaKey : e.metaKey || e.ctrlKey
}

/** Whether `key` (a KeyboardEvent's `key`) is the pointer's modifier itself. */
export function isPointKey(key: string, mac: boolean = isMacPlatform()): boolean {
  return key === 'Meta' || (!mac && key === 'Control')
}

/** A shortcut as the platform writes it: `⌘G` on a Mac, `Ctrl+G` elsewhere. */
export function shortcutLabel(key: string, mac: boolean = isMacPlatform()): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`
}
