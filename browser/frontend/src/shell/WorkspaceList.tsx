// The workspaces this server knows (GET /workspaces), under Your folders: each folder's name and path, a link to its
// workspace (workspaceHref); `current` marks the workspace the page shows. The start page (StartPage) and the top bar's
// switcher (TopBar) draw the same list.
import { Icon } from '../components/Icon'
import type { WorkspaceRow } from '../lib/types'
import { shortPath, workspaceHref, workspaceLabel } from '../lib/workspace'

export interface WorkspaceListProps {
  rows: readonly WorkspaceRow[]
  /** the workspace the page shows, marked */
  current?: string | null
  /** the switcher's denser rows */
  compact?: boolean
}

export function WorkspaceList({ rows, current, compact }: WorkspaceListProps) {
  const pathname = typeof window === 'undefined' ? '/' : window.location.pathname
  return (
    <div className={`ws-list${compact ? ' ws-list-compact' : ''}`}>
      {rows.length > 0 && (
        <section className="ws-group" aria-label="Your folders">
          <h2 className="ws-group-title label">Your folders</h2>
          <ul className="ws-rows">
            {rows.map((r) => {
              const here = r.name === current
              return (
                <li key={r.name}>
                  <a className={`ws-row${here ? ' current' : ''}`} href={workspaceHref(r, pathname)} aria-current={here ? 'page' : undefined} data-ws={r.name}>
                    <span className="ws-row-name">{workspaceLabel(r)}</span>
                    <span className="ws-row-about">{r.path ? shortPath(r.path) : ''}</span>
                    <span className="ws-row-end">
                      {/* in the switcher every row keeps the check's room, so the rows line up */}
                      {current != null && <span className="ws-here-slot">{here && <Icon name="check" size={14} className="ws-here" title="Open in this tab" />}</span>}
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
