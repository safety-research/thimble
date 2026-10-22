// A card's drawing in the page: the plain tree the card runner makes of a view (the terminal plugin's
// plugin/cards/runner.mjs), `{t, p, c}` nodes of Box, Text and Button with Ink's props, drawn as elements on a grid of
// character cells: the card's font is monospace, a width or a margin in cells is that many `ch`, a height or a margin
// across rows that many rows (--card-row), so a card lays out as the terminal lays it out. A Box is a flexbox with Ink's
// defaults (a row, items that shrink); a border is a line through the middle of the cells it takes, as the terminal's
// box-drawing characters draw it; a Text is a block of its runs, wrapped at words or cut with `…`; a Button is
// `[ label ]`, or its label alone when plain, and a press sends its number (onPress). A character outside ASCII (a dot,
// a box-drawing line, a mark such as ✕ or ◆) stands in cells of its own, as many as the terminal gives it (the plugin's
// core/text.js), since a font that lacks it draws it in another font, at another width. Pure but for the elements.
import type { CSSProperties, ReactNode } from 'react'
import { textWidth } from '../../../../plugin/core/text.js'

export type TreeNode = string | { t: 'Box' | 'Text' | 'Button'; p?: Record<string, unknown>; c?: TreeNode[] }

/** Ink's named colors, in the page's palette (tokens.css), so a card that names one reads on every paper. */
const NAMED: Record<string, string> = {
  black: 'var(--ink-900)', white: 'var(--paper-0)', gray: 'var(--ink-500)', grey: 'var(--ink-500)',
  red: 'var(--status-negative)', green: 'var(--status-positive)', yellow: 'var(--viz-gold-3)', blue: 'var(--viz-blue-3)',
  magenta: 'var(--viz-pink-3)', cyan: 'var(--viz-teal-3)',
  redBright: 'var(--status-negative)', greenBright: 'var(--viz-green-3)', yellowBright: 'var(--viz-gold-3)',
  blueBright: 'var(--viz-blue-2)', magentaBright: 'var(--viz-pink-2)', cyanBright: 'var(--viz-teal-2)', blackBright: 'var(--ink-500)',
  whiteBright: 'var(--paper-0)',
}

/** A color prop as CSS: `#rrggbb` (or #rgb) as it is, an Ink name in the page's palette, anything else none. */
export function colorOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  if (/^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(v)) return v
  return NAMED[v]
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** A size in cells across: whole cells as `ch`, a percent as it is. */
const across = (v: unknown): string | undefined => (typeof v === 'string' && /^\d+(?:\.\d+)?%$/.test(v) ? v : num(v) !== undefined ? `${num(v)}ch` : undefined)
/** A size in rows: whole rows of the card's line height, a percent as it is. */
const down = (v: unknown): string | undefined => (typeof v === 'string' && /^\d+(?:\.\d+)?%$/.test(v) ? v : num(v) !== undefined ? `calc(${num(v)} * var(--card-row))` : undefined)

/** One edge of padding or margin, from Ink's props: the side's own, else its axis's (X, Y), else the whole. */
function edge(p: Record<string, unknown>, what: 'padding' | 'margin', side: 'Top' | 'Bottom' | 'Left' | 'Right'): number {
  const axis = side === 'Top' || side === 'Bottom' ? 'Y' : 'X'
  return num(p[`${what}${side}`]) ?? num(p[`${what}${axis}`]) ?? num(p[what]) ?? 0
}

const BORDER_RADIUS: Record<string, string> = { round: '0.6ch' }
const BORDER_STYLE: Record<string, string> = { double: 'double', dashed: 'dashed', classic: 'solid', bold: 'solid' }

function boxStyle(p: Record<string, unknown>): { style: CSSProperties; border: ReactNode } {
  const dir = typeof p.flexDirection === 'string' ? p.flexDirection : 'row'
  const b = typeof p.borderStyle === 'string' ? p.borderStyle : null
  const sides = { Top: b && p.borderTop !== false, Bottom: b && p.borderBottom !== false, Left: b && p.borderLeft !== false, Right: b && p.borderRight !== false }
  const pad = (s: 'Top' | 'Bottom' | 'Left' | 'Right') => edge(p, 'padding', s) + (sides[s] ? 1 : 0)
  const style: CSSProperties = {
    display: p.display === 'none' ? 'none' : 'flex',
    flexDirection: dir as CSSProperties['flexDirection'],
    flexGrow: num(p.flexGrow) ?? 0,
    flexShrink: num(p.flexShrink) ?? 1,
    flexBasis: across(p.flexBasis) ?? 'auto',
    flexWrap: (typeof p.flexWrap === 'string' ? p.flexWrap : 'nowrap') as CSSProperties['flexWrap'],
    columnGap: across(p.columnGap ?? p.gap),
    rowGap: down(p.rowGap ?? p.gap),
    width: across(p.width),
    height: down(p.height),
    minWidth: across(p.minWidth) ?? 0,
    minHeight: down(p.minHeight),
    maxWidth: across(p.maxWidth),
    maxHeight: down(p.maxHeight),
    paddingTop: down(pad('Top')),
    paddingBottom: down(pad('Bottom')),
    paddingLeft: across(pad('Left')),
    paddingRight: across(pad('Right')),
    marginTop: down(edge(p, 'margin', 'Top')),
    marginBottom: down(edge(p, 'margin', 'Bottom')),
    marginLeft: across(edge(p, 'margin', 'Left')),
    marginRight: across(edge(p, 'margin', 'Right')),
    justifyContent: typeof p.justifyContent === 'string' ? p.justifyContent : undefined,
    alignItems: typeof p.alignItems === 'string' ? p.alignItems : 'stretch',
    alignSelf: typeof p.alignSelf === 'string' && p.alignSelf !== 'auto' ? p.alignSelf : undefined,
    overflow: p.overflow === 'hidden' || p.overflowX === 'hidden' || p.overflowY === 'hidden' ? 'hidden' : undefined,
    position: p.position === 'absolute' ? 'absolute' : 'relative',
    top: down(p.top),
    bottom: down(p.bottom),
    left: across(p.left),
    right: across(p.right),
    backgroundColor: colorOf(p.backgroundColor),
    boxSizing: 'border-box',
  }
  const color = colorOf(p.borderColor) ?? 'currentColor'
  const line = `1px ${BORDER_STYLE[b ?? ''] ?? 'solid'} ${color}`
  const border = b ? (
    <span
      className="drawn-border"
      aria-hidden="true"
      style={{
        borderTop: sides.Top ? line : 'none',
        borderBottom: sides.Bottom ? line : 'none',
        borderLeft: sides.Left ? line : 'none',
        borderRight: sides.Right ? line : 'none',
        borderRadius: BORDER_RADIUS[b] ?? 0,
        opacity: p.borderDimColor ? 0.55 : undefined,
      }}
    />
  ) : null
  return { style, border }
}

/** A string as the page draws it: its ASCII as text, each other character in a span as many cells wide as it takes. */
export function cells(s: string): ReactNode[] {
  const out: ReactNode[] = []
  let plain = ''
  let k = 0
  for (const ch of s) {
    if (ch >= ' ' && ch <= '~') {
      plain += ch
      continue
    }
    if (plain) out.push(plain)
    plain = ''
    const w = textWidth(ch)
    out.push(w ? <span key={k++} className="drawn-cell" style={{ width: `${w}ch` }}>{ch}</span> : ch)
  }
  if (plain) out.push(plain)
  return out
}

/** A Text's runs: its strings, and its nested Texts with their own color and weight. */
function runs(c: TreeNode[] | undefined, key: string): ReactNode[] {
  return (c ?? []).map((n, i) => {
    if (typeof n === 'string') return cells(n)
    if (n.t !== 'Text') return null
    return (
      <span key={`${key}.${i}`} style={textStyle(n.p ?? {})}>
        {runs(n.c, `${key}.${i}`)}
      </span>
    )
  })
}

function textStyle(p: Record<string, unknown>): CSSProperties {
  const fg = colorOf(p.color)
  const bg = colorOf(p.backgroundColor)
  const inverse = p.inverse === true
  return {
    color: inverse ? (bg ?? 'var(--card-paper)') : fg,
    backgroundColor: inverse ? (fg ?? 'var(--card-ink)') : bg,
    fontWeight: p.bold ? 600 : undefined,
    fontStyle: p.italic ? 'italic' : undefined,
    opacity: p.dimColor ? 0.6 : undefined,
    textDecoration: [p.underline ? 'underline' : '', p.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
  }
}

/** The text a Button draws: `[ label ]`, or the label alone when plain (layout.js buttonText). */
function buttonLabel(p: Record<string, unknown>, c: TreeNode[] | undefined, key: string): ReactNode {
  const label = c?.length ? runs(c, key) : cells(String(p.label ?? ''))
  return p.plain ? label : (
    <>
      {'[ '}
      {label}
      {' ]'}
    </>
  )
}

/** The tree as elements. `onPress(n)` hears a press of the Button whose onPress is `n`. */
export function Tree({ node, onPress, path = 'n' }: { node: TreeNode; onPress: (n: number) => void; path?: string }): ReactNode {
  if (typeof node === 'string') return <span className="drawn-text">{cells(node)}</span>
  const p = node.p ?? {}
  if (node.t === 'Text') {
    const cut = typeof p.wrap === 'string' && p.wrap.startsWith('truncate')
    return (
      <span className={`drawn-text${cut ? ' is-cut' : ''}`} style={textStyle(p)}>
        {runs(node.c, path)}
      </span>
    )
  }
  if (node.t === 'Button') {
    const n = num(p.onPress)
    return (
      <button type="button" className={`drawn-button${p.plain ? ' is-plain' : ''}`} onClick={(e) => (e.stopPropagation(), n !== undefined && onPress(n))}>
        {buttonLabel(p, node.c, path)}
      </button>
    )
  }
  const { style, border } = boxStyle(p)
  return (
    <span className="drawn-box" style={style}>
      {border}
      {(node.c ?? []).map((k, i) => (
        <Tree key={i} node={k} onPress={onPress} path={`${path}.${i}`} />
      ))}
    </span>
  )
}
