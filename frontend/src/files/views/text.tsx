// The Rendered view: line-numbered text; a markdown file renders as a document unless a ref points into it, its fenced
// code blocks syntax-coloured in the language the fence names (components/Code.tsx MarkdownCode, as in the chat). Each
// rendered block carries `data-anchor="<path>#L<n>"` for its first source line, so the ⌘ pointer lands on the line.
import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Root } from 'hast'
import { MarkdownCode } from '../../components/Code'
import { MdImage } from '../../components/MdImage'
import { rehypeNumericCells } from '../../lib/markdownCells'
import type { SourceKind } from '../../lib/types'
import { BlockEl, LineRow, targetOf, useTarget, type ViewDef, type ViewProps } from './common'

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path)

const MD_COMPONENTS: Components = {
  table: ({ node: _node, ...rest }) => (
    <div className="reader-table-wrap reader-md-table">
      <table {...rest} />
    </div>
  ),
  code: MarkdownCode,
  // a corpus's markdown loads no image from another host
  img: MdImage,
}

/** rehype plugin: a top-level block gets `data-anchor` from the source line it starts on (`lines` maps the joined text's
 * line index to the record's line number). */
export function rehypeBlockAnchors(path: string, lines: number[]) {
  return () => (tree: Root) => {
    for (const child of tree.children) {
      if (child.type !== 'element') continue
      const start = child.position?.start.line
      if (!start) continue
      const line = lines[start - 1] ?? start
      child.properties.dataAnchor = `${path}#L${line}`
    }
  }
}

export function TextView({ path, page, targetRef }: ViewProps) {
  const records = page.records
  const md = isMarkdown(path)
  const [raw, setRaw] = useState(() => !md || targetOf(targetRef, path) != null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records, raw])
  useEffect(() => {
    if (target) setRaw(true)
  }, [target])
  const lineText = (rec: (typeof records)[number]) => String(rec.record?.text ?? rec.blocks[0]?.text ?? '')
  const rehype = useMemo(() => [rehypeBlockAnchors(path, records.map((r) => r.line)), rehypeNumericCells], [path, records])
  return (
    <div className="reader-lines" ref={rootRef}>
      {md && !raw ? (
        <div className="reader-md reader-md-file" data-anchor={path} data-anchor-text={path}>
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehype} components={MD_COMPONENTS}>
            {records.map(lineText).join('\n')}
          </Markdown>
        </div>
      ) : (
        records.map((rec) => (
          <LineRow key={rec.line} path={path} line={rec.line} target={target} hit={hit} className="reader-textline">
            {rec.blocks.length ? rec.blocks.map((b, k) => <BlockEl key={k} block={b} path={path} line={rec.line} index={k} target={target} hit={hit} />) : <BlockEl block={{ kind: 'text', text: lineText(rec) }} path={path} line={rec.line} index={0} target={target} hit={hit} />}
          </LineRow>
        ))
      )}
    </div>
  )
}

function match(path: string, kind: SourceKind): number {
  return kind === 'prompt' || /\.(md|markdown|txt)$/i.test(path) ? 0.9 : 0
}

const def: ViewDef = { type: 'text', title: 'Rendered', match, component: TextView }
export default def
