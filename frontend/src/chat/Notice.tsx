// A notice in a chat (backend notices.post): a failure the analyst should know of, with an easy fix, as one line in the
// warning's colours, an optional button that runs the fix, and × that dismisses it. A notice whose fix is a command
// (`/login`, `thimble server restart`) says it in its text, the command in code. A later notice with the same key
// replaces it (model.foldRecords), so a failure that happens again shows as one row. Dismissed notices are kept per
// workspace in this browser; a new notice of the same failure has an id of its own and shows again. A button that
// worked dismisses its notice; one that failed says why in a toast and leaves the notice.
import { useState, useSyncExternalStore } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { refreshProposals } from '../lib/proposals'
import { track } from '../lib/telemetry'
import type { NoticeAction } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import type { NoticeRow as NoticeRowT } from './model'
import { proposalsOff } from './ProposalCard'

/** The actions a notice's button can run; a notice with another one shows no button. */
export const NOTICE_DOS: readonly string[] = ['proposals-retry', 'proposals-off', 'settings', 'view-retry']
/** How many dismissed notices a workspace keeps (the newest). */
const DISMISSED_MAX = 200

const dismissedKey = (ws: string) => storageKey(ws, 'notices-dismissed')
const listeners = new Set<() => void>()
const cache = new Map<string, readonly string[]>()

/** The notices dismissed in workspace `ws`, by `<chat>:<id>`. */
export function dismissedNotices(ws: string): readonly string[] {
  let list = cache.get(ws)
  if (!list) {
    const raw = readStorage<unknown>(dismissedKey(ws), [])
    list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
    cache.set(ws, list)
  }
  return list
}

/** Dismiss notice `id` of `chat` in workspace `ws`, for every component that shows it. */
export function dismissNotice(ws: string, chat: string, id: string): void {
  const key = `${chat}:${id}`
  const list = dismissedNotices(ws)
  if (list.includes(key)) return
  const next = [...list, key].slice(-DISMISSED_MAX)
  cache.set(ws, next)
  writeStorage(dismissedKey(ws), next)
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Whether `action` is one this page can run. Pure. */
export const runnable = (action: NoticeAction | undefined): action is NoticeAction => !!action && NOTICE_DOS.includes(action.do) && (action.do !== 'view-retry' || !!action.slug)

/** Run a notice's action: true when the notice is answered and can go (Open Settings leaves it). */
export async function runNotice(ws: string, action: NoticeAction): Promise<boolean> {
  switch (action.do) {
    case 'proposals-retry':
      await api.proposeNow(ws)
      return true
    case 'proposals-off':
      await proposalsOff(ws)
      return true
    case 'settings':
      bus.emit('openSettings', {})
      return false
    case 'view-retry':
      if (!action.slug) return false
      await api.retryProposal(ws, action.slug)
      void refreshProposals(ws)
      return true
    default:
      return false
  }
}

/** A notice's text, a span in backticks drawn as code. Pure but for the elements. */
export function noticeText(text: string) {
  return text.split(/(`[^`\n]+`)/).map((part, i) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part))
}

export function NoticeRow({ item, ws, chat }: { item: NoticeRowT; ws: string; chat: string }) {
  const dismissed = useSyncExternalStore(subscribe, () => dismissedNotices(ws))
  const [busy, setBusy] = useState(false)
  if (dismissed.includes(`${chat}:${item.id}`)) return null
  const action = runnable(item.action) ? item.action : undefined
  const run = () => {
    if (!action || busy) return
    track('ui-click', { target: `notice:${item.key ?? item.id}`, detail: { action: action.do } })
    setBusy(true)
    runNotice(ws, action)
      .then((done) => done && dismissNotice(ws, chat, item.id))
      .catch((e: Error) => bus.emit('toast', { text: `${action.label} didn't work: ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' }))
      .finally(() => setBusy(false))
  }
  return (
    <div className="chat-notice" role="status" data-key={item.key} data-kind={item.noticeKind}>
      <Icon name="warning" size={13} className="chat-notice-ico" />
      <span className="chat-notice-text">{noticeText(item.text)}</span>
      {action && (
        <Button variant="secondary" size="sm" className="chat-notice-act" busy={busy} onClick={run}>
          {action.label}
        </Button>
      )}
      <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label="Dismiss" className="chat-notice-x" onClick={() => dismissNotice(ws, chat, item.id)} />
    </div>
  )
}
