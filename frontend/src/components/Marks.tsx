// Marks and keys. A mark is one glyph that judges or flags: the unread dot in the accent, ✓ verified in the positive
// colour, ⚑ not checked in the warning colour, ✕ failed in the negative colour, set inline after what it judges. A
// key is a key's name in mono in a hairline box of radius 4 (tab, esc, ↵).
import type { HTMLAttributes, ReactNode } from 'react'

export type MarkKind = 'unread' | 'verified' | 'unchecked' | 'failed'

const GLYPH: Record<Exclude<MarkKind, 'unread'>, string> = { verified: '✓', unchecked: '⚑', failed: '✕' }
const NAME: Record<MarkKind, string> = { unread: 'Unread', verified: 'verified', unchecked: 'not checked', failed: 'failed' }

export interface MarkProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  kind: MarkKind
  /** the accessible name, when the default word does not fit */
  label?: string
}

export function Mark({ kind, label, className, ...rest }: MarkProps) {
  const cls = `mark mark-${kind}${className ? ` ${className}` : ''}`
  if (kind === 'unread') return <span className={`dot ${cls}`} role="img" aria-label={label ?? NAME[kind]} {...rest} />
  return (
    <span className={cls} role="img" aria-label={label ?? NAME[kind]} {...rest}>
      {GLYPH[kind]}
    </span>
  )
}

export function Kbd({ children, className, ...rest }: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <kbd className={`kbd${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </kbd>
  )
}

export default Mark
