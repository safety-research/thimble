// A view proposal's chip, the same wherever a proposal shows: the view's option as the views bar draws it (ViewTab),
// keyed by slug, followed by its build state. Queued or building: a spinner, and a click opens the build's thread.
// Built: a click opens the view (with Open after it while the analyst has not opened it yet, files/viewReady.ts).
// Failed: ✕ with the error in its tooltip, Retry, and Report a problem (shell/ProblemReport). A dropped proposal's chip
// is not drawn (lib/proposals isDropped). A built view whose last change failed (`failed_change`) shows the same.
import { useState } from 'react'
import type { MouseEvent } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Mark } from '../components/Marks'
import { Spinner } from '../components/Spinner'
import { Tipped } from '../components/Tooltip'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { findProposal, refreshProposals, useProposals } from '../lib/proposals'
import { track } from '../lib/telemetry'
import { teleport } from '../lib/teleport'
import { failureText, ReportProblemButton } from '../shell/ProblemReport'
import { useReadyViews } from '../files/viewReady'
import { openThread } from './Notes'

/** A chip that names a view, drawn as that view's unpicked option in the views bar, a size smaller, so it does not
 * change as the view is built. A button when it goes somewhere. */
export function ViewTab({ name, onClick, className = '' }: { name: string; onClick?: (e: MouseEvent<HTMLElement>) => void; className?: string }) {
  const cls = ['view-tab', className].filter(Boolean).join(' ')
  const inner = (
    <>
      <Icon name="view" size={12} className="view-tab-ico" />
      <span className="view-tab-name">{name}</span>
    </>
  )
  return onClick ? (
    <button type="button" className={cls} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <span className={cls}>{inner}</span>
  )
}

interface Props {
  ws: string
  /** the proposal's slug, when the chip's ref names it; else the newest proposal of `name` */
  slug?: string | null
  name: string
  className?: string
}

export function ViewChip({ ws, slug, name, className }: Props) {
  const proposals = useProposals(ws)
  const ready = useReadyViews(ws)
  const [retrying, setRetrying] = useState(false)
  const p = findProposal(proposals, slug, name)
  const key = p?.slug ?? slug ?? null
  const status = p?.status ?? null
  if (status === 'dropped') return null
  const pending = status === 'queued' || status === 'building'
  const changeFailed = status === 'built' && p?.failed_change != null
  const failed = status === 'failed' || changeFailed
  const open = () => {
    if ((pending || failed) && p?.chat) {
      track('chip-teleport', { target: `chat:${p.chat}`, detail: { kind: 'view-build' } })
      openThread(p.chat, 'view')
    } else if (key && !pending && !failed) {
      track('chip-teleport', { target: `view:${key}`, detail: { kind: 'view' } })
      teleport(`view:${key}`)
    }
  }
  const retry = () => {
    if (!p) return
    track('view-build', { target: `view:${p.slug}`, detail: { again: true } })
    setRetrying(true)
    api
      .retryProposal(ws, p.slug)
      .then(() => refreshProposals(ws))
      .catch((e: Error) => bus.emit('toast', { text: `Could not retry ${p.name}. ${e.message}`, kind: 'error' }))
      .finally(() => setRetrying(false))
  }
  const clickable = (pending || failed) ? !!p?.chat : !!key
  return (
    <span
      className={['view-chip', status ? `view-chip-${status}` : '', className ?? ''].filter(Boolean).join(' ')}
      data-anchor={key ? `view:${key}` : undefined}
      data-anchor-text={name}
      data-status={status ?? undefined}
    >
      <ViewTab name={name} className="view-chip-chip" onClick={clickable ? (e) => (e.stopPropagation(), open()) : undefined} />
      {pending && <Spinner size={10} label={status === 'queued' ? 'Queued' : 'Building'} />}
      {status === 'built' && !changeFailed && key && ready.includes(key) && (
        <Button size="sm" className="view-chip-open" aria-label={`Open ${name}`} onClick={(e) => (e.stopPropagation(), open())}>
          Open
        </Button>
      )}
      {failed && (
        <>
          {p?.error ? (
            <Tipped text={p.error} className="view-chip-why">
              <Mark kind="failed" className="view-chip-mark" />
            </Tipped>
          ) : (
            <Mark kind="failed" className="view-chip-mark" />
          )}
          <Button size="sm" className="view-chip-retry" busy={retrying} aria-label={`Retry ${name}`} onClick={(e) => (e.stopPropagation(), retry())}>
            Retry
          </Button>
          <ReportProblemButton compact description={failureText(changeFailed ? `The change to the view ${name} failed.` : `The view ${name} did not build.`, p?.error)} focus={p?.chat ? [p.chat] : []} className="view-chip-report" />
        </>
      )}
    </span>
  )
}
