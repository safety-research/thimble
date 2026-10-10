// thimble's search for a view's page, part of the view kit: views.frame_document loads it after viewer_transcript.js and
// before viewer_range.js; viewer_kit.css styles it. It is the find of Files' reader (frontend/src/files/FindBar.tsx,
// find.ts) as a box in the view's top row:
//
//   const search = thimble.search({ mount: '#search', in: '#list', placeholder: 'Search messages' })
//
// Typing finds the text, case ignored, in the records under `in` (the page by default): every match on screen gets the
// find's wash (::highlight(thimble-search)), the current one a stronger one, and the box says "3 of 120". Enter or ↓
// goes to the next match, ⇧Enter or ↑ to the one before, wrapping at the ends; ⌘F or Ctrl+F puts the focus in the box;
// Escape empties it. Typing goes to the first match at or after the top of what the list shows, as Files' find does.
// The list's strip (viewer_colour.js) gets a lane of ticks in the ink at its left, one per match, like cue points, and
// a click on a tick goes to that match; the loupe marks the records that hold one. Without Color by the list gets the
// kit's strip with that lane alone.
//
// A list that draws only the rows in view, such as thimble.table, gives the search every row's text instead:
// search.rows({texts, refs, go, box}), each row's text as drawn ('\n' between parts drawn apart, such as cells), go(i) to
// bring row i into view, and the box that scrolls; the rows on the page carry data-thimble-row="<i>". A part that folds
// text away, such as thimble.diff, thimble.transcript and thimble.record, keeps it in the page in an element with
// data-thimble-fold, hidden: the search counts what it holds, ticks it where the fold stands, and sends the element a
// `thimble-unfold` event when it goes to a match inside it, so the part opens it. A fold may hold another: the event goes
// to the innermost one folded around the match, and again while the match stays folded, so a part may open one level at
// a time. A match that a box cuts from view by its size (its overflow hidden, such as a long block whose height is cut to
// six lines) sends that box the same event. Reset empties the box. The search hides nothing: search.has(text) tells a
// page that wants to filter by it. It reads the page's text once, a slice at a time from when the box gets the focus,
// and then only the elements the page changes, so the first search over a long transcript is quick and a key never
// waits on it.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var shared = kit.shared
  var ctl = shared.controls
  var esc = shared.esc
  var num = shared.num

  var HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function'
  var WAIT_MS = 120 // ms after the last key before the search runs
  var BIG = 20000 // rows past which a search of rows waits as long again, so typing stays quick
  var MOST = 20000 // matches found at most; the count says "+" past them, as Files' find does
  var SLICE_MS = 12 // ms of reading the page's text before the browser takes its turn, so typing goes on
  var READS = 3 // times a page that keeps changing is read again from the start a slice at a time, then at once
  var UNITS = 64 // elements the page changed that the index reads again, past which it reads the page again whole
  // the kit's own controls, the lanes' and the tree's groups (the tree has its own find), the page's own wording around
  // its records (data-thimble-chrome, as the bridge reads it) and its action buttons (.btn, such as Show more), whose
  // text is no record's
  var SKIP = '.thimble-part,.thimble-colour-mount,.thimble-colour-menu,.thimble-search,.thimble-tip,.thimble-colour-strip,' +
    '.thimble-colour-loupe,.thimble-colour-bracket,.thimble-range-mount,.thimble-axis,.thimble-lanes,.thimble-tree,[data-thimble-chrome]:not([data-anchor]),' +
    '.btn,script,style,template,noscript,textarea,select,input,option,svg'
  // the elements text runs on inside, so a phrase across them is found; any other element ends a run
  var INLINE = { SPAN: 1, B: 1, I: 1, EM: 1, STRONG: 1, A: 1, CODE: 1, MARK: 1, SMALL: 1, SUB: 1, SUP: 1, S: 1, DEL: 1, INS: 1, U: 1, TIME: 1, ABBR: 1, Q: 1, CITE: 1, KBD: 1, VAR: 1, SAMP: 1, LABEL: 1, FONT: 1, BDI: 1, BDO: 1, DFN: 1, WBR: 1 }
  var FOLD = 'data-thimble-fold'
  var DROP = 'data-thimble-drop'
  var UNFOLD_MAX = 32 // the times going to a match sends `thimble-unfold` at most, one fold level each
  var ICON = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  }
  function ico(name, cls) {
    return '<svg class="thimble-colour-ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + ICON[name] + '</svg>'
  }
  // a text in lower case with the same length, so offsets in it are offsets in the text
  function lower(s) {
    var low = s.toLowerCase()
    if (low.length === s.length) return low
    var out = ''
    for (var i = 0; i < s.length; i++) {
      var c = s[i].toLowerCase()
      out += c.length === 1 ? c : s[i]
    }
    return out
  }
  // each place `needle` (in lower case) shows in `low`, as [start, end]
  function places(low, needle) {
    var out = []
    if (!needle) return out
    var at = low.indexOf(needle)
    while (at >= 0) {
      out.push([at, at + needle.length])
      at = low.indexOf(needle, at + needle.length)
    }
    return out
  }
  // the fold a text is in: the innermost element with data-thimble-fold around it that is hidden, else the innermost one,
  // else null; a fold may hold another, such as a folded turn holding a long block's folded lines
  function foldOf(el) {
    var first = null
    for (var e = el; e && e.nodeType === 1; e = e.parentElement)
      if (e.hasAttribute(FOLD)) {
        if (e.hidden) return e
        if (!first) first = e
      }
    return first
  }
  var now = typeof performance !== 'undefined' && performance.now ? function () { return performance.now() } : Date.now
  // The runs of text under `root` in document order, each the text nodes that run on inside one element (through inline
  // elements such as a span or a link, so a phrase across them is found): {nodes, folds, folded, text, low, block, cv},
  // `folds` each node's fold as foldOf gives it, `folded` whether any has one, `low` the text in lower case, `cv` the
  // element around it whose content a list may leave unrendered (content-visibility), such as a turn. The kit's
  // controls and hidden elements (a fold's text apart) are left out. An element's style tells whether it shows, not its
  // boxes, which in a list that draws its rows as they come into view (content-visibility) would lay out every row; and
  // inside a turn or a message of the kit's own lists, which such a list may leave unrendered and whose styles hide
  // nothing in it, its `hidden` attribute and its own style attribute alone tell, since reading the style of each element
  // there would compute it: seconds over a long transcript. A page's own rows are read by their styles, which may hide a
  // part of a row, such as a cell a narrow layout leaves out. The search reads the page once into an index and finds in
  // it, reading again only the elements the page changes (patch); step(ms) reads it a slice at a time, so a long page is
  // read without holding up typing.
  function Index(root) {
    var self = this
    this.root = root
    this.runs = []
    this.done = !root
    this.last = null
    this.parent = null
    this.fold = null
    this.light = null // the kit's turn or message whose elements are read by attribute
    this.cv = null // the element with content-visibility the walk is in
    if (root)
      this.walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          return self.accept(n)
        },
      })
  }
  Index.prototype.accept = function (n) {
    if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT
    if (n.matches(SKIP)) return NodeFilter.FILTER_REJECT
    if (this.light && !this.light.contains(n)) this.light = null
    if (this.cv && !this.cv.contains(n)) this.cv = null
    if (n.hasAttribute(FOLD)) return NodeFilter.FILTER_SKIP
    // hidden, or hidden by the label filter (viewer_bridge.js data-thimble-drop)
    if (n.hidden || n.getAttribute(DROP) === 'hide') return NodeFilter.FILTER_REJECT
    if (this.light) return n.style.display === 'none' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
    var cs = getComputedStyle(n)
    if (cs.display === 'none') return NodeFilter.FILTER_REJECT
    if (cs.contentVisibility && cs.contentVisibility !== 'visible') {
      this.cv = n
      if (n.classList.contains('thimble-turn') || n.classList.contains('thimble-msg')) this.light = n
    }
    return NodeFilter.FILTER_SKIP
  }
  // read on for about `ms` milliseconds (to the end with Infinity); true once the whole page is read
  Index.prototype.step = function (ms) {
    if (this.done) return true
    var end = now() + ms
    for (var k = 1, n = this.walker.nextNode(); n; n = this.walker.nextNode(), k++) {
      this.add(n)
      if ((k & 255) === 0 && now() > end) return false
    }
    if (this.last) this.last.low = lower(this.last.text)
    this.done = true
    return true
  }
  Index.prototype.add = function (n) {
    var v = n.nodeValue
    if (!v) return
    if (n.parentElement !== this.parent) {
      this.parent = n.parentElement
      this.fold = foldOf(this.parent)
    }
    var block = this.parent
    while (block && block !== this.root && INLINE[block.tagName]) block = block.parentElement
    var last = this.last
    if (!last || last.block !== block) {
      if (last) last.low = lower(last.text)
      if (this.cv && !this.cv.contains(n)) this.cv = null
      last = this.last = { nodes: [], folds: [], folded: false, text: '', low: '', block: block, cv: this.cv }
      this.runs.push(last)
    }
    last.nodes.push(n)
    last.folds.push(this.fold)
    if (this.fold) last.folded = true
    last.text += v
  }
  // The index brought up to date with the elements the page changed since it was read (`units`, each read again whole),
  // rather than read again whole: the runs in an element the page took away or in a unit go, and each unit's runs are
  // read again in its place. A unit's elements are read as the whole read would reach them, from the kit's turns, the
  // elements with content-visibility and the hidden elements around it. False when it cannot be, so the page is read
  // again whole.
  Index.prototype.patch = function (units) {
    var root = this.root
    var us = []
    for (var i = 0; i < units.length; i++) {
      var u = units[i]
      if (!u.isConnected) continue
      if (u === root || !root.contains(u)) return false
      if (us.indexOf(u) < 0) us.push(u)
    }
    // a unit inside another is read with it
    us = us.filter(function (u) {
      for (var k = 0; k < us.length; k++) if (us[k] !== u && us[k].contains(u)) return false
      return true
    })
    this.runs = this.runs.filter(function (r) {
      if (!r.block || !r.block.isConnected) return false
      for (var k = 0; k < us.length; k++) if (us[k].contains(r.block)) return false
      return true
    })
    for (var j = 0; j < us.length; j++) {
      var got = readUnit(us[j], root)
      if (!got.length) continue
      // the first run after the unit in the page's order
      var lo = 0
      var hi = this.runs.length
      while (lo < hi) {
        var mid = (lo + hi) >> 1
        if (us[j].compareDocumentPosition(this.runs[mid].nodes[0]) & Node.DOCUMENT_POSITION_FOLLOWING) hi = mid
        else lo = mid + 1
      }
      this.runs.splice.apply(this.runs, [lo, 0].concat(got))
    }
    return true
  }
  // the runs of one element under `root`, read as the whole read reaches it: none when an element around it, or the
  // element itself, is left out
  function readUnit(u, root) {
    var x = new Index(u)
    var chain = []
    for (var e = u.parentElement; e && e !== root; e = e.parentElement) chain.push(e)
    for (var c = chain.length - 1; c >= 0; c--) if (x.accept(chain[c]) === NodeFilter.FILTER_REJECT) return []
    if (x.accept(u) === NodeFilter.FILTER_REJECT) return []
    x.step(Infinity)
    return x.runs
  }
  // the element a change of `n` is read again in: the element itself, or for text and an inline element, such as a
  // link, the block its text runs in
  function unitOf(n, root) {
    var e = n && (n.nodeType === 1 ? n : n.parentElement)
    while (e && e !== root && INLINE[e.tagName]) e = e.parentElement
    return e
  }
  // whether an element shows: neither it nor an element around it hidden or not displayed
  function shows(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) if (e.hidden || getComputedStyle(e).display === 'none') return false
    return true
  }
  // whether a node is text, or an inline element, that runs on with the text beside it
  function runsOn(n) {
    return !!n && (n.nodeType === 3 ? /\S/.test(n.nodeValue) : n.nodeType === 1 && !!INLINE[n.tagName])
  }
  // the runs under `root`, read at once
  function runs(root) {
    var x = new Index(root)
    x.step(Infinity)
    return x.runs
  }
  // the fold a match from character `a` to `b` of `run` is in: that of the first text it covers in a hidden fold, so a
  // phrase across a fold's edge opens the fold, else that of its first text, else null
  function foldAt(run, a, b) {
    if (!run.folded) return null
    var first
    for (var i = 0, at = 0; i < run.nodes.length && at < b; i++) {
      var len = run.nodes[i].nodeValue.length
      if (at + len > a) {
        var f = run.folds[i]
        if (f && f.hidden) return f
        if (first === undefined) first = f
      }
      at += len
    }
    return first || null
  }
  // `el`, or where a list leaves it unlaid out of view (content-visibility: auto) the nearest element around it that is
  // laid out; `el` itself where the browser cannot tell
  function laidOut(el) {
    if (!el || typeof el.checkVisibility !== 'function' || el.checkVisibility({ contentVisibilityAuto: true }) || !el.checkVisibility()) return el
    for (var e = el.parentElement; e; e = e.parentElement) if (e.checkVisibility({ contentVisibilityAuto: true })) return e
    return el
  }
  // The box that cuts a range from view by its size, such as a long block whose height is cut to six lines: the innermost
  // element around it whose overflow is hidden or clipped and whose box the range runs past, inside the box it scrolls
  // in; null where none does
  function clipOf(r) {
    var rect = r && typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect() : null
    if (!rect || (!rect.width && !rect.height)) return null
    var n = r.startContainer
    for (var e = n.nodeType === 1 ? n : n.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      var cs = getComputedStyle(e)
      if (/(auto|scroll|overlay)/.test(cs.overflowY)) return null
      if (!/(hidden|clip)/.test(cs.overflowY + ' ' + cs.overflowX)) continue
      var c = e.getBoundingClientRect()
      if (rect.top < c.top - 1 || rect.bottom > c.bottom + 1 || rect.left < c.left - 1 || rect.right > c.right + 1) return e
    }
    return null
  }
  // a range over `run` from character `a` to `b`
  function rangeIn(run, a, b) {
    var r = document.createRange()
    var at = 0
    var startSet = false
    for (var i = 0; i < run.nodes.length; i++) {
      var node = run.nodes[i]
      var len = node.nodeValue.length
      if (!startSet && a < at + len) {
        r.setStart(node, a - at)
        startSet = true
      }
      if (startSet && b <= at + len) {
        r.setEnd(node, b - at)
        return r
      }
      at += len
    }
    return startSet ? r : null
  }
  function scrolls(el) {
    var cs = getComputedStyle(el)
    return /(auto|scroll|overlay)/.test(cs.overflowY || cs.overflow || '')
  }
  // the box a list scrolls in: `el` itself, else the nearest box around it that scrolls, else the page (true)
  function scrollerOf(el) {
    for (var a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) if (scrolls(a)) return a
    return true
  }
  // scrolls every box around `rect`'s element so that it shows, in the middle when it was out of view
  function bringIntoView(node, rect) {
    var start = node && (node.nodeType === 1 ? node : node.parentElement)
    if (!start || !rect) return
    var box = rect()
    for (var a = start.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (!scrolls(a) || a.scrollHeight <= a.clientHeight) continue
      var c = a.getBoundingClientRect()
      if (box.top < c.top + 4 || box.bottom > c.bottom - 4) a.scrollTop += box.top - c.top - (c.height - box.height) / 2
      box = rect()
    }
    if (box.top < 0 || box.bottom > innerHeight) window.scrollBy(0, box.top - (innerHeight - box.height) / 2)
  }

  var all = [] // every search of the page, for ⌘F

  function Search(opts) {
    var self = this
    this.mount = ctl.el(opts.mount)
    // a search made again on the same mount takes its place: the one before finds nothing more
    for (var i = all.length - 1; i >= 0; i--) if (this.mount && all[i].mount === this.mount) all.splice(i, 1)[0].retire()
    this.within = opts.in || null
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null
    this.text = ''
    this.needle = ''
    this.matches = [] // {range, run, fold, row, k, rec}: a DOM match, or with `row` a match in a row of `source`
    this.at = -1
    this.key = null // what the current match is, to find it again once the page draws again: [record, k]
    this.source = null // {texts, low, go, box}: the rows of a list that draws only those in view, the one of `sources` that shows
    this.sources = [] // every list's rows (rows), by its box
    this.more = false // more matches than MOST
    this.timer = null
    this.frame = null
    this.marked = null // the box whose strip has the ticks
    this.idx = null // the page's text as the search last read it (Index), read again once the page changed (stale)
    this.stale = true
    this.units = [] // the elements the page changed since the index was read, read again before the next search
    this.gone = false // and whether it took elements away
    this.reading = null // the timer of the next slice of an index read a slice at a time (prepare)
    this.waiting = false // a search waits for that index
    this.last = null // the last search of the page's text, {idx, needle, hit}: `hit` the runs that hold its needle
    this.sized = null // the ResizeObserver of the root's width
    if (this.mount) {
      this.mount.classList.add('thimble-search-mount', 'thimble-part')
      this.mount.setAttribute('data-thimble-chrome', '')
      this.mount.innerHTML =
        '<span class="thimble-search" role="search">' + ico('search', 'thimble-search-glyph') +
        '<input class="thimble-search-input" type="text" spellcheck="false" autocomplete="off" placeholder="' + esc(opts.placeholder || 'Search') + '" aria-label="' + esc(opts.placeholder || 'Search') + '">' +
        '<span class="thimble-search-count" aria-live="polite"></span>' +
        '<button type="button" class="btn btn-ghost btn-sm btn-square thimble-search-step" data-step="-1" title="Previous match (⇧Enter)" aria-label="Previous match" hidden>' + ico('up') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-sm btn-square thimble-search-step" data-step="1" title="Next match (Enter)" aria-label="Next match" hidden>' + ico('down') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-sm btn-square thimble-search-clear" title="Clear" aria-label="Clear the search" hidden>' + ico('x') + '</button>' +
        '</span>'
      this.input = this.mount.querySelector('input')
      this.countEl = this.mount.querySelector('.thimble-search-count')
      this.steps = this.mount.querySelectorAll('.thimble-search-step')
      this.clearEl = this.mount.querySelector('.thimble-search-clear')
      this.input.addEventListener('input', function () {
        self.typed()
      })
      // the page's text read while the analyst gets ready to type, so the first search finds at once
      this.input.addEventListener('focus', function () {
        self.prepare()
      })
      this.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          self.now()
          self.step(e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          if (self.input.value) self.set('')
          else self.input.blur()
        }
      })
      this.mount.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('button')
        if (!b) return
        if (b.classList.contains('thimble-search-clear')) {
          self.set('')
          self.input.focus()
        } else if (b.hasAttribute('data-step')) {
          self.now()
          self.step(Number(b.getAttribute('data-step')))
        }
      })
    }
    // the page drawn again: read again for the next search, and the matches found again in a frame, the current one kept
    // where it still shows. A class or a style changed, such as a tab shown, only has the page read again
    this.observer = new MutationObserver(function (records) {
      self.heard(records)
    })
    this.observe()
    // Reset empties the box
    this.checkReset = shared.part({
      changed: function () {
        return !self.dead && !!self.text
      },
      reset: function () {
        self.set('', true)
      },
      fire: function () {
        self.tell()
      },
    })
    all.push(this)
    // a strip on the list from the start, so the list's width does not change when the first match is found
    var box = this.box()
    if (box && box !== true) shared.strip(box)
  }
  Search.prototype.retire = function () {
    this.dead = true
    this.observer.disconnect()
    if (this.sized) this.sized.disconnect()
    clearTimeout(this.timer)
    this.timer = null
    clearTimeout(this.reading)
    this.reading = null
    this.idx = null
    // its washes and its ticks go with it
    if (HL && this.needle) {
      CSS.highlights.delete('thimble-search')
      CSS.highlights.delete('thimble-search-current')
    }
    var strip = this.marked ? shared.strip(this.marked) : null
    if (strip) strip.marks(null)
    this.marked = null
  }
  // the element the search finds in
  Search.prototype.root = function () {
    if (this.source && this.source.box) return this.source.box
    return (this.within && ctl.el(this.within)) || document.body
  }
  // the box whose strip gets the ticks: the rows' box, else the box `in` scrolls in
  Search.prototype.box = function () {
    if (this.source) return this.source.box || null
    var r = this.within ? ctl.el(this.within) : null
    return r ? scrollerOf(r) : true
  }
  Search.prototype.observe = function () {
    var r = this.root()
    if (r === this.observed) return
    var self = this
    this.observer.disconnect()
    if (this.sized) this.sized.disconnect()
    this.observed = r
    if (!r) return
    // `hidden` too: a fold opened or closed (the diff's Show more), an element the label filter hides; and a class or a
    // style, which may show or hide an element, such as a tab
    this.observer.observe(r, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['hidden', DROP, 'class', 'style'] })
    // and on the elements around it, whose class or style may hide a part of each record by the page's styles, such as
    // a mode that leaves out the tool calls
    for (var up = r.parentElement; up; up = up.parentElement) this.observer.observe(up, { attributes: true, attributeOldValue: true, attributeFilter: ['hidden', 'class', 'style'] })
    // a new width may show or hide a part of each record by the page's styles (a media or container query, such as a
    // narrow layout's cells): the page read again for the next search
    if (typeof ResizeObserver === 'function') {
      var width = null
      this.sized = new ResizeObserver(function (es) {
        var w = es[es.length - 1].contentRect.width
        if (width != null && w !== width) self.stale = true
        width = w
      })
      this.sized.observe(r)
    }
  }
  // the page's changes the observer heard: any that can change what the search finds has its elements read again
  // (note), and one other than a class or a style, or a class or a style on an element that holds records, such as a
  // tab, finds the matches again in a frame
  Search.prototype.heard = function (records) {
    var again = false
    for (var i = 0; i < records.length; i++) {
      var r = records[i]
      if (!this.counts(r)) continue
      this.note(r)
      if (r.type !== 'attributes' || r.attributeName === 'hidden' || r.attributeName === DROP || this.holds(r.target)) again = true
    }
    if (again && this.needle) this.soon()
  }
  // whether an element holds records or a list's rows, outside any record, so that a class or a style that shows or hides
  // it, such as a tab's, finds the matches again; a class on a record, such as the chosen row's, does not
  Search.prototype.holds = function (t) {
    if (!t || t.nodeType !== 1 || t.closest('[data-anchor]')) return false
    if (t.querySelector('[data-anchor]')) return true
    for (var i = 0; i < this.sources.length; i++) if (this.sources[i].box && t.contains(this.sources[i].box)) return true
    return false
  }
  // A change the index must take: the elements it touched to be read again before the next search, or the page read
  // again whole while it is being read, for a change of the root itself or of an element around it, or past UNITS
  // elements, as when a page draws its list again
  Search.prototype.note = function (r) {
    if (this.stale) return
    var root = this.idx && this.idx.root
    if (!root || !this.idx.done || this.units.length > UNITS || (r.type === 'attributes' && r.target.contains(root))) {
      this.stale = true
      return
    }
    var add = []
    if (r.type === 'childList') {
      var inline = false
      for (var a = 0; a < r.addedNodes.length; a++) {
        var n = r.addedNodes[a]
        if (n.nodeType === 1 && !INLINE[n.tagName]) add.push(n)
        else inline = true
      }
      for (var d = 0; d < r.removedNodes.length; d++)
        if (r.removedNodes[d].nodeType !== 1 || INLINE[r.removedNodes[d].tagName]) inline = true
        else this.gone = true
      // text that runs on in the element the change is in, or a block put in or taken out beside such text, which
      // splits its run or joins two: that element read again
      if (inline || runsOn(r.previousSibling) || runsOn(r.nextSibling)) add.push(unitOf(r.target, root))
    } else add.push(unitOf(r.target, root))
    for (var k = 0; k < add.length; k++) {
      if (!add[k] || add[k] === root) {
        this.stale = true
        return
      }
      this.units.push(add[k])
    }
    if (this.units.length > UNITS) this.stale = true
  }
  // whether a change of the page can change what the search finds: one outside the kit's own parts, and of a class or a
  // style one that may show or hide what it is on
  Search.prototype.counts = function (rec) {
    var t = rec.target
    var e = t && (t.nodeType === 1 ? t : t.parentElement)
    if (e && e.closest && e.closest(SKIP)) return false
    if (rec.type === 'attributes') return shared.showsOrHides(rec)
    if (rec.type !== 'childList') return true
    var nodes = [].slice.call(rec.addedNodes).concat([].slice.call(rec.removedNodes))
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      if (n.nodeType === 3 || (n.nodeType === 1 && !n.matches(SKIP + ',[data-thimble]'))) return true
    }
    return false
  }
  Search.prototype.typed = function () {
    var self = this
    this.prepare()
    clearTimeout(this.timer)
    var wait = this.source && this.source.texts.length > BIG ? 2 * WAIT_MS : WAIT_MS
    this.timer = setTimeout(function () {
      self.timer = null
      if (!self.dead) self.run(true)
    }, wait)
    this.chrome()
  }
  // the search run now for what the box holds, if a key is still waiting
  Search.prototype.now = function () {
    if (this.timer == null) return
    clearTimeout(this.timer)
    this.timer = null
    this.run(true)
  }
  // the page drew again: its matches found again in the next frame; a list of rows only draws other rows, whose matches
  // the search knows, so they are only highlighted, unless another list shows now, such as a tab's
  Search.prototype.soon = function () {
    var self = this
    if (this.frame != null) return
    var go = function () {
      self.frame = null
      if (self.dead) return
      var was = self.source
      self.pick()
      if (self.source && self.source === was) self.paint()
      else self.find(false)
    }
    this.frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(go) : setTimeout(go, 16)
  }
  // The page's text read into the index a slice at a time, SLICE_MS each, so typing goes on while a long page is read;
  // a search that waits for it runs once it is read. A page that changes while it is read is read again from the start,
  // and after READS starts the rest is read at once.
  Search.prototype.prepare = function () {
    if (this.dead) return
    this.pick()
    if (this.source || this.reading != null) return
    var self = this
    var starts = 0
    var slice = function () {
      self.reading = null
      if (self.dead || self.source) return
      if (self.stale || !self.idx || self.idx.root !== self.root()) {
        self.fresh()
        starts++
      }
      if (!self.idx.step(starts > READS ? Infinity : SLICE_MS)) {
        self.reading = setTimeout(slice, 0)
        return
      }
      if (self.waiting) {
        self.waiting = false
        self.run(true)
      }
    }
    if (!this.upToDate()) this.reading = setTimeout(slice, 0)
  }
  // whether the index is read whole and current, once brought up to date with the elements the page changed since
  Search.prototype.upToDate = function () {
    // the changes the observer has not told yet, such as the page's own just before it calls set or refresh
    var rs = this.observer.takeRecords()
    for (var i = 0; i < rs.length; i++) if (this.counts(rs[i])) this.note(rs[i])
    if (this.stale || !this.idx || !this.idx.done || this.idx.root !== this.root()) return false
    if (!this.units.length && !this.gone) return true
    var ok = this.idx.patch(this.units)
    this.units = []
    this.gone = false
    this.last = null
    if (!ok) this.stale = true
    return ok
  }
  // a new index, to be read from the start
  Search.prototype.fresh = function () {
    this.idx = new Index(this.root())
    this.stale = false
    this.units = []
    this.gone = false
    this.last = null
  }
  // the page's text as an index, current: read at once where it is not read yet, brought up to date with the elements
  // the page changed since, or read again whole when they are many
  Search.prototype.index = function () {
    if (this.upToDate()) return this.idx
    if (this.stale || !this.idx || this.idx.root !== this.root()) this.fresh()
    this.idx.step(Infinity)
    return this.idx
  }
  // whether a search must wait for the index being read a slice at a time
  Search.prototype.unread = function () {
    return !this.source && this.reading != null && !!(this.input && this.input.value)
  }
  // the text changed: found, the first match at or after the top of the list made the current one, and the page told
  Search.prototype.run = function (go) {
    if (go && this.unread()) {
      this.waiting = true
      return
    }
    var text = this.input ? this.input.value : this.text
    var changed = text !== this.text
    this.text = text
    this.needle = lower(text)
    this.key = null
    this.at = -1
    this.find(go)
    if (changed) this.tell()
  }
  // the page told of the text, and Reset of whether it shows
  Search.prototype.tell = function () {
    var self = this
    if (this.checkReset) this.checkReset()
    if (this.onChange) ctl.safe(function () { self.onChange(self.api) })
  }
  // The matches found again: in the rows of `source`, or in the page's text under `root`. The current match is the one
  // the key names when it still shows, else with `go` the first at or after the top of the list, which is brought into
  // view; then the highlights, the count and the strip's ticks.
  Search.prototype.find = function (go) {
    if (this.dead) return
    this.pick()
    this.observe()
    var out = []
    var needle = this.needle
    if (needle) {
      if (this.source) {
        var low = this.source.low
        var ids = this.source.ids
        for (var i = 0; i < low.length && out.length < MOST; i++) {
          var ps = places(low[i], needle)
          for (var k = 0; k < ps.length && out.length < MOST; k++) out.push({ row: i, k: k, rec: ids && ids[i] != null ? ids[i] : i })
        }
      } else {
        var idx = this.index()
        var rs = idx.runs
        // a needle that holds the last one is only in the runs that held that one, so typing on searches fewer
        var last = this.last
        var from = last && last.idx === idx && needle.indexOf(last.needle) >= 0 ? last.hit : null
        var hit = []
        var perRec = new Map()
        for (var f = 0, nf = from ? from.length : rs.length; f < nf; f++) {
          var j = from ? from[f] : f
          var run = rs[j]
          if (run.low.indexOf(needle) < 0) continue
          hit.push(j)
          if (out.length >= MOST) continue
          var hits = places(run.low, needle)
          // the record it is in: its anchored element, known again by its ref once the page draws it again
          if (run.rec === undefined) {
            var el = (run.block && run.block.closest && run.block.closest('[data-anchor]')) || run.block
            run.rec = el && el.getAttribute && el.getAttribute('data-anchor') ? el.getAttribute('data-anchor') : el
          }
          var rec = run.rec
          for (var h = 0; h < hits.length && out.length < MOST; h++) {
            var kk = perRec.get(rec) || 0
            perRec.set(rec, kk + 1)
            out.push({ run: run, a: hits[h][0], b: hits[h][1], fold: foldAt(run, hits[h][0], hits[h][1]), rec: rec, k: kk })
          }
        }
        this.last = { idx: idx, needle: needle, hit: hit }
      }
    }
    this.more = out.length >= MOST
    this.matches = out
    this.at = -1
    if (this.key) {
      for (var m = 0; m < out.length; m++) if (out[m].rec === this.key[0] && out[m].k === this.key[1]) this.at = m
    }
    var ticks = this.ticks()
    if (this.at < 0 && out.length && (go || this.key)) this.at = this.firstFrom(ticks)
    this.paint()
    this.chrome()
    this.mark(ticks)
    // the match typing goes to is brought into view, its fold opened
    if (go && this.at >= 0) this.go(this.at)
  }
  // each match's [top, bottom] as fractions of its box's height: a row's place among the rows, a DOM match's (or its
  // fold's) place in the box it scrolls in
  Search.prototype.ticks = function () {
    var ms = this.matches
    var out = []
    if (this.source) {
      var n = Math.max(1, this.source.texts.length)
      for (var i = 0; i < ms.length; i++) out.push([ms[i].row / n, (ms[i].row + 1) / n])
      return out
    }
    var box = this.box()
    var page = box === true
    var el = page ? document.scrollingElement || document.documentElement : box
    var H = Math.max(1, el.scrollHeight)
    var top0 = page ? -window.scrollY : el.getBoundingClientRect().top + el.clientTop - el.scrollTop
    var places = new Map() // an element that stands for matches, measured once for all of them
    for (var j = 0; j < ms.length; j++) {
      var r = this.rectOf(ms[j], places)
      out.push(r ? [(r.top - top0) / H, (r.bottom - top0) / H] : [0, 0])
    }
    return out
  }
  // Where a match stands on the screen: its range's box, within its block's, so that one its block cuts from view by its
  // size (a long block's height cut to six lines) stands at the block's edge; for one in a folded fold the place of the
  // outermost fold folded around it, the element before it or, in a line of text, its block; and for one in a row a list
  // leaves unlaid out of view (content-visibility: auto), the row's box, since measuring the text would lay the row out,
  // one row at a time. A match in an element whose content such a list may leave unrendered, such as a turn, stands at
  // that element's box, which the browser lays out without its content: asking where its text is would lay out every
  // turn, again for each match. `places` keeps each element measured for the next match.
  Search.prototype.rectOf = function (m, places) {
    var place = function (el) {
      if (places && places.has(el)) return places.get(el)
      var p = el.getBoundingClientRect()
      if (places) places.set(el, p)
      return p
    }
    if (m.run && m.run.cv && m.run.cv.isConnected) return place(m.run.cv)
    var at
    if (m.fold && m.fold.hidden) {
      var f = m.fold
      for (var up = f.parentElement; up; up = up.parentElement) if (up.hidden && up.hasAttribute(FOLD)) f = up
      // a fold in a line of text, such as a long block's lines past the sixth, stands in its block; any other at the
      // nearest element before it that shows, such as the row before a table's rows folded one by one, found by the
      // hidden attribute alone so that no box is laid out
      at = INLINE[f.tagName] ? f.parentElement : f.previousElementSibling || f.parentElement
      while (at && at.hidden) at = at.previousElementSibling || at.parentElement
      at = laidOut(at)
    } else {
      if (!m.run) return null
      at = laidOut(m.run.block)
      if (at === m.run.block) {
        if (m.range === undefined) m.range = rangeIn(m.run, m.a, m.b)
        var r = m.range && typeof m.range.getBoundingClientRect === 'function' ? m.range.getBoundingClientRect() : null
        var b = r && at ? place(at) : null
        if (!b || (!b.width && !b.height) || (r.top >= b.top && r.bottom <= b.bottom)) return r
        var top = Math.min(Math.max(r.top, b.top), b.bottom)
        return { top: top, bottom: Math.max(top, Math.min(r.bottom, b.bottom)) }
      }
    }
    return at ? place(at) : null
  }
  // the first match at or after the top of what the list shows, as Files' find; the first of all past the last
  Search.prototype.firstFrom = function (ticks) {
    var box = this.box()
    var from = 0
    if (box === true) from = window.scrollY / Math.max(1, (document.scrollingElement || document.documentElement).scrollHeight)
    else if (box) from = box.scrollTop / Math.max(1, box.scrollHeight)
    for (var i = 0; i < ticks.length; i++) if (ticks[i][0] >= from - 1e-6) return i
    return ticks.length ? 0 : -1
  }
  // the ticks on the box's strip, and none on a box that had them before
  Search.prototype.mark = function (ticks) {
    var self = this
    var box = this.matches.length ? this.box() : null
    if (box === true && document.documentElement.scrollHeight <= innerHeight) box = null
    if (this.marked && this.marked !== box) {
      var old = shared.strip(this.marked)
      if (old) old.marks(null)
    }
    this.marked = box
    if (!box) return
    var strip = shared.strip(box)
    if (!strip) return
    // the records that hold a match, for the loupe's cell: a row by its place, an element by its ref or itself
    var rows = new Set()
    var recs = new Set()
    for (var i = 0; i < this.matches.length; i++) {
      var m = this.matches[i]
      if (m.row != null) rows.add(m.row)
      else recs.add(m.rec)
    }
    strip.marks({
      name: '“' + this.text + '”',
      ticks: ticks,
      has: function (t) {
        if (typeof t === 'number') return rows.has(t)
        if (!t || t.nodeType !== 1) return false
        return recs.has(t) || recs.has(t.getAttribute('data-anchor'))
      },
      go: function (k) {
        self.go(k)
      },
    })
  }
  // the find's wash on every match on the page, the stronger one on the current match
  Search.prototype.paint = function () {
    if (!HL) return
    var all = []
    var cur = null
    var cm = this.matches[this.at] || null
    if (this.source) {
      // the rows on the page: their matches in order, the k-th of a row its k-th match in the source
      var root = this.root()
      var rows = root ? root.querySelectorAll('[data-thimble-row]') : []
      for (var i = 0; i < rows.length; i++) {
        var row = Number(rows[i].getAttribute('data-thimble-row'))
        var rs = runs(rows[i])
        var k = 0
        for (var j = 0; j < rs.length; j++) {
          var hits = places(rs[j].low, this.needle)
          for (var h = 0; h < hits.length; h++, k++) {
            var r = rangeIn(rs[j], hits[h][0], hits[h][1])
            if (!r) continue
            if (cm && cm.row === row && cm.k === k) cur = r
            else all.push(r)
          }
        }
      }
    } else {
      for (var m = 0; m < this.matches.length; m++) {
        var mt = this.matches[m]
        if (mt.fold && mt.fold.hidden) continue
        if (mt.range === undefined) mt.range = rangeIn(mt.run, mt.a, mt.b)
        if (!mt.range) continue
        if (m === this.at) cur = mt.range
        else all.push(mt.range)
      }
    }
    var reg = CSS.highlights
    var hl = new Highlight()
    for (var a = 0; a < all.length; a++) hl.add(all[a])
    if (all.length) reg.set('thimble-search', hl)
    else reg.delete('thimble-search')
    if (cur) reg.set('thimble-search-current', new Highlight(cur))
    else reg.delete('thimble-search-current')
    this.current = cur
  }
  // the count, the step buttons and the clear button as the search stands
  Search.prototype.chrome = function () {
    if (!this.mount) return
    var typed = this.input.value
    var n = this.matches.length
    var waiting = this.timer != null
    this.countEl.textContent = !typed || waiting ? '' : !n ? 'No results' : (this.at >= 0 ? num(this.at + 1) + ' of ' : '') + num(n) + (this.more ? '+' : '')
    this.countEl.classList.toggle('thimble-search-none', !!typed && !waiting && !n)
    for (var i = 0; i < this.steps.length; i++) {
      this.steps[i].hidden = !typed
      this.steps[i].disabled = !n || waiting
    }
    this.clearEl.hidden = !typed
  }
  // the next match (dir 1) or the one before (-1), wrapping at the ends
  Search.prototype.step = function (dir) {
    var n = this.matches.length
    if (!n) return
    var k = this.at < 0 ? (dir > 0 ? this.firstFrom(this.ticks()) : n - 1) : (((this.at + dir) % n) + n) % n
    this.go(k)
  }
  Search.prototype.go = function (k) {
    if (this.dead || k < 0 || k >= this.matches.length) return
    this.at = k
    var m = this.matches[k]
    this.key = [m.rec, m.k]
    // a match in a fold, or cut from view by its box's size: the part that folded it opens it, and the matches are found
    // again in what it drew; a part that opens one level at a time, such as a record's nested values, is sent the event
    // again while the match stays folded
    var fold = this.closed(m)
    for (var tries = 0; fold && tries < UNFOLD_MAX; tries++) {
      fold.dispatchEvent(new CustomEvent('thimble-unfold', { bubbles: true }))
      // the page drew nothing again: no part opens it
      if (!this.changed()) break
      this.find(false)
      m = this.matches[this.at]
      // the match not found again, or the same fold around it: the part did not open it
      if (!m || m.rec !== this.key[0] || m.k !== this.key[1]) break
      var next = this.closed(m)
      if (next === fold) break
      fold = next
    }
    this.show(true)
  }
  // what keeps a match from view: the fold folded around it, else the box that cuts it from view by its size; null for
  // neither
  Search.prototype.closed = function (m) {
    if (!m || !m.run) return null
    if (m.fold && m.fold.hidden) return m.fold
    if (m.range === undefined) m.range = rangeIn(m.run, m.a, m.b)
    return clipOf(m.range)
  }
  // whether the page changed what the search finds since the observer last told, its changes taken from the observer
  Search.prototype.changed = function () {
    var rs = this.observer.takeRecords()
    var any = false
    for (var i = 0; i < rs.length; i++)
      if (this.counts(rs[i])) {
        this.note(rs[i])
        any = true
      }
    return any
  }
  // the current match brought into view and drawn as current
  Search.prototype.show = function (paint) {
    var m = this.matches[this.at]
    if (!m) return
    if (this.source) {
      var src = this.source
      ctl.safe(function () { src.go(m.row) })
      this.paint()
      var cur = this.current
      if (cur && typeof cur.getBoundingClientRect === 'function') bringIntoView(cur.startContainer, function () { return cur.getBoundingClientRect() })
    } else {
      if (paint) this.paint()
      if (m.range === undefined) m.range = rangeIn(m.run, m.a, m.b)
      var r = m.range
      if (r && typeof r.getBoundingClientRect === 'function') bringIntoView(r.startContainer, function () { return r.getBoundingClientRect() })
    }
    if (!HL && m.range && window.getSelection) {
      var sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(m.range)
    }
    this.chrome()
  }
  // the box's text set from the page; `quiet` leaves the page untold (Reset, which tells it once)
  Search.prototype.set = function (text, quiet) {
    text = text == null ? '' : String(text)
    if (this.input) this.input.value = text
    clearTimeout(this.timer)
    this.timer = null
    this.waiting = false
    var changed = text !== this.text
    this.text = text
    this.needle = lower(text)
    this.key = null
    this.at = -1
    this.find(!!text)
    if (changed && !quiet) this.tell()
  }
  // the rows of a list that draws only those in view, kept by its box, so that lists in tabs each give theirs; null takes
  // every list's away, for the page's text again
  Search.prototype.rows = function (src) {
    if (!src || !Array.isArray(src.texts)) {
      this.sources = []
    } else {
      var s = {
        texts: src.texts,
        low: src.texts.map(function (t) {
          return lower(t == null ? '' : String(t))
        }),
        ids: Array.isArray(src.refs) ? src.refs : null,
        go: typeof src.go === 'function' ? src.go : function () {},
        box: ctl.el(src.box) || null,
      }
      this.sources = this.sources.filter(function (x) {
        return x.box && x.box !== s.box
      })
      this.sources.push(s)
      if (s.box) shared.strip(s.box)
    }
    this.find(false)
  }
  // the list the search finds in: the one given last of those that show, such as the table of the tab in view; none
  // while none shows, so the search finds in the page's text
  Search.prototype.pick = function () {
    this.sources = this.sources.filter(function (s) {
      return !s.box || s.box.isConnected
    })
    var got = null
    for (var i = this.sources.length - 1; i >= 0 && !got; i--) if (!this.sources[i].box || shows(this.sources[i].box)) got = this.sources[i]
    this.source = got
  }

  // ⌘F or Ctrl+F in the view: the focus in the first search's box, its text chosen
  document.addEventListener(
    'keydown',
    function (e) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 'f') return
      for (var i = 0; i < all.length; i++) {
        var s = all[i]
        if (!s.input || !s.input.isConnected) continue
        e.preventDefault()
        s.input.focus()
        s.input.select()
        return
      }
    },
    true,
  )

  /** a box in the view's top row that finds text in the view's records (see the top of this file) */
  thimble.search = function (opts) {
    var s = new Search(opts || {})
    s.api = {
      /** the text searched for, '' for none */
      get text() {
        return s.text
      },
      /** how many matches there are (MOST at most, the count then saying "+"), and the current one's place among them
       *  from 0 (-1 for none) */
      get count() {
        return s.matches.length
      },
      get at() {
        return s.at
      },
      /** the box's text set from the page; the page is told as when the analyst types */
      set: function (text) {
        s.set(text)
      },
      /** the next match (1) or the one before (-1), and match `k` */
      step: function (dir) {
        s.now()
        s.step(dir < 0 ? -1 : 1)
      },
      go: function (k) {
        s.now()
        s.go(Number(k))
      },
      /** whether a text holds what is searched for, case ignored; true while nothing is */
      has: function (text) {
        return !s.needle || lower(String(text == null ? '' : text)).indexOf(s.needle) >= 0
      },
      /** a list that draws only the rows in view gives every row's text: {texts, refs, go(i), box}; null takes them
       *  away */
      rows: function (src) {
        s.rows(src)
        return s.api
      },
      /** found again now, for a change of the page the search cannot see */
      refresh: function () {
        s.stale = true
        s.find(false)
      },
    }
    return s.api
  }
})()
