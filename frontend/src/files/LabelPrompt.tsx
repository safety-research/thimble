// The new-label card's "Label from prompt" row: the analyst describes a label, the labels model drafts it over what the
// card's Applies to says (POST /concepts/draft), and the draft fills the card below, where the analyst checks its name,
// classifier, Applies to and how many units Run reads, and presses Run. Nothing runs before that press (bug hunt G12: the
// draft ran at once as a prompt label over all 42,205 records of every file). The card's Run creates and runs the label in
// one call (POST /concepts with `run`), which keeps the label only once its run starts, so no empty label is left behind
// (bug hunt D1). A description the model could not define fills the card as a prompt label, so nothing typed is lost.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { TextInput } from '../components/Field'
import { labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import type { LabelDraft } from '../lib/types'
import { freeName } from './labels'
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
  /** fill the new-label card from a draft, for the analyst to check and run */
  onDraft: (draft: LabelDraft) => void
}

/** A description drafted by the labels model into the new-label card, under a name no label has. `run` resolves true
 * once the card holds the draft; on a failure it says so in a toast, fills the card as a prompt label with the
 * description, and resolves false. Nothing is created or run. `busy` is the description being drafted. */
export function useDescribe({ ws, labels, appliesTo, onDraft }: DescribeHooks): { busy: string | null; run: (text: string) => Promise<boolean> } {
  const [busy, setBusy] = useState<string | null>(null)
  const run = useCallback(
    async (asked: string) => {
      const description = asked.trim()
      if (!description) return false
      setBusy(description)
      try {
        const draft = await labelApi.draft(ws, description, appliesTo)
        onDraft({ ...draft, name: freeName(draft.name, labels.all.map((k) => k.name)) })
        return true
      } catch (e) {
        bus.emit('toast', { text: `Could not define the label. ${(e as Error).message}`, kind: 'error' })
        onDraft(promptDraft(description, appliesTo))
        return false
      } finally {
        setBusy(null)
      }
    },
    [ws, labels.all, appliesTo, onDraft],
  )
  return { busy, run }
}

export function LabelPrompt(hooks: DescribeHooks) {
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
        // the description stays, to be changed and drafted again; the field takes the focus back once it is enabled
        void run(text).then(() => requestAnimationFrame(() => input.current?.focus()))
      }}
    >
      <TextInput ref={input} value={text} onChange={setText} block bare placeholder="Label from prompt…" aria-label="Label from prompt" disabled={!!busy} />
      <Button variant={text.trim() ? 'primary' : 'secondary'} size="sm" icon="arrow-up" type="submit" title="Draft the label" aria-label="Draft the label" className="composer-send label-prompt-send" disabled={!text.trim()} busy={!!busy} />
    </form>
  )
}
