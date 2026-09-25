// The page side of chat-rows.test.ts: bundled into the page, it mounts real components with react-dom; the test reads
// what the DOM shows and owns the assertions.
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Rows } from '../../../src/chat/Rows'
import { foldRecords } from '../../../src/chat/model'
import { ThreadsContext } from '../../../src/chat/Notes'
import { StartGate } from '../../../src/chat/StartGate'
import type { ChatRecord } from '../../../src/lib/types'

declare global {
  interface Window {
    __thimble: {
      mountRows: typeof mountRows
      mountStart: typeof mountStart
      unmountAll: typeof unmountAll
      skipped: number
    }
  }
}

const mounted: { el: HTMLDivElement; root: Root }[] = []

function mount(): { el: HTMLDivElement; root: Root } {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const m = { el, root: createRoot(el) }
  mounted.push(m)
  return m
}

function unmountAll(): void {
  for (const m of mounted.splice(0)) {
    m.root.unmount()
    m.el.remove()
  }
}

/** Fold `records` and render the rows for workspace `ws`, the threads named by `labels` (id → full name); returns the
 * host element's id. */
function mountRows(records: ChatRecord[], ws: string, streaming = false, labels: Record<string, string> = {}): string {
  const m = mount()
  m.el.id = `rows-${mounted.length}`
  flushSync(() =>
    m.root.render(
      <ThreadsContext.Provider value={{ labels: new Map(Object.entries(labels)) }}>
        <Rows rows={foldRecords(records)} ws={ws} streaming={streaming} />
      </ThreadsContext.Provider>,
    ),
  )
  return m.el.id
}

/** The start gate with Skip; `window.__thimble.skipped` counts the Skips. */
function mountStart(ws: string): string {
  const m = mount()
  m.el.id = `start-${mounted.length}`
  flushSync(() => m.root.render(<StartGate ws={ws} model="claude-opus-5" onSkip={() => (window.__thimble.skipped += 1)} />))
  return m.el.id
}

window.__thimble = { mountRows, mountStart, unmountAll, skipped: 0 }
