// The one button in four variants (primary, secondary, ghost, icon) and two sizes; Segmented for an exclusive choice,
// whose chosen option is raised; and Tabs, the surfaces' text tabs. An icon button's `title` shows in the shared
// tooltip (Tooltip.tsx) on hover and keyboard focus instead of the native title, and is its accessible name when it has
// no aria-label.
import type { ButtonHTMLAttributes, FocusEvent, PointerEvent, ReactNode, Ref } from 'react'
import { Icon, type IconName } from './Icon'
import { Spinner } from './Spinner'
import { useTooltip, type TipAlign } from './Tooltip'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'icon'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant
  /** sm is 24px tall, md 28px (default md) */
  size?: ButtonSize
  /** a glyph before the label; alone (no children) the button is a square */
  icon?: IconName
  /** the working state: a ring turns before the label and the button ignores clicks */
  busy?: boolean
  /** the pressed state of a toggle; also sets aria-pressed */
  active?: boolean
  /** how an icon button's tooltip lines up under it (Tooltip placeTip) */
  tipAlign?: TipAlign
  ref?: Ref<HTMLButtonElement>
  children?: ReactNode
}

const ICON_PX: Record<ButtonSize, number> = { sm: 14, md: 16 }

export function Button({ variant = 'ghost', size = 'md', icon, busy, active, tipAlign, className, children, disabled, type = 'button', ref, title, onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur, ...rest }: ButtonProps) {
  const square = variant === 'icon' || (icon != null && children == null)
  const cls = ['btn', `btn-${variant === 'icon' ? 'ghost' : variant}`, `btn-${size}`, square ? 'btn-square' : '', busy ? 'btn-busy' : '', active ? 'active' : '', className ?? ''].filter(Boolean).join(' ')
  // an icon alone is named by its title in the tooltip; a button with a label keeps the plain attribute
  const tipText = square && title ? title : null
  const { props: tipProps, tip } = useTooltip(tipText, undefined, tipAlign)
  const t = tipProps as Partial<{ 'aria-describedby': string; onPointerEnter: (e: PointerEvent<HTMLElement>) => void; onPointerLeave: () => void; onPointerDown: () => void; onFocus: (e: FocusEvent<HTMLElement>) => void; onBlur: () => void }>
  return (
    <>
      <button
        ref={ref}
        type={type}
        className={cls}
        disabled={disabled || busy}
        aria-pressed={active != null ? active : undefined}
        aria-busy={busy || undefined}
        title={tipText ? undefined : title}
        aria-label={tipText ?? undefined}
        aria-describedby={t['aria-describedby']}
        onPointerEnter={(e) => (t.onPointerEnter?.(e), onPointerEnter?.(e))}
        onPointerLeave={(e) => (t.onPointerLeave?.(), onPointerLeave?.(e))}
        onPointerDown={(e) => (t.onPointerDown?.(), onPointerDown?.(e))}
        onFocus={(e) => (t.onFocus?.(e), onFocus?.(e))}
        onBlur={(e) => (t.onBlur?.(), onBlur?.(e))}
        {...rest}
      >
        {icon && !busy && <Icon name={icon} size={ICON_PX[size]} className="btn-ico" />}
        {children != null && <span className="btn-label">{children}</span>}
      </button>
      {tip}
    </>
  )
}

export default Button

export interface SegmentedOption<V extends string> {
  value: V
  label?: ReactNode
  icon?: IconName
  /** names an option with an icon and no label, in the one tooltip and to a screen reader, as an icon Button's title
   * does; an option with a label shows it as the browser's title */
  title?: string
  disabled?: boolean
  /** a ref the ⌘ pointer can open a thread on (a view in the views bar): `data-anchor`, with the label as its text */
  anchor?: string
  /** something new waits there (a view built for the analyst's ask, not opened yet): the accent dot after the label */
  dot?: boolean
  /** a class of the option's own, such as the state of the work on it */
  className?: string
}

/** sm 22px (a setting inside a card), md 24px (a mode switch), lg 30px (a views bar, a type bar) */
export type SegmentedSize = 'sm' | 'md' | 'lg'

export interface SegmentedProps<V extends string> {
  options: readonly SegmentedOption<V>[]
  value: V
  onChange: (value: V) => void
  /** default md */
  size?: SegmentedSize
  /** the options sit in a tinted track (a setting in a popover or a card); without it they sit on the surface */
  track?: boolean
  /** the options share the width equally */
  block?: boolean
  /** the accessible name of the group */
  label?: string
  className?: string
}

const SEG_ICON_PX: Record<SegmentedSize, number> = { sm: 12, md: 12, lg: 14 }
/** a glyph alone draws at the size an icon button of the option's height gives its glyph */
const SEG_GLYPH_PX: Record<SegmentedSize, number> = { sm: 14, md: 14, lg: 16 }

/** An exclusive choice; the chosen option is raised: the cell's paper, a hairline ring, ink at 500. */
export function Segmented<V extends string>({ options, value, onChange, size = 'md', track, block, label, className }: SegmentedProps<V>) {
  const cls = ['seg', `seg-${size}`, track ? 'seg-track' : '', block ? 'seg-block' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <span className={cls} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <SegOption
          key={o.value}
          option={o}
          size={size}
          active={o.value === value}
          onPick={() => {
            if (o.value !== value) onChange(o.value)
          }}
        />
      ))}
    </span>
  )
}

function SegOption<V extends string>({ option: o, size, active, onPick }: { option: SegmentedOption<V>; size: SegmentedSize; active: boolean; onPick: () => void }) {
  const glyphOnly = o.icon != null && o.label == null
  const { props: tipProps, tip } = useTooltip(glyphOnly ? o.title : null)
  return (
    <>
      <button
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={glyphOnly ? o.title : undefined}
        className={`seg-opt${glyphOnly ? ' seg-glyph' : ''}${active ? ' active' : ''}${o.className ? ` ${o.className}` : ''}`}
        title={glyphOnly ? undefined : o.title}
        disabled={o.disabled}
        data-anchor={o.anchor}
        data-anchor-text={o.anchor && typeof o.label === 'string' ? o.label : undefined}
        onClick={onPick}
        {...tipProps}
      >
        {o.icon && <Icon name={o.icon} size={(glyphOnly ? SEG_GLYPH_PX : SEG_ICON_PX)[size]} className="seg-ico" />}
        {o.label != null && <span className="seg-label">{o.label}</span>}
        {o.dot && <span className="dot seg-dot" role="img" aria-label="New" />}
      </button>
      {tip}
    </>
  )
}

export interface TabOption<V extends string> {
  value: V
  label: ReactNode
  /** a reply landed there: the accent dot after the name */
  dot?: boolean
  /** something is at work there (a writer writing the document): the spinner after the name, in the dot's place */
  busy?: boolean
}

export interface TabsProps<V extends string> {
  options: readonly TabOption<V>[]
  value: V
  onChange: (value: V) => void
  /** the accessible name of the tab list */
  label?: string
  className?: string
}

/** The surfaces' tabs: text only, outside the pane; the active tab in ink at 500, the others tertiary. */
export function Tabs<V extends string>({ options, value, onChange, label, className }: TabsProps<V>) {
  return (
    <nav className={`tabs${className ? ` ${className}` : ''}`} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={`tab${o.value === value ? ' active' : ''}`}
          data-tab={o.value}
          onClick={() => {
            if (o.value !== value) onChange(o.value)
          }}
        >
          <span className="tab-label">{o.label}</span>
          {o.busy ? <Spinner size={10} className="tab-dot tab-spinner" label="Writing" /> : o.dot && <span className="dot tab-dot" role="img" aria-label="Unread" />}
        </button>
      ))}
    </nav>
  )
}
