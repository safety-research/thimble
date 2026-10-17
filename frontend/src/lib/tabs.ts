// One tab of thimble's page per workspace (bug hunt round 9, J8: every press opened one more tab beside a live one, five
// after a quit, `claude -c`, `/thimble browser`, `thimble -c` and two ↗). The press (`thimble open`, backend open_cmd)
// hands its ref to the signed-in tabs whose stream is live (backend investigation.press, the stream's `press` event): a
// tab opens the ref, asks its browser to bring it to the front, and says it took it (takePress), so no other tab opens.
// A tab stopped with its server closes once another tab of its workspace on this origin runs the page: the press that
// started the server again opened that one, in front, and it says so when it starts (answerTabs); a stopped tab that
// missed it asks before it reloads once the server runs again (shell/ServerDown StoppedPage, liveElsewhere), and closes
// when one answers. A tab that came back by itself (noteCameBack) just before the press's tab started stops and closes
// when that one says it started (`elsewhere`), so the press's tab, in front, is the one left.
import { api } from './api'
import { pageStopped, stopPage } from './stale'
import { teleport } from './teleport'

/** The channel the tabs of this origin ask and answer on. */
export const TABS_CHANNEL = 'thimble-tabs'
/** How long a stopped tab waits for another to say it runs the page. */
export const ASK_MS = 500
/** A tab that came back by itself this recently gives way to a tab that starts the page on its workspace after it. */
export const CAME_BACK_MS = 60_000
const CAME_BACK_KEY = 'thimble-came-back'

/** This tab comes back by itself, now (shell/ServerDown StoppedPage): kept for its reload in the tab's session storage. */
export function noteCameBack(): void {
  try {
    window.sessionStorage.setItem(CAME_BACK_KEY, String(Date.now()))
  } catch {
    // no storage: the tab stays when another starts
  }
}

function cameBackLately(): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(CAME_BACK_KEY) || 0)
    return at > 0 && Date.now() - at < CAME_BACK_MS
  } catch {
    return false
  }
}

/** The press `data` ({ref, open}) handed to this tab of workspace `ws`: the ref opened ('home' opens nothing more), the
 * tab brought to the front where the browser lets it, and the press taken. */
export function takePress(ws: string, data: unknown): void {
  const d = (data ?? {}) as { ref?: unknown; open?: unknown }
  const open = typeof d.open === 'string' ? d.open : ''
  if (!open || pageStopped()) return
  try {
    window.focus()
  } catch {
    // a browser that refuses: the ref opens all the same
  }
  const ref = typeof d.ref === 'string' ? d.ref.trim() : ''
  if (ref && ref !== 'home') teleport(ref)
  void api.pressTaken(ws, open).catch(() => undefined)
}

/** Say to the tabs of this origin that thimble's page runs on `ws` here, now and to each that asks, while it runs; the
 * release. */
export function answerTabs(ws: string): () => void {
  if (typeof BroadcastChannel !== 'function') return () => undefined
  const ch = new BroadcastChannel(TABS_CHANNEL)
  ch.onmessage = (e: MessageEvent) => {
    const m = (e.data ?? {}) as { ask?: unknown; ws?: unknown; live?: unknown }
    if (m.ask === 'live' && m.ws === ws && !pageStopped()) ch.postMessage({ live: ws })
    // another tab started the page on this workspace just after this one came back by itself: it is the press's
    if (m.live === ws && !pageStopped() && cameBackLately()) stopPage('elsewhere')
  }
  if (!pageStopped()) ch.postMessage({ live: ws })
  return () => ch.close()
}

/** Call `fn` once another tab of this origin says it runs thimble's page on `ws` (answerTabs); the release. */
export function onLiveElsewhere(ws: string, fn: () => void): () => void {
  if (typeof BroadcastChannel !== 'function') return () => undefined
  const ch = new BroadcastChannel(TABS_CHANNEL)
  ch.onmessage = (e: MessageEvent) => {
    if (((e.data ?? {}) as { live?: unknown }).live === ws) fn()
  }
  return () => ch.close()
}

/** Whether another tab of this origin runs thimble's page on `ws` (answerTabs), asked for `ms`. */
export function liveElsewhere(ws: string, ms = ASK_MS): Promise<boolean> {
  if (typeof BroadcastChannel !== 'function') return Promise.resolve(false)
  return new Promise((resolve) => {
    const ch = new BroadcastChannel(TABS_CHANNEL)
    let timer = 0
    const done = (v: boolean) => {
      window.clearTimeout(timer)
      ch.close()
      resolve(v)
    }
    ch.onmessage = (e: MessageEvent) => {
      if (((e.data ?? {}) as { live?: unknown }).live === ws) done(true)
    }
    timer = window.setTimeout(() => done(false), ms)
    ch.postMessage({ ask: 'live', ws })
  })
}
