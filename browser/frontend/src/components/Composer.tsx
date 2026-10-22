// The shared composer: a sheet floating over the work, the text on top, the foot with the model control at the left and
// the send square at the right (accent once there is something to send). Enter sends and Shift+Enter breaks the line
// (with `submitOnMod`, ⌘/Ctrl+Enter sends). With `stop` (an agent the browser can stop runs), the square is the stop
// square while the field is empty, as in Claude; once there is text it is the send square again, so what is typed
// while the agent runs is sent (where it goes, and whether it waits for the run, is the caller's), and clearing the
// field brings Stop back. The two squares fill one slot with one component, so React keeps the button and keyboard focus
// stays on it across the swap. Stop ignores `disabled`, which is about the field: stopping needs nothing a loading or unreadable thread lacks.
// With `tip`, hovering the composer shows it in the one tooltip, a disabled field included (a demo page's composer
// says why nothing can be typed there).
import { type FormEvent, type ReactNode, type Ref } from 'react'
import { Button } from './Button'
import { TextArea } from './Field'
import type { IconName } from './Icon'
import { useTooltip } from './Tooltip'

export interface ComposerFrameProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  /** names where the text goes: Reply in main… */
  placeholder?: string
  /** the text area's accessible name */
  label?: string
  disabled?: boolean
  /** what hovering the composer shows in the one tooltip, such as why it is disabled */
  tip?: string
  /** a send is in flight: the square shows the ring */
  busy?: boolean
  /** the foot's left side: the model and effort as quiet text or a menu */
  model?: ReactNode
  /** more controls in the foot, before the send square */
  tools?: ReactNode
  /** rows above the text (a title field) */
  head?: ReactNode
  /** the running agent's Stop, which takes the send square's place while the field is empty: `label` names it in the
   * tooltip and to a screen reader (Stop the orientation), and `busy` shows the ring while the stop request is in
   * flight */
  stop?: { label: string; onStop: () => void; busy?: boolean }
  sendIcon?: IconName
  sendLabel?: string
  mono?: boolean
  rows?: number
  maxHeight?: number
  /** ⌘/Ctrl+Enter sends instead of Enter */
  submitOnMod?: boolean
  spellCheck?: boolean
  className?: string
  textRef?: Ref<HTMLTextAreaElement>
  /** a letter typed while the field is empty: true when something took it (a card's key, v), so the field gets
   * nothing; `type(text)` puts a word in the field (chat/Composer, cards/keys.ts) */
  onEmptyKey?: (key: string, type: (text: string) => void) => boolean
  [data: `data-${string}`]: string | undefined
}

export function ComposerFrame({ value, onChange, onSubmit, placeholder, label, disabled = false, tip, busy = false, model, tools, head, stop, sendIcon = 'arrow-up', sendLabel = 'Send', mono, rows = 2, maxHeight = 200, submitOnMod = false, spellCheck, className, textRef, onEmptyKey, ...rest }: ComposerFrameProps) {
  const ready = !!value.trim() && !disabled
  const { props: tipProps, tip: tipEl } = useTooltip(tip, undefined, 'start')
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (ready && !busy) onSubmit()
  }
  return (
    <form className={`composer${ready ? ' composer-ready' : ''}${disabled ? ' composer-disabled' : ''}${className ? ` ${className}` : ''}`} onSubmit={submit} data-tipped={tip ? '' : undefined} {...tipProps} {...rest}>
      {head}
      <TextArea
        ref={textRef}
        bare
        block
        autoGrow
        mono={mono}
        maxHeight={maxHeight}
        rows={rows}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        disabled={disabled}
        spellCheck={spellCheck}
        className="composer-text"
        onKeyDown={(e) => {
          if (!value && onEmptyKey && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing && onEmptyKey(e.key, onChange)) {
            e.preventDefault()
            return
          }
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          const mod = e.metaKey || e.ctrlKey
          if (submitOnMod ? mod : !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-foot">
        {model != null && <span className="composer-model">{model}</span>}
        <span className="composer-spacer" />
        {tools}
        {stop && !value.trim() ? (
          <Button variant="primary" size="sm" icon="stop" title={stop.label} aria-label={stop.label} type="button" className="composer-send" busy={stop.busy} onClick={stop.onStop} />
        ) : (
          <Button variant={ready ? 'primary' : 'secondary'} size="sm" icon={sendIcon} title={sendLabel} aria-label={sendLabel} type="submit" className="composer-send" disabled={!ready} busy={busy} />
        )}
      </div>
      {tipEl}
    </form>
  )
}

export default ComposerFrame
