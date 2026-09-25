// Recovery for a lazy chunk that fails to load. Chunks carry their content hash, so when the server's build is replaced
// while a tab is open, the tab asks for files that are gone and the browser says only "Importing a module script
// failed". A chunk is fetched again once before its failure is shown, and when the server serves a different build, the
// tab reloads itself: never twice within RELOAD_GUARD_MS (a sessionStorage flag, so it cannot loop), and never while
// typed text would be lost, when it shows the "thimble was updated" line with Reload instead.
import { bus } from './bus'

export const RELOAD_KEY = 'thimble:chunk-reload'
export const RELOAD_GUARD_MS = 60_000
export const RETRY_DELAY_MS = 400
/** What a surface shows in place of a chunk that did not load, instead of the browser's own message. */
export const CHUNK_FAILED = 'thimble was updated while this tab was open, or the connection dropped. Reload the page.'

/** Whether `e` is a failed fetch of a module chunk (each browser words it differently, and Vite's preload its own way). */
export function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|Loading (CSS )?chunk .* failed/i.test(msg)
}

/** The text a surface shows for a failure: the chunk message for a chunk that did not load, else the error's own. */
export function failureText(e: unknown): string {
  if (isChunkError(e)) return CHUNK_FAILED
  return e instanceof Error ? e.message : String(e)
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** `load()`, tried `retries` more times after a chunk failure (any other failure is thrown at once). */
export async function retryImport<T>(load: () => Promise<T>, retries = 1, sleep: (ms: number) => Promise<void> = wait): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await load()
    } catch (e) {
      if (i >= retries || !isChunkError(e)) throw e
      await sleep(RETRY_DELAY_MS * (i + 1))
    }
  }
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

export interface RecoverDeps {
  /** the build this tab loaded, and the one the server serves now; null is unknown (dev mode, no answer) */
  loaded: () => Promise<string | null>
  served: () => Promise<string | null>
  /** whether text typed on the page would be lost by a reload */
  typing: () => boolean
  /** sessionStorage, or null where it is not available */
  storage: () => Store | null
  reload: () => void
  /** show the "thimble was updated" line with Reload */
  prompt: () => void
  now: () => number
}

/** Whether a reload may happen now, given when the last one for a missing chunk was (null: none, or not readable). */
export function mayReload(now: number, last: number | null): boolean {
  return last == null || !(now - last >= 0 && now - last < RELOAD_GUARD_MS)
}

/** After a chunk failed: reload once when the server serves another build, or ask for a reload when that would lose
 * typed text or a reload just happened; nothing when the build is the same (a dropped connection, not a stale page). */
export async function recoverStaleBuild(d: RecoverDeps): Promise<'reloaded' | 'prompted' | 'none'> {
  const [loaded, served] = await Promise.all([d.loaded(), d.served()])
  if (loaded == null || served == null || loaded === served) return 'none'
  if (d.typing()) {
    d.prompt()
    return 'prompted'
  }
  let store: Store | null = null
  let last: number | null = null
  try {
    store = d.storage()
    const raw = store?.getItem(RELOAD_KEY)
    last = raw ? Number(raw) || null : null
  } catch {
    store = null
  }
  // without a place to keep the flag a reload could loop, so it is left to the analyst
  if (!store || !mayReload(d.now(), last)) {
    d.prompt()
    return 'prompted'
  }
  try {
    store.setItem(RELOAD_KEY, String(d.now()))
  } catch {
    d.prompt()
    return 'prompted'
  }
  d.reload()
  return 'reloaded'
}

// ---- in the browser ----

let loadedBuild: Promise<string | null> | null = null

/** The build the server serves, or null (dev mode, no build, or no answer). */
export async function servedBuild(): Promise<string | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as { ui?: unknown }
    return typeof body.ui === 'string' ? body.ui : null
  } catch {
    return null
  }
}

/** The build this tab loaded: the server's answer when the page first asked, kept for the page's life. */
export function thisBuild(): Promise<string | null> {
  loadedBuild ??= servedBuild()
  return loadedBuild
}

/** Whether text typed on the page (a chat draft, a comment, a field) would be lost by a reload. */
function typedText(): boolean {
  try {
    for (const el of document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input:not([type]), input[type=text], input[type=search]')) {
      if (el.value.trim()) return true
    }
    const active = document.activeElement as HTMLElement | null
    return !!active?.isContentEditable && !!active.textContent?.trim()
  } catch {
    return false
  }
}

let recovering: Promise<unknown> | null = null

/** Recover from a chunk that did not load (once per failure burst). */
export function recoverInBrowser(): void {
  recovering ??= recoverStaleBuild({
    loaded: thisBuild,
    served: servedBuild,
    typing: typedText,
    storage: () => window.sessionStorage,
    reload: () => window.location.reload(),
    prompt: () => bus.emit('uiStale', {}),
    now: () => Date.now(),
  }).finally(() => {
    recovering = null
  })
}

/** A lazy chunk, fetched again once on a chunk failure; a final failure starts the recovery above and is thrown. */
export async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await retryImport(load)
  } catch (e) {
    if (isChunkError(e)) recoverInBrowser()
    throw e
  }
}

/** Notes the build this tab loaded, and recovers from a chunk failure no surface caught: Vite's preload of a chunk's
 * dependencies, or a dynamic import whose rejection nothing handled. */
export function installChunkRecovery(): void {
  void thisBuild()
  window.addEventListener('vite:preloadError', () => recoverInBrowser())
  window.addEventListener('unhandledrejection', (ev) => {
    if (isChunkError(ev.reason)) recoverInBrowser()
  })
}
