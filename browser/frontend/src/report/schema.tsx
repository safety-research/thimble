// The editor's schema: the default paragraph, heading and list blocks, the `figure` and `prompt` blocks, the `cite`
// inline atom that renders RefChip, and the toolbar's three text styles.
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

/** `mode`: `write`, a request for the writer about the passage above (the slash menu's Prompt), or `card`, a request
 * to main whose card takes the block's place once made (/card). `sent`: the text of a block sent to main with ⌘↵,
 * shown working until its card comes or main's turn ends. */
export const Prompt = createReactBlockSpec(
  { type: PROMPT_TYPE, propSchema: { mode: { default: 'write', values: ['write', 'card'] }, sent: { default: '' } }, content: 'none' } as const,
  {
    render: ({ block, editor }) => <PromptBlock block={block as unknown as { id: string; props: { mode: 'write' | 'card'; sent: string } }} editor={editor} />,
  },
)

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: defaultBlockSpecs.heading,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    figure: Figure(),
    prompt: Prompt(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, cite: Cite },
  styleSpecs: { bold: defaultStyleSpecs.bold, italic: defaultStyleSpecs.italic, code: defaultStyleSpecs.code },
})

export type ReportEditor = typeof schema.BlockNoteEditor
export type ReportPartialBlock = typeof schema.PartialBlock
