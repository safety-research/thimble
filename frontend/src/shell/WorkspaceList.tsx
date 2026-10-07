// The workspaces this server knows (GET /workspaces), in groups: Demo (the datasets `thimble demo` downloaded: the
// dataset's name, not its workspace's demo-<dataset>, the dataset's one sentence and "analysis ready" when its
// pre-cached orientation is installed), Examples (the worked
// examples of custom views: the name and the view it opens at) and Your folders (the folder's name and path). A group
// with no row is left out. Each row is a link to its workspace; `current` marks the workspace the page shows. The start
// page (StartPage) and the top bar's switcher (TopBar) draw the same list.
import { Chip } from '../components/Chip'
import { Icon } from '../components/Icon'
import type { WorkspaceRow } from '../lib/types'
import { groupWorkspaces, shortPath, workspaceHref, workspaceLabel } from '../lib/workspace'

export interface WorkspaceListProps {
  rows: readonly WorkspaceRow[]
  /** the workspace the page shows, marked */
  current?: string | null
  /** the switcher's denser rows */
  compact?: boolean
}

export function WorkspaceList({ rows, current, compact }: WorkspaceListProps) {
  const pathname = typeof window === 'undefined' ? '/' : window.location.pathname
  const hash = typeof window === 'undefined' ? '' : window.location.hash
  return (
    <div className={`ws-list${compact ? ' ws-list-compact' : ''}`}>
      {groupWorkspaces(rows).map((g) => (
        <section key={g.kind} className="ws-group" data-group={g.kind} aria-label={g.title}>
          <h2 className="ws-group-title label">{g.title}</h2>
          <ul className="ws-rows">
            {g.rows.map((r) => {
              const here = r.name === current
              return (
                <li key={r.name}>
                  <a className={`ws-row${here ? ' current' : ''}`} href={workspaceHref(r, pathname, hash)} aria-current={here ? 'page' : undefined} data-ws={r.name}>
                    <span className="ws-row-name">{workspaceLabel(r)}</span>
                    <span className="ws-row-about">
                      {r.kind === 'example' ? (
                        r.view && (
                          <Chip kind="label" icon="view" className="ws-view">
                            {r.view.name}
                          </Chip>
                        )
                      ) : (
                        about(r)
                      )}
                    </span>
                    <span className="ws-row-end">
                      {r.kind === 'demo' && r.ready && (
                        <Chip kind="status" tone="positive" face="sans" className="ws-ready">
                          analysis ready
                        </Chip>
                      )}
                      {/* in the switcher every row keeps the check's room, so the chips line up */}
                      {current != null && <span className="ws-here-slot">{here && <Icon name="check" size={14} className="ws-here" title="Open in this tab" />}</span>}
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** The row's second text: a dataset's sentence, a folder's path. */
function about(r: WorkspaceRow): string {
  if (r.kind === 'demo') return r.blurb || r.title || ''
  return r.path ? shortPath(r.path) : ''
}
