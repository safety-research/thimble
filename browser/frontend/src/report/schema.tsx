// The editor's schema: the default paragraph, heading, list and quote blocks, the `figure` and `prompt` blocks, the
// `cite` inline atom that renders RefChip, and the toolbar's three text styles.
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs } from '@blocknote/core'
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react'
import { GlyphCites, RefChip } from '../components/RefChip'
import { FigureBlock } from './FigureBlock'
import { PROMPT_TYPE } from './model'
import { PromptBlock } from './PromptBlock'

/** A citation in the report's text: a cited number is the link's text, and a bare citation is its target's glyph alone,
 * its name in the hover (components/RefChip GlyphCites). */
export const Cite = createReactInlineContentSpec(
  { type: 'cite', propSchema: { value: { default: '' }, ref: { default: '' } }, content: 'none' } as const,
  {
    render: ({ inlineContent }) => (
      <GlyphCites.Provider value={true}>
        <RefChip ref={inlineContent.props.ref} value={inlineContent.props.value || undefined} compact cite />
      </GlyphCites.Provider>
    ),
  },
)

export const Figure = createReactBlockSpec(
  { type: 'figure', propSchema: { cell: { default: '' }, caption: { default: '' } }, content: 'none' } as const,
  {
    render: ({ block, editor }) => <FigureBlock block={block as unknown as { id: string; props: { cell: string; caption: string } }} editor={editor} />,
  },
)

/** A request to Claude placed in the report (the slash menu's Ask Claude here), about the passage above it. */
export const Prompt = createReactBlockSpec(
  { type: PROMPT_TYPE, propSchema: {}, content: 'none' } as const,
  {
    render: ({ block, editor }) => <PromptBlock block={block as unknown as { id: string }} editor={editor} />,
  },
)

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: defaultBlockSpecs.heading,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    quote: defaultBlockSpecs.quote,
    figure: Figure(),
    prompt: Prompt(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, cite: Cite },
  styleSpecs: { bold: defaultStyleSpecs.bold, italic: defaultStyleSpecs.italic, code: defaultStyleSpecs.code },
})

export type ReportPartialBlock = typeof schema.PartialBlock
