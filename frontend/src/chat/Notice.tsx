// Notices (backend notices.py, lib/notices.ts): a failure of main or of one of thimble's agents that the analyst should
// know of, with an easy fix. Every open notice shows in the foreground, in a strip above the composer of whichever chat
// is open (NoticeStrip), under the view proposal card's place, and stays there across thread switches until the
// analyst dismisses it (×) or a fix that worked clears it. Each is one line in the warning's colors: the agent it
// happened to in bold ("Orientation", "View build: Agent Network"), the failure and, when the fix is a command
// (`/login`, `thimble server restart`), the command in code, and Open for the chat it happened in when another one is
// shown; then its fix as buttons under the words, and ×. A fix that went through dismisses the notice (a new failure brings a new one); one
// that failed, or that the server could not start, says why in a toast and leaves it. A failure of main's own request
// shows in the strip only while another chat is open, since main's chat shows its API error card. Open notices in the
// same words, for the same agent and with the same fix (sameNotices), are one card that counts them (`×3`), as when
// Claude's safeguards switch the replies of several helpers of the orientation; its × and its fix answer every one of
// them, and its Open goes to the chat of the newest. In the agent's own chat the notice is also a row (NoticeRow), the
// same words without buttons, kept as a quiet line of the chat's history once the notice is closed; while it is open
// the strip shows it there, and an earlier closed row under its key in the same words waits too, so the words show
// once. The Manual-mode notice (kind `manual-mode`, while main runs in Claude Code's Manual mode) is drawn in the
// problem red instead (styles/chat.css). However many notices are open, the strip shows the newest in full and the rest
// as one row under it, "5 more notices ›", which opens them in place, each with its fix, Open and ×, and Dismiss all; so
// the chat keeps most of its column and no notice is cut off (bug hunt C21). When Claude's safeguards stop main's reply
// partway, its notice offers Make the card again, which sends main the words that ask for the card the reply did not
// add, and Ask again, which puts the analyst's last message back in main's composer to change and send (bug hunt C23).
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { api, labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { dismissNotice, noticeActions, useNotices, useNoticesRead, usePageNotices } from '../lib/notices'
import { refreshProposals } from '../lib/proposals'
import { teleport } from '../lib/teleport'
import { track } from '../lib/telemetry'
import type { Notice, NoticeAction } from '../lib/types'
import type { NoticeRow as NoticeRowT } from './model'
import { proposalsOff } from './ProposalCard'

/** The actions a notice's button can run; one with another `do` shows no button. */
export const NOTICE_DOS: readonly string[] = ['proposals-retry', 'proposals-off', 'settings', 'view-retry', 'sign-out', 'label-open', 'label-again', 'orient-again', 'card-again', 'ask-again']

/** The actions that name what they act on in `slug`. */
const SLUGGED: readonly string[] = ['view-retry', 'sign-out', 'label-open', 'label-again']

/** The actions whose words are their `text`. */
const TEXTED: readonly string[] = ['card-again', 'ask-again']

/** Whether `action` is one this page can run. Pure. */
export const runnable = (action: NoticeAction): boolean => NOTICE_DOS.includes(action.do) && (!SLUGGED.includes(action.do) || !!action.slug) && (!TEXTED.includes(action.do) || !!action.text?.trim())

/** Run a notice's action: true when the failure is answered and the notice can go (Open Settings leaves it). A fix the
 * server could not start (a check that cannot run now, a build refused at once) throws with its reason, which the
 * toast says, and the notice stays. Try again names the notice's key, so the check that failed is the one run again.
 * Sign it out signs out the browser a sign-in notice names (its slug). A label's notice opens the label (and stays) or
 * runs it again on the units its last run could not label; a failed orientation's runs it again, a start the module
 * refused saying why. A stopped reply's Make the card again sends main its words, and Ask again opens main with the
 * analyst's last message in the composer. */
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
    case 'label-open':
      if (action.slug) teleport(`concept:${action.slug}`)
      return false
    case 'label-again':
      if (!action.slug) return false
      await labelApi.applyAgain(ws, action.slug)
      return true
    case 'orient-again': {
      const got = await api.orientAgain(ws)
      if (!got.agentId && !got.program && got.kind) throw new Error(got.reason || 'the orientation did not start')
      return true
    }
    case 'card-again':
      if (!action.text?.trim()) return false
      bus.emit('openChat', { chatId: 'main', send: action.text })
      return true
    case 'ask-again':
      if (!action.text?.trim()) return false
      bus.emit('openChat', { chatId: 'main', draft: action.text })
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

/** The words of a notice: the agent in bold and, for `count` notices in the same words, how many, then the failure,
 * then what `after` adds (Open). */
function NoticeWords({ agent, text, after, count = 1 }: { agent: string; text: string; after?: ReactNode; count?: number }) {
  return (
    <span className="chat-notice-text">
      {agent && <b className="chat-notice-agent">{agent}</b>}
      {agent && ' '}
      {count > 1 && (
        <span className="chat-notice-count" title={`${count} notices in the same words`}>
          {`×${count}`}
        </span>
      )}
      {count > 1 && ' '}
      {noticeText(text)}
      {after && ' '}
      {after}
    </span>
  )
}

/** The open notices in the same words (sameNotices) in the foreground, as one card: their words with their count, their
 * fix, Open for the newest one's chat when another is shown, and ×, which dismisses every one of them. */
function ForegroundNotice({ ws, all, current, agent, onOpen }: { ws: string; all: readonly Notice[]; current: string; agent: string; onOpen: (chat: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const notice = all[all.length - 1]
  const actions = noticeActions(notice.action).filter(runnable)
  const target = `notice:${notice.key || notice.id}`
  const dismissAll = () => Promise.all(all.map((n) => dismissNotice(ws, n)))
  const run = (a: NoticeAction) => {
    if (busy) return
    track('ui-click', { target, detail: { action: a.do } })
    setBusy(a.do)
    runNotice(ws, a, notice)
      .then((done) => (done ? dismissAll() : undefined))
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
    <div className="chat-notice" role="status" data-notice={notice.id} data-key={notice.key ?? undefined} data-kind={notice.kind} data-chat={notice.chat ?? undefined} data-count={all.length > 1 ? all.length : undefined}>
      <Icon name="warning" size={13} className="chat-notice-ico" />
      <div className="chat-notice-body">
        <NoticeWords agent={agent} text={notice.text} after={openLink} count={all.length} />
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
          void dismissAll()
        }}
      />
    </div>
  )
}

/** Whether the strip shows a notice in the chat `current`: every one, but a failure of main's own request while main
 * is shown, whose API error card main's chat shows with its fix (backend notices.API). Pure. */
export const stripShows = (n: Pick<Notice, 'kind' | 'chat'>, current: string): boolean => !(n.kind === 'api' && n.chat === current)

/** The open notices as the strip shows them, oldest first: those in the same words, for the same agent (by its name,
 * `agent`), of the same kind and with the same fix as one, at the place of the first, with every one of them in `all`
 * (oldest first). A fix that names its notice's key (Try again of a view proposal check, runNotice) keeps its notices
 * apart, since each runs a check of its own. Pure. */
export function sameNotices<N extends Pick<Notice, 'id' | 'key' | 'kind' | 'text' | 'action'>>(notices: readonly N[], agent: (n: N) => string): { all: N[]; agent: string }[] {
  const groups = new Map<string, { all: N[]; agent: string }>()
  for (const n of notices) {
    const actions = noticeActions(n.action)
    const own = actions.some((a) => a.do === 'proposals-retry') ? (n.key ?? n.id) : ''
    const name = agent(n)
    const id = JSON.stringify([n.kind ?? '', name, n.text, actions.map((a) => [a.do, a.slug ?? '', a.label]), own])
    const g = groups.get(id)
    if (g) g.all.push(n)
    else groups.set(id, { all: [n], agent: name })
  }
  return [...groups.values()]
}

/** The strip's cards (sameNotices) newest first: by the time of the newest notice of each (its `ts`, which a notice
 * posted again under its key takes anew), then by its place in the open notices, a later one newer. Pure. */
export function newestFirst<C extends { all: readonly Pick<Notice, 'ts'>[] }>(cards: readonly C[]): C[] {
  const at = (c: C) => c.all.reduce((t, n) => (n.ts && n.ts > t ? n.ts : t), '')
  return cards
    .map((c, i) => ({ c, i, t: at(c) }))
    .sort((a, b) => (a.t === b.t ? b.i - a.i : a.t < b.t ? 1 : -1))
    .map((x) => x.c)
}

/** The words of the row that opens the strip's other notices: `5 more notices ›`. Pure. */
export const moreNotices = (n: number): string => `${n} more ${n === 1 ? 'notice' : 'notices'} ›`

/** Every open notice of the workspace, above the composer of the chat shown (`current`); those in the same words as one
 * card that counts them (sameNotices). The newest card shows in full; the others wait behind one row under it, `N more
 * notices ›`, which shows them there, newest first, each with its fix, Open and ×, and turns into Show fewer and
 * Dismiss all, which dismisses every open notice. */
export function NoticeStrip({ ws, current, labels, onOpen }: { ws: string; current: string; labels?: ReadonlyMap<string, string>; onOpen: (chat: string) => void }) {
  const notices = useNotices(ws).filter((n) => stripShows(n, current))
  const [open, setOpen] = useState(false)
  const cards = newestFirst(sameNotices(notices, (n) => noticeAgent(n, labels)))
  const more = cards.length - 1
  // once only one is left, the next notice that comes waits behind the row again
  useEffect(() => {
    if (more < 1) setOpen(false)
  }, [more])
  if (!cards.length) return null
  const card = ({ all, agent }: (typeof cards)[number]) => <ForegroundNotice key={all[0].key || all[0].id} ws={ws} all={all} current={current} agent={agent} onOpen={onOpen} />
  const shown = open && more > 0
  return (
    <div className="chat-notices" role="region" aria-label="Notices" data-open={shown || undefined}>
      {card(cards[0])}
      {shown && <div className="chat-notices-rest">{cards.slice(1).map(card)}</div>}
      {more > 0 && (
        <div className="chat-notices-more">
          <button
            type="button"
            className="chat-notices-toggle"
            aria-expanded={shown}
            onClick={() => {
              track('ui-click', { target: 'notices', detail: { action: shown ? 'fewer' : 'more' } })
              setOpen(!shown)
            }}
          >
            {shown ? 'Show fewer' : moreNotices(more)}
          </button>
          {shown && (
            <button
              type="button"
              className="chat-notices-all"
              onClick={() => {
                track('ui-click', { target: 'notices', detail: { action: 'dismiss-all' } })
                void Promise.all(notices.map((n) => dismissNotice(ws, n)))
              }}
            >
              Dismiss all
            </button>
          )}
        </div>
      )}
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
        <ForegroundNotice key={n.key || n.id} ws="" all={[n]} current="" agent="" onOpen={() => undefined} />
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
