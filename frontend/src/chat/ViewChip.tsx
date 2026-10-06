// A view proposal's chip, the same wherever a proposal shows: the view's option as the views bar draws it (ViewTab),
// keyed by slug, followed by its build state. Each build is a view builder, a subagent of the analyst's Claude Code
// session (`thimble:view-builder`). Queued: at most VIEW_POOL build at once, so the chip says how many build ahead of it.
// Building: a spinner, a click opens the build's thread (each gate shows there as a step), its tooltip says where the
// terminal shows it, and a repair (a fresh builder after a build that failed for good) says which of VIEW_REPAIRS it is.
// Built: a click opens the view (with Open after it while the analyst has not opened it yet, files/viewReady.ts).
// Failed, or stopped when the analyst's Claude Code session ended: ✕ with why in its tooltip, Retry, and Report a
// problem (shell/ProblemReport); Retry is a click that starts a builder through thimble's plugin, and its menu picks the
// run's model and effort (Settings' dev row by default). A start that did not happen says why, with Start it where the
// kind takes it (chat/Refused). A dropped proposal's chip is not drawn (lib/proposals isDropped). A built view whose last
// change failed (`failed_change`) shows the same as a failed one. A suggested viewer for a file type, which the File
// browser offers beside Raw, is a plain name until it is accepted.
import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Mark } from '../components/Marks'
import { Menu, type MenuItem } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { Tipped } from '../components/Tooltip'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { hasEffort, loadSettings, modelChoices, modelLabel, sameModel } from '../lib/models'
import { findProposal, refreshProposals, useProposals } from '../lib/proposals'
import { track } from '../lib/telemetry'
import { teleport } from '../lib/teleport'
import type { Proposal, Settings, StartAnswer } from '../lib/types'
import { failureText, ReportProblemButton } from '../shell/ProblemReport'
import { useReadyViews } from '../files/viewReady'
import { AGENT_EFFORTS } from './ModelLine'
import { openThread } from './Notes'
import { refusalActions, refusalLine } from './Refused'

/** How many view builds run at once (backend dev.VIEW_POOL); the rest wait in the queue. */
export const VIEW_POOL = 3
/** How many fresh builders repair an orientation's proposal whose build failed for good (backend dev.VIEW_REPAIRS). */
export const VIEW_REPAIRS = 2

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

/** A queued build's words: how many build ahead of it in the pool. Pure. */
export function queuedText(proposals: readonly Pick<Proposal, 'status'>[]): string {
  const building = proposals.filter((p) => p.status === 'building').length
  return building ? `queued · ${building} of ${VIEW_POOL} building` : 'queued'
}

/** A building chip's word: a repair says which of VIEW_REPAIRS it is. Pure. */
export function buildingText(p: Pick<Proposal, 'repairs'> | null | undefined): string {
  return p?.repairs ? `repair ${p.repairs} of ${VIEW_REPAIRS}` : 'building'
}

/** The tooltip of a building chip: where the terminal shows its builder. */
export const BUILD_TERMINAL_TIP = 'In your terminal: ↓ to thimble:view-builder in the agent tray'

/** The words a build stopped by the analyst's quit shows. */
export const BUILD_QUIT_LINE = 'Stopped when your Claude Code session ended.'

/** Why a chip shows ✕, for its tooltip: the build's refusal, its stop at the quit, or its error. Pure. */
export function failedWhy(p: Pick<Proposal, 'error' | 'stopped_by' | 'refused'> | null | undefined): string {
  if (p?.refused) return refusalLine(p.refused)
  if (p?.stopped_by === 'quit') return BUILD_QUIT_LINE
  return p?.error ?? ''
}

/** The Build menu: the run's model and effort, Settings' dev row unless the analyst picks others here. */
function BuildMenu({ ws, name, values, onPick }: { ws: string; name: string; values: { model: string; effort: string }; onPick: (v: { model: string; effort: string }) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    let alive = true
    loadSettings(ws)
      .then((s) => alive && setSettings(s))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws])
  const items: MenuItem[] = [
    ...modelChoices(settings, values.model).map((m) => ({ id: `m:${m}`, label: modelLabel(m), note: m, checked: sameModel(m, values.model), onSelect: () => onPick({ model: m, effort: hasEffort(m) ? values.effort || 'high' : '' }) })),
    { id: 'sep', separator: true as const },
    ...(hasEffort(values.model) ? AGENT_EFFORTS.map((e) => ({ id: `e:${e}`, label: e, checked: e === values.effort, onSelect: () => onPick({ ...values, effort: e }) })) : []),
  ]
  return (
    <Menu
      label={`Build ${name} with`}
      items={items}
      trigger={
        <button type="button" className="view-chip-values" aria-label={`Model and effort for ${name}`} data-model={values.model} data-effort={values.effort} onClick={(e) => e.stopPropagation()}>
          {[values.model ? modelLabel(values.model) : '', values.effort].filter(Boolean).join(' · ') || 'model'}
          <Icon name="chevron-down" size={10} />
        </button>
      }
    />
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
  // the Build menu's pick: the proposal's last values, else Settings' dev row
  const [dev, setDev] = useState<{ model: string; effort: string } | null>(null)
  const [picked, setPicked] = useState<{ model: string; effort: string } | null>(null)
  useEffect(() => {
    let alive = true
    loadSettings(ws)
      .then((s) => alive && setDev({ model: s.models?.dev?.model ?? '', effort: s.models?.dev?.effort ?? '' }))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws])
  const key = p?.slug ?? slug ?? null
  const status = p?.status ?? null
  if (status === 'dropped') return null
  const pending = status === 'queued' || status === 'building'
  const changeFailed = status === 'built' && p?.failed_change != null
  const refused = !!p?.refused && !pending && status !== 'built'
  const failed = status === 'failed' || changeFailed || refused
  const ran = p?.values?.model ? { model: p.values.model, effort: p.values.effort ?? '' } : p?.model ? { model: p.model, effort: p.effort ?? '' } : null
  const values = picked ?? ran ?? dev ?? { model: '', effort: '' }
  const open = () => {
    if ((pending || failed) && p?.chat) {
      track('chip-teleport', { target: `chat:${p.chat}`, detail: { kind: 'view-build' } })
      openThread(p.chat, 'view')
    } else if (key && !pending && !failed) {
      track('chip-teleport', { target: `view:${key}`, detail: { kind: 'view' } })
      teleport(`view:${key}`)
    }
  }
  const after = (what: string) => (a: StartAnswer & Partial<Proposal>) => {
    if (a.kind && !a.agentId) bus.emit('toast', { text: `${what} ${name} didn't start: ${refusalLine({ kind: a.kind, reason: a.reason ?? '', expired: a.expired })}`, kind: 'error' })
    return refreshProposals(ws)
  }
  // Retry and Try again: a new builder through thimble's plugin, with the Build menu's values
  const retry = () => {
    if (!p) return
    track('view-build', { target: `view:${p.slug}`, detail: { again: true, ...values } })
    setRetrying(true)
    api
      .buildView(ws, p.slug, values.model ? { model: values.model, ...(values.effort ? { effort: values.effort } : {}) } : {})
      .then(after('The build of'))
      .catch((e: Error) => bus.emit('toast', { text: `Could not retry ${p.name}. ${e.message}`, kind: 'error' }))
      .finally(() => setRetrying(false))
  }
  // Start it: a refused typed build (main's propose_view call), started as a click with the same request
  const startIt = () => {
    const rid = p?.refused?.request
    if (!rid) return
    setRetrying(true)
    api
      .startIt(ws, rid)
      .then(after('The build of'))
      .catch((e: Error) => bus.emit('toast', { text: `Could not start ${name}. ${e.message}`, kind: 'error' }))
      .finally(() => setRetrying(false))
  }
  const actions = refused ? refusalActions(p!.refused!.kind, !!p!.refused!.expired) : []
  const clickable = status === 'suggested' ? false : pending || failed ? !!p?.chat : !!key
  const why = failedWhy(p)
  return (
    <span
      className={['view-chip', status ? `view-chip-${status}` : '', refused ? 'view-chip-refused' : '', className ?? ''].filter(Boolean).join(' ')}
      data-anchor={key ? `view:${key}` : undefined}
      data-anchor-text={name}
      data-status={status ?? undefined}
      data-refused={refused ? p!.refused!.kind : undefined}
      data-stopped-by={p?.stopped_by ?? undefined}
    >
      <ViewTab name={name} className="view-chip-chip" onClick={clickable ? (e) => (e.stopPropagation(), open()) : undefined} />
      {pending && (
        <Tipped text={status === 'building' ? BUILD_TERMINAL_TIP : `At most ${VIEW_POOL} views build at once`} className="view-chip-state">
          <Spinner size={10} label={status === 'queued' ? 'Queued' : 'Building'} />
          <span className="view-chip-word">{status === 'queued' ? queuedText(proposals ?? []) : buildingText(p)}</span>
        </Tipped>
      )}
      {status === 'built' && !changeFailed && key && ready.includes(key) && (
        <Button size="sm" className="view-chip-open" aria-label={`Open ${name}`} onClick={(e) => (e.stopPropagation(), open())}>
          Open
        </Button>
      )}
      {failed && (
        <>
          {why ? (
            <Tipped text={why} className="view-chip-why">
              <Mark kind="failed" className="view-chip-mark" />
            </Tipped>
          ) : (
            <Mark kind="failed" className="view-chip-mark" />
          )}
          {p?.stopped_by === 'quit' && !refused && <span className="view-chip-word">stopped</span>}
          {refused && <span className="view-chip-word">didn't start</span>}
          {actions.includes('start-it') ? (
            <Button size="sm" className="view-chip-start-it" busy={retrying} aria-label={`Start ${name}`} onClick={(e) => (e.stopPropagation(), startIt())}>
              Start it
            </Button>
          ) : !refused || actions.includes('try-again') ? (
            <Button size="sm" className="view-chip-retry" busy={retrying} aria-label={`${refused ? 'Try again' : 'Retry'} ${name}`} onClick={(e) => (e.stopPropagation(), retry())}>
              {refused ? 'Try again' : 'Retry'}
            </Button>
          ) : null}
          {!refused && <BuildMenu ws={ws} name={name} values={values} onPick={setPicked} />}
          {!refused && p?.stopped_by !== 'quit' && <ReportProblemButton compact description={failureText(changeFailed ? `The change to the view ${name} failed.` : `The view ${name} did not build.`, p?.error)} focus={p?.chat ? [p.chat] : []} className="view-chip-report" />}
        </>
      )}
    </span>
  )
}
