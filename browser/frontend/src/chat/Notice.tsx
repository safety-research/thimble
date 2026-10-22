// Notices: a failure the analyst should know of, with what to do about it, in the warning's colors. A failure of
// thimble's own work in a chat (a check of the marks that could not run, a card runner that is down, a retry of a
// request) is a row of that chat (NoticeRow), with Fix this and Report this as a failure line offers them in the
// terminal. The notices the page makes itself (a sign-in link that is gone, lib/notices.ts) show in a strip above the
// composer and on the start page (NoticeStrip) until the analyst dismisses them (×).
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { dismissNotice, usePageNotices } from '../lib/notices'
import type { Notice } from '../lib/types'
import type { NoticeRow as NoticeRowT } from './model'
import { ReportThis } from '../shell/ShareReport'

/** A notice's text, a span in backticks drawn as code. Pure but for the elements. */
export function noticeText(text: string) {
  return text.split(/(`[^`\n]+`)/).map((part, i) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part))
}

/** One notice of the page's own, with ×. */
function PageNotice({ notice }: { notice: Notice }) {
  return (
    <div className="chat-notice" role="status" data-notice={notice.id} data-kind={notice.kind}>
      <Icon name="warning" size={13} className="chat-notice-ico" />
      <div className="chat-notice-body">
        <span className="chat-notice-text">{noticeText(notice.text)}</span>
      </div>
      <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label="Dismiss" className="chat-notice-x" onClick={() => dismissNotice(notice)} />
    </div>
  )
}

/** The notices this page made, above the composer, or on the start page (`start`), which has no chat. */
export function NoticeStrip({ start = false }: { start?: boolean }) {
  const notices = usePageNotices()
  if (!notices.length) return null
  return (
    <div className={`chat-notices${start ? ' start-notices' : ''}`} role="region" aria-label="Notices">
      {notices.map((n) => (
        <PageNotice key={n.id} notice={n} />
      ))}
    </div>
  )
}

/** A notice as a row of the chat it happened in (backend features/cards.py notice, agent.py retries): what failed and
 * what to do, then Fix this and Report this. */
export function NoticeRow({ item }: { item: NoticeRowT }) {
  return (
    <div className="chat-notice chat-notice-row" role="note" data-kind={item.noticeKind}>
      <Icon name="warning" size={13} className="chat-notice-ico" />
      <div className="chat-notice-body">
        <span className="chat-notice-text">{noticeText(item.text)}</span>
        {item.noticeKind !== 'retry' && <ReportThis text={item.text} className="chat-notice-report" />}
      </div>
    </div>
  )
}
