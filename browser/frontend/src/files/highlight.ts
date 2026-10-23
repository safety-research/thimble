// Syntax highlighting for the file reader. A file's language comes from its name or #! line (languageOf); highlight.js
// (files/hljs.ts, a lazily loaded chunk) turns the text into HTML, and tokensOf reads that back into lines of tokens
// with a role that styles/code.css colours. Code files are highlighted whole so multi-line strings and comments colour
// correctly; JSON lines files a line at a time. Text past the size limits stays plain.
import { createElement, Fragment, useEffect, useState, type ReactNode } from 'react'
import { loadChunk } from '../lib/chunkRecovery'

/** The roles a token can take, one colour each in styles/code.css (`.tok-<role>`). */
export type Role = 'keyword' | 'string' | 'number' | 'function' | 'type' | 'property' | 'comment' | 'meta' | 'heading' | 'emphasis' | 'strong' | 'link' | 'added' | 'removed'

export interface Token {
  text: string
  role?: Role
}

/** Characters of text highlighted at once: a larger code file stays plain rather than stall the page. */
export const MAX_TEXT = 1_000_000
/** Characters of one JSON line highlighted; a longer record stays plain. */
export const MAX_LINE = 200_000

const BY_EXTENSION: Record<string, string> = {
  py: 'python', pyi: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json', ipynb: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', scss: 'css',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', xhtml: 'xml', plist: 'xml',
  sql: 'sql',
  diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile',
  mk: 'makefile',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  rb: 'ruby',
}
const BY_NAME: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', '.env': 'ini', '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash', gemfile: 'ruby', rakefile: 'ruby' }
const BY_INTERPRETER: [RegExp, string][] = [
  [/\bpython[\d.]*\b/, 'python'],
  [/\b(?:ba|z|da|k)?sh\b/, 'bash'],
  [/\b(?:node|deno|bun)\b/, 'javascript'],
  [/\bruby\b/, 'ruby'],
]

/** The highlight.js language of a file: from its name (an extension, or a name such as Dockerfile), else from a #!
 * first line naming an interpreter; null when nothing names one (a plain text file, a README). */
export function languageOf(path: string, firstLine?: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  const dot = name.lastIndexOf('.')
  if (dot > 0 && BY_EXTENSION[name.slice(dot + 1)]) return BY_EXTENSION[name.slice(dot + 1)]
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile'
  if (firstLine?.startsWith('#!')) for (const [re, lang] of BY_INTERPRETER) if (re.test(firstLine)) return lang
  return null
}

// highlight.js's scopes and the role each takes. A scope with no entry takes its enclosing scope's role (params,
// punctuation, operators); `null` resets to the plain text colour (an interpolation inside a string).
const ROLES: Record<string, Role | null> = {
  keyword: 'keyword', 'selector-tag': 'keyword', bullet: 'keyword', 'template-tag': 'keyword', name: 'keyword', 'variable.language': 'keyword', doctag: 'keyword',
  string: 'string', char: 'string', code: 'string', 'meta.string': 'string', regexp: 'string',
  number: 'number', literal: 'number', symbol: 'number',
  title: 'function', 'title.function': 'function', 'title.function.invoke': 'function', 'selector-class': 'function', 'selector-id': 'function', 'selector-pseudo': 'function',
  meta: 'meta', 'meta.keyword': 'meta',
  'title.class': 'type', 'title.class.inherited': 'type', type: 'type', built_in: 'type', class: 'type',
  attr: 'property', attribute: 'property', property: 'property', 'selector-attr': 'property',
  comment: 'comment', quote: 'comment',
  section: 'heading',
  emphasis: 'emphasis',
  strong: 'strong',
  link: 'link',
  addition: 'added',
  deletion: 'removed',
  subst: null, 'template-variable': null,
}

/** The role of a highlight.js class attribute (`hljs-title function_`, `hljs-meta hljs-keyword`): its most specific
 * scope that has one; undefined when it has none (the enclosing role holds), null for a scope that resets it. */
export function roleOf(cls: string): Role | null | undefined {
  const parts = cls.split(/\s+/).filter(Boolean)
  const base = (parts[0] ?? '').replace(/^hljs-/, '')
  const subs = parts.slice(1).map((p) => p.replace(/^hljs-/, '').replace(/_+$/, ''))
  const names = [[base, ...subs].join('.'), ...subs.map((_, i) => [base, ...subs.slice(0, subs.length - 1 - i)].join('.'))]
  for (const n of names) if (n in ROLES) return ROLES[n]
  return undefined
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" }

/** highlight.js's HTML read back into lines of tokens: each token takes its innermost scope's role, adjacent tokens of
 * one role are joined, and lines split where the text breaks. */
export function tokensOf(html: string): Token[][] {
  const lines: Token[][] = [[]]
  const stack: (Role | null | undefined)[] = []
  const push = (text: string, role: Role | undefined) => {
    if (!text) return
    const line = lines[lines.length - 1]
    const last = line[line.length - 1]
    if (last && last.role === role) last.text += text
    else line.push(role ? { text, role } : { text })
  }
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(roleOf(m[1]))
    else if (m[2] === undefined) stack.pop()
    else {
      let role: Role | undefined
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === undefined) continue
        role = stack[i] ?? undefined
        break
      }
      const text = m[2].replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e])
      const parts = text.split('\n')
      parts.forEach((p, i) => {
        if (i > 0) lines.push([])
        push(p, role)
      })
    }
  }
  return lines
}

export type Hljs = (typeof import('./hljs'))['default']
let loaded: Hljs | null = null
let loading: Promise<Hljs> | null = null

function loadHljs(): Promise<Hljs> {
  loading ??= loadChunk(() => import('./hljs')).then((mod) => (loaded = mod.default))
  // a failure is not kept, so the next highlighted block fetches the chunk again
  loading.catch(() => {
    loading = null
  })
  return loading
}

/** highlight.js once its chunk has loaded (it starts loading when `want` is first true); null until then. */
export function useHljs(want: boolean): Hljs | null {
  const [hl, setHl] = useState<Hljs | null>(loaded)
  useEffect(() => {
    if (!want || hl) return
    let alive = true
    loadHljs()
      .then((h) => alive && setHl(() => h))
      .catch((e) => console.warn('the highlighter did not load', e))
    return () => {
      alive = false
    }
  }, [want, hl])
  return hl
}

/** The text's lines as tokens in `lang`; null when it is past the size limit, the language is not registered or the
 * tokens do not add back up to the text (the reader then shows it plain). */
export function highlightLines(hl: Hljs, text: string, lang: string, max = MAX_TEXT): Token[][] | null {
  if (text.length > max || !hl.getLanguage(lang)) return null
  try {
    const lines = tokensOf(hl.highlight(text, { language: lang, ignoreIllegals: true }).value)
    return lines.map((l) => l.map((t) => t.text).join('')).join('\n') === text ? lines : null
  } catch (e) {
    console.warn(`highlighting as ${lang} failed`, e)
    return null
  }
}

/** A piece of a line where a token and a label's segment overlap: the token's role, and the segment it lies in. */
export interface Piece {
  text: string
  role?: Role
  seg: number
}

/** A line's tokens cut at the boundaries of its label segments (both cover the same text), so a label's highlight and
 * the syntax colours can be drawn together: the segment wraps the colored pieces that fall in it. */
export function piecesOf(tokens: readonly Token[], segStarts: readonly number[]): Piece[] {
  const out: Piece[] = []
  let at = 0
  let seg = 0
  for (const t of tokens) {
    let i = 0
    while (i < t.text.length) {
      while (seg + 1 < segStarts.length && segStarts[seg + 1] <= at) seg++
      const next = seg + 1 < segStarts.length ? segStarts[seg + 1] : Infinity
      const take = Math.min(t.text.length - i, next - at)
      out.push({ text: t.text.slice(i, i + take), role: t.role, seg })
      i += take
      at += take
    }
  }
  return out
}

/** Tokens as coloured spans (plain text for a token with no role). */
export function renderTokens(tokens: readonly { text: string; role?: Role }[]): ReactNode {
  return createElement(
    Fragment,
    null,
    tokens.map((t, i) => (t.role ? createElement('span', { key: i, className: `tok-${t.role}` }, t.text) : t.text)),
  )
}
