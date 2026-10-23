// The chat's note on a demo page (lib/demo): one calm line above the composer once an action that needs Claude stopped
// there, with × to hide it until the next one. What was typed stays where it was typed.
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { DEMO_NOTE, dismissDemoNote, useDemoNote } from '../lib/demo'

export function DemoNote() {
  const note = useDemoNote()
  if (!note) return null
  return (
    <div className="chat-continue chat-demo-note" role="status" data-demo-note={note}>
      <Icon name="terminal" size={13} className="chat-continue-ico" />
      <span className="chat-demo-note-text">{DEMO_NOTE}</span>
      <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label="Dismiss" className="chat-demo-note-x" onClick={dismissDemoNote} />
    </div>
  )
}
