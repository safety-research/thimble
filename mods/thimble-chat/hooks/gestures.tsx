// Stub of the gestures lane's module: the shared Target and onPointer, until the merge replaces this file. It turns a
// plain click on a mark or a record into the `card` message register.tsx already handles.
export type Target = {
  kind: 'card' | 'mark' | 'sentence' | 'citation' | 'row' | 'record' | 'node'
  ref?: string
  text?: string
  cardId?: string
  script?: string
}

export type PointerEv = {
  button: 'left' | 'middle' | 'right'
  shift: boolean
  ctrl: boolean
  alt: boolean
  type: 'press' | 'release' | 'double'
}

export function onPointer(target: Target, ev: PointerEv, ctx: unknown): void {
  const surface = ctx as { post?: (data: unknown) => void }
  if (!surface.post || ev.type !== 'press' || target.kind === 'card' || !target.ref) return
  const value = target.kind === 'mark' || target.kind === 'row'
  const cite = value && target.text ? `[[${target.text}|${target.ref}]]` : `[[${target.ref}]]`
  const opens = target.kind === 'record' || (target.kind === 'node' && !target.ref.startsWith('card:'))
  const secondary = ev.button !== 'left' || ev.shift || ev.ctrl || ev.alt
  surface.post({ type: 'card', card: target.cardId ?? '', kind: opens ? 'example' : 'bar', cite, open: target.ref, secondary })
}
