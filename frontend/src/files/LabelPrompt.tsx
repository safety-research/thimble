// The new-label card's "Label from prompt" row: the analyst describes a label, the labels model drafts it over what the
// card's Applies to says (POST /concepts/draft), and the row creates and runs it in one call (POST /concepts with
// `run`), which keeps the label only once its run starts. A description, draft or run that fails fills the card below
// instead, so nothing typed is lost and no empty label is left behind.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { TextInput } from '../components/Field'
import { labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { ConceptRun, LabelDraft } from '../lib/types'
import { draftBody, freeName, usedColours } from './labels'
import { nextFreeColour } from './LabelCard'
import type { FilesLabels } from './useLabels'

/** A description as a prompt label over `scope`, for the new-label card when the model could not define it. Pure. */
export function promptDraft(text: string, scope: readonly string[]): LabelDraft {
  return { name: '', over: 'files', marks: 'span', glob: scope.join(', '), kind: 'prompt', text, values: ['match', 'no match'] }
}

export interface DescribeHooks {
  ws: string
  labels: FilesLabels
  /** the files a label over files applies to: the patterns the new-label card's Applies to holds */
  appliesTo: string[]
  /** a run started for a new label (the pane polls its progress) */
  onRun: (id: string, run: ConceptRun) => void
  /** fill the new-label card from a draft */
  onManual: (draft: LabelDraft) => void
}

/** A description made a label: drafted by the labels model, then created under a name no label has and run, in one call
 * that keeps the label only once its run starts. `run` resolves true once the run has started; on a failure it says so
 * in a toast, fills the new-label card with what it has, and resolves false, with no label made. `busy` is the
 * description being made. */
export function useDescribe({ ws, labels, appliesTo, onRun, onManual }: DescribeHooks): { busy: string | null; run: (text: string) => Promise<boolean> } {
  const [busy, setBusy] = useState<string | null>(null)
  const run = useCallback(
    async (asked: string) => {
      const description = asked.trim()
      if (!description) return false
      setBusy(description)
      try {
        let draft: LabelDraft
        try {
          draft = await labelApi.draft(ws, description, appliesTo)
        } catch (e) {
          bus.emit('toast', { text: `Could not define the label. ${(e as Error).message}`, kind: 'error' })
          onManual(promptDraft(description, appliesTo))
          return false
        }
        const named = { ...draft, name: freeName(draft.name, labels.all.map((k) => k.name)) }
        try {
          const k = await labelApi.create(ws, { ...draftBody(named, nextFreeColour(labels.all), usedColours(labels.all)), run: true })
          track('label-apply', { target: `concept:${k.id}`, detail: { over: named.over, marks: named.marks, kind: named.kind, created: true, described: true } })
          onRun(k.id, k.run ?? { status: 'running' })
          return true
        } catch (e) {
          bus.emit('toast', { text: `Could not run ${named.name}. ${(e as Error).message}`, kind: 'error' })
          onManual(named)
          return false
        }
      } finally {
        setBusy(null)
      }
    },
    [ws, labels.all, appliesTo, onRun, onManual],
  )
  return { busy, run }
}

interface Props extends DescribeHooks {
  /** the label was made and its run started */
  onDone: () => void
}

export function LabelPrompt({ onDone, ...hooks }: Props) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const { busy, run } = useDescribe(hooks)
  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus())
  }, [])
  return (
    <form
      className="label-prompt"
      onSubmit={(e) => {
        e.preventDefault()
        if (busy) return
        void run(text).then((made) => made && onDone())
      }}
    >
      <TextInput ref={input} value={text} onChange={setText} block bare placeholder="Label from prompt…" aria-label="Label from prompt" disabled={!!busy} />
      <Button variant={text.trim() ? 'primary' : 'secondary'} size="sm" icon="arrow-up" type="submit" title="Make the label" aria-label="Make the label" className="composer-send label-prompt-send" disabled={!text.trim()} busy={!!busy} />
    </form>
  )
}
