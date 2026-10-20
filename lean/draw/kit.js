/* kit.js: the drawing toolkit an object's program is written against.

   A program is the body of a function `(k, data) => node`. It builds a tree of nodes with `k` and returns it.
   DrawKit.run(program, data, opts) runs it and returns a drawing: plain JSON that both renderers read.

     drawing = { kit, w, h, mode, root, cites: {id: cite}, examples: {id: set}, regions: [{id, meta}], warnings, ms, error? }

   The toolkit draws nothing itself. It records meaning: text as styled runs, values as values (a bar keeps its
   number, a spark its series), and regions with the ids the program gave them. The terminal renderer (term.js) lays
   the tree out in cells.

   This file is a plain script with no imports, so it can run inside a sandbox: a Node vm context
   (sandbox-node.mjs) or a sandboxed iframe (browser/sandbox.js). It reads no clock but performance.now/Date.now for
   the time limit, and nothing else from the environment. It defines globalThis.DrawKit.
*/
(function (root) {
  'use strict'

  const KIT = 1
  const TONES = ['ink', 'dim', 'accent', 'good', 'bad', 'warn', 'unseen', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'cite', 'explain']
  const CATS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
  const ALIAS = {
    default: 'ink', normal: 'ink', text: 'ink', black: 'ink', fg: 'ink',
    muted: 'dim', grey: 'dim', gray: 'dim', faint: 'dim', secondary: 'dim',
    blue: 'accent', link: 'accent', primary: 'accent',
    red: 'bad', error: 'bad', fail: 'bad',
    green: 'good', ok: 'good', pass: 'good',
    amber: 'warn', yellow: 'warn', warning: 'warn', orange: 'warn',
    missing: 'unseen', none: 'unseen',
    teal: 'c1', purple: 'c2', sand: 'c3', slate: 'c4', rose: 'c5', olive: 'c6'
  }
  const MAX_SIDE = 400
  const MAX_CITE_ROWS = 50
  const MAX_RECORDS = 200
  const MAX_SERIES_POINTS = 2000
  const MAX_KNOB = 2000
  // the refs one part of a map carries (the rows of every thread through it), as many as a selection resolves
  const MAX_PART_REFS = 500
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/

  // ---------------------------------------------------------------- small utilities
  const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
  function int(v, d) { v = Math.round(Number(v)); return isFinite(v) ? v : d }
  function num(v) {
    if (typeof v === 'number') return v
    if (typeof v === 'string' && v.trim() !== '') {
      const t = v.trim().replace(/,/g, '').replace(/%$/, '')
      if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return parseFloat(t)
    }
    return NaN
  }
  function clone(v) {
    if (v === undefined) return undefined
    try { return JSON.parse(JSON.stringify(v)) } catch (e) { return null }
  }
  // Characters a renderer can draw: control and zero-width characters go, tabs become a space.
  function clean(s) {
    const out = []
    for (const ch of Array.from(String(s == null ? '' : s))) {
      const cp = ch.codePointAt(0)
      if (ch === '\t') { out.push(' '); continue }
      if (ch === '\n') { out.push('\n'); continue }
      if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) continue
      if ((cp >= 0x200B && cp <= 0x200F) || cp === 0x2060 || (cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x20E3 || (cp >= 0x0300 && cp <= 0x036F) || cp === 0xFEFF) continue
      out.push(ch)
    }
    return out.join('')
  }
  function sep3(i) { return i.length > 3 ? i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : i }
  // Numbers for people: 1546 -> "1,546", 95.4321 -> "95.43". o: {dp, pct, sign, compact, raw}
  function fmt(v, o) {
    o = o || {}
    if (v == null) return ''
    if (typeof v !== 'number') { const n = num(v); if (!isFinite(n) || o.raw) return String(v); v = n }
    if (!isFinite(v)) return isNaN(v) ? 'NaN' : (v > 0 ? '∞' : '-∞')
    let suffix = ''
    if (o.pct) { v = v * 100; suffix = '%' }
    if (o.compact && Math.abs(v) >= 1000) {
      for (const [d, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
        if (Math.abs(v) >= d) { const x = v / d; return (o.sign && v > 0 ? '+' : '') + String(+x.toFixed(Math.abs(x) >= 100 ? 0 : 1)) + u + suffix }
      }
    }
    let s
    if (o.dp != null) s = Math.abs(v).toFixed(clamp(int(o.dp, 0), 0, 12))
    else if (Number.isInteger(v)) s = String(Math.abs(v))
    else s = String(Math.abs(+v.toPrecision(4)))
    if (s.indexOf('e') >= 0) return String(v) + suffix
    const p = s.split('.')
    return (v < 0 ? '-' : (o.sign && v > 0 ? '+' : '')) + sep3(p[0]) + (p[1] ? '.' + p[1] : '') + suffix
  }
  function slug(s) {
    const t = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_.:]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    return /^[a-z0-9]/.test(t) ? t : ''
  }
  function escapeMarkup(s) { return String(s == null ? '' : s).replace(/([\\*{}[\]])/g, '\\$1') }
  function plain(runs) { return (runs || []).map(r => r.br ? '\n' : r.s).join('') }

  // ---------------------------------------------------------------- tones
  function toneOf(t, ctx, fallback) {
    fallback = fallback || 'ink'
    if (t == null || t === '') return fallback
    // any tone with -faint is that tone, pale: what is not in focus keeps its color but steps back
    const f = /^(.+)-faint$/.exec(String(t).toLowerCase().trim())
    if (f) { const b = toneOf(f[1], ctx, fallback); return b + '-faint' }
    const k = String(t).toLowerCase().trim()
    if (TONES.indexOf(k) >= 0) return k
    if (ALIAS[k]) return ALIAS[k]
    const m = /^c(\d+)$/.exec(k)
    if (m) return CATS[((+m[1] - 1) % 6 + 6) % 6]
    warn(ctx, `unknown tone "${t}"; drawn as ${fallback}`)
    return fallback
  }
  function knownTone(name) { const k = String(name).toLowerCase().replace(/-faint$/, ''); return TONES.indexOf(k) >= 0 || !!ALIAS[k] || /^c\d+$/.test(k) }
  function warn(ctx, msg) { if (ctx && ctx.warnings.indexOf(msg) < 0 && ctx.warnings.length < 60) ctx.warnings.push(msg) }

  // ---------------------------------------------------------------- inline markup -> runs
  // **bold**   {tone:words} (nests; known tone names only)   [words](#id) a link to a cite, examples or region id
  // \* \{ \} \[ \] \\ escape.  A newline is a hard break.  Runs: {s, tone, b?, ref?} and {br: true}.
  function inline(str, o, ctx) {
    o = o || {}
    const a = Array.from(clean(typeof str === 'number' ? fmt(str) : str))
    const runs = []
    let bold = !!o.bold
    const tones = [toneOf(o.tone, ctx)]
    const push = (ch, ref) => {
      const tone = ref && tones.length === 1 ? 'accent' : tones[tones.length - 1]
      const last = runs[runs.length - 1]
      if (last && !last.br && last.tone === tone && !!last.b === bold && last.ref === ref) { last.s += ch; return }
      const r = { s: ch, tone: tone }
      if (bold) r.b = true
      if (ref) r.ref = ref
      runs.push(r)
    }
    if (o.raw) {
      for (const ch of a) { if (ch === '\n') runs.push({ br: true }); else push(ch) }
      return runs
    }
    let i = 0
    while (i < a.length) {
      const ch = a[i]
      if (ch === '\\' && i + 1 < a.length && '*{}[]\\'.indexOf(a[i + 1]) >= 0) { push(a[i + 1]); i += 2; continue }
      if (ch === '\n') { runs.push({ br: true }); i++; continue }
      if (ch === '*' && a[i + 1] === '*') { bold = !bold; i += 2; continue }
      if (ch === '{') {
        const m = /^\{([a-zA-Z][\w-]*):/.exec(a.slice(i, i + 24).join(''))
        if (m && knownTone(m[1])) { tones.push(toneOf(m[1], ctx)); i += m[0].length; continue }
      }
      if (ch === '}' && tones.length > 1) { tones.pop(); i++; continue }
      if (ch === '[') {
        const m = /^\[([^\]\n]+)\]\(#([^)\s]+)\)/.exec(a.slice(i, i + 300).join(''))
        if (m) {
          for (const c of Array.from(m[1])) push(c, m[2])
          ctx.links.push(m[2])
          i += Array.from(m[0]).length
          continue
        }
      }
      push(ch)
      i++
    }
    return runs
  }

  // ---------------------------------------------------------------- the kit
  function makeKit(ctx, W, H, opts) {
    const tick = n => {
      ctx.ops += n || 1
      if (ctx.ops >= ctx.nextCheck) {
        ctx.nextCheck = ctx.ops + 2000
        if (nowMs() - ctx.t0 > ctx.limit) { const e = new Error(`the program ran past the ${ctx.limit} ms limit`); e.name = 'TimeLimit'; throw e }
      }
    }
    const T = t => toneOf(t, ctx)
    const node = (t, props) => { tick(1); return Object.assign({ t: t }, props) }
    const isNode = v => isObj(v) && typeof v.t === 'string' && !(v instanceof Canvas)
    // anything a program hands where a node goes: a node, a canvas, a string (text), a number, an array (a stack)
    const asNode = v => {
      if (v == null || v === false) return null
      if (v instanceof Canvas) return v.node()
      if (isNode(v)) return v
      if (Array.isArray(v)) return k.stack.apply(null, v)
      if (typeof v === 'number') return k.text(fmt(v))
      return k.text(String(v))
    }
    const splitArgs = args => {
      const list = Array.prototype.slice.call(args)
      let o = {}
      const last = list[list.length - 1]
      if (list.length && isObj(last) && !isNode(last) && !(last instanceof Canvas)) o = list.pop()
      const kids = []
      const walk = v => { if (Array.isArray(v)) v.forEach(walk); else { const n = asNode(v); if (n) kids.push(n) } }
      list.forEach(walk)
      return { kids: kids, o: o }
    }
    const sizing = (n, o) => {
      if (!o) return n
      if (o.w != null) n.w = clamp(int(o.w, 1), 1, MAX_SIDE)
      if (o.grow != null) n.grow = Math.max(0, num(o.grow) || 0)
      if (o.minW != null) n.minW = clamp(int(o.minW, 1), 1, MAX_SIDE)
      return n
    }
    const metaOf = (m, where) => normMeta(m, ctx, where)
    const keys = keysAt(opts.keys)

    const k = {
      w: W, h: H, mode: opts.mode || 'inline', state: clone(ctx.state) || {},
      // the card as the host knows it: its title (drawn by the host when the program draws none), its id, the surface
      // it is drawn on, and the event this run answers (a key, a press, a brush), else null
      title: opts.title != null ? clean(String(opts.title)) : '', id: opts.id != null ? String(opts.id) : '',
      surface: opts.surface === 'browser' ? 'browser' : 'terminal', event: ctx.event ? clone(ctx.event) : null,
      tones: TONES.slice(), cats: CATS.slice(),
      fmt: fmt, num: num, escape: escapeMarkup,

      // ---------------- interaction: what the person does reaches the program as an event, and the program answers
      // with new state, which the host keeps (the terminal and the browser show the same) and runs the program with.
      // k.on(name, fn, label): name is a key ('j', 'space', 'return'), 'press' or 'press:<region id>', 'brush' or
      // 'brush:<id>', or any event name a surface sends. fn(event) returns a patch of the state, or calls k.set and
      // k.ask. Handlers run after the program has drawn once, so they see every name it defined.
      on(name, fn, label) {
        const n = String(name == null ? '' : name).trim()
        if (!n || typeof fn !== 'function') { warn(ctx, 'k.on needs (name, fn): a key, "press", "brush" or "press:<id>", and a function'); return k }
        const why = keys.why(n)
        if (why) warn(ctx, `the key "${n}" does not reach this card where it is drawn now (${why}); the analyst cannot use it here. k.keys.free(key) says which keys do`)
        if (!ctx.handlers.some(h => h.name === n)) ctx.handlers.push({ name: n, fn: fn, label: label != null ? clean(String(label)).slice(0, 40) : '' })
        return k
      },
      // k.set(key, value) or k.set({...}): the state a handler leaves for the next run
      set(key, value) {
        if (ctx.phase !== 'handle') { warn(ctx, 'k.set changes the state only inside a k.on handler; read k.state to draw'); return k }
        if (isObj(key)) Object.keys(key).forEach(x => { ctx.patch[x] = clone(key[x]) })
        else if (key != null) ctx.patch[String(key)] = clone(value)
        return k
      },
      // k.ask(selection): open a side thread scoped to what is selected. selection: {label, region, rows, refs, text}:
      // rows are rows of the card's data (each knows its source rows); text, when given, is asked at once
      ask(sel) {
        if (ctx.phase !== 'handle') { warn(ctx, 'k.ask opens a thread only inside a k.on handler, when the analyst acts'); return k }
        ctx.ask = askOf(ctx, sel)
        return k
      },
      // k.after(ms, name, payload): an event this program gets later, {type: name, ...payload}, such as the next frame of
      // a replay. Inside a handler. The host keeps one waiting event per name, so asking again moves it.
      after(ms, name, payload) {
        if (ctx.phase !== 'handle') { warn(ctx, 'k.after asks for a later event only inside a k.on handler'); return k }
        const n = String(name == null ? '' : name).trim()
        if (!n) { warn(ctx, 'k.after needs (ms, name): the event name its handler takes'); return k }
        const ev = Object.assign({}, isObj(payload) ? clone(payload) : {}, { type: n })
        ctx.after = ctx.after.filter(a => a.event.type !== n).concat([{ ms: clamp(int(ms, 100), 30, 600000), event: ev }])
        return k
      },
      // k.do(action, args): ask the host for one of its actions by name, such as 'open' (a card, a row, a claim) or
      // 'close'. Inside a handler. What a host can do is its own; an action it does not have says so in one line.
      do(action, args) {
        if (ctx.phase !== 'handle') { warn(ctx, 'k.do asks the host for an action only inside a k.on handler'); return k }
        const a = String(action == null ? '' : action).trim()
        if (!/^[a-z][\w.-]{0,40}$/i.test(a)) { warn(ctx, `k.do needs an action name, such as 'open'; "${a}" is not one`); return k }
        if (ctx.effects.length < 20) ctx.effects.push(Object.assign({}, isObj(args) ? clone(args) : {}, { do: a }))
        return k
      },
      // k.local(...keys): state keys that belong to the surface they were set on, such as a hover or a replay's frame.
      // Each surface keeps its own; the rest of the state (a filter, a zoom, a flip) is shared by every surface.
      local() {
        Array.prototype.slice.call(arguments).flat().forEach(x => {
          const s = String(x == null ? '' : x).trim()
          if (s && ctx.local.indexOf(s) < 0 && ctx.local.length < 20) ctx.local.push(s)
        })
        return k
      },
      // k.keys: the keys that reach this program where it is drawn now. k.keys.free(key) is true for a key it can
      // take; the host keeps the others (moving between things, going back), and k.keys.taken lists them. The bar
      // names the program's keys while it has the focus, so a program never prints its own key hints.
      keys: { taken: keys.taken.slice(), free: kk => !keys.why(String(kk == null ? '' : kk)) },
      // k.select(id): the part this program has selected, which every surface marks as it marks a selection (a fill in
      // the terminal, an outline in the browser)
      select(id) {
        ctx.selected = id == null ? null : String(id)
        return k
      },
      // k.status(text, tone): one short line the host shows in its bar while this program has the keys (what is
      // going on, a problem and its fix)
      status(text, tone) {
        const s = clean(String(text == null ? '' : text)).replace(/\s+/g, ' ').trim().slice(0, 160)
        ctx.status = s ? { text: s, tone: toneOf(tone, ctx) } : null
        return k
      },
      // k.want(request): data the host has not given yet, such as {rows: [refs]} (the rows behind a part, read through
      // the kernel). Returns it when the host has it (opts.got), else null; the host then reads it and runs the program
      // again with it.
      want(request) {
        if (!isObj(request)) { warn(ctx, 'k.want needs a request, such as {rows: [refs]}'); return null }
        const key = wantKey(request)
        const got = ctx.got && Object.prototype.hasOwnProperty.call(ctx.got, key) ? ctx.got[key] : undefined
        if (got !== undefined) return clone(got)
        if (!ctx.wants.some(w => w.key === key) && ctx.wants.length < 20) ctx.wants.push({ key: key, request: clone(request) })
        return null
      },
      // k.embed(drawing): another program's drawing, run by the host in its own sandbox (the card inside a pane), as a
      // part of this one. Its parts, cites and examples come with it.
      embed(drawing) {
        if (!isObj(drawing) || !isObj(drawing.root) || typeof drawing.root.t !== 'string') { warn(ctx, 'k.embed needs a drawing, with its root'); return k.text('') }
        const d = clone(drawing)
        Object.keys(d.cites || {}).forEach(id => { if (!ctx.cites[id]) ctx.cites[id] = d.cites[id] })
        Object.keys(d.examples || {}).forEach(id => { if (!ctx.examples[id]) ctx.examples[id] = d.examples[id] })
        tick(64)
        return d.root
      },
      // the refs of rows of the card's data (a row, a list of rows, or a value that holds rows): what a cite or an
      // ask names, so a program can say which rows a selection stands for
      rows(x) { return refsIn(ctx, x) },
      cat(i) { return CATS[((i | 0) % 6 + 6) % 6] },
      // the width of a string in columns, as the terminal counts it (wide characters count 2)
      len(s) { return Array.from(clean(s)).reduce((n, ch) => n + (ch === '\n' ? 0 : wide(ch.codePointAt(0)) ? 2 : 1), 0) },

      // ---------------- text
      text(str, o) {
        o = o || {}
        const n = node('text', { runs: inline(str, { tone: o.tone, bold: o.bold, raw: o.raw }, ctx) })
        if (o.align === 'right' || o.align === 'center') n.align = o.align
        if (o.wrap === false) n.wrap = false
        if (o.max != null) n.max = Math.max(1, int(o.max, 1))
        return sizing(n, o)
      },

      // ---------------- layout
      stack() {
        const { kids, o } = splitArgs(arguments)
        const n = node('stack', { kids: kids })
        if (o.gap) n.gap = Math.max(0, int(o.gap, 0))
        if (o.align === 'right' || o.align === 'center') n.align = o.align
        return sizing(n, o)
      },
      beside() {
        const { kids, o } = splitArgs(arguments)
        const n = node('beside', { kids: kids, gap: o.gap == null ? 2 : Math.max(0, int(o.gap, 2)) })
        if (o.align === 'middle' || o.align === 'center' || o.align === 'bottom') n.align = o.align === 'center' ? 'middle' : o.align
        return sizing(n, o)
      },
      frame(kid, o) {
        o = o || {}
        const n = node('frame', { kid: asNode(kid) || k.space(1, 1) })
        if (o.title != null) n.title = inline(o.title, { bold: true }, ctx)
        if (o.right != null) n.right = inline(o.right, { tone: 'dim' }, ctx)
        if (o.bottom != null) n.bottom = inline(o.bottom, { tone: 'dim' }, ctx)
        if (o.tone) n.tone = T(o.tone)
        return sizing(n, o)
      },
      size(kid, o) { const n = asNode(kid) || k.space(1, 1); return sizing(Object.assign({}, n), o || {}) },
      space(w, h) { return node('space', { w: Math.max(0, int(w == null ? 1 : w, 1)), h: Math.max(0, int(h == null ? 1 : h, 1)) }) },
      rule(o) { o = o || {}; return sizing(node('rule', { tone: T(o.tone || 'dim') }), o) },

      // ---------------- values
      // a bar: one value against a max, or stacked parts [{value, tone, label}]; it grows to the width it is given
      bar(value, o) {
        if (isObj(value) && !Array.isArray(value)) { o = value; value = o.parts || o.value }
        o = o || {}
        const n = node('bar', { tone: T(o.tone || 'accent') })
        if (Array.isArray(value)) {
          n.parts = value.map((p, pi) => {
            p = isObj(p) ? p : { value: p }
            const q = { value: Math.max(0, num(p.value) || 0), tone: T(p.tone || CATS[pi % 6]) }
            if (p.label != null) q.label = clean(p.label)
            // a part made from a row of the card's data (the row, a spread of it, or {row}) is a part by itself, as a
            // bar item is: selected, it opens its own rows, with no ref written
            const from = lineageOf(ctx, p)
            if (from || p.id != null || p.cite || p.examples || p.meta) {
              const meta = metaOf(Object.assign({}, p.meta || {}, { label: p.regionLabel || `${p.label == null ? '' : p.label} ${fmt(q.value)}`.trim(), cite: p.cite, examples: p.examples }), 'bar part')
              if (from && meta.ref == null && meta.refs == null) meta.ref = from
              let rid = p.id != null ? String(p.id) : (refSlug(from) || slug(p.label) || 'part')
              // an id the runtime made is kept apart from one already drawn, with no warning: the program named none
              if (p.id == null && ctx.ids[rid]) { let i = 2; while (ctx.ids[rid + '~' + i]) i++; rid = rid + '~' + i }
              q.meta = meta
              q.region = regionId(ctx, rid, 'bar part', meta)
            }
            return q
          })
          n.value = n.parts.reduce((s, p) => s + p.value, 0)
        } else n.value = num(value)
        n.max = num(o.max)
        if (!(n.max > 0)) n.max = Math.max(1, Math.abs(isFinite(n.value) ? n.value : 1))
        if (o.track) n.track = true
        return sizing(n, o)
      },

      // Conveniences: compositions of the primitives above, written here so programs need not repeat them.
      // A program may build its own the same way.

      // rows of  label  ▆▆▆▆▆▆  value  note : beside(text, bar, text, text) per item, in one column plan
      bars(items, o) {
        o = o || {}
        items = (Array.isArray(items) ? items : []).map(it => Array.isArray(it) ? { label: it[0], value: it[1] } : (isObj(it) ? it : { label: String(it) }))
        const vals = items.map(it => Array.isArray(it.parts) ? it.parts.reduce((s, p) => s + Math.max(0, num(isObj(p) ? p.value : p) || 0), 0) : num(it.value))
        const max = num(o.max) > 0 ? num(o.max) : Math.max.apply(null, vals.filter(isFinite).concat([0])) || 1
        const texts = items.map((it, i) => it.text != null ? String(it.text) : isFinite(vals[i]) ? fmt(vals[i], o.fmt) : (it.missing || 'unseen'))
        const width = o.w != null ? int(o.w, W) : W - 4
        const labelW = o.labelW != null ? int(o.labelW, 12) : Math.min(Math.max(1, ...items.map(it => k.len(it.label == null ? '' : it.label))), Math.max(6, Math.floor(width * 0.4)))
        const valW = Math.max(1, ...texts.map(t => k.len(t)))
        // a note that only says the row's value again (a total beside the total) is not drawn a second time
        const bare = t => String(t).replace(/[,\s]/g, '')
        const noteOf = (it, i) => it.note == null || bare(plain(inline(it.note, {}, ctx))) === bare(texts[i]) ? null : it.note
        const noteW = Math.max(0, ...items.map((it, i) => noteOf(it, i) != null ? k.len(plain(inline(noteOf(it, i), {}, ctx))) : 0))
        const notes = noteW > 0 && width - labelW - valW - noteW - 4 >= 12
        const rows = items.map((it, i) => {
          const row = k.beside(
            k.text(it.label == null ? '' : it.label, { w: labelW, tone: it.labelTone || o.labelTone || 'ink', raw: !o.markup, wrap: false }),
            Array.isArray(it.parts) ? k.bar(it.parts, { max: max }) : isFinite(vals[i]) ? k.bar(vals[i], { max: max, tone: it.tone || o.tone }) : k.unseen(),
            k.text(texts[i], { w: valW, align: 'right', bold: !!(it.bold || o.bold), tone: isFinite(vals[i]) ? 'ink' : 'unseen', raw: true }),
            notes && k.text(' ' + (noteOf(it, i) == null ? '' : noteOf(it, i)), { w: noteW + 1, tone: 'dim', wrap: false }),
            { gap: 1 })
          // an item made from a row of the card's data (the row itself, a spread of it, or {row}) is a part by itself:
          // its rows open with no ref written
          const from = lineageOf(ctx, it)
          const id = it.id != null ? it.id : typeof it.cite === 'string' ? it.cite : typeof it.examples === 'string' ? it.examples : null
          if (id == null && !it.cite && !it.examples && !it.meta && !from) return row
          const meta = Object.assign({}, it.meta || {})
          if (from && meta.ref == null && !lineageOf(ctx, meta)) meta.ref = from
          return k.region(id != null ? id : (slug(it.label) || refSlug(from)), Object.assign({}, meta, { label: it.regionLabel || `${it.label == null ? '' : it.label} ${texts[i]}`.trim(), cite: it.cite != null ? it.cite : meta.cite, examples: it.examples != null ? it.examples : meta.examples }), row)
        })
        return k.stack(rows, { gap: o.gap ? 1 : 0 })
      },
      // ■ label   ■ label : one text
      legend(items, o) {
        o = o || {}
        const its = (Array.isArray(items) ? items : []).map(it => Array.isArray(it) ? { label: it[0], tone: it[1] } : it).filter(isObj)
        return k.text(its.map(it => { const t = T(it.tone); return `{${t}:${t === 'unseen' ? '░' : '■'}} {dim:${escapeMarkup(it.label)}}` }).join('   '), o)
      },
      // ●●●○○ : n of total, or a list of tones (an entry {tone, on: false} is hollow)
      dots(a, b, o) {
        let list
        if (Array.isArray(a)) { o = b || {}; list = a.map(x => isObj(x) ? { tone: T(x.tone || 'accent'), on: x.on !== false } : { tone: T(x || 'accent'), on: true }) }
        else {
          o = o || {}
          const n = Math.max(0, int(a, 0)), total = clamp(Math.max(n, int(b, n)), 0, 400)
          list = []
          for (let i = 0; i < total; i++) list.push(i < n ? { tone: T(o.tone || 'accent'), on: true } : { tone: 'dim', on: false })
        }
        return k.text(list.map(d => d.on ? `{${d.tone}:●}` : '{dim:○}').join(''), Object.assign({ wrap: false }, o))
      },
      // a one-line trend: one cell per value in the terminal, a line in the browser; null is a gap
      spark(values, o) {
        o = o || {}
        let vals = (Array.isArray(values) ? values : []).map(v => v == null ? null : num(v)).map(v => v === null || !isFinite(v) ? null : v)
        if (vals.length > MAX_SERIES_POINTS) { warn(ctx, `spark has ${vals.length} values; keeps the last ${MAX_SERIES_POINTS}`); vals = vals.slice(-MAX_SERIES_POINTS) }
        const fin = vals.filter(v => v !== null)
        const mn = isFinite(num(o.min)) ? num(o.min) : Math.min(0, Math.min.apply(null, fin.concat([0])))
        let mx = isFinite(num(o.max)) ? num(o.max) : Math.max.apply(null, fin.concat([mn + 1]))
        if (mx === mn) mx = mn + 1
        const n = node('spark', { values: vals, min: mn, max: mx, tone: T(o.tone || 'accent') })
        if (Array.isArray(o.tones)) n.tones = o.tones.slice(0, vals.length).map(t => t == null ? null : T(t))
        tick(vals.length / 8)
        return sizing(n, o)
      },
      // lines (or dots) of series over x: [numbers], [[x, y]...], or [{name, values | points, tone, id, cite}]
      plot(series, o) {
        o = o || {}
        const S = normSeries(series, ctx).map((s, i, all) => {
          const q = { name: s.name != null ? clean(s.name) : (all.length > 1 ? `series ${i + 1}` : ''), pts: s.pts, tone: T(s.tone || (i === 0 ? 'accent' : CATS[(i - 1) % 6])) }
          if (s.id != null || s.cite || s.examples || s.meta) {
            q.meta = metaOf(Object.assign({}, s.meta, { label: s.label || q.name, cite: s.cite, examples: s.examples }), 'plot series')
            q.region = regionId(ctx, s.id, 'plot series', q.meta)
          }
          return q
        })
        const axis = a => {
          a = isObj(a) ? a : {}
          const r = {}
          if (a.label != null) r.label = clean(a.label)
          if (isFinite(num(a.min))) r.min = num(a.min)
          if (isFinite(num(a.max))) r.max = num(a.max)
          if (a.log) r.log = true
          if (Array.isArray(a.ticks)) r.ticks = a.ticks.map(t => isObj(t) ? { at: num(t.at), label: t.label != null ? String(t.label) : undefined } : { at: num(t) }).filter(t => isFinite(t.at))
          return r
        }
        const n = node('plot', { series: S, h: clamp(int(o.h, 8), 3, 60), x: axis(o.x), y: axis(o.y) })
        if (o.dots) n.dots = true
        if (o.legend === false) n.legend = false
        // brush: in the browser, a drag across the plot's x axis is an event {type: 'brush', id, from, to} in x's units
        if (o.brush) { const b = typeof o.brush === 'string' ? o.brush : o.id != null ? String(o.id) : 'brush'; n.brush = { id: ID_RE.test(b) ? b : (slug(b) || 'brush') } }
        tick(S.reduce((s, q) => s + q.pts.length, 0) / 8)
        return sizing(n, o)
      },
      // rows of records in columns; numbers right-aligned. o.cols [{key, label, align, fmt, tone, w}],
      // o.id / o.cite / o.examples: functions of (row, i) that make a row a region
      table(rows, o) {
        o = o || {}
        rows = Array.isArray(rows) ? rows : []
        let cols = Array.isArray(o.cols) ? o.cols : null
        if (!cols) {
          cols = []
          // the kernel's own fields (_ref, _rows) are lineage, not columns
          rows.forEach(r => { if (isObj(r)) Object.keys(r).forEach(kk => { if (cols.indexOf(kk) < 0 && kk.charAt(0) !== '_') cols.push(kk) }) })
          if (!cols.length && rows.length && Array.isArray(rows[0])) cols = rows[0].map((_, i) => i)
        }
        cols = cols.map(c => isObj(c) ? Object.assign({}, c, { key: c.key != null ? c.key : c.label }) : { key: c })
        const get = (r, c) => Array.isArray(r) ? r[c.key] : isObj(r) ? r[c.key] : r
        const max = o.max != null ? Math.max(1, int(o.max, rows.length)) : 200
        const shown = rows.length > max ? rows.slice(0, max) : rows
        const RAW = /(^|_)(id|rev|step|epoch|year|run|batch|seed|pid|line)$/i
        const cells = shown.map((r, i) => cols.map(c => {
          let v = get(r, c)
          let tone = c.tone ? T(typeof c.tone === 'function' ? c.tone(v, r, i) : c.tone) : 'ink'
          let bold = false
          if (isObj(v)) { tone = v.tone ? T(v.tone) : tone; bold = !!v.bold; v = v.text != null ? v.text : v.value }
          let s
          if (typeof c.fmt === 'function') s = String(c.fmt(v, r, i))
          else if (typeof v === 'number') s = (c.raw || o.raw || RAW.test(String(c.key))) ? String(v) : fmt(v, isObj(c.fmt) ? c.fmt : undefined)
          else s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
          if ((typeof v === 'number' && !isFinite(v)) || /^\s*nan\s*$/i.test(s)) tone = 'bad'
          return inline(s, { tone: tone, bold: bold, raw: !c.markup }, ctx).filter(x => !x.br)
        }))
        const isNum = (r, c) => { let v = get(r, c); if (isObj(v)) v = v.value != null ? v.value : v.text; return v == null || v === '' || typeof v === 'number' || isFinite(num(v)) || /^\s*[-+]?(nan|inf)/i.test(String(v)) }
        const outCols = cols.map(c => {
          const q = { label: c.label != null ? clean(c.label) : typeof c.key === 'number' ? '' : clean(c.key) }
          q.align = c.align ? (c.align === 'right' ? 'right' : 'left') : (shown.length && shown.every(r => isNum(r, c)) ? 'right' : 'left')
          if (c.w != null) q.w = clamp(int(c.w, 4), 1, 120)
          return q
        })
        const outRows = cells.map((cs, i) => {
          const r = { cells: cs }
          const from = isObj(shown[i]) ? lineageOf(ctx, shown[i]) : null
          const rid = typeof o.id === 'function' ? o.id(shown[i], i) : from ? refSlug(from) || null : null
          const rc = typeof o.cite === 'function' ? o.cite(shown[i], i) : null
          const re = typeof o.examples === 'function' ? o.examples(shown[i], i) : null
          // a row of the card's data is a part by itself: selected, it opens its source rows
          if (rid != null || rc || re || from) {
            r.meta = metaOf({ label: cs.map(plain).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60), cite: rc, examples: re, ref: from || undefined }, 'table row')
            r.region = regionId(ctx, rid, 'table row', r.meta)
          }
          return r
        })
        tick(shown.length * cols.length)
        const n = node('table', { cols: outCols, rows: outRows })
        if (rows.length > shown.length) n.more = rows.length - shown.length
        if (o.head === false) n.head = false
        return sizing(n, o)
      },
      unseen(o) {
        if (typeof o === 'string') o = { label: o }
        o = o || {}
        const n = node('unseen', {})
        if (o.label != null) n.label = clean(o.label)
        if (o.h != null) n.h = clamp(int(o.h, 1), 1, 40)
        return sizing(n, o)
      },

      // ---------------- meaning
      region(id, meta, kid) {
        if ((isNode(meta) || meta instanceof Canvas) && !(isNode(kid) || kid instanceof Canvas)) { const t = meta; meta = kid; kid = t }
        const press = isObj(meta) && typeof meta.onPress === 'function' ? meta.onPress : null
        const m = metaOf(meta, 'region')
        const n = node('region', { id: regionId(ctx, id, 'region', m), meta: m, kid: asNode(kid) || k.space(1, 1) })
        // a press on this part: the same as k.on('press:<id>', fn)
        if (press) k.on('press:' + n.id, press, m.label || n.id)
        if (!m.label) m.label = labelOf(n.kid) || (m.cite && ctx.cites[m.cite] && ctx.cites[m.cite].text) || (m.examples && ctx.examples[m.examples] && ctx.examples[m.examples].label) || n.id
        return n
      },
      cite(id, c) {
        if (isObj(id) && c == null) { c = id; id = c.id }
        return registerCite(ctx, id, c)
      },
      examples(id, e) {
        if (isObj(id) && e == null) { e = id; id = e.id }
        return registerExamples(ctx, id, e)
      },

      // ---------------- knobs: a value the person turns (◂ ▸); the host runs the program again with the new value
      // values: a list (numbers, words, anything JSON), or {min, max, step}. at: the value it starts at.
      // fmt: a function, a value as the person reads it. Returns the value the person set, else `at`.
      knob(id, o) {
        o = o || {}
        let kid = String(id == null ? '' : id)
        if (!ID_RE.test(kid)) { const t = slug(kid) || 'knob'; warn(ctx, `knob id "${kid}" uses characters ids cannot hold; it is "${t}"`); kid = t }
        if (ctx.controls[kid]) { warn(ctx, `knob "${kid}" is defined twice; the first one is kept`); return clone(ctx.controls[kid].values[ctx.controls[kid].i]) }
        let values = Array.isArray(o.values) ? o.values.map(v => clone(v)).filter(v => v !== undefined) : null
        if (!values && isFinite(num(o.min)) && isFinite(num(o.max))) {
          const mn = num(o.min), mx = num(o.max), st = Math.abs(num(o.step)) || 1
          values = []
          for (let v = mn; v <= mx + st * 1e-9 && values.length < MAX_KNOB; v += st) values.push(+v.toPrecision(12))
        }
        if (!values || !values.length) { warn(ctx, `knob "${kid}" has no values; give it values: [...] or min and max`); values = [o.at === undefined ? 0 : clone(o.at)] }
        if (values.length > MAX_KNOB) { warn(ctx, `knob "${kid}" has ${values.length} values; keeps the first ${MAX_KNOB}`); values = values.slice(0, MAX_KNOB) }
        const key = v => JSON.stringify(v)
        const find = v => {
          const i = values.findIndex(x => key(x) === key(v))
          if (i >= 0 || typeof v !== 'number') return i
          // a number between values: the nearest one
          let best = -1, d = Infinity
          values.forEach((x, j) => { if (typeof x === 'number' && Math.abs(x - v) < d) { d = Math.abs(x - v); best = j } })
          return best
        }
        let start = o.at === undefined ? 0 : find(o.at)
        if (start < 0) { warn(ctx, `knob "${kid}" starts at ${key(o.at)}, which is not one of its values; it starts at the first`); start = 0 }
        let i = start
        if (Object.prototype.hasOwnProperty.call(ctx.state, kid)) { const j = find(ctx.state[kid]); if (j >= 0) i = j }
        const shown = values.map((v, j) => {
          if (typeof o.fmt === 'function') { try { return clean(o.fmt(v, j)) } catch (e) { return clean(String(v)) } }
          return typeof v === 'number' ? fmt(v) : clean(typeof v === 'object' && v ? JSON.stringify(v) : String(v))
        })
        tick(values.length / 8)
        ctx.controls[kid] = { id: kid, label: o.label != null ? clean(o.label) : kid, values: values, shown: shown, i: i, start: start }
        return clone(values[i])
      },
      // the knob drawn where the program puts it: `label ◂ value ▸`, a link to the knob, so a person can select and turn it
      dial(id, o) {
        o = o || {}
        const c = ctx.controls[String(id)]
        if (!c) { warn(ctx, `k.dial("${id}") comes before k.knob("${id}"), or there is no such knob`); return k.text(String(id), { tone: 'dim' }) }
        const label = o.label === false ? '' : (o.label != null ? String(o.label) : c.label)
        return k.text(`${label ? '{dim:' + escapeMarkup(label) + '} ' : ''}[◂ ${escapeMarkup(c.shown[c.i])} ▸](#${c.id})`, { wrap: false, w: o.w, bold: o.bold })
      },

      // ---------------- raw cells
      canvas(w, h) {
        w = clamp(int(w, W), 1, MAX_SIDE); h = clamp(int(h, 1), 1, MAX_SIDE)
        tick(w * h / 50)
        return new Canvas(w, h, ctx, tick, metaOf)
      },

      // ---------------- a map of work: threads passing stations, links, groups (makeMap below); a canvas with regions
      map(spec, o) { return makeMap(k, ctx, T, spec, o) }
    }
    k.vstack = k.stack; k.hstack = k.beside; k.hatch = k.unseen
    return k
  }
  function S0len(series) { return Array.isArray(series) ? series.length : 1 }

  // ---------------------------------------------------------------- ids, cites, examples
  // A region's id is what a selection and a handoff carry, so it should come from the program. When a program gives
  // none, the id comes from what the region shows (its cite, examples or label), never from where the call sits.
  function regionId(ctx, id, where, meta) {
    let s = id == null || id === '' ? '' : String(id)
    if (!s) {
      const m = meta || {}
      s = (typeof m.cite === 'string' && m.cite) || (typeof m.examples === 'string' && m.examples) || slug(m.label) || `${where.replace(/\W+/g, '-')}-${ctx.regionOrder.length + 1}`
      warn(ctx, `a ${where} has no id, so it is "${s}"; give each region an id of its own, so a selection survives a change to the program`)
    }
    if (!ID_RE.test(s)) {
      const t = slug(s) || 'r'
      warn(ctx, `region id "${s}" uses characters ids cannot hold; it is "${t}"`)
      s = t
    }
    if (ctx.ids[s]) {
      ctx.ids[s]++
      const t = s + '~' + ctx.ids[s]
      warn(ctx, `region id "${s}" is used ${ctx.ids[s]} times; the later one is "${t}"`)
      s = t
    } else ctx.ids[s] = 1
    ctx.regionOrder.push(s)
    return s
  }
  function registerCite(ctx, id, c) {
    if (!isObj(c)) { warn(ctx, 'k.cite needs (id, {text, source, query, rows, note})'); return null }
    id = String(id != null ? id : 'cite-' + (++ctx.seq))
    const o = Object.assign(clone(c) || {}, { id: id })
    if (c.text != null) o.text = clean(c.text)
    if (c.source != null) o.source = clean(c.source)
    if (c.query != null) o.query = String(c.query)
    let rows = Array.isArray(c.rows) ? c.rows : []
    let more = Math.max(0, num(c.more) || 0)
    if (rows.length > MAX_CITE_ROWS) { more += rows.length - MAX_CITE_ROWS; rows = rows.slice(0, MAX_CITE_ROWS) }
    o.rows = clone(rows)
    o.more = more
    if (c.note != null) o.note = clean(c.note)
    if (!rows.length && !o.note && !o.text) warn(ctx, `cite "${id}" has no rows, text or note`)
    if (ctx.cites[id] && JSON.stringify(ctx.cites[id]) !== JSON.stringify(o)) warn(ctx, `cite "${id}" is defined twice; the first one is kept`)
    if (!ctx.cites[id]) ctx.cites[id] = o
    return id
  }
  function registerExamples(ctx, id, e) {
    if (Array.isArray(e)) e = { records: e }
    if (!isObj(e)) { warn(ctx, 'k.examples needs (id, {label, records, total, fmt})'); return null }
    id = String(id != null ? id : 'ex-' + (++ctx.seq))
    const o = Object.assign(clone(e) || {}, { id: id, label: e.label != null ? clean(e.label) : '' })
    let recs = Array.isArray(e.records) ? e.records : []
    if (recs.length > MAX_RECORDS) recs = recs.slice(0, MAX_RECORDS)
    o.records = clone(recs)
    o.total = Math.max(o.records.length, num(e.total) || 0)
    if (e.fmt != null) o.fmt = String(e.fmt)
    if (!ctx.examples[id]) ctx.examples[id] = o
    return id
  }
  // meta: a label string, or {label, cite, examples, note, tone}; cite and examples are ids or inline objects
  function normMeta(m, ctx, where) {
    if (m == null) return {}
    if (typeof m === 'string' || typeof m === 'number') return { label: clean(String(m)) }
    if (!isObj(m)) return {}
    // any other field the program adds (a lineage note, a confidence, a verb's own data) is kept as given
    const o = clone(m) || {}
    if (m.label != null) o.label = clean(String(m.label)).slice(0, 120)
    if (m.note != null) o.note = clean(String(m.note))
    if (m.tone) o.tone = toneOf(m.tone, ctx)
    if (m.cite != null) o.cite = typeof m.cite === 'string' ? m.cite : registerCite(ctx, m.cite.id, m.cite)
    if (m.examples != null) o.examples = typeof m.examples === 'string' ? m.examples : registerExamples(ctx, Array.isArray(m.examples) ? null : m.examples.id, m.examples)
    // a meta that is a row of the card's data, a spread of one, or holds one as `row` or `from`: the part opens its rows
    const from = lineageOf(ctx, m)
    const named = ['ref', 'refs', 'rows', '_ref', '_rows'].some(x => o[x] != null)
    if (!named && from) o.ref = from
    delete o.onPress
    for (const key of ['row', 'from']) if (isObj(m[key]) && lineageOf(ctx, m[key])) { if (o.ref == null) o.ref = lineageOf(ctx, m[key]); delete o[key] }
    if (o.label == null) delete o.label
    if (o.cite == null) delete o.cite
    if (o.examples == null) delete o.examples
    return o
  }
  // a region's label when the program gave none: the text it holds, in reading order
  function labelOf(n) {
    const out = []
    const walk = x => {
      if (!x || out.join(' ').length > 80) return
      if (x.t === 'text') out.push(plain(x.runs).replace(/\s+/g, ' ').trim())
      else if (x.t === 'canvas') x.ops.forEach(op => { if (op[0] === 'text') out.push(plain(op[3])) })
      ;(x.kids || []).forEach(walk)
      if (x.kid) walk(x.kid)
    }
    walk(n)
    return out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 72)
  }


  // ---------------------------------------------------------------- lineage: rows of the card's data
  // The kernel binds each row of a query's output into the card's data with `_ref` (its own ref, such as
  // r3#day=2026-06-18) and `_rows` (its source rows). Every such row is indexed here, so a part drawn from one (the row
  // itself, a spread of it, or {row}) opens its rows with no ref written, and a part drawn from none is matched to the
  // row whose words and numbers it shows. A row with `_rows` and no `_ref` (an older card) gets the pointer ref
  // obj:<id>#/<path> when the host names the card.
  function indexRows(ctx, data, id) {
    ctx.rowsOf = typeof WeakMap === 'function' ? new WeakMap() : null
    ctx.rowList = []
    let seen = 0
    const walk = (v, ptr, depth) => {
      if (depth > 8 || seen > 50000 || v == null || typeof v !== 'object') return
      seen++
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, ptr + '/' + i, depth + 1)); return }
      const has = typeof v._ref === 'string' && v._ref
      if (!has && Array.isArray(v._rows) && v._rows.length && id) v._ref = 'obj:' + id + '#' + (ptr || '/')
      if (typeof v._ref === 'string' && v._ref) {
        if (ctx.rowsOf) ctx.rowsOf.set(v, v._ref)
        if (ctx.rowList.length < 20000) ctx.rowList.push({ obj: v, ref: v._ref })
      }
      for (const key of Object.keys(v)) if (key !== '_rows' && v[key] && typeof v[key] === 'object') walk(v[key], ptr + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'), depth + 1)
    }
    walk(data, '', 0)
  }
  function lineageOf(ctx, x, depth) {
    if (!isObj(x)) return null
    const hit = ctx.rowsOf && ctx.rowsOf.get(x)
    if (hit) return hit
    if (typeof x._ref === 'string' && x._ref) return x._ref
    if (!depth) for (const key of ['row', 'from']) { if (isObj(x[key])) { const r = lineageOf(ctx, x[key], 1); if (r) return r } }
    return null
  }
  function refsIn(ctx, x) {
    const out = []
    const add = r => { if (typeof r === 'string' && r && out.indexOf(r) < 0 && out.length < 200) out.push(r) }
    const walk = (v, depth) => {
      if (v == null || depth > 3 || out.length >= 200) return
      if (typeof v === 'string') { if (/^([qr]\d+(?:[#@]|$)|obj:)/.test(v) || v.indexOf('#') > 0) add(v); return }
      if (Array.isArray(v)) { v.forEach(y => walk(y, depth + 1)); return }
      if (!isObj(v)) return
      const r = lineageOf(ctx, v)
      if (r) { add(r); return }
      Object.keys(v).forEach(key => { if (key !== '_rows') walk(v[key], depth + 1) })
    }
    walk(x, 0)
    return out
  }
  // a ref as a region id: r3#day=2026-06-18 -> day-2026-06-18, obj:x#/days/3 -> days-3
  function refSlug(ref) {
    if (typeof ref !== 'string') return ''
    const frag = ref.split('#').slice(1).join('#').replace(/@.*$/, '')
    return slug(frag.replace(/[=&/]+/g, '-')) || slug(ref)
  }
  // a key value as a ref writes it (the kernel's refs.ref_value): as it is when safe, else its slug
  function refValue(v) {
    const s = typeof v === 'boolean' ? String(v) : v == null ? '' : String(v)
    if (/^[A-Za-z0-9_.:~,/+-]+$/.test(s)) return s
    return s.replace(/[^A-Za-z0-9_.:~,/+-]+/g, '-').replace(/^-+|-+$/g, '') || encodeURIComponent(s)
  }
  function askOf(ctx, sel) {
    const ev = ctx.event || {}
    if (sel == null) sel = { region: ev.region || null }
    if (typeof sel === 'string') sel = { label: sel }
    if (!isObj(sel)) sel = {}
    const out = {}
    if (sel.label != null) out.label = clean(String(sel.label)).slice(0, 200)
    const region = sel.region != null ? String(sel.region) : null
    if (region && ID_RE.test(region)) out.region = region
    const refs = refsIn(ctx, [sel.rows, sel.row, sel.refs, sel.ref].filter(x => x != null))
    if (refs.length) out.refs = refs
    if (typeof sel.text === 'string' && sel.text.trim()) out.text = clean(sel.text).slice(0, 2000)
    if (sel.note != null) out.note = clean(String(sel.note)).slice(0, 400)
    if (!out.label) out.label = out.region || (refs.length ? `${refs.length} row${refs.length === 1 ? '' : 's'} of the card` : 'this card')
    return out
  }

  // A part with no rows of its own is matched to the rows of the card's data whose words it shows (its id, its label,
  // its text) and, to tell them apart, whose numbers it shows. One row wins: its ref. Several rows of one query that
  // share the words win together: the ref of the column value they share (r3#outcome=won-clean-ep). A tie between
  // unrelated rows, or no words in common, matches nothing: a guess never picks between two rows.
  function matchRegions(ctx, regions, rootNode) {
    const rows = ctx.rowList || []
    if (!rows.length || rows.length > 5000) return
    const strs = new Map(), nums = new Map()
    rows.forEach((r, i) => {
      for (const key of Object.keys(r.obj)) {
        if (key.charAt(0) === '_') continue
        const v = r.obj[key]
        if (typeof v === 'string') {
          const t = v.trim().toLowerCase()
          if (t.length < 2 || t.length > 80) continue
          if (!strs.has(t)) strs.set(t, [])
          const l = strs.get(t)
          if (l.length < 200) l.push([i, key])
        } else if (typeof v === 'number' && isFinite(v)) {
          if (!nums.has(v)) nums.set(v, [])
          nums.get(v).push(i)
        }
      }
    })
    if (strs.size > 6000) return
    const texts = new Map()
    const textOf = n => {
      const out = []
      const vals = []
      const walk = x => {
        if (!x || out.length > 60) return
        if (x.t === 'text') out.push(plain(x.runs))
        else if (x.t === 'bar') { if (isFinite(x.value)) vals.push(x.value); if (x.parts) x.parts.forEach(p => { if (isFinite(p.value)) vals.push(p.value) }) }
        else if (x.t === 'table') x.rows.forEach(r => out.push(r.cells.map(plain).join(' ')))
        else if (x.t === 'canvas') x.ops.forEach(op => { if (op[0] === 'text') out.push(plain(op[3])); if (op[0] === 'bar') vals.push(op[4]) })
        ;(x.kids || []).forEach(walk)
        if (x.kid) walk(x.kid)
      }
      walk(n)
      return { text: out.join(' '), vals }
    }
    const kidOf = new Map()
    const collect = n => {
      if (!n || typeof n !== 'object') return
      if (n.t === 'region') kidOf.set(n.id, n.kid)
      ;(n.kids || []).forEach(collect)
      if (n.kid) collect(n.kid)
    }
    collect(rootNode)
    const word = (text, w) => {
      let at = text.indexOf(w)
      while (at >= 0) {
        const a = text.charAt(at - 1), b = text.charAt(at + w.length)
        if (!/[a-z0-9]/.test(a) && !/[a-z0-9]/.test(b)) return true
        at = text.indexOf(w, at + 1)
      }
      return false
    }
    for (const r of regions) {
      const m = r.meta || (r.meta = {})
      if (['ref', 'refs', 'rows', '_ref', '_rows'].some(x => m[x] != null) || m.knob || (m.cite && ctx.cites[m.cite] && (ctx.cites[m.cite].ref || (ctx.cites[m.cite].rows || []).length))) continue
      ctx.ops += 1
      const kid = kidOf.get(r.id)
      const got = kid ? (texts.get(r.id) || textOf(kid)) : { text: '', vals: [] }
      const text = (String(r.id).replace(/[-_]+/g, ' ') + ' ' + (m.label || '') + ' ' + got.text).toLowerCase()
      const idSlug = String(r.id).toLowerCase()
      const score = new Map(), field = new Map()
      for (const [t, list] of strs) {
        if (!(word(text, t) || (t.length >= 3 && idSlug.indexOf(slug(t)) >= 0 && slug(t).length >= 3))) continue
        for (const [i, key] of list) { score.set(i, (score.get(i) || 0) + 2); if (!field.has(i)) field.set(i, [key, t]) }
      }
      const shown = got.vals.concat((text.match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map(x => +x.replace(/,/g, '')).filter(isFinite))
      if (!score.size) {
        // no words in common: a part that shows three or more of one row's numbers, and no other row's as many, is a copy
        // the program made of that row's values (a bar item built from a row's fields): that row
        const distinct = shown.filter((v, i) => Math.abs(v) >= 2 && shown.indexOf(v) === i)
        if (distinct.length < 3) continue
        const hits = new Map()
        for (const v of distinct) for (const i of new Set(nums.get(v) || [])) hits.set(i, (hits.get(i) || 0) + 1)
        let top = -1, best = 0, tie = false
        hits.forEach((v, i) => { if (v > best) { best = v; top = i; tie = false } else if (v === best) tie = true })
        if (best >= 3 && !tie) { m.ref = rows[top].ref; m.lineage = 'matched' }
        continue
      }
      for (const v of shown) for (const i of (nums.get(v) || [])) if (score.has(i)) score.set(i, score.get(i) + 1)
      let best = 0
      score.forEach(v => { if (v > best) best = v })
      const top = []
      score.forEach((v, i) => { if (v === best) top.push(i) })
      if (top.length === 1) { m.ref = rows[top[0]].ref; m.lineage = 'matched'; continue }
      // several rows share the words: one query's rows with the same value in one column are one group
      const q = rows[top[0]].ref.split('#')[0]
      const f = field.get(top[0])
      if (top.length <= 500 && /^[qr]\d+$/.test(q) && top.every(i => rows[i].ref.split('#')[0] === q && field.get(i) && field.get(i)[0] === f[0] && field.get(i)[1] === f[1])) {
        m.ref = `${q}#${refValue(f[0])}=${refValue(rows[top[0]].obj[f[0]])}`
        m.lineage = 'matched'
      }
    }
  }

  // ---------------------------------------------------------------- series for plots
  function normSeries(series, ctx) {
    const isNumLike = v => typeof v === 'number' || v == null || (typeof v === 'string' && isFinite(num(v)))
    if (!Array.isArray(series)) series = series ? [series] : []
    if (series.length && series.every(isNumLike)) series = [{ values: series }]
    else if (series.length && series.every(p => Array.isArray(p) && p.length === 2 && isNumLike(p[0]))) series = [{ points: series }]
    return series.filter(isObj).map(s => {
      let pts = []
      if (Array.isArray(s.points)) pts = s.points.map(p => Array.isArray(p) ? [num(p[0]), p[1] == null ? null : num(p[1])] : [num(p.x), p.y == null ? null : num(p.y)])
      else if (Array.isArray(s.values)) pts = s.values.map((v, j) => [j, v == null ? null : num(v)])
      pts = pts.filter(p => isFinite(p[0])).map(p => [p[0], p[1] === null || !isFinite(p[1]) ? null : p[1]])
      if (pts.length > MAX_SERIES_POINTS) { warn(ctx, `a plot series has ${pts.length} points; keeps ${MAX_SERIES_POINTS}`); pts = pts.slice(0, MAX_SERIES_POINTS) }
      return Object.assign({}, s, { pts: pts })
    })
  }

  // ---------------------------------------------------------------- canvas: raw cells, recorded as operations
  // Positions are cells (x across, y down). px and line work in half cells down: y from 0 to 2h-1.
  function Canvas(w, h, ctx, tick, metaOf) {
    this.w = w; this.h = h
    this._ops = []
    this._ctx = ctx; this._tick = tick; this._metaOf = metaOf
  }
  const cT = (c, t, d) => toneOf(t, c._ctx, d || 'ink')
  const fl = v => Math.floor(Number(v) || 0)
  Canvas.prototype._op = function (op) { this._tick(1); if (this._ops.length < 20000) this._ops.push(op); else warn(this._ctx, 'canvas: more than 20,000 drawing calls; the rest are dropped'); return this }
  Canvas.prototype.put = function (x, y, ch, tone, o) {
    if (typeof o === 'boolean') o = { bold: o }
    o = o || {}
    const c = Array.from(clean(ch == null ? ' ' : ch).replace(/\n/g, ''))[0] || ' '
    const op = ['put', fl(x), fl(y), c, cT(this, tone)]
    if (o.bold || o.bg) op.push(o.bold ? 1 : 0)
    if (o.bg) op.push(cT(this, o.bg))
    return this._op(op)
  }
  Canvas.prototype.text = function (x, y, str, o) {
    if (typeof o === 'string') o = { tone: o }
    o = o || {}
    const op = ['text', fl(x), fl(y), inline(str, { tone: o.tone, bold: o.bold, raw: o.raw }, this._ctx).filter(r => !r.br), o.align === 'right' || o.align === 'center' ? o.align : 'left']
    if (o.max != null) op.push(Math.max(0, int(o.max, 0)))
    return this._op(op)
  }
  Canvas.prototype.fill = function (x, y, w, h, ch, tone) {
    const c = Array.from(clean(ch == null ? ' ' : ch).replace(/\n/g, ''))[0] || ' '
    return this._op(['fill', fl(x), fl(y), Math.max(0, fl(w)), Math.max(0, fl(h)), c, cT(this, tone)])
  }
  Canvas.prototype.hline = function (x, y, w, ch, tone) { return this._op(['hline', fl(x), fl(y), Math.max(0, fl(w)), Array.from(String(ch || '─'))[0], cT(this, tone, 'dim')]) }
  Canvas.prototype.vline = function (x, y, h, ch, tone) { return this._op(['vline', fl(x), fl(y), Math.max(0, fl(h)), Array.from(String(ch || '│'))[0], cT(this, tone, 'dim')]) }
  Canvas.prototype.box = function (x, y, w, h, o) {
    if (typeof o === 'string') o = { title: o }
    o = o || {}
    const op = ['box', fl(x), fl(y), Math.max(0, fl(w)), Math.max(0, fl(h)), cT(this, o.tone, 'dim')]
    if (o.title != null) op.push(inline(o.title, { bold: true }, this._ctx).filter(r => !r.br))
    // fill: an opaque box (a callout over what was drawn before it): its inside is cleared on both surfaces
    if (o.fill) { if (op.length < 7) op.push(null); op.push({ fill: true }) }
    return this._op(op)
  }
  // a background under cells already drawn (a picked chip, a highlighted run): the terminal colors the cells' ground,
  // the browser draws one rounded band behind them
  Canvas.prototype.bg = function (x, y, w, h, tone) { return this._op(['bg', fl(x), fl(y), Math.max(0, fl(w)), Math.max(0, fl(h)), cT(this, tone, 'accent-faint')]) }
  Canvas.prototype.px = function (x, y, tone) { return this._op(['px', fl(x), fl(y), cT(this, tone, 'accent')]) }
  Canvas.prototype.line = function (x0, y0, x1, y1, tone) { return this._op(['line', +x0 || 0, +y0 || 0, +x1 || 0, +y1 || 0, cT(this, tone, 'accent')]) }
  // value marks inside a canvas keep their numbers, so the browser draws them exactly
  Canvas.prototype.bar = function (x, y, w, value, max, tone) { return this._op(['bar', fl(x), fl(y), Math.max(1, fl(w)), num(value), num(max) > 0 ? num(max) : 1, cT(this, tone, 'accent')]) }
  Canvas.prototype.spark = function (x, y, values, o) {
    o = o || {}
    const vals = (Array.isArray(values) ? values : []).slice(-MAX_SERIES_POINTS).map(v => v == null || !isFinite(num(v)) ? null : num(v))
    const fin = vals.filter(v => v !== null)
    const mn = isFinite(num(o.min)) ? num(o.min) : Math.min(0, Math.min.apply(null, fin.concat([0])))
    let mx = isFinite(num(o.max)) ? num(o.max) : Math.max.apply(null, fin.concat([mn + 1]))
    if (mx === mn) mx = mn + 1
    return this._op(['spark', fl(x), fl(y), Math.max(1, int(o.w, vals.length)), vals, mn, mx, cT(this, o.tone, 'accent')])
  }
  Canvas.prototype.region = function (id, x, y, w, h, meta) {
    const press = isObj(meta) && typeof meta.onPress === 'function' ? meta.onPress : null
    const m = this._metaOf(meta, 'canvas region')
    const rid = regionId(this._ctx, id, 'canvas region', m)
    if (!m.label) m.label = rid
    // a press on this part: the same as k.on('press:<id>', fn), as for k.region
    const hs = this._ctx.handlers
    if (press && !hs.some(x => x.name === 'press:' + rid)) hs.push({ name: 'press:' + rid, fn: press, label: clean(String(m.label)).slice(0, 40) })
    return this._op(['region', rid, fl(x), fl(y), Math.max(1, fl(w)), Math.max(1, fl(h)), m])
  }
  // a brush area: in the browser, a drag across cells x..x+w is an event {type: 'brush', id, from, to}, the cells read
  // as min..max (default: the cell numbers); the terminal has no drag, so bind keys to the same state
  Canvas.prototype.brush = function (id, x, y, w, h, o) {
    o = isObj(o) ? o : {}
    const bid = ID_RE.test(String(id)) ? String(id) : (slug(id) || 'brush')
    const W = Math.max(1, fl(w))
    return this._op(['brush', bid, fl(x), fl(y), W, Math.max(1, fl(h)), isFinite(num(o.min)) ? num(o.min) : 0, isFinite(num(o.max)) ? num(o.max) : W, !!o.log])
  }
  // a node-link drawing at the surface's own resolution: positions in cells, fractions allowed. The browser draws a dot
  // as a circle exactly there and a link as a thin stroke between two points; the terminal draws the nearest cell's
  // glyph (● ◉ ○) and a link as glyphs (─ │ ╱ ╲) on the blank cells between its ends. o: {size: 1–3, hollow, bold,
  // bg, glyph, label, labelTone, part, meta}: with `part` the dot is a part of its own, its hit area the dot itself
  const fx = v => { const n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : 0 }
  Canvas.prototype.dot = function (x, y, tone, o) {
    o = isObj(o) ? o : {}
    const f = { size: clamp(int(o.size, 1), 1, 3) }
    if (o.hollow) f.hollow = true
    if (o.bold) f.bold = true
    if (o.bg) f.bg = cT(this, o.bg)
    if (o.glyph != null) f.glyph = Array.from(clean(String(o.glyph)).replace(/\n/g, ''))[0] || '●'
    // a few words beside the dot (×3, a name), set where the dot is
    if (o.label != null && String(o.label).trim()) { f.label = Array.from(clean(String(o.label)).replace(/\n/g, ' ')).slice(0, 40).join(''); f.labelTone = cT(this, o.labelTone, 'dim') }
    if (o.part != null) {
      const m = this._metaOf(o.meta, 'dot')
      f.region = regionId(this._ctx, o.part, 'dot', m)
      if (!m.label) m.label = f.region
      f.meta = m
    }
    return this._op(['dot', fx(x), fx(y), cT(this, tone, 'accent'), f])
  }
  // o: {dash}: a dashed link (a revision, a weak tie)
  Canvas.prototype.link = function (x0, y0, x1, y1, tone, o) {
    o = isObj(o) ? o : {}
    return this._op(['link', fx(x0), fx(y0), fx(x1), fx(y1), cT(this, tone, 'dim'), o.dash ? { dash: true } : {}])
  }
  Canvas.prototype.node = function () { return { t: 'canvas', w: this.w, h: this.h, ops: this._ops.slice() } }

  // ---------------------------------------------------------------- wide characters (the terminal draws them 2 cells)
  function wide(cp) {
    if (cp >= 0x1F000 && cp <= 0x1FAFF) return true
    if ((cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x20000 && cp <= 0x3FFFD)) return true
    return false
  }

  // ---------------------------------------------------------------- map: work laid out by its own structure
  // k.map(spec, o) composes a canvas from a loose spec: threads (one long run, many runs, the agents of a swarm) that
  // pass stations (moves, places, concepts) in order, links between stations, and groups of stations. Every field is
  // optional, several names are read for each (stations or nodes, links or edges, stops or path), and the parts' meta
  // keep any other field given. The form follows the shape, unless o.form names one:
  //   line     one thread: its stations along one line, numbered by step; the mini form is one row, to scale
  //   metro    many threads: stations in columns, bundles of threads between them that fork and merge; a bundle splits
  //            into one lane per value of the lens, its count printed on it, and where a column runs out of rows its
  //            biggest bundle stays one striped lane with a count per value (cells cannot draw 40 thin lines)
  //   regions  stations with no threads: groups as boxes of stations, a dot sized by each station's count
  // o: {form, full (false: the calm mini form), lens (a thread field), rows (a row budget), unit, title}
  // Every station, group and lane is a region whose meta names its rows (`ref`, or the source rows a query bound) and
  // carries the moves through it as examples, so a selection leads to the real rows.
  const MAP_GLY = {
    3: { h: '━', v: '┃', LD: '┓', UR: '┗', LU: '┛', DR: '┏' },
    2: { h: '─', v: '│', LD: '╮', UR: '╰', LU: '╯', DR: '╭' },
    1: { h: '┄', v: '┆', LD: '╮', UR: '╰', LU: '╯', DR: '╭' },
  }
  const MAP_GOOD = /\b(fix(ed|es)?|merge[sd]?|pass(ed|es)?|green|done|success(ful)?|solved|resolved|correct|complete[sd]?|approved|yes|true|ok)\b|✓/i
  const MAP_BAD = /\b(fail(ed|s|ure)?|error|broke|broken|time[ds]? ?out|crash(ed)?|wrong|rejected|false|no)\b|✗/i
  const MAP_WARN = /\b(mask(ed|s)?|skip(ped)?|retr(y|ied)|partial|gave up|stuck|flaky|stale|abandoned|cut off|unfinished|incomplete|stopped)\b/i

  // a short name for a label: its first word and the next telling one (one with a digit or #, else the next word that
  // is not a small word), as "reviews #66110" for "reviews and approves #66110" or "shares build" for "shares the build"
  const SMALL = /^(the|a|an|of|to|in|on|for|with|and|or|its|it|at|by|from|as|is|are|be|into|then)$/i
  function shortName(label) {
    const w = String(label || '').replace(/[,;:()]/g, ' ').split(/\s+/).filter(Boolean)
    if (w.length <= 2) return w.join(' ')
    const rest = w.slice(1)
    const tell = rest.find(x => /[\d#@/_]/.test(x)) || rest.find(x => !SMALL.test(x)) || rest[0]
    return w[0] + ' ' + tell
  }
  const mslug = (s, n) => (slug(s) || slug('x-' + s) || 'x').slice(0, n || 48).replace(/-+$/, '')
  function mapList(v) {
    if (Array.isArray(v)) return v
    if (isObj(v)) return Object.keys(v).map(id => Object.assign({ id: id }, isObj(v[id]) ? v[id] : { label: v[id] }))
    return []
  }
  function firstOf(o, names) {
    if (!isObj(o)) return undefined
    for (const n of names) if (o[n] != null && o[n] !== '') return o[n]
    return undefined
  }
  const refList = v => (typeof v === 'string' && v ? [v] : Array.isArray(v) ? v.filter(x => typeof x === 'string' && x).slice(0, 50) : [])
  const scalar = v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

  // the loose spec, read into {title, unit, stations, threads, links, groups, lens}
  function mapSpec(spec, o, ctx) {
    spec = isObj(spec) ? spec : {}
    const from = names => { for (const n of names) if (spec[n] != null) return mapList(spec[n]); return [] }
    const stations = new Map()
    const station = raw => {
      const r = isObj(raw) ? raw : { id: raw }
      const id = firstOf(r, ['id', 'key', 'station', 'name', 'label'])
      if (id == null || (!scalar(id))) return null
      const sid = clean(String(id)).slice(0, 120)
      if (!sid) return null
      let s = stations.get(sid)
      if (!s) { s = { id: sid, label: sid, raw: {}, threads: [], stops: [] }; stations.set(sid, s) }
      if (isObj(raw)) {
        Object.keys(raw).forEach(kk => { if (kk !== '_rows' && kk !== 'examples') s.raw[kk] = raw[kk] })
        const lab = firstOf(raw, ['label', 'name', 'title'])
        if (lab != null && scalar(lab)) s.label = clean(String(lab))
        if (raw.short != null) s.short = clean(String(raw.short))
        const n = num(firstOf(raw, ['n', 'count', 'size', 'value', 'total']))
        if (isFinite(n)) s.n = n
        const ref = refList(firstOf(raw, ['ref', 'refs', 'rows']))
        if (ref.length) s.ref = ref
        else if (Array.isArray(raw._rows) && raw._rows.length) s.ref = refList(raw._rows)
        if (Array.isArray(raw.examples)) s.examples = raw.examples
        const g = firstOf(raw, ['group', 'region', 'area', 'cluster'])
        if (g != null && scalar(g)) s.group = String(g)
        if (raw.mark != null) s.mark = Array.from(clean(String(raw.mark)))[0]
        if (raw.tone != null) s.tone = raw.tone
        const note = firstOf(raw, ['note', 'rule', 'why', 'text', 'what'])
        if (note != null && scalar(note)) s.note = clean(String(note))
        if (raw.end || raw.sink || raw.final || raw.ending) s.end = true
      }
      return s
    }
    from(['stations', 'nodes', 'places', 'concepts', 'moves_list']).forEach(station)
    const threads = new Map()
    const thread = raw => {
      const r = isObj(raw) ? raw : { id: raw }
      const id = firstOf(r, ['id', 'thread', 'run', 'agent', 'name', 'label'])
      if (id == null || !scalar(id)) return null
      const tid = clean(String(id)).slice(0, 120)
      let t = threads.get(tid)
      if (!t) { t = { id: tid, label: tid, fields: {}, stops: [] }; threads.set(tid, t) }
      if (isObj(raw)) {
        const lab = firstOf(raw, ['label', 'name', 'title'])
        if (lab != null && scalar(lab)) t.label = clean(String(lab))
        const steps = num(firstOf(raw, ['steps', 'length', 'len', 'total', 'records']))
        if (isFinite(steps)) t.steps = steps
        const ref = refList(firstOf(raw, ['ref', 'refs', 'file', 'rows']))
        if (ref.length) t.ref = ref
        else if (Array.isArray(raw._rows) && raw._rows.length) t.ref = refList(raw._rows)
        // a thread that is a row of the card's data (a query's output): that row, which opens the thread's own rows
        const row = ctx ? lineageOf(ctx, raw) : null
        if (row) t.row = row
        if (raw.tone != null) t.tone = raw.tone
        Object.keys(raw).forEach(kk => {
          if (kk[0] !== '_' && scalar(raw[kk]) && ['id', 'label', 'name', 'title', 'ref', 'file', 'tone'].indexOf(kk) < 0) t.fields[kk] = raw[kk]
        })
        const stops = firstOf(raw, ['stops', 'path', 'stations', 'moves', 'visits', 'trail'])
        if (Array.isArray(stops)) stops.forEach(x => addStop(t, x))
      }
      return t
    }
    const addStop = (t, x) => {
      const r = isObj(x) ? x : { station: x }
      const s = station(isObj(x) ? (firstOf(r, ['station', 'at', 'stop']) != null ? { id: firstOf(r, ['station', 'at', 'stop']) } : r) : x)
      if (!s) return
      const stop = { station: s.id, thread: t.id }
      const a = num(firstOf(r, ['from', 'start', 'step', 'first']))
      const b = num(firstOf(r, ['to', 'end', 'last']))
      if (isFinite(a)) stop.from = a
      if (isFinite(b)) stop.to = b
      const ref = refList(firstOf(r, ['ref', 'refs', 'rows']))
      if (ref.length) stop.ref = ref
      else if (Array.isArray(r._rows) && r._rows.length) stop.ref = refList(r._rows)
      const rep = num(firstOf(r, ['repeat', 'repeats', 'times', 'loop']))
      if (isFinite(rep) && rep > 1) stop.repeat = rep
      const note = firstOf(r, ['note', 'text', 'what', 'quote'])
      if (note != null && scalar(note)) stop.note = clean(String(note))
      if (r.mark != null) stop.mark = Array.from(clean(String(r.mark)))[0]
      if (r.tone != null) stop.tone = r.tone
      if (r.label != null && isObj(x) && firstOf(r, ['station', 'at', 'stop']) != null) stop.label = clean(String(r.label))
      Object.keys(r).forEach(kk => { if (kk[0] !== '_' && scalar(r[kk]) && stop[kk] === undefined && ['station', 'at', 'stop', 'thread'].indexOf(kk) < 0) stop[kk] = r[kk] })
      t.stops.push(stop)
    }
    from(['threads', 'runs', 'agents', 'lines', 'trails']).forEach(thread)
    from(['moves', 'visits', 'stops', 'steps_list']).forEach(m => {
      if (!isObj(m)) return
      const tid = firstOf(m, ['thread', 'run', 'agent'])
      if (tid == null || !scalar(tid)) return
      const t = thread({ id: tid })
      if (t) addStop(t, m)
    })
    for (const t of threads.values()) {
      if (t.stops.length && t.stops.every(s => s.from != null)) t.stops.sort((a, b) => a.from - b.from)
      t.stops.forEach((s, i) => {
        if (s.to == null && s.from != null) { const nx = t.stops[i + 1]; s.to = nx && nx.from != null ? Math.max(s.from, nx.from - 1) : (t.steps != null ? Math.max(s.from, t.steps) : s.from) }
        const S = stations.get(s.station)
        if (S.threads.indexOf(t.id) < 0) S.threads.push(t.id)
        S.stops.push(s)
      })
    }
    const links = from(['links', 'edges', 'flows', 'arrows']).filter(isObj).map(l => {
      const a = firstOf(l, ['from', 'source', 'a', 'src']), b = firstOf(l, ['to', 'target', 'b', 'dst'])
      if (a == null || b == null || !scalar(a) || !scalar(b)) return null
      const A = station({ id: a }), B = station({ id: b })
      if (!A || !B) return null
      const q = { from: A.id, to: B.id, raw: l }
      const n = num(firstOf(l, ['n', 'count', 'weight', 'value', 'threads']))
      if (isFinite(n)) q.n = n
      const lab = firstOf(l, ['label', 'name', 'what', 'note'])
      if (lab != null && scalar(lab)) q.label = clean(String(lab))
      if (l.kind != null) q.kind = clean(String(l.kind))
      if (l.tone != null) q.tone = l.tone
      const ref = refList(firstOf(l, ['ref', 'refs', 'rows']))
      if (ref.length) q.ref = ref
      if (isObj(l.by)) q.by = l.by
      return q
    }).filter(Boolean)
    const groups = new Map()
    from(['groups', 'regions', 'areas', 'clusters']).forEach(g => {
      const r = isObj(g) ? g : { id: g }
      const id = firstOf(r, ['id', 'key', 'name', 'label'])
      if (id == null || !scalar(id)) return
      const gid = clean(String(id))
      const G = groups.get(gid) || { id: gid, label: gid, stations: [], raw: {} }
      if (isObj(g)) {
        Object.keys(g).forEach(kk => { if (kk !== '_rows') G.raw[kk] = g[kk] })
        const lab = firstOf(g, ['label', 'name', 'title']); if (lab != null && scalar(lab)) G.label = clean(String(lab))
        if (g.tone != null) G.tone = g.tone
        const n = num(firstOf(g, ['n', 'count', 'size', 'total'])); if (isFinite(n)) G.n = n
        const ref = refList(firstOf(g, ['ref', 'refs', 'rows'])); if (ref.length) G.ref = ref
        else if (Array.isArray(g._rows) && g._rows.length) G.ref = refList(g._rows)
        const note = firstOf(g, ['note', 'why', 'text']); if (note != null && scalar(note)) G.note = clean(String(note))
        const members = firstOf(g, ['stations', 'members', 'items', 'concepts', 'nodes'])
        if (Array.isArray(members)) members.forEach(m => { const s = station(m); if (s) { s.group = s.group || gid; if (G.stations.indexOf(s.id) < 0) G.stations.push(s.id) } })
      }
      groups.set(gid, G)
    })
    for (const s of stations.values()) {
      if (!s.group) continue
      const G = groups.get(s.group) || { id: s.group, label: s.group, stations: [], raw: {} }
      if (G.stations.indexOf(s.id) < 0) G.stations.push(s.id)
      groups.set(s.group, G)
    }
    let lens = o.lens !== undefined ? o.lens : spec.lens
    if (typeof lens === 'string') lens = { by: lens }
    if (!isObj(lens)) lens = null
    else lens = { by: String(firstOf(lens, ['by', 'field', 'name', 'key']) || ''), tones: isObj(lens.tones) ? lens.tones : {}, order: Array.isArray(lens.order) ? lens.order.map(String) : null, label: lens.label != null ? clean(String(lens.label)) : null }
    if (lens && !lens.by) lens = null
    const title = o.title != null ? String(o.title) : spec.title != null ? String(spec.title) : ''
    return { title: clean(title), unit: clean(String(o.unit || spec.unit || '')), stations, threads: [...threads.values()], links, groups: [...groups.values()], lens }
  }

  // the cells a map draws, kept as cells until they become canvas ops (lines as hline/vline, so the browser strokes them)
  function MapGrid(w, h) { this.w = w; this.h = h; this.c = new Array(w * h).fill(null); this.regs = new Map(); this.boxes = [] }
  MapGrid.prototype.inb = function (x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h }
  MapGrid.prototype.get = function (x, y) { return this.inb(x, y) ? this.c[y * this.w + x] : undefined }
  MapGrid.prototype.set = function (x, y, cell) { if (this.inb(x, y)) this.c[y * this.w + x] = cell }
  MapGrid.prototype.free = function (x, y) { return this.inb(x, y) && !this.c[y * this.w + x] }
  MapGrid.prototype.freeSpan = function (x, y, n) { for (let i = 0; i < n; i++) if (!this.free(x + i, y)) return false; return true }
  MapGrid.prototype.str = function (x, y, s, tone, o) {
    o = o || {}
    let dx = 0
    let chars = Array.from(String(s))
    // o.max: cut to that many cells, the last one an ellipsis
    if (o.max != null && chars.length > o.max) chars = chars.slice(0, Math.max(0, o.max - 1)).concat(['…'])
    for (const ch of chars) { if (this.inb(x + dx, y)) this.set(x + dx, y, { ch: ch, tone: tone || 'ink', b: !!o.b, kind: o.kind || 'text' }); dx++ }
    return dx
  }
  MapGrid.prototype.rect = function (id, x, y, w, h) {
    const r = this.regs.get(id)
    if (!r || w <= 0 || h <= 0) return
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(this.w, x + w), y1 = Math.min(this.h, y + h)
    if (x1 > x0 && y1 > y0) r.rects.push([x0, y0, x1 - x0, y1 - y0])
  }
  // the rows in use, from the first to the last that holds anything
  MapGrid.prototype.used = function () {
    let a = this.h, b = -1
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (this.c[y * this.w + x] && this.c[y * this.w + x].ch !== ' ') { if (y < a) a = y; if (y > b) b = y; break }
    this.boxes.forEach(q => { a = Math.min(a, q[1]); b = Math.max(b, q[1] + q[3] - 1) })
    return b < a ? [0, 0] : [a, b]
  }
  const H_LINE = '─━┄╌═'
  const V_LINE = '│┃┆╎'
  MapGrid.prototype.toCanvas = function (tick) {
    const [y0, y1] = this.used()
    const H = Math.max(1, y1 - y0 + 1)
    const ops = []
    const done = new Uint8Array(this.w * this.h)
    // vertical runs of one line glyph and tone
    for (let x = 0; x < this.w; x++) {
      for (let y = y0; y <= y1; y++) {
        const c = this.get(x, y)
        if (!c || V_LINE.indexOf(c.ch) < 0 || done[y * this.w + x]) continue
        let e = y
        while (e + 1 <= y1) { const d = this.get(x, e + 1); if (d && d.ch === c.ch && d.tone === c.tone && !d.pat) e++; else break }
        if (c.pat) e = y
        for (let j = y; j <= e; j++) done[j * this.w + x] = 1
        ops.push(e > y ? ['vline', x, y - y0, e - y + 1, c.ch, c.tone] : ['put', x, y - y0, c.ch, c.tone])
      }
    }
    for (let y = y0; y <= y1; y++) {
      let x = 0
      while (x < this.w) {
        const c = this.get(x, y)
        if (!c || done[y * this.w + x] || c.ch === ' ') { x++; continue }
        if (H_LINE.indexOf(c.ch) >= 0 && !c.pat) {
          let e = x
          while (e + 1 < this.w) { const d = this.get(e + 1, y); if (d && d.ch === c.ch && d.tone === c.tone && !d.pat && !done[y * this.w + e + 1]) e++; else break }
          ops.push(e > x ? ['hline', x, y - y0, e - x + 1, c.ch, c.tone] : ['put', x, y - y0, c.ch, c.tone])
          x = e + 1
          continue
        }
        if (c.kind === 'text') {
          const runs = []
          let e = x
          while (e < this.w) {
            const d = this.get(e, y)
            if (!d || d.kind !== 'text' || done[y * this.w + e]) break
            const last = runs[runs.length - 1]
            if (last && last.tone === d.tone && !!last.b === !!d.b) last.s += d.ch
            else { const r = { s: d.ch, tone: d.tone }; if (d.b) r.b = true; runs.push(r) }
            e++
          }
          // trailing spaces of a run of words are not drawn
          const lr = runs[runs.length - 1]
          if (lr) lr.s = lr.s.replace(/\s+$/, '')
          if (runs.some(r => r.s.trim())) ops.push(['text', x, y - y0, runs.filter(r => r.s.length), 'left'])
          x = e
          continue
        }
        const op = ['put', x, y - y0, c.ch, c.tone]
        if (c.b || c.bg) op.push(c.b ? 1 : 0)
        if (c.bg) op.push(c.bg)
        ops.push(op)
        x++
      }
    }
    this.boxes.forEach(q => ops.unshift(['box', q[0], q[1] - y0, q[2], q[3], q[4], q[5]]))
    for (const [id, r] of this.regs) r.rects.forEach(q => { if (q[1] + q[3] > y0 && q[1] <= y1) ops.push(['region', id, q[0], Math.max(0, q[1] - y0), q[2], Math.min(q[3], y1 + 1 - q[1]), r.meta]) })
    tick(ops.length)
    return { t: 'canvas', w: this.w, h: H, ops: ops }
  }

  // The rows of the threads through a part of a map, each once: per thread its stop's rows there, else the thread's own
  // row of the card's data, else its rows. pairs: [stop or null, thread or null].
  function mapRows(pairs) {
    const out = []
    const seen = new Set()
    const add = r => { if (typeof r === 'string' && r && !seen.has(r) && out.length < MAX_PART_REFS) { seen.add(r); out.push(r) } }
    for (const [st, t] of pairs) {
      if (st && st.ref && st.ref.length) st.ref.forEach(add)
      else if (t && t.row) add(t.row)
      else if (t && t.ref) t.ref.forEach(add)
    }
    return out
  }

  function makeMap(k, ctx, T, spec, o) {
    o = isObj(o) ? o : {}
    const M = mapSpec(spec, o, ctx)
    // inside a frame by default, as k.bars is: the frame takes four columns
    const W = clamp(int(o.w, k.w - 4), 16, MAX_SIDE)
    const full = o.full != null ? !!o.full : isObj(spec) && spec.full != null ? !!spec.full : k.mode === 'detail'
    const lineThreads = M.threads.filter(t => t.stops.length)
    const flows = lineThreads.some(t => t.stops.length > 1) || M.links.length > 0
    const asked = o.form || (isObj(spec) ? spec.form : null)
    let form = ['line', 'metro', 'regions'].indexOf(asked) >= 0 ? asked
      : lineThreads.length === 1 ? 'line' : flows && (lineThreads.length > 1 || M.links.length) ? 'metro' : 'regions'
    if (form === 'metro' && !flows) form = 'regions'
    if (form === 'line' && !lineThreads.length) form = 'regions'
    const unit = M.unit || (form === 'line' ? 'steps' : form === 'metro' && lineThreads.length ? 'threads' : '')
    // lens: a field of the threads; the values in their order, each with a tone
    const lens = M.lens && form !== 'regions' ? Object.assign({}, M.lens) : null
    if (lens) {
      const seen = []
      lineThreads.forEach(t => { const v = t.fields[lens.by]; if (v != null && seen.indexOf(String(v)) < 0) seen.push(String(v)) })
      lens.values = lens.order ? lens.order.filter(v => seen.indexOf(v) >= 0).concat(seen.filter(v => lens.order.indexOf(v) < 0)) : seen
      // Claude's tones first; else good, warn and bad by the value's words, each once, then categories
      lens.tone = {}
      const used = new Set()
      lens.values.forEach(v => { if (lens.tones[v]) { lens.tone[v] = T(lens.tones[v]); used.add(lens.tone[v]) } })
      lens.values.forEach(v => {
        if (lens.tone[v]) return
        const want = MAP_GOOD.test(v) ? 'good' : MAP_WARN.test(v) ? 'warn' : MAP_BAD.test(v) ? 'bad' : null
        const t = want && !used.has(want) ? want : CATS.find(c => !used.has(c)) || 'dim'
        lens.tone[v] = t
        used.add(t)
      })
      if (!lens.values.length) warn(ctx, `k.map: no thread has the lens field "${lens.by}"`)
    }
    const valueOf = t => (lens ? (t.fields[lens.by] == null ? '(none)' : String(t.fields[lens.by])) : '')
    const toneOfThread = t => (lens ? lens.tone[valueOf(t)] || 'dim' : t.tone ? T(t.tone) : 'accent')

    // regions: one per station, group and lane, with the station's rows and its moves as examples
    const regOf = new Map()
    const byId = new Map(M.threads.map(t => [t.id, t]))
    const threadOf = id => byId.get(id) || null
    const unitWord = (n, u) => (u ? `${fmt(n)} ${n === 1 ? u.replace(/s$/, '') : u}` : fmt(n))
    const stationRegion = (g, s, extra) => {
      if (regOf.has('s:' + s.id)) return regOf.get('s:' + s.id)
      const meta = Object.assign({}, s.raw, extra || {})
      delete meta.id
      meta.label = s.label + (s.n != null ? ` · ${unitWord(s.n, s.threads.length ? '' : unit)}` : s.threads.length > 1 ? ` · ${unitWord(s.threads.length, unit)}` : '')
      meta.station = s.id
      if (s.note) meta.note = s.note
      if (s.ref) meta.ref = s.ref.length === 1 ? s.ref[0] : s.ref
      const recs = []
      if (Array.isArray(s.examples)) s.examples.forEach(x => { if (isObj(x)) recs.push({ ref: x.ref, text: clean(String(firstOf(x, ['text', 'quote', 'label']) || x.ref || '')) }); else if (scalar(x)) recs.push({ text: clean(String(x)) }) })
      s.stops.forEach(st => {
        if (!st.ref) return
        const span = st.from != null ? ` · ${st.to != null && st.to !== st.from ? `${fmt(st.from)}–${fmt(st.to)}` : fmt(st.from)}` : ''
        recs.push({ ref: st.ref[0], text: `${st.thread}${span}${st.note ? ': ' + st.note : ''}` })
      })
      // with no ref of its own: the rows of every thread through it
      if (!meta.ref) { const r = mapRows(s.stops.map(st => [st, threadOf(st.thread)])); if (r.length) meta.ref = r.length === 1 ? r[0] : r }
      if (s.threads.length && s.threads.length <= 400) meta.threads = s.threads.slice()
      if (recs.length) meta.examples = registerExamples(ctx, 'ex-' + mslug(s.id, 40), { label: `${s.label}: ${s.threads.length > 1 ? 'the ' + unit + ' through it' : 'its rows'}`, records: recs.slice(0, 200), total: recs.length, fmt: '{text}' })
      const id = regionId(ctx, 'st-' + mslug(s.id, 56), 'map station', meta)
      g.regs.set(id, { meta: meta, rects: [] })
      regOf.set('s:' + s.id, id)
      return id
    }

    let grid, key = []
    if (form === 'metro' && !full && lineThreads.length > 1) {
      // the mini form of many threads: the stations that tell the story, the rest folded into the lanes between them
      const R = mapReduce(M, lineThreads, unit)
      if (R) {
        const r = mapMetro(k, R.M, R.threads, W, false, unit, o.lens ? lens : null, valueOf, stationRegion, ctx, T, o, lens)
        grid = r.g
      }
    }
    if (form === 'metro' && !full && !lineThreads.length && M.links.length > 8) {
      // the calm form of flows with no threads: the biggest flows, about three quarters of the whole, the rest named in
      // one line under them
      const all = M.links.slice().sort((a, b) => (b.n || 0) - (a.n || 0))
      const sum = all.reduce((a, l) => a + (l.n || 0), 0)
      const kept = []
      let got = 0
      for (const l of all) { if (kept.length >= 4 && (got >= sum * 0.75 || kept.length >= 10)) break; kept.push(l); got += l.n || 0 }
      const r = mapMetro(k, Object.assign({}, M, { links: kept }), [], W, false, unit, null, valueOf, stationRegion, ctx, T, o, lens)
      grid = r.g
      if (kept.length < all.length) key.push(`{dim:${fmt(all.length - kept.length)} smaller flows not drawn (${fmt(sum - got)}${unit ? ' ' + escapeMarkup(unit) : ''} of ${fmt(sum)}); the full map has them all}`)
    }
    if (grid) { /* drawn */ } else if (form === 'line') grid = mapLine(k, M, lineThreads[0], W, full, unit, stationRegion, toneOfThread, ctx, T)
    else if (form === 'metro') {
      const F = mapFold(M, lineThreads, o.fold != null ? num(o.fold) : Math.max(2, Math.ceil(lineThreads.length * 0.05)))
      const r = mapMetro(k, F.M, F.threads, W, full, unit, full || o.lens ? lens : null, valueOf, stationRegion, ctx, T, o, lens)
      grid = r.g
      key = r.key
      if (F.folded.length) key.push(`{dim:folded into the lanes, under ${fmt(F.min)} ${escapeMarkup(unit || 'threads')} each:} ` + F.folded.slice(0, 8).map(x => `${escapeMarkup(x.label)} {dim:${fmt(x.threads.length)}}`).join(', ') + (F.folded.length > 8 ? ` {dim:+${F.folded.length - 8}}` : ''))
    } else grid = mapRegions(k, M, W, full, unit, stationRegion, ctx, T)
    const node = grid.toCanvas(n => { ctx.ops += n })
    node.map = { form: form, full: full, threads: lineThreads.length, stations: M.stations.size, lens: lens ? lens.by : null }
    const parts = [node]
    if (key.length && (full || form === 'metro')) key.forEach(line => parts.push(k.text(line)))
    return parts.length === 1 ? node : k.stack(parts)
  }

  // ---- one thread: a line of its stations
  function mapLine(k, M, t, W, full, unit, stationRegion, toneOfThread, ctx, T) {
    const stops = t.stops
    const n = stops.length
    const total = t.steps || Math.max(0, ...stops.map(s => s.to || s.from || 0)) || n
    const known = stops.every(s => s.from != null)
    const span = s => (known ? Math.max(1, (s.to != null ? s.to : s.from) - s.from + 1) : 1)
    const st = s => M.stations.get(s.station) || {}
    const labelOf = s => s.label || st(s).label || s.station
    // a short name: Claude's `short`, else the first word and the most telling other word (one with a digit or #)
    const shortOf = s => st(s).short || shortName(labelOf(s))
    // the last stop of a finished thread says how it ended: ✓ by words of success, ✗ of failure, ■ otherwise
    const endMark = s => (MAP_GOOD.test(labelOf(s)) ? '✓' : MAP_BAD.test(labelOf(s)) ? '✗' : '■')
    const markOf = (s, i) => s.mark || st(s).mark || (i === n - 1 && st(s).end ? endMark(s) : '')
    const markTone = (s, m) => (s.tone ? T(s.tone) : st(s).tone ? T(st(s).tone) : m === '✓' ? 'good' : m === '✗' ? 'bad' : m === '■' ? (MAP_WARN.test(labelOf(s)) ? 'warn' : 'ink') : 'accent')
    const notes = stops.map((s, i) => ({ s, i, note: s.note || st(s).note })).filter(x => x.note)
    const ncol = W >= 100 && notes.length > 3 ? 2 : 1
    const H = full ? 8 + Math.ceil(notes.length / ncol) : 1
    const g = new MapGrid(W, H)
    const reg = stops.map(s => stationRegion(g, M.stations.get(s.station)))

    if (!full) {
      // one row to scale: each stop takes width as its steps, its name at its start; where names do not fit, the
      // stops with the fewest steps give up words first (the full name, a short name, its mark alone)
      const token = (s, i, lvl) => {
        const m = markOf(s, i), rep = s.repeat ? (lvl ? ' ⟳' : ` ⟳${fmt(s.repeat)}`) : ''
        if (lvl >= 2) return m || '●'
        return (lvl === 0 ? labelOf(s) : shortOf(s)) + (m ? ' ' + m : '') + rep
      }
      const lvl = stops.map(() => 0)
      const minOf = i => k.len(token(stops[i], i, lvl[i])) + (i < n - 1 ? (lvl[i] >= 2 ? 2 : 3) : 0)
      const keyed = i => (st(stops[i]).raw && st(stops[i]).raw.key ? 1 : 0)
      const byFew = stops.map((s, i) => i).sort((a, b) => keyed(a) - keyed(b) || span(stops[a]) - span(stops[b]))
      for (let guard = 0; guard < 3 * n && stops.reduce((sum, s, i) => sum + minOf(i), 0) > W; guard++) {
        const i = byFew.find(j => lvl[j] < 2 && (lvl[j] < 1 || byFew.every(q => lvl[q] >= 1)))
        if (i == null) break
        lvl[i]++
      }
      const mins = stops.map((s, i) => minOf(i))
      let ws = mins.slice()
      const room = W - ws.reduce((a, b) => a + b, 0)
      if (room > 0) {
        // the spare cells go to the stops by their steps, largest remainders first
        const wts = stops.map(span)
        const sum = wts.reduce((a, b) => a + b, 0)
        const extra = wts.map((w, i) => Math.max(0, (W * w) / sum - mins[i]))
        const es = extra.reduce((a, b) => a + b, 0) || 1
        const add = extra.map(v => Math.floor((room * v) / es))
        let left = room - add.reduce((a, b) => a + b, 0)
        extra.map((v, i) => [((room * v) / es) % 1, i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { add[i]++; left-- } })
        ws = ws.map((v, i) => v + add[i])
      }
      let x = 0
      stops.forEach((s, i) => {
        const m = markOf(s, i)
        const lab = lvl[i] >= 2 ? '' : lvl[i] === 1 ? shortOf(s) : labelOf(s)
        let dx = 0
        if (lab) dx += g.str(x, 0, lab, 'ink')
        if (m || !lab) { if (lab) dx++; g.set(x + dx, 0, m ? { ch: m, tone: markTone(s, m), kind: 'mark' } : { ch: '·', tone: 'dim', kind: 'mark' }); dx++ }
        if (s.repeat) { const r = lvl[i] ? ' ⟳' : ` ⟳${fmt(s.repeat)}`; g.str(x + dx, 0, r, 'c5'); dx += k.len(r) }
        const padL = lvl[i] >= 2 ? 0 : 1, padR = i < n - 1 && lvl[i + 1] < 2 ? 1 : 0
        if (i < n - 1) for (let j = x + dx + padL; j < x + ws[i] - padR; j++) g.set(j, 0, { ch: '─', tone: s.tone ? T(s.tone) : 'dim', kind: 'line' })
        g.rect(reg[i], x, 0, ws[i], 1)
        x += ws[i]
      })
      return g
    }

    // the full map. Across when the names fit in one row (stations spaced for reading, their first step under each, a
    // strip to scale, the notes below); else down, one station a row: its first step, its name, its share to scale,
    // its note under it. Cells are too coarse for names that take turns above and below a line.
    const lastW = Math.min(18, k.len(labelOf(stops[n - 1])))
    const gap = n > 1 ? Math.floor((W - 1 - lastW) / (n - 1)) : W
    const xs = stops.map((s, i) => i * gap)
    const across = n <= 8 && gap >= 4 && stops.every((s, i) => xs[i] + k.len(labelOf(s)) < (i < n - 1 ? xs[i + 1] - 1 : W + 1))
    if (!across) return mapDown(k, M, t, W, unit, stops, reg, g.regs, { span, labelOf, markOf, markTone, known, total, T })
    const G = g
    const yLine = 1, yNum = 2, yScale = 3
    stops.forEach((s, i) => {
      let lab = labelOf(s)
      const x0 = i === n - 1 && xs[i] + k.len(lab) > W ? Math.max(n > 1 ? xs[n - 2] + 2 : 0, W - k.len(lab)) : xs[i]
      G.str(x0, 0, lab, s.tone ? T(s.tone) : 'ink', { b: true })
      G.rect(reg[i], x0, 0, k.len(lab), 1)
    })
    stops.forEach((s, i) => {
      const x = xs[i]
      const m = markOf(s, i) || '●'
      G.set(x, yLine, { ch: m, tone: markTone(s, m), kind: 'mark', b: true })
      G.rect(reg[i], x, yLine, 1, 1)
      if (i < n - 1) {
        const ch = s.repeat ? '↻' : '━'
        for (let xx = x + 1; xx < xs[i + 1]; xx++) G.set(xx, yLine, { ch: ch, tone: s.repeat ? 'c5' : (s.tone ? T(s.tone) : toneOfThread(t)), kind: s.repeat ? 'mark' : 'line' })
        if (s.repeat) { const r = ` ×${fmt(s.repeat)} `; if (xs[i + 1] - x - 1 > k.len(r) + 2) G.str(x + 2, yLine, r, 'c5') }
      }
    })
    let free = 0
    stops.forEach((s, i) => {
      if (s.from == null) return
      const txt = fmt(s.from)
      if (xs[i] >= free && xs[i] + k.len(txt) <= W) { G.str(xs[i], yNum, txt, 'dim'); G.rect(reg[i], xs[i], yNum, k.len(txt), 1); free = xs[i] + k.len(txt) + 1 }
    })
    // where the steps went: one strip to scale, a stop's segment in alternating tones, the total at its end
    if (known && n > 1) {
      const tail = ` ${fmt(total)} ${unit} to scale`
      const sw = Math.max(n, W - k.len(tail))
      let x = 0
      stops.forEach((s, i) => {
        const end = i === n - 1 ? sw : Math.max(x + 1, Math.round(((s.to != null ? s.to : s.from) / Math.max(1, total)) * sw))
        for (let xx = x; xx < Math.min(end, sw); xx++) G.set(xx, yScale, { ch: '▬', tone: i % 2 ? 'dim' : 'accent', kind: 'block' })
        G.rect(reg[i], x, yScale, Math.max(1, Math.min(end, sw) - x), 1)
        x = Math.min(end, sw)
      })
      G.str(sw, yScale, tail, 'dim')
    }
    const cw = Math.floor(W / ncol)
    const per = Math.ceil(notes.length / ncol)
    notes.forEach((x, j) => {
      const col = Math.floor(j / per), row = j % per
      const X = col * cw, Y = yScale + 2 + row
      const m = markOf(x.s, x.i) || '●'
      const head = x.s.from != null ? fmt(x.s.from) : ''
      G.set(X, Y, { ch: m, tone: markTone(x.s, m), kind: 'mark' })
      G.str(X + 2, Y, head, 'dim')
      const nx = X + 2 + Math.max(6, k.len(head) + 1)
      let words = x.note
      const room = cw - (nx - X) - 2
      if (k.len(words) > room) words = Array.from(words).slice(0, Math.max(1, room - 1)).join('') + '…'
      G.str(nx, Y, words, 'ink')
      G.rect(reg[x.i], X, Y, cw - 1, 1)
    })
    return G
  }

  // ---- one thread, down: a station a row, the line running down the left, its share of the steps to scale
  function mapDown(k, M, t, W, unit, stops, reg, regs, f) {
    const n = stops.length
    const st = s => M.stations.get(s.station) || {}
    const notes = stops.map(s => s.note || st(s).note || '')
    const wrapNote = (txt, w) => {
      const out = []
      let line = ''
      for (const word of String(txt).split(/\s+/).filter(Boolean)) {
        if (line && k.len(line) + 1 + k.len(word) > w) { out.push(line); line = word } else line = line ? line + ' ' + word : word
        if (out.length >= 2) break
      }
      if (line && out.length < 2) out.push(line)
      if (out.length === 2 && k.len(out.join(' ')) < k.len(txt)) out[1] = Array.from(out[1]).slice(0, Math.max(1, w - 1)).join('') + '…'
      return out
    }
    const numW = Math.max(1, ...stops.map(s => (s.from != null ? k.len(fmt(s.from)) : 0)))
    const barW = f.known ? Math.max(6, Math.min(24, Math.floor(W / 5))) : 0
    const maxSpan = Math.max(1, ...stops.map(f.span))
    const nameX = 2 + numW + 2
    const longest = Math.max(4, ...stops.map(s => k.len(f.labelOf(s) + (s.repeat ? ` ⟳${fmt(s.repeat)}` : ''))))
    const labW = Math.max(8, Math.min(longest, W - nameX - (barW ? barW + 2 + k.len(fmt(maxSpan)) + 1 : 0)))
    const nameW = Math.max(labW, W - nameX)
    const bx = nameX + labW + 2
    let lines = 2
    if (stops.reduce((a, s, i) => a + 1 + wrapNote(notes[i], nameW).length, 0) > Math.max(k.h, n * 2)) lines = 1
    const noteLines = i => wrapNote(notes[i], nameW).slice(0, lines).map((l, j, all) => (j === all.length - 1 && all.length < wrapNote(notes[i], nameW).length ? Array.from(l).slice(0, Math.max(1, nameW - 1)).join('') + '…' : l))
    const rows = stops.map((s, i) => 1 + noteLines(i).length)
    const back = (M.links || []).filter(l => stops.some(s => s.station === l.from))
    const H = rows.reduce((a, b) => a + b, 0) + (f.known ? 1 : 0) + back.length
    const g = new MapGrid(W, Math.max(1, H))
    g.regs = regs
    let y = 0
    stops.forEach((s, i) => {
      const m = f.markOf(s, i) || '●'
      const h = rows[i]
      g.set(0, y, { ch: m, tone: f.markTone(s, m), kind: 'mark', b: true })
      if (i < n - 1) for (let yy = y + 1; yy < y + h; yy++) g.set(0, yy, { ch: s.repeat ? '↻' : '┃', tone: s.repeat ? 'c5' : 'accent', kind: s.repeat ? 'mark' : 'line' })
      if (s.from != null) g.str(2 + numW - k.len(fmt(s.from)), y, fmt(s.from), 'dim')
      let lab = f.labelOf(s) + (s.repeat ? ` ⟳${fmt(s.repeat)}` : '')
      if (k.len(lab) > labW) lab = Array.from(lab).slice(0, labW - 1).join('') + '…'
      g.str(nameX, y, lab, s.tone ? f.T(s.tone) : 'ink', { b: true })
      if (barW) {
        const v = f.span(s)
        const len = Math.max(1, Math.round((v / maxSpan) * barW))
        for (let j = 0; j < len; j++) g.set(bx + j, y, { ch: '▬', tone: 'accent', kind: 'block' })
        g.str(bx + len + 1, y, fmt(v), 'dim')
      }
      noteLines(i).forEach((line, j) => g.str(nameX, y + 1 + j, line, 'dim', { max: nameW }))
      g.rect(reg[i], 0, y, W, h)
      y += h
    })
    back.forEach(l => {
      const a = M.stations.get(l.from), b = M.stations.get(l.to)
      g.str(0, y, '↺', 'c5')
      g.str(nameX, y, `back: ${a ? a.label : l.from} → ${b ? b.label : l.to}${l.label ? ' (' + l.label + ')' : ''}`, 'dim', { max: W - nameX })
      y++
    })
    if (f.known) g.str(nameX, y, `${fmt(f.total)}${unit ? ' ' + unit : ''} in all; a bar is a station's share`, 'dim', { max: W - nameX })
    return g
  }

  // ---- the mini form of many threads: an origin, the first place they split, and where they end. The split is the
  // earliest stations that share out the threads between them (each thread in one), taken from the stations Claude
  // marked `key`, else from the stations a tenth to nine tenths of the threads pass; each thread's other stops are
  // folded into the lanes between them
  function mapReduce(M, threads, unit) {
    const ST = M.stations
    const nT = threads.length
    const ends = new Set(threads.map(t => t.stops[t.stops.length - 1].station))
    const pos = {}
    threads.forEach(t => {
      const seen = new Set()
      t.stops.forEach((s, i) => { if (seen.has(s.station)) return; seen.add(s.station); const a = pos[s.station] = pos[s.station] || [0, 0]; a[0] += i / Math.max(1, t.stops.length - 1); a[1]++ })
    })
    const at = id => (pos[id] ? pos[id][0] / pos[id][1] : 1)
    const keyed = [...ST.values()].filter(s => (s.raw.key || s.raw.mini) && !ends.has(s.id) && s.threads.length)
    const cands = (keyed.length ? keyed : [...ST.values()].filter(s => !ends.has(s.id) && s.threads.length >= Math.max(2, Math.ceil(nT * 0.1)) && s.threads.length < nT * 0.9))
      .sort((a, b) => at(a.id) - at(b.id) || b.threads.length - a.threads.length)
    const covered = new Set()
    let keep = []
    for (const s of cands) {
      const over = s.threads.filter(t => covered.has(t)).length
      if (over <= s.threads.length * 0.2) { keep.push(s.id); s.threads.forEach(t => covered.add(t)) }
    }
    keep = keep.concat([...ends])
    if (keep.length < 2) return null
    const origin = { id: 'all', label: `${fmt(nT)} ${unit || 'threads'}`, raw: { origin: true }, origin: true, threads: threads.map(t => t.id), stops: [], n: nT }
    const stations = new Map([['all', origin]])
    keep.forEach(id => { const s = ST.get(id); if (s) stations.set(id, s) })
    const out = threads.map(t => {
      const stops = [{ station: 'all', thread: t.id }]
      t.stops.forEach(s => { if (stations.has(s.station) && stops[stops.length - 1].station !== s.station) stops.push(s) })
      return Object.assign({}, t, { stops })
    })
    return { M: Object.assign({}, M, { stations, links: [] }), threads: out }
  }

  // ---- the full form of many threads leaves out the stations few threads pass (under `min`), unless Claude marked them
  // key or threads end there; their threads run straight through to the next station they reach
  function mapFold(M, threads, min) {
    const folded = [...M.stations.values()].filter(s => s.threads.length && s.threads.length < min && !s.raw.key && !s.end && !threads.some(t => t.stops[t.stops.length - 1].station === s.id))
    if (!folded.length || min <= 1) return { M, threads, folded: [], min }
    const gone = new Set(folded.map(s => s.id))
    const stations = new Map([...M.stations].filter(([id]) => !gone.has(id)))
    const out = threads.map(t => {
      const stops = []
      t.stops.forEach(s => { if (!gone.has(s.station) && (!stops.length || stops[stops.length - 1].station !== s.station)) stops.push(s) })
      return Object.assign({}, t, { stops })
    })
    return { M: Object.assign({}, M, { stations }), threads: out, folded, min }
  }

  // ---- many threads: a metro map of bundles between stations in columns
  function mapMetro(k, M, threads, W, full, unit, lens, valueOf, stationRegion, ctx, T, o, lensAll) {
    const ST = M.stations
    const unitWord = (n, u) => (u ? `${fmt(n)} ${n === 1 ? u.replace(/s$/, '') : u}` : fmt(n))
    // edges: consecutive stops of each thread; links with a count where no thread runs
    const EW = new Map()
    const backs = []
    const edge = (a, b) => { const key = a + '>' + b; let e = EW.get(key); if (!e) { e = { key, a, b, tids: [], n: 0, by: null, ref: null }; EW.set(key, e) } return e }
    threads.forEach(t => t.stops.forEach((s, i) => { if (!i) return; const a = t.stops[i - 1].station; if (a !== s.station) { const e = edge(a, s.station); e.tids.push(t.id); e.n++ } }))
    const extra = []
    M.links.forEach(l => {
      if (EW.has(l.from + '>' + l.to) && !l.n) return
      if (threads.length && l.n == null) { extra.push(l); return }
      const e = edge(l.from, l.to)
      if (!e.tids.length) { e.n = l.n != null ? l.n : 1; e.by = l.by; e.ref = l.ref; e.label = l.label }
    })
    const ids = []
    for (const e of EW.values()) { if (ids.indexOf(e.a) < 0) ids.push(e.a); if (ids.indexOf(e.b) < 0) ids.push(e.b) }
    // an edge that goes back (a return, a loop) is a note, not a lane: with threads, back means against the order in
    // which the threads first reach the stations; with links alone, against a depth-first walk from the starts
    const pos = {}
    if (threads.length) {
      const acc = {}
      threads.forEach(t => {
        const seen = new Set()
        t.stops.forEach((s, i) => { if (seen.has(s.station)) return; seen.add(s.station); const a = acc[s.station] = acc[s.station] || [0, 0]; a[0] += i / Math.max(1, t.stops.length - 1); a[1]++ })
      })
      ids.forEach(id => { pos[id] = acc[id] ? acc[id][0] / acc[id][1] : 0.5 })
    } else {
      const out = {}
      for (const e of EW.values()) (out[e.a] = out[e.a] || []).push(e.b)
      const state = {}
      let t = 0
      const visit = id => { if (state[id]) return; state[id] = 1; (out[id] || []).forEach(visit); pos[id] = -(t++) }
      ids.filter(id => ![...EW.values()].some(e => e.b === id)).concat(ids).forEach(visit)
    }
    const fwd = (a, b) => pos[a] < pos[b] || (pos[a] === pos[b] && a < b)
    for (const [key, e] of [...EW]) if (!fwd(e.a, e.b)) { backs.push(e); EW.delete(key) }
    const succ0 = {}, pred0 = {}
    ids.forEach(id => { succ0[id] = {}; pred0[id] = {} })
    for (const e of EW.values()) { succ0[e.a][e.b] = (succ0[e.a][e.b] || 0) + e.n; pred0[e.b][e.a] = (pred0[e.b][e.a] || 0) + e.n }
    // columns: the longest path from a start; a station where threads end goes to the last column
    const rank = {}
    const rk = id => {
      if (rank[id] != null) return rank[id]
      let r = 0
      for (const p in pred0[id]) r = Math.max(r, rk(p) + 1)
      return (rank[id] = r)
    }
    ids.forEach(rk)
    let maxR = Math.max(0, ...ids.map(id => rank[id]))
    const ending = ids.filter(id => ST.get(id).end || !Object.keys(succ0[id]).length)
    if (ending.length && ending.some(id => rank[id] < maxR)) ending.forEach(id => { rank[id] = maxR })
    for (const [key, e] of [...EW]) if (rank[e.b] <= rank[e.a]) { backs.push(e); EW.delete(key) }
    maxR = Math.max(0, ...ids.map(id => rank[id]))
    const nThreads = threads.length || Math.max(1, ...[...EW.values()].map(e => e.n))
    const nOf = id => { const s = ST.get(id); return s.n != null ? s.n : s.threads.length || Math.max(Object.values(pred0[id]).reduce((a, b) => a + b, 0), Object.values(succ0[id]).reduce((a, b) => a + b, 0)) }
    // nodes, with a pass-through point in every column an edge skips
    const N = {}
    ids.forEach((id, i) => { N[id] = { id, rank: rank[id], n: nOf(id), ord: i } })
    const chain = {}
    for (const e of EW.values()) {
      const ch = [e.a]
      for (let r = rank[e.a] + 1; r < rank[e.b]; r++) { const did = `~${e.key}@${r}`; N[did] = { id: did, rank: r, dummy: true, edge: e.key, n: e.n, ord: 1e6 }; ch.push(did) }
      ch.push(e.b)
      chain[e.key] = ch
    }
    const succ = {}, pred = {}
    for (const id in N) { succ[id] = {}; pred[id] = {} }
    for (const key in chain) {
      const ch = chain[key], w = EW.get(key).n
      for (let i = 1; i < ch.length; i++) { succ[ch[i - 1]][ch[i]] = (succ[ch[i - 1]][ch[i]] || 0) + w; pred[ch[i]][ch[i - 1]] = (pred[ch[i]][ch[i - 1]] || 0) + w }
    }
    const layers = []
    for (const id in N) (layers[N[id].rank] = layers[N[id].rank] || []).push(id)
    for (let r = 0; r <= maxR; r++) layers[r] = (layers[r] || []).sort((a, b) => N[a].ord - N[b].ord || (a < b ? -1 : 1))
    const yy = {}
    const place = l => { let y = 0; l.forEach(id => { yy[id] = y + N[id].n / 2; y += N[id].n + (N[id].dummy ? 2 : 6) }); const sh = -y / 2; l.forEach(id => { yy[id] += sh }) }
    layers.forEach(place)
    const bary = (id, nb) => { let s = 0, w = 0; for (const q in nb[id]) { s += yy[q] * nb[id][q]; w += nb[id][q] } return w ? s / w : yy[id] }
    for (let it = 0; it < 10; it++) {
      for (let r = 1; r <= maxR; r++) { layers[r].sort((a, b) => bary(a, pred) - bary(b, pred)); place(layers[r]) }
      for (let r = maxR - 1; r >= 0; r--) { layers[r].sort((a, b) => bary(a, succ) - bary(b, succ)); place(layers[r]) }
    }
    // lanes: every bundle split by the lens, one lane per value; a bundle in `merged` stays one striped lane
    const cats = lens ? lens.values.concat(['(none)']) : ['']
    const weightOf = n => (n >= Math.max(3, Math.round(nThreads / 4)) ? 3 : n >= Math.max(2, Math.round(nThreads / 10)) ? 2 : 1)
    const lanesFor = merged => {
      const lanes = {}, all = []
      for (const [key, e] of EW) {
        const gr = {}
        if (e.tids.length) e.tids.forEach(tid => { const t = threads.find(x => x.id === tid); const v = lens && t ? valueOf(t) : ''; (gr[v] = gr[v] || []).push(tid) })
        else if (lens && isObj(e.by)) Object.keys(e.by).forEach(v => { const c = num(e.by[v]); if (c > 0) gr[String(v)] = new Array(c).fill(null) })
        else gr[''] = new Array(e.n).fill(null)
        const present = Object.keys(gr).sort((a, b) => (cats.indexOf(a) < 0 ? 999 : cats.indexOf(a)) - (cats.indexOf(b) < 0 ? 999 : cats.indexOf(b)))
        const tone = v => (lens ? lens.tone[v] || 'dim' : 'accent')
        if ((merged.has(key) && present.length > 1) || !lens) {
          const parts = present.map(v => ({ v, n: gr[v].length, tids: gr[v].filter(Boolean), tone: tone(v) }))
          const pat = []
          parts.forEach(p => { for (let i = 0; i < Math.max(1, Math.round((6 * p.n) / e.n)); i++) pat.push(p.tone) })
          const major = parts.slice().sort((a, b) => b.n - a.n)[0] || { v: '', tone: 'accent' }
          const L = { id: all.length, key, v: lens ? major.v : '', parts, pat: lens && parts.length > 1 ? pat : null, tids: e.tids.slice(), n: e.n, tone: major.tone, w: weightOf(e.n), mixed: !!lens && parts.length > 1 }
          all.push(L)
          lanes[key] = [L]
          continue
        }
        lanes[key] = present.map(v => { const L = { id: all.length, key, v, tids: gr[v].filter(Boolean), n: gr[v].length, tone: tone(v), w: weightOf(gr[v].length) }; all.push(L); return L })
      }
      const ins = {}, outs = {}
      for (const id in N) { ins[id] = []; outs[id] = [] }
      for (const key in chain) { const ch = chain[key]; for (let i = 0; i < ch.length - 1; i++) { outs[ch[i]].push(...lanes[key]); ins[ch[i + 1]].push(...lanes[key]) } }
      return { lanes, all, ins, outs }
    }
    const budget = clamp(int(o.rows, full ? 30 : 10), 4, 200)
    const gapB = (a, b) => (N[b].dummy && N[a].dummy ? 1 : 2)
    const merged = new Set()
    let hOf, plan
    for (let guard = 0; guard < 200; guard++) {
      plan = lanesFor(merged)
      hOf = {}
      for (const id in N) hOf[id] = N[id].dummy ? plan.lanes[N[id].edge].length : Math.max(plan.ins[id].length, plan.outs[id].length, 1)
      const colH = layers.map(l => l.reduce((a, id, i) => a + hOf[id] + (i ? gapB(l[i - 1], id) : 0), 0))
      const worst = colH.indexOf(Math.max(...colH))
      if (colH[worst] <= budget - 2) break
      const keys = [...EW.keys()].filter(kk => !merged.has(kk) && plan.lanes[kk].length > 1 && chain[kk].some(id => N[id].rank === worst))
      if (!keys.length) break
      keys.sort((a, b) => plan.lanes[b].length - plan.lanes[a].length || EW.get(a).n - EW.get(b).n)
      merged.add(keys[0])
    }
    const { lanes, all: allLanes, ins, outs } = plan
    const colH = layers.map(l => l.reduce((a, id, i) => a + hOf[id] + (i ? gapB(l[i - 1], id) : 0), 0))
    const H = Math.max(budget, Math.max(...colH) + 4)
    const top0 = 1, bot0 = H - 2
    // x: the last column leaves room for the endings' words to its right
    const sinkW = Math.max(0, ...layers[maxR].filter(id => !N[id].dummy).map(id => k.len(ST.get(id).label) + 1 + k.len(fmt(N[id].n)) + 2))
    const xEnd = Math.max(Math.floor(W * 0.5), W - Math.min(sinkW, Math.floor(W * 0.4)) - 1)
    const X = []
    for (let r = 0; r <= maxR; r++) X.push(maxR ? Math.round((r * (xEnd - 1)) / maxR) : 0)
    // y: centers relaxed toward their weighted neighbors, order and gaps kept
    const y = {}
    const cen = id => y[id] + (hOf[id] - 1) / 2
    layers.forEach(l => { let v = 0; l.forEach((id, i) => { if (i) v += gapB(l[i - 1], id); y[id] = v; v += hOf[id] }); const sh = (top0 + bot0 + 1) / 2 - v / 2; l.forEach(id => { y[id] += sh }) })
    const resolve = (l, round) => {
      for (let i = 0; i < l.length; i++) { const lo = i ? y[l[i - 1]] + hOf[l[i - 1]] + gapB(l[i - 1], l[i]) : top0; if (y[l[i]] < lo) y[l[i]] = lo }
      for (let i = l.length - 1; i >= 0; i--) { const hi = i < l.length - 1 ? y[l[i + 1]] - gapB(l[i], l[i + 1]) - hOf[l[i]] : bot0 - hOf[l[i]] + 1; if (y[l[i]] > hi) y[l[i]] = hi }
      for (let i = 0; i < l.length; i++) { const lo = i ? y[l[i - 1]] + hOf[l[i - 1]] + gapB(l[i - 1], l[i]) : top0; if (y[l[i]] < lo) y[l[i]] = lo }
      if (round) l.forEach(id => { y[id] = Math.round(y[id]) })
    }
    const NB = {}
    for (const id in N) { const q = {}; for (const z in pred[id]) q[z] = (q[z] || 0) + pred[id][z]; for (const z in succ[id]) q[z] = (q[z] || 0) + succ[id][z]; NB[id] = q }
    for (let it = 0, al = 0.7; it < 60; it++, al *= 0.96) {
      const rs = [...Array(maxR + 1).keys()]
      if (it % 2) rs.reverse()
      for (const r of rs) {
        for (const id of layers[r]) { let s = 0, w = 0; for (const q in NB[id]) { s += cen(q) * NB[id][q]; w += NB[id][q] } if (w) y[id] += (s / w - cen(id)) * al }
        resolve(layers[r])
      }
    }
    layers.forEach(l => resolve(l, true))
    // the rows of the lanes at every node: in by where they come from, out by where they go
    const entry = {}, exit = {}
    const prevOf = (id, L) => { const ch = chain[L.key]; return ch[ch.indexOf(id) - 1] }
    const nextOf = (id, L) => { const ch = chain[L.key]; return ch[ch.indexOf(id) + 1] }
    const ci = L => cats.indexOf(L.v)
    const bestOffset = (rows, h, n) => { let best = 0, bs = Infinity; for (let off = 0; off <= h - n; off++) { let s = 0; rows.forEach((d, i) => { s += Math.abs(off + i - d) }); if (s < bs - 1e-9) { bs = s; best = off } } return best }
    for (let r = 0; r <= maxR; r++) {
      for (const id of layers[r]) {
        entry[id] = {}; exit[id] = {}
        const h = hOf[id], top = y[id]
        if (N[id].dummy) {
          const ls = lanes[N[id].edge]
          const off = bestOffset(ls.map(L => exit[prevOf(id, L)][L.id] - top), h, ls.length)
          ls.forEach((L, i) => { entry[id][L.id] = top + off + i; exit[id][L.id] = top + off + i })
          continue
        }
        const I = ins[id].slice().sort((a, b) => exit[prevOf(id, a)][a.id] - exit[prevOf(id, b)][b.id] || ci(a) - ci(b))
        const oi = bestOffset(I.map(L => exit[prevOf(id, L)][L.id] - top), h, I.length)
        I.forEach((L, i) => { entry[id][L.id] = top + oi + i })
        const tg = L => { const nn = nextOf(id, L); return N[nn].dummy ? y[nn] + (hOf[nn] - lanes[L.key].length) / 2 + lanes[L.key].indexOf(L) : y[nn] + (hOf[nn] - 1) / 2 }
        const O = outs[id].slice().sort((a, b) => tg(a) - tg(b) || ci(a) - ci(b))
        const oo = bestOffset(O.map(L => tg(L) - top), h, O.length)
        O.forEach((L, i) => { exit[id][L.id] = top + oo + i })
      }
    }
    // route: straight runs and one bend per gap, the bends of a gap in columns of their own
    const g = new MapGrid(W, H)
    const xL = id => X[N[id].rank], xR = id => X[N[id].rank]
    const segs = []
    for (const key in chain) {
      const ch = chain[key]
      for (const L of lanes[key]) {
        for (let i = 0; i < ch.length - 1; i++) segs.push({ L, a: ch[i], b: ch[i + 1], ya: exit[ch[i]][L.id], yb: entry[ch[i + 1]][L.id], x0: xR(ch[i]) + 1, x1: xL(ch[i + 1]) - 1, r: N[ch[i]].rank })
        for (let i = 1; i < ch.length - 1; i++) segs.push({ L, thru: true, ya: entry[ch[i]][L.id], x0: xL(ch[i]), x1: xR(ch[i]) })
      }
    }
    const byGap = {}
    segs.filter(s => !s.thru && s.ya !== s.yb).forEach(s => (byGap[s.r] = byGap[s.r] || []).push(s))
    for (const r in byGap) {
      const list = byGap[r]
      const up = list.filter(s => s.yb < s.ya).sort((a, b) => b.ya - a.ya || b.yb - a.yb)
      const dn = list.filter(s => s.yb > s.ya).sort((a, b) => a.ya - b.ya || a.yb - b.yb)
      const occ = {}
      const lo0 = list[0].x0 + 1, hi0 = list[0].x1 - 1
      const fits = (c, a, b) => (occ[c] || []).every(([p, q]) => b < p - 1 || a > q + 1)
      for (const s of up.concat(dn)) {
        const a = Math.min(s.ya, s.yb), b = Math.max(s.ya, s.yb)
        let c = hi0
        while (c > lo0 && !fits(c, a, b)) c--
        s.c = Math.max(list[0].x0, c)
        ;(occ[s.c] = occ[s.c] || []).push([a, b])
      }
    }
    const put = (x, yy0, ch, L, dir) => {
      const cur = g.get(x, yy0)
      if (cur === undefined) return
      if (cur && dir === 'h' && cur.kind === 'lane' && cur.dir !== 'h') return
      g.set(x, yy0, { ch, tone: L.pat ? L.pat[(x + yy0) % L.pat.length] : L.tone, kind: 'lane', dir, lane: L, pat: !!L.pat })
    }
    for (const s of segs) {
      const G = MAP_GLY[s.L.w]
      if (s.thru || s.ya === s.yb) { for (let x = s.x0; x <= s.x1; x++) put(x, s.ya, G.h, s.L, 'h'); continue }
      for (let x = s.x0; x < s.c; x++) put(x, s.ya, G.h, s.L, 'h')
      for (let x = s.c + 1; x <= s.x1; x++) put(x, s.yb, G.h, s.L, 'h')
    }
    for (const s of segs) {
      if (s.thru || s.ya === s.yb) continue
      const G = MAP_GLY[s.L.w], down = s.yb > s.ya
      put(s.c, s.ya, down ? G.LD : G.LU, s.L, 'c')
      put(s.c, s.yb, down ? G.UR : G.DR, s.L, 'c')
      for (let q = Math.min(s.ya, s.yb) + 1; q < Math.max(s.ya, s.yb); q++) put(s.c, q, G.v, s.L, 'v')
    }
    // stations: a column of beads as tall as its lanes
    const P = {}
    const regs = {}
    for (const id of ids) {
      const S = ST.get(id), top = y[id], h = hOf[id], x = X[N[id].rank]
      const rid = stationRegion(g, S)
      regs[id] = rid
      const glyph = S.mark || '●'
      const beadTone = S.tone ? T(S.tone) : (lensAll && (lensAll.tone[S.id] || lensAll.tone[S.label])) || 'ink'
      for (let row = top; row < top + h; row++) g.set(x, row, { ch: h > 1 && row > top && row < top + h - 1 ? '┃' : glyph, tone: beadTone, kind: 'bead' })
      g.rect(rid, x, top, 1, h)
      P[id] = { x, top, h, S, end: N[id].rank === maxR && maxR > 0 }
    }
    // words: the endings to the right of the last column; the others beside their beads where the cells are free
    const order = ids.slice().sort((a, b) => (P[b].end - P[a].end) || P[b].x - P[a].x || N[b].n - N[a].n)
    const small = id => !full && N[id].n < Math.max(2, nThreads * 0.12) && !P[id].end
    for (const id of order) {
      const p = P[id], S = p.S
      const cnt = fmt(N[id].n)
      // an ending named like a value of the lens takes that value's tone, so the endings read with the lanes into them
      const lensTone = lensAll && (lensAll.tone[S.id] || lensAll.tone[S.label])
      const toneOfLabel = S.tone ? T(S.tone) : lensTone ? lensTone : p.end ? (MAP_GOOD.test(S.label) ? 'good' : MAP_WARN.test(S.label) ? 'warn' : MAP_BAD.test(S.label) ? 'bad' : 'ink') : 'ink'
      const short = S.short || shortName(S.label)
      // an ending's words run to the right edge, so a long one is cut there rather than shortened to two words
      const roomEnd = W - (p.x + 2) - k.len(cnt) - 1
      const cutEnd = k.len(S.label) > roomEnd && roomEnd >= 6 ? Array.from(S.label).slice(0, roomEnd - 1).join('') + '…' : null
      const variants = small(id) ? [] : S.origin ? [[S.label, false]] : p.end && cutEnd ? [[S.label, true], [cutEnd, true], [short, true], [short, false]] : [[S.label, true], [S.label, false], [short, true], [short, false]]
      const spots = L => p.end
        ? [[p.x + 2, p.top + Math.floor((p.h - 1) / 2)], [p.x + 2, p.top], [p.x + 2, p.top - 1], [p.x + 2, p.top + p.h]]
        : [[p.x, p.top - 1], [p.x + 2, p.top - 1], [p.x - L + 1, p.top - 1], [p.x, p.top + p.h], [p.x - L + 1, p.top + p.h], [p.x + 2, p.top], [p.x - L - 1, p.top],
          [p.x + 2, p.top + p.h - 1], [p.x - L - 1, p.top + p.h - 1], [p.x - L - 1, p.top - 1], [p.x + 2, p.top + p.h], [p.x, p.top - 2], [p.x, p.top + p.h + 1]]
      // a name keeps a free cell on each side, so two names never run together
      const fits = (lx, ly, L) => g.freeSpan(lx, ly, L) && (lx === 0 || g.free(lx - 1, ly)) && (lx + L >= W || g.free(lx + L, ly))
      let placed = null
      for (const [name, withN] of variants) {
        const txt = withN ? name + ' ' + cnt : name
        const L = k.len(txt)
        for (const [lx, ly] of spots(L)) {
          if (lx < 0 || lx + L > W || ly < 0 || ly >= H) continue
          if (fits(lx, ly, L)) { placed = { x: lx, y: ly, name, withN }; break }
        }
        if (placed) break
      }
      if (!placed && !small(id)) {
        const ly = p.end ? p.top : p.top - 1, lx = p.end ? p.x + 2 : p.x
        let n = 0
        while (lx + n < W && g.free(lx + n, ly) && n < 30) n++
        if (n >= 4) placed = { x: lx, y: ly, name: Array.from(short).slice(0, n - 1).join('') + (k.len(short) > n - 1 ? '…' : ''), withN: false }
      }
      if (placed) {
        const dx = g.str(placed.x, placed.y, placed.name, toneOfLabel, { b: true })
        if (placed.withN) g.str(placed.x + dx, placed.y, ' ' + cnt, 'dim')
        g.rect(regs[id], placed.x, placed.y, dx + (placed.withN ? 1 + k.len(cnt) : 0), 1)
      }
    }
    // lane counts, once on each lane's longest straight run; a striped lane prints a count per value in its tone
    const laneRegion = L => {
      const e = EW.get(L.key)
      const A = ST.get(e.a), B = ST.get(e.b)
      const meta = { label: `${unitWord(L.n, unit)}: ${A.label} → ${B.label}${L.v && !L.mixed ? ' · ' + L.v : ''}`, from: A.id, to: B.id }
      if (L.v && !L.mixed) meta.value = L.v
      if (L.tids.length) meta.threads = L.tids.slice(0, 400)
      const recs = []
      const pairs = []
      L.tids.forEach(tid => {
        const t = threads.find(x => x.id === tid)
        if (!t) return
        const st = t.stops.find(s => s.station === e.b)
        pairs.push([st || null, t])
        const ref = (st && st.ref && st.ref[0]) || t.row || (t.ref && t.ref[0])
        recs.push({ ref, text: `${t.label}${lens ? ' · ' + valueOf(t) : ''}${st && st.from != null ? ' · reaches ' + B.label + ' at ' + fmt(st.from) : ''}` })
      })
      // the link's own ref, else the rows of every thread through it, as a station's
      if (e.ref) meta.ref = e.ref.length === 1 ? e.ref[0] : e.ref
      else { const r = mapRows(pairs); if (r.length) meta.ref = r.length === 1 ? r[0] : r }
      if (recs.length) meta.examples = registerExamples(ctx, 'ex-ln-' + mslug(A.id, 18) + '-' + mslug(B.id, 18) + (L.v ? '-' + mslug(L.v, 12) : ''), { label: meta.label, records: recs.slice(0, 200), total: recs.length, fmt: '{text}' })
      const id = regionId(ctx, 'ln-' + mslug(A.id, 20) + '-' + mslug(B.id, 20) + (L.v && !L.mixed ? '-' + mslug(L.v, 16) : ''), 'map lane', meta)
      g.regs.set(id, { meta, rects: [] })
      return id
    }
    for (const L of allLanes) {
      let best = null
      for (let yy0 = 0; yy0 < H; yy0++) {
        let x = 0
        while (x < W) {
          const c = g.get(x, yy0)
          if (c && c.kind === 'lane' && c.lane === L && c.dir === 'h') {
            let e = x
            while (e + 1 < W && g.get(e + 1, yy0) && g.get(e + 1, yy0).lane === L && g.get(e + 1, yy0).dir === 'h') e++
            if (!best || e - x > best.e - best.x) best = { x, e, y: yy0 }
            x = e + 1
          } else x++
        }
      }
      const parts = L.mixed ? L.parts : [{ n: L.n, tone: L.tone }]
      const cells = [{ ch: ' ' }]
      parts.forEach((pt, i) => { if (i) cells.push({ ch: '·', tone: 'dim' }); Array.from(fmt(pt.n)).forEach(ch => cells.push({ ch, tone: pt.tone, b: true })) })
      cells.push({ ch: ' ' })
      const rid = laneRegion(L)
      if (best && best.e - best.x + 1 >= cells.length + 2) {
        const sx = Math.round((best.x + best.e) / 2 - (cells.length - 1) / 2)
        cells.forEach((c, i) => g.set(sx + i, best.y, { ch: c.ch, tone: c.tone || L.tone, b: !!c.b, kind: 'text' }))
        g.rect(rid, best.x, best.y, best.e - best.x + 1, 1)
      } else if (best) g.rect(rid, best.x, best.y, best.e - best.x + 1, 1)
    }
    // the key: what a line's weight counts, the lens's values, and what goes back
    const key = []
    const hi = Math.max(3, Math.round(nThreads / 4)), mid = Math.max(2, Math.round(nThreads / 10))
    const u = unit || 'threads'
    const span = (a, b) => (a >= b ? fmt(a) : `${fmt(a)}–${fmt(b)}`)
    key.push(`{dim:line weight = ${escapeMarkup(u)}:} ━ {dim:${fmt(hi)}+}  ─ {dim:${span(mid, hi - 1)}}  ┄ {dim:${span(1, mid - 1)}}`)
    if (lens) key.push(`{dim:${escapeMarkup(lens.label || lens.by)}:} ` + lens.values.map(v => `{${lens.tone[v]}:■} ${escapeMarkup(v)}`).join('  ') + (merged.size ? '  {dim:· a striped lane holds several, a count for each}' : ''))
    const back = backs.concat(extra).map(e => {
      const a = ST.get(e.a || e.from), b = ST.get(e.b || e.to)
      return a && b ? `${escapeMarkup(a.label)} {dim:→} ${escapeMarkup(b.label)}${e.n ? ` {dim:${fmt(e.n)}}` : ''}${e.label ? ` {dim:(${escapeMarkup(e.label)})}` : ''}` : null
    }).filter(Boolean)
    if (back.length) key.push('{dim:↺ back:} ' + back.join('{dim:,} '))
    return { g, key }
  }

  // ---- stations with no threads: groups as boxes of stations, each dot sized by its count
  function mapRegions(k, M, W, full, unit, stationRegion, ctx, T) {
    let groups = M.groups.filter(G => G.stations.length)
    const loose = [...M.stations.values()].filter(s => !groups.some(G => G.stations.indexOf(s.id) >= 0))
    if (loose.length) groups = groups.concat([{ id: '_rest', label: groups.length ? 'other' : (M.title || 'stations'), stations: loose.map(s => s.id), raw: {}, rest: true }])
    const nOf = s => (s.n != null ? s.n : s.threads.length || 1)
    groups.forEach((G, i) => {
      G.items = G.stations.map(id => M.stations.get(id)).sort((a, b) => nOf(b) - nOf(a))
      G.total = G.n != null ? G.n : G.items.reduce((s, x) => s + nOf(x), 0)
      G.tone = G.tone ? T(G.tone) : CATS[i % 6]
    })
    groups.sort((a, b) => b.total - a.total)
    const max = Math.max(1, ...[...M.stations.values()].map(nOf))
    const dot = n => (n >= max * 0.6 ? '◉' : n >= max * 0.3 ? '●' : n >= max * 0.1 ? '•' : '·')
    const groupRegion = (g, G) => {
      const meta = Object.assign({}, G.raw, { label: `${G.label} · ${unitWord(G.total)}`, group: G.id, stations: G.stations.slice(0, 200) })
      delete meta.id
      if (G.note) meta.note = G.note
      if (G.ref) meta.ref = G.ref.length === 1 ? G.ref[0] : G.ref
      else { const r = mapRows(G.items.filter(s => s.ref).map(s => [{ ref: s.ref }, null])); if (r.length) meta.ref = r.length === 1 ? r[0] : r }
      const id = regionId(ctx, G.rest ? 'grp-other' : 'grp-' + mslug(G.id, 56), 'map group', meta)
      g.regs.set(id, { meta, rects: [] })
      return id
    }
    const unitWord = n => (unit ? `${fmt(n)} ${unit}` : fmt(n))
    if (!full) {
      // one row of groups to scale, the words under it
      const g = new MapGrid(W, 2)
      const sum = groups.reduce((s, G) => s + G.total, 0) || 1
      let x = 0
      const rids = groups.map(G => groupRegion(g, G))
      groups.forEach((G, i) => {
        const w = i === groups.length - 1 ? W - x : Math.max(1, Math.round((W * G.total) / sum))
        for (let j = 0; j < w && x + j < W; j++) g.set(x + j, 0, { ch: '▆', tone: G.tone, kind: 'block' })
        g.rect(rids[i], x, 0, Math.min(w, W - x), 1)
        x += w
      })
      let lx = 0
      groups.forEach((G, i) => {
        const txt = `${G.label} ${fmt(G.total)}`
        if (lx + 2 + k.len(txt) > W) return
        g.set(lx, 1, { ch: '■', tone: G.tone, kind: 'mark' })
        g.str(lx + 2, 1, G.label, 'ink')
        g.str(lx + 2 + k.len(G.label) + 1, 1, fmt(G.total), 'dim')
        g.rect(rids[i], lx, 1, 2 + k.len(txt), 1)
        lx += 2 + k.len(txt) + 3
      })
      return g
    }
    // the full map: boxes in columns, each the shortest column so far
    const itemW = s => 2 + k.len(s.label) + 2 + k.len(fmt(nOf(s)))
    const boxW = G => clamp(Math.max(k.len(G.label) + k.len(fmt(G.total)) + 8, ...G.items.map(s => itemW(s) + 4)), 16, W)
    // as many columns as keep every name whole; when none does, one column if it stays short, else as many as fit
    const want = Math.max(...groups.map(boxW))
    const whole = Math.max(1, Math.min(groups.length, Math.floor(W / want)))
    const tall = groups.reduce((a, G) => a + Math.min(G.items.length, 12) + 2, 0)
    const ncol = W / whole >= want || tall <= Math.max(k.h, 24) ? whole : Math.max(1, Math.min(groups.length, Math.floor(W / 24)))
    const colW = Math.floor(W / ncol)
    const maxItems = 12
    const heights = new Array(ncol).fill(0)
    const placed = groups.map(G => {
      const shown = G.items.slice(0, maxItems)
      const h = shown.length + 2 + (G.items.length > shown.length ? 1 : 0)
      const c = heights.indexOf(Math.min(...heights))
      const at = { G, shown, x: c * colW, y: heights[c], w: colW - 1, h }
      heights[c] += h
      return at
    })
    const g = new MapGrid(W, Math.max(1, ...heights))
    placed.forEach(p => {
      const { G } = p
      const rid = groupRegion(g, G)
      g.boxes.push([p.x, p.y, p.w, p.h, G.tone, [{ s: G.label, tone: 'ink', b: true }, { s: ' ' + fmt(G.total), tone: 'dim' }]])
      for (let xx = p.x; xx < p.x + p.w; xx++) { g.set(xx, p.y, { ch: ' ', kind: 'box' }); g.set(xx, p.y + p.h - 1, { ch: ' ', kind: 'box' }) }
      for (let yy0 = p.y; yy0 < p.y + p.h; yy0++) { g.set(p.x, yy0, { ch: ' ', kind: 'box' }); g.set(p.x + p.w - 1, yy0, { ch: ' ', kind: 'box' }) }
      g.rect(rid, p.x, p.y, p.w, 1)
      p.shown.forEach((s, i) => {
        const yy0 = p.y + 1 + i
        const sid = stationRegion(g, s)
        const n = fmt(nOf(s))
        const room = p.w - 4 - k.len(n) - 3
        let lab = s.label
        if (k.len(lab) > room) lab = Array.from(lab).slice(0, Math.max(1, room - 1)).join('') + '…'
        g.set(p.x + 2, yy0, { ch: s.mark || dot(nOf(s)), tone: s.tone ? T(s.tone) : G.tone, kind: 'mark' })
        g.str(p.x + 4, yy0, lab, 'ink')
        g.str(p.x + p.w - 2 - k.len(n), yy0, n, 'dim')
        g.rect(sid, p.x + 1, yy0, p.w - 2, 1)
      })
      if (G.items.length > p.shown.length) g.str(p.x + 4, p.y + p.h - 2, `+ ${G.items.length - p.shown.length} more`, 'dim')
    })
    return g
  }

  // ---------------------------------------------------------------- run
  // Names a program should not lean on are shadowed as undefined parameters. This is a courtesy, not the boundary:
  // the sandbox the program runs in (a vm context with nothing of the host's, or an iframe with no network) is.
  // The program runs inside an inner function, so it may still declare variables with these names.
  const SHADOW = ['globalThis', 'self', 'window', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'postMessage', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator', 'location', 'parent', 'top', 'frames', 'opener', 'setTimeout', 'setInterval', 'queueMicrotask', 'Function', 'require', 'process', 'module', 'DrawKit', 'WebAssembly', 'Worker', 'SharedArrayBuffer', 'Atomics']
  const PRELUDE = '"use strict";\nreturn (function (k, data) {\n'
  function errorInfo(e, program) {
    const msg = e && e.message ? String(e.message) : String(e)
    const name = e && e.name ? String(e.name) : 'Error'
    let line = null
    const st = e && e.stack ? String(e.stack) : ''
    const m = /<anonymous>:(\d+):(\d+)/.exec(st) || /program\.js:(\d+):(\d+)/.exec(st)
    if (m) line = +m[1] - 4
    if (!(line >= 1)) line = null
    const src = line && typeof program === 'string' ? (program.split('\n')[line - 1] || '').trim().slice(0, 160) : ''
    return { name: name, message: msg.slice(0, 400), line: line, source: src }
  }
  function toRoot(ret, k) {
    if (ret && typeof ret.then === 'function') {
      try { ret.then(null, () => {}) } catch (e) { /* nothing to wait for */ }
      const e = new Error('the program returned a promise; a program runs start to end and returns a node, with no await or import')
      e.name = 'ReturnError'
      throw e
    }
    if (ret instanceof Canvas) return ret.node()
    if (ret && typeof ret === 'object' && typeof ret.t === 'string') return ret
    if (typeof ret === 'string' || typeof ret === 'number') return k.text(String(ret))
    if (Array.isArray(ret)) return k.stack.apply(null, ret)
    const e = new Error('the program returned ' + (ret === undefined ? 'nothing' : typeof ret) + '; return a node, such as k.stack(...), k.frame(...) or a canvas')
    e.name = 'ReturnError'
    throw e
  }
  function collectRegions(rootNode) {
    const out = []
    const walk = n => {
      if (!n || typeof n !== 'object') return
      if (n.t === 'region') out.push({ id: n.id, meta: n.meta })
      if (n.t === 'table') n.rows.forEach(r => { if (r.region) out.push({ id: r.region, meta: r.meta }) })
      if (n.t === 'plot') n.series.forEach(s => { if (s.region) out.push({ id: s.region, meta: s.meta }) })
      if (n.t === 'bar' && n.parts) n.parts.forEach(p => { if (p.region) out.push({ id: p.region, meta: p.meta }) })
      if (n.t === 'canvas') n.ops.forEach(op => { if (op[0] === 'region') out.push({ id: op[1], meta: op[6] }); if (op[0] === 'dot' && op[4].region) out.push({ id: op[4].region, meta: op[4].meta }) })
      if (n.kids) n.kids.forEach(walk)
      if (n.kid) walk(n.kid)
    }
    walk(rootNode)
    return out
  }

  // what to fix, in a few words, for each way a program fails: the fallback line says it after the error
  function fixFor(error, limit) {
    const m = String(error.message || '')
    if (error.name === 'TimeLimit') return `it ran past ${limit} ms: draw fewer rows (bind a smaller table) or loop less`
    if (error.name === 'SizeLimit') return 'draw fewer parts, or bind a smaller table and draw a summary of it'
    if (error.name === 'ReturnError') return 'end the program with return and a node, such as return k.stack(...)'
    if (error.name === 'ProgramError') return 'save the card with a program'
    if (error.name === 'SyntaxError') return `the program does not parse${error.line ? ` near line ${error.line}` : ''}: check its brackets and quotes`
    let x = /Cannot read propert(?:y|ies) of (undefined|null)(?: \(reading '([^']*)'\))?/.exec(m)
    if (x) return `a value is ${x[1]} where the program reads ${x[2] ? '.' + x[2] : 'a field'}: check the names in the card's data`
    x = /(\w+) is not defined/.exec(m)
    if (x) return `${x[1]} is not defined: a program has only k and data`
    x = /(\S+) is not a function/.exec(m)
    if (x) return `${x[1]} is not a function: check its name in the toolkit or the data`
    return 'fix the program and save the card again'
  }
  function newCtx(state, event, limit, got) {
    return { warnings: [], cites: {}, examples: {}, ids: {}, regionOrder: [], links: [], controls: {}, state: state, seq: 0, ops: 0, nextCheck: 2000, t0: nowMs(), limit: limit, handlers: [], patch: {}, phase: 'draw', ask: null, event: event || null, rowsOf: null, rowList: [], after: [], effects: [], status: null, wants: [], selected: null, local: [], got: isObj(got) ? got : null }
  }
  // the keys a host keeps where a program is drawn: opts.keys = {taken: {key: why}} (or a list of keys). A key's name
  // as handlers name it ('space', 'return', 'esc', 'up', '0')
  function keysAt(o) {
    const raw = isObj(o) && o.taken != null ? o.taken : Array.isArray(o) ? o : null
    const why = {}
    if (Array.isArray(raw)) raw.forEach(x => { if (x != null) why[String(x)] = 'the host keeps it' })
    else if (isObj(raw)) Object.keys(raw).forEach(x => { why[x] = String(raw[x] || 'the host keeps it').slice(0, 80) })
    const name = x => (x === ' ' ? 'space' : x === 'enter' ? 'return' : x === 'escape' ? 'esc' : x)
    return { taken: Object.keys(why), why: x => why[name(x)] || null }
  }
  // a want's key: its request as JSON with sorted keys, so the same request is the same key on every surface
  function wantKey(req) {
    const norm = v => Array.isArray(v) ? v.map(norm) : isObj(v) ? Object.keys(v).sort().reduce((o, x) => { o[x] = norm(v[x]); return o }, {}) : v
    return JSON.stringify(norm(req))
  }
  // one run of the program: (ctx, root node) or throws
  function runOnce(program, data, opts, ctx, W, H) {
    const k = makeKit(ctx, W, H, opts)
    let fn
    if (typeof program === 'function') fn = program
    else if (typeof program === 'string' && program.trim()) {
      // eslint-disable-next-line no-new-func
      fn = new Function('k', 'data', ...SHADOW, PRELUDE + program + '\n}).call(undefined, k, data)')
    } else { const e = new Error('the card has no program'); e.name = 'ProgramError'; throw e }
    const d = clone(data == null ? {} : data)
    indexRows(ctx, d, opts.id)
    return { k: k, root: toRoot(fn.call(undefined, k, d), k) }
  }
  // the handlers an event reaches: k.on(name) for its key, its type, or its type and target
  function handlersFor(ctx, event) {
    if (!isObj(event)) return []
    const names = []
    const type = String(event.type || '')
    if (type === 'key' && event.key != null) names.push(String(event.key))
    if (type) names.push(type)
    if (type && (event.region || event.id)) names.unshift(type + ':' + (event.region || event.id))
    const out = []
    names.forEach(n => ctx.handlers.forEach(h => { if (h.name === n && out.indexOf(h) < 0) out.push(h) }))
    return out
  }

  /**
   * Run a program. `program` is the source of a function body (a string) or a function (k, data) => node.
   * opts: {w: columns (default 96), h: rows the host prefers (default 24), mode: 'inline' | 'detail', limit: ms (default
   * 2000), maxBytes: the drawing's budget (default 2 MB), state: the card's interaction state, event: what the person
   * did ({type: 'key', key} | {type: 'press', region} | {type: 'brush', id, from, to} | any {type}), title, id, surface}
   * With an event, the program runs once to learn its handlers, the handler the event reaches runs and patches the
   * state, and the program runs again with the new state: the drawing carries `state` and, when a handler called
   * k.ask, `ask`. Returns the drawing; on an error, `drawing.error` = {name, message, line, source, fix} and the root
   * is one line that says what failed and what to fix, under the card's title.
   */
  function run(program, data, opts) {
    opts = opts || {}
    const W = clamp(int(opts.w, 96), 8, MAX_SIDE), H = clamp(int(opts.h, 24), 3, MAX_SIDE)
    const limit = Math.max(50, num(opts.limit) || 2000)
    const maxBytes = Math.max(10000, num(opts.maxBytes) || 2000000)
    let state = isObj(opts.state) ? (clone(opts.state) || {}) : {}
    const event = isObj(opts.event) ? clone(opts.event) : null
    let ctx = newCtx(state, event, limit, opts.got)
    let rootNode = null, error = null, asked = null, handled = null, effects = [], after = []
    const t0 = ctx.t0
    try {
      const first = runOnce(program, data, opts, ctx, W, H)
      rootNode = first.root
      if (event) {
        const hs = handlersFor(ctx, event)
        if (hs.length) {
          handled = hs[0].name
          ctx.phase = 'handle'
          const ret = hs[0].fn(clone(event))
          // a handler that ends with k.ask(...) or k.set(...) returns k itself: that is no patch of the state
          if (isObj(ret) && ret !== first.k) Object.keys(ret).forEach(x => { ctx.patch[x] = clone(ret[x]) })
          asked = ctx.ask
          effects = ctx.effects
          after = ctx.after
          const patch = ctx.patch
          if (Object.keys(patch).length) {
            state = Object.assign({}, state, patch)
            const again = newCtx(clone(state), null, limit, opts.got)
            again.t0 = t0
            again.ops = ctx.ops
            again.nextCheck = ctx.ops + 2000
            ctx = again
            rootNode = runOnce(program, data, opts, ctx, W, H).root
          }
        }
      }
    } catch (e) {
      error = errorInfo(e, typeof program === 'string' ? program : '')
    }
    const title = opts.title != null && String(opts.title).trim() ? clean(String(opts.title)) : (rootNode && rootNode.t === 'frame' && rootNode.title ? plain(rootNode.title).trim() : '')
    let regions = []
    if (!error) {
      regions = collectRegions(rootNode)
      try { matchRegions(ctx, regions, rootNode) } catch (e) { /* matching is a help, never a failure */ }
      const known = {}
      regions.forEach(r => { known[r.id] = 1 })
      ctx.links.forEach(id => { if (!known[id] && !ctx.cites[id] && !ctx.examples[id] && !ctx.controls[id]) warn(ctx, `a link points at "#${id}", which no region, k.cite, k.examples or k.knob defines`) })
      Object.keys(ctx.controls).forEach(id => { if (known[id]) warn(ctx, `knob "${id}" has the id of a region; a link to "#${id}" selects the region, not the knob`) })
      regions.forEach(r => {
        if (r.meta.cite && !ctx.cites[r.meta.cite]) warn(ctx, `region "${r.id}" cites "${r.meta.cite}", which no k.cite defines`)
        if (r.meta.examples && !ctx.examples[r.meta.examples]) warn(ctx, `region "${r.id}" points at examples "${r.meta.examples}", which no k.examples defines`)
      })
    }
    const ms = Math.round((nowMs() - t0) * 10) / 10
    const finish = () => {
      const out = { kit: KIT, w: W, h: H, mode: opts.mode || 'inline', title: title, root: rootNode, cites: error ? {} : ctx.cites, examples: error ? {} : ctx.examples, regions: error ? [] : regions, warnings: ctx.warnings, ms: ms }
      const controls = Object.keys(ctx.controls).map(id => ctx.controls[id])
      if (controls.length && !error) out.controls = controls
      if (!error && (controls.length || Object.keys(state).length)) out.state = state
      // what reaches the program: the keys and events its handlers take, which a host shows and routes to it
      if (!error && ctx.handlers.length) out.on = ctx.handlers.map(h => ({ name: h.name, label: h.label }))
      if (handled) out.handled = handled
      if (asked && !error) out.ask = asked
      // what the handler asked of the host: actions (k.do), events later (k.after); and what the program wants shown
      // in the host's bar (k.status) and has not been given yet (k.want)
      if (effects.length && !error) out.effects = effects
      if (after.length && !error) out.after = after
      if (ctx.status && !error) out.status = ctx.status
      if (ctx.wants.length && !error) out.wants = ctx.wants
      if (ctx.selected && !error) out.selected = ctx.selected
      // the state keys each surface keeps for itself (k.local)
      if (ctx.local.length && !error) out.local = ctx.local.slice()
      if (error) out.error = error
      return out
    }
    if (error) rootNode = fallback(error, title, limit, W, H, opts)
    let out = finish()
    let text = JSON.stringify(out)
    if (!error && text.length > maxBytes) {
      error = { name: 'SizeLimit', message: `the drawing is ${(text.length / 1e6).toFixed(1)} MB, over the ${(maxBytes / 1e6).toFixed(1)} MB budget`, line: null, source: '' }
      rootNode = fallback(error, title, limit, W, H, opts)
      out = finish()
      text = JSON.stringify(out)
    }
    return JSON.parse(text)
  }
  // the readable fallback: one line under the title that says what failed and what to fix
  function fallback(error, title, limit, W, H, opts) {
    error.fix = fixFor(error, limit)
    const kk = makeKit(newCtx({}, null, Infinity), W, H, opts || {})
    const where = error.line ? ` (line ${error.line})` : ''
    // the message only when the fix does not already say it
    const generic = /^fix the program/.test(error.fix) || error.name === 'SizeLimit'
    const what = generic ? `: ${String(error.message).slice(0, 120)}` : ''
    return kk.text(`{bad:×} ${title ? `**${escapeMarkup(title)}** ` : ''}{dim:could not draw:} ${escapeMarkup(error.name)}${escapeMarkup(what)}${where} {dim:· fix:} ${escapeMarkup(error.fix)}`)
  }

  root.DrawKit = { KIT: KIT, TONES: TONES, CATS: CATS, run: run, wantKey: wantKey, fmt: fmt, inline: (s, o) => inline(s, o, { warnings: [], links: [] }), wide: wide, plain: plain }
})(typeof globalThis !== 'undefined' ? globalThis : this)
