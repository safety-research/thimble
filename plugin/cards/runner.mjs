// runner.mjs: the card runner. One Node process per session runs every card's view, keeps each card's state and
// handlers, and makes the text copy of what a card draws. The hooks (ask.ts) start it and talk to it over a Unix socket.
//
//   node --permission --allow-fs-read=<plugin>/cards --allow-fs-read=<cards of the session> --allow-fs-write=<run dir>
//        runner.mjs <socket>
//
// The process can read the plugin's cards/ folder and the session's card copies, and write only its socket's folder:
// no child process, no worker, no network of its own. Each card version runs in a `vm` context of its own that holds
// only the JavaScript built-ins, the card's rows (JSON text, parsed inside the context) and the view's source compiled
// as a function. Only strings cross between this process and a context: the request goes in as JSON text, the drawing
// comes out as JSON text, and every exception is caught inside the context and said as text. Code generation from
// strings is off (no eval, no Function), there are no timers, and each call has a time limit. The context keeps the
// card's state and its handlers (a Button's onPress, the onPointer and onKey listeners) between calls.
//
// Requests are POST /<op> with a JSON body; each answers JSON: {ok: true, ...} or {ok: false, error}.
//   load     {id, version, title, view, rows, state, query, width}  a new version from its view source and rows file;
//            answers the tree, state, keys, the rows' summary and the text copy. A version that fails keeps the old one.
//   draw     {id, width, text?}       the tree at a width (and its text copy)
//   key      {id, key}                the view's onKey; `handled` says whether it has one
//   press    {id, button}             a Button's onPress, by the number the tree gives it
//   pointer  {id, down, up}           a click: the onPointer listener gets the down, then the up
//   query    {id, text}               the `/` search: props.query (null ends it)
//   act      {id, actions, width}     keys and clicks in order, a text copy after each, then the card as it was
//   unload   {id}
//   ping
// Each event answers the plain tree (`{t, p, c}`: Box, Text and Button nodes, a Button's onPress a number), and the state
// and the search to keep. A card the runner does not hold answers {ok: false, missing: true}: the hooks load it again from its copy.
import fs from 'node:fs'
import http from 'node:http'
import { types } from 'node:util'
import vm from 'node:vm'

import { buttonText, layoutLines } from './layout.js'

const LOAD_MS = 5000
const EVENT_MS = 1000
const MAX_TREE = 95000 // Claude Code draws a card's props up to 100000 characters
const MAX_VIEW = 60000

// ------------------------------------------------------------------------------------------------- static check

/** The view's code with strings, template text and comments taken out, so a word inside them does not count. */
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
    if (c === '{') depth++
    if (c === '}') { depth--; if (tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); i++; out += ')'; template(); continue } }
    out += c
    i++
  }
  return out
}

/** What the view must not hold, as a friendly early error; the vm context is the boundary, not this check. */
export function checkView(src) {
  const bad = []
  if (src.length > MAX_VIEW) bad.push(`the view is ${src.length} characters; at most ${MAX_VIEW}`)
  const code = scrub(src)
  for (const w of ['import', 'export', 'require', 'globalThis', 'process']) {
    if (new RegExp(`(^|[^A-Za-z0-9_$.])${w}(?![A-Za-z0-9_$])(?!\\s*:(?!:))`).test(code)) bad.push(`\`${w}\` is not allowed`)
  }
  for (const w of ['eval', 'Function']) if (new RegExp(`(^|[^A-Za-z0-9_$])${w}\\s*(\\)\\s*)?\\(`).test(code)) bad.push(`calling \`${w}(\` is not allowed`)
  if (/(^|[^A-Za-z0-9_$])\$(?![A-Za-z0-9_$])|\$\$|(^|[^A-Za-z0-9_])\$[A-Za-z_]/.test(code)) bad.push('`$` is not allowed outside strings')
  if (!/function\s+view\s*\(/.test(src)) bad.push('define `function view(props, surface)`')
  return bad
}

// ------------------------------------------------------------------------------------------------- inside a context

// The code each context runs first. It defines one global that cannot be changed, __thimble, whose call(op, json)
// answers JSON text. It holds the rows, the state, the search, the width, the handlers of the last drawing and the
// view's functions. The rows' text is the one value put on the context's global from outside, before any code of the
// view has run; init takes it off.
const PRELUDE = new vm.Script(String.raw`
Object.defineProperty(this, '__thimble', { writable: false, configurable: false, value: (function () {
  'use strict'
  const parse = JSON.parse, stringify = JSON.stringify, isArray = Array.isArray, keysOf = Object.keys, freeze = Object.freeze
  const Str = String
  const PROPS = {
    Box: ['flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent', 'gap',
      'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight', 'margin', 'marginX', 'marginY', 'marginTop',
      'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom',
      'paddingLeft', 'paddingRight', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow',
      'display', 'position', 'top', 'left', 'right', 'bottom'],
    Text: ['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap'],
    Button: ['label', 'plain', 'dimColor', 'variant'],
  }
  let rows = [], title = '', state, query = null, columns = 80
  let fns = null, pointer = null, keyListener = null, handlers = [], dirty = false, nodes = 0
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
  const surface = freeze({
    elements,
    get state() { return state },
    setState(next) { state = next; dirty = true },
    get columns() { return columns },
    rows: 0,
    onPointer(fn) { pointer = typeof fn === 'function' ? fn : null; return () => { pointer = null } },
    onKey(fn) { keyListener = typeof fn === 'function' ? fn : null; return () => { keyListener = null } },
    every() { return () => {} },
    post() {},
  })
  const props = () => ({ title, rows, query, columns })

  // the view's drawing as a plain tree: Box, Text and Button nodes with the props each takes; a Button's onPress
  // becomes a number, the handler kept here
  function kids(c, depth, inText, out) {
    if (c == null || c === false || c === true) return out
    if (isArray(c)) { for (const x of c) kids(x, depth, inText, out); return out }
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'bigint') { out.push(inText ? Str(c) : { t: 'Text', p: {}, c: [Str(c)] }); return out }
    const n = node(c, depth, inText)
    if (n) out.push(n)
    return out
  }
  function node(n, depth, inText) {
    if (!n || typeof n !== 'object' || depth > 30) return null
    const t = n.type
    if (t !== 'Box' && t !== 'Text' && t !== 'Button') return null
    if (inText && t !== 'Text') return null
    if (++nodes > 20000) throw new Error('the drawing has more than 20000 elements; draw fewer rows (show a page of them)')
    const src = n.props && typeof n.props === 'object' ? n.props : {}
    const p = {}
    for (const k of PROPS[t]) {
      const v = src[k]
      if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity)) p[k] = v
    }
    if (t === 'Button') {
      if (typeof src.onPress === 'function') { handlers.push(src.onPress); p.onPress = handlers.length - 1 }
      if (typeof src.key === 'string' || typeof src.key === 'number') p.key = Str(src.key)
    }
    return { t, p, c: kids(src.children, depth + 1, t !== 'Box', []) }
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
    const c = kids(tree, 0, false, [])
    const root = c.length === 1 && c[0].t === 'Box' ? c[0] : { t: 'Box', p: { flexDirection: 'column' }, c }
    return { tree: root, pointer: pointer !== null }
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
  function said(e) {
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
    if (v && typeof v === 'object' && isArray(v.rows)) return v.rows
    throw new Error('the file is JSON but not a list of rows, or an object with a "rows" list')
  }
  function summary() {
    const cols = []
    for (const r of rows.slice(0, 50)) if (r && typeof r === 'object' && !isArray(r)) for (const k of keysOf(r)) if (cols.indexOf(k) < 0) cols.push(k)
    let first = ''
    try { first = rows.length ? stringify(rows[0]) : '' } catch (_) { first = '' }
    return { rows: rows.length, columns: cols.slice(0, 40), first: first.length > 200 ? first.slice(0, 199) + '…' : first }
  }
  const OPS = {
    init(a) {
      const view = globalThis.__thimbleView, text = globalThis.__thimbleRows
      delete globalThis.__thimbleView
      delete globalThis.__thimbleRows
      try { rows = parseRows(text) } catch (e) { return { ok: false, phase: 'rows', error: said(e) } }
      title = Str(a.title || '')
      columns = a.width
      query = typeof a.query === 'string' ? a.query : null
      state = a.state == null ? undefined : a.state
      let got
      try { got = view() } catch (e) { return { ok: false, phase: 'view', error: said(e) } }
      if (!got || typeof got.view !== 'function') return { ok: false, phase: 'view', error: 'the code defines no function view(props, surface)' }
      fns = got
      return { summary: summary(), keys: typeof got.keys === 'string' ? got.keys : '' }
    },
    draw(a) { if (a.width) columns = a.width; return {} },
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
    query(a) { query = typeof a.text === 'string' ? a.text : null; return {} },
    save() { return { saved: saved(), query } },
    restore(a) { state = a.saved == null ? undefined : parse(a.saved); query = a.query; return {} },
  }
  function call(op, json) {
    try {
      const a = parse(json)
      const r = OPS[op](a)
      if (r.ok === false) return stringify(r)
      const d = draw()
      return stringify(Object.assign({ ok: true }, r, { tree: d.tree, pointer: d.pointer, state: saved(), query }))
    } catch (e) {
      try { return stringify({ ok: false, phase: op === 'init' ? 'view' : op, error: said(e) }) } catch (_) { return '{"ok":false,"error":"the view failed"}' }
    }
  }
  return freeze({ call })
})() })
`, { filename: 'prelude.js' })

// what the view's function gives back: its view, its onKey and its keys, whichever it defines
const TAIL = "\n;return { view: typeof view === 'function' ? view : undefined, onKey: typeof onKey === 'function' ? onKey : undefined, keys: typeof keys === 'string' ? keys : '' }"

/** A JSON answer from inside a context, or the error that stopped it. The request is written into the script as a
 *  string literal, so nothing of this process is put where the view's code could reach it, and only a string comes
 *  out. The context catches every exception of the view; what still arrives here is the vm's own (the time limit), or
 *  a value of the view's, which is never read (reading it could run the view's code outside the time limit). */
function inContext(card, op, args, ms) {
  let out
  try {
    out = vm.runInContext(`__thimble.call(${JSON.stringify(op)}, ${JSON.stringify(JSON.stringify(args))})`, card.ctx, { filename: 'call.js', timeout: ms })
  } catch (e) {
    // the vm makes its time-limit error in the context's realm: its own `code` is read as data, never through a getter
    const code = e && typeof e === 'object' && !types.isProxy(e) ? Object.getOwnPropertyDescriptor(e, 'code') : undefined
    return { ok: false, phase: op, error: code && code.value === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? `the view ran past its ${ms / 1000} s limit` : 'the view stopped the card' }
  }
  if (typeof out !== 'string' || out.length > 4 * MAX_TREE) return { ok: false, phase: op, error: 'the view gave no drawing thimble can read' }
  const r = JSON.parse(out)
  if (r.ok && JSON.stringify(r.tree).length > MAX_TREE) return { ok: false, phase: op, error: `the drawing is more than ${MAX_TREE} characters, which Claude Code does not draw; draw fewer rows (show a page of them)` }
  return r
}

// ------------------------------------------------------------------------------------------------- the cards

const cards = new Map()

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
  const card = { ctx, version: a.version, width: a.width, tree: null }
  const r = inContext(card, 'init', { title: a.title, state: a.state ?? null, query: a.query ?? null, width: a.width }, LOAD_MS)
  if (!r.ok) return r
  card.tree = r.tree
  cards.set(a.id, card)
  return { ...r, ...copy(r.tree, a.width) }
}

function event(a, op, args, withText) {
  const card = cards.get(a.id)
  if (!card) return { ok: false, missing: true }
  const r = inContext(card, op, args, EVENT_MS)
  if (r.ok) card.tree = r.tree
  return r.ok && withText ? { ...r, ...copy(r.tree, card.width) } : r
}

/** The first Button whose words hold `words`, in a plain tree: its onPress number. */
function buttonWith(n, words) {
  if (!n || typeof n !== 'object') return null
  if (n.t === 'Button' && buttonText(n.p, n.c).includes(words) && typeof n.p.onPress === 'number') return n.p.onPress
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
      r = inContext(card, 'pointer', { down: at, up: at }, EVENT_MS)
      if (r.ok && !r.handled) r.note = 'a click at a cell reaches only an onPointer listener, and the view set none; a Button takes a click by its words'
    } else {
      copies.push({ what: JSON.stringify(x).slice(0, 80), error: 'not a key or a click' })
      continue
    }
    if (r.ok) {
      card.tree = r.tree
      copies.push({ what, note: r.note, ...copy(r.tree, card.width) })
    } else copies.push({ what, error: r.error })
  }
  const back = inContext(card, 'restore', { saved: before.saved, query: before.query }, EVENT_MS)
  if (back.ok) card.tree = back.tree
  return { ok: true, copies, tree: card.tree, state: back.ok ? back.state : before.saved }
}

const OPS = {
  ping: () => ({ ok: true }),
  load,
  draw: a => {
    const card = cards.get(a.id)
    if (card && a.width) card.width = a.width
    return event(a, 'draw', { width: a.width }, !!a.text)
  },
  key: a => event(a, 'key', { key: String(a.key ?? '').slice(0, 1) }),
  press: a => event(a, 'press', { button: Number(a.button) }),
  pointer: a => event(a, 'pointer', { down: a.down, up: a.up ?? a.down, button: a.button }),
  query: a => event(a, 'query', { text: typeof a.text === 'string' ? a.text : null }),
  act,
  unload: a => ({ ok: cards.delete(a.id) }),
}

// ------------------------------------------------------------------------------------------------- the socket

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
        out = Object.hasOwn(OPS, op) ? OPS[op](JSON.parse(body || '{}')) : { ok: false, error: `no request ${op}` }
      } catch (e) {
        out = { ok: false, error: `the runner failed: ${e && e.message}` }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(out))
    })
  })
  server.listen(sock, () => fs.chmodSync(sock, 0o600))
  // the session that started this runner is gone: so is the runner
  const parent = process.ppid
  setInterval(() => { if (process.ppid !== parent) process.exit(0) }, 2000)
}

if (process.argv[2]) serve(process.argv[2])
