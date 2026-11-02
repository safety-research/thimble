// The shared composer: a sheet floating over the work, the text on top, the foot with the model control at the left and
// the send square at the right (accent once there is something to send). Enter sends and Shift+Enter breaks the line
// (with `submitOnMod`, ⌘/Ctrl+Enter sends). With `stop` (an agent the browser can stop runs), the square is the stop
// square while the field is empty, as in Claude; once there is text the send square joins it at the right, so what is
// typed while the agent runs is sent (where it goes, and whether it waits for the run, is the caller's), and the agent
// can still be stopped, as Esc stops it in Claude Code while a message waits. Each square keeps its own slot, so React
// keeps the stop button, and the keyboard focus on it, as the send square comes and goes. Stop ignores `disabled`,
// which is about the field: stopping needs nothing a loading or unreadable thread lacks. What floats above the sheet
// (`above`, the chat's list of commands) sees each key first (`onKeyDown`) and takes the keys it uses.
import { type FormEvent, type KeyboardEvent, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react'
import { Button } from './Button'
import { TextArea } from './Field'
import type { IconName } from './Icon'

export interface ComposerFrameProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  /** names where the text goes: Reply in main… */
  placeholder?: string
  /** the text area's accessible name */
  label?: string
  disabled?: boolean
  /** a send is in flight: the square shows the ring */
  busy?: boolean
  /** the foot's left side: the model and effort as quiet text or a menu */
  model?: ReactNode
  /** more controls in the foot, before the send square */
  tools?: ReactNode
  /** rows above the text (a title field) */
  head?: ReactNode
  /** the running agent's Stop, which takes the send square's place while the field is empty and stands before it once
   * text is typed: `label` names it in the tooltip and to a screen reader (Stop the orientation), and `busy` shows the
   * ring while the stop request is in flight */
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
  /** floats above the sheet, over what lies above it and never over the text: the chat's list of commands */
  above?: ReactNode
  /** sees each key in the text first; a key it takes (preventDefault) goes no further, so an Enter it takes sends nothing */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  /** more of the text area's attributes: its focus handlers, and the list it controls */
  textProps?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onKeyDown' | 'children'>
  [data: `data-${string}`]: string | undefined
}

export function ComposerFrame({ value, onChange, onSubmit, placeholder, label, disabled = false, busy = false, model, tools, head, stop, sendIcon = 'arrow-up', sendLabel = 'Send', mono, rows = 2, maxHeight = 200, submitOnMod = false, spellCheck, className, textRef, above, onKeyDown, textProps, ...rest }: ComposerFrameProps) {
  const ready = !!value.trim() && !disabled
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (ready && !busy) onSubmit()
  }
  return (
    <form className={`composer${ready ? ' composer-ready' : ''}${disabled ? ' composer-disabled' : ''}${className ? ` ${className}` : ''}`} onSubmit={submit} {...rest}>
      {above}
      {head}
      <TextArea
        {...textProps}
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
          onKeyDown?.(e)
          if (e.defaultPrevented || e.key !== 'Enter' || e.nativeEvent.isComposing) return
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
        {stop && <Button variant={value.trim() ? 'secondary' : 'primary'} size="sm" icon="stop" title={stop.label} aria-label={stop.label} type="button" className="composer-send" busy={stop.busy} onClick={stop.onStop} />}
        {(!stop || !!value.trim()) && <Button variant={ready ? 'primary' : 'secondary'} size="sm" icon={sendIcon} title={sendLabel} aria-label={sendLabel} type="submit" className="composer-send" disabled={!ready} busy={busy} />}
      </div>
    </form>
  )
}

export default ComposerFrame
