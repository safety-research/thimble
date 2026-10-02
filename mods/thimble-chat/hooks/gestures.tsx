// What a press on anything drawn does: the regions (para.tsx, card.tsx) say what is under the pointer and hand the
// event here. This is the smallest stand-in: a press posts the target to the hooks module (register.tsx `gesture`).
export type Target = {
  kind: 'card' | 'mark' | 'sentence' | 'citation' | 'row' | 'record' | 'node'
  ref?: string
  text?: string
  cardId?: string
  script?: string
}

export type PointerEv = { button: 'left' | 'middle' | 'right'; shift: boolean; ctrl: boolean; alt: boolean; type: 'press' | 'release' | 'double' }

export function onPointer(target: Target, ev: PointerEv, ctx: unknown): void {
  if (ev.type !== 'press') return
  const t: Record<string, string> = { kind: target.kind }
  for (const k of ['ref', 'text', 'cardId', 'script'] as const) if (typeof target[k] === 'string') t[k] = target[k]!
  ;(ctx as { post: (d: unknown) => void }).post({ type: 'gesture', target: t, ev: { ...ev } })
}
