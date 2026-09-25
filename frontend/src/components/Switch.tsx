// The one switch: a pill, accent when on. A `role="switch"` button; the label sits beside it as the caller's text.
import type { ButtonHTMLAttributes, Ref } from 'react'

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'children'> {
  checked: boolean
  onChange: (checked: boolean) => void
  /** the accessible name when no visible label is associated */
  label?: string
  ref?: Ref<HTMLButtonElement>
}

export function Switch({ checked, onChange, label, className, disabled, ref, ...rest }: SwitchProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? ' on' : ''}${className ? ` ${className}` : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...rest}
    >
      <span className="switch-knob" />
    </button>
  )
}

export default Switch
