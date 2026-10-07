// thimble's transcript for a view's page, part of the view kit: views.frame_document loads it after viewer_side.js and
// before viewer_range.js; viewer_parts.css styles it. It draws an agent's turns as the File browser's Transcript mode
// draws them (frontend/src/files/views/transcript.tsx AgentTranscript, views/common.tsx RecordCard, files.css
// .reader-*): one card per turn, its number in a column at the left, its speaker, tool and time in a mono head, its words
// under it; a tool call and what came back, and a system record, folded to one line until opened; a long block folded to
// six lines with Expand; a thought quiet; an error in the problem red; a line between sessions. Each turn is anchored
// with its ref, so a label marks it, a ⌘-click asks about it and Color by draws its bar, and its number opens its lines
// in the File browser.
//
//   const tr = thimble.transcript({ mount: '#turns', colour, onOpen: (turn) => fetchWhole(turn) })
//   tr.draw(turns, { title: 'explorer · Run 2' })   turns: [{ref, t, speaker, kind, tool, text, input, output, error,
//                                                    session, line}], kind text | prompt | tool | thinking | system
//   tr.reveal(ref)                                  a cited turn: opened, scrolled to the middle, its highlight fading
//   tr.set(ref, {text, input, output})              a turn's words once the reader sent them whole
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var shared = kit.shared
  var ctl = shared.controls
  var esc = shared.esc
  var num = shared.num

  var FOLD_LINES = 6 // a block longer than this folds to it, with Expand (views/common.tsx COLLAPSE_LINES)
  var HIT_MS = 1500 // how long a cited turn keeps its highlight (views/common.tsx HIT_MS)
  var LINE_MAX = 200 // characters of a folded turn's one line
  var FOLDED = { tool: true, system: true, result: true }

  function lines(s) {
    return String(s == null ? '' : s).split('\n').length
  }
  function firstLine(s) {
    var line = String(s == null ? '' : s).split('\n').filter(function (l) { return l.trim() })[0] || ''
    return line.length > LINE_MAX ? line.slice(0, LINE_MAX) + '…' : line
  }
  // a time as the reader's head writes it: seconds since 1970 as YYYY-MM-DD HH:MM:SS in UTC, a string as written
  function stamp(turn) {
    if (turn.time != null && turn.time !== '') return String(turn.time)
    var t = turn.t
    if (typeof t !== 'number' || !isFinite(t)) return ''
    return new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ')
  }
  // a turn's one line while it is folded: a tool call's tool and the first telling line of its input
  function summary(turn) {
    if (turn.kind === 'tool') return (turn.tool || 'tool') + (turn.input ? '  ' + firstLine(turn.input) : '')
    return firstLine(turn.text) || '(empty)'
  }

  function Transcript(opts) {
    var self = this
    this.mount = ctl.el(opts.mount)
    this.colour = opts.colour || null
    this.onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null
    this.fold = typeof opts.fold === 'function' ? opts.fold : function (turn) { return !!FOLDED[turn.kind] }
    this.turns = []
    this.byRef = {}
    this.opened = {} // ref -> true (opened) or false (folded by hand)
    this.expanded = {} // `${ref}:${block}` -> true
    if (!this.mount) return
    this.mount.classList.add('thimble-transcript')
    this.mount.addEventListener('click', function (e) {
      self.click(e)
    })
  }
  Transcript.prototype.isOpen = function (turn) {
    var o = this.opened[turn.ref]
    return o === undefined ? !this.fold(turn) : o
  }
  Transcript.prototype.block = function (turn, k, kind, text, cls) {
    if (text == null || String(text) === '') return ''
    var key = turn.ref + ':' + k
    var long = lines(text) > FOLD_LINES
    var open = !long || this.expanded[key]
    var body = String(text)
    if (kind === 'call') {
      var nl = body.indexOf('\n')
      body = '<span class="thimble-turn-toolname">' + esc(nl < 0 ? body : body.slice(0, nl)) + '</span>' + esc(nl < 0 ? '' : body.slice(nl))
    } else body = esc(body)
    return (
      '<div class="thimble-turn-fold' + (open ? '' : ' is-folded') + '">' +
      '<div class="thimble-turn-block thimble-turn-' + kind + (cls ? ' ' + cls : '') + '">' + body + '</div>' +
      (long ? '<button type="button" class="btn btn-ghost btn-sm thimble-turn-expand" data-expand="' + esc(key) + '">' + (open ? 'Collapse' : 'Expand<span class="thimble-turn-dim">' + num(lines(text)) + ' lines</span>') + '</button>' : '') +
      '</div>'
    )
  }
  Transcript.prototype.turnHtml = function (turn, i) {
    var open = this.isOpen(turn)
    var kind = turn.kind || 'text'
    var head = esc(turn.speaker || '(unsigned)') + (turn.tool && kind === 'tool' ? '<span class="thimble-turn-tool"> · ' + esc(turn.tool) + '</span>' : '') + (stamp(turn) ? ' · ' + esc(stamp(turn)) : '')
    var body = ''
    if (!open) body = '<button type="button" class="thimble-turn-line" data-open="' + esc(turn.ref) + '">' + esc(summary(turn)) + '</button>'
    else {
      if (kind === 'tool') {
        body += this.block(turn, 0, 'call', (turn.tool || 'tool') + (turn.input != null && turn.input !== '' ? '\n' + turn.input : ''))
        body += this.block(turn, 1, 'result', turn.output != null ? turn.output : turn.result, turn.error ? 'is-error' : '')
      } else if (kind === 'thinking') body += this.block(turn, 0, 'thinking', turn.text)
      else if (kind === 'system') body += this.block(turn, 0, 'raw', turn.text)
      else body += this.block(turn, 0, 'text', turn.text, turn.error ? 'is-error' : '')
      if (!body) body = '<div class="thimble-turn-empty">(empty)</div>'
      if (this.fold(turn)) body += '<button type="button" class="btn btn-ghost btn-sm thimble-turn-expand thimble-turn-close" data-close="' + esc(turn.ref) + '">Collapse</button>'
    }
    var colour = this.colour && typeof this.colour.attr === 'function' ? this.colour.attr(turn) : ''
    var no = turn.line != null ? turn.line : i + 1
    return (
      '<div class="thimble-turn thimble-turn-k-' + esc(kind) + '" data-anchor="' + esc(turn.ref) + '" data-anchor-text="' + esc(summary(turn).slice(0, 300)) + '"' + (typeof turn.t === 'number' ? ' data-t="' + turn.t + '"' : '') + colour + '>' +
      '<button type="button" class="thimble-turn-no" data-place="' + esc(turn.ref) + '" title="Open its lines in the File browser" data-thimble-chrome>' + esc(no) + '</button>' +
      '<div class="thimble-turn-main"><div class="thimble-turn-head" data-thimble-chrome>' + head + '</div><div class="thimble-turn-body">' + body + '</div></div></div>'
    )
  }
  Transcript.prototype.draw = function (turns, o) {
    if (!this.mount) return
    o = o || {}
    var self = this
    this.turns = Array.isArray(turns) ? turns : []
    this.byRef = {}
    this.turns.forEach(function (t) {
      self.byRef[t.ref] = t
    })
    var out = []
    if (o.title != null) out.push('<div class="thimble-transcript-head" data-thimble-chrome><span class="thimble-transcript-title">' + esc(o.title) + '</span><span class="thimble-transcript-n">' + num(this.turns.length) + (this.turns.length === 1 ? ' turn' : ' turns') + '</span>' + (o.sub ? '<span class="thimble-transcript-sub">' + esc(o.sub) + '</span>' : '') + '</div>')
    var prev
    this.turns.forEach(function (t, i) {
      if (t.session != null && prev != null && t.session !== prev) out.push('<div class="thimble-transcript-session" data-thimble-chrome><span>' + esc(t.sessionName || t.session) + '</span></div>')
      if (t.session != null) prev = t.session
      out.push(self.turnHtml(t, i))
    })
    if (!this.turns.length) out.push('<div class="thimble-turn-empty thimble-transcript-none">' + esc(o.empty || 'No turn') + '</div>')
    this.mount.innerHTML = out.join('')
  }
  // one turn drawn again in its place
  Transcript.prototype.redrawTurn = function (ref) {
    var turn = this.byRef[ref]
    var node = this.find(ref)
    if (!turn || !node) return
    var i = this.turns.indexOf(turn)
    var tmp = document.createElement('div')
    tmp.innerHTML = this.turnHtml(turn, i)
    node.replaceWith(tmp.firstChild)
  }
  Transcript.prototype.find = function (ref) {
    var all = this.mount.querySelectorAll('.thimble-turn')
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-anchor') === String(ref)) return all[i]
    return null
  }
  Transcript.prototype.open = function (ref, on) {
    var turn = this.byRef[ref]
    if (!turn) return
    var was = this.isOpen(turn)
    this.opened[ref] = on === undefined ? !was : !!on
    this.redrawTurn(ref)
    if (!was && this.isOpen(turn) && this.onOpen) {
      var self = this
      ctl.safe(function () { self.onOpen(turn) })
    }
  }
  Transcript.prototype.click = function (e) {
    var t = e.target
    if (!t.closest) return
    var go = t.closest('[data-open]')
    if (go) return this.open(go.getAttribute('data-open'), true)
    var shut = t.closest('[data-close]')
    if (shut) return this.open(shut.getAttribute('data-close'), false)
    var ex = t.closest('[data-expand]')
    if (ex) {
      var key = ex.getAttribute('data-expand')
      this.expanded[key] = !this.expanded[key]
      return this.redrawTurn(key.slice(0, key.lastIndexOf(':')))
    }
    var place = t.closest('[data-place]')
    if (place) thimble.navigate(place.getAttribute('data-place'), { browser: true })
  }
  // a cited turn: opened, in the middle of its box, its highlight fading as Files' does
  Transcript.prototype.reveal = function (ref) {
    var turn = this.byRef[ref]
    if (!turn) return false
    if (!this.isOpen(turn)) this.open(ref, true)
    var node = this.find(ref)
    if (!node) return false
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: node.getBoundingClientRect().height > (this.mount.clientHeight || innerHeight) ? 'start' : 'center' })
    node.classList.remove('thimble-turn-hit')
    void node.offsetWidth
    node.classList.add('thimble-turn-hit')
    setTimeout(function () {
      node.classList.remove('thimble-turn-hit')
    }, HIT_MS)
    return true
  }
  Transcript.prototype.set = function (ref, patch) {
    var turn = this.byRef[ref]
    if (!turn || !patch) return
    for (var k in patch) turn[k] = patch[k]
    this.redrawTurn(ref)
  }
  /** a transcript's turns as the File browser's Transcript mode draws them (see the top of this file) */
  thimble.transcript = function (opts) {
    var tr = new Transcript(opts || {})
    return {
      draw: function (turns, o) {
        tr.draw(turns, o)
      },
      reveal: function (ref) {
        return tr.reveal(ref)
      },
      open: function (ref, on) {
        tr.open(ref, on)
      },
      set: function (ref, patch) {
        tr.set(ref, patch)
      },
      /** the turns as last drawn */
      get turns() {
        return tr.turns.slice()
      },
    }
  }
})()
