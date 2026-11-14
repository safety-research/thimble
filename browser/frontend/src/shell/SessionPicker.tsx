// The session picker of a folder (GET /ws/{c}/sessions, backend folder_sessions.py): New session first, then the
// folder's sessions, the latest first, each with when it was last written, its turns and cards and its first message,
// those open now (in a tab, or held by a thimble-browser) marked. A choice opens it (POST /ws/{c}/sessions/open) and
// the tab goes to the workspace that shows it: a session open now as it is, a new or earlier one in a workspace of the
// folder that is not open. thimble-browser opens the page on it in a folder that has sessions (`?pick=<c>`, StartPage),
// and the top bar's switcher draws it when a folder's name is clicked (TopBar).
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import type { FolderSessions, OpenSessionBody, SessionRow } from '../lib/types'
import { shortPath, workspaceHref } from '../lib/workspace'

/** How long ago `at` (epoch seconds) was, as thimble-browser's --resume list says it. Pure. */
export function sessionWhen(at: number, now: number = Date.now() / 1000): string {
  const s = Math.max(0, Math.floor(now - at))
  for (const [unit, n] of [['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
    if (s >= n) {
      const k = Math.floor(s / n)
      return `${k} ${unit}${k === 1 ? '' : 's'} ago`
    }
  }
  return 'just now'
}

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** What the picker sends to open a row: an earlier session by its archive, one open in a workspace by that workspace. */
export function openBody(row: Pick<SessionRow, 'archive' | 'slot'>): OpenSessionBody {
  return row.archive ? { archive: row.archive } : { slot: row.slot }
}

export interface SessionPickerProps {
  /** a workspace of the folder */
  ws: string
  /** the workspace this tab shows, whose row says so */
  current?: string | null
  /** the switcher's denser rows */
  compact?: boolean
}

export function SessionPicker({ ws, current, compact }: SessionPickerProps) {
  const [data, setData] = useState<FolderSessions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setError(null)
    api
      .sessions(ws)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [ws])
  const open = async (body: OpenSessionBody, key: string) => {
    if (!data || busy) return
    setBusy(key)
    try {
      const { name } = await api.openSession(data.folder, body)
      window.location.assign(workspaceHref({ name }, window.location.pathname))
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
    }
  }
  if (error && !data) return <p className="ws-switcher-error">{error}</p>
  if (!data) return <Spinner size={12} label="Loading" className="ws-switcher-wait" />
  return (
    <section className={`session-picker${compact ? ' session-picker-compact' : ''}`} aria-label={`Sessions of ${data.label}`} data-panel="session-picker">
      <header className="session-picker-head">
        <span className="session-picker-folder">{data.label}</span>
        <span className="session-picker-path">{shortPath(data.path)}</span>
      </header>
      <ul className="session-rows">
        <li>
          <button type="button" className="session-row session-new" disabled={busy != null} onClick={() => void open({ new: true }, 'new')} data-session="new">
            <span className="session-new-label">
              <Icon name="plus" size={14} />
              New session
            </span>
            <span className="session-end">{busy === 'new' && <Spinner size={10} label="Opening" />}</span>
          </button>
        </li>
        {data.sessions.map((r) => {
          const key = r.archive ?? r.slot
          const here = !r.archive && r.slot === current
          return (
            <li key={key}>
              <button type="button" className={`session-row${here ? ' current' : ''}`} disabled={busy != null} onClick={() => void open(openBody(r), key)} data-session={key}>
                <span className="session-when">{sessionWhen(r.at)}</span>
                <span className="session-first">{r.first || 'No message yet'}</span>
                <span className="session-counts">
                  {counted(r.turns, 'turn')} · {counted(r.cards, 'card')}
                </span>
                <span className="session-end">
                  {busy === key ? <Spinner size={10} label="Opening" /> : r.open && <span className="session-open">{here ? 'This tab' : 'Open now'}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {error && <p className="ws-switcher-error">{error}</p>}
    </section>
  )
}
