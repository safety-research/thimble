// The end of an orientation's or a writer's thread that sent its summary to main at its end (its SubagentHandback
// call): one quiet line, `Summary sent to main`, with the summary folded under it. A side thread's answer never goes to
// main from the browser: main gets only each fork's closing `↳` line.
import { useState } from 'react'
import { Icon } from '../components/Icon'
import { CardChipCites } from '../components/RefChip'
import { ChatMarkdown } from './markdown'
import { Note } from './Notes'

export const SUMMARY_SENT = 'Summary sent to main'

/** The end of an orientation's or a writer's thread that sent its summary to main (ChatPanel orientMessages): one
 * quiet line, which a click opens on the summary as the thread's message, and folds again. `anchor` is the summary's
 * data-anchor, so a ⌘-click on it starts a thread there. */
export function HandedBack({ text, anchor }: { text: string; anchor?: string }) {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen((o) => !o)
  return (
    <>
      <Note
        className={`chat-hand-back${open ? ' open' : ''}`}
        data-state="handed"
        text={
          <span
            className="chat-note-head chat-note-act"
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={toggle}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggle()
              }
            }}
          >
            {SUMMARY_SENT}
            <Icon name="chevron-right" size={10} className="chat-row-caret" />
          </span>
        }
      />
      {open && (
        <div className="chat-msg chat-assistant chat-hand-back-summary">
          <div className="chat-text" data-anchor={anchor} data-anchor-text={anchor ? text : undefined}>
            <CardChipCites.Provider value={true}>
              <ChatMarkdown text={text} />
            </CardChipCites.Provider>
          </div>
        </div>
      )}
    </>
  )
}
