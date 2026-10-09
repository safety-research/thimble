// A card's details in a panel at the right of the board: the question, its provenance (thread, run, files read), the
// code for a card that runs code (editable; Run or ⌘↵ saves and runs it again), the output and what it printed, the
// takeaway (editable with RefEditor), the card check (CheckDetails, with the Undo of its fix), and the card's history.
// What the analyst types is saved when the field is left. The card's History (its button on the card, or a row of the
// history here) lists its edits, newest first; each opens the card as it was before that edit, to read (VersionView:
// its question, steps or text, code, output and takeaway as stored then), with Restore, which makes the card that
// version again as an edit of the analyst's (backend notebook.restore_version). Matt 2026-10-09: "we should not keep
// 'Before' with a strikethrough. maybe cards have a history button?"
// LabelPanel is the same panel for a label with no card of its own.
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { ChatMarkdown } from '../chat/markdown'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { CodeArea, CodeText } from '../components/Code'
import { TextArea } from '../components/Field'
import { Kbd } from '../components/Marks'
import { Icon } from '../components/Icon'
import { chartLabels, lineOmitted, Output, OutputText } from '../components/Outputs'
import { GlyphCites } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { cellLabel, displayName, onCellNames } from '../lib/cellName'
import { revealLines, scrollWithin } from '../lib/tableCell'
import { teleport } from '../lib/teleport'
import { track } from '../lib/telemetry'
import type { CardVersion, Cell } from '../lib/types'
import { shortcutLabel } from '../lib/platform'
import { CheckDetails } from './CheckDetails'
import { useConceptDetail } from './concepts'
import { CanvasContext } from './context'
import { detailBlocks, fieldWords, formatDuration, groupInputs, historyRows, truncatedSize, type DetailBlock, type HistoryRow } from './details'
import { LabelDetails } from './LabelDetails'
import { hhmm, isRunnable, kindOf } from './layout'
import { planSteps } from './plan'
import { PlanSteps } from './PlanBody'
import { RefEditor } from './RefEditor'

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })
const TAB = '    '
/** the room a chart has in the panel: its width less the body's padding */
const PANEL_ROOM = 420 - 2 * 16
/** the rows of a table the panel shows before its Show all */
const PANEL_ROWS = 40

/** Lines of one of the card's outputs (`card:<id>@out<i>#L<n>`) a click on a citation opened the panel at (Canvas): the
 * panel scrolls to them and marks them. `seq` tells one click from the next. */
export interface OutputCite {
  out: number
  line: number
  end?: number
  seq: number
}

/** What the panel shows: the card's details, its history, or the card as it was before one of its edits (and where Back
 * goes from there). */
type PanelView = { kind: 'card' } | { kind: 'history' } | { kind: 'version'; entry: string; back: 'card' | 'history' }

export function DetailPanel({ cell, cite = null, history = 0, onClose }: { cell: Cell; cite?: OutputCite | null; history?: number; onClose: () => void }) {
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
  // the card's History button opens the history (`history` counts its presses); a row of the history opens a version
  const [view, setView] = useState<PanelView>(history ? { kind: 'history' } : { kind: 'card' })
  useEffect(() => {
    if (history) setView({ kind: 'history' })
  }, [history])

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
  const byName = (by: string | null | undefined) => (!by || by === 'user' || by === 'analyst' ? 'you' : by === 'check' ? 'the card check' : ctx.threadOf({ ...cell, created_by: by }).name || by)
  const rows = historyRows(cell, byName)
  const open = (back: 'card' | 'history') => (entry: string) => {
    track('ui-click', { target: `cell:${cell.id}`, detail: { action: 'version', entry } })
    setView({ kind: 'version', entry, back })
  }
  const editTake = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('a, button, .chip, .refchip')) return
    setTakeAt({ x: e.clientX, y: e.clientY })
  }
  return (
    <aside className="bdetail" role="complementary" aria-label="Detail" data-cite-home={cell.id} onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <header className="bdetail-head">
        <span className="bdetail-title">{view.kind === 'card' ? 'Detail' : 'History'}</span>
        <span className="bdetail-id">{name}</span>
        <Button variant="icon" size="md" icon="x" title="Close" aria-label="Close" className="bdetail-close" onClick={onClose} />
      </header>
      {view.kind === 'history' && (
        <div className="bdetail-body" data-view="history">
          <div className="bdetail-q-read">{cell.title}</div>
          <section className="bdetail-sec">
            <HistoryList rows={rows} onOpen={open('history')} />
          </section>
        </div>
      )}
      {view.kind === 'version' && (
        <div className="bdetail-body" data-view="version">
          <VersionView key={view.entry} ws={ws} cell={cell} entry={view.entry} byName={byName} onBack={() => setView({ kind: view.back })} onRestored={() => setView({ kind: 'history' })} />
        </div>
      )}
      <div className="bdetail-body" hidden={view.kind !== 'card'}>
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
              blocks.map((b) => <Block key={b.index} block={b} cell={cell} cite={cite?.out === b.index ? cite : null} />)
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
        <CheckDetails cell={cell} />
        {rows.length > 0 && (
          <section className="bdetail-sec">
            <span className="bdetail-label">History</span>
            <HistoryList rows={rows} onOpen={open('card')} />
          </section>
        )}
      </div>
    </aside>
  )
}

/** A card's history, newest first (details.historyRows): each edit whose version was kept is a button that opens the
 * card as it was before it. */
function HistoryList({ rows, onOpen }: { rows: HistoryRow[]; onOpen: (entry: string) => void }) {
  return (
    <div className="bdetail-hists">
      {rows.map((h, i) => {
        const body = (
          <>
            <time className="bdetail-hist-t" dateTime={h.ts}>
              {hhmm(h.ts)}
            </time>
            <span className="bdetail-hist-what">{h.what}</span>
            {h.fields && <span className="bdetail-hist-fields">{h.fields}</span>}
          </>
        )
        return h.entry ? (
          <button key={i} type="button" className="bdetail-hist is-version" data-entry={h.entry} title="Open the card as it was before this edit" onClick={() => onOpen(h.entry!)}>
            {body}
            <Icon name="chevron-right" size={11} className="bdetail-hist-go" />
          </button>
        ) : (
          <div key={i} className="bdetail-hist">
            {body}
          </div>
        )
      })}
    </div>
  )
}

/** The card as it was before one of its edits (backend notebook.card_version_route), to read: its question, its steps
 * or text, its code, output and takeaway as stored then, a quiet Changed beside each part the edit replaced. Back
 * returns to where it was opened; Restore makes the card this version again, as an edit of the analyst's. */
function VersionView({ ws, cell, entry, byName, onBack, onRestored }: { ws: string; cell: Cell; entry: string; byName: (by: string | null | undefined) => string; onBack: () => void; onRestored: () => void }) {
  const ctx = useContext(CanvasContext)
  const [got, setGot] = useState<CardVersion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.cardVersion(ws, cell.id, entry).then(
      (v) => live && setGot(v),
      (e: Error) => live && setError(e.message),
    )
    return () => void (live = false)
  }, [ws, cell.id, entry])
  const restore = async () => {
    if (busy) return
    setBusy(true)
    track('ui-click', { target: `cell:${cell.id}`, detail: { action: 'restore', entry } })
    try {
      await api.restoreVersion(ws, cell.id, entry)
      ctx.refresh()
      onRestored()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const v = got?.version
  const changed = new Set(got?.fields ?? [])
  const who = got ? byName(got.by) : ''
  const kind = v ? kindOf(v as Cell) : ''
  const blocks = v ? detailBlocks(v.outputs) : []
  const tag = (field: string) =>
    changed.has(field) ? (
      <span className="plan-mark is-changed" title="This edit changed it">
        Changed
      </span>
    ) : null
  return (
    <>
      <div className="bdetail-version">
        <Button variant="ghost" size="sm" icon="arrow-left" className="bdetail-back" onClick={onBack}>
          Back
        </Button>
        <span className="bdetail-version-what">{got ? `Before ${who === 'you' ? 'your' : `${who}’s`} edit at ${hhmm(got.ts)}` : ''}</span>
        <Button variant="primary" size="sm" className="bdetail-restore" busy={busy} disabled={!got} onClick={() => void restore()}>
          Restore
        </Button>
      </div>
      {error ? (
        <div className="bdetail-wait">{error}</div>
      ) : !v ? (
        <div className="bdetail-wait">
          <Spinner size={10} label="loading" />
        </div>
      ) : (
        <>
          <section className="bdetail-sec">
            <span className="bdetail-label">Question{tag('title')}</span>
            <div className="bdetail-q-read">{v.title}</div>
          </section>
          {kind === 'plan' && (
            <section className="bdetail-sec">
              <span className="bdetail-label">Steps{tag('payload')}</span>
              <PlanSteps ws={ws} cellId={cell.id} steps={planSteps(v as Cell)} now={Date.now()} anchors={false} />
            </section>
          )}
          {kind === 'note' && (
            <section className="bdetail-sec">
              <span className="bdetail-label">Text{tag('payload')}</span>
              <div className="bdetail-take-text chat-text">
                <ChatMarkdown text={v.text ?? String((v.payload as { text?: unknown } | undefined)?.text ?? '')} />
              </div>
            </section>
          )}
          {kind !== 'plan' && kind !== 'note' && v.payload != null && (
            <section className="bdetail-sec">
              <span className="bdetail-label">{fieldWords(kind, ['payload']).replace(/^./, (c) => c.toUpperCase())}{tag('payload')}</span>
              <pre className="bdetail-shell">{JSON.stringify(v.payload, null, 2)}</pre>
            </section>
          )}
          {v.code != null && v.payload == null && (
            <section className="bdetail-sec">
              <span className="bdetail-label">Code{tag('code')}</span>
              <pre className="bdetail-code-read">
                <CodeText text={v.code} lang="python" />
              </pre>
            </section>
          )}
          {blocks.length > 0 && (
            <section className="bdetail-sec">
              <span className="bdetail-label">Output</span>
              {blocks.map((b) => (
                <ReadBlock key={b.index} block={b} cell={cell} />
              ))}
            </section>
          )}
          {kind !== 'plan' && kind !== 'note' && (
            <section className="bdetail-sec">
              <span className="bdetail-label">Takeaway{tag('takeaway')}</span>
              <div className="bdetail-take">
                <div className="bdetail-take-text chat-text">
                  {v.takeaway?.trim() ? (
                    <GlyphCites.Provider value={true}>
                      <ChatMarkdown text={v.takeaway} />
                    </GlyphCites.Provider>
                  ) : (
                    <span className="bdetail-take-empty">No takeaway</span>
                  )}
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </>
  )
}

/** One output of an earlier version, to read: as the panel draws the card's own, a stream's stored text with no
 * complete text to load (its side file went with the run that replaced it). */
function ReadBlock({ block, cell }: { block: DetailBlock; cell: Cell }) {
  const { concepts } = useContext(CanvasContext)
  if (block.kind === 'shell') {
    return (
      <div className="bdetail-block">
        <pre className={block.stream === 'stderr' ? 'bdetail-shell bdetail-stderr' : 'bdetail-shell'}>
          <OutputText text={block.text} truncated={block.truncated} />
        </pre>
      </div>
    )
  }
  return (
    <div className="bdetail-out">
      {block.kind === 'error' ? (
        <pre className="bdetail-shell bdetail-error">
          <span className="bdetail-error-head">
            {block.ename}
            {block.evalue ? `: ${block.evalue}` : ''}
          </span>
          {block.traceback ? '\n' + block.traceback : ''}
        </pre>
      ) : block.kind === 'text' ? (
        <pre className="bdetail-shell">{block.plain ? <OutputText text={block.text} /> : block.text}</pre>
      ) : (
        <div className={`bdetail-artifact bdetail-artifact-${block.label}`}>
          <Output bundle={block.bundle} maxRows={PANEL_ROWS} fitWidth={PANEL_ROOM} labels={chartLabels(cell.labels, concepts)} />
        </div>
      )}
    </div>
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

/** The cited lines of the output drawn in `box` brought into view in the panel and marked (lib/tableCell revealLines),
 * or the output flashed when it does not draw them; once per citation, and not while `wait` holds. */
function useCite(box: RefObject<HTMLElement | null>, cite: OutputCite | null, wait = false): void {
  const shown = useRef(-1)
  useEffect(() => {
    const el = box.current
    if (!cite || wait || !el || shown.current === cite.seq) return
    shown.current = cite.seq
    const stop = el.closest<HTMLElement>('.bdetail-body') ?? el
    if (revealLines(el, cite.line, cite.end, stop)) return
    scrollWithin(el, stop, false)
    el.classList.add('anchor-flash')
    window.setTimeout(() => el.classList.remove('anchor-flash'), 1600)
  })
}

function Block({ block, cell, cite }: { block: DetailBlock; cell: Cell; cite: OutputCite | null }) {
  const { concepts } = useContext(CanvasContext)
  const box = useRef<HTMLDivElement>(null)
  useCite(box, block.kind === 'shell' ? null : cite)
  if (block.kind === 'shell') return <ShellBlock block={block} cell={cell} cite={cite} />
  return (
    <div ref={box} className="bdetail-out" data-out={block.index}>
      {block.kind === 'error' ? (
        <pre className="bdetail-shell bdetail-error">
          <span className="bdetail-error-head">
            {block.ename}
            {block.evalue ? `: ${block.evalue}` : ''}
          </span>
          {block.traceback ? '\n' + block.traceback : ''}
        </pre>
      ) : block.kind === 'text' ? (
        <pre className="bdetail-shell">{block.plain ? <OutputText text={block.text} /> : block.text}</pre>
      ) : (
        // the artifact itself, as the card draws it: the table (its first rows, then Show all), the chart at the panel's width
        <div className={`bdetail-artifact bdetail-artifact-${block.label}`}>
          <Output bundle={block.bundle} maxRows={PANEL_ROWS} fitWidth={PANEL_ROOM} labels={chartLabels(cell.labels, concepts)} />
        </div>
      )}
    </div>
  )
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

/** A stream as a shell block; a truncated one carries a chip with its size that loads the complete text in place, and
 * loads it by itself when a citation names a line its stored text left out. */
function ShellBlock({ block, cell, cite }: { block: Extract<DetailBlock, { kind: 'shell' }>; cell: Cell; cite: OutputCite | null }) {
  const { ws } = useContext(CanvasContext)
  const box = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const omitted = !!cite && full == null && lineOmitted(block.truncated, cite.line)
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
  useEffect(() => {
    if (omitted) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [omitted, cite?.seq])
  useCite(box, cite, omitted)
  return (
    <div ref={box} className="bdetail-block" data-out={block.index}>
      <pre className={block.stream === 'stderr' ? 'bdetail-shell bdetail-stderr' : 'bdetail-shell'}>
        <OutputText text={full ?? block.text} truncated={full == null ? block.truncated : null} />
      </pre>
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
