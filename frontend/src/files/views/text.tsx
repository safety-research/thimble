// The Rendered view: line-numbered text; a markdown file renders as a document, its fenced code blocks syntax-coloured
// in the language the fence names (components/Code.tsx MarkdownCode, as in the chat). Each rendered block carries
// `data-anchor="<path>#L<n>"` for its first source line, so the ⌘ pointer lands on the line. A ref into a markdown file
// opens the document at the block that holds its line, with an edge beside the block and the words a span ref quotes
// highlighted (.hl), scrolled into view (bug hunt L11: the file showed its source with line numbers, as Raw does). A
// front matter (YAML between `---` lines, TOML between `+++` lines) shows folded above the document, its fields one per
// row when opened.
import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, ElementContent, Root, Text } from 'hast'
import { Button } from '../../components/Button'
import { MarkdownCode } from '../../components/Code'
import { MdImage } from '../../components/MdImage'
import { rehypeNumericCells } from '../../lib/markdownCells'
import { plainMd } from '../../lib/mdPlain'
import { findQuote } from '../../lib/quoteFind'
import type { SourceKind, SourceRecord } from '../../lib/types'
import { BlockEl, citedQuote, LineRow, useTarget, type Target, type ViewDef, type ViewProps } from './common'

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

/** Words written in Markdown, rendered as a markdown file is (a transcript's system prompt, a reply). */
export function MarkdownText({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} rehypePlugins={[rehypeNumericCells]} components={MD_COMPONENTS}>
      {text}
    </Markdown>
  )
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

/** The words `quote` in the hast element `el`, each text they cross cut where they start and end and the part inside
 * wrapped in a `.hl` span; as written, else without its markdown syntax (`**P6:**` reads `P6:`). Code is not searched,
 * since its block draws its own text. Whether the words were found. */
export function markQuoteIn(el: Element, quote: string): boolean {
  const texts: { parent: Element; node: Text; from: number }[] = []
  let full = ''
  const walk = (p: Element) => {
    for (const c of p.children) {
      if (c.type === 'text') {
        texts.push({ parent: p, node: c, from: full.length })
        full += c.value
      } else if (c.type === 'element' && c.tagName !== 'code') walk(c)
    }
  }
  walk(el)
  const at = findQuote(full, quote) ?? findQuote(full, plainMd(quote))
  if (!at) return false
  for (const t of texts) {
    const v = t.node.value
    const i = Math.max(at[0], t.from) - t.from
    const j = Math.min(at[1], t.from + v.length) - t.from
    if (j <= i) continue
    const parts: ElementContent[] = []
    if (i > 0) parts.push({ type: 'text', value: v.slice(0, i) })
    parts.push({ type: 'element', tagName: 'span', properties: { className: ['hl'] }, children: [{ type: 'text', value: v.slice(i, j) }] })
    if (j < v.length) parts.push({ type: 'text', value: v.slice(j) })
    t.parent.children.splice(t.parent.children.indexOf(t.node), 1, ...parts)
  }
  return true
}

/** rehype plugin: the top-level block the target's line is in (the last that starts on or before it; `lines` maps the
 * joined text's line index to the record's line number) carries `reader-md-target`, and the words `quote` in it are
 * highlighted (markQuoteIn). */
export function rehypeTarget(lines: number[], target: Target | null, quote: string | null) {
  return () => (tree: Root) => {
    if (!target) return
    let at: Element | null = null
    for (const child of tree.children) {
      if (child.type !== 'element' || !child.position) continue
      if ((lines[child.position.start.line - 1] ?? child.position.start.line) > target.line) break
      at = child
    }
    if (!at) return
    const cls = at.properties.className
    at.properties.className = [...(Array.isArray(cls) ? cls : cls != null ? [cls] : []), 'reader-md-target']
    if (quote) markQuoteIn(at, quote)
  }
}

/** lines a front matter may take before its closing fence (backend transcripts.FRONT_MATTER_MAX) */
const FRONT_MATTER_MAX = 400

/** the first line of a front matter: a YAML `key:`, a TOML `key =` or a TOML `[table]` (backend transcripts._FRONT_KEY) */
const FRONT_KEY = /^(?:["']?[\p{L}_][\p{L}\p{N}_ .-]*["']?\s*(?::(?=\s|$)|=)|\[[^\]\n]+\]\s*$)/u

/** How many of a file's first lines its front matter takes, both fences counted; 0 for a file with none, or whose first
 * line inside is no key, as a paragraph between two rules. Pure. */
export function frontMatterLines(lines: string[]): number {
  const fence = lines[0]?.replace(/^\uFEFF/, '').trim()
  if (fence !== '---' && fence !== '+++') return 0
  const first = lines.slice(1, FRONT_MATTER_MAX).find((l) => l.trim() && !l.trimStart().startsWith('#')) ?? ''
  if (!FRONT_KEY.test(first)) return 0
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
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records])
  const meta = useMemo(() => (md && records[0]?.line === 1 ? frontMatterLines(records.map(lineText)) : 0), [md, records])
  const body = useMemo(() => records.slice(meta), [records, meta])
  const quote = useMemo(() => citedQuote(records, target), [records, target])
  const rehype = useMemo(() => {
    const lines = body.map((r) => r.line)
    return [rehypeBlockAnchors(path, lines), rehypeTarget(lines, target, quote), rehypeNumericCells]
  }, [path, body, target, quote])
  // the block a ref names comes into view once it is drawn, its quoted words in the middle (a block taller than the view
  // from its start); once per ref, so the analyst's scroll is kept as more lines load
  const placed = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!md || !target || placed.current === targetRef) return
    const el = rootRef.current?.querySelector<HTMLElement>('.reader-md-target')
    if (!el) return
    placed.current = targetRef
    const hl = el.querySelector<HTMLElement>('.hl')
    const room = rootRef.current?.closest<HTMLElement>('.reader-body')?.clientHeight ?? window.innerHeight
    ;(hl ?? el).scrollIntoView({ block: !hl && el.getBoundingClientRect().height > room ? 'start' : 'center' })
  }, [md, target, targetRef, records])
  return (
    <div className="reader-lines" ref={rootRef}>
      {md ? (
        <div className="reader-md reader-md-file" data-anchor={path} data-anchor-text={path}>
          {meta > 0 && <FrontMatter path={path} records={records.slice(0, meta)} />}
          <Markdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} rehypePlugins={rehype} components={MD_COMPONENTS}>
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
