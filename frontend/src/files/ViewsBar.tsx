// Files' views: File browser, then every view written for this corpus, one exclusive choice (Segmented); then proposals
// not built yet (spinner while building, ✕ and Retry on failure); then New view, a field that asks main for one. A row
// across the top of Files, or, while Files shows in a pane beside another, in that pane's head (`compact`, portalled by
// FilesTab), where what does not fit goes in a ⋯ menu (viewsFit.ts). Refetches on bus `view`.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { openThread } from '../chat/Notes'
import { Button, Segmented } from '../components/Button'
import { TextInput } from '../components/Field'
import { Icon, type IconName } from '../components/Icon'
import { Mark } from '../components/Marks'
import { Menu, Popover } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { Tipped } from '../components/Tooltip'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { refreshProposals, useProposals } from '../lib/proposals'
import { startSurfaceDrag } from '../lib/surfaces'
import { track } from '../lib/telemetry'
import type { Proposal, View, ViewReview } from '../lib/types'
import { useReadyViews } from './viewReady'
import { fitViews } from './viewsFit'

export const BROWSER = 'browser'
/** What the New view field says while it is empty: what to type, and where it goes. */
export const NEW_VIEW_PLACEHOLDER = 'Describe a view; Enter asks main'

/** The views bar's value for a view. */
export const viewKey = (slug: string): string => `v:${slug}`
export const slugOfKey = (key: string): string | null => (key.startsWith('v:') ? key.slice(2) : null)

export interface BuiltView {
  slug: string
  name: string
  first_file?: string | null
  /** the files it claims, as globs: what a label made beside it applies to */
  claims?: string[]
  /** when it last passed its checks: a new stamp is a new version of its page */
  built?: string
  /** the review of its pictures, from its proposal */
  review?: ViewReview
}

/** The views the bar lists and the proposals not yet built, read and kept fresh. */
export function useViews(ws: string): { views: BuiltView[]; proposals: Proposal[] } {
  const proposals = useProposals(ws) ?? []
  const [views, setViews] = useState<View[]>([])
  useEffect(() => {
    let alive = true
    const read = () => {
      api
        .views(ws)
        // a file-type viewer thimble ships is listed where the corpus holds a file it opens
        .then((v) => alive && setViews(v.filter((x) => x.ok && (x.origin !== 'builtin' || !!x.first_file))))
        .catch(() => {
          /* no views */
        })
    }
    read()
    const off = bus.on('view', () => read())
    return () => {
      alive = false
      off()
    }
  }, [ws])
  const known = new Map(views.map((v) => [v.slug, v]))
  const built: BuiltView[] = [
    ...proposals.filter((p) => p.status === 'built').map((p) => ({ slug: p.slug, name: p.name, first_file: known.get(p.slug)?.first_file, claims: known.get(p.slug)?.claims, built: known.get(p.slug)?.built, review: p.review })),
    ...views.filter((v) => !proposals.some((p) => p.slug === v.slug)).map((v) => ({ slug: v.slug, name: v.name, first_file: v.first_file, claims: v.claims, built: v.built })),
  ]
  return { views: built, proposals: proposals.filter((p) => p.status !== 'built' && p.status !== 'dropped') }
}

/** A proposal in the bar: the view's button as the bar draws a view, its state after the name, a click that opens the
 * build's thread; for a failed build (a view the analyst asked for) Retry beside it; × on hover to dismiss it. */
function ProposalOption({ ws, p, onDismiss, size }: { ws: string; p: Proposal; onDismiss: () => void; size: 'md' | 'lg' }) {
  const [retrying, setRetrying] = useState(false)
  const pending = p.status === 'queued' || p.status === 'building'
  const failed = p.status === 'failed'
  const retry = () => {
    track('view-build', { target: `view:${p.slug}`, detail: { again: true } })
    setRetrying(true)
    api
      .retryProposal(ws, p.slug)
      .then(() => refreshProposals(ws))
      .catch((e: Error) => bus.emit('toast', { text: `Could not retry ${p.name}. ${e.message}`, kind: 'error' }))
      .finally(() => setRetrying(false))
  }
  const mark = <Mark kind="failed" className="files-proposal-mark" />
  return (
    <span className={`seg seg-${size} files-proposal`} data-status={p.status}>
      <button
        type="button"
        className="seg-opt files-proposal-opt"
        data-anchor={`view:${p.slug}`}
        data-anchor-text={p.name}
        disabled={!p.chat}
        onClick={() => {
          if (!p.chat) return
          track('chip-teleport', { target: `chat:${p.chat}`, detail: { kind: 'view-build' } })
          openThread(p.chat, 'view')
        }}
      >
        <Icon name="view" size={14} className="seg-ico" />
        <span className="seg-label">{p.name}</span>
        {pending && <Spinner size={10} label={p.status === 'queued' ? 'Queued' : 'Building'} />}
        {failed && (p.error ? <Tipped text={p.error}>{mark}</Tipped> : mark)}
      </button>
      {failed && (
        <Button size="sm" className="files-proposal-retry" busy={retrying} aria-label={`Retry ${p.name}`} onClick={retry}>
          Retry
        </Button>
      )}
      <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label={`Dismiss ${p.name}`} className="files-proposal-x" onClick={onDismiss} />
    </span>
  )
}

interface Props {
  ws: string
  value: string
  onChange: (value: string) => void
  views: BuiltView[]
  proposals: Proposal[]
  /** in a pane's head beside another pane: md, New view a +, and a ⋯ menu for what does not fit */
  compact?: boolean
}

/** The ⋯ menu's note after a proposal's name: its build's state. */
const STATE_NOTE: Partial<Record<Proposal['status'], string>> = { queued: 'queued', building: 'building', failed: 'failed' }

export function ViewsBar({ ws, value, onChange, views, proposals, compact = false }: Props) {
  const [gone, setGone] = useState<Set<string>>(new Set())
  const [askAt, setAskAt] = useState<HTMLButtonElement | null>(null)
  const [asking, setAsking] = useState(false)
  const [ask, setAsk] = useState('')
  const askInput = useRef<HTMLInputElement>(null)
  const ready = useReadyViews(ws)
  const barRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  // the indices of the items that fit (the options, then the proposals), or null until measured: all of them
  const [fit, setFit] = useState<number[] | null>(null)
  useEffect(() => {
    if (asking) requestAnimationFrame(() => askInput.current?.focus())
  }, [asking])

  const hide = (slug: string, on: boolean) =>
    setGone((prev) => {
      const next = new Set(prev)
      if (on) next.add(slug)
      else next.delete(slug)
      return next
    })
  const dismiss = async (p: Proposal) => {
    track('view-dismiss', { target: `view:${p.slug}` })
    hide(p.slug, true)
    try {
      await api.deleteProposal(ws, p.slug)
      await refreshProposals(ws)
    } catch (e) {
      bus.emit('toast', { text: `Could not remove ${p.name}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      hide(p.slug, false)
    }
  }
  const sendAsk = () => {
    const text = ask.trim()
    if (!text) return
    track('view-build', { target: 'panel:files', detail: { asked: true } })
    setAsking(false)
    setAsk('')
    api.postEvent(ws, 'main', { text: `Build a view: ${text}` }).catch((e: Error) => bus.emit('toast', { text: `Could not ask for the view. ${e.message}`, kind: 'error' }))
  }

  const openBuild = (p: Proposal) => {
    if (!p.chat) return
    track('chip-teleport', { target: `chat:${p.chat}`, detail: { kind: 'view-build' } })
    openThread(p.chat, 'view')
  }

  const options: { value: string; label: string; icon: IconName; anchor?: string; dot?: boolean; className?: string }[] = [
    { value: BROWSER, label: 'File browser', icon: 'folder-open' },
    ...views.map((v) => ({ value: viewKey(v.slug), label: v.name, icon: 'view' as const, anchor: `view:${v.slug}`, dot: ready.includes(v.slug), className: v.review?.state === 'running' ? 'is-reviewing' : undefined })),
  ]
  const pending = proposals.filter((p) => !gone.has(p.slug))
  const active = options.findIndex((o) => o.value === value)
  const names = [...options.map((o) => o.label), ...pending.map((p) => p.name)].join('\u0000')

  // what fits: each item's width read from the hidden copy of the row, against the room the bar has; again whenever the
  // bar or the copy (a font arriving) changes size
  useLayoutEffect(() => {
    const bar = barRef.current
    const row = measureRef.current
    if (!bar || !row) return
    const measure = () => {
      // a bar not laid out (hidden, or no layout at all) shows every item
      if (!bar.clientWidth) return setFit(null)
      const kids = [...row.children] as HTMLElement[]
      const tail = kids.pop()!
      const more = kids.pop()!
      const gap = parseFloat(getComputedStyle(bar).columnGap) || 0
      const next = fitViews({ widths: kids.map((k) => k.offsetWidth), room: bar.clientWidth, gap, tail: tail.offsetWidth, more: more.offsetWidth, active })
      setFit((cur) => (cur && cur.length === next.length && cur.every((v, i) => v === next[i]) ? cur : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    ro.observe(row)
    return () => ro.disconnect()
  }, [names, active, compact])

  const shows = (i: number) => !fit || fit.includes(i)
  const hiddenOptions = options.filter((_, i) => !shows(i))
  const hiddenProposals = pending.filter((_, i) => !shows(options.length + i))
  const overflow = [
    ...hiddenOptions.map((o) => ({ id: o.value, label: o.label, icon: o.icon, checked: o.value === value, note: o.dot ? 'new' : undefined, onSelect: () => onChange(o.value) })),
    ...hiddenProposals.map((p) => ({ id: `p:${p.slug}`, label: p.name, icon: 'view' as const, note: STATE_NOTE[p.status], disabled: !p.chat, onSelect: () => openBuild(p) })),
  ]

  const newView = (
    <Popover anchor={askAt} open={asking} onClose={() => setAsking(false)} label="New view" className="files-views-ask">
      <form
        className="files-views-ask-form"
        onSubmit={(e) => {
          e.preventDefault()
          sendAsk()
        }}
      >
        <TextInput ref={askInput} value={ask} onChange={setAsk} block bare placeholder={NEW_VIEW_PLACEHOLDER} aria-label="New view" />
        <Button variant={ask.trim() ? 'primary' : 'secondary'} size="sm" icon="arrow-up" type="submit" title="Ask main" aria-label="Ask main for the view" className="composer-send files-views-ask-send" disabled={!ask.trim()} />
      </form>
    </Popover>
  )
  // a built view's option dragged out of the bar goes to a pane of its own (shell/PaneArea)
  const dragOut = (e: ReactPointerEvent) => {
    const opt = (e.target as Element).closest('.seg-opt[data-anchor^="view:"]')
    if (opt && !opt.closest('.files-proposal')) startSurfaceDrag(e, opt.getAttribute('data-anchor')!)
  }

  if (!compact)
    return (
      <div className="files-views" aria-label="Views" onPointerDown={dragOut}>
        <Segmented label="Views" size="lg" value={value} onChange={onChange} options={options} />
        {pending.map((p) => (
          <ProposalOption key={p.slug} ws={ws} p={p} size="lg" onDismiss={() => void dismiss(p)} />
        ))}
        <Button ref={setAskAt} icon="plus" className="files-views-new" active={asking} onClick={() => setAsking((o) => !o)}>
          New view
        </Button>
        {newView}
      </div>
    )

  return (
    <>
      {/* the row as it would be with every item, out of sight beside the bar, where what fits is measured */}
      <div ref={measureRef} className="files-views-measure seg" aria-hidden="true" inert>
        {options.map((o) => (
          <span key={o.value} className={'seg-opt-m' + (o.value === value ? ' active' : '')}>
            <Icon name={o.icon} size={14} className="seg-ico" />
            <span className="seg-label">{o.label}</span>
            {o.dot && <span className="dot seg-dot" />}
          </span>
        ))}
        {pending.map((p) => (
          <span key={p.slug} className="seg-opt-m">
            <Icon name="view" size={14} className="seg-ico" />
            <span className="seg-label">{p.name}</span>
            <Spinner size={10} label="" />
          </span>
        ))}
        <span className="btn btn-ghost btn-sm btn-square" />
        <span className="btn btn-ghost btn-sm btn-square" />
      </div>
      <div
        ref={barRef}
        className="files-views is-compact"
        aria-label="Views"
        onPointerDown={dragOut}
      >
        <Segmented label="Views" value={value} onChange={onChange} options={options.filter((_, i) => shows(i))} />
        {pending
          .filter((_, i) => shows(options.length + i))
          .map((p) => (
            <ProposalOption key={p.slug} ws={ws} p={p} size="md" onDismiss={() => void dismiss(p)} />
          ))}
        {overflow.length > 0 && (
          <span className="files-views-more">
            <Menu label="More views" items={overflow} trigger={<Button variant="icon" size="sm" icon="more-horizontal" title="More views" aria-label="More views" />} />
            {hiddenOptions.some((o) => o.dot) && <span className="dot files-views-more-dot" role="img" aria-label="New" />}
          </span>
        )}
        <Button ref={setAskAt} variant="icon" size="sm" icon="plus" title="New view" aria-label="New view" className="files-views-new" active={asking} onClick={() => setAsking((o) => !o)} />
        {newView}
      </div>
    </>
  )
}
