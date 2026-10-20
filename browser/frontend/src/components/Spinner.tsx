// The working mark: a small rotating ring sized by `size` (styles/spinner.css). Decorative unless `label` is given.
import type { CSSProperties, HTMLAttributes } from 'react'

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** the ring's outer size in px (default 10, the design's one size); the stroke grows to 2px from 16 up */
  size?: number
  /** a status label for assistive tech */
  label?: string
}

export function Spinner({ size = 10, label, className, style, ...rest }: SpinnerProps) {
  const vars = { '--spinner-size': `${size}px`, '--spinner-stroke': size >= 16 ? '2px' : '1.5px', ...style } as CSSProperties
  const cls = className ? `spinner ${className}` : 'spinner'
  return label ? <span className={cls} style={vars} role="status" aria-label={label} {...rest} /> : <span className={cls} style={vars} aria-hidden="true" {...rest} />
}

export default Spinner
