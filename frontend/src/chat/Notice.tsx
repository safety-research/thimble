// Notices (backend notices.py, lib/notices.ts): a failure of main or of one of thimble's agents that the analyst should
// know of, with an easy fix. Every open notice shows in the foreground, in a strip above the composer of whichever chat
// is open (NoticeStrip), under the view proposal card's place, and stays there across thread switches until the
// analyst dismisses it (×) or a fix that worked clears it. Each is one line in the warning's colors: the agent it
// happened to in bold ("Orientation", "View build: Agent Network"), the failure and, when the fix is a command
// (`/login`, `thimble server restart`), the command in code, and Open for the chat it happened in when another one is
// shown; then its fix as buttons under the words, and ×. A fix that went through dismisses the notice (a new failure brings a new one); one
// that failed, or that the server could not start, says why in a toast and leaves it. A failure of main's own request
// shows in the strip only while another chat is open, since main's chat shows its API error card. In the agent's own
// chat the notice is also a row (NoticeRow), the same words without buttons, kept as a quiet line of the chat's history
// once the notice is closed; while it is open the strip shows it there, and an earlier closed row under its key in the
// same words waits too, so the words show once. The Manual-mode notice (kind `manual-mode`,
// while main runs in Claude Code's Manual mode) is drawn in the problem red instead (styles/chat.css). The strip also
// tells of new comments, which are no failure: one notice in the accent's colors (NewCommentsNotice, kind `comments`)
// says how many comments the checks that are on left since the analyst last looked, and on what, with Show, which
// opens the first of them, and × (report/newComments.ts); this page makes it, so the server holds no such notice.
import { useState, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { dismissNotice, noticeActions, useNotices, useNoticesRead, usePageNotices } from '../lib/notices'
import { refreshProposals } from '../lib/proposals'
import { useChecks } from '../report/Checks'
import { CANVAS } from '../report/checkComments'
import { newCommentsText, surfaceName, useNewComments, type NewComments } from '../report/newComments'
import { track } from '../lib/telemetry'
import type { Notice, NoticeAction } from '../lib/types'
import type { NoticeRow as NoticeRowT } from './model'
import { proposalsOff } from './ProposalCard'
import { useDocLabels } from './SurfaceChips'

/** The actions a notice's button can run; one with another `do` shows no button. */
export const NOTICE_DOS: readonly string[] = ['proposals-retry', 'proposals-off', 'settings', 'view-retry', 'sign-out']

/** Whether `action` is one this page can run. Pure. */
export const runnable = (action: NoticeAction): boolean => NOTICE_DOS.includes(action.do) && ((action.do !== 'view-retry' && action.do !== 'sign-out') || !!action.slug)

/** Run a notice's action: true when the failure is answered and the notice can go (Open Settings leaves it). A fix the
 * server could not start (a check that cannot run now, a build refused at once) throws with its reason, which the
 * toast says, and the notice stays. Try again names the notice's key, so the check that failed is the one run again.
 * Sign it out signs out the browser a sign-in notice names (its slug). */
export async function runNotice(ws: string, action: NoticeAction, notice?: Pick<Notice, 'key'>): Promise<boolean> {
  switch (action.do) {
    case 'proposals-retry': {
      const got = await api.proposeNow(ws, notice?.key ?? undefined)
      if (got && got.started === false) throw new Error(got.reason || 'the check could not start')
      return true
    }
    case 'proposals-off':
      await proposalsOff(ws)
      return true
    case 'settings':
      bus.emit('openSettings', {})
      return false
    case 'view-retry': {
      if (!action.slug) return false
      const row = await api.retryProposal(ws, action.slug)
      void refreshProposals(ws)
      if (row?.refused) throw new Error(row.refused.reason || 'the build could not start')
      return true
    }
    case 'sign-out':
      if (!action.slug) return false
      await api.signOut(action.slug, ws)
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

/** The words of a notice: the agent in bold, then the failure, then what `after` adds (Open). */
function NoticeWords({ agent, text, after }: { agent: string; text: string; after?: ReactNode }) {
  return (
    <span className="chat-notice-text">
      {agent && <b className="chat-notice-agent">{agent}</b>}
      {agent && ' '}
      {noticeText(text)}
      {after && ' '}
      {after}
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
    runNotice(ws, a, notice)
      .then((done) => (done ? dismissNotice(ws, notice) : undefined))
      .catch((e: Error) => bus.emit('toast', { text: `${a.label} didn't work: ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' }))
      .finally(() => setBusy(null))
  }
  const open = notice.chat && notice.chat !== current ? notice.chat : null
  const openLink = open ? (
    <button
      type="button"
      className="chat-notice-open"
      onClick={() => {
        track('thread-switch', { target: `chat:${open}`, detail: { from: 'notice' } })
        onOpen(open)
      }}
    >
      Open
    </button>
  ) : undefined
  return (
    <div className="chat-notice" role="status" data-notice={notice.id} data-key={notice.key ?? undefined} data-kind={notice.kind} data-chat={notice.chat ?? undefined}>
      <Icon name="warning" size={13} className="chat-notice-ico" />
      <div className="chat-notice-body">
        <NoticeWords agent={agent} text={notice.text} after={openLink} />
        {actions.length > 0 && (
          <span className="chat-notice-acts">
            {actions.map((a) => (
              <Button key={`${a.do}:${a.slug ?? ''}`} variant="secondary" size="sm" className="chat-notice-act" busy={busy === a.do} disabled={!!busy && busy !== a.do} onClick={() => run(a)}>
                {a.label}
              </Button>
            ))}
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

/** Whether the strip shows a notice in the chat `current`: every one, but a failure of main's own request while main
 * is shown, whose API error card main's chat shows with its fix (backend notices.API). Pure. */
export const stripShows = (n: Pick<Notice, 'kind' | 'chat'>, current: string): boolean => !(n.kind === 'api' && n.chat === current)

/** The new comments of the checks that are on, in one notice: how many and on what (newCommentsText), Show, which
 * opens the first surface they are on at its first new comment, and ×. Both clear what they cover; so does opening one
 * of the comments on the page. */
export function NewCommentsNotice({ ws, news }: { ws: string; news: NewComments }) {
  const docs = news.runs.map((r) => r.surface).filter((s) => s !== CANVAS)
  const label = useDocLabels(ws, docs)
  return (
    <div className="chat-notice" role="status" data-notice="comments" data-kind="comments">
      <Icon name="comment" size={13} className="chat-notice-ico" />
      <div className="chat-notice-body">
        <NoticeWords
          agent=""
          text={newCommentsText(news.runs, (s) => surfaceName(s, label(s)))}
          after={
            <button type="button" className="chat-notice-open" onClick={news.show}>
              Show
            </button>
          }
        />
      </div>
      <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label="Dismiss" className="chat-notice-x" onClick={news.dismiss} />
    </div>
  )
}

/** Every open notice of the workspace, above the composer of the chat shown (`current`), oldest first, then the new
 * comments' notice. */
export function NoticeStrip({ ws, current, labels, onOpen }: { ws: string; current: string; labels?: ReadonlyMap<string, string>; onOpen: (chat: string) => void }) {
  const notices = useNotices(ws).filter((n) => stripShows(n, current))
  const news = useNewComments(ws, useChecks(ws))
  if (!notices.length && !news.runs.length) return null
  return (
    <div className="chat-notices" role="region" aria-label="Notices">
      {notices.map((n) => (
        <ForegroundNotice key={n.key || n.id} ws={ws} notice={n} current={current} agent={noticeAgent(n, labels)} onOpen={onOpen} />
      ))}
      {news.runs.length > 0 && <NewCommentsNotice ws={ws} news={news} />}
    </div>
  )
}

/** The notices this page made (lib/notices showPageNotice), on the start page, which has no workspace and no chat: a
 * link's sign-in code that was used or expired. */
export function PageNoticeStrip() {
  const notices = usePageNotices()
  if (!notices.length) return null
  return (
    <div className="chat-notices start-notices" role="region" aria-label="Notices">
      {notices.map((n) => (
        <ForegroundNotice key={n.key || n.id} ws="" notice={n} current="" agent="" onOpen={() => undefined} />
      ))}
    </div>
  )
}

/** Whether the strip says what a notice's row says, so the row waits (NoticeRow): the row's own notice is open (by its
 * id, or its key while the log has not closed the row), or, for a row the log closed, a later notice under its key that
 * says the same words is open, as when Claude's safeguards switch a thread's reply again after the analyst dismissed
 * the first notice. `open` is the open notices, once read. Pure. */
export function stripSays(item: Pick<NoticeRowT, 'id' | 'key' | 'text' | 'closed'>, open: readonly Pick<Notice, 'id' | 'key' | 'text'>[]): boolean {
  return open.some((n) => (item.closed ? !!item.key && n.key === item.key && n.text === item.text : n.id === item.id || (!!item.key && n.key === item.key)))
}

/** A notice as a row of the chat it happened in, for its history: a quiet line, without the agent's name (the chat is
 * its own), once a fix cleared it or the analyst dismissed it. While the strip above the composer shows it with its fix,
 * in this chat too, or shows a later notice in the same words, the row waits (stripSays); it shows only while the open
 * notices are not read. */
export function NoticeRow({ item, ws }: { item: NoticeRowT; ws: string }) {
  const open = useNotices(ws)
  const read = useNoticesRead(ws)
  if (read && stripSays(item, open)) return null
  // open while the log has not closed it and the open notices are not read yet; once they are, any row shown is closed
  const closed = item.closed || read
  return (
    <div className="chat-notice chat-notice-row" role="note" data-notice={item.id} data-key={item.key} data-kind={item.noticeKind} data-closed={closed || undefined}>
      <Icon name="warning" size={13} className="chat-notice-ico" />
      <div className="chat-notice-body">
        <NoticeWords agent="" text={item.text} />
      </div>
    </div>
  )
}
