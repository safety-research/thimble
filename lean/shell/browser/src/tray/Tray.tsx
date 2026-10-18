// Tray.tsx: the bottom panel, the tray program (lean/panes/tray.js) the terminal draws above its prompt, drawn here from
// the same file. A cite or explain mark opens its card: a cite card shows what the value rests on (the query's output
// around the cited row, a series, a code hunk or the rows, read through the kernel); an explain card a few plain words,
// a small drawing when the observer wrote one, and where it mattered. A citation inside a card opens over it, 0 goes
// back; 1 asks, and the question starts the mark's side thread, which the chat then shows (main does not see it).
// Which cards are open is the program's state, shared with the terminal: a card opened on either surface opens on both.
import { useMemo } from 'react'
import { PaneView } from '../panes/PaneView'
import { allMarks, ask, markOfFrame, stepMark } from '../lib/actions'
import { setState, useStore, type TrayEntry } from '../lib/store'

export function Tray() {
  const tray = useStore((s) => s.tray)
  const asking = useStore((s) => s.trayAsk)
  const rows = useStore((s) => s.rows)
  const marks = useMemo(() => allMarks(rows), [rows])
  const state = useMemo(() => ({ stack: tray, asking }), [tray, asking])
  return (
    <section className={`lean-tray-host${tray.length ? ' is-open' : ''}`} aria-label="cite and explain">
      <PaneView
        name="tray"
        rows={14}
        focus={tray.length > 0}
        state={state}
        onState={(st) => {
          const stack = (Array.isArray(st.stack) ? st.stack : []) as TrayEntry[]
          setState({ tray: stack, trayAsk: !!st.asking, focus: markOfFrame(rows, stack[0]) })
        }}
        actions={{
          close: () => setState({ tray: [], trayAsk: false, focus: null }),
          step: (e) => stepMark(marks, Number(e.dir) < 0 ? -1 : 1),
          ask: (e) => {
            const scope = (e.scope || {}) as { row?: string; mark?: { kind?: string; ref?: string; gloss?: string; label?: string; term?: string } }
            const text = String(e.text || '')
            void ask(text, { ...(scope.row ? { row: scope.row } : {}), ...(scope.mark ? { mark: scope.mark as never } : {}) }).then((ok) => {
              if (ok) setState({ pendingThread: { row: scope.row || '', ref: scope.mark?.ref || scope.mark?.term || scope.mark?.label || '', at: Date.now() } })
            })
          },
        }}
        className="lean-tray-pane"
      />
    </section>
  )
}
