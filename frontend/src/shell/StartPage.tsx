// thimble's start page: the page whose URL names no workspace, which `thimble demo` opens, or names one this server does
// not hold (a tab kept from another run or another server). A title and the server's workspaces in groups
// (WorkspaceList), each row opening its workspace.
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import type { WorkspaceRow } from '../lib/types'
import { WorkspaceList } from './WorkspaceList'

export function StartPage({ missing }: { missing?: string | null }) {
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
        <h1 className="start-title">Workspaces</h1>
        {missing && <p className="start-missing">No workspace “{missing}” on this server.</p>}
        {error ? (
          <p className="start-error">{error}</p>
        ) : rows == null ? (
          <Spinner size={14} label="Loading" />
        ) : rows.length ? (
          <WorkspaceList rows={rows} />
        ) : (
          <p className="start-empty">
            No folder is open. Run <code>thimble</code> in a folder, or <code>thimble demo</code>.
          </p>
        )}
      </main>
    </div>
  )
}
