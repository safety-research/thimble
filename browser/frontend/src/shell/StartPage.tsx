// thimble's start page: the page whose URL names no workspace, or names one this server does not hold (a tab kept from
// another run or another server). A title and the server's folders (WorkspaceList), each row opening its session
// picker, and a link whose sign-in key isn't valid anymore. With `pick` (`?pick=<c>`, which thimble-browser opens in a
// folder that has sessions) it is that folder's session picker (SessionPicker).
import { useEffect, useState } from 'react'
import { PageNoticeStrip } from '../chat/Notice'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import type { WorkspaceRow } from '../lib/types'
import { SessionPicker } from './SessionPicker'
import { WorkspaceList } from './WorkspaceList'

export function StartPage({ missing, pick }: { missing?: string | null; pick?: string | null }) {
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    api
      .workspaces()
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setError(`Could not reach the thimble server: ${(e as Error).message}`))
    return () => {
      alive = false
    }
  }, [])
  return (
    <div className="start" data-panel="start">
      <header className="start-bar">
        <Icon name="thimble" size={18} className="shell-mark" />
        <span className="shell-word">thimble</span>
      </header>
      <main className="start-main">
        <h1 className="start-title">{pick ? 'Sessions' : 'Workspaces'}</h1>
        <PageNoticeStrip />
        {missing && <p className="start-missing">No workspace “{missing}” on this server.</p>}
        {pick ? (
          <SessionPicker ws={pick} />
        ) : error ? (
          <p className="start-error">{error}</p>
        ) : rows == null ? (
          <Spinner size={14} label="Loading" />
        ) : rows.length ? (
          <WorkspaceList rows={rows} />
        ) : (
          <p className="start-empty">
            No folder is open. Run <code>thimble-browser</code> in a folder.
          </p>
        )}
      </main>
    </div>
  )
}
