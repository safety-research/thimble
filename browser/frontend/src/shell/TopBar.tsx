// The top bar: at the left the thimble mark and the corpus's folder in mono, which opens the switcher, the server's
// workspaces as the start page lists them (WorkspaceList), this one marked, and on a demo page the Demo tag (DemoTag);
// the surfaces' tabs over the main area (a click shows the surface, a drag takes it to a pane); at the right Undo and
// Redo (shell/undo.ts), the links toggle, the theme popover and the settings gear (Report a problem… is in its menu).
// Before them, Fix… and the line of the fix Claude made (shell/FixEntry). What Claude and thimble are doing shows above
// the chat's input box (chat/ChatBusy).
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Button, type TabOption } from '../components/Button'
import { Icon } from '../components/Icon'
import { Popover } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { bus, type Tab } from '../lib/bus'
import { toggleLinks, useLinksVisible } from '../lib/links'
import type { WorkspaceRow } from '../lib/types'
import { shortPath, shownPath } from '../lib/workspace'
import { DemoTag } from './DemoTag'
import { FixButton, FixState } from './FixEntry'
import { SettingsPopover } from './SettingsPopover'
import { ThemePopover } from './ThemePopover'
import { undoTip, useUndo } from './undo'
import { WorkspaceList } from './WorkspaceList'
import { listedLabels, type SideTab } from './LensSidebar'
import { useLenses } from '../lib/lensMarks'
import { useConcepts } from '../canvas/concepts'
import { useFeature } from '../features'

export interface SurfaceTab extends TabOption<Tab> {
  /** `focus`: the focused pane shows it; `shown`: another pane does; `hidden`: no pane does */
  state: 'focus' | 'shown' | 'hidden'
}

export interface TopBarProps {
  ws: string
  tabs: readonly SurfaceTab[]
  onTab: (tab: Tab) => void
  onTabDrag: (e: ReactPointerEvent, tab: Tab) => void
  /** the Labels and Checks sidebar's tab while it is open (shell/LensSidebar.tsx), and how to open or close it */
  side?: SideTab | null
  onSide?: (tab: SideTab | null) => void
}

/** The top bar's two quiet buttons that open the Labels and Checks sidebar on their tab, each with its count; a button
 * whose feature is off (features.ts) is not shown. */
function SideButtons({ ws, side, onSide }: { ws: string; side: SideTab | null; onSide: (tab: SideTab | null) => void }) {
  const labelsOn = useFeature('labels')
  const lensesOn = useFeature('lenses')
  const concepts = useConcepts(ws)
  const lenses = useLenses(ws)
  const nLabels = listedLabels(concepts).length
  const button = (tab: SideTab, icon: 'label' | 'comment', word: string, n: number) => (
    <button type="button" className={`shell-side-btn${side === tab ? ' on' : ''}`} aria-pressed={side === tab} data-side={tab} onClick={() => onSide(side === tab ? null : tab)}>
      <Icon name={icon} size={14} />
      {word}
      <span className="shell-side-n">{n}</span>
    </button>
  )
  return (
    <span className="shell-side-btns">
      {labelsOn && button('labels', 'label', 'Labels', nLabels)}
      {lensesOn && button('checks', 'comment', 'Checks', lenses.length)}
    </span>
  )
}

export function TopBar({ ws, tabs, onTab, onTabDrag, side = null, onSide }: TopBarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [gear, setGear] = useState<HTMLButtonElement | null>(null)
  const [themeOpen, setThemeOpen] = useState(false)
  const [tools, setTools] = useState<HTMLSpanElement | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const links = useLinksVisible()
  const history = useUndo(ws)
  // a failure's Report a problem drafts a report through main (shell/ShareReport), which listens for it itself
  // a notice's Open Settings (chat/Notice.tsx, the bus's `openSettings`) opens the settings under the gear
  useEffect(
    () =>
      bus.on('openSettings', () => {
        setThemeOpen(false)
        setSettingsOpen(true)
      }),
    [],
  )
  useEffect(() => {
    let alive = true
    api
      .corpora()
      .then((cs) => alive && setPath(shownPath(cs.find((c) => c.name === ws))))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws])
  return (
    <header className="shell-topbar" data-panel="topbar">
      <span className="shell-brand">
        <Icon name="thimble" size={18} className="shell-mark" />
        <span className="shell-word">thimble</span>
        <WorkspaceSwitcher ws={ws} label={path ? shortPath(path) : ws} />
        <DemoTag />
      </span>
      <nav className="tabs shell-tabs" role="tablist" aria-label="Surfaces">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={t.state === 'focus'}
            className={`tab${t.state === 'focus' ? ' active' : t.state === 'shown' ? ' shown' : ''}`}
            data-tab={t.value}
            onPointerDown={(e) => onTabDrag(e, t.value)}
            onClick={() => onTab(t.value)}
          >
            <span className="tab-label">{t.label}</span>
            {t.dot && <span className="dot tab-dot" role="img" aria-label="Unread" />}
          </button>
        ))}
      </nav>
      <span className="shell-spacer" />
      <FixState ws={ws} />
      <FixButton />
      {onSide && <SideButtons ws={ws} side={side} onSide={onSide} />}
      <span ref={setTools} className="shell-tools">
        <Button variant="icon" icon="undo" title={undoTip(history.labels)} aria-label="Undo" disabled={!history.labels.undo && !history.labels.held} onClick={history.undo} data-tel="undo" />
        <Button variant="icon" icon="redo" title={history.labels.redo ? `Redo: ${history.labels.redo}` : 'Redo'} aria-label="Redo" disabled={!history.labels.redo} onClick={history.redo} data-tel="redo" />
        <Button variant="icon" icon={links ? 'link' : 'link-off'} title={links ? 'Hide links' : 'Show links'} aria-label={links ? 'Hide links' : 'Show links'} aria-pressed={links} className={`shell-links${links ? ' on' : ''}`} onClick={toggleLinks} data-tel="links" />
        <Button variant="icon" icon="palette" title="Theme" aria-label="Theme" aria-haspopup="dialog" aria-expanded={themeOpen} onClick={() => {
            setSettingsOpen(false)
            setThemeOpen((o) => !o)
          }}
          data-tel="theme" />
        <Button ref={setGear} variant="icon" icon="gear" title="Settings" aria-label="Settings" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => {
            setThemeOpen(false)
            setSettingsOpen((o) => !o)
          }}
          data-tel="settings" />
      </span>
      {/* the popover hangs under the tools, flush with their right end */}
      <ThemePopover anchor={tools} open={themeOpen} onClose={() => setThemeOpen(false)} />
      <SettingsPopover ws={ws} anchor={gear} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  )
}

/** The corpus's folder in the top bar, a button that opens the server's workspaces (WorkspaceList), loaded each time it
 * opens, this one marked; a row opens its workspace in this tab. */
export function WorkspaceSwitcher({ ws, label }: { ws: string; label: string }) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    api
      .workspaces()
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [open])
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="shell-corpus-name"
        title="Switch workspace"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-tel="switch-workspace"
      >
        {/* right to left so a long path is cut at its start and keeps the corpus folder's name */}
        <span className="shell-corpus-path" dir="rtl">
          <span dir="ltr">{label}</span>
        </span>
        <Icon name="chevron-down" size={12} className="shell-corpus-caret" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Workspaces" className="ws-switcher" width={480}>
        {error ? <p className="ws-switcher-error">{error}</p> : rows == null ? <Spinner size={12} label="Loading" className="ws-switcher-wait" /> : <WorkspaceList rows={rows} current={ws} compact />}
      </Popover>
    </>
  )
}
