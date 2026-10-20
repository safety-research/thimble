// A story's blocks as its editor (StoryEditor.tsx) shows them between edits: text, a list, a headline, a quote, a rule,
// a picture of a card, and a section's card in its step (backend story.step_of).
import { useEffect, useRef } from 'react'
import type { WriteupFigure, WriteupParagraph, WriteupSentence } from '../lib/types'
import type { Flag } from './checkComments'
import { FigureView } from './FigureBlock'
import { Prose } from './Prose'
import { stepMatches, type StoryBlock } from './storyModel'

/** The sentences a block shows: its stored paragraph's while the block's text is the stored text, else the text as
 * typed, one sentence per item of a list. */
export function sentencesOf(block: StoryBlock, stored: WriteupParagraph | undefined): WriteupSentence[] {
  const typed = block.type === 'bullets' ? block.text.split('\n').map((l) => l.trim()).filter(Boolean) : [block.text.trim()].filter(Boolean)
  const held = (stored?.sentences ?? []).filter((s) => s.text.trim())
  const same = held.length > 0 && (block.type === 'bullets' ? held.map((s) => s.text.trim()).join('\n') : held.map((s) => s.text.trim()).join(' ')) === typed.join(block.type === 'bullets' ? '\n' : ' ')
  if (same) return held
  return typed.map((text, i) => ({ id: i ? `${block.id}-${i}` : block.id, text, refs: [], tags: [] }))
}

/** One block as it reads: prose, a list, a headline, a quote and its speaker, a rule, a card as the report shows it, or
 * a picture of a card (the card drawn alone and taking no pointer) with its caption. A callout reads as prose. */
export function ReadBlock({ ws, slug, block, sentences, flags }: { ws: string; slug: string; block: StoryBlock; sentences: readonly WriteupSentence[]; flags?: ReadonlyMap<string, Flag> }) {
  const prose = (className?: string) => sentences.length > 0 && <Prose ws={ws} slug={slug} sentences={sentences} flags={flags} className={className} />
  switch (block.type) {
    case 'bullets':
      return (
        <ul className="wu-sb-list">
          {sentences.map((s) => (
            <li key={s.id}>
              <Prose ws={ws} slug={slug} sentences={[s]} flags={flags} />
            </li>
          ))}
        </ul>
      )
    case 'headline':
      return <div className="wu-sb-headline">{prose()}</div>
    case 'quote':
      return (
        <blockquote className="wu-sb-quote">
          {prose()}
          {block.speaker && <span className="wu-sb-who">{block.speaker}</span>}
        </blockquote>
      )
    case 'divider':
      return <hr className="wu-sb-rule" />
    case 'card':
      return block.cell ? <FigureView ws={ws} figure={{ id: block.id, cell: block.cell, caption: block.caption ?? '' }} /> : null
    case 'image':
      return block.cell ? <CardImage ws={ws} block={block} /> : null
    default:
      return <div className="wu-sb-text">{prose()}</div>
  }
}

/** A picture of a card: the card's chart, table or body drawn alone, taking no pointer, with the caption under it. */
export function CardImage({ ws, block }: { ws: string; block: StoryBlock }) {
  return (
    <figure className="wu-sb-image" data-anchor={block.cell} data-anchor-text={block.caption ?? ''}>
      <div className="wu-sb-image-art" inert>
        <FigureView ws={ws} figure={{ id: block.id, cell: block.cell ?? '', caption: block.caption ?? '' }} bare />
      </div>
      {block.caption && <figcaption className="wu-sb-image-cap">{block.caption}</figcaption>}
    </figure>
  )
}

/** The items a step can highlight: a table's rows, a timeline's events, a diagram's nodes. */
const STEP_ITEMS = 'tbody tr, .canvas-tl-row, .canvas-diagram-node'

/** An element's text with a space between its text nodes, so a row's cells read as words apart. */
function wordsOf(el: Element): string {
  const out: string[] = []
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n.textContent ?? '')
  return out.join(' ')
}

/** A section's card in its step: the rows, events or nodes the step names lit and the rest faded, or its callout over
 * the card. */
export function StepFigure({ ws, figure }: { ws: string; figure: WriteupFigure }) {
  const box = useRef<HTMLDivElement | null>(null)
  const terms = figure.highlight ?? []
  const key = terms.join('\u0000')
  useEffect(() => {
    const el = box.current
    if (!el) return
    const apply = () => {
      let lit = 0
      for (const it of Array.from(el.querySelectorAll(STEP_ITEMS))) {
        const on = terms.length > 0 && stepMatches(wordsOf(it), terms)
        it.classList.toggle('wu-step-on', on)
        if (on) lit++
      }
      // a term that names a table's column lights the column: its header and its cell in every row
      const cols = new Set<number>()
      for (const table of Array.from(el.querySelectorAll('table'))) {
        const heads = Array.from(table.querySelectorAll('thead tr:last-child > *'))
        heads.forEach((th, i) => terms.length > 0 && stepMatches(wordsOf(th), terms) && cols.add(i))
        for (const row of Array.from(table.querySelectorAll('tr'))) {
          Array.from(row.children).forEach((cell, i) => cell.classList.toggle('wu-step-col', cols.has(i)))
        }
      }
      el.classList.toggle('wu-step-lit', lit > 0)
      el.classList.toggle('wu-step-cols', cols.size > 0 && lit === 0)
      // a lit column past the table's visible width comes into view, the table scrolling sideways inside its box
      const head = el.querySelector<HTMLElement>('thead .wu-step-col')
      let box = head?.parentElement ?? null
      while (box && box !== el && !(box.scrollWidth > box.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(box).overflowX))) box = box.parentElement
      if (head && box && box !== el) {
        const left = head.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft
        if (left < box.scrollLeft || left + head.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollTo({ left: Math.max(0, left - 48), behavior: 'smooth' })
      }
    }
    apply()
    // the card is read after the figure mounts, and a table can show more rows: the step follows what is drawn
    const mo = new MutationObserver(apply)
    mo.observe(el, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="wu-step" ref={box}>
      {figure.callout && (
        <div className="wu-step-callout" key={figure.callout}>
          {figure.callout}
        </div>
      )}
      <FigureView ws={ws} figure={figure} bare />
    </div>
  )
}
