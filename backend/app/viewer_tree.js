// thimble's tree for a view's page, part of the view kit: views.frame_document loads it after viewer_table.js and
// before viewer_range.js; viewer_parts.css styles it. A list of groups to navigate beside the records, drawn as Files'
// tree draws the corpus's folders (frontend/src/files/Tree.tsx): a chat's channels, an inbox's folders, a repository's
// files, a wiki's pages under their wikis, agents and their sessions. It draws only the rows near its view, so a tree of
// 50,000 nodes opens in a fraction of a second. It needs no other part of the kit.
//
//   const tree = thimble.tree({
//     mount: '#pages',                           the element the tree fills and scrolls in; the page gives it a height
//     items: pages,                              the nodes, one of three ways:
//                                                  [{key, name, parent, n}]   a tree as given, `parent` another's key
//                                                  with split: '/'            keys are paths: folders from their prefixes
//                                                  with rows                  records, grouped as rows.groups(items)
//     count: (node) => unread(node.items),       the number at a row's right: by default `n`, a group's records, or a
//                                                folder's sum; false for none
//     mix: true,                                 the row's thimble.mix: true counts a group's records by Color by, or
//                                                (node) => counts
//     anchor: (node) => 'view:wiki/' + node.key, a row's data-anchor
//     find: true,                                a field over the tree that keeps the names that match
//     onPick: (node) => show(node),              a click or Enter on a row, which chooses it
//   })
//   tree.draw(items)                             new nodes, such as after a fetch; tree.draw() after Rows changed
//
// A node, as each function above and `nodes` give it: {key, name, parent, depth, children, n, item}, `item` the one it
// was given (null for a folder the tree made), and with `rows` also `items` and `value`, its group's records and value.
// Rows are 24 px, indented by depth, a folder's chevron folding it, the guide lines showing while the pointer is over the
// tree; with `split` the folders come before the leaves, each in natural order. A name is cut with an ellipsis and shown
// whole on hover; the number stands right-aligned in mono after it, never under it. A group takes no color of its own:
// `mix` shows how its records divide among Color by's values. A click on a folder opens it, and on the chosen folder
// folds it; ↑ ↓ move, ← folds or goes to the parent, → opens, Enter picks. The tree opens with the folders that fit its
// height open (opening); thimble keeps the folds and the chosen key per view (`key`, else the mount's id), and Reset puts
// back the folds the tree opened with and empties the find, and keeps the choice.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var shared = kit.shared
  var ctl = shared.controls
  var esc = shared.esc
  var num = shared.num

  var ROW = 24 // px, a row's height (files.css .files-row, Tree.tsx ROW_HEIGHT)
  var INDENT = 14 // px a level indents (Tree.tsx INDENT)
  var GUIDE_X = 7 // px, the first level's guide line (Tree.tsx GUIDE_X)
  var OVER = 12 // rows drawn above and below the view, so a scroll shows drawn rows
  var FIT_ROWS = 30 // the rows a tree with no height yet fits when it opens
  var FIT_MIN = 8 // the fewest rows a tree fits when it opens
  var SNAP_MS = 1600 // how long a revealed row keeps its highlight (viewer_kit.css [data-thimble-snap])
  var collator = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }) : null
  var CHEV = '<svg class="thimble-tree-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
  var GLYPH = '<svg class="thimble-tree-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>'
  var HOSTED = typeof WeakMap === 'function' ? new WeakMap() : null // a mount -> the tree it holds, which a new one there retires
  var serial = 0 // trees made, for their rows' ids

  function cmp(a, b) {
    return collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0
  }
  function finite(v) {
    return typeof v === 'number' && isFinite(v) ? v : null
  }
  // counts as thimble.mix takes them, {value: n} or [[value, n]], as {value: n}
  function countsOf(v) {
    if (!v || typeof v !== 'object') return null
    if (!Array.isArray(v)) return v
    var out = {}
    for (var i = 0; i < v.length; i++) if (v[i]) out[v[i][0] == null ? '' : v[i][0]] = (out[v[i][0] == null ? '' : v[i][0]] || 0) + (Number(v[i][1]) || 0)
    return out
  }
  function addCounts(to, from) {
    if (!from) return to
    for (var k in from) {
      var n = Number(from[k]) || 0
      if (n) to[k] = (to[k] || 0) + n
    }
    return to
  }
  function sameSet(a, b) {
    if (!a || !b) return !a === !b
    if (a.size !== b.size) return false
    var same = true
    a.forEach(function (k) {
      if (!b.has(k)) same = false
    })
    return same
  }

  function Tree(opts) {
    var self = this
    this.mount = ctl.el(opts.mount)
    this.dead = false
    this.name = 'tree:' + (typeof opts.key === 'string' && opts.key ? opts.key : (this.mount && this.mount.id) || 'tree')
    this.rows = opts.rows && typeof opts.rows.groups === 'function' ? opts.rows : null
    this.split = !this.rows && typeof opts.split === 'string' && opts.split ? opts.split : null
    this.count = opts.count === false ? false : typeof opts.count === 'function' ? opts.count : null
    this.mix = opts.mix === true ? true : typeof opts.mix === 'function' ? opts.mix : null
    this.anchor = typeof opts.anchor === 'function' ? opts.anchor : null
    this.onPick = typeof opts.onPick === 'function' ? opts.onPick : null
    this.items = Array.isArray(opts.items) ? opts.items : []
    this.list = [] // every node in the order the tree lists them: {key, name, low, up, end, depth, kids, item, items, value, pub}
    this.at = new Map() // a node's key -> its place in `list`
    this.shown = [] // the places in `list` of the rows that show, in order
    this.drawn = new Map() // a row's place in `shown` -> its element, the rows near the view
    this.open = null // the keys of the folders open
    this.initial = null // the folders the tree opened with (opening), and what it opened them for
    this.initialFor = null
    this.query = ''
    this.found = null // what the find matched (search)
    this.findFolded = new Set() // the folders above a match the analyst folded while the find's words stay
    this.cursor = -1 // the node the keys move, a place in `list`
    this.mixes = new Map()
    this.id = 'thimble-tree-' + ++serial
    if (!this.mount) return
    // a tree made again on the same mount takes its place: the one before hears nothing more
    var before = HOSTED && HOSTED.get(this.mount)
    if (before) before.retire()
    if (HOSTED) HOSTED.set(this.mount, this)
    var m = this.mount
    m.classList.add('thimble-tree')
    m.innerHTML =
      (opts.find
        ? '<div class="thimble-tree-find thimble-part" data-thimble-chrome><label class="thimble-tree-box">' + GLYPH +
          '<input class="thimble-tree-input" type="text" placeholder="Find" aria-label="Find a name" spellcheck="false" autocomplete="off"></label></div>'
        : '') + '<div class="thimble-tree-body" role="tree" tabindex="0"></div><div class="thimble-tree-none" hidden>No name matches</div>'
    this.input = m.querySelector('.thimble-tree-input')
    this.findEl = this.input ? this.input.closest('.thimble-tree-find') : null
    this.body = m.querySelector('.thimble-tree-body')
    this.none = m.querySelector('.thimble-tree-none')
    this.body.addEventListener('click', function (e) {
      // a ⌘-click asks about the row (the bridge), and picks nothing
      if (e.metaKey || e.ctrlKey) return
      var row = e.target.closest && e.target.closest('.thimble-tree-row')
      if (!row) return
      var i = Number(row.getAttribute('data-i'))
      if (e.target.closest('.thimble-tree-fold')) {
        self.cursor = i
        self.setOpen(i, !self.isOpen(i))
        return
      }
      self.pick(i, true)
    })
    // a name cut short shows whole in the kit's tip
    this.body.addEventListener('pointerover', function (e) {
      var nm = e.target.closest && e.target.closest('.thimble-tree-name')
      if (!nm || nm.scrollWidth <= nm.clientWidth + 1) return
      var nd = self.list[Number(nm.parentNode.getAttribute('data-i'))]
      var r = nm.getBoundingClientRect()
      if (nd) shared.tip('<div class="thimble-tip-h">' + esc(nd.name) + '</div>', r.left - 12, r.bottom, 'under', r.top)
    })
    this.body.addEventListener('pointerout', function (e) {
      var nm = e.target.closest && e.target.closest('.thimble-tree-name')
      if (nm && !(e.relatedTarget && nm.contains(e.relatedTarget))) shared.untip()
    })
    // the rows take the keys: the ring on the row they are on shows while they move it, not after a click
    var body = this.body
    body.addEventListener('pointerdown', function () {
      body.classList.remove('is-keys')
    })
    // the keys start on the chosen row where it shows, else on the first row in view; reached by Tab, its ring shows
    body.addEventListener('focus', function () {
      if (ctl.safe(function () { return body.matches(':focus-visible') }, false)) body.classList.add('is-keys')
      if (self.place(self.cursor) >= 0 || !self.shown.length) return
      var c = self.at.get(self.chosenKey())
      self.cursor = c != null && self.place(c) >= 0 ? c : self.shown[self.firstInView()]
      self.paintCursor()
    })
    body.addEventListener('keydown', function (e) {
      self.key(e)
    })
    if (this.input) {
      this.input.addEventListener('input', function () {
        self.find(self.input.value)
      })
      this.input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          var first = self.firstHit()
          if (first >= 0) self.cursor = first
          body.classList.add('is-keys')
          body.focus()
          self.paintCursor()
        } else if (e.key === 'Enter' && self.found) {
          e.preventDefault()
          var hit = self.place(self.cursor) >= 0 ? self.cursor : self.firstHit()
          if (hit >= 0) self.pick(hit, false)
        } else if (e.key === 'Escape' && self.input.value) {
          e.preventDefault()
          e.stopPropagation()
          self.input.value = ''
          self.find('')
        }
      })
    }
    // the rows near the view follow every scroll that moves the tree: its own, or the page's where it does not scroll
    var frame = null
    this.onScroll = function () {
      shared.untip()
      if (frame != null) return
      frame = requestAnimationFrame(function () {
        frame = null
        if (!self.dead) self.window()
      })
    }
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true })
    if (typeof ResizeObserver === 'function') {
      this.resized = new ResizeObserver(function () {
        if (!self.dead) self.window()
      })
      this.resized.observe(m)
    }
    // Color by changed: the rows' mixes counted again
    shared.onColour(function () {
      if (self.dead || !self.mix) return
      self.mixes.clear()
      self.repaint()
    })
    // a label colored by reaches records only as their marks arrive: the mixes follow
    var marksFrame = null
    thimble.onMarks(function () {
      var c = shared.colour()
      if (self.dead || self.mix !== true || !c || !c.label || marksFrame != null) return
      marksFrame = requestAnimationFrame(function () {
        marksFrame = null
        self.mixes.clear()
        self.repaint()
      })
    })
    // a list of groups has the kit's plain track, as its other lists have their strips
    if (typeof shared.strip === 'function') shared.strip(m, {})
    // Reset puts back the folds the tree opened with and empties the find; the choice stays
    this.checkReset = shared.part({
      changed: function () {
        return !self.dead && (!!self.query || self.foldsChanged())
      },
      reset: function () {
        delete ctl.kept(self.name).open
        ctl.save()
        self.open = new Set(self.initial || [])
        self.query = ''
        if (self.input) self.input.value = ''
        self.findFolded = new Set()
        self.search()
        self.relayout()
      },
    })
    this.draw()
  }

  // the tree made again on its mount: it hears nothing more and draws nothing more
  Tree.prototype.retire = function () {
    this.dead = true
    document.removeEventListener('scroll', this.onScroll, { capture: true })
    if (this.resized) this.resized.disconnect()
  }
  Tree.prototype.kept = function () {
    return ctl.kept(this.name)
  }
  Tree.prototype.chosenKey = function () {
    var k = this.kept().chosen
    return k == null ? null : String(k)
  }
  // a key as the nodes hold it: with `split`, a path without empty parts
  Tree.prototype.norm = function (key) {
    if (key == null) return null
    key = String(key)
    return this.split
      ? key
          .split(this.split)
          .filter(function (s) {
            return s !== ''
          })
          .join(this.split)
      : key
  }
  Tree.prototype.indexOf = function (key) {
    var i = this.at.get(this.norm(key))
    return i == null ? -1 : i
  }

  // ---------------------------------------------------------------- the nodes
  // The nodes as given (`items` as a tree, as paths with `split`, or as records grouped by `rows`), in the order the tree
  // lists them, each with its parent, its depth, the end of its subtree and its number.
  Tree.prototype.build = function () {
    var made = [] // {key, name, upKey, item, items, value, given}
    var at = new Map()
    var node = function (key, name, upKey) {
      var i = at.get(key)
      if (i != null) return made[i]
      var n = { key: key, name: name == null ? key : name, upKey: upKey, item: null, items: null, value: null, given: null }
      at.set(key, made.length)
      made.push(n)
      return n
    }
    var items = this.items || []
    var i, n
    if (this.rows) {
      var rows = this.rows
      var groups = ctl.safe(function () { return rows.groups(items) }, []) || []
      for (i = 0; i < groups.length; i++) {
        var g = groups[i]
        if (!g || g.key == null) continue
        n = node(String(g.key), g.name == null ? String(g.key) : String(g.name), g.parent == null ? null : String(g.parent))
        n.items = Array.isArray(g.items) ? g.items : []
        n.value = g.value === undefined ? null : g.value
      }
    } else {
      var sep = this.split
      for (i = 0; i < items.length; i++) {
        var it = items[i]
        var o = it != null && typeof it === 'object' ? it : { key: it }
        if (o.key == null || o.key === '') continue
        var key = String(o.key)
        var up = o.parent == null || o.parent === '' ? null : String(o.parent)
        if (sep) {
          var parts = key.split(sep).filter(function (s) {
            return s !== ''
          })
          if (!parts.length) continue
          up = null
          for (var j = 0; j < parts.length - 1; j++) {
            var fk = parts.slice(0, j + 1).join(sep)
            node(fk, parts[j], up)
            up = fk
          }
          key = parts.join(sep)
          n = node(key, parts[parts.length - 1], up)
        } else {
          // a parent that no item names is a folder of its own, named by its key
          if (up === key) up = null
          n = node(key, null, up)
          n.upKey = up
          if (up != null && !at.has(up)) node(up, null, null)
        }
        if (o.name != null && o.name !== '') n.name = String(o.name)
        n.item = it
        n.given = finite(o.n)
      }
    }
    // each node under its parent, the roots in the order they came; a node in a loop of parents is a root
    var kids = made.map(function () {
      return []
    })
    var roots = []
    for (i = 0; i < made.length; i++) {
      var u = made[i].upKey == null ? null : at.get(made[i].upKey)
      if (u == null || u === i) roots.push(i)
      else kids[u].push(i)
    }
    if (this.split) {
      // folders first, then the leaves, each in natural order (Tree.tsx rowsOf)
      var bySpot = function (a, b) {
        return (kids[b].length > 0) - (kids[a].length > 0) || cmp(made[a].name, made[b].name) || (made[a].key < made[b].key ? -1 : 1)
      }
      roots.sort(bySpot)
      for (i = 0; i < kids.length; i++) if (kids[i].length > 1) kids[i].sort(bySpot)
    }
    var list = []
    var seen = new Uint8Array(made.length)
    var walk = function (r) {
      // depth first, without recursion: [node, its parent's place in list, depth]
      var stack = [[r, -1, 0]]
      while (stack.length) {
        var top = stack.pop()
        var m = top[0]
        if (seen[m]) continue
        seen[m] = 1
        var src = made[m]
        var nd = { key: src.key, name: src.name, low: src.name.toLowerCase(), up: top[1], end: 0, depth: top[2], kids: [], item: src.item, items: src.items, value: src.value, given: src.given, pub: null }
        var at2 = list.length
        list.push(nd)
        if (top[1] >= 0) list[top[1]].kids.push(at2)
        for (var k = kids[m].length - 1; k >= 0; k--) stack.push([kids[m][k], at2, top[2] + 1])
      }
    }
    roots.forEach(walk)
    // a loop of parents reaches no root: its first node is a root
    for (i = 0; i < made.length; i++) if (!seen[i]) walk(i)
    // each subtree's end, and each node's number: from the leaves up
    var count = this.count
    for (i = list.length - 1; i >= 0; i--) {
      n = list[i]
      n.end = n.kids.length ? list[n.kids[n.kids.length - 1]].end : i + 1
      n.pub = {
        key: n.key,
        name: n.name,
        parent: n.up >= 0 ? list[n.up].key : null,
        depth: n.depth,
        children: n.kids.length,
        n: null,
        item: n.item,
      }
      if (this.rows) {
        n.pub.items = n.items
        n.pub.value = n.value
      }
    }
    for (i = list.length - 1; i >= 0; i--) {
      n = list[i]
      var v = null
      if (count !== false) {
        var sum = null
        for (var c = 0; c < n.kids.length; c++) {
          var cn = list[n.kids[c]].pub.n
          if (cn != null) sum = (sum || 0) + cn
        }
        if (count) {
          var pub = n.pub
          v = finite(ctl.safe(function () { return count(pub) }, null))
        } else if (this.rows) v = n.items.length + (sum || 0)
        else v = n.given
        if (v == null) v = sum
      }
      n.pub.n = v
    }
    this.list = list
    this.at = new Map()
    for (i = 0; i < list.length; i++) this.at.set(list[i].key, i)
    this.mixes.clear()
    this.nested = list.some(function (x) {
      return x.kids.length > 0
    })
  }
  // How the tree opens: level by level, a level's folders open while every row then shown still fits the tree's height,
  // and a folder alone among its siblings opens too, as every path under one folder does. Computed once for the nodes
  // (again when Rows groups them by another choice), so a filter that changes the counts moves no fold.
  Tree.prototype.opening = function () {
    var list = this.list
    var open = new Set()
    var h = this.viewH()
    var fit = h > 0 ? Math.max(FIT_MIN, Math.floor(h / ROW)) : FIT_ROWS
    var levels = []
    var shownN = 0
    for (var i = 0; i < list.length; i++) {
      if (list[i].up < 0) shownN++
      if (list[i].kids.length) (levels[list[i].depth] || (levels[list[i].depth] = [])).push(i)
    }
    for (var d = 0; d < levels.length; d++) {
      var lv = levels[d] || []
      var add = 0
      for (var a = 0; a < lv.length; a++) add += list[lv[a]].kids.length
      if (shownN + add > fit) break
      for (var b = 0; b < lv.length; b++) open.add(list[lv[b]].key)
      shownN += add
    }
    var roots = []
    for (var r = 0; r < list.length; r = list[r].end) roots.push(r)
    var groups = [roots]
    while (groups.length) {
      var sibs = groups.pop()
      if (sibs.length === 1 && list[sibs[0]].kids.length) open.add(list[sibs[0]].key)
      for (var s = 0; s < sibs.length; s++) if (open.has(list[sibs[s]].key)) groups.push(list[sibs[s]].kids)
    }
    return open
  }
  // the height the rows have: the mount's with no rows in it, less the find field over them; about 0 where the page
  // gives the mount no height of its own, or has not laid it out
  Tree.prototype.viewH = function () {
    this.body.style.height = '0px'
    return Math.max(0, this.mount.clientHeight - (this.findEl ? this.findEl.offsetHeight : 0))
  }
  Tree.prototype.foldsChanged = function () {
    return this.kept().open !== undefined && !sameSet(this.open, this.initial)
  }
  Tree.prototype.keepOpen = function () {
    var k = []
    this.open.forEach(function (x) {
      k.push(x)
    })
    this.kept().open = k
    ctl.save()
    this.checkReset()
  }

  // ---------------------------------------------------------------- the find
  // The names that match the find's words, the case aside: what shows is each match, everything under a match as it is
  // folded, and the folders above a match, open (the analyst may fold one while the words stay)
  Tree.prototype.search = function () {
    var q = this.query.trim().toLowerCase()
    if (!q) {
      this.found = null
      return
    }
    var list = this.list
    var N = list.length
    var hit = new Uint8Array(N)
    var below = new Uint8Array(N)
    var under = new Uint8Array(N)
    var hits = 0
    var i
    for (i = 0; i < N; i++)
      if (list[i].low.indexOf(q) >= 0) {
        hit[i] = 1
        hits++
      }
    for (i = N - 1; i >= 0; i--) if ((hit[i] || below[i]) && list[i].up >= 0) below[list[i].up] = 1
    for (i = 0; i < N; i++) if (list[i].up >= 0) under[i] = under[list[i].up] || hit[list[i].up]
    this.found = { q: q, hit: hit, below: below, under: under, n: hits }
  }
  Tree.prototype.find = function (text) {
    this.query = String(text || '')
    this.findFolded = new Set()
    this.search()
    this.layout()
    // the matches from the top; the words cleared, the row the keys were on in view
    if (this.found) {
      this.mount.scrollTop = 0
      this.cursor = this.firstHit()
    }
    this.redraw()
    if (!this.found && this.place(this.cursor) >= 0) this.scrollTo(this.place(this.cursor), false)
    this.checkReset()
  }
  Tree.prototype.firstHit = function () {
    if (!this.found) return this.shown.length ? this.shown[0] : -1
    for (var r = 0; r < this.shown.length; r++) if (this.found.hit[this.shown[r]]) return this.shown[r]
    return -1
  }

  // ---------------------------------------------------------------- what shows
  Tree.prototype.isOpen = function (i) {
    var nd = this.list[i]
    if (!nd || !nd.kids.length) return false
    var f = this.found
    if (f && f.below[i]) return !this.findFolded.has(nd.key)
    return this.open.has(nd.key)
  }
  // the rows that show: every node whose folders above are open, and with the find's words what it keeps
  Tree.prototype.layout = function () {
    var list = this.list
    var f = this.found
    var out = []
    var i = 0
    while (i < list.length) {
      if (f && !(f.hit[i] || f.below[i] || f.under[i])) {
        i = list[i].end
        continue
      }
      out.push(i)
      i = this.isOpen(i) ? i + 1 : list[i].end
    }
    this.shown = out
  }
  // where a node shows among the rows, -1 for nowhere (`shown` is in the order of `list`)
  Tree.prototype.place = function (i) {
    if (i == null || i < 0) return -1
    var lo = 0
    var hi = this.shown.length - 1
    while (lo <= hi) {
      var mid = (lo + hi) >> 1
      var v = this.shown[mid]
      if (v === i) return mid
      if (v < i) lo = mid + 1
      else hi = mid - 1
    }
    return -1
  }

  // ---------------------------------------------------------------- drawing
  // Everything drawn again with the items: the nodes, how the tree opens, what the find keeps and the rows near the view
  Tree.prototype.draw = function () {
    if (!this.mount || this.dead) return
    // the row the keys are on stays theirs, by its key, as the nodes come again
    var on = this.list[this.cursor] ? this.list[this.cursor].key : null
    this.build()
    this.cursor = on != null && this.at.has(on) ? this.at.get(on) : -1
    var kept = this.kept()
    // how it opens, worked out for the first nodes with folders, and again for another choice of Rows
    var sig = this.rows ? JSON.stringify(this.rows.by) : 'items'
    var fresh = !this.initial || this.initialFor !== sig || !this.initialNested
    if (fresh) {
      this.initial = this.opening()
      this.initialFor = sig
      this.initialNested = this.nested
    }
    if (!this.open || (fresh && !Array.isArray(kept.open))) this.open = Array.isArray(kept.open) ? new Set(kept.open.map(String)) : new Set(this.initial)
    this.mount.classList.toggle('is-tree', this.nested)
    this.search()
    this.relayout()
  }
  Tree.prototype.relayout = function () {
    this.layout()
    this.redraw()
    this.checkReset()
  }
  // the rows drawn anew, none kept
  Tree.prototype.redraw = function () {
    if (!this.body) return
    this.body.style.height = this.shown.length * ROW + 'px'
    this.none.hidden = !(this.found && !this.shown.length)
    this.drawn.forEach(function (el) {
      el.remove()
    })
    this.drawn.clear()
    this.window()
  }
  // the rows drawn anew where they are, such as after Color by changed their mixes
  Tree.prototype.repaint = function () {
    this.drawn.forEach(function (el) {
      el.remove()
    })
    this.drawn.clear()
    this.window()
  }
  // the first row whose top is in view
  Tree.prototype.firstInView = function () {
    var br = this.body.getBoundingClientRect()
    var mr = this.mount.getBoundingClientRect()
    var top = Math.max(mr.top + (this.findEl ? this.findEl.offsetHeight : 0), 0)
    return Math.max(0, Math.min(this.shown.length - 1, Math.ceil((top - br.top) / ROW)))
  }
  // the rows near the view drawn, those that were drawn and still are near kept as they are: the view is the part of the
  // mount in the frame, so a tree in a page that scrolls draws only its rows in view too
  Tree.prototype.window = function (also) {
    if (!this.body || this.dead) return
    var n = this.shown.length
    var br = this.body.getBoundingClientRect()
    var mr = this.mount.getBoundingClientRect()
    var top = Math.max(mr.top, 0)
    var bottom = Math.min(mr.bottom, innerHeight)
    var a = 0
    var b = Math.min(n, 2 * OVER)
    if (bottom > top) {
      a = Math.max(0, Math.floor((top - br.top) / ROW) - OVER)
      b = Math.min(n, Math.max(a, Math.ceil((bottom - br.top) / ROW) + OVER))
    }
    var self = this
    this.drawn.forEach(function (el, r) {
      if ((r < a || r >= b) && r !== also) {
        el.remove()
        self.drawn.delete(r)
      }
    })
    var add = []
    var html = ''
    var want = function (r) {
      if (r < 0 || r >= n || self.drawn.has(r)) return
      add.push(r)
      html += self.rowHtml(r)
    }
    for (var r = a; r < b; r++) want(r)
    if (also != null && (also < a || also >= b)) want(also)
    if (add.length) {
      var tmp = document.createElement('div')
      tmp.innerHTML = html
      for (var j = 0; j < add.length; j++) {
        var el = tmp.firstChild
        this.drawn.set(add[j], el)
        this.body.appendChild(el)
      }
    }
    this.paintCursor()
  }
  Tree.prototype.rowHtml = function (r) {
    var i = this.shown[r]
    var nd = this.list[i]
    var folder = nd.kids.length > 0
    var open = folder && this.isOpen(i)
    var chosen = this.chosenKey() === nd.key
    var self = this
    var guides = ''
    if (this.nested) for (var g = 0; g <= nd.depth; g++) guides += '<span class="thimble-tree-guide" style="left:' + (GUIDE_X + g * INDENT) + 'px"></span>'
    var lead = folder ? '<span class="thimble-tree-fold">' + CHEV + '</span>' : this.nested ? '<span class="thimble-tree-gap"></span>' : ''
    var name = esc(nd.name)
    var f = this.found
    if (f && f.hit[i] && nd.low.length === nd.name.length) {
      var at = nd.low.indexOf(f.q)
      name = esc(nd.name.slice(0, at)) + '<mark class="thimble-tree-hit">' + esc(nd.name.slice(at, at + f.q.length)) + '</mark>' + esc(nd.name.slice(at + f.q.length))
    }
    var end = ''
    if (this.mix) end += thimble.mix(this.mixOf(i) || {})
    if (nd.pub.n != null) end += '<span class="thimble-tree-n">' + num(nd.pub.n) + '</span>'
    var anchor = this.anchor ? ctl.safe(function () { return self.anchor(nd.pub) }, null) : null
    return (
      '<div class="thimble-tree-row' + (folder ? ' is-folder' : '') + (chosen ? ' active' : '') + '" role="treeitem" id="' + this.id + '-' + i + '" data-i="' + i + '"' +
      ' data-key="' + esc(nd.key) + '" aria-level="' + (nd.depth + 1) + '"' + (folder ? ' aria-expanded="' + open + '"' : '') + (chosen ? ' aria-selected="true"' : '') +
      (anchor != null && anchor !== '' ? ' data-anchor="' + esc(anchor) + '"' : '') + ' style="top:' + r * ROW + 'px;--depth:' + nd.depth + '">' +
      guides + lead + '<span class="thimble-tree-name">' + name + '</span>' + (end ? '<span class="thimble-tree-end">' + end + '</span>' : '') +
      '</div>'
    )
  }
  // A node's mix: `mix(node)`'s counts, else its children's summed; with `mix: true` its records' Color by values and
  // its descendants'. Counted for the rows drawn, and kept until the nodes or Color by change.
  Tree.prototype.mixOf = function (i) {
    if (this.mixes.has(i)) return this.mixes.get(i)
    var nd = this.list[i]
    var got = null
    var self = this
    if (this.mix === true) {
      var c = shared.colour()
      got = {}
      if (c && nd.items)
        for (var k = 0; k < nd.items.length; k++) {
          var r = nd.items[k]
          var v = ctl.safe(function () { return c.valueOf(r) }, null)
          var key = v == null ? '' : String(v)
          got[key] = (got[key] || 0) + 1
        }
      for (var a = 0; a < nd.kids.length; a++) addCounts(got, this.mixOf(nd.kids[a]))
    } else if (this.mix) {
      got = countsOf(ctl.safe(function () { return self.mix(nd.pub) }, null))
      if (!got && nd.kids.length) {
        got = {}
        for (var b = 0; b < nd.kids.length; b++) addCounts(got, this.mixOf(nd.kids[b]))
      }
    }
    this.mixes.set(i, got)
    return got
  }
  // the row the keys are on: its ring while the keys move it, and the tree's active descendant
  Tree.prototype.paintCursor = function () {
    if (!this.body) return
    var r = this.place(this.cursor)
    this.drawn.forEach(function (el, k) {
      el.classList.toggle('is-cursor', k === r)
    })
    if (r >= 0 && this.drawn.has(r)) this.body.setAttribute('aria-activedescendant', this.id + '-' + this.cursor)
    else this.body.removeAttribute('aria-activedescendant')
  }
  Tree.prototype.paintChosen = function () {
    var key = this.chosenKey()
    this.drawn.forEach(function (el) {
      var on = key != null && el.getAttribute('data-key') === key
      el.classList.toggle('active', on)
      if (on) el.setAttribute('aria-selected', 'true')
      else el.removeAttribute('aria-selected')
    })
  }
  // row `r` scrolled into view: in the middle when `middle`, else just inside the edge, clear of the find field
  Tree.prototype.scrollTo = function (r, middle) {
    if (r < 0 || r >= this.shown.length) return
    this.window(r)
    var el = this.drawn.get(r)
    if (!el) return
    this.mount.style.scrollPaddingTop = (this.findEl ? this.findEl.offsetHeight : 0) + 'px'
    el.scrollIntoView({ block: middle ? 'center' : 'nearest' })
    this.window()
  }

  // ---------------------------------------------------------------- what the analyst does
  Tree.prototype.setOpen = function (i, on) {
    var nd = this.list[i]
    if (!nd || !nd.kids.length || this.isOpen(i) === !!on) return
    if (this.found && this.found.below[i]) {
      if (on) this.findFolded.delete(nd.key)
      else this.findFolded.add(nd.key)
    } else {
      if (on) this.open.add(nd.key)
      else this.open.delete(nd.key)
      this.keepOpen()
    }
    this.relayout()
  }
  Tree.prototype.setChosen = function (key) {
    var k = this.kept()
    if (key == null) delete k.chosen
    else k.chosen = String(key)
    ctl.save()
    this.paintChosen()
  }
  // the folders above a node opened, so that it shows once the find's words are gone; whether any was folded
  Tree.prototype.openAbove = function (i) {
    var opened = false
    for (var u = this.list[i].up; u >= 0; u = this.list[u].up) {
      var k = this.list[u].key
      if (this.found) this.findFolded.delete(k)
      if (this.open.has(k)) continue
      this.open.add(k)
      opened = true
    }
    if (opened) this.keepOpen()
    return opened
  }
  // a row picked, by a click or Enter: chosen, a folder opened (a click on the chosen folder folds it), the page told;
  // a match picked keeps its folders open once the find's words are gone
  Tree.prototype.pick = function (i, click) {
    var nd = this.list[i]
    if (!nd) return
    var again = this.chosenKey() === nd.key
    this.cursor = i
    if (this.found) this.openAbove(i)
    if (nd.kids.length) {
      if (!this.isOpen(i)) this.setOpen(i, true)
      else if (again && click) this.setOpen(i, false)
    }
    this.setChosen(nd.key)
    this.paintCursor()
    var self = this
    if (this.onPick) ctl.safe(function () { self.onPick(nd.pub) })
  }
  Tree.prototype.key = function (e) {
    var n = this.shown.length
    if (!n) return
    var r = this.place(this.cursor)
    var nd = r >= 0 ? this.list[this.cursor] : null
    var to = null
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') to = r < 0 ? this.firstInView() : Math.max(0, Math.min(n - 1, r + (e.key === 'ArrowDown' ? 1 : -1)))
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = n - 1
    else if (e.key === 'ArrowRight') {
      if (!nd) to = this.firstInView()
      else if (nd.kids.length && !this.isOpen(this.cursor)) this.setOpen(this.cursor, true)
      else if (nd.kids.length && r + 1 < n && this.list[this.shown[r + 1]].up === this.cursor) to = r + 1
    } else if (e.key === 'ArrowLeft') {
      if (!nd) to = this.firstInView()
      else if (nd.kids.length && this.isOpen(this.cursor)) this.setOpen(this.cursor, false)
      else if (nd.up >= 0 && this.place(nd.up) >= 0) to = this.place(nd.up)
    } else if ((e.key === 'Enter' || e.key === ' ') && nd) this.pick(this.cursor, false)
    else return
    e.preventDefault()
    this.body.classList.add('is-keys')
    if (to != null) {
      this.cursor = this.shown[to]
      this.scrollTo(to, false)
    }
    this.paintCursor()
  }
  // a node shown: its folders opened, the find's words cleared where they hide it, scrolled to the middle, chosen and
  // highlighted for a moment
  Tree.prototype.reveal = function (key) {
    var i = this.indexOf(key)
    if (i < 0) return false
    var f = this.found
    if (f && !(f.hit[i] || f.below[i] || f.under[i])) {
      this.query = ''
      if (this.input) this.input.value = ''
      this.findFolded = new Set()
      this.search()
    }
    this.openAbove(i)
    this.cursor = i
    this.setChosen(this.list[i].key)
    this.relayout()
    var r = this.place(i)
    this.scrollTo(r, true)
    var el = this.drawn.get(r)
    if (el) {
      el.removeAttribute('data-thimble-snap')
      void el.offsetWidth
      el.setAttribute('data-thimble-snap', '')
      setTimeout(function () {
        el.removeAttribute('data-thimble-snap')
      }, SNAP_MS)
    }
    return true
  }

  /** a list of groups to navigate beside the records, as Files' tree (see the top of this file) */
  thimble.tree = function (opts) {
    var t = new Tree(opts || {})
    return {
      /** drawn with these items, such as after a fetch, the folds and the choice kept; with none, drawn again, such as
       *  after Rows changed its choice */
      draw: function (items) {
        // anything but a list (or null for none) draws again, so `onChange: tree.draw` keeps the items
        if (Array.isArray(items) || items === null) t.items = items || []
        t.draw()
      },
      /** the chosen row marked, as a pick marks it, without telling the page; null for none */
      choose: function (key) {
        var i = t.indexOf(key)
        if (i >= 0) t.cursor = i
        t.setChosen(key == null ? null : t.norm(key))
        t.paintCursor()
      },
      /** the key of the chosen node, kept per view, or null */
      get chosen() {
        return t.chosenKey()
      },
      /** a node shown: its folders opened, scrolled to, chosen and highlighted for a moment; false when there is none */
      reveal: function (key) {
        return t.reveal(key)
      },
      /** a folder folded (`on` true), opened (false) or turned over (left out); false when there is none */
      fold: function (key, on) {
        var i = t.indexOf(key)
        if (i < 0 || !t.list[i].kids.length) return false
        t.setOpen(i, on === undefined ? !t.isOpen(i) : !on)
        return true
      },
      /** every node, in the order the tree lists them */
      get nodes() {
        return t.list.map(function (n) {
          return n.pub
        })
      },
    }
  }
})()
