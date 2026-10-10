// thimble's diff for a view's page, part of the view kit: views.frame_document loads it after viewer_table.js and
// before viewer_range.js; viewer_kit.css styles it. Two versions of a text, such as a wiki page's revisions or a memory
// file rewritten, side by side or inline, as a code forge draws a change:
//
//   const diff = thimble.diff({ mount: '#diff', before: older.text, after: newer.text, titles: ['Rev 41', 'Rev 42'] })
//   diff.set({ before, after })               another pair, such as the next revision
//   thimble.diff({ mount: '#commit', patch: commit.diff, ref: commit.ref })   a change as git or a forge stores it
//
// The lines are aligned, a line removed in the problem red's tint with − before it and a line added in the positive
// green's with +, and in a changed line the words that changed in a stronger tint. Side by side (`mode: 'split'`) the
// older version is on the left and the newer on the right, a changed line beside the line it became; inline
// (`'inline'`) a changed line is the old line over the new one. `'auto'`, the default, is side by side in a mount at
// least SPLIT_PX wide and inline in a narrower one, such as the side panel, or where one version is empty. Unchanged
// lines more than `context` lines from a change fold to one line, "120 unchanged lines", with Show more, and Show less
// folds them again; the folded lines stay in the page, hidden, so thimble.search finds them and opens their fold. Line
// numbers and signs are drawn by the style alone, so they are neither found, copied nor quoted. `ref` is the newer
// version's record, the diff's data-anchor: a label marks it, a ⌘-click asks about it and a citation's quote is found
// in it. `patch`, in place of the two texts, is a unified diff as git or a forge stores a change: each file it names
// under a head with its path and its lines added and removed, each hunk under its `@@ -12,7 +12,8 @@` line, its lines
// numbered from it; a patch of hunks alone, such as a forge's patch of one file, has no head.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var shared = kit.shared
  var ctl = shared.controls
  var esc = shared.esc
  var num = shared.num

  var SPLIT_PX = 760 // px a mount's content is wide at least for `auto` to set the versions side by side, about 45
  // characters a side
  var CONTEXT = 3 // unchanged lines kept beside a change
  var MIN_FOLD = 4 // unchanged lines a fold hides at least; a shorter stretch shows
  var CELLS = 4000000 // the largest table a longest common subsequence is found in; past it, unique lines anchor it
  var ALIKE = 0.4 // words two lines share at least (Dice) for their words to be compared rather than the whole lines
  var WORD = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu

  // ---------------------------------------------------------------- the alignment
  // The steps from `a` to `b`, sequences of numbers: [op, i, j] with op 0 the same, 1 removed from a, 2 added from b. The
  // common ends first; then a longest common subsequence where its table is small enough, else the elements each holds
  // once anchor it (patience) and the stretches between the anchors are aligned in turn; with no anchor, all removed
  // then all added.
  function steps(a, b) {
    var out = []
    seq(a, 0, a.length, b, 0, b.length, out)
    return out
  }
  function seq(a, a0, a1, b, b0, b1, out) {
    var head = []
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) head.push([0, a0++, b0++])
    var tail = []
    while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) tail.unshift([0, --a1, --b1])
    for (var h = 0; h < head.length; h++) out.push(head[h])
    var n = a1 - a0
    var m = b1 - b0
    if (!n || !m) {
      for (var i = a0; i < a1; i++) out.push([1, i, -1])
      for (var j = b0; j < b1; j++) out.push([2, -1, j])
    } else if (n * m <= CELLS) lcs(a, a0, a1, b, b0, b1, out)
    else {
      var anchors = patience(a, a0, a1, b, b0, b1)
      if (!anchors.length) {
        for (var i2 = a0; i2 < a1; i2++) out.push([1, i2, -1])
        for (var j2 = b0; j2 < b1; j2++) out.push([2, -1, j2])
      } else {
        var pa = a0
        var pb = b0
        for (var k = 0; k < anchors.length; k++) {
          seq(a, pa, anchors[k][0], b, pb, anchors[k][1], out)
          out.push([0, anchors[k][0], anchors[k][1]])
          pa = anchors[k][0] + 1
          pb = anchors[k][1] + 1
        }
        seq(a, pa, a1, b, pb, b1, out)
      }
    }
    for (var t = 0; t < tail.length; t++) out.push(tail[t])
  }
  function lcs(a, a0, a1, b, b0, b1, out) {
    var n = a1 - a0
    var m = b1 - b0
    var w = m + 1
    var T = n < 65535 && m < 65535 ? new Uint16Array((n + 1) * w) : new Uint32Array((n + 1) * w)
    for (var i = n - 1; i >= 0; i--)
      for (var j = m - 1; j >= 0; j--)
        T[i * w + j] = a[a0 + i] === b[b0 + j] ? T[(i + 1) * w + j + 1] + 1 : Math.max(T[(i + 1) * w + j], T[i * w + j + 1])
    var x = 0
    var y = 0
    while (x < n && y < m) {
      if (a[a0 + x] === b[b0 + y]) {
        out.push([0, a0 + x++, b0 + y++])
      } else if (T[(x + 1) * w + y] >= T[x * w + y + 1]) out.push([1, a0 + x++, -1])
      else out.push([2, -1, b0 + y++])
    }
    while (x < n) out.push([1, a0 + x++, -1])
    while (y < m) out.push([2, -1, b0 + y++])
  }
  // the elements each of a and b hold once, in an order both keep (the longest such, by patience sorting): [[i, j]]
  function patience(a, a0, a1, b, b0, b1) {
    var ca = new Map()
    var cb = new Map()
    for (var i = a0; i < a1; i++) ca.set(a[i], ca.has(a[i]) ? -1 : i)
    for (var j = b0; j < b1; j++) cb.set(b[j], cb.has(b[j]) ? -1 : j)
    var pairs = []
    for (var jj = b0; jj < b1; jj++) {
      var ia = ca.get(b[jj])
      if (ia != null && ia >= 0 && cb.get(b[jj]) === jj) pairs.push([ia, jj])
    }
    // the longest run of pairs rising in a, in b's order
    var tops = []
    var back = new Array(pairs.length)
    for (var p = 0; p < pairs.length; p++) {
      var lo = 0
      var hi = tops.length
      while (lo < hi) {
        var mid = (lo + hi) >> 1
        if (pairs[tops[mid]][0] < pairs[p][0]) lo = mid + 1
        else hi = mid
      }
      back[p] = lo ? tops[lo - 1] : -1
      tops[lo] = p
    }
    var outp = []
    for (var q = tops.length ? tops[tops.length - 1] : -1; q >= 0; q = back[q]) outp.unshift(pairs[q])
    return outp
  }
  // texts as numbers, the same text the same number, for the alignment
  function ids(lists) {
    var seen = new Map()
    return lists.map(function (l) {
      return l.map(function (s) {
        var k = seen.get(s)
        if (k === undefined) seen.set(s, (k = seen.size))
        return k
      })
    })
  }
  function linesOf(text) {
    if (text == null || text === '') return []
    var ls = String(text).replace(/\r\n?/g, '\n').split('\n')
    if (ls.length > 1 && ls[ls.length - 1] === '') ls.pop()
    return ls
  }
  // how alike two lines read: the share of their words both hold (Dice), 0 to 1
  function likeness(x, y) {
    var wx = new Set((x.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []))
    var wy = new Set((y.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []))
    if (!wx.size && !wy.size) return x.trim() === y.trim() ? 1 : 0
    var both = 0
    wx.forEach(function (w) {
      if (wy.has(w)) both++
    })
    return (2 * both) / (wx.size + wy.size)
  }
  // Two lines word by word: the old line's parts (same or removed) and the new line's (same or added), each [changed,
  // text]; a space between two changes goes with them, so a change reads as one phrase
  function words(x, y) {
    var tx = x.match(WORD) || []
    var ty = y.match(WORD) || []
    var n = ids([tx, ty])
    var st = steps(n[0], n[1])
    var left = []
    var right = []
    // a space the same between two changes on its side joins them
    for (var k = 0; k < st.length; k++) {
      var s = st[k]
      if (s[0] === 0 && /^\s+$/.test(tx[s[1]]) && k > 0 && k < st.length - 1 && st[k - 1][0] !== 0 && st[k + 1][0] !== 0) {
        left.push([1, tx[s[1]]])
        right.push([1, ty[s[2]]])
      } else if (s[0] === 0) {
        left.push([0, tx[s[1]]])
        right.push([0, ty[s[2]]])
      } else if (s[0] === 1) left.push([1, tx[s[1]]])
      else right.push([1, ty[s[2]]])
    }
    return [tidy(left), tidy(right)]
  }
  function tidy(parts) {
    var out = []
    for (var i = 0; i < parts.length; i++) {
      var last = out[out.length - 1]
      if (last && last[0] === parts[i][0]) last[1] += parts[i][1]
      else out.push([parts[i][0], parts[i][1]])
    }
    return out
  }
  // A stretch of changes as rows: the removed lines ([number, text]) set against the added ones in order, as a code
  // forge does, a pair alike enough a changed line ('mod', its words marked) and the rest removed or added whole; the
  // two lists are emptied
  function pairUp(dels, inss, out) {
    var k = Math.max(dels.length, inss.length)
    for (var i = 0; i < k; i++) {
      var d = i < dels.length ? dels[i] : null
      var s = i < inss.length ? inss[i] : null
      if (d && s && likeness(d[1], s[1]) >= ALIKE) {
        var w = words(d[1], s[1])
        out.push({ kind: 'mod', a: d[0], b: s[0], ta: d[1], tb: s[1], pa: w[0], pb: w[1] })
      } else {
        if (d) out.push({ kind: 'del', a: d[0], b: null, ta: d[1], tb: null, pair: !!s })
        if (s) out.push({ kind: 'ins', a: null, b: s[0], ta: null, tb: s[1], pair: !!d })
      }
    }
    dels.length = 0
    inss.length = 0
  }
  // The rows of a diff: {kind, a, b, ta, tb, pa, pb} with kind 'same', 'del', 'ins' or 'mod' (a line changed, beside
  // the line it became), a and b the lines' numbers from 1 (null where a side has none), ta and tb their texts, pa and
  // pb a changed line's parts (pairUp).
  function rows(before, after) {
    var A = linesOf(before)
    var B = linesOf(after)
    var n = ids([A, B])
    var st = steps(n[0], n[1])
    var out = []
    var dels = []
    var inss = []
    for (var k = 0; k < st.length; k++) {
      var s = st[k]
      if (s[0] === 0) {
        pairUp(dels, inss, out)
        out.push({ kind: 'same', a: s[1] + 1, b: s[2] + 1, ta: A[s[1]], tb: B[s[2]] })
      } else if (s[0] === 1) dels.push([s[1] + 1, A[s[1]]])
      else inss.push([s[2] + 1, B[s[2]]])
    }
    pairUp(dels, inss, out)
    return { rows: out, lines: [A.length, B.length] }
  }

  // ---------------------------------------------------------------- a patch
  // A unified diff as git or a forge stores a change: [{from, to, named, binary, hunks: [{range, heading, rows}]}], a
  // file for each that it names (`diff --git`, or `---` over `+++`), its paths without git's a/ and b/, null for
  // /dev/null (a file created or deleted); a patch of hunks alone, as a forge gives one file's, is one file with no
  // name. A hunk's lines are read by the counts its `@@ -12,7 +12,8 @@` line gives (1 where it leaves one out), so a
  // removed line that starts with `--` is never taken for a file's header and what follows the last hunk, such as a
  // mail's signature, is left out; its rows are numbered from that line, as rows() gives them.
  var HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/
  function pathOf(s) {
    s = s.replace(/\t.*$/, '').replace(/\s+$/, '') // a time after a tab, as diff -u writes one
    if (s === '/dev/null') return null
    if (s.charAt(0) === '"')
      try {
        s = JSON.parse(s) // git quotes a path with odd characters
      } catch (e) {}
    return s.replace(/^[ab]\//, '')
  }
  function parsePatch(text) {
    var lines = linesOf(text)
    var files = []
    var file = null
    var open = function () {
      file = { from: null, to: null, named: false, binary: false, hunks: [] }
      files.push(file)
    }
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i]
      var m = HUNK.exec(l)
      if (m) {
        if (!file) open()
        var a = Number(m[1])
        var b = Number(m[3])
        var left = [m[2] == null ? 1 : Number(m[2]), m[4] == null ? 1 : Number(m[4])]
        var hunk = { range: l.slice(0, l.indexOf('@@', 2) + 2), heading: m[5].trim(), rows: [] }
        var dels = []
        var inss = []
        while (i + 1 < lines.length && (left[0] > 0 || left[1] > 0)) {
          var x = lines[i + 1]
          var c = x.charAt(0)
          if (c === '\\') {
            i++ // \ No newline at end of file
            continue
          }
          if (c === '-' && left[0] > 0) {
            dels.push([a++, x.slice(1)])
            left[0]--
          } else if (c === '+' && left[1] > 0) {
            inss.push([b++, x.slice(1)])
            left[1]--
          } else if ((c === ' ' || x === '') && left[0] > 0 && left[1] > 0) {
            pairUp(dels, inss, hunk.rows)
            hunk.rows.push({ kind: 'same', a: a++, b: b++, ta: x.slice(1), tb: x.slice(1) })
            left[0]--
            left[1]--
          } else break
          i++
        }
        pairUp(dels, inss, hunk.rows)
        file.hunks.push(hunk)
        continue
      }
      if (l.indexOf('diff --git ') === 0) {
        open()
        file.named = true
        var g = /^diff --git (?:a\/)?(.+?) (?:b\/)?(\1)$/.exec(l) || /^diff --git a\/(.+) b\/(.+)$/.exec(l)
        if (g) {
          file.from = g[1]
          file.to = g[2]
        }
      } else if (l.indexOf('--- ') === 0 && i + 1 < lines.length && lines[i + 1].indexOf('+++ ') === 0) {
        // a file's header: the one `diff --git` opened, else a file of its own
        if (!file || file.hunks.length || file.headed) open()
        file.named = file.headed = true
        file.from = pathOf(l.slice(4))
        file.to = pathOf(lines[++i].slice(4))
      } else if (file && /^new file mode /.test(l)) file.from = null
      else if (file && /^deleted file mode /.test(l)) file.to = null
      else if (file && (m = /^rename from (.+)$/.exec(l))) file.from = m[1]
      else if (file && (m = /^rename to (.+)$/.exec(l))) file.to = m[1]
      else if (file && (/^Binary files .* differ$/.test(l) || l === 'GIT binary patch')) file.binary = true
    }
    return files
  }

  // ---------------------------------------------------------------- drawing it
  function partsHtml(parts, tag) {
    var out = ''
    for (var i = 0; i < parts.length; i++) out += parts[i][0] ? '<' + tag + ' class="thimble-diff-w">' + esc(parts[i][1]) + '</' + tag + '>' : esc(parts[i][1])
    return out
  }
  // a line's text cell: its sign (drawn by the style, as is the height of an empty line), its text, a changed line's
  // words marked
  function textCell(kind, text, parts, tag) {
    var body = parts ? partsHtml(parts, tag) : esc(text)
    return '<span class="thimble-diff-tx thimble-diff-' + kind + '">' + body + '</span>'
  }
  function noCell(n) {
    return '<span class="thimble-diff-no"' + (n != null ? ' data-n="' + n + '"' : '') + '></span>'
  }
  // a row side by side: the older line at the left, the newer at the right; a removed line and the added line set
  // against it share a row
  function splitRows(list) {
    var out = ''
    for (var i = 0; i < list.length; i++) {
      var r = list[i]
      var left
      var right
      if (r.kind === 'same') {
        left = noCell(r.a) + textCell('same', r.ta)
        right = noCell(r.b) + textCell('same', r.tb)
      } else if (r.kind === 'mod') {
        left = noCell(r.a) + textCell('del', r.ta, r.pa, 'del')
        right = noCell(r.b) + textCell('ins', r.tb, r.pb, 'ins')
      } else if (r.kind === 'del' && r.pair && list[i + 1] && list[i + 1].kind === 'ins' && list[i + 1].pair) {
        left = noCell(r.a) + textCell('del', r.ta)
        right = noCell(list[i + 1].b) + textCell('ins', list[i + 1].tb)
        i++
      } else if (r.kind === 'del') {
        left = noCell(r.a) + textCell('del', r.ta)
        right = noCell(null) + '<span class="thimble-diff-tx thimble-diff-none"></span>'
      } else {
        left = noCell(null) + '<span class="thimble-diff-tx thimble-diff-none"></span>'
        right = noCell(r.b) + textCell('ins', r.tb)
      }
      out += '<div class="thimble-diff-row">' + left + right + '</div>'
    }
    return out
  }
  // a row inline: the old line's number, the new line's, the line; a changed line is the old over the new
  function inlineRows(list) {
    var out = ''
    for (var i = 0; i < list.length; i++) {
      var r = list[i]
      if (r.kind === 'mod') {
        out += '<div class="thimble-diff-row">' + noCell(r.a) + noCell(null) + textCell('del', r.ta, r.pa, 'del') + '</div>'
        out += '<div class="thimble-diff-row">' + noCell(null) + noCell(r.b) + textCell('ins', r.tb, r.pb, 'ins') + '</div>'
      } else out += '<div class="thimble-diff-row">' + noCell(r.a) + noCell(r.b) + textCell(r.kind, r.kind === 'ins' ? r.tb : r.ta) + '</div>'
    }
    return out
  }

  var HOSTED = typeof WeakMap === 'function' ? new WeakMap() : null // a mount -> the diff it holds, which a new one there retires

  function Diff(opts) {
    var self = this
    this.mount = ctl.el(opts.mount)
    this.dead = false
    this.before = opts.before
    this.after = opts.after
    this.patch = opts.patch != null ? String(opts.patch) : null
    this.mode = opts.mode === 'split' || opts.mode === 'inline' ? opts.mode : 'auto'
    this.context = Number(opts.context) >= 0 ? Math.floor(Number(opts.context)) : CONTEXT
    this.titles = Array.isArray(opts.titles) ? opts.titles : null
    this.ref = opts.ref != null ? String(opts.ref) : null
    this.opened = {} // a fold's number -> true while it shows its lines
    if (!this.mount) return
    // a diff made again on the same mount takes its place: the one before draws nothing more
    var before = HOSTED && HOSTED.get(this.mount)
    if (before) before.retire()
    if (HOSTED) HOSTED.set(this.mount, this)
    this.mount.classList.add('thimble-diff-host')
    this.mount.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-fold-button]')
      if (!self.dead && b && self.mount.contains(b)) self.toggle(Number(b.getAttribute('data-fold-button')))
    })
    // the search goes to a match in a fold: the fold opens
    this.mount.addEventListener('thimble-unfold', function (e) {
      var f = e.target && e.target.getAttribute ? e.target.getAttribute('data-fold') : null
      if (!self.dead && f != null) self.toggle(Number(f), true)
    })
    if (typeof ResizeObserver === 'function') {
      this.resized = new ResizeObserver(function () {
        if (!self.dead && self.mount.isConnected && self.mode === 'auto' && self.shown !== self.resolved()) self.draw()
      })
      this.resized.observe(this.mount)
    }
    this.draw()
  }
  // the diff made again on its mount: it draws nothing more
  Diff.prototype.retire = function () {
    this.dead = true
    if (this.resized) this.resized.disconnect()
  }
  // the mode drawn: `auto` side by side in a wide mount, inline in a narrow one or when one side is empty (a page created
  // or deleted, a patch that only adds or only removes lines), which leaves that side nothing to show
  Diff.prototype.resolved = function () {
    if (this.mode !== 'auto') return this.mode
    if (this.oneSided) return 'inline'
    // the width the lines get: the mount's less its padding, as the side panel's body has
    var cs = getComputedStyle(this.mount)
    var w = this.mount.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
    return w <= 0 || w >= SPLIT_PX ? 'split' : 'inline'
  }
  // The rows of one stretch (the two texts, or a hunk) drawn: the changes with the `context` lines beside them, each run
  // of unchanged lines further from a change folded under a bar with Show more, numbered on from this.folds; the
  // counts of lines added and removed and of changes added to
  Diff.prototype.stretch = function (list, rowsHtml) {
    // the lines a change keeps in view: those within `context` lines of one
    var near = new Array(list.length)
    var lastChange = -Infinity
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind !== 'same') {
        if (list[i].kind !== 'ins') this.removed++
        if (list[i].kind !== 'del') this.added++
        if (i - lastChange > 1) this.changes++
        lastChange = i
        for (var k = Math.max(0, i - this.context); k <= i; k++) near[k] = true
      } else if (i - lastChange <= this.context) near[i] = true
    }
    var out = ''
    var j = 0
    while (j < list.length) {
      if (near[j] || list[j].kind !== 'same') {
        var e = j
        while (e < list.length && (near[e] || list[e].kind !== 'same')) e++
        out += rowsHtml(list.slice(j, e))
        j = e
        continue
      }
      var end = j
      while (end < list.length && !near[end]) end++
      var run = list.slice(j, end)
      if (run.length < MIN_FOLD) out += rowsHtml(run)
      else {
        var fold = this.folds++
        var open = !!this.opened[fold]
        out +=
          '<div class="thimble-diff-gap" data-thimble-chrome><span class="thimble-diff-n">' + num(run.length) + (run.length === 1 ? ' unchanged line' : ' unchanged lines') + '</span>' +
          '<button type="button" class="btn btn-ghost btn-sm thimble-diff-more" data-fold-button="' + fold + '" aria-expanded="' + open + '">' + (open ? 'Show less' : 'Show more') + '</button></div>' +
          '<div class="thimble-diff-fold" data-thimble-fold data-fold="' + fold + '"' + (open ? '' : ' hidden') + '>' + rowsHtml(run) + '</div>'
      }
      j = end
    }
    return out
  }
  // A patch's files drawn: a file it names under its head (its path, `from → to` when it was renamed, and its lines added
  // and removed), each hunk under its `@@` line, whose heading (the function it is in) is the file's text and whose
  // range is the diff's own wording
  Diff.prototype.files = function (files, rowsHtml) {
    var self = this
    var out = ''
    files.forEach(function (f) {
      var added = self.added
      var removed = self.removed
      var body = ''
      f.hunks.forEach(function (h) {
        body +=
          '<div class="thimble-diff-hunk"><span class="thimble-diff-range" data-thimble-chrome>' + esc(h.range) + '</span>' +
          (h.heading ? ' <span class="thimble-diff-heading">' + esc(h.heading) + '</span>' : '') + '</div>' + self.stretch(h.rows, rowsHtml)
      })
      if (f.binary && !f.hunks.length) body += '<div class="thimble-diff-empty">Binary file, not shown</div>'
      else if (!f.hunks.length) body += '<div class="thimble-diff-empty">No lines changed</div>'
      if (f.named) {
        var path = f.from != null && f.to != null && f.from !== f.to ? f.from + ' → ' + f.to : f.to != null ? f.to : f.from || ''
        var counts = f.binary && !f.hunks.length ? '' : '+' + num(self.added - added) + ' \u2212' + num(self.removed - removed)
        body =
          '<div class="thimble-diff-file"><span class="thimble-diff-path">' + esc(path) + '</span>' +
          (counts ? '<span class="thimble-diff-count" data-thimble-chrome>' + counts + '</span>' : '') + '</div>' + body
      }
      out += body
    })
    return out
  }
  Diff.prototype.draw = function () {
    if (!this.mount || this.dead) return
    var files = this.patch != null ? parsePatch(this.patch) : null
    var got = files ? null : rows(this.before, this.after)
    var all = got ? got.rows : []
    if (files)
      for (var fi = 0; fi < files.length; fi++)
        for (var hi = 0; hi < files[fi].hunks.length; hi++)
          for (var ri = 0; ri < files[fi].hunks[hi].rows.length; ri++) all.push(files[fi].hunks[hi].rows[ri])
    // one side empty: every line added, or every line removed
    var olds = 0
    var news = 0
    var most = 1
    for (var i = 0; i < all.length; i++) {
      if (all[i].a != null) olds++
      if (all[i].b != null) news++
      most = Math.max(most, all[i].a || 0, all[i].b || 0)
    }
    this.oneSided = !olds || !news
    var mode = this.resolved()
    this.shown = mode
    this.added = 0
    this.removed = 0
    this.changes = 0
    this.folds = 0
    var rowsHtml = mode === 'split' ? splitRows : inlineRows
    var out = files ? this.files(files, rowsHtml) : this.stretch(got.rows, rowsHtml)
    if (files && !files.length) out = '<div class="thimble-diff-empty">No changes in the patch</div>'
    else if (!files && !got.rows.length) out = '<div class="thimble-diff-empty">Both versions are empty</div>'
    var digits = String(most).length
    var head = ''
    if (this.titles && mode === 'split') head = '<div class="thimble-diff-head" data-thimble-chrome><span>' + esc(this.titles[0] == null ? '' : this.titles[0]) + '</span><span>' + esc(this.titles[1] == null ? '' : this.titles[1]) + '</span></div>'
    else if (this.titles) head = '<div class="thimble-diff-head" data-thimble-chrome><span>' + esc(this.titles[0] == null ? '' : this.titles[0]) + ' → ' + esc(this.titles[1] == null ? '' : this.titles[1]) + '</span></div>'
    this.mount.innerHTML =
      '<div class="thimble-diff thimble-diff-' + mode + '"' + (this.ref ? ' data-anchor="' + esc(this.ref) + '"' : '') + ' style="--thimble-diff-digits:' + digits + '">' + head + out + '</div>'
  }
  // a fold opened or folded again; `on` true opens it
  Diff.prototype.toggle = function (k, on) {
    var f = this.mount.querySelector('[data-fold="' + k + '"]')
    var b = this.mount.querySelector('[data-fold-button="' + k + '"]')
    if (!f || !b) return
    var open = on === undefined ? f.hidden : !!on
    if (open) this.opened[k] = true
    else delete this.opened[k]
    f.hidden = !open
    b.textContent = open ? 'Show less' : 'Show more'
    b.setAttribute('aria-expanded', String(open))
  }

  /** two versions of a text side by side or inline, the words that changed marked (see the top of this file) */
  thimble.diff = function (opts) {
    var d = new Diff(opts || {})
    return {
      /** another pair or patch, or other options, drawn at once: {before, after, patch, mode, context, titles, ref}; the
       *  folds close. Two texts draw in place of a patch, and a patch in place of two texts */
      set: function (o) {
        o = o || {}
        if ('before' in o) d.before = o.before
        if ('after' in o) d.after = o.after
        if ('patch' in o) d.patch = o.patch != null ? String(o.patch) : null
        else if ('before' in o || 'after' in o) d.patch = null
        if ('mode' in o) d.mode = o.mode === 'split' || o.mode === 'inline' ? o.mode : 'auto'
        if ('context' in o && Number(o.context) >= 0) d.context = Math.floor(Number(o.context))
        if ('titles' in o) d.titles = Array.isArray(o.titles) ? o.titles : null
        if ('ref' in o) d.ref = o.ref != null ? String(o.ref) : null
        if ('before' in o || 'after' in o || 'patch' in o || 'context' in o) d.opened = {}
        d.draw()
      },
      /** every fold opened (true) or folded again (false) */
      expand: function (on) {
        var fs = d.mount ? d.mount.querySelectorAll('[data-fold]') : []
        for (var i = 0; i < fs.length; i++) d.toggle(Number(fs[i].getAttribute('data-fold')), on !== false)
      },
      /** the mode drawn, 'split' or 'inline' */
      get mode() {
        return d.shown || null
      },
      /** the lines added and removed (a changed line counts in both), and the stretches of changes */
      get added() {
        return d.added || 0
      },
      get removed() {
        return d.removed || 0
      },
      get changes() {
        return d.changes || 0
      },
    }
  }
})()
