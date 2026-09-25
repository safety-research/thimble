// A document's sentences as plain prose where the editor is not shown (a slide, a story's beat, a page's claims): each
// sentence a span with `data-anchor` and `data-sid`, inline markdown rendered, citations as RefChip, and the tint of a
// shown comment's check (checkComments.ts passageFlags).
import type { ReactNode } from 'react'
import { GlyphCites, RefChip } from '../components/RefChip'
import type { WriteupSentence } from '../lib/types'
import type { Flag } from './checkComments'
import { parseInline, type InlineNode } from './inlineParse'
import { readableText } from './model'

/** Whether a node is a citation with no value, the chip that hides while the links are off. */
const bareRef = (n: InlineNode | undefined): boolean => n?.kind === 'ref' && !n.value

function inline(nodes: InlineNode[], ws: string, key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`
    switch (n.kind) {
      case 'text': {
        // the space before a bare citation hides with it (refchip.css refchip-gap), so the punctuation closes up
        const gap = bareRef(nodes[i + 1]) ? /\s+$/.exec(n.text) : null
        if (!gap) return n.text
        return (
          <span key={k}>
            {n.text.slice(0, gap.index)}
            <span className="refchip-gap">{gap[0]}</span>
          </span>
        )
      }
      case 'code':
        return <code key={k}>{n.text}</code>
      case 'ref':
        return <RefChip key={k} ref={n.ref} value={n.value || undefined} workspace={ws} cite />
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noreferrer">
            {inline(n.children, ws, `${k}.`)}
          </a>
        )
      case 'strong':
        return <strong key={k}>{inline(n.children, ws, `${k}.`)}</strong>
      case 'em':
        return <em key={k}>{inline(n.children, ws, `${k}.`)}</em>
    }
  })
}

export interface ProseProps {
  ws: string
  slug: string
  sentences: readonly WriteupSentence[]
  flags?: ReadonlyMap<string, Flag>
  className?: string
  /** off for text that is not the document as it stands (a past draft, History.tsx): no `data-anchor`, so the ⌘
   * pointer and a teleport do not take its sentences for the current ones */
  anchors?: boolean
}

/** Sentences run together as one paragraph, a space between them; a bare citation in them is its target's glyph alone
 * (components/RefChip GlyphCites). */
export function Prose({ ws, slug, sentences, flags, className, anchors = true }: ProseProps) {
  return (
    <GlyphCites.Provider value={true}>
      <p className={`wu-prose${className ? ` ${className}` : ''}`}>
        {sentences.map((s, i) => {
          const flag = flags?.get(s.id)
          return (
            <span key={s.id}>
              {i > 0 && ' '}
              <span
                className={['wu-s', flag ? 'wu-flag' : '', flag?.active ? 'wu-flag-active' : ''].filter(Boolean).join(' ')}
                style={flag ? ({ '--flag': flag.color } as React.CSSProperties) : undefined}
                data-anchor={anchors ? `report:${slug}#${s.id}` : undefined}
                data-anchor-text={anchors ? readableText(s.text) : undefined}
                data-sid={anchors ? s.id : undefined}
                data-cids={flag?.cids.join(' ')}
              >
                {inline(parseInline(s.text.trim()), ws)}
              </span>
            </span>
          )
        })}
      </p>
    </GlyphCites.Provider>
  )
}
