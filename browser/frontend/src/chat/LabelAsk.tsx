// The ask before a big prompt label's run (backend label_asks.py), as the terminal asks above its bar: a label that
// would read more than a sample of records with a model does not start until the person chooses. One card above the
// chat's composer, in the view proposal's shape (chat-offer), for each run that waits: "Label <name>", what the run
// reads ("Read 14,591 records of revisions.jsonl with Opus 5.5?"), Run all, Run on a sample of 300 and Cancel, and
// under them the estimate, dim ("about 292 model calls"). The Labels sidebar shows the same card in a label's detail.
// The asks are read again on each `concepts` event, since the server says `asked`, `answered` or `cancelled` there.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import type { LabelAsk, LabelAskChoice } from '../lib/types'

/** The asks that wait in the workspace, oldest first; of one label when `concept` names it. */
export function useLabelAsks(ws: string, concept?: string): LabelAsk[] {
  const [asks, setAsks] = useState<LabelAsk[]>([])
  useEffect(() => {
    let alive = true
    const read = () =>
      labelApi
        .asks(ws)
        .then((got) => alive && setAsks(Array.isArray(got) ? got : []))
        .catch(() => undefined)
    read()
    const off = bus.on('concepts', () => read())
    return () => {
      alive = false
      off()
    }
  }, [ws])
  return concept ? asks.filter((a) => a.concept === concept) : asks
}

/** The choices an ask offers, in order: Run on a sample only when the sample is fewer than all. Pure. */
export function askChoices(a: Pick<LabelAsk, 'units' | 'sample'>): { choice: LabelAskChoice; words: string }[] {
  return [
    { choice: 'all', words: 'Run all' },
    ...(a.sample > 0 && a.units > a.sample ? [{ choice: 'sample' as const, words: `Run on a sample of ${a.sample.toLocaleString('en-US')}` }] : []),
    { choice: 'cancel', words: 'Cancel' },
  ]
}

/** One ask with its choices. */
export function LabelAskCard({ ws, ask }: { ws: string; ask: LabelAsk }) {
  const [busy, setBusy] = useState<LabelAskChoice | null>(null)
  const choose = (choice: LabelAskChoice) => {
    if (busy) return
    setBusy(choice)
    labelApi
      .answerAsk(ws, ask.id, choice)
      .catch((e: Error) => bus.emit('toast', { text: `The label ${ask.name} did not start: ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' }))
      .finally(() => setBusy(null))
  }
  return (
    <div className="chat-offer label-ask" role="group" aria-label={`Run the label ${ask.name}?`} data-ask={ask.id} data-label={ask.concept}>
      <div className="chat-offer-head">
        <Icon name="label" size={13} className="chat-offer-ico" />
        Label <span className="chat-offer-name">{ask.name}</span>
      </div>
      <p className="chat-offer-text">{`${ask.text}?`}</p>
      <div className="chat-offer-acts label-ask-acts">
        {askChoices(ask).map((c) => (
          <Button
            key={c.choice}
            variant={c.choice === 'all' ? 'primary' : c.choice === 'sample' ? 'secondary' : 'ghost'}
            size="sm"
            busy={busy === c.choice}
            disabled={!!busy && busy !== c.choice}
            onClick={() => choose(c.choice)}
          >
            {c.words}
          </Button>
        ))}
      </div>
      {ask.meta && <p className="chat-offer-files label-ask-meta">{ask.meta}</p>}
    </div>
  )
}

/** Every ask that waits, above the chat's composer. */
export function LabelAsks({ ws, concept }: { ws: string; concept?: string }) {
  const asks = useLabelAsks(ws, concept)
  if (!asks.length) return null
  return (
    <>
      {asks.map((a) => (
        <LabelAskCard key={a.id} ws={ws} ask={a} />
      ))}
    </>
  )
}
