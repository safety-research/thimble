// The one card frame: head row (title left, meta right), body, foot. Every card-like thing on any surface uses it.
import type { AllHTMLAttributes, ReactNode, Ref } from 'react'

export type CardTag = 'div' | 'article' | 'section' | 'form' | 'li' | 'a'

export interface CardProps extends Omit<AllHTMLAttributes<HTMLElement>, 'children' | 'title'> {
  /** the head row's left side: a string becomes the title; a node is placed as given */
  head?: ReactNode
  /** the head row's right side, small and tertiary (who, when, a kind chip) */
  meta?: ReactNode
  /** the foot row, under a hairline: controls and chips */
  foot?: ReactNode
  /** the element (default div); a form takes onSubmit, an anchor takes href */
  as?: CardTag
  /** the accent ring of the selected card */
  selected?: boolean
  /** the filtered-out state: the card stands at 45% */
  dim?: boolean
  /** no shadow, a hairline border: a card inside a card, or a row that looks like a card */
  flat?: boolean
  /** the body's padding removed, for a chart or table that fills the frame */
  tight?: boolean
  ref?: Ref<HTMLElement>
  children?: ReactNode
}

export function Card({ head, meta, foot, as = 'div', selected, dim, flat, tight, className, children, ref, ...rest }: CardProps) {
  const Tag = as as 'div'
  const cls = ['card', selected ? 'selected' : '', dim ? 'dim' : '', flat ? 'card-flat' : '', tight ? 'card-tight' : '', className ?? ''].filter(Boolean).join(' ')
  const hasHead = head != null || meta != null
  // `{open && …}` hands over false; a boolean or an empty string is no body
  const hasBody = children != null && typeof children !== 'boolean' && children !== ''
  return (
    <Tag ref={ref as Ref<HTMLDivElement>} className={cls} {...(rest as AllHTMLAttributes<HTMLDivElement>)}>
      {hasHead && (
        <div className="card-head">
          {typeof head === 'string' ? <span className="card-title">{head}</span> : head}
          {meta != null && <span className="card-meta">{meta}</span>}
        </div>
      )}
      {hasBody && <div className="card-body">{children}</div>}
      {foot != null && <div className="card-foot">{foot}</div>}
    </Tag>
  )
}

export default Card
