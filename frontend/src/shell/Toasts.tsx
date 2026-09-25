// Toasts: the opaque overlay at the bottom right, from the bus, gone after a few seconds or on a click. An error has a
// negative edge and ✕; news has the accent dot and a chip to where it landed. A failure that names `report` also
// offers Report a problem and stays longer.
import { useEffect, useState } from 'react'
import { Mark } from '../components/Marks'
import { RefChip } from '../components/RefChip'
import { bus, type ProblemPrefill } from '../lib/bus'
import { ReportProblemButton } from './ProblemReport'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
  ref?: string
  report?: ProblemPrefill
}
const SHOW_MS = 5000
const REPORT_SHOW_MS = 15000
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
        // the toast event's optional `ref` is not in lib/bus.ts's type, so it is read past the type
        const ref = (t as { ref?: string }).ref
        const text = t.kind === 'error' ? toastText(t.text) : t.text
        setToasts((ts) => (ts.some((x) => x.text === text) ? ts : [...ts, { id, text, kind: t.kind ?? 'info', ref, report: t.report }]))
        window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.report ? REPORT_SHOW_MS : SHOW_MS)
      }),
    [],
  )
  if (!toasts.length) return null
  return (
    <div className="shell-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`shell-toast overlay${t.kind === 'error' ? ' shell-toast-error' : ''}`} onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>
          <Mark kind={t.kind === 'error' ? 'failed' : 'unread'} label={t.kind === 'error' ? 'error' : 'news'} />
          <span className="shell-toast-text">{t.text}</span>
          {t.ref && <RefChip ref={t.ref} compact />}
          {t.report && <ReportProblemButton description={t.report.description} focus={t.report.focus} className="shell-toast-report" />}
        </div>
      ))}
    </div>
  )
}
