// Toasts: the opaque overlay at the bottom right, from the bus, gone after a few seconds or on a click. One rule says
// what is a toast: it confirms or fails the analyst's own click, or reports news with a link to where it landed (a
// view that is ready, a thread that got its answer, a report published as a Claude artifact). A state that lasts (a
// refused start, a write that failed, the server down) shows once, next to what it concerns, and is never also a toast.
// An error has a negative edge and ✕; news has the accent dot and a chip or a link to where it landed, and news with a
// thread's chip or a link stays longer, for a click on it. A span in backticks (a command such as
// `thimble-browser --continue`) is drawn as code, as a notice draws it.
import { useEffect, useState } from 'react'
import { Mark } from '../components/Marks'
import { RefChip } from '../components/RefChip'
import { bus } from '../lib/bus'
import { ThreadChip } from '../chat/Notes'
import { noticeText } from '../chat/Notice'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
  ref?: string
  thread?: { id: string; label: string }
  link?: { href: string; label: string }
}
const SHOW_MS = 5000
const THREAD_SHOW_MS = 15000
let seq = 0

/** An error's words without the HTTP status lib/api puts before the server's detail, first letter capitalised. Pure. */
export function toastText(text: string): string {
  return text.replace(/(^|[.:;]\s+)[45]\d\d\s+(\S)/g, (_, pre: string, first: string) => pre + (pre === '' || /[.;]/.test(pre) ? first.toUpperCase() : first))
}

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(
    () =>
      bus.on('toast', (t) => {
        const id = ++seq
        const text = t.kind === 'error' ? toastText(t.text) : t.text
        const same = (x: Toast) => x.text === text && x.thread?.id === t.thread?.id && x.link?.href === t.link?.href
        setToasts((ts) => (ts.some(same) ? ts : [...ts, { id, text, kind: t.kind ?? 'info', ref: t.ref, thread: t.thread, link: t.link }]))
        window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.thread || t.link ? THREAD_SHOW_MS : SHOW_MS)
      }),
    [],
  )
  if (!toasts.length) return null
  return (
    <div className="shell-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`shell-toast overlay${t.kind === 'error' ? ' shell-toast-error' : ''}`} onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>
          <Mark kind={t.kind === 'error' ? 'failed' : 'unread'} label={t.kind === 'error' ? 'error' : 'news'} />
          <span className="shell-toast-text">{noticeText(t.text)}</span>
          {t.ref && <RefChip ref={t.ref} compact />}
          {t.thread && <ThreadChip id={t.thread.id} label={t.thread.label} />}
          {t.link && (
            <a className="shell-toast-link" href={t.link.href} target="_blank" rel="noopener noreferrer">
              {t.link.label}
            </a>
          )}
        </div>
      ))}
    </div>
  )
}
