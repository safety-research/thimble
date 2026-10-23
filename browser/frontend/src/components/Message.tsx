// The analyst's own message: a solid accent tile, the text in the accent's text-on colour. The agent's words are plain
// text on the window and need no part of their own.
import type { HTMLAttributes, ReactNode, Ref } from 'react'

export interface UserMessageProps extends HTMLAttributes<HTMLParagraphElement> {
  ref?: Ref<HTMLParagraphElement>
  children: ReactNode
}

export function UserMessage({ className, children, ref, ...rest }: UserMessageProps) {
  return (
    <p ref={ref} className={`msg-user${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </p>
  )
}

export default UserMessage
