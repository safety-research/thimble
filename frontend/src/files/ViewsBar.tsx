// Files' views: File browser, then every view written for this corpus, one exclusive choice (Segmented), a view whose
// newer version builds or is reviewed with its chip shimmering; then New view, a field that asks main for one. A view
// proposal shows here only once its view is built: until then its build is the chat's chip (chat/ViewChip) and its
// thread. A view shows × on hover, which deletes it once confirmed. A row across the top of Files, or, while Files shows
// in a pane beside another, in that pane's head (`compact`, portalled by FilesTab), where what does not fit goes in a ⋯
// menu (viewsFit.ts). The views list is the shared one (lib/views.ts).
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Button, Segmented } from '../components/Button'
import { TextInput } from '../components/Field'
import { Icon, type IconName } from '../components/Icon'
import { Menu, Popover } from '../components/Menu'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { demoStop } from '../lib/demo'
import { refreshProposals, useProposals } from '../lib/proposals'
import { useViewList } from '../lib/views'
import { startSurfaceDrag } from '../lib/surfaces'
import { track } from '../lib/telemetry'
import type { Proposal, View, ViewReview } from '../lib/types'
import { useReadyViews, useUpdatedViews } from './viewReady'
import { fitViews } from './viewsFit'

export const BROWSER = 'browser'
/** What the New view field says while it is empty: what to type, and where it goes. */
export const NEW_VIEW_PLACEHOLDER = 'Describe a view; Enter asks main'

/** The confirm of a view's delete, by the option whose × asked for it (`at`). It takes the focus, and gives it back to
 * that × when it closes, unless the focus has moved elsewhere. */
export function DeleteViewConfirm({ asked, onClose, onDelete }: { asked: { name: string; at: HTMLElement } | null; onClose: () => void; onDelete: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!asked) return
    const x = asked.at.querySelector<HTMLElement>('.seg-remove')
    requestAnimationFrame(() => cancelRef.current?.focus())
    return () => {
      if (x?.isConnected && (!document.activeElement || document.activeElement === document.body)) x.focus()
    }
  }, [asked])
  return (
    <Popover anchor={asked?.at} open={!!asked} onClose={onClose} label={asked ? `Delete ${asked.name}` : 'Delete'} className="files-views-delete" width={280}>
      {asked && (
        <div className="files-views-delete-body">
          <p>Delete {asked.name}? It will not be proposed again.</p>
          <div className="files-views-delete-actions">
            <Button size="sm" ref={cancelRef} onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" variant="secondary" className="files-views-delete-go" onClick={onDelete}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </Popover>
  )
}

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
  /** a newer version of it builds (a change or a dev ticket) */
  updating?: boolean
  /** its page draws label controls of its own (elements with data-label), so the Labels sidebar does not open by itself */
  label_controls?: boolean
  /** the npm packages its page loads (view.json's `libs`), which its head names */
  libs?: string[]
}

/** Whether a proposal is a view the bar lists: built, or built before and being changed now. Pure. */
export function listedAsView(p: Proposal, known: ReadonlySet<string>): boolean {
  if (p.status === 'built') return true
  return (p.status === 'queued' || p.status === 'building') && !p.held && (!!p.revision || known.has(p.slug))
}

/** The views the bar lists and the proposals not yet built (which the bar does not show), from the views list and the
 * proposals. A file viewer (`file_type`) is a mode of the File browser, so the bar leaves it and its proposal out, as it
 * leaves out a view switched off in Settings. Pure. */
export function barList(list: readonly View[], all: readonly Proposal[]): { views: BuiltView[]; proposals: Proposal[] } {
  const fileViewers = new Set(list.filter((x) => x.file_type).map((x) => x.slug))
  // a file-type viewer thimble ships is listed where the corpus holds a file it opens
  const views = list.filter((x) => x.ok && !x.file_type && (x.origin !== 'builtin' || !!x.first_file))
  const proposals = all.filter((p) => !fileViewers.has(p.slug) && !p.off)
  const known = new Map(views.map((v) => [v.slug, v]))
  const slugs = new Set(known.keys())
  const listed = proposals.filter((p) => listedAsView(p, slugs))
  // a view being changed keeps the version it last passed its checks at, which the views list gives
  const built: BuiltView[] = [
    ...listed.map((p) => {
      const v = known.get(p.slug)
      return { slug: p.slug, name: p.name, first_file: v?.first_file, files: v?.files, n_files: v?.n_files, claims: v?.claims, built: v?.built, version: v?.version, label_controls: v?.label_controls, libs: v?.libs, review: p.review, ...(p.status !== 'built' ? { updating: true } : {}) }
    }),
    ...views
      .filter((v) => !proposals.some((p) => p.slug === v.slug))
      .map((v) => ({ slug: v.slug, name: v.name, first_file: v.first_file, files: v.files, n_files: v.n_files, claims: v.claims, built: v.built, version: v.version, label_controls: v.label_controls, libs: v.libs, builtin: v.origin === 'builtin' })),
  ]
  // a view proposal (`suggested`) waits on the chat's card until it is accepted, and a held proposal (an orientation's
  // from before 0.8.0) appears once it is built
  return { views: built, proposals: proposals.filter((p) => !listed.includes(p) && p.status !== 'built' && p.status !== 'dropped' && p.status !== 'suggested' && !p.held) }
}

/** The views the bar lists and the proposals not yet built (barList), read and kept fresh; `ready` once both lists
 * have been read. */
export function useViews(ws: string): { views: BuiltView[]; proposals: Proposal[]; ready: boolean } {
  const proposals = useProposals(ws)
  const list = useViewList(ws)
  return { ...barList(list ?? [], proposals ?? []), ready: list != null && proposals != null }
}

interface Props {
  ws: string
  value: string
  onChange: (value: string) => void
  views: BuiltView[]
  /** in a pane's head beside another pane: md, New view a +, and a ⋯ menu for what does not fit */
  compact?: boolean
}

/** What the × of a view asks to delete, and the box the confirm sits by. */
interface Removing {
  slug: string
  name: string
  at: HTMLElement
}

export function ViewsBar({ ws, value, onChange, views, compact = false }: Props) {
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
  // the indices of the options that fit, or null until measured: all of them
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
  const remove = async ({ slug, name }: Removing) => {
    setRemoving(null)
    track('view-dismiss', { target: `view:${slug}` })
    hide(slug, true)
    if (value === viewKey(slug)) onChange(BROWSER)
    try {
      await api.deleteView(ws, slug)
      await refreshProposals(ws)
    } catch (e) {
      bus.emit('toast', { text: `Could not delete ${name}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      hide(slug, false)
    }
  }
  const sendAsk = () => {
    const text = ask.trim()
    if (!text || demoStop()) return
    track('view-build', { target: 'panel:files', detail: { asked: true } })
    setAsking(false)
    setAsk('')
    api.postEvent(ws, 'main', { text: `Build a view: ${text}` }).catch((e: Error) => bus.emit('toast', { text: `Could not ask for the view. ${e.message}`, kind: 'error' }))
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
        ...(v.builtin ? {} : { removeLabel: `Delete ${v.name}`, onRemove: (at: HTMLElement) => setRemoving({ slug: v.slug, name: v.name, at }) }),
      })),
  ]
  const active = options.findIndex((o) => o.value === value)
  const names = options.map((o) => o.label).join('\u0000')

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
  const overflow = hiddenOptions.map((o) => ({ id: o.value, label: o.label, icon: o.icon, checked: o.value === value, note: o.note, onSelect: () => onChange(o.value) }))

  const confirm = <DeleteViewConfirm asked={removing} onClose={() => setRemoving(null)} onDelete={() => removing && void remove(removing)} />
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
    if (opt) startSurfaceDrag(e, opt.getAttribute('data-anchor')!)
  }

  if (!compact)
    return (
      <div className="files-views" aria-label="Views" onPointerDown={dragOut}>
        <Segmented label="Views" size="lg" value={value} onChange={onChange} options={options} />
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
