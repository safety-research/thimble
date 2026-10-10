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
//                                                              colour: Color by, whose bar the record takes
//
// Called again on the same mount with the same ref, it keeps what the analyst opened and folded.
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
    this.args = null
    this.hits = 0
    mount.addEventListener('click', function (e) {
      self.click(e)
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
      for (var i = 0; i < es.length; i++) if (this.scan(es[i][1], step(path, es[i][0]), Array.isArray(v) ? null : es[i][0])) hit = true
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
      var text = this.marked(v)
      var open = this.longs[path] !== undefined ? this.longs[path] : this.hits > hits
      return (
        '<span class="thimble-record-val is-str is-long"><span class="thimble-record-text' + (open ? '' : ' is-folded') + '">' + text + '</span>' +
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
          num(es.length - MANY) + ' more</button></div>'
      )
    return out.join('')
  }
  Record.prototype.draw = function (args) {
    this.args = args
    var v = parsed(args.value)
    var ref = args.ref == null || args.ref === '' ? null : String(args.ref)
    if (ref !== this.ref) {
      this.ref = ref
      this.folds = {}
      this.longs = {}
      this.more = {}
    }
    this.open = Number(args.open) >= 0 ? Number(args.open) : OPEN
    this.q = typeof args.find === 'string' ? args.find.trim().toLowerCase() : ''
    this.hits = 0
    this.found = null
    if (this.q && isBranch(v)) {
      this.found = {}
      this.scan(v, '', null)
    }
    var colour = args.colour && typeof args.colour.attr === 'function' ? ctl.safe(function () { return args.colour.attr(v) }, '') || '' : ''
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
