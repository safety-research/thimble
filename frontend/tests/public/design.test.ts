// The design system's rules, read from the source, and its small pure helpers. The rules: a colour is a token of
// src/styles/tokens.css (an ink tint is `rgba(var(--ink-rgb), a)`), text is set in the app's two faces through their
// tokens, in weights 400 and 500 (600 only for a report's title and section heads), the one drop shadow is the float's,
// a text field has a placeholder only where the line says what the field is for, the UI carries no helper text, and
// an icon-only control is named in the one tooltip rather than the browser's title. A test here fails with the file
// and the line that broke a rule, so a change that means to break it changes the rule here, on purpose.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { groupState, groupTools, toolGroupName, toolMeta, toolSteps, type Row } from '../../src/chat/model.ts'
import { placeAside, placeBeside } from '../../src/components/Menu.tsx'
import { KNOWN_MODELS, modelChoices, modelLabel } from '../../src/lib/models.ts'
import { ACCENTS, paperScheme, PAPERS, readAccent, readPaper } from '../../src/lib/theme.ts'
import type { Settings } from '../../src/lib/types.ts'
import { shortPath } from '../../src/lib/workspace.ts'
import { describe as describeChain } from '../../src/pointer/capture.ts'

const SRC = path.resolve(__dirname, '../../src')
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8')

/** Every file under src whose name ends in one of `exts`, with its path relative to src (forward slashes). */
function sources(...exts: string[]): { file: string; text: string }[] {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : exts.some((x) => e.name.endsWith(x)) ? [path.join(d, e.name)] : []))
  return walk(SRC).map((f) => ({ file: path.relative(SRC, f).split(path.sep).join('/'), text: readFileSync(f, 'utf8') }))
}

/** A stylesheet's declarations with their line numbers, comments removed (a comment keeps its lines). */
function declarations(css: string): { line: number; prop: string; value: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const out: { line: number; prop: string; value: string }[] = []
  for (const m of text.matchAll(/([-\w]+)\s*:\s*([^;{}]+);/g)) out.push({ line: text.slice(0, m.index).split('\n').length, prop: m[1], value: m[2].trim() })
  return out
}

/** The selector of the rule that holds line `line` of a stylesheet. */
function selectorAt(css: string, line: number): string {
  const before = css.split('\n').slice(0, line).join('\n')
  const open = before.lastIndexOf('{')
  return before.slice(before.lastIndexOf('}', open) + 1, open).trim()
}

/** A comma-separated CSS value split at its top-level commas. */
function layers(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  return [...out, cur.trim()]
}

const STYLES = sources('.css').filter((f) => f.file.startsWith('styles/'))

describe('the design rules, read from the source', () => {
  test('a colour outside tokens.css is a token or an ink tint, never a colour of its own', () => {
    const HEX = /#[0-9a-fA-F]{3,8}\b/
    // a colour function with its own numbers; rgba(var(--ink-rgb), a) is the ink tint the tokens are built from
    const FN = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab)\((?!\s*var\(--ink-rgb\))/
    const NAMED = /(?<![-\w])(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|silver)(?![-\w])/
    // the switch's knob is white on every accent, as the switch is drawn; a mask's colour is only its alpha
    const ALLOWED = [{ file: 'styles/components.css', text: '.switch.on .switch-knob' }]
    const found: string[] = []
    for (const { file, text } of STYLES) {
      if (file === 'styles/tokens.css') continue
      for (const d of declarations(text)) {
        // an image in url() (a mask's glyph) draws no colour of its own
        const value = d.value.replace(/url\((?:[^()]|\([^()]*\))*\)/g, 'url()')
        if (/mask/.test(d.prop) || !(HEX.test(value) || FN.test(value) || NAMED.test(value))) continue
        if (ALLOWED.some((a) => a.file === file && selectorAt(text, d.line).startsWith(a.text))) continue
        found.push(`${file}:${d.line}: ${d.prop}: ${d.value}`)
      }
    }
    // in the code, a colour is a token too; the files that hold colours as values say why in their own header: the
    // accents' swatches (theme.ts), a chart's palette, which Vega takes as values (vizTheme.ts), and the colours
    // matplotlib writes, each matched to its token (svg.ts)
    const CODE_COLOURS = new Set(['lib/theme.ts', 'lib/vizTheme.ts', 'lib/svg.ts'])
    for (const { file, text } of sources('.ts', '.tsx')) {
      if (CODE_COLOURS.has(file)) continue
      text.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '')
        if (HEX.test(code.replace(/&#\w+;|#L\d+|#[a-z][\w-]*[?/]/g, '')) || FN.test(code)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`)
      })
    }
    expect(found, 'a colour takes a token of tokens.css; a tint of ink is rgba(var(--ink-rgb), a)').toEqual([])
  })

  test("text is set in the app's two faces through their tokens, and no stylesheet loads a face from another host", () => {
    const found: string[] = []
    for (const { file, text } of STYLES) {
      if (file === 'styles/tokens.css') continue
      for (const d of declarations(text)) {
        if (d.prop === 'font-family' || d.prop === '--bn-font-family') {
          if (!/^(?:var\(--font-(?:body|mono|prose)\)|inherit)$/.test(d.value)) found.push(`${file}:${d.line}: ${d.prop}: ${d.value}`)
        }
        if (d.prop === 'font' && !/^(?:inherit|var\(--type-[\w-]+\))$/.test(d.value) && !/var\(--font-(?:body|mono|prose)\)$/.test(d.value)) found.push(`${file}:${d.line}: font: ${d.value}`)
      }
      for (const m of text.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)/g)) if (/^(?:https?:)?\/\//.test(m[1])) found.push(`${file}: @import ${m[1]}`)
    }
    expect(found, 'a font is var(--font-body), var(--font-mono), var(--font-prose) or a --type-* token').toEqual([])
    // the faces tokens.css names are the two fonts.css serves from the app itself: the card harness draws offscreen
    // and may reach no host
    const tokens = read('styles/tokens.css')
    expect(/--font-body:\s*'Hanken Grotesk'/.test(tokens) && /--font-mono:\s*'Geist Mono'/.test(tokens)).toBe(true)
    const faces = [...read('styles/fonts.css').matchAll(/@import '([^']+)'/g)].map((m) => m[1].split('/')[1])
    expect(new Set(faces)).toEqual(new Set(['hanken-grotesk', 'geist-mono']))
  })

  test("weights are 400 and 500, and 600 only for a report's title and section heads", () => {
    const found: string[] = []
    for (const { file, text } of STYLES) {
      for (const d of declarations(text)) {
        const weight = d.prop === 'font-weight' ? d.value : /^(?:font|--type-[\w-]+)$/.test(d.prop) ? (/^(?:italic\s+)?(\d{3}|bold|bolder|lighter)\b/.exec(d.value)?.[1] ?? null) : null
        if (weight === null || /^(?:400|500|normal|inherit|var\(.*\))$/.test(weight)) continue
        if (file === 'styles/tokens.css' && weight === '600' && /^--type-report-h[12]$/.test(d.prop)) continue
        found.push(`${file}:${d.line}: ${d.prop}: ${d.value}`)
      }
    }
    for (const { file, text } of sources('.ts', '.tsx')) {
      for (const m of text.matchAll(/fontWeight:\s*['"]?(\w+)/g)) if (!/^(?:400|500|normal)$/.test(m[1])) found.push(`${file}: fontWeight ${m[1]}`)
    }
    expect(found).toEqual([])
  })

  test("a cited number is set in its text's own face, size and weight", () => {
    const found: string[] = []
    for (const { file, text } of STYLES) {
      for (const d of declarations(text)) {
        if (!/^font(?:-weight|-size|-family)?$/.test(d.prop) || d.value === 'inherit') continue
        const selector = selectorAt(text, d.line)
        if (/\.refchip-value\b/.test(selector)) found.push(`${file}:${d.line}: ${selector} { ${d.prop}: ${d.value} }`)
      }
    }
    expect(found).toEqual([])
  })

  test("the one drop shadow is the float's: outside tokens.css a shadow with a blur is a --shadow token", () => {
    // a ring or a hairline (no blur) draws an edge, not a shadow, and is written where it is used
    const found: string[] = []
    for (const { file, text } of STYLES) {
      if (file === 'styles/tokens.css') continue
      for (const d of declarations(text)) {
        if (d.prop === 'filter' && /drop-shadow/.test(d.value)) found.push(`${file}:${d.line}: filter: ${d.value}`)
        if (d.prop === 'text-shadow' && d.value !== 'none') found.push(`${file}:${d.line}: text-shadow: ${d.value}`)
        if (d.prop !== 'box-shadow' && !/^--[\w-]*shadow/.test(d.prop)) continue
        for (const layer of layers(d.value)) {
          if (/^(?:none|var\(--[\w-]+\))$/.test(layer)) continue
          const lengths = layer
            .replace(/var\([^)]*\)|color-mix\((?:[^()]|\([^()]*\))*\)|rgba?\([^)]*\)/g, ' ')
            .split(/\s+/)
            .filter((w) => /^-?[\d.]+(?:px|em|rem)?$/.test(w))
          if (lengths.length >= 3 && parseFloat(lengths[2]) !== 0) found.push(`${file}:${d.line}: ${d.prop}: ${d.value}`)
        }
      }
    }
    expect(found, 'a floating surface wears var(--shadow-float) or one of the shadow tokens built on it').toEqual([])
  })

  test('a text field has a placeholder only where the line says what the field is for', () => {
    // the composers name where a message goes, the searches what they search, the ask box, the New view field, and
    // Label from prompt what to type; every other field (a label's name, a check's prompt, the start's
    // instructions) has none, and neither does the report editor. A template's variable part reads as *.
    const ALLOWED = new Set(['Reply in *…', 'Reply, or ask Thimble to fix…', 'Ask about this card…', 'Ask about this…', 'Search cards', 'Search files', 'Describe a view; Enter asks main', 'Label from prompt…'])
    const found: string[] = []
    for (const { file, text } of sources('.tsx', '.ts')) {
      for (const m of text.matchAll(/placeholder=(?:"([^"]*)"|\{'([^']*)'\}|\{`([^`]*)`\})/g)) found.push(`${file}: ${(m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, '*')}`)
      for (const m of text.matchAll(/const [A-Z_]*PLACEHOLDER = '([^']*)'/g)) found.push(`${file}: ${m[1]}`)
    }
    expect(found.length, 'the scan reads the placeholders it checks').toBeGreaterThan(0)
    expect(found.filter((f) => !ALLOWED.has(f.slice(f.indexOf(': ') + 2)))).toEqual([])
    // the report editor's dictionary blanks BlockNote's own placeholders
    expect(read('report/Editor.tsx')).toMatch(/placeholders: Object\.fromEntries\(Object\.keys\(en\.placeholders\)\.map\(\(k\) => \[k, ''\]\)\)/)
  })

  test('no helper text: an empty pane stays empty, and a gesture is named in its tooltip, not in a line of text', () => {
    const HINTS = ['No file open', 'Star a card on the Canvas', 'No slides yet', 'No story yet', 'Write drafts', '>No files.<', 'dbl-click', 'Evidence for this sentence']
    const found = sources('.tsx').flatMap(({ file, text }) => HINTS.filter((h) => text.includes(h)).map((h) => `${file}: "${h}"`))
    expect(found).toEqual([])
  })

  test("an icon-only button is named in the one tooltip, never by the browser's title beside its aria-label", () => {
    const found: string[] = []
    for (const { file, text } of sources('.tsx')) {
      // Button keeps the plain title only on a button with a visible label, whose tip it does not draw
      if (file === 'components/Button.tsx') continue
      for (const m of text.matchAll(/<button\b[^>]*>/g)) if (/\stitle=/.test(m[0]) && /\saria-label=/.test(m[0])) found.push(`${file}: ${m[0].slice(0, 90)}`)
    }
    expect(found, 'an icon-only button takes TipButton, Tipped or Button, whose tip is the one tooltip').toEqual([])
  })

  test("a report block's actions stand at its right: no drag handle or + at its left, and no Evidence button on any document", () => {
    const editor = read('report/Editor.tsx')
    expect(editor).not.toMatch(/AddBlockButton|DragHandleButton|DragHandleMenu|<SideMenu[ >]/)
    expect(read('components/Icon.tsx')).not.toMatch(/\bgrip:/)
    expect(editor).toMatch(/placement: 'right-start'/)
    // a document's checks are the Checks pane's, in its sidebar
    const evidence = sources('.tsx').filter((f) => f.file.startsWith('report/') && /wu-evidence|>\s*Evidence\s*</.test(f.text))
    expect(evidence.map((f) => f.file)).toEqual([])
  })

  test("a chip's name has a line taller than its type and shorter than the chip, so its cut leaves an underscore whole", () => {
    const tokens = read('styles/tokens.css')
    const components = read('styles/components.css')
    const at = components.indexOf('\n.chip-text {')
    expect(at, '.chip-text is in components.css').toBeGreaterThanOrEqual(0)
    const rule = components.slice(at, components.indexOf('}', at))
    expect(rule).toMatch(/overflow: hidden/)
    const line = Number(/line-height:\s*(\d+)px/.exec(rule)?.[1])
    const type = Number(/--text-mono-sm:\s*(\d+)px/.exec(tokens)?.[1])
    const chip = Number(/--h-chip:\s*(\d+)px/.exec(tokens)?.[1])
    expect(line).toBeGreaterThanOrEqual(type + 3)
    expect(line).toBeLessThan(chip)
  })
})

describe("the design system's helpers", () => {
  test('modelLabel names a model id in two words, without its tag', () => {
    expect(modelLabel('claude-opus-5')).toBe('Opus 5')
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelLabel('claude-opus-5[1m]')).toBe('Opus 5')
    expect(modelLabel('opus')).toBe('Opus')
    expect(modelLabel('  ')).toBe('model')
  })

  test('modelChoices lists the current model first, then every role model once, then the current models, each by its id without a tag', () => {
    const settings = { models: { main: { model: 'claude-opus-5', effort: 'medium', fast: true }, thread: { model: 'claude-opus-5', effort: 'low', fast: true }, labels: { model: 'claude-haiku-4-5-20251001', effort: 'low', fast: false } } } as unknown as Settings
    const rest = (named: string[]) => KNOWN_MODELS.filter((x) => !named.includes(x))
    expect(modelChoices(settings, 'claude-fable-5-1')).toEqual(['claude-fable-5-1', 'claude-opus-5', 'claude-haiku-4-5-20251001', ...rest(['claude-fable-5-1', 'claude-opus-5', 'claude-haiku-4-5-20251001'])])
    expect(modelChoices(settings, 'claude-opus-5')).toEqual(['claude-opus-5', 'claude-haiku-4-5-20251001', ...rest(['claude-opus-5', 'claude-haiku-4-5-20251001'])])
    expect(modelChoices(null, null)).toEqual([...KNOWN_MODELS])
    expect(modelChoices(null, 'claude-opus-5-5[1m]'), 'the 1M tag names the same model').toEqual(['claude-opus-5-5', ...KNOWN_MODELS.filter((x) => x !== 'claude-opus-5-5')])
  })

  test("the theme: Warm and iris by default, a stored choice stands, the old toggle's dark opens on Dark", () => {
    expect(readPaper(null)).toBe('warm')
    expect(readPaper('neutral')).toBe('neutral')
    expect(readPaper('bogus', 'dark')).toBe('dark')
    expect(readPaper(null, 'light')).toBe('warm')
    expect(readPaper('warm', 'dark'), 'a paper chosen since wins over the old key').toBe('warm')
    expect(readAccent(null)).toBe('iris')
    expect(readAccent('lime')).toBe('lime')
    expect(readAccent('red'), 'red is no accent: it is kept for contradicts and failed').toBe('iris')
    expect(paperScheme('dark')).toBe('dark')
    expect(paperScheme('neutral')).toBe('light')
    expect(PAPERS.map((p) => p.id)).toEqual(['warm', 'neutral', 'dark'])
    expect(ACCENTS.map((a) => a.id)).toEqual(['pink', 'orange', 'yellow', 'lime', 'blue', 'iris', 'graphite'])
    // each accent's swatch is the fill tokens.css gives it
    const tokens = read('styles/tokens.css')
    for (const a of ACCENTS) expect(tokens, a.id).toMatch(new RegExp(`\\[data-accent='${a.id}'\\][^{]*\\{[^}]*--accent:\\s*${a.hex}`, 'i'))
  })

  test('the top bar prints the corpus folder with the home folder as ~', () => {
    expect(shortPath('/home/ada/corpora/refunds')).toBe('~/corpora/refunds')
    expect(shortPath('/Users/ada/x')).toBe('~/x')
    expect(shortPath('/home/ada')).toBe('~')
    expect(shortPath('/data/mini')).toBe('/data/mini')
  })

  test('tool-call cards: a run of calls of one kind is one card, with its steps, its meta and its state', () => {
    const tool = (id: string, name: string, input: object, result: object | undefined, ts: string | undefined) => ({ kind: 'tool', index: Number(id.slice(1)), id, name, input, ts, result, children: [] })
    const rows = [
      { kind: 'user', index: 0, text: 'q' },
      tool('t1', 'mcp__thimble__add_card', { question: 'Files' }, { summary: 'ok', ts: '2026-09-22T10:00:12Z', cell_id: 'c1' }, '2026-09-22T10:00:00Z'),
      tool('t2', 'mcp__thimble__edit_cell', { question: 'Files, again' }, { summary: 'ok', ts: '2026-09-22T10:00:31Z', cell_id: 'c1' }, '2026-09-22T10:00:13Z'),
      tool('t3', 'Read', { file_path: '/data/mini/a.jsonl' }, undefined, '2026-09-22T10:00:32Z'),
      { kind: 'text', index: 9, text: 'done' },
      tool('t10', 'Grep', { pattern: 'x' }, { summary: 'ok' }, undefined),
    ] as unknown as Row[]
    const g = groupTools(rows) as any[]
    expect(g.map((r) => (r.kind === 'tools' ? `${r.name}:${r.tools.length}` : r.kind))).toEqual(['user', 'Cards:2', 'Read:1', 'text', 'Read:1'])
    expect(toolMeta(g[1].tools), 'the steps and the time from the first call to the last result').toBe('2 steps · 31s')
    expect(toolMeta(g[4].tools), 'no time without both ends').toBe('1 step')
    expect(toolGroupName('mcp__plugin_thimble_thimble__apply_label')).toBe('Label')
    expect(toolGroupName('mystery_tool')).toBe('mystery_tool')
    expect(toolSteps(g[1].tools, false).map((s) => [s.text, s.state]), 'a call by the old name reads as the new one').toEqual([['add_card · Files', 'done'], ['edit_card · Files, again', 'done']])
    expect(toolSteps(g[2].tools, true).map((s) => s.state)).toEqual(['running'])
    expect(groupState(g[1].tools, false)).toBe('done')
    expect(groupState(g[2].tools, true)).toBe('running')
    expect(groupState(g[2].tools, false), 'an old call that never came back shows nothing').toBe(null)
    expect(groupState([tool('t9', 'Bash', {}, { summary: 'no', is_error: true }, undefined)] as any, false)).toBe('failed')
  })

  test('placeBeside puts the sheet below when it fits, above when it does not, and clamps to the viewport', () => {
    const rect = { left: 100, right: 200, top: 100, bottom: 130 }
    expect(placeBeside(rect, 180, 200, 1000, 800, 'start')).toEqual({ left: 100, top: 134 })
    expect(placeBeside(rect, 180, 200, 1000, 800, 'end')).toEqual({ left: 20, top: 134 })
    // no room below: above the anchor
    expect(placeBeside({ left: 100, right: 200, top: 700, bottom: 730 }, 180, 200, 1000, 800, 'start')).toEqual({ left: 100, top: 496 })
    // no room either way: pinned to the bottom margin
    expect(placeBeside({ left: 100, right: 200, top: 150, bottom: 180 }, 180, 700, 1000, 800, 'start')).toEqual({ left: 100, top: 92 })
    // wider than the room on the right: pulled left to the margin
    expect(placeBeside({ left: 900, right: 990, top: 10, bottom: 40 }, 300, 100, 1000, 800, 'start')).toEqual({ left: 692, top: 44 })
    expect(placeBeside({ left: 2, right: 40, top: 10, bottom: 40 }, 300, 100, 1000, 800, 'end').left).toBe(8)
  })

  test("placeAside puts a disabled menu item's tip to its right when it fits, else to its left, level with its middle", () => {
    expect(placeAside({ left: 100, right: 260, top: 200, bottom: 228 }, 300, 24, 1000, 800)).toEqual({ left: 264, top: 202 })
    expect(placeAside({ left: 600, right: 760, top: 200, bottom: 228 }, 300, 24, 1000, 800)).toEqual({ left: 296, top: 202 })
    expect(placeAside({ left: 100, right: 760, top: 200, bottom: 228 }, 300, 24, 1000, 800)).toEqual({ left: 692, top: 202 })
    expect(placeAside({ left: 100, right: 260, top: 0, bottom: 10 }, 300, 40, 1000, 800).top).toBe(8)
    expect(placeAside({ left: 100, right: 260, top: 790, bottom: 800 }, 300, 40, 1000, 800).top).toBe(752)
  })

  test("a pointed element: its surface from the nearest panel, its kind from its component class, its selector from its anchor", () => {
    const card = { tag: 'article', classes: ['card', 'canvas-card', 'selected'], anchor: 'card:c1' }
    const canvas = { tag: 'section', classes: ['canvas'], panel: 'canvas' }
    expect(describeChain([card, canvas])).toEqual({ surface: 'canvas', element: 'canvas-card', selector: '[data-anchor="card:c1"]' })
    const span = { tag: 'span', classes: ['sentence'] }
    const para = { tag: 'p', classes: [], anchor: 'report:report#p3' }
    expect(describeChain([span, para, { tag: 'div', classes: [], panel: 'report' }])).toEqual({ surface: 'report', element: 'span', selector: '[data-anchor="report:report#p3"] > span.sentence' })
    expect(describeChain([]).element).toBe('element')
  })
})
