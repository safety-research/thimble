// Shell.tsx: 0.9's shell on lean's data: the top bar (thimble, the folder, Files · Canvas · Report), the chat column on
// the left and one pane on the right with the surface the tab picked. The bottom panel (cite and explain cards, the
// card detail's bar) sits at the foot of the pane. Keys act while no text field has the focus (or the composer is
// empty): ] [ step through the marks, 1 asks from the panel or opens the focused card's detail, 0 closes, v s c press
// a verb on the latest message.
import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@09/components/Icon'
import { Resizer } from '@09/shell/Resizer'
import { ChatPanel } from './chat/ChatPanel'
import { CanvasPane } from './canvas/CanvasPane'
import { CardDetail } from './canvas/CardDetail'
import { FilesPane } from './files/FilesPane'
import { ReportPane } from './report/ReportPane'
import { getState, setState, useStore, type Surface } from './lib/store'
import { allMarks, pressVerb, rowVerbs, stepMark } from './lib/actions'
import { detailKey } from './canvas/CardDetail'

const CHAT = { def: 308, min: 280, max: 640 }
const TABS: { id: Surface; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'report', label: 'Report' },
]
const WIDTH_KEY = 'thimble-lean:chat-width'

function readWidth(): number {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY))
    return w >= CHAT.min && w <= CHAT.max ? w : CHAT.def
  } catch {
    return CHAT.def
  }
}

/** What the page's link asked for: a card's detail (?card=, the old /card/ link) or a row of the chat (#row=). */
function fromUrl() {
  const q = new URLSearchParams(location.search)
  const h = new URLSearchParams(location.hash.slice(1))
  const card = q.get('card') || q.get('o')
  if (card) setState({ surface: 'canvas', card: { id: card, v: q.get('v') ? Number(q.get('v')) : null, region: h.get('r') }, selected: card })
  const row = h.get('row')
  if (row) setState({ flashRow: row, thread: 'main' })
  const view = q.get('view')
  if (view) setState({ surface: 'files', filesView: view })
}

export function Shell() {
  const surface = useStore((s) => s.surface)
  const card = useStore((s) => s.card)
  const info = useStore((s) => s.info)
  const live = useStore((s) => s.live)
  const [width, setWidth] = useState(readWidth)
  useEffect(fromUrl, [])
  useEffect(() => {
    document.title = info?.folder ? `${info.folder} · thimble` : 'thimble'
  }, [info?.folder])
  useKeys()
  const paneX = 12 + width + 12
  const path = info?.root ? shortPath(info.root) : ''
  return (
    <div className="shell" data-chat="open" data-live={live ? '' : undefined} style={{ '--pane-x': `${paneX}px` } as React.CSSProperties}>
      <header className="shell-topbar" data-panel="topbar">
        <span className="shell-brand">
          <Icon name="thimble" size={18} className="shell-mark" />
          <span className="shell-word">thimble</span>
          <span className="shell-corpus-name lean-corpus" title={info?.root || ''}>
            <span className="shell-corpus-path" dir="rtl">
              <span dir="ltr">{path}</span>
            </span>
          </span>
        </span>
        <nav className="tabs shell-tabs" role="tablist" aria-label="Surfaces">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={surface === t.id}
              className={`tab${surface === t.id ? ' active' : ''}`}
              data-tab={t.id}
              onClick={() => setState({ surface: t.id, card: t.id === 'canvas' ? getState().card : null })}
            >
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
        <span className="shell-spacer" />
        <span className="shell-tools lean-live" title={live ? 'Connected to the terminal session on 127.0.0.1' : 'The terminal session is not connected: /browser opens it again'}>
          <span className={`lean-live-dot${live ? '' : ' is-off'}`} />
          {live ? 'live' : 'not connected'}
        </span>
      </header>
      <div className="shell-body">
        <aside className="shell-left" style={{ width }}>
          <ChatPanel />
        </aside>
        <Resizer
          side="left"
          width={width}
          min={CHAT.min}
          max={CHAT.max}
          defaultWidth={CHAT.def}
          onResize={setWidth}
          onEnd={(w) => {
            try {
              localStorage.setItem(WIDTH_KEY, String(Math.round(w)))
            } catch {
              /* kept for this page only */
            }
          }}
        />
        <div className="shell-main">
          <main className="shell-center">
            <div className="shell-panes">
              <section className="shell-panel" role="tabpanel" data-surface={surface} style={{ left: 0, top: 0, right: 0, bottom: 0 }}>
                <div className="shell-panel-body">
                  {surface === 'files' && <FilesPane />}
                  {surface === 'canvas' && (card ? <CardDetail /> : <CanvasPane />)}
                  {surface === 'report' && <ReportPane />}
                </div>
              </section>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p
}

/** Whether a key goes into a text field: there the keys type, and only Escape leaves the field. */
function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const field = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable
  if (field && e.key === 'Escape') {
    el.blur()
    return true
  }
  return field
}

function useKeys() {
  const rows = useStore((s) => s.rows)
  const marks = useMemo(() => allMarks(rows), [rows])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return
      const s = getState()
      const k = e.key
      if (s.card && !s.tray.length && detailKey(k)) return e.preventDefault()
      if (k === ']' || k === '[') {
        e.preventDefault()
        stepMark(marks, k === ']' ? 1 : -1)
        return
      }
      if (k === '0' || k === 'Escape') {
        if (s.propsOpen || s.squeezeOpen) return e.preventDefault(), setState({ propsOpen: null, squeezeOpen: null })
        if (s.tray.length) return e.preventDefault(), setState({ tray: s.tray.slice(0, -1), trayAsk: false, focus: s.tray.length > 1 ? s.focus : null })
        if (s.card && s.detailBar) return e.preventDefault(), setState({ detailBar: null })
        if (s.card) return e.preventDefault(), setState({ card: null, thread: 'main' })
        if (k === 'Escape' && s.selected) return setState({ selected: null })
        return
      }
      if (/^[1-9]$/.test(k) && s.propsOpen) {
        const p = s.rows.find((r) => r.row === s.propsOpen)?.record?.verbs?.v?.proposals?.[Number(k) - 1]
        if (p) return e.preventDefault(), void pressVerb(s.propsOpen, 'v', p)
      }
      if (k === '1') {
        if (s.tray.length && !s.trayAsk) return e.preventDefault(), setState({ trayAsk: true })
        if (!s.tray.length && s.selected && s.surface === 'canvas' && !s.card) return e.preventDefault(), setState({ card: { id: s.selected, v: null, region: null } })
        return
      }
      if (s.tray.length || s.card) return
      const verb = rowVerbs(s.verbs).find((v) => v.key === k)
      if (verb) {
        const row = s.focus?.row || [...s.rows].reverse().find((r) => r.kind === 'assistant' && r.record)?.row
        if (row) {
          e.preventDefault()
          void pressVerb(row, verb.key)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [marks])
}
