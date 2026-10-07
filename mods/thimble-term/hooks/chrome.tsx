// The panels' chrome, after Claude Code's own panels (its Artifacts and Background panels): a title in the accent
// colour and bold with a dim subtitle under it, tabs with the selected one inverse, a bordered search box, bold section
// headings with a dim count, `❯` and the accent on the selected row, metadata dim against the right edge, and a dim
// italic row of key hints at the end (SPEC.md, "The visual system", rules 5 to 9 and section 7).
//
// Two forms of each part: as styled lines (Line), for the panels a Client draws from lines and hits (home.ts, the
// threads tree, the lists), and as elements, for the panels register.tsx, harness.tsx and reports.tsx draw with Box and
// Text. viewdraw.ts draws a view's header itself, since tools/render_view.mjs runs it under Node, which reads no .tsx.
import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { Line, Seg } from './draw'
import { cut, lineWidth, width } from './draw'
import { COLORS } from './paint'

// the theme keys of paint.ts COLORS that the chrome draws with
export const LINK = COLORS.link
export const ACCENT = COLORS.accent
export const FRESH = COLORS.fresh
export const TIP = COLORS.tip
export const CHROME = { link: LINK, accent: ACCENT, fresh: FRESH, tip: TIP } as const

/** The cells a mark hangs in, left of a panel's type area: `❯`, `?`, `↳`, a highlight's `●`. */
export const MARGIN_W = 2

// ------------------------------------------------------------------------------------------------ as lines

const dim = (s: string): Seg => ({ s, fg: COLORS.dim })

/** `left` with `right` set against the right edge at `w`, the left cut first so the right stays whole. */
export function spread(left: Line, right: Line, w: number): Line {
  const rw = lineWidth(right)
  if (!rw) return fitTo(left, w)
  const l = fitTo(left, Math.max(0, w - rw - 2))
  return [...l, { s: ' '.repeat(Math.max(2, w - lineWidth(l) - rw)) }, ...right]
}

/** A line cut to `w` cells, its last segment ending in "…" where cut. */
export function fitTo(l: Line, w: number): Line {
  if (lineWidth(l) <= w) return l
  const out: Line = []
  let left = w
  for (const s of l) {
    if (left <= 0) break
    const sw = width(s.s)
    if (sw <= left) {
      out.push(s)
      left -= sw
    } else {
      out.push({ ...s, s: cut(s.s, left) })
      left = 0
    }
  }
  return out
}

/** A panel's title row: the subject's name in the accent and bold, navigation (`1 file ›`) against the right edge. */
export function titleLine(title: string, w: number, right: Line = []): Line {
  return spread([{ s: title, fg: ACCENT, b: true }], right, w)
}

/** A panel's subtitle: its facts dim, parted by ` · `; a part given as a segment keeps its own colour (a problem's red). */
export function subLine(parts: readonly (string | Seg | null | undefined | false)[]): Line {
  const out: Line = []
  for (const p of parts) {
    if (!p) continue
    if (out.length) out.push(dim(' · '))
    out.push(typeof p === 'string' ? dim(p) : p)
  }
  return out
}

/** A rule across the type area, in the rule grey. */
export function ruleLine(w: number): Line {
  return [{ s: '─'.repeat(Math.max(1, w)), fg: COLORS.rule }]
}

/** A section heading: its name bold, its count dim in parentheses, `N new` in green after it. */
export function headingLine(name: string, count?: number, fresh = 0): Line {
  return [{ s: name, b: true }, ...(count !== undefined ? [dim(` (${count.toLocaleString('en-US')})`)] : []), ...(fresh ? [{ s: '  ' }, { s: `${fresh.toLocaleString('en-US')} new`, fg: FRESH }] : [])]
}

/** Where a key hint stands on its row, the same on every panel: choosing (↑↓), Enter, Space, then the panel's own keys
 *  in the order it gives them, then going back and closing. */
function hintRank(h: string): number {
  return /^↑↓/.test(h) ? 0 : /^Enter\b/.test(h) ? 1 : /^Space\b/.test(h) ? 2 : /^b to go back\b/.test(h) ? 8 : /^x to close\b/.test(h) ? 9 : 5
}

/** The key hints in the order every panel gives them (hintRank). */
export function orderedHints(hints: readonly string[]): string[] {
  return hints.map((h, i) => ({ h, i })).sort((a, b) => hintRank(a.h) - hintRank(b.h) || a.i - b.i).map(x => x.h)
}

/** The key-hint row: the bound keys in Claude Code's words, in one order on every panel, dim and italic, parted by
 *  ` · `. */
export function hintLine(hints: readonly string[], w: number): Line {
  return fitTo([{ s: orderedHints(hints).join(' · '), fg: COLORS.dim, i: true }], w)
}

/** `new` in green, the word that follows a new item's name; `N new` after a count. */
export function freshSeg(n?: number): Seg {
  return { s: n === undefined ? 'new' : `${n.toLocaleString('en-US')} new`, fg: FRESH }
}

/** A line with its margin: `❯` in the accent and the line's own words in the accent when `on` (the selected row), else
 *  two spaces. A segment with a colour of its own (a state glyph, a value's hue, a problem, a dim secondary part) keeps
 *  it; `whole` recolours the dim parts too, as a table's selected row is accent across its whole width. */
export function pointed(l: Line, on: boolean, whole = false): Line {
  if (!on) return [{ s: ' '.repeat(MARGIN_W) }, ...l]
  return [{ s: '❯ ', fg: ACCENT }, ...l.map(s => (s.fg === undefined || s.fg === COLORS.text || (whole && s.fg === COLORS.dim) ? { ...s, fg: ACCENT } : s))]
}

/** A line with an empty margin. */
export function margined(l: Line): Line {
  return [{ s: ' '.repeat(MARGIN_W) }, ...l]
}

/** A link: blue and underlined (a citation's value, the place after `↗`, a label's name). */
export function linkSeg(s: string): Seg {
  return { s, fg: LINK, u: true }
}

// ------------------------------------------------------------------------------------------------ as elements

type El = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }

/** A styled line as one Text, each segment a nested Text (paint.ts paintLine, wrapped when `wrap`). */
export function lineEl(els: El, l: Line, key?: string, wrap = false): RenderElement {
  const { Text } = els
  const seg = (s: Seg) => {
    const p: TextProps = {}
    if (s.fg) p.color = s.fg
    if (s.bg) p.backgroundColor = s.bg
    if (s.b) p.bold = true
    if (s.d) p.dimColor = true
    if (s.i) p.italic = true
    if (s.u) p.underline = true
    if (s.inv) p.inverse = true
    return Text({ ...p, children: s.s })
  }
  const line = Text({ wrap: wrap ? 'wrap' : 'truncate-end', children: l.length ? l.map(seg) : ' ' })
  return key ? els.Box({ key, flexDirection: 'row', children: [line] }) : line
}

/** A panel's header under its path row: the title row (accent, bold; navigation against the right edge), the dim
 *  subtitle when it has facts, then any rows the panel adds (tabs, a search box), then the rule. */
export function headerEls(els: El, o: { title: string; cols: number; right?: RenderElement | null; sub?: Line; titleLine?: Line; more?: RenderElement[]; rule?: boolean }): RenderElement[] {
  const { Box, Text } = els
  const out: RenderElement[] = []
  const title = o.titleLine ?? [{ s: o.title, fg: ACCENT, b: true }]
  out.push(
    o.right ? (
      <Box key="h-title" flexDirection="row">
        <Box flexShrink={1}>{lineEl(els, title)}</Box>
        <Box flexGrow={1} />
        <Box flexShrink={0}>{o.right}</Box>
      </Box>
    ) : (
      <Box key="h-title" flexDirection="row">{lineEl(els, title, undefined, true)}</Box>
    ),
  )
  if (o.sub?.length) out.push(<Box key="h-sub">{lineEl(els, o.sub, undefined, true)}</Box>)
  out.push(...(o.more ?? []))
  if (o.rule !== false) out.push(<Text key="h-rule" color={COLORS.rule}>{'─'.repeat(Math.max(1, o.cols))}</Text>)
  return out
}

/** A rule across the type area. */
export function ruleEl(els: El, cols: number, key: string): RenderElement {
  return els.Box({ key, flexDirection: 'row', children: [els.Text({ color: COLORS.rule, children: '─'.repeat(Math.max(1, cols)) })] })
}

/** The key-hint row, the panel's last. */
export function hintsEl(els: El, hints: readonly string[], cols: number): RenderElement {
  return lineEl(els, hintLine(hints, cols), 'h-hints')
}

/** The key hints on the rows they need in `w` cells, in hintLine's order and look, a row ending where the next hint
 *  does not fit, so none is left out (a view's panel, whose keys are its own). */
export function hintRows(hints: readonly string[], w: number): string[] {
  const rows: string[] = []
  for (const h of orderedHints(hints)) {
    if (rows.length && width(rows[rows.length - 1]!) + 3 + width(h) <= w) rows[rows.length - 1] += ` · ${h}`
    else rows.push(h)
  }
  return rows
}

/** The key hints wrapped (hintRows), the panel's last rows. */
export function hintRowsEl(els: El, hints: readonly string[], cols: number): RenderElement {
  const rows = hintRows(hints, cols)
  if (rows.length <= 1) return hintsEl(els, hints, cols)
  return els.Box({ key: 'h-hints', flexDirection: 'column', children: rows.map((r, i) => lineEl(els, fitTo([{ s: r, fg: COLORS.dim, i: true }], cols), `h-hints-${i}`)) })
}

/** Label/value rows and fields (rule 27): each label dim and lower case in a column as wide as the longest label plus
 *  a gutter, its value or field on L. */
export function fieldEls(els: El, rows: readonly [string, RenderElement | string, string?][], keyPrefix = 'f'): RenderElement | null {
  if (!rows.length) return null
  const { Box, Text } = els
  const w = Math.max(...rows.map(([k]) => width(k))) + 2
  return (
    <Box key={`${keyPrefix}-rows`} flexDirection="column">
      {rows.map(([k, v, colour]) => (
        <Box key={`${keyPrefix}:${k}`} flexDirection="row">
          <Box width={w} flexShrink={0}>
            <Text dimColor>{k}</Text>
          </Box>
          <Box flexShrink={1} flexGrow={1}>{typeof v === 'string' ? <Text wrap="wrap" {...(colour ? { color: colour } : {})}>{v}</Text> : v}</Box>
        </Box>
      ))}
    </Box>
  )
}

/** A row of controls at A0, 2 cells apart (rule 25): plain words, inverse under the pointer. */
export function controlsEl(els: El, controls: readonly (RenderElement | null | false)[], key = 'controls'): RenderElement | null {
  const kept = controls.filter((c): c is RenderElement => Boolean(c))
  if (!kept.length) return null
  return els.Box({ key, flexDirection: 'row', columnGap: 2, flexWrap: 'wrap', children: kept })
}

/** A row that brings its own margin (`❯`, a passage's `?` or `↳`): the panel draws it as it is, where every other row
 *  gets an empty margin (register.tsx withWay). */
export function marginKey(key: string): string {
  return key.startsWith('m:') ? key : `m:${key}`
}

export function hasMargin(el: unknown): boolean {
  const k = (el as { key?: unknown; props?: { key?: unknown } } | null)?.props?.key ?? (el as { key?: unknown } | null)?.key
  return typeof k === 'string' && k.startsWith('m:')
}
