// A card's details in a panel at the right of the board: the question, its provenance (thread, run, files read), the
// code for a card that runs code (editable; Run or ⌘↵ saves and runs it again), the output and what it printed, the
// takeaway (editable with RefEditor), and the card's history. What the analyst types is saved when the field is left.
// LabelPanel is the same panel for a label with no card of its own.
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react'
import { ChatMarkdown } from '../chat/markdown'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { CodeArea } from '../components/Code'
import { TextArea } from '../components/Field'
import { Kbd } from '../components/Marks'
import { Icon } from '../components/Icon'
import { chartLabels, Output } from '../components/Outputs'
import { GlyphCites } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { cellLabel, displayName, onCellNames } from '../lib/cellName'
import { teleport } from '../lib/teleport'
import { track } from '../lib/telemetry'
import type { Cell } from '../lib/types'
import { shortcutLabel } from '../lib/platform'
import { useConceptDetail } from './concepts'
import { CanvasContext } from './context'
import { detailBlocks, formatDuration, groupInputs, truncatedSize, type DetailBlock } from './details'
import { LabelDetails } from './LabelDetails'
import { hhmm, isRunnable, kindOf } from './layout'
import { RefEditor } from './RefEditor'

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })
const TAB = '    '
/** the room a chart has in the panel: its width less the body's padding */
const PANEL_ROOM = 420 - 2 * 16
/** the rows of a table the panel shows before its Show all */
const PANEL_ROWS = 40

export function DetailPanel({ cell, onClose }: { cell: Cell; onClose: () => void }) {
  const ctx = useContext(CanvasContext)
  const { ws } = ctx
  const kind = kindOf(cell)
  const runnable = isRunnable(cell)
  const payload = (cell.payload ?? {}) as Record<string, unknown>
  const concept = kind === 'label' ? String(payload.concept ?? '') : ''
  const label = useConceptDetail(ws, concept || null)
  const thread = ctx.threadOf(cell)
  const [question, setQuestion] = useState(cell.title)
  // the takeaway's editor is open, and where the click that opened it landed (for the caret)
  const [takeAt, setTakeAt] = useState<{ x: number; y: number } | null | false>(false)
  const [note, setNote] = useState(typeof payload.text === 'string' ? payload.text : '')
  const [code, setCode] = useState(cell.code ?? '')
  const [running, setRunning] = useState(false)
  const codeSeen = useRef(cell.code ?? '')
  // another card, or the card changed elsewhere: the fields follow unless they hold an edit of the analyst's
  useEffect(() => setQuestion(cell.title), [cell.id, cell.title])
  useEffect(() => setNote(typeof payload.text === 'string' ? payload.text : ''), [cell.id, payload.text])
  useEffect(() => {
    if ((cell.code ?? '') !== codeSeen.current || code === codeSeen.current) setCode(cell.code ?? '')
    codeSeen.current = cell.code ?? ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell.id, cell.code])
  const dirty = runnable && code !== (cell.code ?? '')
  const busy = running || cell.status === 'running'
  const blocks = useMemo(() => detailBlocks(cell.outputs), [cell.outputs])
  const name = useSyncExternalStore(onCellNames, () => cellLabel(cell.id) ?? displayName(cell))

  const saveField = async (field: 'title' | 'takeaway', value: string) => {
    const next = value.trim()
    if (next === (field === 'title' ? cell.title : cell.takeaway ?? '').trim() || (field === 'title' && !next)) return
    track(field === 'title' ? 'cell-edit' : 'takeaway-edit', { target: `cell:${cell.id}`, detail: { field, via: 'detail' } })
    try {
      await api.updateCell(ws, cell.id, field === 'title' ? { title: next } : { takeaway: next })
      ctx.refresh()
    } catch (e) {
      fail(e)
    }
  }
  const saveNote = async () => {
    if (note === (typeof payload.text === 'string' ? payload.text : '')) return
    track('cell-edit', { target: `cell:${cell.id}`, detail: { field: 'payload', via: 'detail' } })
    try {
      await api.updateCell(ws, cell.id, { payload: { ...payload, text: note } })
      ctx.refresh()
    } catch (e) {
      fail(e)
    }
  }
  const run = async () => {
    if (busy) return
    setRunning(true)
    track('cell-run', { target: `cell:${cell.id}`, detail: { via: 'detail', edited: dirty } })
    try {
      if (dirty) {
        await api.updateCell(ws, cell.id, { code })
        codeSeen.current = code
      }
      await api.runCell(ws, cell.id)
      ctx.refresh()
    } catch (e) {
      fail(e)
    } finally {
      setRunning(false)
    }
  }
  const onCodeKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void run()
    } else if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const t = e.currentTarget
      const at = t.selectionStart
      const next = code.slice(0, at) + TAB + code.slice(t.selectionEnd)
      setCode(next)
      requestAnimationFrame(() => (t.selectionStart = t.selectionEnd = at + TAB.length))
    }
  }
  const ran = runnable && cell.exec_count != null ? [hhmm(cell.ts), formatDuration(cell.duration_s), `run ${cell.exec_count}`].filter(Boolean).join(' · ') : ''
  // you for the analyst's own hand; else the thread or agent, as the card's foot names it (the terminal session is main)
  const byName = (by: string | null | undefined) => (!by || by === 'user' || by === 'analyst' ? 'you' : ctx.threadOf({ ...cell, created_by: by }).name || by)
  const history = [{ ts: cell.created_ts ?? cell.ts, what: `created by ${byName(cell.created_by)}` }, ...(cell.edited ?? []).map((e) => ({ ts: e.ts, what: `edited by ${byName(e.by)}` }))].filter((h) => h.ts)
  const editTake = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('a, button, .chip, .refchip')) return
    setTakeAt({ x: e.clientX, y: e.clientY })
  }
  return (
    <aside className="bdetail" role="complementary" aria-label="Detail" data-cite-home={cell.id} onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <header className="bdetail-head">
        <span className="bdetail-title">Detail</span>
        <span className="bdetail-id">{name}</span>
        <Button variant="icon" size="md" icon="x" title="Close" aria-label="Close" className="bdetail-close" onClick={onClose} />
      </header>
      <div className="bdetail-body">
        <TextArea bare block autoGrow rows={1} maxHeight={200} className="bdetail-q" value={question} onChange={setQuestion} onKeyDown={(e) => e.stopPropagation()} onBlur={() => void saveField('title', question)} aria-label="Question" />
        <dl className="bdetail-facts">
          <dt>Thread</dt>
          <dd>
            <button type="button" className="bdetail-thread" disabled={!thread.chatId} onClick={() => ctx.openThread(cell)}>
              {thread.name || '—'}
            </button>
          </dd>
          {ran && (
            <>
              <dt>Ran</dt>
              <dd className="bdetail-mono">{ran}</dd>
            </>
          )}
          {!!cell.reads?.length && (
            <>
              <dt>Inputs</dt>
              <dd>
                <Inputs reads={cell.reads} more={cell.reads_more ?? 0} />
              </dd>
            </>
          )}
        </dl>
        {runnable && (
          <section className="bdetail-sec">
            <div className="bdetail-sec-head">
              <span className="bdetail-label">Code</span>
              {dirty && !busy && <span className="bdetail-dirty">edited · not run</span>}
              <Button variant={dirty ? 'primary' : 'secondary'} size="sm" icon={busy ? undefined : 'run'} busy={busy} className="bdetail-run" onClick={() => void run()}>
                {busy ? 'Running' : 'Run'} {!busy && <Kbd>{shortcutLabel('↵')}</Kbd>}
              </Button>
            </div>
            <CodeBox value={code} onChange={setCode} onKeyDown={onCodeKey} />
          </section>
        )}
        {((runnable && busy) || blocks.length > 0) && (
          <section className="bdetail-sec">
            <span className="bdetail-label">Output</span>
            {busy ? (
              <div className="bdetail-wait">
                <Spinner size={10} label="running" />
              </div>
            ) : (
              blocks.map((b) => <Block key={b.index} block={b} cell={cell} />)
            )}
          </section>
        )}
        {kind === 'note' && (
          <section className="bdetail-sec">
            <span className="bdetail-label">Text</span>
            <TextArea bare block autoGrow rows={3} maxHeight={480} className="bdetail-note" value={note} onChange={setNote} onKeyDown={(e) => e.stopPropagation()} onBlur={() => void saveNote()} aria-label="Text" />
          </section>
        )}
        {kind === 'label' && label.concept && <LabelDetails concept={label.concept} reload={label.reload} set={label.set} />}
        {kind !== 'note' && (
          <section className="bdetail-sec">
            <span className="bdetail-label">Takeaway</span>
            <div className="bdetail-take">
              {takeAt !== false ? (
                <RefEditor
                  className="bdetail-take-text chat-text"
                  label="Takeaway"
                  value={cell.takeaway ?? ''}
                  at={takeAt}
                  onDone={(v) => {
                    setTakeAt(false)
                    void saveField('takeaway', v)
                  }}
                />
              ) : (
                <div
                  className="bdetail-take-text chat-text is-rest"
                  role="button"
                  tabIndex={0}
                  aria-label="Takeaway"
                  onClick={editTake}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    e.stopPropagation()
                    setTakeAt(null)
                  }}
                >
                  {cell.takeaway?.trim() ? (
                    <GlyphCites.Provider value={true}>
                      <ChatMarkdown text={cell.takeaway} />
                    </GlyphCites.Provider>
                  ) : (
                    <span className="bdetail-take-empty">Add a takeaway</span>
                  )}
                </div>
              )}
            </div>
          </section>
        )}
        {history.length > 0 && (
          <section className="bdetail-sec">
            <span className="bdetail-label">History</span>
            {history.map((h, i) => (
              <div key={i} className="bdetail-hist">
                <time className="bdetail-hist-t" dateTime={h.ts}>
                  {hhmm(h.ts)}
                </time>
                <span>{h.what}</span>
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  )
}

/** The code on the inset paper, highlighted as Python (CodeArea). A line wider than the panel scrolls sideways, with a
 * fade at the right edge while some of it is cut off. */
function CodeBox({ value, onChange, onKeyDown }: { value: string; onChange: (v: string) => void; onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void }) {
  const el = useRef<HTMLTextAreaElement>(null)
  const [more, setMore] = useState(false)
  const check = () => {
    const t = el.current
    if (t) setMore(t.scrollWidth - t.clientWidth - t.scrollLeft > 1)
  }
  useEffect(check, [value])
  useEffect(() => {
    const t = el.current
    if (!t || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(t)
    return () => ro.disconnect()
  }, [])
  return (
    <div className={`bdetail-code-box${more ? ' has-more' : ''}`}>
      <CodeArea lang="python" ref={el} mono block autoGrow rows={4} maxHeight={420} spellCheck={false} className="bdetail-code" value={value} onChange={onChange} onKeyDown={onKeyDown} onScroll={check} aria-label="Code" />
    </div>
  )
}

function Block({ block, cell }: { block: DetailBlock; cell: Cell }) {
  const { concepts } = useContext(CanvasContext)
  switch (block.kind) {
    case 'shell':
      return <ShellBlock block={block} cell={cell} />
    case 'error':
      return (
        <pre className="bdetail-shell bdetail-error">
          <span className="bdetail-error-head">
            {block.ename}
            {block.evalue ? `: ${block.evalue}` : ''}
          </span>
          {block.traceback ? '\n' + block.traceback : ''}
        </pre>
      )
    case 'text':
      return <pre className="bdetail-shell">{block.text}</pre>
    case 'artifact':
      // the artifact itself, as the card draws it: the table (its first rows, then Show all), the chart at the panel's width
      return (
        <div className={`bdetail-artifact bdetail-artifact-${block.label}`}>
          <Output bundle={block.bundle} maxRows={PANEL_ROWS} fitWidth={PANEL_ROOM} labels={chartLabels(cell.labels, concepts)} />
        </div>
      )
  }
}

/**
 * The files the run read, summarised: each folder and pattern with its count (details.groupInputs), which opens to its
 * paths, each of which opens the file; a file read on its own is its path. Past the listed reads, how many more it read.
 */
function Inputs({ reads, more }: { reads: string[]; more: number }) {
  const groups = useMemo(() => groupInputs(reads), [reads])
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (pattern: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(pattern)) next.delete(pattern)
      else next.add(pattern)
      return next
    })
  const file = (path: string) => (
    <button key={path} type="button" className="bdetail-input-path" title={path} onClick={() => teleport(path)}>
      {path}
    </button>
  )
  return (
    <div className="bdetail-inputs">
      {groups.map((g) =>
        g.paths.length === 1 && g.pattern === g.paths[0] ? (
          <div key={g.pattern} className="bdetail-input">
            {file(g.pattern)}
          </div>
        ) : (
          <div key={g.pattern} className={`bdetail-input${open.has(g.pattern) ? ' is-open' : ''}`}>
            <button type="button" className="bdetail-input-group" aria-expanded={open.has(g.pattern)} onClick={() => toggle(g.pattern)}>
              <Icon name="chevron-right" size={10} className="bdetail-input-chev" />
              <span className="bdetail-input-count">{g.paths.length.toLocaleString()} files</span>
              <span className="bdetail-input-pattern">{g.pattern}</span>
            </button>
            {open.has(g.pattern) && <div className="bdetail-input-paths">{g.paths.map(file)}</div>}
          </div>
        ),
      )}
      {more > 0 && <div className="bdetail-input-more">{more.toLocaleString()} more</div>}
    </div>
  )
}

/** A stream as a shell block; a truncated one carries a chip with its size that loads the complete text in place. */
function ShellBlock({ block, cell }: { block: Extract<DetailBlock, { kind: 'shell' }>; cell: Cell }) {
  const { ws } = useContext(CanvasContext)
  const [full, setFull] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // a new run's text drops the complete text loaded for the old one
  useEffect(() => setFull(null), [block.text])
  const load = async () => {
    if (loading) return
    setLoading(true)
    try {
      setFull(await api.outputFull(ws, cell.notebook, cell.id, block.index))
    } catch (e) {
      fail(e)
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="bdetail-block">
      <pre className={block.stream === 'stderr' ? 'bdetail-shell bdetail-stderr' : 'bdetail-shell'}>{full ?? block.text}</pre>
      {block.truncated && full == null && (
        <Chip kind="value" icon="expand" disabled={loading} onClick={() => void load()}>
          {loading ? <Spinner size={10} label="loading" /> : null}
          {truncatedSize(block.truncated)}
        </Chip>
      )}
    </div>
  )
}

/** A label's review in the same panel, for a label with no card on the canvas: its name, then its details as a label
 * card's panel shows them (LabelDetails). */
export function LabelPanel({ conceptId, onClose }: { conceptId: string; onClose: () => void }) {
  const ctx = useContext(CanvasContext)
  const label = useConceptDetail(ctx.ws, conceptId)
  const name = label.concept?.name || ctx.concepts.get(conceptId)?.name || 'label'
  return (
    <aside className="bdetail" role="complementary" aria-label="Label" onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <header className="bdetail-head">
        <span className="bdetail-title">Label</span>
        <span className="bdetail-id">{name}</span>
        <Button variant="icon" size="md" icon="x" title="Close" aria-label="Close" className="bdetail-close" onClick={onClose} />
      </header>
      <div className="bdetail-body">
        {label.concept ? (
          <LabelDetails concept={label.concept} reload={label.reload} set={label.set} />
        ) : (
          <div className="bdetail-wait">{label.error ? label.error : <Spinner size={10} label="loading" />}</div>
        )}
      </div>
    </aside>
  )
}
