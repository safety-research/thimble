// The chat's composer: the shared composer (components/Composer) with main's model line at its foot (ModelLine): its
// model as a menu (`models`, `onModel`), its effort and its fast mode, which main's next turn runs with
// (events.model_route, events.effort_route, events.fast_route). A thread whose message goes to a session thimble starts shows that role's line instead
// (`chip`, RoleChip). A thread whose run the browser can stop (main's turn, a side thread's fork, the orientation, a
// writer, a check's run, a dev ticket, a view's build or its review) passes `stop`, and while it runs the composer
// carries its Stop, beside the send square once text is typed (ComposerFrame), as Esc is in Claude Code. Each thread
// keeps its own draft. Text offered
// from outside the chat (chat/pending offerDraft: a failed fix's Ask Claude, a failed view's Send to thimble-fix)
// joins its thread's draft, once. A "/" at the start
// of the text opens the list of the commands the composer handles (commands.ts) above the sheet, one row each, its name
// and what it does, as Claude Code lists its own; the list follows what is typed. ↑ and ↓ move in it; Enter, Tab or a
// click puts the command in the text with a space after it, ready for its words, except that Enter on a command typed
// in full sends it at once, as without the list; Esc closes it. It closes too when the text is no longer a "/" and part
// of a name, and when the text loses the focus. A list a command opens (`picker`: the messages `/rewind` lists,
// RewindPicker) takes its place while it is open.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ComposerFrame, type ComposerFrameProps } from '../components/Composer'
import type { MainEffort } from '../lib/types'
import { COMMANDS, commandsFor, type ChatCommand } from './commands'
import { MODEL_TIP, ModelLine } from './ModelLine'
import { onDraftOffered, takeDrafts, type Offer } from './pending'

export interface ComposerProps {
  /** the model main runs (ModelLine.mainModel); nothing while it is unknown */
  model?: string | null
  /** with `onModel`, the model is a menu of these (lib/models modelChoices) */
  models?: readonly string[]
  onModel?: (model: string) => void
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
  /** the Stop of what the thread shows while it runs (ComposerFrame `stop`): main's turn, a side thread's fork, an agent */
  stop?: ComposerFrameProps['stop']
  /** the thread shown: each thread keeps its own draft, so text typed in one is never sent from another */
  thread?: string
  /** the commands a "/" lists: the ones the composer handles (COMMANDS), unless a test gives others */
  commands?: readonly ChatCommand[]
  /** a list a command opened, above the sheet in the place of the list of commands while it is open: the messages
   * `/rewind` lists (RewindPicker), which takes the keys */
  picker?: ReactNode
}

/** `drafts` with `thread`'s draft set to `text`, an empty draft dropped. Pure. */
export function withDraft(drafts: Readonly<Record<string, string>>, thread: string, text: string): Readonly<Record<string, string>> {
  if ((drafts[thread] ?? '') === text) return drafts
  const next = { ...drafts }
  if (text) next[thread] = text
  else delete next[thread]
  return next
}

/** `drafts` with each offered text after its thread's draft, on a line of its own, unless the draft holds it already (the
 * same failure offered again). Pure. */
export function withOffers(drafts: Readonly<Record<string, string>>, offers: readonly Offer[]): Readonly<Record<string, string>> {
  return offers.reduce((d, o) => (d[o.thread]?.includes(o.text) ? d : withDraft(d, o.thread, d[o.thread] ? `${d[o.thread]}\n${o.text}` : o.text)), drafts)
}

export function Composer({ model, models, onModel, effort, onEffort, fast = null, onFast, chip: own, onSend, sending, placeholder, label = 'Ask about the data', disabled = false, stop, thread = 'main', commands = COMMANDS, picker }: ComposerProps) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const input = drafts[thread] ?? ''
  const taRef = useRef<HTMLTextAreaElement>(null)
  // the list of commands: while the text has the focus, until Esc closes it (`shut`); typing, or the focus coming
  // back, opens it again
  const [focused, setFocused] = useState(false)
  const [shut, setShut] = useState(false)
  const [at, setAt] = useState(0)
  const found = focused && !shut && !disabled && !picker ? commandsFor(input, commands) : []
  const active = Math.min(at, found.length - 1)
  const listId = useId()
  const optionId = (i: number) => `${listId}-${i}`
  useEffect(() => {
    if (found.length) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' })
  }, [active, found.length])
  // a picked command puts the caret after its space, ready for its words
  const picked = useRef(false)
  useLayoutEffect(() => {
    const t = taRef.current
    if (!picked.current || !t) return
    picked.current = false
    t.focus()
    t.setSelectionRange(t.value.length, t.value.length)
  }, [input])
  const pick = (c: ChatCommand) => {
    picked.current = true
    setDrafts((d) => withDraft(d, thread, `${c.name} `))
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!found.length || e.nativeEvent.isComposing) return
    const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setAt((active + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length)
    } else if ((e.key === 'Enter' || e.key === 'Tab') && plain) {
      // a command typed in full: Enter is the composer's, which sends it
      if (e.key === 'Enter' && found[active].name === input) return
      e.preventDefault()
      pick(found[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setShut(true)
    }
  }
  const list = found.length ? (
    // a press in the list keeps the focus in the text
    <div id={listId} className="chat-commands" role="listbox" aria-label="Commands" onMouseDown={(e) => e.preventDefault()}>
      {found.map((c, i) => (
        <div key={c.name} id={optionId(i)} role="option" aria-selected={i === active} className={`chat-command${i === active ? ' active' : ''}`} onPointerMove={() => i !== active && setAt(i)} onClick={() => pick(c)}>
          <span className="chat-command-name">{c.name}</span>
          <span className="chat-command-about">{c.about}</span>
        </div>
      ))}
    </div>
  ) : null
  // what was offered before the composer was drawn, then each offer as it comes
  useEffect(() => {
    const take = () => {
      const offers = takeDrafts()
      if (offers.length) setDrafts((d) => withOffers(d, offers))
    }
    take()
    return onDraftOffered(take)
  }, [])
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
      models={onModel ? models : undefined}
      onModel={onModel}
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
      onChange={(v) => {
        setDrafts((d) => withDraft(d, thread, v))
        setAt(0)
        setShut(false)
      }}
      onSubmit={send}
      above={picker ?? list}
      onKeyDown={onKey}
      textProps={{
        onFocus: () => {
          setFocused(true)
          setShut(false)
        },
        onBlur: () => setFocused(false),
        'aria-autocomplete': 'list',
        'aria-controls': found.length ? listId : undefined,
        'aria-activedescendant': found.length ? optionId(active) : undefined,
      }}
      placeholder={placeholder}
      label={placeholder ?? label}
      disabled={disabled}
      busy={sending}
      model={chip}
      stop={stop}
    />
  )
}
