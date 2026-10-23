// runner.mjs: the card runner. One Node process per session runs every card's view, keeps each card's state and
// handlers, and makes the text copy of what a card draws. The hooks (ask.ts) start it and talk to it over a Unix socket.
//
//   sandbox/run.mjs --srt <srt> <rules> -- env -i PATH=… node --permission --allow-fs-read=<plugin>/cards
//        --allow-fs-read=<plugin>/core/text.js --allow-fs-read=<cards of the session> --allow-fs-write=<its folder>
//        --disallow-code-generation-from-strings --max-old-space-size=1024 runner.mjs <socket>
//
// The boundary is Anthropic's sandbox runtime (srt: bubblewrap on Linux, Seatbelt on macOS) the process runs in
// (argv.mjs gives its rules): it has no network, reads only the runner's code, the card copies and the Node it runs on,
// and writes only its own folder, which holds its socket. In it the process starts with an empty environment, and Node's
// permission model keeps its reads to the same code and copies. Each card version runs in a `vm` context of its own,
// which keeps the cards apart: it holds only the JavaScript built-ins, the card's rows (JSON text, parsed inside the
// context) and the view's source compiled as a function. Only strings cross between this process and a context: the
// request goes in as JSON text, the drawing comes out as JSON text, and every exception is caught inside the context and
// said as text. Code generation from strings is off (no eval, no Function), there are no timers, and each call has a
// time limit. The context keeps the card's state and its handlers (a Button's onPress, the onPointer and onKey
// listeners) between calls.
//
// Requests are POST /<op> with a JSON body; each answers JSON: {ok: true, ...} or {ok: false, error}.
//   load     {id, version, title, view, rows, state, width, beside}  a new version from its view source and rows file;
//            answers the tree, state, keys, the rows' summary and the text copy, and the copy at `beside` (the width a
//            side pane leaves it) when texts wrap there. A version that fails keeps the old one.
//   draw     {id, width}              the tree at a width, which the card is drawn at from now on
//   copy     {id, width}              the text copy at a width; the card stays as it is
//   key      {id, key}                the view's onKey; `handled` says whether it has one
//   press    {id, button}             a Button's onPress, by the number the tree gives it
//   pointer  {id, down, up}           a click: on a Button that holds lines, its onPress; else the onPointer listener
//                                     gets the down, then the up
//   undo     {id, n}                  the state as it was before the last n keys
//   act      {id, actions, width}     keys and clicks in order, a text copy after each, then the card as it was
//   ping
// Any request may also name `theme`, 'dark' or 'light' (Claude Code's theme): the palette surface.colors gives every
// card from then on (the hooks send it with each request, and draw the cards again when it changes).
// Each event answers the plain tree (`{t, p, c}`: Box, Text and Button nodes, a Button's onPress a number), and the state
// to keep. A card the runner does not hold answers {ok: false, missing: true}: the hooks load it again from its copy.
// Every answer carries `seq`, which grows with each request, so the hooks keep the newest drawing when two answers come
// back out of order.
//
// The tree holds only what Claude Code's Client draws: a Button's children are strings and Text, and a Text's are
// strings and Text (anything else is the view's error, said to Claude, as Claude Code would refuse to draw it), and a
// string holds no control character but a line break (the others are taken out; a tab is a space). A Button around
// lines (a Box, or several) becomes a column Box with the Button's onPress number, and a click on its cells presses it.
// A dense card gets blank rows between its parts (space.js), unless the view reads clicks by cell (surface.onPointer);
// each version keeps the places its first drawing gave them, so a key never moves the card's rows.
import fs from 'node:fs'
import http from 'node:http'
import { types } from 'node:util'
import vm from 'node:vm'

import { buttonText, layoutLines, pressAt } from './layout.js'
import { spaced } from './space.js'

const LOAD_MS = 5000
// the terminal theme the cards draw for (surface.colors), as the newest request named it: 'dark' or 'light'
let theme = 'dark'
const EVENT_MS = 1000
// Claude Code takes a Client's props, and the tree the Client draws, up to 100000 characters each; the Client's tree
// spells each node out (type, props, children), so the cap is measured on that form (drawnSize)
const MAX_TREE = 95000
const MAX_VIEW = 60000

// ------------------------------------------------------------------------------------------------- static check

/** Whether a `/` that follows `before` (the code so far) starts a regular expression rather than a division: after
 *  an operator, an opening bracket, a comma or a keyword such as `return`, or at the start. */
function regexAt(before) {
  const t = before.trimEnd()
  return !t || /[(,=:[!&|?{};+\-*%<>~^]$/.test(t) || /(^|[^\w$])(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(t)
}

/** The view's code with strings, template text, regular expressions and comments taken out, so a word inside them
 *  does not count. */
function scrub(src) {
  let out = ''
  let i = 0
  const n = src.length
  const tpl = []
  let depth = 0
  const template = () => {
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue }
      if (src[i] === '`') { i++; out += '""'; return }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; tpl.push(depth); depth++; out += '('; return }
      i++
    }
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; out += ' '; continue }
    if (c === '"' || c === "'") { i++; while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++ } i++; out += '""'; continue }
    if (c === '`') { i++; template(); continue }
    if (c === '/' && regexAt(out)) {
      let inClass = false
      i++
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
        else if (src[i] === '/' && !inClass) { i++; break }
        i++
      }
      while (i < n && /[a-z]/.test(src[i])) i++
      out += '""'
      continue
    }
    if (c === '{') depth++
    if (c === '}') { depth--; if (tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); i++; out += ')'; template(); continue } }
    out += c
    i++
  }
  return out
}

/** What the view must not hold, as a friendly early error; the sandbox holds the view, not this check. */
export function checkView(src) {
  const bad = []
  if (src.length > MAX_VIEW) bad.push(`the view is ${src.length} characters; at most ${MAX_VIEW}`)
  const code = scrub(src)
  for (const w of ['import', 'export', 'require', 'globalThis', 'process']) {
    if (new RegExp(`(^|[^A-Za-z0-9_$.])${w}(?![A-Za-z0-9_$])(?!\\s*:(?!:))`).test(code)) bad.push(`\`${w}\` is not allowed`)
  }
  for (const w of ['eval', 'Function']) if (new RegExp(`(^|[^A-Za-z0-9_$])${w}\\s*(\\)\\s*)?\\(`).test(code)) bad.push(`calling \`${w}(\` is not allowed`)
  if (!/function\s+view\s*\(/.test(src)) bad.push('define `function view(props, surface)`')
  return bad
}

// ------------------------------------------------------------------------------------------------- inside a context

// The code each context runs first. It defines one global that cannot be changed, __thimble, whose call(op, json)
// answers JSON text. It holds the rows, the state, the width, the handlers of the last drawing and the
// view's functions. The rows' text is the one value put on the context's global from outside, before any code of the
// view has run; init takes it off.
const PRELUDE = new vm.Script(String.raw`
Object.defineProperty(this, '__thimble', { writable: false, configurable: false, value: (function () {
  'use strict'
  const parse = JSON.parse, stringify = JSON.stringify, isArray = Array.isArray, keysOf = Object.keys, freeze = Object.freeze
  const Str = String, toNumber = Number, finite = isFinite
  const PROPS = {
    Box: ['flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent', 'gap',
      'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight', 'margin', 'marginX', 'marginY', 'marginTop',
      'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom',
      'paddingLeft', 'paddingRight', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow',
      'display', 'position', 'top', 'left', 'right', 'bottom'],
    Text: ['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap'],
    Button: ['label', 'plain', 'dimColor', 'variant'],
  }
  const BORDERS = ['single', 'double', 'round', 'bold', 'singleDouble', 'doubleSingle', 'classic', 'arrow', 'dashed', 'quote']
  let rows = [], data = null, title = '', state, columns = 80
  let fns = null, pointer = null, keyListener = null, handlers = [], dirty = false, nodes = 0, notes = []
  // the state before each of the last keys, newest last, for undo; any other event of the person's ends it
  let undoable = []
  const element = t => function (props) {
    const p = props && typeof props === 'object' ? props : {}
    if (arguments.length > 1) {
      const more = []
      for (let i = 1; i < arguments.length; i++) more.push(arguments[i])
      return { type: t, props: Object.assign({}, p, { children: more }) }
    }
    return { type: t, props: p }
  }
  const elements = freeze({ Box: element('Box'), Text: element('Text'), Button: element('Button') })
  // the card palette: browser mode's chart colors (browser/frontend/src/styles/tokens.css), one set for each terminal
  // theme, the one Claude Code's theme names (the request's theme, 'dark' or 'light'). On dark, the Dark paper's
  // chart steps lightened toward its pastel step and a little desaturated, so they read calm on a black background; on
  // light, the light papers' strong step, deep enough for a white one. The categories keep the browser's families in a
  // fixed order (blue, orange, teal, pink, gold), with no violet, which is thimble's purple for agents' work and
  // citations, and no green or red, which mean success and failure (good and bad: the papers' status colors). seq(t)
  // runs from a blue-gray (0) to the first category's blue (1), its lightness rising on dark and falling on light, so
  // more reads as stronger on both; gray is --viz-ink-3 for context.
  const PALETTES = freeze({
    dark: freeze({
      cat: freeze(['#80b2ea', '#ed9a6b', '#6fd0cc', '#ed95ba', '#f0ca78']),
      seq: ['#5f6670', '#636f7e', '#68788d', '#6c829c', '#708bab', '#7495bb', '#789fca', '#7ca8da', '#80b2ea'],
      gray: '#85827a',
      good: '#67cda8',
      bad: '#f59183',
    }),
    light: freeze({
      cat: freeze(['#0471c8', '#e26101', '#018d82', '#c8367b', '#a08319']),
      seq: ['#9aa1ab', '#8c9cb0', '#7e96b4', '#6f91b8', '#608bbb', '#5085bf', '#3e7fc2', '#2978c5', '#0471c8'],
      gray: '#a19d94',
      good: '#0b7c5f',
      bad: '#c93a28',
    }),
  })
  let theme = 'dark'
  const hex2 = (a, b, f) => {
    let out = '#'
    for (let i = 1; i < 7; i += 2) {
      const x = parseInt(a.slice(i, i + 2), 16), y = parseInt(b.slice(i, i + 2), 16)
      out += Math.round(x + (y - x) * f).toString(16).padStart(2, '0')
    }
    return out
  }
  // read at each use, so a view that draws again after the theme changed draws in the new set
  const colors = freeze({
    get cat() { return PALETTES[theme].cat },
    seq(t) {
      const SEQ = PALETTES[theme].seq
      const v = typeof t === 'number' && t === t ? Math.max(0, Math.min(1, t)) : 0
      const at = v * (SEQ.length - 1), i = Math.min(SEQ.length - 2, Math.floor(at))
      return hex2(SEQ[i], SEQ[i + 1], at - i)
    },
    get gray() { return PALETTES[theme].gray },
    get good() { return PALETTES[theme].good },
    get bad() { return PALETTES[theme].bad },
  })
  // a number as a card writes it: thousands separated by commas (2,327), at most the digits given as decimals (2 when not given,
  // trailing zeros dropped), so the view does not write the digits of a count by hand
  function num(n, digits) {
    const v = typeof n === 'number' ? n : typeof n === 'string' && n.trim() !== '' ? toNumber(n) : NaN
    if (!finite(v)) return Str(n)
    const d = typeof digits === 'number' && digits >= 0 ? Math.min(20, Math.trunc(digits)) : 2
    let t = Math.abs(v).toFixed(d)
    if (typeof digits !== 'number' && t.indexOf('.') >= 0) t = t.replace(/\.?0+$/, '')
    const dot = t.indexOf('.'), whole = dot < 0 ? t : t.slice(0, dot)
    const out = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dot < 0 ? '' : t.slice(dot))
    return (v < 0 && /[1-9]/.test(t) ? '-' : '') + out
  }
  const surface = freeze({
    elements,
    colors,
    num,
    get state() { return state },
    setState(next) { state = next; dirty = true },
    get columns() { return columns },
    onPointer(fn) { pointer = typeof fn === 'function' ? fn : null; return () => { pointer = null } },
    onKey(fn) { keyListener = typeof fn === 'function' ? fn : null; return () => { keyListener = null } },
  })
  const props = () => ({ title, rows, data, columns })
  // the characters a terminal would act on instead of drawing: C0 and C1 controls but the line break; a tab is a space
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
  const clean = v => Str(v).replace(/\t/g, ' ').replace(CONTROL, '')
  const said = n => n && typeof n === 'object' && typeof n.type === 'string' ? '<' + n.type + '>' : typeof n

  // On the light theme a terminal draws the shade glyphs ░ ▒ ▓ as a quarter, a half and three quarters of
  // the text's color over the white background, so a ░ in a light color (gray, the start of seq) almost vanishes.
  // There each run of shade glyphs is drawn as █ in a mixed color instead: ░ the least share of the color that keeps
  // 2:1 contrast on white, ▒ and ▓ evenly between it and the color, so the shades keep their order and the faintest
  // shows. Text without a color mixes the light theme's ink. The dark theme keeps the glyphs.
  const SHADES = /[\u2591-\u2593]+/g, SHADE = /[\u2591-\u2593]/, HEX = /^#[0-9a-fA-F]{6}$/, INK = '#000000', WHITE = '#ffffff'
  const lum = h => {
    let s = 0
    for (let i = 0; i < 3; i++) {
      const v = parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16) / 255
      s += [0.2126, 0.7152, 0.0722][i] * (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
    }
    return s
  }
  const onWhite = h => 1.05 / (lum(h) + 0.05)
  const shadeCache = Object.create(null)
  function shades(color) {
    if (shadeCache[color]) return shadeCache[color]
    let lo = 0, hi = 1
    if (onWhite(color) < 2) lo = 0.55
    else for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (onWhite(hex2(WHITE, color, m)) >= 2) hi = m; else lo = m }
    const a = onWhite(color) < 2 ? lo : hi
    return (shadeCache[color] = [0, 1, 2].map(k => hex2(WHITE, color, a + (1 - a) * k / 3)))
  }
  function shaded(c, ink) {
    if (theme !== 'light' || !ink || ink.plain) return c
    const color = ink.color === undefined ? INK : ink.color
    if (!HEX.test(color)) return c
    const out = []
    for (const x of c) {
      if (typeof x !== 'string' || !SHADE.test(x)) { out.push(x); continue }
      let at = 0
      x.replace(SHADES, (run, i) => {
        if (i > at) out.push(x.slice(at, i))
        let k = 0
        while (k < run.length) {
          let j = k
          while (j < run.length && run[j] === run[k]) j++
          out.push({ t: 'Text', p: { color: shades(color)[run.charCodeAt(k) - 0x2591] }, c: ['\u2588'.repeat(j - k)] })
          k = j
        }
        at = i + run.length
        return run
      })
      if (at < x.length) out.push(x.slice(at))
    }
    return out
  }
  // the view's drawing as a plain tree: Box, Text and Button nodes with the props each takes; a Button's onPress
  // becomes a number, the handler kept here
  function kids(c, depth, inText, out, ink) {
    if (c == null || c === false || c === true) return out
    if (isArray(c)) { for (const x of c) kids(x, depth, inText, out, ink); return out }
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'bigint') { out.push(inText ? clean(c) : { t: 'Text', p: {}, c: shaded([clean(c)], {}) }); return out }
    const n = node(c, depth, inText, ink)
    if (n) out.push(n)
    return out
  }
  // a Box or a Button among the children: then a Button is a group of lines (a row, a heading and its bars), which
  // Claude Code's Button cannot hold
  function holdsBoxes(c) {
    if (isArray(c)) { for (const x of c) if (holdsBoxes(x)) return true; return false }
    return !!c && typeof c === 'object' && (c.type === 'Box' || c.type === 'Button')
  }
  function node(n, depth, inText, ink) {
    if (!n || typeof n !== 'object' || depth > 30) return null
    let t = n.type
    if (t !== 'Box' && t !== 'Text' && t !== 'Button') return null
    const group = t === 'Button' && !inText && holdsBoxes(n.props && n.props.children)
    if (inText && t !== 'Text') throw new Error('a ' + inText + ' holds ' + said(n) + ', and Claude Code draws only strings and Text inside a ' + inText + ': put the ' + inText + ' inside the Box instead')
    if (++nodes > 20000) throw new Error('the drawing has more than 20000 elements; draw fewer rows (show a page of them)')
    const src = n.props && typeof n.props === 'object' ? n.props : {}
    const p = {}
    for (const k of PROPS[t]) {
      const v = src[k]
      if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity)) p[k] = v
    }
    if (t === 'Box' && 'borderStyle' in p && BORDERS.indexOf(p.borderStyle) < 0) {
      const note = 'borderStyle "' + Str(p.borderStyle).slice(0, 40) + '" is not a border style (' + BORDERS.join(', ') + '), so that Box has no border'
      if (notes.indexOf(note) < 0) notes.push(note)
      delete p.borderStyle
    }
    if (t === 'Button') {
      if (typeof src.onPress === 'function') { handlers.push(src.onPress); p.onPress = handlers.length - 1 }
      if (typeof src.key === 'string' || typeof src.key === 'number') p.key = Str(src.key)
      if (typeof p.label === 'string') p.label = clean(p.label)
    }
    if (group) {
      // a Button around lines is a column Box that keeps the Button's onPress: a click anywhere on it presses it
      // (pressAt in layout.js reads the click's cell)
      const c = kids(src.children, depth + 1, false, [])
      return { t: 'Box', p: Object.assign({ flexDirection: 'column' }, 'onPress' in p ? { onPress: p.onPress } : {}), c }
    }
    // the color a Text's strings draw in, which its Texts inherit; on a background or inverted, shades stay glyphs
    const own = t === 'Text' ? { color: 'color' in p ? p.color : ink && ink.color, plain: !!(p.backgroundColor || p.inverse || (ink && ink.plain)) } : undefined
    let c = kids(src.children, depth + 1, t === 'Box' ? false : t, [], own)
    if (own) c = shaded(c, own)
    if (t === 'Button' && !words(c) && !(typeof p.label === 'string' && p.label.trim())) throw new Error('a Button has no words: give it a label, or strings or Text as its children')
    return { t, p, c }
  }
  function words(c) {
    let w = ''
    for (const x of c) w += typeof x === 'string' ? x : words(x.c || [])
    return w.trim()
  }
  function draw() {
    let tree, pass = 0
    do {
      dirty = false
      handlers = []
      tree = fns.view(props(), surface)
      pass++
    } while (dirty && pass < 3)
    nodes = 0
    notes = []
    const c = kids(tree, 0, false, [])
    const root = c.length === 1 && c[0].t === 'Box' ? c[0] : { t: 'Box', p: { flexDirection: 'column' }, c }
    return { tree: root, notes }
  }
  function saved() {
    try { return stringify(state === undefined ? null : state) } catch (e) { throw new Error('the state is not plain JSON: ' + Str(e && e.message)) }
  }
  function where(e) {
    try {
      const m = /view\.js:(\d+):(\d+)/.exec(Str(e && e.stack))
      return m ? 'line ' + m[1] + ': ' : ''
    } catch (_) { return '' }
  }
  function errorOf(e) {
    try { return where(e) + (e && typeof e === 'object' && 'message' in e ? Str(e.message) : Str(e)) } catch (_) { return 'the view threw a value thimble cannot read' }
  }
  function parseRows(text) {
    let v
    try { v = parse(text) } catch (e) {
      const out = []
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim()
        if (!l) continue
        try { out.push(parse(l)) } catch (e2) { throw new Error('the file is not JSON, and its line ' + (i + 1) + ' is not a JSON Lines record') }
      }
      return out
    }
    if (isArray(v)) return v
    if (v && typeof v === 'object') { data = v; return isArray(v.rows) ? v.rows : [] }
    throw new Error('the file is JSON but neither a list of rows nor an object')
  }
  function summary() {
    const cols = []
    const seen = Object.create(null)
    for (const r of rows) if (r && typeof r === 'object' && !isArray(r)) for (const k of keysOf(r)) if (seen[k] !== 1) { seen[k] = 1; cols.push(k) }
    let first = ''
    try { first = rows.length ? stringify(rows[0]) : '' } catch (_) { first = '' }
    const other = data ? keysOf(data).filter(k => k !== 'rows') : []
    // what the card read, in words: its rows, or an object by its keys, each list with its length
    const n = (k, len) => k + ' (' + len + ')'
    const read = data && !isArray(data.rows)
      ? 'an object with ' + keysOf(data).slice(0, 8).map(k => (isArray(data[k]) ? n(k, data[k].length) : k)).join(', ')
      : rows.length + ' row' + (rows.length === 1 ? '' : 's')
    return { rows: rows.length, read, columns: cols.slice(0, 40), first: first.length > 200 ? first.slice(0, 199) + '…' : first, ...(other.length ? { other: other.slice(0, 20), hasRows: isArray(data.rows) } : {}) }
  }
  const OPS = {
    init(a) {
      const view = globalThis.__thimbleView, text = globalThis.__thimbleRows
      delete globalThis.__thimbleView
      delete globalThis.__thimbleRows
      try { rows = parseRows(text) } catch (e) { return { ok: false, phase: 'rows', error: errorOf(e) } }
      title = Str(a.title || '')
      columns = a.width
      state = a.state == null ? undefined : a.state
      let got
      try { got = view() } catch (e) { return { ok: false, phase: 'view', error: errorOf(e) } }
      if (!got || typeof got.view !== 'function') return { ok: false, phase: 'view', error: 'the code defines no function view(props, surface)' }
      fns = got
      return { summary: summary(), keys: typeof got.keys === 'string' ? got.keys : '' }
    },
    draw(a) { if (a.width) columns = a.width; return {} },
    copy() { return {} },
    key(a) {
      const f = typeof fns.onKey === 'function' ? fns.onKey : keyListener
      if (!f) return { handled: false }
      f(a.key, surface, props())
      return { handled: true }
    },
    press(a) {
      const f = handlers[a.button]
      if (typeof f !== 'function') return { handled: false }
      f({})
      return { handled: true }
    },
    pointer(a) {
      if (!pointer) return { handled: false }
      const b = a.button || 'left'
      pointer({ type: 'down', x: a.down.x, y: a.down.y, button: b })
      if (pointer) pointer({ type: 'up', x: a.up.x, y: a.up.y, button: b })
      return { handled: true }
    },
    undo(a) {
      const n = Math.min(undoable.length, Math.max(0, Math.trunc(Number(a.n) || 0)))
      if (!n) return {}
      const b = undoable.splice(undoable.length - n)[0]
      state = b === 'null' ? undefined : parse(b)
      return {}
    },
    save() { return { saved: saved() } },
    restore(a) { state = a.saved == null ? undefined : parse(a.saved); undoable = []; return {} },
  }
  // a drawing at another width, for a text copy: the card keeps its width and the handlers of the tree on screen
  function peek(width) {
    const was = columns, kept = handlers
    columns = width
    try { return draw() } finally { columns = was; handlers = kept }
  }
  // an event the view fails on is undone: the card keeps the state, the width and the handlers it had before it, so
  // it draws and takes keys as before (a drawing that fails at a narrow width leaves the card at its last width)
  function call(op, json) {
    let before = null
    const was = columns, kept = handlers
    try {
      if (op === 'key' || op === 'press' || op === 'pointer') before = saved()
      const a = parse(json)
      if (a.theme === 'dark' || a.theme === 'light') theme = a.theme
      const r = OPS[op](a)
      if (r.ok === false) return stringify(r)
      if (op === 'key') undoable = undoable.concat([before]).slice(-16)
      else if (before) undoable = []
      const d = op === 'copy' ? peek(a.width) : draw()
      return stringify(Object.assign({ ok: true }, r, { tree: d.tree, notes: d.notes, state: saved(), cells: !!pointer }))
    } catch (e) {
      try {
        columns = was
        handlers = kept
        if (before) state = before === 'null' ? undefined : parse(before)
        return stringify({ ok: false, phase: op === 'init' ? 'view' : op, error: errorOf(e) })
      } catch (_) { return '{"ok":false,"error":"the view failed"}' }
    }
  }
  return freeze({ call })
})() })
`, { filename: 'prelude.js' })

// what the view's function gives back: its view, its onKey and its keys, whichever it defines
const TAIL = "\n;return { view: typeof view === 'function' ? view : undefined, onKey: typeof onKey === 'function' ? onKey : undefined, keys: typeof keys === 'string' ? keys : '' }"

/** A JSON answer from inside a context, or the error that stopped it. The request is written into the script as a
 *  string literal, so nothing of this process is put where the view's code could reach it, and only a string comes
 *  out. The context catches every exception of the view, and undoes the event it failed on; what still arrives here is
 *  the vm's own (the time limit), or a value of the view's, which is never read (reading it could run the view's code
 *  outside the time limit). Two failures happen where the context cannot undo them: the time limit stops the view
 *  part way, and a drawing too big is refused after the context kept it. Then the card leaves the runner (drop), and
 *  the next request loads it again from its copy on disk, with the state and the width it last drew (draw.ts askCard). */
function inContext(card, op, args, ms) {
  let out
  try {
    out = vm.runInContext(`__thimble.call(${JSON.stringify(op)}, ${JSON.stringify(JSON.stringify({ ...args, theme }))})`, card.ctx, { filename: 'call.js', timeout: ms })
  } catch (e) {
    // the vm makes its time-limit error in the context's realm: its own `code` is read as data, never through a getter
    const code = e && typeof e === 'object' && !types.isProxy(e) ? Object.getOwnPropertyDescriptor(e, 'code') : undefined
    drop(card)
    return { ok: false, phase: op, error: code && code.value === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? `the view ran past its ${ms / 1000} s limit` : 'the view stopped the card' }
  }
  if (typeof out !== 'string' || out.length > 4 * MAX_TREE) {
    drop(card)
    return { ok: false, phase: op, error: 'the view gave no drawing thimble can read' }
  }
  const r = JSON.parse(out)
  // blank rows between the card's parts (space.js), in the places the version's first drawing gave them, so no key moves
  // them; a view that reads clicks by cell keeps its rows where it drew them
  if (r.ok && r.tree && !r.cells) r.tree = spaced(r.tree, Number(args.width) || card.width || 80, card.plan)
  // and its tree says so (`cells` on its top node), so the Client leaves its clicks to the view (client.tsx)
  else if (r.ok && r.tree && typeof r.tree === 'object') r.tree = { ...r.tree, p: { ...(r.tree.p || {}), cells: true } }
  delete r.cells
  if (r.ok && drawnSize(r.tree) > MAX_TREE) {
    drop(card)
    return { ok: false, phase: op, error: `the drawing is more than ${MAX_TREE} characters as Claude Code holds it, which it does not draw; draw fewer elements: group the rows, or show a page of them` }
  }
  return r
}

/** The card out of the runner, when its context may hold what a failed event left. */
function drop(card) {
  if (cards.get(card.id) === card) cards.delete(card.id)
}

/** The characters a plain tree takes as the Client draws it (client.tsx): each node as {type, props: {...p, key?,
 *  children}}, a Button with its key. */
export function drawnSize(tree) {
  const el = n => (typeof n === 'string' ? n : n && typeof n === 'object'
    ? { type: n.t, props: { ...(n.p || {}), ...(n.t === 'Button' ? { key: `b${n.p?.onPress ?? ''}` } : {}), children: (n.c || []).map(el) } }
    : null)
  return JSON.stringify({ type: 'Box', props: { flexDirection: 'column', width: 0, children: [el(tree)] } }).length
}

// ------------------------------------------------------------------------------------------------- the cards

const cards = new Map()
// the requests answered, for each answer's `seq`
let answered = 0

/** The text copy of a tree at a width. */
function copy(tree, width) {
  return layoutLines(tree, width)
}

function load(a) {
  const view = String(a.view ?? '')
  const bad = checkView(view)
  if (bad.length) return { ok: false, phase: 'view', error: bad.join('; ') }
  let text
  try {
    text = fs.readFileSync(String(a.rows), 'utf8')
  } catch (e) {
    return { ok: false, phase: 'rows', error: `the card's copy of the rows cannot be read (${e.code || e.message})` }
  }
  const ctx = vm.createContext(Object.create(null), {
    name: `card ${a.id}`,
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  })
  PRELUDE.runInContext(ctx, { timeout: EVENT_MS })
  try {
    ctx.__thimbleView = vm.compileFunction(view + TAIL, [], { parsingContext: ctx, filename: 'view.js' })
    ctx.__thimbleRows = text
  } catch (e) {
    const line = /view\.js:(\d+)/.exec(String(e.stack))?.[1]
    return { ok: false, phase: 'view', error: `the view does not parse${line ? ` (line ${line})` : ''}: ${e.message}` }
  }
  const card = { id: a.id, ctx, version: a.version, width: a.width, tree: null, view, plan: new Map() }
  const r = inContext(card, 'init', { title: a.title, state: a.state ?? null, width: a.width }, LOAD_MS)
  if (!r.ok) return r
  card.tree = r.tree
  cards.set(a.id, card)
  const own = copy(r.tree, a.width)
  return { ...r, ...own, ...besideOf(card, own, Number(a.beside) || 0) }
}

/** The copy at `width`, the narrower width a side pane leaves the card, when a row that fits at the card's width wraps
 *  there: `beside: {width, lines, cut, wrapped}`, `wrapped` the numbers of the lines they start on. A row laid out for
 *  the wider card (fixed columns, parts side by side: layout.js `row`) breaks its columns there, and Claude sees it
 *  before the person does. A sentence that wraps on its own line reads the same at either width, so it alone brings
 *  nothing back, and no reason for a new version. Nothing when no row wraps, or the view fails at that width (it is
 *  told when the card draws there). */
function besideOf(card, own, width) {
  if (!width || width >= card.width) return {}
  const r = inContext(card, 'copy', { width }, EVENT_MS)
  if (!r.ok) return {}
  const c = copy(r.tree, width)
  const before = new Set(own.wrapped.map(w => w.text))
  const wrapped = [...new Set(c.wrapped.filter(w => w.row && !before.has(w.text)).map(w => w.line))]
  return wrapped.length ? { beside: { width, lines: c.lines, cut: c.cut, wrapped } } : {}
}

/** A click: a Button around lines that holds the cell where it ended, else the view's onPointer listener. */
function click(card, at) {
  const press = pressAt(card.tree, card.width, at.up.x, at.up.y)
  return press === null ? inContext(card, 'pointer', at, EVENT_MS) : inContext(card, 'press', { button: press }, EVENT_MS)
}

function event(a, op, args) {
  const card = cards.get(a.id)
  if (!card) return { ok: false, missing: true }
  const r = inContext(card, op, args, EVENT_MS)
  if (r.ok) card.tree = r.tree
  return r
}

/** The text copy of a card at a width; the card stays as it is. */
function textCopy(a) {
  const card = cards.get(a.id)
  if (!card) return { ok: false, missing: true }
  const width = Number(a.width) || card.width
  const r = inContext(card, 'copy', { width }, EVENT_MS)
  return r.ok ? { ok: true, ...copy(r.tree, width) } : r
}

/** The first Button whose words hold `words`, in a plain tree (a Button around lines too): its onPress number. */
function buttonWith(n, words) {
  if (!n || typeof n !== 'object') return null
  if (typeof n.p?.onPress === 'number' && (n.t === 'Button' ? buttonText(n.p, n.c) : layoutLines(n, 1000).lines.join(' ')).includes(words)) return n.p.onPress
  for (const k of n.c || []) {
    const f = buttonWith(k, words)
    if (f !== null) return f
  }
  return null
}

function act(a) {
  const card = cards.get(a.id)
  if (!card) return { ok: false, missing: true }
  card.width = a.width || card.width
  const before = inContext(card, 'save', {}, EVENT_MS)
  if (!before.ok) return before
  const copies = []
  for (const x of (Array.isArray(a.actions) ? a.actions : []).slice(0, 12)) {
    let r
    let what
    if (x && typeof x.key === 'string' && x.key.length) {
      what = `key ${x.key.slice(0, 1)}`
      r = inContext(card, 'key', { key: x.key.slice(0, 1) }, EVENT_MS)
      if (r.ok && !r.handled) r.note = 'the card takes no keys (define onKey)'
    } else if (x && typeof x.click === 'string') {
      what = `click on "${x.click.slice(0, 60)}"`
      const button = buttonWith(card.tree, x.click)
      r = button === null ? { ok: true, tree: card.tree, note: `no Button shows "${x.click.slice(0, 60)}"` } : inContext(card, 'press', { button }, EVENT_MS)
    } else if (x && Array.isArray(x.click) && x.click.length === 2) {
      const at = { x: Math.trunc(Number(x.click[0]) || 0), y: Math.trunc(Number(x.click[1]) || 0) }
      what = `click at ${at.x},${at.y}`
      r = click(card, { down: at, up: at })
      if (r.ok && !r.handled) r.note = 'a click at a cell reaches a Button around lines or an onPointer listener, and the view has neither there'
    } else {
      copies.push({ what: JSON.stringify(x).slice(0, 80), error: 'not a key or a click' })
      continue
    }
    if (r.ok) {
      card.tree = r.tree
      copies.push({ what, note: r.note, ...copy(r.tree, card.width) })
    } else copies.push({ what, error: r.error })
  }
  const back = inContext(card, 'restore', { saved: before.saved }, EVENT_MS)
  if (back.ok) card.tree = back.tree
  return { ok: true, copies, tree: card.tree, state: back.ok ? back.state : before.saved }
}

const OPS = {
  ping: () => ({ ok: true }),
  load,
  draw: a => {
    const r = event(a, 'draw', { width: a.width })
    if (r.ok && a.width) cards.get(a.id).width = a.width
    return r
  },
  copy: textCopy,
  key: a => event(a, 'key', { key: String(a.key ?? '').slice(0, 1) }),
  press: a => event(a, 'press', { button: Number(a.button) }),
  pointer: a => {
    const card = cards.get(a.id)
    if (!card) return { ok: false, missing: true }
    const r = click(card, { down: a.down, up: a.up ?? a.down, button: a.button })
    if (r.ok) card.tree = r.tree
    return r
  },
  undo: a => event(a, 'undo', { n: Number(a.n) || 0 }),
  act,
}

// ------------------------------------------------------------------------------------------------- the socket

// A view's own code can leave a rejected promise or throw from a microtask (a bare `Promise.reject`, an async built-in
// such as WebAssembly.compile whose rejection no one awaits). Node makes an unhandled rejection or an uncaught
// exception fatal by default, which would end the one runner for every card in the session. The runner awaits all its
// own promises and wraps each request in try/catch, so what still reaches here comes from a card's code; it is already
// contained (the card's own call answered, or will time out), so the process stays up and the card draws on. A card
// cannot take the runner down this way.
process.on('unhandledRejection', () => {})
process.on('uncaughtException', () => {})

function serve(sock) {
  try { fs.unlinkSync(sock) } catch { /* no socket left from an earlier runner */ }
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', d => { body += d })
    req.on('end', () => {
      const op = String(req.url || '').replace(/^\/+/, '')
      let out
      try {
        const a = JSON.parse(body || '{}')
        if (a && (a.theme === 'dark' || a.theme === 'light')) theme = a.theme
        out = Object.hasOwn(OPS, op) ? OPS[op](a) : { ok: false, error: `no request ${op}` }
      } catch (e) {
        out = { ok: false, error: `the runner failed: ${e && e.message}` }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ...out, seq: ++answered }))
    })
  })
  // a socket the runner cannot make (its folder is not writable, say) is said, and the runner ends: the hooks then say
  // why it did not start, where the guard below would keep it running with no socket
  server.on('error', e => {
    process.stderr.write(`the card runner cannot listen on ${sock}: ${e.message}\n`)
    process.exit(1)
  })
  server.listen(sock, () => fs.chmodSync(sock, 0o600))
  // the session that started this runner is gone: so is the runner
  const parent = process.ppid
  setInterval(() => { if (process.ppid !== parent) process.exit(0) }, 2000)
}

if (process.argv[2]) serve(process.argv[2])
