// A name cut in its middle where its row is too narrow for it: its start gives way first, ending in `…`, and its end
// stays whole, so names that share a long start still differ where they differ at their end (the Files tree's
// `sweep1-fable-emergent_prs` and `sweep1-fable-emergent_prs_issues`). The whole name shows in the one tooltip. The
// start is cut to the characters that fit, measured in the name's font, so the `…` meets the end with no gap; where
// nothing can be measured (no layout yet), the start's own ellipsis cuts it.
import { useLayoutEffect, useRef, useState } from 'react'
import { useTooltip } from './Tooltip'

/** what parts a name's words: a dash, an underscore, a dot, a space, a slash */
const SEP = /[-_. /]/
/** the fewest characters the end keeps, its separator with them */
const WORD_MIN = 4
/** a file name this long or shorter keeps its folder's last word with it in a path's end */
const SHORT_FILE = 16

/** The last word of one part of a path, with the separator before it, at least WORD_MIN characters: `_issues` of
 *  `sweep1-fable-emergent_prs_issues`, `_prs` of `sweep1-fable-emergent_prs`; an extension with the word before it
 *  (`-name.jsonl`); the whole part when no separator parts it. */
function lastWord(s: string): string {
  for (let i = s.length - WORD_MIN; i > 0; i--) {
    if (!SEP.test(s[i]!)) continue
    if (s[i] !== '.') return s.slice(i)
    // an extension alone tells no two files apart
    for (let j = i - 1; j > 0; j--) if (SEP.test(s[j]!)) return s.slice(j)
    return s
  }
  return s
}

/** A name as the start that gives way and the end that stays (`['sweep1-fable-emergent_prs', '_issues']`): the end is
 *  the name's last word, and in a path with a short file name the folder's last word and the file's name
 *  (`_issues/board.jsonl`); the start is '' for a name that is all end. Pure. */
export function midSplit(name: string): [string, string] {
  const slash = name.lastIndexOf('/', name.length - 2)
  let end: string
  if (slash > 0) {
    const file = name.slice(slash + 1)
    const dir = name.slice(0, slash)
    end = file.length <= SHORT_FILE ? `${lastWord(dir.slice(dir.lastIndexOf('/') + 1))}/${file}` : lastWord(file)
  } else end = lastWord(name)
  return end.length >= name.length ? ['', name] : [name.slice(0, name.length - end.length), end]
}

/** The most characters of `start` that fit with `…` in `room` px, by `width` (a text's width in the name's font); null
 *  when the whole start fits. Pure. */
export function keptChars(start: string, room: number, width: (s: string) => number): number | null {
  const chars = [...start]
  if (width(start) <= room + 0.5) return null
  let lo = 0
  let hi = chars.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (width(`${chars.slice(0, mid).join('')}…`) <= room) lo = mid
    else hi = mid - 1
  }
  return lo
}

let canvas: HTMLCanvasElement | null = null

/** The start's characters that fit beside the end in the box, measured in the box's font; null when they all fit or
 *  the box has no layout to measure. */
function fitStart(box: HTMLElement, end: HTMLElement | null, start: string): number | null {
  if (box.clientWidth <= 0) return null
  canvas ??= document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // the longhands: the computed `font` shorthand is '' where a longhand has no place in it (Chrome)
  const st = getComputedStyle(box)
  ctx.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`
  if ('letterSpacing' in ctx) ctx.letterSpacing = st.letterSpacing
  return keptChars(start, box.clientWidth - (end?.offsetWidth ?? 0), (s) => ctx.measureText(s).width)
}

/** A name in a row that may be too narrow for it, cut in its middle (midSplit), the whole name in its tooltip. It takes
 *  the room its row leaves it. `tip`: what its tooltip says in place of the name, null for none (a row whose own
 *  tooltip names it whole). */
export function MidCut({ text, className, tip: tipText = text }: { text: string; className?: string; tip?: string | null }) {
  const { props, tip } = useTooltip(tipText, undefined, 'start')
  const [start, end] = midSplit(text)
  const box = useRef<HTMLSpanElement>(null)
  const endEl = useRef<HTMLSpanElement>(null)
  // the start's characters kept before its `…`; null for the whole start
  const [kept, setKept] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !start) return
    let live = true
    const fit = () => live && setKept(fitStart(el, endEl.current, start))
    fit()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    ro?.observe(el)
    // a web font that loads after the first measure changes the widths
    document.fonts?.ready.then(fit).catch(() => undefined)
    return () => {
      live = false
      ro?.disconnect()
    }
  }, [start, end])
  return (
    <span ref={box} className={`midcut${className ? ` ${className}` : ''}`} {...props}>
      {start ? <span className="midcut-start">{kept === null ? start : `${[...start].slice(0, kept).join('')}…`}</span> : null}
      <span ref={endEl} className="midcut-end">
        {end}
      </span>
      {tip}
    </span>
  )
}
