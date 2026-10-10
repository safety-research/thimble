// thimble's record viewer for a view's page, part of the view kit: views.frame_document loads it after
// viewer_transcript.js and before viewer_range.js; viewer_parts.css styles it. It draws one record, a JSON value, as a
// collapsible tree under the record's citation: a row per field, its key in mono at the left and its value at the
// right; a nested object or list folded to one line that names its size and its first fields, opened by a click on its
// key; a long string folded to six lines with Show more and Show less; a long list's first 100 items with Show N more.
// The record is anchored with its ref, so a label marks it and a ⌘-click asks about it, and its citation opens it in
// the File browser. It works on any element, and in the side panel as its body:
//
//   side.open({ title, ref, render: (body) => thimble.record({ mount: body, value: rec, ref }) })
//
//   thimble.record({ mount, value, ref, open, find, colour })   value: an object, a list, a plain value, or JSON text;
//                                                              open: the levels of nested values open at first (2);
//                                                              find: words whose matches are highlighted and opened;
//                                                              colour (or color): the Color by whose bar the record
//                                                              takes, the page's by default; false for none
//
// Called again on the same mount with the same ref, it keeps what the analyst opened and folded. Its bar follows Color
// by as it changes, with nothing drawn again. What a fold hides stays in the page, hidden, in an element with
// data-thimble-fold, so thimble.search finds it and opens its fold with the `thimble-unfold` event: a folded value's
// values, each on its own line, a long string's text past its first six lines and a long list's items past its first
// 100. A record's folded values and items are kept in the page up to FOLD_CHARS characters; the search does not find
// those past them until their fold is opened by hand.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var shared = kit.shared
  var ctl = shared.controls
  var esc = shared.esc
  var num = shared.num

  var OPEN = 2 // levels of nested values open at first
  var LONG_LINES = 6 // a string longer than this many lines, or LONG_CHARS characters, folds to six lines
  var LONG_CHARS = 480
  var MANY = 100 // the items or fields of a value shown before Show N more
  var FOLD_CHARS = 200000 // characters of folded values and items a record keeps in the page for the search
  var PREVIEW = 6 // fields or items a folded value names
  var CARET = '<svg class="thimble-record-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'

  function isBranch(v) {
    return v != null && typeof v === 'object'
  }
  function entries(v) {
    return Array.isArray(v)
      ? v.map(function (x, i) {
          return [String(i), x]
        })
      : Object.keys(v).map(function (k) {
          return [k, v[k]]
        })
  }
  // a JSON pointer's step (RFC 6901), so every value has a path of its own
  function step(path, key) {
    return path + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1')
  }
  var LOCATOR_MAX = 18 // characters of a record's place a chip shows (frontend lib/refs.ts LOCATOR_LABEL_MAX)
  function cut(s) {
    return s.length > LOCATOR_MAX ? s.slice(0, LOCATOR_MAX - 1) + '…' : s
  }
  // a file as a chip names it (frontend lib/refs.ts refLabel): its name after its run's folder, the first folder that
  // holds a digit or else the last, with … where folders are left out
  function fileLabel(path, name) {
    var parts = path.split('/')
    var depth = parts.length > 1 && (parts[parts.length - 2] === 'agents' || parts[parts.length - 2] === 'prompts') ? 2 : 1
    var run = parts.length > depth ? parts.slice(0, parts.length - depth).filter(Boolean) : []
    name = name == null ? parts[parts.length - 1] : name
    if (!run.length) return name
    var k = run.length - 1
    for (var i = 0; i < run.length; i++)
      if (/\d/.test(run[i])) {
        k = i
        break
      }
    return run[k] + ' › ' + (k < run.length - 1 ? '… › ' : '') + name
  }
  // the words a citation chip shows, as thimble's chips write them (lib/refs.ts refLabel): the file and the record's
  // place in it, or a view and its unit
  function citeLabel(ref) {
    var s = String(ref).trim()
    var m = /^view:([a-z0-9][a-z0-9-]{0,39})(?:\/(\S+))?$/.exec(s)
    if (m) return m[2] ? m[1] + ' · ' + cut(m[2]) : 'view ' + m[1]
    var at = s.indexOf('#')
    if (at < 0) return fileLabel(s)
    var path = s.slice(0, at)
    var f = s.slice(at + 1)
    if (/\.(db|sqlite3?)$/i.test(path) && /^[A-Za-z_]\w*(\/.+)?$/.test(f)) return fileLabel(path, f)
    var file = fileLabel(path)
    if ((m = /^L(\d+)(?:\.b(\d+)(?::c\d+-\d+)?)?$/.exec(f))) return file + ' L' + m[1] + (m[2] ? '.b' + m[2] : '')
    if ((m = /^L(\d+)-L(\d+)$/.exec(f))) return file + ' L' + m[1] + '-' + m[2]
    if ((m = /^row=(\d+)$/.exec(f)) && /\.[ct]sv$/i.test(path)) return file + ' row ' + m[1]
    if ((m = /^(?:page=|p)(\d+)$/.exec(f)) && /\.pdf$/i.test(path)) return file + ' p. ' + m[1]
    if (f[0] === '/' && /\.json$/i.test(path)) return file + ' ' + cut(f)
    return file + ' · ' + cut(f)
  }
  function plain(v) {
    if (v === null) return 'null'
    if (v === undefined) return 'undefined'
    return typeof v === 'string' ? v : String(v)
  }
  function isLong(s) {
    return s.length > LONG_CHARS || s.split('\n').length > LONG_LINES
  }
  // A long string's first LONG_LINES lines, LONG_CHARS characters of them at most (after a space where one is near), and
  // the rest; the cut falls before a match of `q` it would split, so the match is found whole
  function cutLong(s, q) {
    var c = s.length
    var at = -1
    for (var i = 0; i < LONG_LINES; i++) if ((at = s.indexOf('\n', at + 1)) < 0) break
    if (at >= 0) c = at
    if (c > LONG_CHARS) {
      var sp = s.lastIndexOf(' ', LONG_CHARS)
      c = sp > LONG_CHARS * 0.8 ? sp + 1 : LONG_CHARS
      var code = s.charCodeAt(c - 1)
      if (code >= 0xd800 && code < 0xdc00) c--
    }
    if (q) {
      var low = s.toLowerCase()
      for (var m = low.indexOf(q); m >= 0 && m < c; m = low.indexOf(q, m + 1))
        if (m + q.length > c) {
          c = m
          break
        }
    }
    return [s.slice(0, c), s.slice(c)]
  }
  // how long a folded string is, in what folded it: its lines, or its characters when it is long on few lines
  function folded(s) {
    var n = s.split('\n').length
    return n > LONG_LINES ? num(n) + ' lines' : num(s.length) + ' characters'
  }
  // a value given as JSON text is drawn as the object or list it holds
  function parsed(v) {
    if (typeof v !== 'string') return v
    var t = v.trim()
    if (t[0] !== '{' && t[0] !== '[') return v
    try {
      var o = JSON.parse(t)
      return isBranch(o) ? o : v
    } catch (e) {
      return v
    }
  }

  function Record(mount) {
    var self = this
    this.mount = mount
    this.ref = null
    this.folds = {} // path -> true (opened) or false (folded) by hand
    this.longs = {} // path -> true while a long string is open
    this.more = {} // path -> true once all its items show
    this.q = ''
    this.args = null
    this.hits = 0
    this.bars = null
    this.drawn = null // the value as last drawn
    // Color by's choices changed: the record's bar stamped again from its value
    this.restamp = function () {
      var root = self.mount.firstElementChild
      if (root && root.classList.contains('thimble-record') && self.bars) self.bars.stamp(root, self.drawn)
    }
    mount.addEventListener('click', function (e) {
      self.click(e)
    })
    // the search goes to a match folded away (viewer_search.js): what folds it opens
    mount.addEventListener('thimble-unfold', function (e) {
      self.unfold(e.target)
    })
  }
  // the matches of `find` in a text, highlighted, and counted
  Record.prototype.marked = function (text) {
    var q = this.q
    if (!q) return esc(text)
    var low = text.toLowerCase()
    var out = ''
    var at = 0
    for (var i = low.indexOf(q); i >= 0; i = low.indexOf(q, at)) {
      out += esc(text.slice(at, i)) + '<mark class="thimble-record-hit">' + esc(text.slice(i, i + q.length)) + '</mark>'
      at = i + q.length
      this.hits++
    }
    return out + esc(text.slice(at))
  }
  // the paths whose value, or a key or a value under it, holds the words found
  Record.prototype.scan = function (v, path, key) {
    var q = this.q
    var hit = key != null && String(key).toLowerCase().indexOf(q) >= 0
    if (isBranch(v)) {
      var es = entries(v)
      var list = Array.isArray(v)
      for (var i = 0; i < es.length; i++) {
        if (!this.scan(es[i][1], step(path, es[i][0]), list ? null : es[i][0])) continue
        hit = true
        // a match past the items a long list shows at first
        if (list && i >= MANY && es.length > MANY + 10) this.beyond[path] = true
      }
    } else if (plain(v).toLowerCase().indexOf(q) >= 0) hit = true
    if (hit) this.found[path] = true
    return hit
  }
  Record.prototype.isOpen = function (path, depth) {
    var by = this.folds[path]
    if (by !== undefined) return by
    return depth < this.open || !!(this.found && this.found[path])
  }
  // a folded value's one line: its size, and the fields it has or the plain items it holds
  function summary(v) {
    var es = entries(v)
    if (!es.length) return 'empty'
    var size = Array.isArray(v) ? num(es.length) + (es.length === 1 ? ' item' : ' items') : num(es.length) + (es.length === 1 ? ' field' : ' fields')
    var named = Array.isArray(v)
      ? es.filter(function (e) {
          return !isBranch(e[1])
        }).map(function (e) {
          return plain(e[1]).replace(/\s+/g, ' ').slice(0, 40)
        })
      : es.map(function (e) {
          return e[0]
        })
    if (!named.length) return size
    return size + ': ' + named.slice(0, PREVIEW).join(', ') + (named.length > PREVIEW ? ', …' : '')
  }
  Record.prototype.value = function (v, path) {
    if (typeof v === 'string') {
      if (v === '') return '<span class="thimble-record-val is-empty">""</span>'
      if (!isLong(v)) return '<span class="thimble-record-val is-str">' + this.marked(v) + '</span>'
      var hits = this.hits
      var parts = cutLong(v, this.q)
      var text = this.marked(parts[0])
      var rest = this.marked(parts[1])
      var open = this.longs[path] !== undefined ? this.longs[path] : this.hits > hits
      return (
        '<span class="thimble-record-val is-str is-long"><span class="thimble-record-text' + (open ? '' : ' is-folded') + '">' + text +
        '<span data-thimble-fold data-fold-long="' + esc(path) + '"' + (open ? '' : ' hidden') + '>' + rest + '</span></span>' +
        '<button type="button" class="btn btn-ghost btn-sm thimble-record-more" data-long="' + esc(path) + '" aria-expanded="' + open + '" data-thimble-chrome>' +
        (open ? 'Show less' : 'Show more<span class="thimble-record-dim">' + folded(v) + '</span>') +
        '</button></span>'
      )
    }
    var kind = typeof v === 'number' ? 'num' : typeof v === 'boolean' ? 'bool' : 'null'
    return '<span class="thimble-record-val is-' + kind + '">' + this.marked(plain(v)) + '</span>'
  }
  // the rows of a value's fields or items, in a grid of their own, so each level lines its values up
  Record.prototype.rows = function (v, path, depth) {
    var es = entries(v)
    var all = this.more[path] || es.length <= MANY + 10
    var shown = all ? es : es.slice(0, MANY)
    var out = []
    for (var i = 0; i < shown.length; i++) {
      var key = shown[i][0]
      var x = shown[i][1]
      var at = step(path, key)
      var name = Array.isArray(v) ? esc(key) : this.marked(key)
      if (isBranch(x) && entries(x).length) {
        var open = this.isOpen(at, depth + 1)
        out.push(
          '<div class="thimble-record-row is-branch' + (open ? ' is-open' : '') + '">' +
            '<button type="button" class="thimble-record-key" data-fold="' + esc(at) + '" aria-expanded="' + open + '" data-thimble-chrome>' + CARET + '<span>' + name + '</span></button>' +
            '<span class="thimble-record-sum" data-thimble-chrome>' + esc(open ? summary(x).replace(/:.*$/, '') : summary(x)) + '</span>' +
            (open ? '' : this.folded([x], 'data-fold-path', at)) +
          '</div>' +
          (open ? '<div class="thimble-record-kids">' + this.rows(x, at, depth + 1) + '</div>' : '')
        )
      } else {
        out.push(
          '<div class="thimble-record-row"><span class="thimble-record-key" data-thimble-chrome><i class="thimble-record-gap"></i><span>' + name + '</span></span>' +
            (isBranch(x) ? '<span class="thimble-record-val is-empty">' + (Array.isArray(x) ? '[]' : '{}') + '</span>' : this.value(x, at)) +
          '</div>'
        )
      }
    }
    if (!all)
      out.push(
        '<div class="thimble-record-row"><span></span><button type="button" class="btn btn-ghost btn-sm thimble-record-more" data-more="' + esc(path) + '" data-thimble-chrome>Show ' +
          num(es.length - MANY) + ' more</button>' +
          this.folded(es.slice(MANY).map(function (e) { return e[1] }), 'data-fold-more', path) +
          '</div>'
      )
    return out.join('')
  }
  // The plain values under folded values, each on its own line in the order the open tree draws them (keys are the
  // tree's wording, which the search skips), hidden in the page for the search; `attr` names the fold's path for
  // unfold. A record's folds hold FOLD_CHARS characters in all at most.
  Record.prototype.folded = function (values, attr, path) {
    var self = this
    var out = []
    var seen = []
    var put = function (s) {
      if (s.length > self.room) s = s.slice(0, self.room)
      self.room -= s.length + 1
      out.push(s)
    }
    var walk = function (x) {
      if (self.room <= 0) return
      if (!isBranch(x)) return put(x === '' ? '""' : plain(x))
      if (seen.indexOf(x) >= 0) return
      var list = Array.isArray(x)
      var keys = list ? null : Object.keys(x)
      if (!(list ? x.length : keys.length)) return put(list ? '[]' : '{}')
      seen.push(x)
      if (list) for (var i = 0; i < x.length && self.room > 0; i++) walk(x[i])
      else for (var j = 0; j < keys.length && self.room > 0; j++) walk(x[keys[j]])
      seen.pop()
    }
    for (var i = 0; i < values.length && this.room > 0; i++) walk(values[i])
    if (!out.length) return ''
    return '<div class="thimble-record-folded" data-thimble-fold hidden ' + attr + '="' + esc(path) + '">' + esc(out.join('\n')) + '</div>'
  }
  Record.prototype.draw = function (args) {
    this.args = args
    var v = parsed(args.value)
    var ref = args.ref == null || args.ref === '' ? null : String(args.ref)
    var fresh = ref !== this.ref
    if (fresh) {
      this.ref = ref
      this.folds = {}
      this.longs = {}
      this.more = {}
    }
    this.open = Number(args.open) >= 0 ? Number(args.open) : OPEN
    var q = typeof args.find === 'string' ? args.find.trim().toLowerCase() : ''
    fresh = fresh || q !== this.q
    this.q = q
    this.hits = 0
    this.room = FOLD_CHARS
    this.found = null
    if (this.q && isBranch(v)) {
      this.found = {}
      this.beyond = {}
      this.scan(v, '', null)
      // words just asked for show every match: what holds one opens, though it was folded by hand, and a long list
      // shows all its items when one past its first matches; the same words again leave what the analyst folded since
      if (fresh) {
        for (var p in this.found) {
          delete this.folds[p]
          delete this.longs[p]
        }
        for (var b in this.beyond) this.more[b] = true
      }
    }
    this.bars = shared.bars(args)
    this.drawn = v
    var colour = this.bars.attr(v)
    var text = ''
    try {
      text = typeof v === 'string' ? v : JSON.stringify(v) || ''
    } catch (e) {}
    var body = isBranch(v)
      ? entries(v).length
        ? '<div class="thimble-record-tree">' + this.rows(v, '', 0) + '</div>'
        : '<div class="thimble-record-val is-empty">' + (Array.isArray(v) ? 'No items' : 'No fields') + '</div>'
      : '<div class="thimble-record-tree is-one">' + this.value(v, '') + '</div>'
    this.mount.innerHTML =
      '<div class="thimble-record"' + (ref ? ' data-anchor="' + esc(ref) + '" data-anchor-text="' + esc(text.slice(0, 300)) + '"' : '') + colour + '>' +
      (ref ? '<div class="thimble-record-cite" data-thimble-chrome><button type="button" class="chip chip-tone-evidence chip-act" data-record-file title="' + esc(ref) + '"><span class="chip-text">' + esc(citeLabel(ref)) + '</span></button></div>' : '') +
      body +
      '</div>'
    this.bars.watch(this.mount, this.restamp)
  }
  // a click on a key, Show more or less, Show N more or the citation; the focus stays on what was clicked
  Record.prototype.click = function (e) {
    var t = e.target && e.target.closest ? e.target : null
    // only a click on the record this drew, not on what the page drew in the mount since (another side panel's body)
    var root = t && t.closest('.thimble-record')
    if (!root || root !== this.mount.firstElementChild || !this.args) return
    var fold = t.closest('[data-fold]')
    var long = t.closest('[data-long]')
    var more = t.closest('[data-more]')
    if (t.closest('[data-record-file]')) {
      if (this.ref) thimble.navigate(this.ref, { browser: true })
      return
    }
    var attr, path
    if (fold) {
      attr = 'data-fold'
      path = fold.getAttribute(attr)
      this.folds[path] = fold.getAttribute('aria-expanded') !== 'true'
    } else if (long) {
      attr = 'data-long'
      path = long.getAttribute(attr)
      this.longs[path] = long.getAttribute('aria-expanded') !== 'true'
    } else if (more) {
      attr = 'data-more'
      path = more.getAttribute(attr)
      this.more[path] = true
    } else return
    var self = this
    ctl.safe(function () {
      self.draw(self.args)
    })
    var all = this.mount.querySelectorAll('[' + attr + ']')
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute(attr) === path) return all[i].focus()
  }

  // the search goes to a match folded away, or cut from view by a folded string's height: the folded value, long string
  // or long list it is in opens, with every value around it, and the record is drawn again, as a click opens them
  Record.prototype.unfold = function (el) {
    var root = el && el.closest ? el.closest('.thimble-record') : null
    if (!root || root !== this.mount.firstElementChild || !this.args) return
    if (el.classList.contains('thimble-record-text')) el = el.querySelector(':scope > [data-fold-long]') || el
    var p
    if ((p = el.getAttribute('data-fold-path')) != null) this.folds[p] = true
    else if ((p = el.getAttribute('data-fold-long')) != null) this.longs[p] = true
    else if ((p = el.getAttribute('data-fold-more')) != null) this.more[p] = true
    else return
    for (var q = p.slice(0, Math.max(0, p.lastIndexOf('/'))); q; q = q.slice(0, q.lastIndexOf('/')))
      if (!this.isOpen(q, q.split('/').length - 1)) this.folds[q] = true
    var self = this
    ctl.safe(function () {
      self.draw(self.args)
    })
  }

  /** a record's fields as a collapsible tree under its citation (see the top of this file); returns {hits}, how many
   *  places matched `find` */
  thimble.record = function (opts) {
    opts = opts || {}
    var mount = ctl.el(opts.mount)
    if (!mount) return { hits: 0 }
    var r = mount.__thimbleRecord
    if (!r) r = mount.__thimbleRecord = new Record(mount)
    ctl.safe(function () {
      r.draw(opts)
    })
    return { hits: r.hits }
  }
})()
