// The workspaces this server knows (GET /workspaces), under Your folders: one row per folder, its name and path, which
// opens its session picker (shell/SessionPicker): on the start page a link to it (pickHref), in the top bar's switcher
// (TopBar) the picker in place of the list (`onFolder`). `current` marks the folder of the workspace the page shows.
import type { MouseEvent } from 'react'
import { Icon } from '../components/Icon'
import type { WorkspaceRow } from '../lib/types'
import { folderRows, pickHref, shortPath, workspaceLabel } from '../lib/workspace'

export interface WorkspaceListProps {
  rows: readonly WorkspaceRow[]
  /** the workspace the page shows, whose folder is marked */
  current?: string | null
  /** the switcher's denser rows */
  compact?: boolean
  /** a folder's row clicked: the switcher shows its session picker in place of the list */
  onFolder?: (folder: string) => void
}

export function WorkspaceList({ rows, current, compact, onFolder }: WorkspaceListProps) {
  const pathname = typeof window === 'undefined' ? '/' : window.location.pathname
  const folders = folderRows(rows)
  return (
    <div className={`ws-list${compact ? ' ws-list-compact' : ''}`}>
      {folders.length > 0 && (
        <section className="ws-group" aria-label="Your folders">
          <h2 className="ws-group-title label">Your folders</h2>
          <ul className="ws-rows">
            {folders.map(({ row: r, names }) => {
              const here = current != null && names.includes(current)
              const click = onFolder
                ? (e: MouseEvent) => {
                    e.preventDefault()
                    onFolder(r.name)
                  }
                : undefined
              return (
                <li key={r.name}>
                  <a className={`ws-row${here ? ' current' : ''}`} href={pickHref(r.name, pathname)} onClick={click} aria-current={here ? 'page' : undefined} data-ws={r.name}>
                    <span className="ws-row-name">{workspaceLabel(r)}</span>
                    <span className="ws-row-about">{r.path ? shortPath(r.path) : ''}</span>
                    <span className="ws-row-end">
                      {/* in the switcher every row keeps the check's room, so the rows line up */}
                      {current != null && <span className="ws-here-slot">{here && <Icon name="check" size={14} className="ws-here" title="Open in this tab" />}</span>}
                      {onFolder && <Icon name="chevron-right" size={12} className="ws-row-go" />}
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
