// printed.mjs: the line of a check's code that printed a line of its output, which the tray and the claims pane show
// above a computed citation's output line. Pure: no `$`, no Node.
//
// It names a line only when it is sure, since a line that did not print the value is worse than none: the print whose
// own words stand in the output line (`print("failed:", n)` above `failed: 12`), or, when the code's every statement
// that may print is a print, the one print that could have written the line, or the one that wrote it in every
// reading of the output by the code's prints in the order they run. Prints are not all that writes an output: any
// statement can write a warning, an error stops the code, and a call or a child process can print. So a reading lets
// lines that no print wrote stand anywhere (a line that holds a print's own words is that print's), and the lines
// Python writes itself, a warning and an error's traceback, are no print's. A statement that may print and is no
// print (a command such as `head`, a call such as `df.info()`) leaves a line without a print's words unknown, and a
// print in a function's body leaves the order unknown.
//
//   printLine(code, out, at)   the line of `code` that printed line `at` of the output `out`, or ''

// a statement that prints: Python's print, a shell's echo or printf, JavaScript's console.log, a write to stdout
const PRINTS = /\b(?:print|printf|println|puts|echo)\b|\bconsole\.log\b|\bstdout\.write\s*\(/
// what a template fills in: an f-string's or format's `{}`, a template's `${}`, a shell's `$name`, a % conversion
const FILLED = /\$\{[^{}]*\}|\{[^{}]*\}|\$\w+|%[-+ #0]*\d*(?:\.\d+)?[sdifrxXeEgGc%]/

/** A print line's own part: the string literals it hands the print itself, each as written, and the rest of what it
 *  hands it. That is the print's arguments, inside its parentheses, or the rest of the line after a shell's echo; a
 *  literal deeper inside them (`df["status"]`, `== "failed"`, `.groupby("day")`) only picks what is printed. */
function printArgs(line) {
  const s = String(line)
  const m = PRINTS.exec(s)
  if (!m) return { literals: [], rest: '' }
  // the brackets around each character outside string literals (-1 inside one), the literals passed over whole
  const lits = []
  const depth = []
  let d = 0
  for (let i = 0; i < s.length; i++) {
    depth[i] = d
    const c = s[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1
      // with its prefix, as in f"…" or rb'…'
      const pre = /(?:^|[^\w$])([frbuFRBU]{1,2})$/.exec(s.slice(Math.max(0, i - 3), i))
      lits.push({ at: i - (pre ? pre[1].length : 0), end: Math.min(j + 1, s.length), d, text: s.slice(i + 1, j) })
      for (let k = i + 1; k <= j && k < s.length; k++) depth[k] = -1
      i = j
    } else if ('([{'.includes(c)) d++
    else if (')]}'.includes(c)) d = Math.max(0, d - 1)
  }
  const from = m.index + m[0].length
  const paren = m[0].endsWith('(') ? from - 1 : /^\s*\(/.test(s.slice(from)) ? s.indexOf('(', from) : -1
  const own = paren >= 0 ? depth[paren] + 1 : Math.max(0, depth[m.index])
  // the arguments end at the bracket that closes the print's parentheses
  let to = s.length
  if (paren >= 0) for (let i = paren + 1; i < s.length; i++) if (depth[i] === own && ')]}'.includes(s[i])) { to = i; break }
  const literals = lits.filter(l => l.at >= from && l.at < to && l.d === own)
  let rest = ''
  let at = paren >= 0 ? paren + 1 : from
  for (const l of literals) { rest += s.slice(at, l.at); at = l.end }
  rest += s.slice(at, to)
  return { literals: literals.map(l => l.text), rest }
}

/** The words a line of code writes out as they are: the string literals it hands the print itself, without what
 *  f-strings, `{}`, %, a shell's `$name` and a template's `${}` fill in. */
function literalBits(line) {
  const bits = []
  for (const text of printArgs(line).literals) {
    for (const part of text.split(new RegExp(`${FILLED.source}|\\\\[ntr]`))) {
      const t = part.trim()
      if (t.length >= 2) bits.push(t)
    }
  }
  return bits
}

// ---------------------------------------------------------------------------------------------- reading the code

// a statement that is a print: it starts with one
const PRINT_AT = /^(?:(?:print|printf|println|puts|echo)\b|console\.log\b|(?:[\w$]+\.)*stdout\.write\s*\()/
// the header of a block, by its first word: Python's (`for r in runs:`) or a brace's (`} else {`)
const HEADER = /^(?:\}\s*)?(?:async\s+)?(def|class|function|for|while|if|elif|else|with|try|except|catch|finally|match|case|switch)\b/
// how often a block's body runs: a function's when it is called, a loop's any number of times, a condition's at most
// once, a `with` or a `finally` once
const RUNS = { def: 'def', class: 'def', function: 'def', for: 'loop', while: 'loop', with: 'once', finally: 'once' }
// a statement that prints nothing: an import, an assignment, a declaration, a shell's setting, the end of a bracket, a
// decorator, a string alone, a call that changes a value or writes a file
const SILENT = new RegExp(`^(?:${[
  String.raw`(?:import|from)\s`,
  String.raw`(?:pass|break|continue|return|global|nonlocal|del)\b`,
  '@',
  String.raw`[)\]}]+[,;)\]}]*$`,
  String.raw`(?:const|let|var)\s`,
  String.raw`(?:cd|export|set|unset|source|shopt|umask)\b`,
  String.raw`[\w$.]+(?:\[[^\]]*\])*(?:\s*,\s*\*?[\w$.]+(?:\[[^\]]*\])*)*\s*(?::[^=]+)?(?:[-+*/%@&|^]|\/\/|\*\*|<<|>>)?=(?!=)`,
  String.raw`(?:[\w$]+\.)+(?:append|extend|add|update|sort|insert|remove|discard|pop|clear|setdefault|reverse|close|commit|execute|executemany|write|writerow|writerows|writeheader|seed)\s*\(`,
  String.raw`[rRbBuU]{0,2}(?:'{3}[^]*'{3}|"{3}[^]*"{3}|'[^']*'|"[^"]*")$`,
].join('|')})`)
// a command that runs a script: its code from a heredoc (`python3 - <<'PY'`), or after -c or -e
const SCRIPT = String.raw`(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:\S+\s+run\s+)?(?:\S*\/)?(?:python[\d.]*|node|ruby|perl|bash|sh|zsh)(?:\s+-[\w-]+)*`
const HEREDOC_RUN = new RegExp(String.raw`^${SCRIPT}(?:\s+-)?\s*<<-?\s*(['"]?)(\w+)\1\s*$`)
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/
const INLINE = new RegExp(String.raw`^${SCRIPT}\s+-[ce]\s*(['"])`)

/** One line read on from the lines before it (`st`: the quote of a string they left open, the brackets they left open):
 *  the line without its comment (`text`), and with what its strings hold blanked (`bare`), so a word inside a string
 *  does not count. */
function scan(line, st) {
  let text = ''
  let bare = ''
  for (let j = 0; j < line.length; j++) {
    const c = line[j]
    if (st.quote) {
      if (line.startsWith(st.quote, j)) { text += st.quote; bare += st.quote; j += st.quote.length - 1; st.quote = ''; continue }
      if (c === '\\' && j + 1 < line.length) { text += c + line[j + 1]; bare += '  '; j++; continue }
      text += c
      bare += ' '
      continue
    }
    if (c === '#' && (j === 0 || /\s/.test(line[j - 1]))) break
    if (c === '"' || c === "'" || c === '`') {
      st.quote = c !== '`' && line.startsWith(c.repeat(3), j) ? c.repeat(3) : c
      text += st.quote
      bare += st.quote
      j += st.quote.length - 1
      continue
    }
    if ('([{'.includes(c)) st.depth++
    else if (')]}'.includes(c)) st.depth = Math.max(0, st.depth - 1)
    text += c
    bare += c
  }
  return { text, bare }
}

/** `s` cut at each `sep` (a regular expression) that stands outside its strings and brackets (`bare` is s with its
 *  strings blanked), each part with what cut it before it. */
function cutOutside(s, bare, sep) {
  const parts = []
  let depth = 0
  let from = 0
  let by = ''
  for (let j = 0; j < bare.length; j++) {
    const c = bare[j]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1)
    else if (!depth) {
      const m = sep.exec(bare.slice(j))
      if (m && m.index === 0) {
        parts.push({ text: s.slice(from, j), bare: bare.slice(from, j), by })
        by = m[0]
        from = j + m[0].length
        j = from - 1
      }
    }
  }
  parts.push({ text: s.slice(from), bare: bare.slice(from), by })
  return parts
}

/** A print statement's arguments, outside their strings and brackets: Python's, JavaScript's or Ruby's inside its
 *  parentheses, a shell's echo's after it. */
function argsOf(text, bare) {
  const m = PRINT_AT.exec(bare)
  if (!m) return null
  let from = m[0].length
  if (/^\s*\(/.test(bare.slice(from)) || m[0].endsWith('(')) {
    const open = m[0].endsWith('(') ? from - 1 : bare.indexOf('(', from)
    let depth = 0
    let close = -1
    for (let j = open; j < bare.length; j++) {
      if ('([{'.includes(bare[j])) depth++
      else if (')]}'.includes(bare[j]) && --depth === 0) { close = j; break }
    }
    if (close < 0 || bare.slice(close + 1).trim()) return null
    from = open + 1
    return cutOutside(text.slice(from, close), bare.slice(from, close), /,/).map(p => p.text.trim()).filter(Boolean)
  }
  return cutOutside(text.slice(from), bare.slice(from), /\s+/).map(p => p.text.trim()).filter(Boolean)
}

// one string literal, or several joined (`"a" "b"`, `'a' + 'b'`): Python's, with its prefix
const LITERAL = /^(?:[rRbBuUfF]{0,2}(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*\+?\s*)+$/
const STRING = /[rRbBuUfF]{0,2}(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g

/** What a simple print statement prints, as far as its code tells: the words it writes out exactly when it hands out no
 *  value (`exact`, white space left out), whether it prints one line (`one`: its values are counts, `len(…)`, or
 *  numbers), whether that line is numbers alone (`digits`: it hands out no string), and whether it ends its line
 *  (`ends`: no `end=`, no `file=`, no echo -n, no printf or write). */
function printOf(text, bare) {
  const out = { exact: null, one: false, digits: false, ends: true }
  if (/^(?:printf\b|(?:[\w$]+\.)*stdout\.write)/.test(bare)) return { ...out, ends: false }
  const args = argsOf(text, bare)
  if (!args) return out
  const echo = /^echo\b/.test(bare)
  if (echo && args.some(a => /^-\w*[nec]/.test(a))) return { ...out, ends: false }
  let sep = ' '
  const words = []
  let values = 0
  let one = true
  for (const a of args) {
    const kw = /^(\w+)\s*=(?!=)\s*([^]*)$/.exec(a)
    if (kw && !echo) {
      if (kw[1] === 'end' || kw[1] === 'file') out.ends = false
      // a separator that breaks the line prints a line for each value
      if (kw[1] === 'sep') sep = LITERAL.test(kw[2]) && !/\\n/.test(kw[2]) ? [...kw[2].matchAll(STRING)].map(x => x[1] ?? x[2]).join('') : null
      if (sep == null) one = false
      continue
    }
    if (LITERAL.test(a) || (echo && !/[$`\\*?'"]/.test(a))) {
      const parts = LITERAL.test(a) ? [...a.matchAll(STRING)] : [[a, a]]
      for (const x of parts) {
        const s = x[1] ?? x[2]
        // what the string fills in: an f-string's fields, a shell's `$name` and `$(…)` inside double quotes
        const fields = /^[rRbBuU]*[fF]/.test(x[0]) ? [...s.replace(/\{\{|\}\}/g, '').matchAll(/\{([^{}]*)\}/g)].map(f => f[1])
          : echo && x[0][0] === '"' && /[$`]/.test(s) ? ['$'] : []
        if (/\\n/.test(s)) one = false
        // a field is a value: one line when it is a count
        for (const f of fields) { values++; if (!/^len\s*\(.*\)\s*(?:[:!].*)?$/.test(f)) one = false }
        words.push(fields.length ? null : /^[rRbBuU]*[fF]/.test(x[0]) ? s.replace(/\{\{|\}\}/g, w => w[0]) : s)
      }
      continue
    }
    values++
    if (!/^(?:-?\d[\d_]*(?:\.\d+)?|len\s*\(.*\))$/.test(a)) one = false
  }
  out.one = one
  // counts and numbers alone, joined by a separator with no letter: a line of numbers
  out.digits = one && values > 0 && !words.length && sep != null && !/\p{L}/u.test(sep)
  // words only: the line is those words, joined by the separator (simple escapes read as what they print)
  if (!values && sep != null && words.every(w => w != null && !/\\(?![tn"'\\])/.test(w) && !/\\n/.test(w))) {
    out.exact = words.join(sep).replace(/\\t/g, ' ').replace(/\\(["'\\])/g, '$1').replace(/\s+/g, '')
  }
  return out
}

/**
 * The prints of the code in the order they run, as far as the code shows it: a list of steps, each a print ({unit})
 * or a block of steps ({runs: 'loop' | 'cond' | 'once', steps}). `blind`: the code holds a statement that may print
 * and is no print (a command such as `head`, a call such as `df.info()`), so a line without a print's words may be
 * its; `unordered`: a print stands in a function's body, so the code does not give the order it runs in.
 */
function readCode(code) {
  const lines = String(code ?? '').split('\n')
  const read = { units: [], blind: false, unordered: false }
  read.steps = readLines(lines, 0, lines.length, read, null)
  return read
}

/** lines[from, to) as statements, into steps. `at`: the line every unit of an inline script stands at. */
function readLines(lines, from, to, read, at) {
  const root = { indent: -1, runs: 'once', steps: [] }
  const stack = [root]
  let i = from
  while (i < to) {
    // a statement: from its first line on while a bracket or a string stays open, or a line ends with `\`
    if (!lines[i].trim() || /^\s*(#|\/\/)/.test(lines[i])) { i++; continue }
    const first = i
    const indent = /^[ \t]*/.exec(lines[i])[0].replace(/\t/g, '    ').length
    const st = { quote: '', depth: 0 }
    let text = ''
    let bare = ''
    do {
      const r = scan(lines[i], st)
      text += (text ? '\n' : '') + r.text
      bare += (bare ? '\n' : '') + r.bare
      i++
    } while (i < to && (st.quote || st.depth > 0 || /\\$/.test(text)))
    text = text.trim()
    bare = bare.trim()
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]
    // a heredoc: a script whose code is its lines, or text another command reads (then it may print anything)
    // (its `<<` outside a string, and its end line in the code: `x << 2` shifts bits)
    const doc = HEREDOC.exec(text)
    let end = i
    while (doc && end < to && lines[end].trim() !== doc[2]) end++
    if (doc && bare.slice(doc.index, doc.index + 2) === '<<' && end < to) {
      if (HEREDOC_RUN.test(text)) parent.steps.push({ runs: 'once', steps: readLines(lines, i, end, read, at) })
      else read.blind = true
      i = end + 1
      continue
    }
    // a script after -c or -e: its code is the string; a script of one line stands at this line
    const inline = INLINE.exec(text)
    if (inline) {
      const q = inline[1]
      let close = inline[0].length
      while (close < text.length && text[close] !== q) close += text[close] === '\\' && q === '"' ? 2 : 1
      if (text.slice(close + 1).trim()) read.blind = true
      let inner = text.slice(inline[0].length, close)
      if (q === '"') inner = inner.replace(/\\(["\\$`])/g, '$1')
      const ls = inner.split('\n')
      const steps = readLines(ls, 0, ls.length, read, ls.length === 1 ? (at ?? first) : at)
      if (ls.length > 1 && at == null) moveLines(steps, first)
      parent.steps.push({ runs: 'once', steps })
      continue
    }
    const where = at ?? first
    readStatement(text, bare, where, indent, parent, stack, read)
  }
  return root.steps
}

/** The prints of a script over lines, which count its lines from its first, moved to the code's lines. */
function moveLines(steps, first) {
  for (const s of steps) {
    if (s.unit) s.unit.i += first
    else moveLines(s.steps, first)
  }
}

/** One statement (its text, and its text with its strings blanked) into the steps of `parent`: its parts cut at `;`,
 *  `&&` and `||`, each a print, a statement that holds a print (`[print(r) for r in rows]`, `for r in rows: print(r)`),
 *  a statement that prints nothing, a block's header, or a statement that may print. */
function readStatement(text, bare, i, indent, parent, stack, read) {
  // a print inside a function's body runs when the function is called, which the code's order does not tell
  const inDef = stack.some(s => s.runs === 'def')
  for (const part of cutOutside(text, bare, /;|&&|\|\|/)) {
    const t = part.text.trim()
    const b = part.bare.trim()
    if (!t) continue
    if (PRINT_AT.test(b)) {
      const u = { i, bits: literalBits(t), single: !/\\n/.test(t), ...printOf(t, b) }
      read.units.push(u)
      if (inDef) read.unordered = true
      // after && or ||, it may not run
      parent.steps.push(part.by === '&&' || part.by === '||' ? { runs: 'cond', steps: [{ unit: u }] } : { unit: u })
      continue
    }
    if (PRINTS.test(b)) {
      if (inDef || /\b(?:def|lambda|function)\b|=>/.test(b)) read.unordered = true
      held(t, i, parent, read)
      continue
    }
    // a function whose body is on the lines under it (`const show = (v) => {`, `rows.forEach(r => {`)
    if (/\{$/.test(b) && /=>|\bfunction\b/.test(b)) {
      const block = { indent, runs: 'def', steps: [] }
      parent.steps.push(block)
      stack.push(block)
      continue
    }
    if (SILENT.test(b)) continue
    const head = HEADER.exec(b)
    if (head && /[:{]$/.test(b)) {
      // a header that ends its line opens a block of the lines under it
      const block = { indent, runs: RUNS[head[1]] ?? 'cond', steps: [] }
      parent.steps.push(block)
      stack.push(block)
      continue
    }
    // a block on one line whose body prints nothing (`for r in rows: n += 1`)
    if (head && SILENT.test(cutOutside(t, b, /:/).slice(1).map(p => p.bare).join(':').trim())) continue
    read.blind = true
  }
}

/** A statement that holds a print it may run any number of times (`[print(r) for r in rows]`, `x and print(y)`). */
function held(t, i, parent, read) {
  const u = { i, bits: literalBits(t), single: !/\\n/.test(t), exact: null, one: false, ends: true }
  read.units.push(u)
  parent.steps.push({ runs: 'loop', steps: [{ unit: u }] })
}

// ------------------------------------------------------------------------------------- reading the output in order

// the lines Python writes into a script's output itself, which no print wrote: a warning (`<file>:<line>:
// <Category>Warning: <message>`, and the line of code under it, two spaces in, when Python has that line), and an
// error's traceback, from its first line to the line that names the error
const WARNING = /^\S.*:\d+: [A-Z]\w*Warning:(?: |$)/
const TRACEBACK = 'Traceback (most recent call last):'

/** Which lines of the output Python wrote itself (`own`), and whether the code stopped at an error (`stopped`): its
 *  statements after the one that failed never ran. */
function pythonsLines(said) {
  const own = said.map(() => false)
  let stopped = false
  for (let j = 0; j < said.length; j++) {
    if (WARNING.test(said[j])) {
      own[j] = true
      if (/^ {2}\S/.test(said[j + 1] ?? '')) own[++j] = true
    } else if (said[j] === TRACEBACK) {
      own[j] = stopped = true
      while (j + 1 < said.length && /^\s/.test(said[j + 1])) own[++j] = true
      if (j + 1 < said.length && said[j + 1].trim()) own[++j] = true
    }
  }
  return { own, stopped }
}

/** A line of numbers alone (`40`, `0.45 12`, `1e-05`), as a print of counts and numbers writes it. */
const numbers = s => /\d/.test(s) && !/\p{L}/u.test(s.replace(/(\d)[eE](?=[-+]?\d)/g, '$1'))

/** The prints that could have printed the output's line `k`, in some reading of its lines by the code's prints in the
 *  order they run, or null when no reading fits the output: each print that runs writes lines one after another, at
 *  least one (exactly one when it prints `one`), only lines it `may` write and at most one that holds its `own` words.
 *  A line no print wrote may stand anywhere (`free`: it holds no print's own words), and once the code `stopped` at an
 *  error, the prints after it never ran. */
function readers(steps, said, may, own, free, stopped, k) {
  const M = said.length
  // the steps as a machine of states: an edge reads a print's lines, or nothing
  const edges = []
  let n = 0
  const build = (list, s) => {
    let at = s
    for (const st of list) {
      if (st.unit) { const t = n++; edges.push([at, t, st.unit]); at = t; continue }
      if (st.runs === 'def') continue
      const b0 = n++
      const b1 = build(st.steps, b0)
      const t = n++
      edges.push([at, b0, null], [b1, t, null])
      if (st.runs === 'loop') edges.push([b1, b0, null], [at, t, null])
      else if (st.runs === 'cond') edges.push([at, t, null])
      at = t
    }
    return at
  }
  const start = n++
  const end = build(steps, start)
  // the code stopped at an error: the reading may end at any state
  if (stopped) for (let q = 0; q < n; q++) if (q !== end) edges.push([q, end, null])
  const eps = Array.from({ length: n }, () => [])
  const back = Array.from({ length: n }, () => [])
  // the edges that read lines: [from, to, the print's last ends]
  const reads = []
  for (const [a, b, u] of edges) {
    if (u) reads.push([a, b, u])
    else { eps[a].push(b); back[b].push(a) }
  }
  // the states a set of states reaches along edges that read nothing (`via`: eps forward, back backward), in place
  const todo = new Int32Array(n)
  const close = (set, via) => {
    let top = 0
    for (let q = 0; q < n; q++) if (set[q]) todo[top++] = q
    while (top) {
      const to = via[todo[--top]]
      for (let j = 0; j < to.length; j++) if (!set[to[j]]) { set[to[j]] = 1; todo[top++] = to[j] }
    }
    return set
  }
  // where a print's lines from line s can end (exclusive): the lines it may write, up to its limits
  const last = new Map()
  for (const u of new Set(reads.map(r => r[2]))) {
    // walking back from the end: the first line u may not write, and its second line of own words
    const at = new Int32Array(M + 1)
    let stop = M
    let ownAt = M
    let ownNext = M
    for (let s = M - 1; s >= 0; s--) {
      if (!may(u, s)) stop = s
      if (own(u, s)) { ownNext = ownAt; ownAt = s }
      at[s] = may(u, s) ? Math.min(stop, u.bits.length && u.single ? ownNext : M, u.one ? s + 1 : M) : s
    }
    last.set(u, at)
  }
  for (const r of reads) r[2] = last.get(r[2])
  // forward: the states reached when lines [0, pos) are read; a print read from pos reaches pos + 1 to its last end,
  // and a line no print wrote is passed over
  const F = []
  const diff = Array.from({ length: n }, () => new Int32Array(M + 2))
  const cnt = new Int32Array(n)
  for (let pos = 0; pos <= M; pos++) {
    const here = new Uint8Array(n)
    if (pos === 0) here[start] = 1
    else if (free[pos - 1]) here.set(F[pos - 1])
    for (let q = 0; q < n; q++) { cnt[q] += diff[q][pos]; if (cnt[q] > 0) here[q] = 1 }
    F[pos] = close(here, eps)
    if (pos === M) break
    for (let r = 0; r < reads.length; r++) {
      const [q, q2, ends] = reads[r]
      const e = ends[pos]
      if (F[pos][q] && e > pos) { diff[q2][pos + 1]++; diff[q2][e + 1]-- }
    }
  }
  if (!F[M][end]) return null
  // backward: the states from which lines [pos, M) can be read to the end, and for each state the next such pos
  const next = Array.from({ length: n }, () => new Int32Array(M + 2).fill(M + 1))
  const done = new Uint8Array(n)
  done[end] = 1
  close(done, back)
  for (let q = 0; q < n; q++) if (done[q]) next[q][M] = M
  for (let pos = M - 1; pos >= 0; pos--) {
    const B = new Uint8Array(n)
    for (let r = 0; r < reads.length; r++) {
      const [q, q2, ends] = reads[r]
      const e = ends[pos]
      if (e > pos && next[q2][pos + 1] <= e) B[q] = 1
    }
    if (free[pos]) for (let q = 0; q < n; q++) if (next[q][pos + 1] === pos + 1) B[q] = 1
    close(B, back)
    for (let q = 0; q < n; q++) next[q][pos] = B[q] ? pos : next[q][pos + 1]
  }
  // the prints that read line k in some reading: from a start s at or before k, to an end past it
  const out = new Set()
  for (const [u, ends] of last) for (const [q, q2, at] of reads) {
    if (at !== ends || out.has(u)) continue
    for (let s = k; s >= 0; s--) {
      // a print that starts earlier reaches no further
      if (ends[s] <= k) break
      if (F[s][q] && next[q2][k + 1] <= ends[s]) { out.add(u); break }
    }
  }
  return [...out]
}

/**
 * The line of a check's code that printed the output's line `at` (`out` is the whole output; a single line is its
 * line 0), or '' when the code does not show it for sure: a line that did not print the value is worse than none.
 * It is the print whose own words stand in that line, the one with the most of them (`print("failed:", n)`); else, in
 * code where every statement that may print is a print, the one print that could have written that line: by what
 * each print can write (`print(df)` under `print("Failures by day:")`, which writes only its words; a print of a value
 * under `print(len(runs))`, which writes a number) and, where the code shows the order its prints run in, in every
 * reading of the whole output in that order (`print(len(runs))` then `print(sum(...))`, a loop's prints). A line
 * Python wrote itself (a warning, a traceback) is no print's.
 */
export function printLine(code, out, at = 0) {
  const lines = String(code || '').split('\n')
  const read = readCode(code)
  const units = read.units
  if (!units.length) return ''
  let said = String(out ?? '').split('\n')
  if (said.length > 1 && said[said.length - 1] === '') said = said.slice(0, -1)
  const k = Math.max(0, Math.min(said.length - 1, Math.trunc(Number(at)) || 0))
  const norm = s => s.replace(/\s+/g, '')
  const python = pythonsLines(said)
  if (python.own[k]) return ''
  // the prints whose own words stand in each line, the most of them (a print that writes only its words: exactly them)
  const best = said.map((line, j) => {
    let most = 0
    let who = []
    if (python.own[j]) return who
    for (const u of units) {
      if (!u.bits.length) continue
      const got = u.exact != null ? (norm(line) === u.exact ? u.bits.reduce((a, b) => a + b.length, 0) : 0) : u.bits.filter(b => line.includes(b)).reduce((a, b) => a + b.length, 0)
      if (got > most) { most = got; who = [u] } else if (got && got === most) who.push(u)
    }
    return who
  })
  const one = list => {
    const at = new Set(list.map(u => u.i))
    return at.size === 1 ? lines[[...at][0]].trim() : ''
  }
  if (best[k].length && one(best[k])) return one(best[k])
  if (read.blind) return ''
  // the output cut by its window (`…` at an end): its first or last line may be a part of another print's
  const cut = (k === 0 && said[0].startsWith('…')) || (k === said.length - 1 && said[k].endsWith('…'))
  if (cut) return ''
  // the lines a print may write: none Python wrote, none that holds another print's words, only its own words when it
  // writes them exactly, a line of numbers when it prints numbers alone
  const may = (u, j) => !python.own[j] && (!best[j].length || best[j].includes(u)) && (u.exact == null || norm(said[j]) === u.exact) && (!u.digits || numbers(said[j]))
  const could = units.filter(u => may(u, k))
  if (!could.length) return ''
  // where the code does not show the order its prints run in, or the window cut the output: what each print may write
  if (read.unordered || units.some(u => !u.ends) || said[0].startsWith('…') || said[said.length - 1].endsWith('…')) return one(could)
  // else the readings of the whole output in that order: a line that no print wrote in any of them is none's (the
  // lines of a warning's message after its first); when no reading fits (a partial output), what each print may write
  const by = readers(read.steps, said, may, (u, j) => best[j].includes(u), best.map(b => !b.length), python.stopped, k)
  return one(by ?? could)
}
