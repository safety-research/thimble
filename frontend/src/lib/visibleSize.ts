// The box an element has on screen, tracked, so a chart waits for a box and re-fits when the box changes.
import { useLayoutEffect, useState, type RefObject } from 'react'

export type Size = { width: number; height: number }
export const NO_SIZE: Size = { width: 0, height: 0 }

type Entry = { contentRect: { width: number; height: number } }
export type SizeObserverCtor = new (cb: (entries: Entry[]) => void) => { observe(el: Element): void; disconnect(): void }

/** Report `el`'s box to `onSize` when it changes: nothing while it never had one, then every distinct size, 0x0 too. */
export function watchVisibleSize(el: Element, onSize: (s: Size) => void, Observer: SizeObserverCtor | undefined = globalThis.ResizeObserver): () => void {
  let last: Size | null = null
  const report = (width: number, height: number) => {
    const w = Math.round(width)
    const h = Math.round(height)
    if (last === null && w === 0 && h === 0) return
    if (last && last.width === w && last.height === h) return
    last = { width: w, height: h }
    onSize(last)
  }
  if (!Observer) {
    report(el.clientWidth, el.clientHeight)
    return () => {}
  }
  const ro = new Observer((entries) => {
    for (const e of entries) report(e.contentRect.width, e.contentRect.height)
  })
  ro.observe(el)
  return () => ro.disconnect()
}

export function useVisibleSize<T extends Element>(ref: RefObject<T | null>): Size {
  const [size, setSize] = useState<Size>(NO_SIZE)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    return watchVisibleSize(el, setSize)
  }, [ref])
  return size
}
