// The one clock the UI shows: HH:MM of a time stamp, local time, wrapped in <time class="time"> (styles/base.css).

/** HH:MM of an ISO time; '' for nothing, the text itself when it is not a time. */
export function hhmm(ts: string | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
