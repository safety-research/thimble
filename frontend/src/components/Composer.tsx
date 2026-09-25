// The shared composer: a sheet floating over the work, the text on top, the foot with the model control at the left and
// the send square at the right (accent once there is something to send). Enter sends and Shift+Enter breaks the line
// (with `submitOnMod`, ⌘/Ctrl+Enter sends).
import { type FormEvent, type ReactNode, type Ref } from 'react'
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
  [data: `data-${string}`]: string | undefined
}

export function ComposerFrame({ value, onChange, onSubmit, placeholder, label, disabled = false, busy = false, model, tools, head, sendIcon = 'arrow-up', sendLabel = 'Send', mono, rows = 2, maxHeight = 200, submitOnMod = false, spellCheck, className, textRef, ...rest }: ComposerFrameProps) {
  const ready = !!value.trim() && !disabled
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (ready && !busy) onSubmit()
  }
  return (
    <form className={`composer${ready ? ' composer-ready' : ''}${className ? ` ${className}` : ''}`} onSubmit={submit} {...rest}>
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
        <Button variant={ready ? 'primary' : 'secondary'} size="sm" icon={sendIcon} title={sendLabel} aria-label={sendLabel} type="submit" className="composer-send" disabled={!ready} busy={busy} />
      </div>
    </form>
  )
}

export default ComposerFrame
