// The file reader's syntax highlighting (src/files/highlight.ts, with the languages of src/files/hljs.ts).
// highlight.js writes HTML, which the reader never inlines: it reads that HTML back into lines of tokens and draws
// them as text. The tokens must add up to the file's text, character for character and line for line, so the reader
// shows the file as it is and a citation's line number and column still point at the same text.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { highlightLines, languageOf, MAX_LINE, piecesOf, tokensOf } from '../../src/files/highlight.ts'
import hljs from '../../src/files/hljs.ts'

type Token = { text: string; role?: string | null }
const join = (lines: Token[][]) => lines.map((l) => l.map((t) => t.text).join('')).join('\n')
const roles = (line: Token[]) => line.filter((t) => t.role).map((t) => [t.text, t.role])

describe('highlighting', () => {
  test("a file's language from its name or its #! line; none for plain text", () => {
    const cases: [string, string | undefined, string | null][] = [
      ['tidepool/pool.py', undefined, 'python'],
      ['src/App.tsx', undefined, 'typescript'],
      ['board.jsonl', undefined, 'json'],
      ['config/run.yaml', undefined, 'yaml'],
      ['README.md', undefined, 'markdown'],
      ['docker/Dockerfile', undefined, 'dockerfile'],
      ['bin/tool', '#!/usr/bin/env python3', 'python'],
      ['bin/tool', undefined, null],
      ['requirements.txt', undefined, null],
    ]
    for (const [p, first, want] of cases) expect(languageOf(p, first), p).toBe(want)
  })

  test('nested spans, entities and line breaks read back as lines of tokens that add up to the text', () => {
    const html = '<span class="hljs-keyword">def</span> <span class="hljs-title function_">f</span>(<span class="hljs-params">a=<span class="hljs-number">1</span></span>):\n    <span class="hljs-keyword">return</span> <span class="hljs-string">f&quot;x {<span class="hljs-subst">a</span>} &lt;&amp;&gt;\ny&quot;</span>'
    const lines = tokensOf(html) as Token[][]
    expect(join(lines)).toBe('def f(a=1):\n    return f"x {a} <&>\ny"')
    expect(lines).toHaveLength(3)
    expect(roles(lines[0])).toEqual([['def', 'keyword'], ['f', 'function'], ['1', 'number']])
    expect(lines[2].map((t) => [t.text, t.role])).toEqual([['y"', 'string']])
  })

  test('markup in a file is read as text, never as HTML', () => {
    const text = '<script>alert(1)</script>\n<img src=x onerror=alert(2)> &amp; &lt;'
    let ran = 0
    for (const lang of ['xml', 'markdown', 'javascript']) {
      const lines = highlightLines(hljs, text, lang) as Token[][] | null
      if (!lines) continue
      ran++
      expect(join(lines), lang).toBe(text)
    }
    expect(ran).toBeGreaterThan(0)
  })

  test('source files in several languages add back up to themselves, line for line', () => {
    const files: [string, string][] = [
      ['src/files/highlight.ts', 'typescript'],
      ['src/components/Outputs.tsx', 'typescript'],
      ['../backend/app/refs.py', 'python'],
      ['../scripts/install.sh', 'bash'],
      ['package.json', 'json'],
    ]
    for (const [file, lang] of files) {
      const text = readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
      const lines = highlightLines(hljs, text, lang, Number.MAX_SAFE_INTEGER) as Token[][]
      expect(lines, file).not.toBeNull()
      expect(lines.length, file).toBe(text.split('\n').length)
      expect(join(lines), file).toBe(text)
    }
  })

  test('a JSON record has its keys as properties and its values as strings, numbers and keywords', () => {
    const line = JSON.stringify({ id: 1, author: 'agent-01', body: 'Review <pending> & "soon"', ok: true, cost: null })
    const [tokens, ...rest] = highlightLines(hljs, line, 'json', MAX_LINE) as Token[][]
    expect(rest).toHaveLength(0)
    expect(tokens.map((t) => t.text).join('')).toBe(line)
    expect(roles(tokens)).toEqual([
      ['"id"', 'property'], ['1', 'number'], ['"author"', 'property'], ['"agent-01"', 'string'], ['"body"', 'property'],
      ['"Review <pending> & \\"soon\\""', 'string'], ['"ok"', 'property'], ['true', 'keyword'], ['"cost"', 'property'], ['null', 'keyword'],
    ])
  })

  test('no highlighting for a language it does not have, or for text past the limit', () => {
    expect(highlightLines(hljs, 'x = 1', 'cobol')).toBeNull()
    expect(highlightLines(hljs, '{"a": "' + 'x'.repeat(50) + '"}', 'json', 20)).toBeNull()
  })

  test("a line's tokens cut where a label's segments start keep every character", () => {
    const tokens: Token[] = [{ text: '{' }, { text: '"body"', role: 'property' }, { text: ':' }, { text: '"a claim here"', role: 'string' }, { text: '}' }]
    const pieces = piecesOf(tokens as any, [0, 11, 16]) as (Token & { seg: number })[]
    expect(pieces.map((p) => p.text).join('')).toBe('{"body":"a claim here"}')
    expect(pieces.filter((p) => p.seg === 1).map((p) => p.text)).toEqual(['claim'])
  })
})
