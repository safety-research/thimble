// A plan card's body (backend notebook.py, plan cards): its numbered steps, each with its status at the right, what it
// makes as chips (dashed until the step runs), its note, and a live row per run under a step, as Claude Code's agent
// tray shows a subagent: its name, its state and time, and its latest event. A done step is one line, its text cut
// short before its status, which a click opens. A step with details shows its line first, as a comment shows its
// statement, with Show more under it that opens the details, their citations as chips, and Show less that folds them.
// What the plan's last edit changed (backend plans.edit_marks) stays marked until the next edit that changes the plan
// or the analyst clears it: a changed step says Changed and its Show more opens its text as it was, a new step says
// New, and the steps the edit removed are listed folded under the steps. A plan has no takeaway. Each step's row
// carries its ref as its anchor, so a comment can sit beside it.
import { useContext, useEffect, useState } from 'react'
import { ChatMarkdown, ChipContext } from '../chat/markdown'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { Cell, PlanRun, PlanStep } from '../lib/types'
import { CanvasContext } from './context'
import { hasMore, hasWas, isCompact, isMade, opens as opensOnClick, planEdit, planSteps, showsMore, statusWords, stepRef, type RemovedStep, type StepMark } from './plan'

const NO_REFS: ReadonlySet<string> = new Set()

/** how often a running step's live rows are read again, ms */
const RUNS_POLL_MS = 5000
/** how often a running step's own time moves on, ms */
const CLOCK_MS = 15000

export function PlanBody({ cell }: { cell: Cell }) {
  const { ws } = useContext(CanvasContext)
  const steps = planSteps(cell)
  const edit = planEdit(cell)
  const running = steps.some((s) => s.status === 'running')
  const now = useClock(running)
  const runs = usePlanRuns(ws, cell.id, steps)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) =>
    setOpened((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div className="plan" data-body="" data-settled="true" data-anchor={`card:${cell.id}`}>
      <ol className="plan-steps">
        {steps.map((s, i) => (
          <StepRow key={s.id} ws={ws} cellId={cell.id} n={i + 1} step={s} mark={edit?.steps.get(s.id)} now={now} runs={runs.filter((r) => r.step === i + 1)} compact={isCompact(s, opened)} open={opened.has(s.id)} onToggle={() => toggle(s.id)} />
        ))}
      </ol>
      {edit && <EditFoot ws={ws} cellId={cell.id} removed={edit.removed} />}
    </div>
  )
}

function StepRow({ ws, cellId, n, step, mark, now, runs, compact, open, onToggle }: { ws: string; cellId: string; n: number; step: PlanStep; mark?: StepMark; now: number; runs: PlanRun[]; compact: boolean; open: boolean; onToggle: () => void }) {
  const ref = stepRef(cellId, n)
  const opens = opensOnClick(step, mark)
  const more = showsMore(step, mark)
  // a done step opens to all it holds; any other step shows what it makes, its note and runs, and its Show more opens
  // its details and how it was before the last edit
  const shut = step.status === 'done' ? compact : !open
  const made = isMade(step)
  const was = hasWas(mark) ? mark!.was : null
  // a run the server has not answered for yet shows by its name alone
  const rows = step.runs.map((name) => runs.find((r) => r.name === name) ?? { step: n, name, chat: null, state: '', latest: '', elapsed: '' })
  const tag = mark && (
    <span className={`plan-mark is-${mark.kind}`} title={mark.kind === 'new' ? 'Added by the last edit' : 'Changed by the last edit'}>
      {mark.kind === 'new' ? 'New' : 'Changed'}
    </span>
  )
  return (
    <li className={`plan-step is-${step.status.replace(' ', '-')}${compact ? ' is-compact' : ''}`} data-step={step.id} data-n={n} data-anchor={ref} data-anchor-text={step.text} data-mark={mark?.kind}>
      <span className="plan-n">{n}</span>
      {opens ? (
        <button type="button" className="plan-text plan-toggle" aria-expanded={!shut} title={compact ? step.text : undefined} onMouseDown={(e) => e.stopPropagation()} onClick={onToggle}>
          <span className="plan-line">{step.text}</span>
          {tag}
          <Icon name={shut ? 'chevron-right' : 'chevron-down'} size={11} className="plan-caret" />
        </button>
      ) : (
        <span className="plan-text" title={compact ? step.text : undefined}>
          <span className="plan-line">{step.text}</span>
          {tag}
        </span>
      )}
      <span className={`plan-status is-${step.status.replace(' ', '-')}`}>{statusWords(step, now)}</span>
      {!compact && (hasMore(step) || more || (!shut && (!!step.details || !!was))) && (
        <div className="plan-under">
          {step.makes.length > 0 && (
            <div className="plan-makes">
              {step.makes.map((m) => (
                <span key={m} className={`plan-make${made ? '' : ' is-will'}`}>
                  {m}
                </span>
              ))}
            </div>
          )}
          {step.note &&
            step.note
              .split('\n')
              .filter((l) => l.trim())
              .map((l, i) => (
                <div key={i} className="plan-note">
                  {l.trim()}
                </div>
              ))}
          {!shut && step.details && (
            <ChipContext.Provider value={{ workspace: ws, broken: NO_REFS }}>
              <div className="plan-details chat-text" onMouseDown={(e) => e.stopPropagation()}>
                <ChatMarkdown text={step.details} />
              </div>
            </ChipContext.Provider>
          )}
          {!shut && was && (
            <div className="plan-was" onMouseDown={(e) => e.stopPropagation()}>
              <span className="plan-was-label">Before</span>
              {was.text != null && <span className="plan-was-text">{was.text}</span>}
              {!!was.makes?.length && (
                <span className="plan-makes">
                  {was.makes.map((m) => (
                    <span key={m} className="plan-make is-will">
                      {m}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
          {more && (
            <button type="button" className="plan-more" aria-expanded={open} onMouseDown={(e) => e.stopPropagation()} onClick={onToggle}>
              {open ? 'Show less' : 'Show more'}
            </button>
          )}
          {rows.map((r) => (
            <RunRow key={r.name} run={r} />
          ))}
        </div>
      )}
    </li>
  )
}

/** Under the steps while the last edit is marked: the steps it removed, folded behind Show more as their count, and
 * Clear marks, which takes every mark off (POST /cards/{id}/plan-edit/clear). */
function EditFoot({ ws, cellId, removed }: { ws: string; cellId: string; removed: RemovedStep[] }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const clear = () => {
    setBusy(true)
    api
      .clearPlanEdit(ws, cellId)
      .catch((e: Error) => bus.emit('toast', { text: `Could not clear the marks. ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(false))
  }
  return (
    <div className="plan-edit" onMouseDown={(e) => e.stopPropagation()}>
      <div className="plan-edit-row">
        {removed.length > 0 && <span className="plan-edit-removed">{removed.length === 1 ? '1 step removed' : `${removed.length} steps removed`}</span>}
        <button type="button" className="plan-more plan-edit-clear" disabled={busy} onClick={clear}>
          Clear marks
        </button>
      </div>
      {open && (
        <ul className="plan-removed">
          {removed.map((r) => (
            <li key={r.id || r.text} className="plan-removed-step">
              {r.text}
            </li>
          ))}
        </ul>
      )}
      {removed.length > 0 && (
        <button type="button" className="plan-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/** One run of a step: a dot in its state's colour, its name, its state and time, and under it its latest event. A
 * click opens its chat. */
function RunRow({ run }: { run: PlanRun }) {
  const state = run.state || 'not started'
  const meta = [run.state, run.elapsed].filter(Boolean).join(' · ')
  const open = run.chat ? () => bus.emit('openChat', { chatId: run.chat! }) : undefined
  return (
    <div className={`plan-run is-${state.replace(' ', '-')}`} data-run={run.name}>
      <div className="plan-run-row">
        {open ? (
          <button type="button" className="plan-run-name" onMouseDown={(e) => e.stopPropagation()} onClick={open}>
            <i className="plan-dot" />
            {run.name}
          </button>
        ) : (
          <span className="plan-run-name">
            <i className="plan-dot" />
            {run.name}
          </span>
        )}
        {meta && <span className="plan-run-meta">{meta}</span>}
      </div>
      {run.latest && <div className="plan-run-latest">⎿ {run.latest}</div>}
    </div>
  )
}

/** Now, moving on every CLOCK_MS while `on`, so a running step's time counts up. */
function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => window.clearInterval(t)
  }, [on])
  return now
}

/** The live rows of the plan's runs (backend plans.plan_runs): read once a step names runs, then every RUNS_POLL_MS and
 * on each change to a chat while a step that names runs is running. */
function usePlanRuns(ws: string, cellId: string, steps: PlanStep[]): PlanRun[] {
  const [runs, setRuns] = useState<PlanRun[]>([])
  const names = steps.map((s) => s.runs.join('\u0001')).join('\u0000')
  const live = steps.some((s) => s.status === 'running' && s.runs.length > 0)
  const statuses = steps.map((s) => s.status).join('|')
  useEffect(() => {
    if (!ws || !names.replace(/\u0000/g, '')) {
      setRuns([])
      return
    }
    let alive = true
    let timer: number | null = null
    const read = () =>
      api
        .planRuns(ws, cellId)
        .then((r) => alive && setRuns(r.runs))
        .catch(() => undefined)
    void read()
    if (!live) return () => void (alive = false)
    const poll = window.setInterval(() => void read(), RUNS_POLL_MS)
    const off = bus.on('chat', () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void read(), 400)
    })
    return () => {
      alive = false
      window.clearInterval(poll)
      if (timer != null) window.clearTimeout(timer)
      off()
    }
  }, [ws, cellId, names, live, statuses])
  return runs
}
