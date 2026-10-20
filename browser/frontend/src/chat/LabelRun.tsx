// A label run in the chat that started it (backend labels/asks.py), one row that changes with the run. Before a model
// reads many records it is what the run reads in one line, "Read 14,591 records of revisions.jsonl with Claude.", the
// analyst's three choices (Run all, Run on a sample, Cancel), and under them one dim line with the run's exact number of
// model calls, "292 model calls" (time and cost are rough, so the ask leaves them out). While the run goes
// it says how far it is ("2,340 done · 1 min 20 s"), read again on each `concepts` event of its label, with Stop.
// Once it ended, the counts it found, or the failure in one line with its fix. The label's chip opens it. The label
// editor's Run asks with the same line and choices (LabelAsk, AskChoices).
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { LabelAskShown, LabelRunLive } from '../lib/types'
import type { LabelRunRow as LabelRunRowT } from './model'
import { LabelChip, openLabel } from './SurfaceChips'

const LIVE_MS = 1000 // the row reads the run's state at most this often

/** How far a run is, after its row's line ("Reading 14,591 records with Claude"): "2,340 done · 1 min 20 s"; '' before
 * the run's total is known. Pure. */
export function runProgress(live: Pick<LabelRunLive, 'done' | 'total' | 'seconds'> | null): string {
  if (!live || !live.total) return ''
  const s = Math.round(live.seconds ?? 0)
  const took = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`
  return `${(live.done ?? 0).toLocaleString()} done · ${took}`
}

/** The run's live state while its row shows it running: read now, then again on its label's `concepts` events. */
function useLive(ws: string, item: LabelRunRowT): LabelRunLive | null {
  const [live, setLive] = useState<LabelRunLive | null>(null)
  const last = useRef(0)
  const running = item.state === 'running'
  useEffect(() => {
    if (!running) return
    let alive = true
    let timer: number | null = null
    const read = () => {
      last.current = Date.now()
      api
        .labelRun(ws, item.id)
        .then((l) => alive && setLive(l))
        .catch(() => undefined)
    }
    read()
    const tick = window.setInterval(read, 5000) // the elapsed time moves on between events too
    const off = bus.on('concepts', (e) => {
      if (e.concept && e.concept !== item.concept) return
      if (timer != null) return
      timer = window.setTimeout(() => {
        timer = null
        read()
      }, Math.max(0, LIVE_MS - (Date.now() - last.current)))
    })
    return () => {
      alive = false
      off()
      window.clearInterval(tick)
      if (timer != null) window.clearTimeout(timer)
    }
  }, [ws, item.id, item.concept, running])
  return running ? live : null
}

/** An ask's choices, shared by the chat's row and the label editor: Run all, Run on a sample (when the sample is fewer
 * than all), Cancel. Each goes to POST /label-runs/{id}; `onAnswered` hears the choice once the server took it. */
export function AskChoices({ ws, id, name, units, sample, onAnswered }: { ws: string; id: string; name: string; units?: number; sample?: number; onAnswered?: (choice: AskChoice) => void }) {
  const [busy, setBusy] = useState<AskChoice | null>(null)
  const choose = (choice: AskChoice) => {
    if (busy) return
    setBusy(choice)
    api
      .answerLabelRun(ws, id, choice)
      .then(() => onAnswered?.(choice))
      .catch((e: Error) => bus.emit('toast', { text: `The label ${name} did not start: ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' }))
      .finally(() => setBusy(null))
  }
  return (
    <span className="chat-labelrun-acts">
      <Button variant="primary" size="sm" busy={busy === 'all'} disabled={!!busy && busy !== 'all'} onClick={() => choose('all')}>
        Run all
      </Button>
      {(units ?? 0) > (sample ?? 0) && (
        <Button variant="secondary" size="sm" busy={busy === 'sample'} disabled={!!busy && busy !== 'sample'} onClick={() => choose('sample')}>
          {`Run on a sample of ${(sample ?? 0).toLocaleString()}`}
        </Button>
      )}
      <Button variant="ghost" size="sm" busy={busy === 'cancel'} disabled={!!busy && busy !== 'cancel'} onClick={() => choose('cancel')}>
        Cancel
      </Button>
    </span>
  )
}

export type AskChoice = 'all' | 'sample' | 'cancel'

/** The label editor's ask (backend POST /concepts/{id}/apply answering `asked`): the run's size in one line and the
 * same choices as the chat's row. */
export function LabelAsk({ ws, ask, onAnswered }: { ws: string; ask: LabelAskShown; onAnswered: (choice: AskChoice) => void }) {
  return (
    <div className="chat-labelrun label-ask" data-state="asked" data-run={ask.id} role="group" aria-label={`run ${ask.name}?`}>
      <span className="chat-labelrun-glyph">
        <Icon name="label" size={13} />
      </span>
      <div className="chat-labelrun-body">
        <span className="chat-labelrun-text">{ask.text}</span>
        <AskChoices ws={ws} id={ask.id} name={ask.name} units={ask.units} sample={ask.sample} onAnswered={onAnswered} />
        {ask.meta && <span className="chat-labelrun-meta">{ask.meta}</span>}
      </div>
    </div>
  )
}

export function LabelRunRow({ item, ws }: { item: LabelRunRowT; ws: string }) {
  const [busy, setBusy] = useState<string | null>(null)
  const live = useLive(ws, item)
  const stop = () => {
    if (busy) return
    setBusy('stop')
    api
      .stopLabelRun(ws, item.concept)
      .catch((e: Error) => bus.emit('toast', { text: `Could not stop ${item.name}: ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(null))
  }
  const state = item.state
  const failed = state === 'failed'
  const glyph =
    state === 'running' || state === 'answering' ? (
      <Spinner size={10} label="running" />
    ) : failed ? (
      <Icon name="warning" size={13} className="chat-labelrun-warn" />
    ) : state === 'asked' ? (
      <Icon name="label" size={13} />
    ) : (
      <span className="chat-call-dot" />
    )
  const progress = state === 'running' ? runProgress(live) : ''
  return (
    <div className="chat-msg chat-labelrun" data-state={state} data-run={item.id} role={state === 'asked' ? 'group' : undefined} aria-label={`label ${item.name}`}>
      <span className="chat-labelrun-glyph">{glyph}</span>
      <div className="chat-labelrun-body">
        <span className="chat-labelrun-text">
          {item.text}
          {progress && <span className="chat-labelrun-progress">{` · ${progress}`}</span>}{' '}
          <LabelChip name={item.name} onClick={(e) => (e.stopPropagation(), openLabel(ws, item.name))} />
        </span>
        {state === 'asked' && <AskChoices ws={ws} id={item.id} name={item.name} units={item.units} sample={item.sample} />}
        {state === 'asked' && item.meta && <span className="chat-labelrun-meta">{item.meta}</span>}
        {state === 'running' && (
          <span className="chat-labelrun-acts">
            <Button variant="ghost" size="sm" busy={busy === 'stop'} onClick={stop}>
              Stop
            </Button>
          </span>
        )}
      </div>
    </div>
  )
}
