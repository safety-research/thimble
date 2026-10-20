// The one text field in two forms: TextInput (a line) and TextArea (lines, growing to a cap). Bordered when it stands
// alone, borderless (`bare`) inside a card. `onChange` hands over the text, not the event.
import { useCallback, useEffect, useRef, type ChangeEvent, type InputHTMLAttributes, type Ref, type TextareaHTMLAttributes } from 'react'

interface FieldCommon {
  value: string
  onChange: (value: string) => void
  /** no border, no background: the field sits inside a card or a bar */
  bare?: boolean
  /** monospace text (a model id, code, a path) */
  mono?: boolean
  /** fills the container's width */
  block?: boolean
}

export interface TextInputProps extends FieldCommon, Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'children'> {
  ref?: Ref<HTMLInputElement>
}

const cls = (base: string, { bare, mono, block }: Pick<FieldCommon, 'bare' | 'mono' | 'block'>, className?: string) => [base, bare ? 'field-bare' : '', mono ? 'field-mono' : '', block ? 'field-block' : '', className ?? ''].filter(Boolean).join(' ')

export function TextInput({ value, onChange, bare, mono, block, className, type = 'text', ref, ...rest }: TextInputProps) {
  return <input ref={ref} type={type} className={cls('field', { bare, mono, block }, className)}value={value} onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)} {...rest} />
}

export interface TextAreaProps extends FieldCommon, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'children'> {
  /** grows with its text up to `maxHeight` px (default 200), then scrolls */
  autoGrow?: boolean
  maxHeight?: number
  ref?: Ref<HTMLTextAreaElement>
}

/** A TextArea's classes, for an element drawn in the same box under it (components/Code.tsx CodeArea's coloured copy of
 * its text), so that the two take the same padding, type and wrapping from the same rules. */
export const textAreaClass = ({ bare, mono, block, autoGrow, className }: Pick<TextAreaProps, 'bare' | 'mono' | 'block' | 'autoGrow' | 'className'>) =>
  cls(autoGrow ? 'field field-area field-grow' : 'field field-area', { bare, mono, block }, className)

export function TextArea({ value, onChange, bare, mono, block, autoGrow, maxHeight = 200, className, rows = 2, ref, ...rest }: TextAreaProps) {
  const own = useRef<HTMLTextAreaElement>(null)
  const emptyHeight = useRef(0)
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      own.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = el
    },
    [ref],
  )
  const fit = useCallback(() => {
    const el = own.current
    if (!autoGrow || !el || el.clientWidth === 0) return
    el.style.height = 'auto'
    // the box is border-box: the border (transparent under `bare`) counts, or every grown field is 2px short and scrolls
    const border = el.offsetHeight - el.clientHeight
    const h = Math.min(el.scrollHeight + border, maxHeight)
    if (!el.value) emptyHeight.current = h
    el.style.height = `${Math.max(h, emptyHeight.current)}px`
  }, [autoGrow, maxHeight])
  useEffect(() => {
    fit()
  }, [value, fit])
  return (
    <textarea
      ref={setRef}
      className={textAreaClass({ bare, mono, block, autoGrow, className })}
      rows={rows}
      value={value}
      style={autoGrow ? { maxHeight } : undefined}
      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
      {...rest}
    />
  )
}
