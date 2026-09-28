// The chat's composer: the shared composer (components/Composer) with main's model line at its foot (ModelLine). Main
// runs in the analyst's Claude Code session, so its model is chosen in the terminal with /model. Its effort and fast mode
// are kept for its next launch (channel.effort_route, channel.fast_route). A thread whose message goes to a session thimble starts shows that role's line instead
// (`chip`, RoleChip). The browser cannot stop a turn, so there is no Stop. Each thread keeps its own draft.
import { useRef, useState, type ReactNode } from 'react'
import { ComposerFrame } from '../components/Composer'
import type { MainEffort } from '../lib/types'
import { MODEL_TIP, ModelLine } from './ModelLine'

export interface ComposerProps {
  /** the model main runs, as the mirror read it from the session's transcript; nothing while it is unknown */
  model?: string | null
  /** main's effort as the line shows it (ModelLine.mainEffort) */
  effort?: MainEffort | null
  /** picks main's effort; without it the foot only names the model */
  onEffort?: (e: MainEffort) => void
  /** main's fast mode (ModelLine.mainFast); null while no session is attached */
  fast?: boolean | null
  onFast?: (on: boolean) => void
  /** the foot's line in place of main's, for a message that goes to another session (RoleChip) */
  chip?: ReactNode
  /** sends the text; a promise that resolves false hands the text back to the field when it is still empty */
  onSend: (text: string) => void | Promise<boolean>
  /** a message is on its way to the session */
  sending: boolean
  /** names where the text goes, in the field while it is empty: Reply in main… */
  placeholder?: string
  /** the text area's accessible name when there is no placeholder */
  label?: string
  disabled?: boolean
  /** the thread shown: each thread keeps its own draft, so text typed in one is never sent from another */
  thread?: string
}

/** `drafts` with `thread`'s draft set to `text`, an empty draft dropped. Pure. */
export function withDraft(drafts: Readonly<Record<string, string>>, thread: string, text: string): Readonly<Record<string, string>> {
  if ((drafts[thread] ?? '') === text) return drafts
  const next = { ...drafts }
  if (text) next[thread] = text
  else delete next[thread]
  return next
}

export function Composer({ model, effort, onEffort, fast = null, onFast, chip: own, onSend, sending, placeholder, label = 'Ask about the data', disabled = false, thread = 'main' }: ComposerProps) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const input = drafts[thread] ?? ''
  const taRef = useRef<HTMLTextAreaElement>(null)
  const send = () => {
    const text = input.trim()
    if (!text || disabled || sending) return
    const from = thread
    setDrafts((d) => withDraft(d, from, ''))
    const sent = onSend(text)
    // a send that did not go out hands the text back to the thread it was typed in
    if (sent && typeof sent.then === 'function') void sent.then((ok) => ok === false && setDrafts((d) => (d[from] ? d : withDraft(d, from, text))))
    taRef.current?.focus()
  }
  const chip = own ? (
    own
  ) : model || (onEffort && effort) ? (
    <ModelLine
      model={model}
      modelTip={MODEL_TIP}
      effort={onEffort ? effort : null}
      onEffort={(e) => onEffort?.(e as MainEffort)}
      fast={fast ?? false}
      onFast={fast != null ? onFast : undefined}
      label="main and its threads"
    />
  ) : undefined
  return (
    <ComposerFrame
      className="chat-composer"
      data-panel="chat"
      textRef={taRef}
      value={input}
      onChange={(v) => setDrafts((d) => withDraft(d, thread, v))}
      onSubmit={send}
      placeholder={placeholder}
      label={placeholder ?? label}
      disabled={disabled}
      busy={sending}
      model={chip}
    />
  )
}
