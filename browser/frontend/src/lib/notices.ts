// The notices this page makes itself: a link's sign-in code that was used, replaced by a newer one or expired (lib/api.ts
// claimKey). The strip above the composer and the start page show them (chat/Notice.tsx) until the analyst dismisses
// one (×, which sends nothing) or a later link signs the browser in. A failure of thimble's own work in a chat is a row
// of that chat's log instead (chat/Notice.tsx NoticeRow).
import { useSyncExternalStore } from 'react'
import type { Notice } from './types'

/** The words of a sign-in code that is gone (backend auth: the server answers 410). */
export const CODE_GONE_TEXT = 'This sign-in link was already used or has expired. Press Enter in the terminal where thimble-browser runs for a new one.'
/** The start of the id of a notice this page made. */
export const PAGE_NOTICE = 'page:'
const CODE_GONE: Notice = { id: `${PAGE_NOTICE}code-gone`, kind: 'sign-in', text: CODE_GONE_TEXT }

let shown: readonly Notice[] = []
const subs = new Set<() => void>()

function set(next: readonly Notice[]): void {
  shown = next
  subs.forEach((fn) => fn())
}

/** The link's sign-in code was used, replaced or expired (POST /ui/key answered 410, or refused it otherwise). */
export function showCodeGone(): void {
  if (!shown.some((n) => n.id === CODE_GONE.id)) set([...shown, CODE_GONE])
}

/** A later link's code signed this browser in: the notice that an earlier one was gone goes. */
export function clearCodeGone(): void {
  dismissNotice(CODE_GONE)
}

/** The analyst's × on a notice: it goes from the page. */
export function dismissNotice(n: Pick<Notice, 'id'>): void {
  if (shown.some((x) => x.id === n.id)) set(shown.filter((x) => x.id !== n.id))
}

/** The notices this page made, oldest first. */
export function usePageNotices(): readonly Notice[] {
  return useSyncExternalStore(
    (fn) => (subs.add(fn), () => void subs.delete(fn)),
    () => shown,
    () => shown,
  )
}
