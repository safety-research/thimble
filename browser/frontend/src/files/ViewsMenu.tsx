// The ⋯ menu at the end of the views bar (ViewsBar), always there. In a pane's head it starts with the views that do not
// fit the bar (viewsFit.ts), each a pick as the bar's option is. Then Propose views: whether thimble proposes views after
// a turn and viewers for file types (thimble's config `views.propose`), which a view proposal's Don't ask again and a
// notice's Turn off view proposals turn off too (chat/ProposalCard proposalsOff). Then each view built for this
// workspace, the hidden ones too (backend views.local_extension), checked while it shows; resting on one, or its focus,
// shows its description beside the menu. Propose views and a view's check apply at once and leave the menu open, as the
// canvas's filter menu does; a pick closes it. A hidden view leaves the views bar, the File browser and the agents'
// prompts, its files and proposal kept (backend views.set_view_on).
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '../components/Button'
import { Icon, type IconName } from '../components/Icon'
import { MenuTip, Popover } from '../components/Menu'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { useSettingSwitch } from '../lib/models'
import { refreshProposals } from '../lib/proposals'
import { track } from '../lib/telemetry'
import type { LocalViewRow } from '../lib/types'
import { refreshViews } from '../lib/views'

/** The menu's button, by its tooltip and accessible name. */
export const VIEWS_MENU = 'More views'
/** The check of whether thimble proposes views. */
export const PROPOSE_VIEWS = 'Propose views'

/** A view the bar has no room for, picked from the menu as from the bar. */
export interface ViewPick {
  value: string
  label: string
  icon: IconName
  checked: boolean
  note?: string
  onSelect: () => void
}

/** What a view's row says on hover and keyboard focus: its description; '' for none. Pure. */
export const viewTip = (v: Pick<LocalViewRow, 'description'>): string => v.description?.trim() ?? ''

/** `rows` with the view `slug` shown (`on`) or hidden. Pure. */
export const withShown = (rows: readonly LocalViewRow[], slug: string, on: boolean): LocalViewRow[] => rows.map((r) => (r.slug === slug ? { ...r, on } : r))

/** A failed request's words without the status code the API puts first. */
const why = (e: Error) => e.message.replace(/^\d{3}\s+/, '')

/** The views built for this workspace, read each time the menu opens (null until the first read answers), and the
 * check of one: shown at once, then saved; the views bar and the File browser read their lists again once it is. A save
 * that fails says so and shows what the server holds. */
function useLocalViews(ws: string, open: boolean): [LocalViewRow[] | null, (v: LocalViewRow, on: boolean) => void] {
  const [rows, setRows] = useState<LocalViewRow[] | null>(null)
  const read = useCallback(
    () =>
      api
        .localViews(ws)
        .then((x) => setRows(x.views))
        .catch(() => setRows((r) => r ?? [])),
    [ws],
  )
  useEffect(() => {
    if (open) void read()
  }, [open, read])
  const turn = (v: LocalViewRow, on: boolean) => {
    setRows((r) => (r ? withShown(r, v.slug, on) : r))
    api
      .switchLocalView(ws, v.slug, on)
      .then((x) => {
        setRows(x.views)
        void refreshViews(ws).catch(() => undefined)
        void refreshProposals(ws)
      })
      .catch((e: Error) => {
        bus.emit('toast', { text: `Could not ${on ? 'show' : 'hide'} ${v.name}. ${why(e)}`, kind: 'error' })
        void read()
      })
  }
  return [rows, turn]
}

export function ViewsMenu({ ws, overflow = [], dot = false, size = 'md' }: { ws: string; overflow?: readonly ViewPick[]; dot?: boolean; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const listEl = useRef<HTMLDivElement>(null)
  const [propose, turnPropose] = useSettingSwitch(
    ws,
    (s) => s.propose_views !== false,
    (on) => ({ propose_views: on ? null : false }),
    (on, e) => bus.emit('toast', { text: `Could not turn view proposals ${on ? 'on' : 'off'}. ${why(e)}`, kind: 'error' }),
  )
  const [views, turnView] = useLocalViews(ws, open)
  const tipBase = useId()
  const [tip, setTip] = useState<{ id: string; el: HTMLElement; text: string } | null>(null)
  const close = useCallback(() => {
    // the focus in the menu, which is about to unmount, goes back to its button rather than to the page
    if (listEl.current?.contains(document.activeElement)) anchor?.querySelector<HTMLElement>('button')?.focus()
    setOpen(false)
  }, [anchor])
  useEffect(() => {
    if (!open) {
      setTip(null)
      return
    }
    // the focus goes to the first item a frame later, once the sheet is placed and shown (Menu does the same)
    const raf = requestAnimationFrame(() => listEl.current?.querySelector<HTMLButtonElement>('.menu-item')?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const all = Array.from(listEl.current?.querySelectorAll<HTMLButtonElement>('.menu-item') ?? [])
    if (!all.length) return
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    all[e.key === 'ArrowDown' ? (i + 1) % all.length : (i - 1 + all.length) % all.length].focus()
  }
  const check = (on: boolean) => <Icon name="check" size={14} className={`menu-check${on ? '' : ' is-off'}`} />
  return (
    <span ref={setAnchor} className="files-views-more">
      <Button variant="icon" size={size} icon="more-horizontal" title={VIEWS_MENU} aria-label={VIEWS_MENU} aria-haspopup="menu" aria-expanded={open} className="files-views-menu-btn" onClick={() => (open ? close() : setOpen(true))} />
      {dot && <span className="dot files-views-more-dot" role="img" aria-label="New" />}
      <Popover anchor={anchor} open={open} onClose={close} align="end" role="menu" label={VIEWS_MENU} className="files-views-menu">
        <div className="menu" ref={listEl} onKeyDown={onKey}>
          {overflow.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={o.checked}
              className={`menu-item${o.checked ? ' checked' : ''}`}
              data-item={o.value}
              onClick={() => {
                close()
                o.onSelect()
              }}
            >
              <Icon name={o.icon} size={14} className="menu-ico" />
              <span className="menu-item-label">{o.label}</span>
              {o.note != null && <span className="menu-item-note">{o.note}</span>}
              {o.checked && check(true)}
            </button>
          ))}
          {overflow.length > 0 && <div className="menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={!!propose}
            className={`menu-item${propose ? ' checked' : ''}`}
            data-item="propose"
            onClick={() => {
              track('chat-settings', { target: 'ui:propose-views', detail: { propose_views: !propose } })
              turnPropose(!propose)
            }}
          >
            <span className="menu-item-label">{PROPOSE_VIEWS}</span>
            {check(!!propose)}
          </button>
          {!!views?.length && <div className="menu-sep" role="separator" />}
          {views?.map((v) => {
            const text = viewTip(v)
            const tipId = `${tipBase}-${v.slug}`
            const show = text ? (e: { currentTarget: HTMLElement }) => setTip({ id: tipId, el: e.currentTarget, text }) : undefined
            const hide = text ? () => setTip((t) => (t?.id === tipId ? null : t)) : undefined
            return (
              <button
                key={v.slug}
                type="button"
                role="menuitemcheckbox"
                aria-checked={v.on}
                aria-describedby={tip?.id === tipId ? tipId : undefined}
                className={`menu-item${v.on ? ' checked' : ''}`}
                data-view={v.slug}
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={show}
                onBlur={hide}
                onClick={() => turnView(v, !v.on)}
              >
                <span className="menu-item-label">{v.name}</span>
                {check(v.on)}
              </button>
            )
          })}
        </div>
      </Popover>
      {open && tip && <MenuTip id={tip.id} anchor={tip.el} text={tip.text} className="tip-lines" />}
    </span>
  )
}
