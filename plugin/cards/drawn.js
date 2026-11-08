// drawn.js: what a card's Client draws of the runner's tree, and how large Claude Code holds that drawing. The Client
// (client.tsx) draws with Claude Code's elements (surface.elements). The runner (runner.mjs) draws the same tree with
// elements that build what Claude Code makes of a Client's drawing (its surface runtime: one JSON text of the elements,
// each {type, props, hover, held, children}), and so measures a card as Claude Code will hold it before the card is
// shown. Claude Code does not draw a Client whose drawing is more than 100000 characters as that text, and the
// analyst's screen then shows only that.
//
//   cardElement(props, o)    the Client's drawing of its props ({tree, width, tint, accent, theme, cap}, draw.ts
//                            propsAt) with the elements `o.E`; `o.id` names the instance (its hover scopes), `o.width`
//                            is the width it draws at, and `o.send` posts a press or a click on a run of words
//   drawnSize(tree, width)   the characters of Claude Code's text of the Client's drawing of `tree` at `width`
//
// Every run of words the view drew takes a click in a Button of the Client's own, which makes a card of many short runs
// (a dot for each run) about four times as large. A tree the runner marks `bare` is drawn without those Buttons, as a
// card that reads clicks by cell (`cells`) is: its clicks still reach the runner, which selects the item on the clicked
// line. Pure: no Node, no imports.

const BOX = ['flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent', 'gap',
  'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight', 'margin', 'marginX', 'marginY', 'marginTop',
  'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom',
  'paddingLeft', 'paddingRight', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow',
  'display', 'position', 'top', 'left', 'right', 'bottom']
const TEXT = ['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap']
const BUTTON = ['label', 'plain', 'dimColor', 'variant']

function pick(p, names) {
  const out = {}
  if (!p) return out
  for (const k of names) {
    const v = p[k]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

/** The words a node draws: a row's side by side, a column's one line under another. */
function wordsOf(n) {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return ''
  const col = n.t === 'Box' && (n.p?.flexDirection === 'column' || n.p?.flexDirection === 'column-reverse')
  return (Array.isArray(n.c) ? n.c : []).map(wordsOf).join(col ? '\n' : '')
}

/** The Client's drawing of a card (the props draw.ts hands it), with the elements `o.E`. */
export function cardElement(props, o) {
  const { E, id, width, send } = o
  // every run of words the view drew (a label, a bar, a number) takes a click: the item it stands in when the card's
  // keys select one there (runner.mjs pick), else a side thread about the run (draw.ts). Each run shows it is
  // clickable under the pointer: thimble's tint behind it (`tint`, the citations' hover, for the theme the drawing is in) and its words
  // underlined; a bar of glyphs, which fills its cells and so hides a tint, takes thimble's color (`accent`) in place of
  // its own. Never Claude Code's inverse of a plain Button. The Button holds only the run's one Text, as a Button holds
  // strings and Text only (Claude Code draws no Button that holds a Box), so wrapping a run never breaks a card that
  // drew without it. Not inside the view's own Buttons (a Button around lines is a Box with onPress), and not at all on
  // a card that reads clicks by cell (the runner marks its tree `cells`), so the view's clicks come first, or on a card
  // whose drawing is more than Claude Code draws with them (the runner marks its tree `bare`)
  const bare = !!(props?.tree && typeof props.tree === 'object' && (props.tree.p?.cells || props.tree.p?.bare))
  let asks = 0
  const tint = typeof props?.tint === 'string' && props.tint ? { backgroundColor: props.tint } : {}
  const accent = typeof props?.accent === 'string' && props.accent ? props.accent : ''
  /** A run of words (a Text's props and children) that takes a click; `text` its words, `path` its place in the
   *  tree. */
  const askable = (p, children, text, line, path) => {
    if (!text.trim()) return E.Text({ ...p, children })
    const key = `ask-${++asks}`
    const scope = `${id}-${key}`
    const words = /[\p{L}\p{N}]/u.test(text)
    const look = words ? { underline: true, ...tint } : accent ? { color: accent } : tint
    return E.Button({
      key, plain: true, label: `ask about ${text.trim().slice(0, 60)}`,
      hover: { scope, inverse: false, ...look },
      onPress: () => send({ ask: { text, line, path }, width }),
      children: [E.Text({ ...p, hover: { scope, ...look }, children })],
    })
  }
  // the screen's ground for the drawing's theme (core/theme.ts), which a bar's cells move toward under the pointer
  const ground = props?.theme === 'light' ? [255, 255, 255] : [30, 30, 30]
  /** A bar's color as the highlight draws it: its hex moved most of the way to the ground, so on the highlight (the
   *  inverse of the words) the bar reads inverted and stays in view; a color by name keeps itself. */
  const inverted = color => {
    const m = /^#([0-9a-f]{6})$/i.exec(color)
    if (!m) return color
    const rgb = [0, 2, 4].map((i, k) => Math.round(parseInt(m[1].slice(i, i + 2), 16) * 0.45 + ground[k] * 0.55))
    return `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`
  }
  /** A Button's children, drawn as in a Text: while the pointer is on the Button (`scope`) the whole row shows
   *  highlighted, each run of words inverse and each run of glyphs in a color (a bar) inverted on the highlight's
   *  ground (Claude Code's inverse of a bar's block cells would turn them into the background's color). `color`: the
   *  color the run inherits. A bar of blocks in no color keeps its look. */
  const lit = (c, scope, color = '') => (Array.isArray(c) ? c : []).map(k => {
    if (typeof k === 'string') {
      if (/[\p{L}\p{N}]/u.test(k) || (!color && !/[\u2580-\u259f]/.test(k))) return E.Text({ hover: { scope, inverse: true }, children: k })
      return color ? E.Text({ hover: { scope, color: inverted(color), backgroundColor: 'text' }, children: k }) : k
    }
    if (k && typeof k === 'object' && k.t === 'Text') {
      const p = pick(k.p, TEXT)
      return E.Text({ ...p, children: lit(k.c, scope, typeof p.color === 'string' ? p.color : color) })
    }
    return null
  }).filter(x => x != null)
  const kids = (c, inText, line = '', owned = false, path = []) => (Array.isArray(c) ? c : []).map((k, i) => draw(k, inText, line, owned, [...path, i])).filter(x => x != null)
  function draw(n, inText, line = '', owned = false, path = []) {
    if (typeof n === 'string') return inText ? n : owned || bare ? E.Text({ children: n }) : askable({}, [n], n, line || n, path)
    if (!n || typeof n !== 'object') return null
    if (n.t === 'Text') {
      if (inText || owned || bare) return E.Text({ ...pick(n.p, TEXT), children: kids(n.c, true) })
      const text = wordsOf(n)
      return askable(pick(n.p, TEXT), kids(n.c, true), text, line || text, path)
    }
    if (inText) return null
    if (n.t === 'Button') {
      const press = n.p?.onPress
      const key = typeof n.p?.key === 'string' ? `k${n.p.key}` : `b${String(press)}`
      // under the pointer, the Button's words show inverse and its runs of glyphs (a bar) inverted (lit): Claude
      // Code's inverse of the whole Button would turn a bar's cells into the background's color
      const scope = `${id}-${key}`
      return E.Button({
        ...pick(n.p, BUTTON), key,
        hover: { scope, inverse: false },
        onPress: () => { if (typeof press === 'number') send({ press, width }) },
        children: lit(n.c, scope),
      })
    }
    if (n.t === 'Box') {
      // a row's runs each ask about themselves on that row's line (a bar beside its label and number)
      const row = n.p?.flexDirection !== 'column' && n.p?.flexDirection !== 'column-reverse'
      // a border the view gives no color of its own is a hairline, dim as the card's own frame at rest
      const p = pick(n.p, BOX)
      if (typeof p.borderStyle === 'string' && p.borderColor === undefined && p.borderDimColor === undefined) p.borderDimColor = true
      return E.Box({ ...p, children: kids(n.c, false, row ? line || wordsOf(n) : '', owned || typeof n.p?.onPress === 'number', path) })
    }
    return null
  }

  // the region the card's tree is laid out in, as layout.js's cardRoot lays it out for the text copy: what is wider is
  // cut at its edge, as the copy says, so a view never draws over the frame. The frame hands only a drawing laid out at
  // this width (draw.ts), and none while that drawing comes; should the region still be narrower (the frame squeezed
  // in a chat narrower than it was told), the tree keeps its width and is cut at the region's edge: no row of it wraps
  const tree = props?.tree ? draw(props.tree, false) : E.Text({ dimColor: true, children: 'drawing…' })
  const laid = E.Box({ flexDirection: 'column', width, flexShrink: 0, children: [tree] })
  // `cap`: the rows the frame shows of a drawing taller than that (draw.ts CARD_ROWS), the rest cut at their foot
  const cap = Math.max(0, Math.floor(Number(props?.cap) || 0))
  return E.Box({ flexDirection: 'column', width, overflow: 'hidden', ...(cap ? { height: cap } : {}), children: [laid] })
}

/** A Button's handle in the measure, from this number on: Claude Code numbers the handles of a Client in one count that
 *  goes on from drawing to drawing, so a card drawn many times holds numbers longer than its first drawing's. */
const HELD_FROM = 100000

/** Elements that build what Claude Code makes of a Client's drawing (its surface runtime): a Box or a Text as {type,
 *  props, hover, children}, with no value that is null, no `hover` in its props and no key of a Text; a Button as {type,
 *  props: {key, label, plain, dimColor, variant}, hover, held, children}, its label its words when it has none, its
 *  handler a number (`held`), and no children when one string is its label. Children are flattened, without null,
 *  undefined or booleans, and a number is its string. */
function heldElements() {
  let held = HELD_FROM
  const flat = (c, out = []) => {
    for (const x of Array.isArray(c) ? c : [c]) {
      if (x === null || x === undefined || typeof x === 'boolean') continue
      if (Array.isArray(x)) flat(x, out)
      else out.push(typeof x === 'number' ? String(x) : x)
    }
    return out
  }
  const words = c => c.map(x => (typeof x === 'string' ? x : x?.type === 'Text' && x.children ? words(x.children) : '')).join('')
  const element = type => (p = {}) => {
    const props = {}
    for (const [k, v] of Object.entries(p)) {
      if (k === 'children' || k === 'hover' || k === 'ref' || v === null || v === undefined || typeof v === 'function') continue
      if (k === 'key') {
        if (type === 'Box' && (typeof v === 'string' || typeof v === 'number')) props.key = String(v)
        continue
      }
      props[k] = v
    }
    const c = p.children === undefined ? [] : flat(p.children)
    return { type, ...(Object.keys(props).length ? { props } : {}), ...(p.hover ? { hover: { ...p.hover } } : {}), ...(c.length ? { children: c } : {}) }
  }
  return {
    Box: element('Box'),
    Text: element('Text'),
    Button(p = {}) {
      const c = p.children === undefined ? [] : flat(p.children)
      const one = p.label === undefined && c.length === 1 && typeof c[0] === 'string'
      const label = p.label ?? (c.length ? words(c) : undefined)
      const props = { key: p.key ?? (one || !c.length ? label : p.label), label }
      if (p.plain === true) props.plain = true
      if (typeof p.dimColor === 'boolean') props.dimColor = p.dimColor
      if (p.variant === 'primary' || p.variant === 'secondary') props.variant = p.variant
      return { type: 'Button', props, ...(p.hover ? { hover: { ...p.hover } } : {}), held: ++held, ...(!one && c.length ? { children: c } : {}) }
    },
  }
}

/** The characters of Claude Code's text of the Client's drawing of `tree` at `width`, with the props the hooks give
 *  the Client at their longest (draw.ts propsAt: a tint as hex, thimble's accent by its name in core/theme.ts, a cap of
 *  two digits) and an instance id of 8 characters. */
export function drawnSize(tree, width) {
  const props = { tree, width, tint: '#000000', accent: 'merged', theme: 'dark', cap: 99 }
  return JSON.stringify(cardElement(props, { E: heldElements(), id: 'i'.repeat(8), width, send: () => undefined })).length
}
