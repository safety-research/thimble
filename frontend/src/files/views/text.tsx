// The Rendered view: line-numbered text; a markdown file renders as a document unless a ref points into it, its fenced
// code blocks syntax-coloured in the language the fence names (components/Code.tsx MarkdownCode, as in the chat). Each
// rendered block carries `data-anchor="<path>#L<n>"` for its first source line, so the ⌘ pointer lands on the line. A
// front matter (YAML between `---` lines, TOML between `+++` lines) shows folded above the document, its fields one per
// row when opened.
import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Root } from 'hast'
import { Button } from '../../components/Button'
import { MarkdownCode } from '../../components/Code'
import { MdImage } from '../../components/MdImage'
import { rehypeNumericCells } from '../../lib/markdownCells'
import type { SourceKind, SourceRecord } from '../../lib/types'
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

/** lines a front matter may take before its closing fence (backend transcripts.FRONT_MATTER_MAX) */
const FRONT_MATTER_MAX = 400

/** How many of a file's first lines its front matter takes, both fences counted; 0 for a file with none. Pure. */
export function frontMatterLines(lines: string[]): number {
  const fence = lines[0]?.replace(/^\uFEFF/, '').trim()
  if (fence !== '---' && fence !== '+++') return 0
  for (let i = 1; i < Math.min(lines.length, FRONT_MATTER_MAX); i++) {
    const t = lines[i].trim()
    if (t === fence || (fence === '---' && t === '...')) return i + 1
  }
  return 0
}

export interface MetaField {
  key: string
  /** a value on one line: a scalar as written, a list of scalars joined with commas, a folded block's lines joined */
  value?: string
  /** a nested value as written, its indent taken off */
  block?: string
}

const unquote = (v: string) => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v)

/** The top-level fields of a front matter's lines (its fences left out), as written: YAML `key: value` or TOML
 * `key = value`, with the indented lines under a key as its value. Pure. */
export function metaFields(lines: string[]): MetaField[] {
  const out: MetaField[] = []
  let cur: { key: string; head: string; body: string[] } | null = null
  const flush = () => {
    if (!cur) return
    const body = cur.body.filter((l) => l.trim())
    const head = cur.head.trim()
    if (!body.length) out.push({ key: cur.key, value: unquote(head) })
    else if (/^[>|][+-]?$/.test(head)) out.push({ key: cur.key, value: body.map((l) => l.trim()).join(head.startsWith('>') ? ' ' : '\n') })
    else if (!head && body.every((l) => /^\s*-\s+[^:{[]+$/.test(l))) out.push({ key: cur.key, value: body.map((l) => unquote(l.replace(/^\s*-\s+/, '').trim())).join(', ') })
    else {
      const indent = Math.min(...body.map((l) => l.length - l.trimStart().length))
      out.push({ key: cur.key, block: [head, ...body.map((l) => l.slice(indent))].filter(Boolean).join('\n') })
    }
    cur = null
  }
  for (const line of lines) {
    const m = /^([^\s#:=][^:=]*?)\s*(?::(?=\s|$)|=)\s?(.*)$/.exec(line)
    if (m && !/^\s/.test(line) && !line.startsWith('- ')) {
      flush()
      cur = { key: m[1], head: m[2], body: [] }
    } else if (cur) cur.body.push(line)
  }
  flush()
  return out
}

const lineText = (rec: SourceRecord) => String(rec.record?.text ?? rec.blocks[0]?.text ?? '')

/** A front matter, folded: a button naming how many fields it holds, which opens them one per row. */
function FrontMatter({ path, records }: { path: string; records: SourceRecord[] }) {
  const [open, setOpen] = useState(false)
  const fields = useMemo(() => metaFields(records.slice(1, -1).map(lineText)), [records])
  return (
    <div className="reader-md-meta" data-anchor={`${path}#L${records[0].line}`}>
      <Button size="sm" icon={open ? 'chevron-down' : 'chevron-right'} className="reader-md-meta-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Metadata
        <span className="dim">
          {fields.length} {fields.length === 1 ? 'field' : 'fields'}
        </span>
      </Button>
      {open && (
        <dl className="reader-md-meta-fields">
          {fields.map((f, i) => (
            <div key={i} className="reader-md-meta-field">
              <dt className="mono">{f.key}</dt>
              <dd>{f.block != null ? <pre>{f.block}</pre> : f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
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
  const meta = useMemo(() => (md && records[0]?.line === 1 ? frontMatterLines(records.map(lineText)) : 0), [md, records])
  const body = useMemo(() => records.slice(meta), [records, meta])
  const rehype = useMemo(() => [rehypeBlockAnchors(path, body.map((r) => r.line)), rehypeNumericCells], [path, body])
  return (
    <div className="reader-lines" ref={rootRef}>
      {md && !raw ? (
        <div className="reader-md reader-md-file" data-anchor={path} data-anchor-text={path}>
          {meta > 0 && <FrontMatter path={path} records={records.slice(0, meta)} />}
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehype} components={MD_COMPONENTS}>
            {body.map(lineText).join('\n')}
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
