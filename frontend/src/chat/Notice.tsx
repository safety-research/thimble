// Notices (backend notices.py, lib/notices.ts): a failure of main or of one of thimble's agents that the analyst should
// know of, with an easy fix. Every open notice shows in the foreground, in a strip above the composer of whichever chat
// is open (NoticeStrip), under the view proposal card's place, and stays there across thread switches until the
// analyst dismisses it (×) or a fix that worked clears it. Each is one line in the warning's colors: the agent it
// happened to in bold ("Orientation", "View build: Agent Network"), the failure and, when the fix is a command
// (`/login`, `thimble server restart`), the command in code; then its fix as buttons, Open for the chat it happened in
// when another one is shown, and ×. A fix that went through dismisses the notice (a new failure brings a new one); one
// that failed says why in a toast and leaves it. In the agent's own chat the notice is also a row (NoticeRow), the same
// line without buttons, which stays as a quiet line of the chat's history once the notice is closed.
import { useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { dismissNotice, noticeActions, useNotices, useNoticesRead } from '../lib/notices'
import { refreshProposals } from '../lib/proposals'
import { track } from '../lib/telemetry'
import type { Notice, NoticeAction } from '../lib/types'
import type { NoticeRow as NoticeRowT } from './model'
import { proposalsOff } from './ProposalCard'

/** The actions a notice's button can run; one with another `do` shows no button. */
export const NOTICE_DOS: readonly string[] = ['proposals-retry', 'proposals-off', 'settings', 'view-retry']

/** Whether `action` is one this page can run. Pure. */
export const runnable = (action: NoticeAction): boolean => NOTICE_DOS.includes(action.do) && (action.do !== 'view-retry' || !!action.slug)

/** Run a notice's action: true when the failure is answered and the notice can go (Open Settings leaves it). */
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

/** The name a notice gives its agent: its own `agent`, else the label of the thread it happened in; none for main's. */
export function noticeAgent(n: Pick<Notice, 'agent' | 'chat'>, labels?: ReadonlyMap<string, string>): string {
  if (n.agent) return n.agent
  return n.chat && n.chat !== 'main' ? (labels?.get(n.chat) ?? '') : ''
}

/** The words of a notice: the agent in bold, then the failure. */
function NoticeWords({ agent, text }: { agent: string; text: string }) {
  return (
    <span className="chat-notice-text">
      {agent && <b className="chat-notice-agent">{agent}</b>}
      {agent && ' '}
      {noticeText(text)}
    </span>
  )
}

/** One open notice in the foreground: its words, its fix, Open for its chat when another is shown, and ×. */
function ForegroundNotice({ ws, notice, current, agent, onOpen }: { ws: string; notice: Notice; current: string; agent: string; onOpen: (chat: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const actions = noticeActions(notice.action).filter(runnable)
  const target = `notice:${notice.key || notice.id}`
  const run = (a: NoticeAction) => {
    if (busy) return
    track('ui-click', { target, detail: { action: a.do } })
    setBusy(a.do)
    runNotice(ws, a)
      .then((done) => (done ? dismissNotice(ws, notice) : undefined))
      .catch((e: Error) => bus.emit('toast', { text: `${a.label} didn't work: ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' }))
      .finally(() => setBusy(null))
  }
  const open = notice.chat && notice.chat !== current ? notice.chat : null
  return (
    <div className="chat-notice" role="status" data-notice={notice.id} data-key={notice.key ?? undefined} data-kind={notice.kind} data-chat={notice.chat ?? undefined}>
      <Icon name="warning" size={13} className="chat-notice-ico" />
      <div className="chat-notice-body">
        <NoticeWords agent={agent} text={notice.text} />
        {(actions.length > 0 || open) && (
          <span className="chat-notice-acts">
            {actions.map((a) => (
              <Button key={`${a.do}:${a.slug ?? ''}`} variant="secondary" size="sm" className="chat-notice-act" busy={busy === a.do} disabled={!!busy && busy !== a.do} onClick={() => run(a)}>
                {a.label}
              </Button>
            ))}
            {open && (
              <Button
                variant="ghost"
                size="sm"
                className="chat-notice-open"
                onClick={() => {
                  track('thread-switch', { target: `chat:${open}`, detail: { from: 'notice' } })
                  onOpen(open)
                }}
              >
                Open
              </Button>
            )}
          </span>
        )}
      </div>
      <Button
        variant="icon"
        size="sm"
        icon="x"
        title="Dismiss"
        aria-label="Dismiss"
        className="chat-notice-x"
        onClick={() => {
          track('ui-click', { target, detail: { action: 'dismiss' } })
          void dismissNotice(ws, notice)
        }}
      />
    </div>
  )
}

/** Every open notice of the workspace, above the composer of the chat shown (`current`), oldest first. */
export function NoticeStrip({ ws, current, labels, onOpen }: { ws: string; current: string; labels?: ReadonlyMap<string, string>; onOpen: (chat: string) => void }) {
  const notices = useNotices(ws)
  if (!notices.length) return null
  return (
    <div className="chat-notices" role="region" aria-label="Notices">
      {notices.map((n) => (
        <ForegroundNotice key={n.key || n.id} ws={ws} notice={n} current={current} agent={noticeAgent(n, labels)} onOpen={onOpen} />
      ))}
    </div>
  )
}

/** A notice as a row of the chat it happened in: the warning line while the notice is open (its fix is above the
 * composer), a quiet line once a fix cleared it or the analyst dismissed it. */
export function NoticeRow({ item, ws }: { item: NoticeRowT; ws: string }) {
  const open = useNotices(ws)
  const read = useNoticesRead(ws)
  // open while the log has not closed it and, once the open notices are read, they hold it
  const closed = item.closed || (read && !open.some((n) => n.id === item.id || (!!item.key && n.key === item.key)))
  return (
    <div className="chat-notice chat-notice-row" role="note" data-notice={item.id} data-key={item.key} data-kind={item.noticeKind} data-closed={closed || undefined}>
      <Icon name="warning" size={13} className="chat-notice-ico" />
      <div className="chat-notice-body">
        <NoticeWords agent={item.agent ?? ''} text={item.text} />
      </div>
    </div>
  )
}
