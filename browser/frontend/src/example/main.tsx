// The tour's example panes (example.html): thimble's own Files pane and Labels sidebar over the tour's example folder
// (./server.ts), in a frame that the tour lays over the page's own panes in its Files and Labels steps
// (src/tour/steps.ts). Everything in them works as in a workspace, on the example's files and label; their requests
// stay in the frame (./shield.ts, first).
//
// The tour places the panes where the page's own stand (ExamplePanes.place), each frame of its layout, and opens the
// sidebar when the page's own Labels sidebar is open, so the page around keeps its layout. The frame's window holds the
// panes' controls under PANES_KEY; what the person does in the panes is told back through `listen`.
import './shield'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import '../styles/index.css'
import '../tour/tour.css'
import './example.css'
import { HoverTips } from '../components/Tooltip'
import { writeColor } from '../files/colorChoice'
import { FilesTab } from '../files/FilesTab'
import { LabelEditorHost } from '../files/LabelEditor'
import { bus } from '../lib/bus'
import { setAccent, setPaper, type Accent, type Paper } from '../lib/theme'
import { storageKey, writeStorage } from '../lib/workspace'
import { LabelsSidebar } from '../shell/LabelsSidebar'
import { Toasts } from '../shell/Toasts'
import { PANES_KEY, type Box, type ExamplePanes, type PanesListeners } from './panes'
import { EXAMPLE } from './server'
import { server } from './shield'

/** The file the Files pane shows first, in its Transcript mode, with the folder's README in the tab beside it. */
const FIRST = 'agents/agent-1.jsonl'
const README = 'README.md'

/** The Files pane as the Files step shows it: the first file in front, plain (its Color by Off), every other file on
 * its default, as a workspace keeps them. */
function seedPane(): void {
  for (let i = window.localStorage.length - 1; i >= 0; i--) {
    const k = window.localStorage.key(i)
    if (k?.startsWith(storageKey(EXAMPLE, ''))) window.localStorage.removeItem(k)
  }
  writeStorage(storageKey(EXAMPLE, 'filesTabs'), { tabs: [README, FIRST], current: FIRST })
  writeColor(EXAMPLE, FIRST, { by: 'off', picks: [], off: {} })
}

let listeners: PanesListeners = {}
/** Whether the person changed the panes since they were drawn: a reset then draws them anew. */
let touched = false

const place = (el: HTMLElement | null, box: Box | null) => {
  if (!el) return
  el.hidden = !box
  if (box) Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` })
}

function Panes({ files, side, sideOpen, round }: { files: RefObject<HTMLElement | null>; side: RefObject<HTMLDivElement | null>; sideOpen: boolean; round: number }) {
  return (
    <>
      <section ref={files} className="shell-panel example-files" role="tabpanel" aria-label="Files" hidden>
        <div className="shell-panel-body">
          <FilesTab key={round} ws={EXAMPLE} active focused />
        </div>
        <span className="tour-tag example-tag">Example</span>
      </section>
      <div ref={side} className="example-side" hidden>
        {sideOpen && <LabelsSidebar key={round} ws={EXAMPLE} section="labels" onClose={() => listeners.side?.(false)} />}
        <span className="tour-tag example-tag">Example</span>
      </div>
      <LabelEditorHost ws={EXAMPLE} />
      <Toasts />
      <HoverTips />
    </>
  )
}

function App() {
  const files = useRef<HTMLElement | null>(null)
  const side = useRef<HTMLDivElement | null>(null)
  const [sideOpen, setSideOpen] = useState(false)
  const [round, setRound] = useState(0)
  const open = useRef(false)
  useEffect(() => {
    const at = (sel: string) => document.querySelector<HTMLElement>(sel)
    const putLabel = (shown: boolean) =>
      void server.answer(`/api/ws/${encodeURIComponent(EXAMPLE)}/concepts/${server.labelId}`, { method: 'PUT', body: JSON.stringify({ shown }) })
    const panes: ExamplePanes = {
      place(f, s) {
        place(files.current, f)
        place(side.current, s)
        if (!!s !== open.current) {
          open.current = !!s
          flushSync(() => setSideOpen(!!s))
        }
      },
      ready: () => !!at('.example-files .reader-body .reader-card'),
      reset() {
        server.reset()
        // the panes as they are drawn first need no new drawing: the first file in front, its Color by Off
        const shown = at('.example-files .reader-tabs .reader-tab.active .reader-tab-name')?.textContent === FIRST.split('/').pop()
        const plain = at('.example-files .reader-colorbar .colorby-trigger:not(.filterby-trigger) b')?.textContent === 'Off'
        if (touched || !shown || !plain) {
          touched = false
          seedPane()
          flushSync(() => setRound((n) => n + 1))
          return
        }
        bus.emit('concepts', { concept: server.labelId, what: 'changed', rows: true })
        bus.emit('filter', { scope: 'files' })
      },
      color: () => putLabel(true),
      plain: () => putLabel(false),
      part: (name) =>
        name === 'color-by' ? at('.example-files .reader-colorbar .colorby-trigger:not(.filterby-trigger)') : at('.colorby-menu[aria-label="Color by"] [data-by^="l:"]'),
      async close() {
        // each Escape closes the sheet on top (components/Menu Popover), once the one before it is gone
        for (let i = 0; i < 4 && document.querySelector('.popover'); i++) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await new Promise((r) => window.setTimeout(r, 60))
        }
      },
      listen(fns) {
        listeners = fns
      },
    }
    ;(window as unknown as Record<string, ExamplePanes>)[PANES_KEY] = panes
    // a press, a key or the wheel of the person's own: a demo playing stops, and a reset draws the panes anew
    const input = (e: Event) => {
      if (!e.isTrusted) return
      touched = true
      listeners.input?.()
    }
    const types = ['pointerdown', 'keydown', 'wheel'] as const
    for (const t of types) window.addEventListener(t, input, { capture: true, passive: true })
    // Escape that nothing in the panes took (a menu, the sidebar, a field with words in it) closes the tour
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !e.isTrusted) return
      const t = e.target as HTMLElement | null
      if (t?.isContentEditable || ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value)) return
      window.setTimeout(() => !e.defaultPrevented && listeners.escape?.(), 0)
    }
    window.addEventListener('keydown', escape)
    // a label's name in Files asks for its sidebar, as in a workspace
    const off = bus.on('openLabels', () => listeners.side?.(true))
    // the page's paper and accent, as they change
    let follow: MutationObserver | null = null
    try {
      const root = window.parent !== window ? window.parent.document.documentElement : null
      const sync = () => {
        const paper = root?.getAttribute('data-paper')
        const accent = root?.getAttribute('data-accent')
        if (paper && paper !== document.documentElement.getAttribute('data-paper')) setPaper(paper as Paper)
        if (accent && accent !== document.documentElement.getAttribute('data-accent')) setAccent(accent as Accent)
      }
      if (root) {
        sync()
        follow = new MutationObserver(sync)
        follow.observe(root, { attributes: true, attributeFilter: ['data-paper', 'data-accent'] })
      }
    } catch {
      /* opened alone: the default theme */
    }
    return () => {
      for (const t of types) window.removeEventListener(t, input, { capture: true })
      window.removeEventListener('keydown', escape)
      off()
      follow?.disconnect()
    }
  }, [])
  return <Panes files={files} side={side} sideOpen={sideOpen} round={round} />
}

seedPane()
createRoot(document.getElementById('root')!).render(<App />)
