// Files' views: File browser, then every view written for this corpus, one exclusive choice (Segmented), a view whose
// newer version builds or is reviewed with its chip shimmering; then proposals not built yet (spinner while building, a
// still warning dot while its session waits for permission, a warning icon and Retry on failure); then New view, a
// field that asks main for one. A view or a proposal shows × on hover, which deletes it once confirmed. A row across
// the top of Files, or, while Files shows in a pane beside another, in that pane's head (`compact`, portalled by
// FilesTab), where what does not fit goes in a ⋯ menu (viewsFit.ts). Refetches on bus `view`.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { openThread } from '../chat/Notes'
import { Button, Segmented } from '../components/Button'
import { TextInput } from '../components/Field'
import { Icon, type IconName } from '../components/Icon'
import { Menu, Popover } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { Tipped, useTooltip } from '../components/Tooltip'
import { pendingAsks, useChatMetas } from '../chat/waiting'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { refreshProposals, useProposals } from '../lib/proposals'
import { startSurfaceDrag } from '../lib/surfaces'
import { track } from '../lib/telemetry'
import type { Proposal, View, ViewReview } from '../lib/types'
import { useReadyViews, useUpdatedViews } from './viewReady'
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
  /** the files it reads, the first 500 of them, and how many there are */
  files?: string[]
  n_files?: number
  /** a file-type viewer thimble ships, which cannot be deleted */
  builtin?: boolean
  /** the files it claims, as globs: what a label made beside it applies to */
  claims?: string[]
  /** when it last passed its checks */
  built?: string
  /** the version it last passed its checks at, which a pane that opened an older one offers to reload */
  version?: string
  /** the review of its pictures, from its proposal */
  review?: ViewReview
  /** a newer version of it builds (a change, the orientation's improvement or a dev ticket) */
  updating?: boolean
}

/** Whether a proposal is a view the bar lists: built, or built before and being changed now. Pure. */
export function listedAsView(p: Proposal, known: ReadonlySet<string>): boolean {
  if (p.status === 'built') return true
  return (p.status === 'queued' || p.status === 'building') && !p.held && (!!p.revision || known.has(p.slug))
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
  const slugs = new Set(known.keys())
  const listed = proposals.filter((p) => listedAsView(p, slugs))
  // a view being changed keeps the version it last passed its checks at, which the views list gives
  const built: BuiltView[] = [
    ...listed.map((p) => {
      const v = known.get(p.slug)
      return { slug: p.slug, name: p.name, first_file: v?.first_file, files: v?.files, n_files: v?.n_files, claims: v?.claims, built: v?.built, version: v?.version, review: p.review, ...(p.status !== 'built' ? { updating: true } : {}) }
    }),
    ...views
      .filter((v) => !proposals.some((p) => p.slug === v.slug))
      .map((v) => ({ slug: v.slug, name: v.name, first_file: v.first_file, files: v.files, n_files: v.n_files, claims: v.claims, built: v.built, version: v.version, builtin: v.origin === 'builtin' })),
  ]
  // a viewer the File browser suggests for a file type shows there alone until it is accepted, and an orientation's
  // view appears once it is built
  return { views: built, proposals: proposals.filter((p) => !listed.includes(p) && p.status !== 'built' && p.status !== 'dropped' && p.status !== 'suggested' && !p.held) }
}

/** The spinner's words for a proposal's build: queued, building, or waiting for permission while a request of its
 * session is on the card. Pure. */
export function buildLabel(status: Proposal['status'], asking: boolean): string {
  if (status === 'queued') return 'Queued'
  return asking ? 'Waiting for permission' : 'Building'
}

/** A proposal in the bar: the view's button as the bar draws a view, its state after the name, a click that opens the
 * build's thread; for a failed build (a view the analyst asked for) a warning icon with the error on hover, and Retry
 * beside it; × on hover to delete it (`onDismiss` gets the proposal's box, which a confirm sits by). A viewer
 * suggested for a file type (in the File browser's mode row) wears the sparkle, shows its `why` on hover, and a click
 * builds it (`onAccept` runs then). */
export function ProposalOption({ ws, p, onDismiss, onAccept, size, asking = false }: { ws: string; p: Proposal; onDismiss: (at: HTMLElement) => void; onAccept?: () => void; size: 'md' | 'lg'; asking?: boolean }) {
  const [retrying, setRetrying] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const suggested = p.status === 'suggested' && !accepting
  const pending = p.status === 'queued' || p.status === 'building' || accepting
  const failed = p.status === 'failed'
  const { props: tipProps, tip } = useTooltip(suggested ? p.why : null, 'files-proposal-tip')
  const retry = () => {
    track('view-build', { target: `view:${p.slug}`, detail: { again: true } })
    setRetrying(true)
    api
      .retryProposal(ws, p.slug)
      .then(() => refreshProposals(ws))
      .catch((e: Error) => bus.emit('toast', { text: `Could not retry ${p.name}. ${e.message}`, kind: 'error' }))
      .finally(() => setRetrying(false))
  }
  const accept = () => {
    track('view-build', { target: `view:${p.slug}`, detail: { suggested: true } })
    setAccepting(true)
    onAccept?.()
    api
      .acceptProposal(ws, p.slug)
      .then(() => refreshProposals(ws))
      .catch((e: Error) => bus.emit('toast', { text: `Could not build ${p.name}. ${e.message}`, kind: 'error' }))
      .finally(() => setAccepting(false))
  }
  const icon = <Icon name={suggested ? 'sparkle' : failed ? 'warning' : 'view'} size={14} className={failed ? 'seg-ico files-proposal-failed' : 'seg-ico'} />
  return (
    <span className={`seg seg-${size} files-proposal`} data-status={accepting ? 'queued' : p.status}>
      <span className="seg-removable">
        <button
          type="button"
          className="seg-opt files-proposal-opt"
          data-anchor={`view:${p.slug}`}
          data-anchor-text={p.name}
          disabled={!suggested && !p.chat}
          onClick={() => {
            if (suggested) return accept()
            if (!p.chat) return
            track('chip-teleport', { target: `chat:${p.chat}`, detail: { kind: 'view-build' } })
            openThread(p.chat, 'view')
          }}
          {...tipProps}
        >
          {failed && p.error ? <Tipped text={p.error}>{icon}</Tipped> : icon}
          <span className="seg-label">{p.name}</span>
          {pending &&
            (asking ? (
              <Tipped text={buildLabel(p.status, asking)}>
                <span className="dot tt-waiting files-proposal-wait" role="status" aria-label={buildLabel(p.status, asking)} />
              </Tipped>
            ) : (
              <Spinner size={10} label={accepting ? 'Queued' : buildLabel(p.status, asking)} />
            ))}
        </button>
        <Button variant="icon" size="sm" icon="x" title="Delete" aria-label={`Delete ${p.name}`} className="seg-remove" onClick={(e) => onDismiss(e.currentTarget.closest<HTMLElement>('.files-proposal') ?? e.currentTarget)} />
      </span>
      {tip}
      {failed && (
        <Button size="sm" className="files-proposal-retry" busy={retrying} aria-label={`Retry ${p.name}`} onClick={retry}>
          Retry
        </Button>
      )}
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

/** What the × of a view or a proposal asks to delete, and the box the confirm sits by. */
interface Removing {
  slug: string
  name: string
  view: boolean
  at: HTMLElement
}

export function ViewsBar({ ws, value, onChange, views, proposals, compact = false }: Props) {
  const [gone, setGone] = useState<Set<string>>(new Set())
  const [removing, setRemoving] = useState<Removing | null>(null)
  const [askAt, setAskAt] = useState<HTMLButtonElement | null>(null)
  const [asking, setAsking] = useState(false)
  const [ask, setAsk] = useState('')
  const askInput = useRef<HTMLInputElement>(null)
  const ready = useReadyViews(ws)
  const updated = useUpdatedViews(ws)
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
  const remove = async ({ slug, name, view }: Removing) => {
    setRemoving(null)
    track('view-dismiss', { target: `view:${slug}` })
    hide(slug, true)
    if (value === viewKey(slug)) onChange(BROWSER)
    try {
      await (view ? api.deleteView(ws, slug) : api.deleteProposal(ws, slug))
      await refreshProposals(ws)
    } catch (e) {
      bus.emit('toast', { text: `Could not delete ${name}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      hide(slug, false)
    }
  }
  const dismiss = (p: Proposal, at: HTMLElement) => setRemoving({ slug: p.slug, name: p.name, view: false, at })
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

  const options: { value: string; label: string; icon: IconName; anchor?: string; dot?: boolean; note?: string; className?: string }[] = [
    { value: BROWSER, label: 'File browser', icon: 'folder-open' },
    ...views
      .filter((v) => !gone.has(v.slug))
      .map((v) => ({
        value: viewKey(v.slug),
        label: v.name,
        icon: 'view' as const,
        anchor: `view:${v.slug}`,
        dot: ready.includes(v.slug) || updated.includes(v.slug),
        note: ready.includes(v.slug) ? 'new' : updated.includes(v.slug) ? 'updated' : undefined,
        className: v.updating || v.review?.state === 'running' ? 'is-updating is-fresh' : ready.includes(v.slug) || updated.includes(v.slug) ? 'is-fresh' : undefined,
        ...(v.builtin ? {} : { removeLabel: `Delete ${v.name}`, onRemove: (at: HTMLElement) => setRemoving({ slug: v.slug, name: v.name, view: true, at }) }),
      })),
  ]
  const pending = proposals.filter((p) => !gone.has(p.slug))
  // the builds whose session waits for permission, read from their chats only while a build runs
  const metas = useChatMetas(ws, pending.some((p) => p.status === 'building' && !!p.chat))
  const askingChats = new Set(metas.filter((m) => pendingAsks(m).length > 0).map((m) => m.id))
  const askingFor = (p: Proposal) => p.status === 'building' && !!p.chat && askingChats.has(p.chat)
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
    ...hiddenOptions.map((o) => ({ id: o.value, label: o.label, icon: o.icon, checked: o.value === value, note: o.note, onSelect: () => onChange(o.value) })),
    ...hiddenProposals.map((p) => ({ id: `p:${p.slug}`, label: p.name, icon: 'view' as const, note: askingFor(p) ? 'waiting for permission' : STATE_NOTE[p.status], disabled: !p.chat, onSelect: () => openBuild(p) })),
  ]

  const confirm = (
    <Popover anchor={removing?.at} open={!!removing} onClose={() => setRemoving(null)} label={removing ? `Delete ${removing.name}` : 'Delete'} className="files-views-delete" width={280}>
      {removing && (
        <div className="files-views-delete-body">
          <p>Delete {removing.name}? It will not be proposed again.</p>
          <div className="files-views-delete-actions">
            <Button size="sm" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="secondary" className="files-views-delete-go" onClick={() => void remove(removing)}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </Popover>
  )
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
          <ProposalOption key={p.slug} ws={ws} p={p} size="lg" asking={askingFor(p)} onDismiss={(at) => dismiss(p, at)} />
        ))}
        <Button ref={setAskAt} icon="plus" className="files-views-new" active={asking} onClick={() => setAsking((o) => !o)}>
          New view
        </Button>
        {newView}
        {confirm}
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
            <ProposalOption key={p.slug} ws={ws} p={p} size="md" asking={askingFor(p)} onDismiss={(at) => dismiss(p, at)} />
          ))}
        {overflow.length > 0 && (
          <span className="files-views-more">
            <Menu label="More views" items={overflow} trigger={<Button variant="icon" size="sm" icon="more-horizontal" title="More views" aria-label="More views" />} />
            {hiddenOptions.some((o) => o.dot) && <span className="dot files-views-more-dot" role="img" aria-label="New" />}
          </span>
        )}
        <Button ref={setAskAt} variant="icon" size="sm" icon="plus" title="New view" aria-label="New view" className="files-views-new" active={asking} onClick={() => setAsking((o) => !o)} />
        {newView}
        {confirm}
      </div>
    </>
  )
}
