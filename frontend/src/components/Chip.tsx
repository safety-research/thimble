// The one chip: 20px tall, a 10px icon and a name, radius 4. The name is mono when code-like, else the body face. A chip
// that points at something is the accent chip (accent edge and text, a light tint); a value or status word is the
// neutral chip; a tone colours text and edge; `active` inverts it to ink.
import type { HTMLAttributes, MouseEvent, ReactNode, Ref } from 'react'
import { Icon, type IconName } from './Icon'

export type ChipKind = 'ref' | 'label' | 'value' | 'status' | 'plain'
export type ChipTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'negative' | 'info'
export type ChipFace = 'mono' | 'sans'

/** The tone a kind takes when none is given: what points somewhere is the accent chip, a value or a word is ink. */
export const DEFAULT_TONE: Record<ChipKind, ChipTone> = { ref: 'accent', label: 'accent', value: 'neutral', status: 'neutral', plain: 'neutral' }

export interface ChipProps extends Omit<HTMLAttributes<HTMLElement>, 'onClick' | 'title' | 'children'> {
  kind: ChipKind
  tone?: ChipTone
  /** the name's face: mono for something code-like, sans for a name in words; mono by default, sans for a label */
  face?: ChipFace
  /** a glyph before the text, 10px */
  icon?: IconName
  /** a glyph after the text, 10px (a caret on a chip that opens a menu, › on one that goes somewhere) */
  trailingIcon?: IconName
  /** a count after the text, past a hairline */
  count?: number
  /** the selected state (a filter that is on, a toggle that is set); also sets aria-pressed on a button chip */
  active?: boolean
  /** makes the chip a control; it renders as a <button> unless `as` says otherwise */
  onClick?: (e: MouseEvent<HTMLElement>) => void
  title?: string
  /** the element: a <button> when there is an onClick, else a <span> */
  as?: 'span' | 'button'
  disabled?: boolean
  ref?: Ref<HTMLElement>
  children?: ReactNode
}

export function Chip({ kind, tone, face, icon, trailingIcon, count, active, onClick, title, as, disabled, className, children, ref, ...rest }: ChipProps) {
  const t = tone ?? DEFAULT_TONE[kind]
  const sans = (face ?? (kind === 'label' ? 'sans' : 'mono')) === 'sans'
  const cls = ['chip', `chip-${kind}`, `chip-tone-${t}`, sans ? 'chip-sans' : '', onClick || as === 'button' ? 'chip-act' : '', active ? 'active' : '', className ?? ''].filter(Boolean).join(' ')
  const inner = (
    <>
      {icon && <Icon name={icon} size={10} className="chip-ico" />}
      {children != null && <span className="chip-text">{children}</span>}
      {count != null && <span className="chip-count">{count.toLocaleString()}</span>}
      {trailingIcon && <Icon name={trailingIcon} size={10} className="chip-ico chip-ico-trail" />}
    </>
  )
  const tag = as ?? (onClick ? 'button' : 'span')
  if (tag === 'button') {
    return (
      <button type="button" ref={ref as Ref<HTMLButtonElement>} className={cls} title={title} onClick={onClick} disabled={disabled} aria-pressed={active != null ? active : undefined} {...rest}>
        {inner}
      </button>
    )
  }
  return (
    <span ref={ref as Ref<HTMLSpanElement>} className={cls} title={title} onClick={onClick} {...rest}>
      {inner}
    </span>
  )
}

export default Chip
