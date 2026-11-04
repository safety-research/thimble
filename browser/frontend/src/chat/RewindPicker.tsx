// The list `/rewind` opens in main's composer (ChatPanel), as Claude Code's /rewind opens the list of the prompts of its
// session: the analyst's own messages in main's current chat (rewind.ts rewindChoices), newest first, each on one line
// with its first words and the time it was sent, under the line that says what a rewind does. It floats above the
// composer in the place of the list of commands (Composer `picker`) and takes the keyboard's focus. ↑ and ↓ move in it,
// round from one end to the other, Home and End go to its ends, and the pointer moves with them; the rows above the
// active one, the newer messages a rewind to it takes back too, are tinted with it. Enter or a click picks a message, and
// main goes back to before it through the rewind its ↶ asks for (ChatPanel rewindTo), while the row shows that it runs.
// Esc closes it, and so do a press outside it and the focus going elsewhere; when it closes with the focus in it, the
// focus goes back where it was, the composer's text.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Spinner } from '../components/Spinner'
import { hhmm } from '../lib/time'
import { RefText } from './markdown'
import { stripHarness } from './model'
import { REWIND_EFFECT, type RewindChoice } from './rewind'

/** The question over the list, before what a rewind does (REWIND_EFFECT). */
export const PICK_QUESTION = 'Rewind to before which message?'

/** A message's words on one line, as its row shows them: the harness's wrapper aside, each run of space one space. Pure. */
export function oneLine(text: string): string {
  return stripHarness(text).replace(/\s+/g, ' ').trim()
}

export function RewindPicker({ choices, ws, busy = false, onPick, onClose }: { choices: readonly RewindChoice[]; ws: string; busy?: boolean; onPick: (event: string) => void; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // the message the keys and the pointer are on, by its event, so that a list that changes under it keeps it; the
  // newest at first
  const [on, setOn] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const at = Math.max(0, choices.findIndex((c) => c.event === on))
  const id = useId()
  const optionId = (i: number) => `${id}-${i}`
  const closed = useRef(false)

  // the focus comes in as the list opens, and goes back where it was when the list closes with the focus in it
  useLayoutEffect(() => {
    closed.current = false
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
    listRef.current?.focus({ preventScroll: true })
    const root = rootRef.current
    return () => {
      closed.current = true
      if (root?.contains(document.activeElement) && back?.isConnected) back.focus({ preventScroll: true })
    }
  }, [])
  // a press outside closes it
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [onClose])
  useEffect(() => {
    if (choices.length) document.getElementById(optionId(at))?.scrollIntoView?.({ block: 'nearest' })
  }, [at, choices.length])

  const pick = (c: RewindChoice | undefined) => {
    if (!c || busy) return
    setPicked(c.event)
    onPick(c.event)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    const moves: Readonly<Record<string, number>> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: choices.length - 1 }
    const to = Object.hasOwn(moves, e.key) ? moves[e.key] : null
    if (to != null) {
      e.preventDefault()
      if (!busy && choices.length) setOn(choices[(to + choices.length) % choices.length].event)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(choices[at])
    }
  }
  return (
    <div
      ref={rootRef}
      className="chat-rewind-pick"
      // a press in the list keeps the focus in it
      onMouseDown={(e) => e.preventDefault()}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null
        if (!closed.current && to && !e.currentTarget.contains(to)) onClose()
      }}
    >
      <p className="chat-rewind-pick-head">
        <span id={`${id}-q`} className="chat-rewind-pick-question">
          {PICK_QUESTION}
        </span>{' '}
        <span id={`${id}-d`}>{REWIND_EFFECT}</span>
      </p>
      <div
        ref={listRef}
        className="chat-rewind-pick-list"
        role="listbox"
        tabIndex={0}
        aria-labelledby={`${id}-q`}
        aria-describedby={`${id}-d`}
        aria-activedescendant={choices.length ? optionId(at) : undefined}
        aria-busy={busy || undefined}
        onKeyDown={onKey}
      >
        {choices.map((c, i) => (
          <div
            key={c.event}
            id={optionId(i)}
            role="option"
            aria-selected={i === at}
            className={`chat-rewind-choice${i === at ? ' active' : ''}`}
            data-event={c.event}
            // a newer message, which a rewind to the active one takes back too
            data-after={i < at || undefined}
            onPointerMove={() => !busy && i !== at && setOn(c.event)}
            onClick={() => pick(c)}
          >
            <span className="chat-rewind-choice-words">
              <RefText text={oneLine(c.text)} workspace={ws} />
            </span>
            {busy && picked === c.event ? (
              <Spinner label="Rewinding" />
            ) : (
              <time className="time" dateTime={c.ts}>
                {hhmm(c.ts)}
              </time>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
