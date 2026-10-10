// thimble's messages for a view's page, part of the view kit: views.frame_document loads it after viewer_transcript.js
// and before viewer_search.js; viewer_parts.css styles it (.thimble-msg-*). It draws any conversation between people or
// agents as a chat app draws it: agents in a chat or on a board, a user and an assistant, people by mail, a pull
// request's comments. Each author's avatar stands in a rail at the left, a head with the author in bold and the time
// quiet in mono (HH:MM, the full date and time on hover), a subject in bold over the words, `to` as a quiet line under
// the head, and the words drawn by thimble.text in `format`. Consecutive messages by one author, within five minutes
// and with the same parent, share one head; a date line opens each day; a reply (`parent`) is drawn under its parent,
// one level in, deeper replies at that level too, as a board draws a thread; an event (`kind: 'event'`), something
// that happened rather than something said, such as a tool call, a task closed or a member who joined, is one line, an
// icon in the ink, the author in bold, what they did (`said`) and the time at the right; a boxed message (`box`), one
// that stands apart from the chat, such as a mail or a task's opening post, is a box beside the avatar, its head the
// author, what they did (`said`) and the time, over the words. Quoted mail (a run of lines that start with ">", with
// the "On … wrote:" line before it) folds behind a "…" button, and a body longer than twelve lines shows its first
// lines with Show more and Show less; both keep their text in the page (data-thimble-fold), so thimble.search finds it
// and opens the fold. Each message is anchored with its ref and carries data-t, so a label marks it, a ⌘-click asks
// about it, the lanes follow it and Color by draws its bar. Its bars follow the page's Color by unless it is given `color` (false
// for none), and it keeps them as Color by changes, stamping each message again in place; Color by reads
// a message's `record` when it has one, so a field of the record named as a message's own, such as `kind`, colors it.
// When the label filter hides a message that held its group's head, the next one shown takes the head. A click, Enter or Space picks a message (onPick), marked
// as the chosen one; ↑ and ↓ go to the message above or below.
//
//   const conv = thimble.messages({ mount: '#thread', format: 'plain', mentions, onPick: (m) => side.open({ ... }) })
//   conv.draw(messages, { title: '# backlog', sub, empty })   messages: [{ref, t, author, text, title, to, parent,
//                                                             kind: 'message' | 'event', icon, said, box, record}]
//                                                             an event's icon: one of ICONS' names, or {html} of the
//                                                             page's own, such as an <svg viewBox="0 0 16 16">
//   conv.reveal(ref)                                         a cited message: its folds opened, scrolled to the
//                                                             middle, its highlight fading
//   conv.set(ref, patch)                                     a message changed, such as its whole text from the reader
//   conv.messages                                            the messages as last drawn
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var shared = kit.shared
  var ctl = shared.controls
  var esc = shared.esc
  var num = shared.num

  var GROUP_S = 300 // seconds between two messages by one author with the same parent that share a head
  var FOLD_LINES = 12 // a body longer than this folds, with Show more
  var SHOW_LINES = 8 // what a folded body shows of itself, at most
  var LINE_CHARS = 100 // characters a drawn line holds, about: a longer line of text counts as several
  var HIT_MS = 1500 // how long a revealed message keeps its highlight (the transcript's)
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  // the events' icons, line drawings in the ink, a few that fit any conversation; any other name is a dot
  var ICONS = {
    note: '<path d="M2.5 3h11v7.5H7l-3 2.5v-2.5H2.5z"/>', // said aside: a comment, a remark, a review
    start: '<circle cx="8" cy="8" r="6"/><path d="M6.7 5.6v4.8L10.6 8z" fill="currentColor" stroke="none"/>', // opened, began, joined, claimed
    change: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/>', // edited, pushed, updated, renamed
    done: '<circle cx="8" cy="8" r="6"/><path d="M5.3 8.2l1.9 1.9 3.5-3.8"/>', // finished, approved, merged, resolved
    stop: '<circle cx="8" cy="8" r="6"/><rect x="5.9" y="5.9" width="4.2" height="4.2" rx=".6" fill="currentColor" stroke="none"/>', // closed, cancelled, left, ended
    again: '<path d="M12.6 7.2A4.7 4.7 0 1 0 11.4 11"/><path d="M13 3.5v3.7H9.3"/>', // reopened, retried, resumed
    link: '<path d="M7 9a2.4 2.4 0 0 0 3.4 0l2.2-2.2a2.4 2.4 0 0 0-3.4-3.4l-.7.7"/><path d="M9 7a2.4 2.4 0 0 0-3.4 0L3.4 9.2a2.4 2.4 0 0 0 3.4 3.4l.7-.7"/>', // linked, referenced, mentioned
    send: '<path d="M14 2L7.4 8.6"/><path d="M14 2L9.8 14 7.4 8.6 2 6.2z"/>', // sent, forwarded, handed off
    remove: '<path d="M2.5 4.5h11M6.5 4.5V2.5h3v2M4 4.5l.7 9h6.6l.7-9"/>', // deleted, removed
    warn: '<path d="M8 2.3l6.2 10.9H1.8z"/><path d="M8 6.6v3"/><circle cx="8" cy="11.4" r=".55" fill="currentColor" stroke="none"/>', // failed, blocked, changes asked for
    run: '<path d="M3 4.5L6.5 8 3 11.5"/><path d="M8.5 11.5H13"/>', // ran a tool or a command
  }
  // the names a forge's or a mailbox's events go by, each drawn as the icon nearest it
  var ALIASES = { comment: 'note', pull: 'start', issue: 'start', commit: 'change', edit: 'change', merge: 'done', approve: 'done', close: 'stop', reopen: 'again', changes: 'warn', delete: 'remove', mail: 'send' }
  var DOT = '<circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>'
  // an event's icon in the rail: a name of ICONS or ALIASES, a dot for any other, or {html} of the page's own (an svg,
  // which takes the ink and the stroke as the kit's own do, or a character)
  function iconHtml(icon) {
    if (icon != null && typeof icon === 'object' && icon.html != null) return '<span class="thimble-msg-ico is-own" aria-hidden="true">' + String(icon.html) + '</span>'
    var name = typeof icon === 'string' && Object.prototype.hasOwnProperty.call(ALIASES, icon) ? ALIASES[icon] : icon
    var drawing = typeof name === 'string' && Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : DOT
    return '<svg class="thimble-msg-ico" viewBox="0 0 16 16" aria-hidden="true">' + drawing + '</svg>'
  }
  var QUOTE = /^\s*>/
  var WROTE = /\swrote:\s*$/i
  var FENCE = /^\s{0,3}(`{3,}|~{3,})/

  function pad2(n) {
    return (n < 10 ? '0' : '') + n
  }
  // a time in seconds since 1970 from a number, its digits, a Date or a date as text, one with no zone in UTC; null for
  // none, such as "step 4" (kit.shared.secs, as the transcript reads times)
  var secs = shared.secs
  function utc(s) {
    return new Date(s * 1000)
  }
  function dayKey(s) {
    var d = utc(s)
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
  }
  // a date line's words: Thu, Aug 28, 2026, in UTC as the kit writes times
  function dayName(s) {
    var d = utc(s)
    return DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear()
  }
  function hm(s) {
    var d = utc(s)
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
  }
  // the time on hover, as the transcript's head writes it: YYYY-MM-DD HH:MM:SS
  function full(s) {
    return utc(s).toISOString().slice(0, 19).replace('T', ' ')
  }
  function timeHtml(s, cls, day) {
    if (s == null) return ''
    var d = utc(s)
    var words = (day ? MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ' ' : '') + hm(s)
    return '<time class="' + cls + '" datetime="' + esc(d.toISOString()) + '" title="' + esc(full(s)) + '">' + esc(words) + '</time>'
  }
  // an avatar's shade from its name, so people tell apart without a color (the repository example's shade)
  function shade(name) {
    var h = 0
    var s = String(name)
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
    return (0.08 + (Math.abs(h) % 9) * 0.02).toFixed(2)
  }
  // the letters on an avatar: a name's initial, and its last word's initial or its number (Gus Adeyemi GA, agent-08 A8,
  // ana.reyes@ferry.example AR)
  function initials(name) {
    var words = String(name || '').replace(/<[^>]*>/g, ' ').replace(/@\S*/g, ' ').split(/[\s._\-/]+/).filter(Boolean)
    if (!words.length) return '?'
    var first = Array.from(words[0])[0]
    var last = words.length > 1 ? words[words.length - 1] : ''
    if (/^\d+$/.test(last)) return first + (String(Number(last)).length <= 2 ? String(Number(last)) : '')
    return last ? first + Array.from(last)[0] : first
  }
  function avatarHtml(name) {
    var letters = initials(name)
    return '<span class="avatar" style="--a:' + shade(name || '') + '" aria-hidden="true">' + esc(letters) + '</span>'
  }
  function count(text) {
    var n = 0
    var lines = String(text).split('\n')
    for (var i = 0; i < lines.length; i++) n += Math.max(1, Math.ceil(lines[i].length / LINE_CHARS))
    return n
  }

  // A body's parts, in order: {text} for words and {quote} for quoted mail, a run of lines that start with ">" with the
  // "On … wrote:" line (or two lines, when the address wrapped) before it. In markdown, a fence's lines are words.
  function parts(text, md) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
    var out = []
    var buf = []
    var fence = null
    function flush() {
      while (buf.length && !buf[0].trim()) buf.shift()
      while (buf.length && !buf[buf.length - 1].trim()) buf.pop()
      if (buf.length) out.push({ text: buf.join('\n') })
      buf = []
    }
    for (var i = 0; i < lines.length; ) {
      var line = lines[i]
      var f = md ? FENCE.exec(line) : null
      if (f) fence = fence == null ? f[1] : line.trim().indexOf(fence) === 0 ? null : fence
      if (fence == null && !f && !QUOTE.test(line)) {
        var k = WROTE.test(line) && /^\s*On\s/i.test(line) ? 1 : /^\s*On\s/i.test(line) && i + 1 < lines.length && WROTE.test(lines[i + 1]) && !QUOTE.test(lines[i + 1]) ? 2 : 0
        var j = i + k
        while (k && j < lines.length && !lines[j].trim()) j++
        if (k && j < lines.length && QUOTE.test(lines[j])) {
          var last = j
          for (var e = j; e < lines.length && (QUOTE.test(lines[e]) || !lines[e].trim()); e++) if (QUOTE.test(lines[e])) last = e
          flush()
          out.push({ quote: lines.slice(i, last + 1).join('\n') })
          i = last + 1
          continue
        }
      }
      buf.push(line)
      i++
    }
    flush()
    return out
  }
  // A text cut where about `budget` lines of it show: at its last blank line in the second half of them, else at the
  // budget's line, a markdown fence closed there and opened again after it; a first line longer than the budget at a
  // space. [shown, the rest]
  function split(text, budget, md) {
    var lines = text.split('\n')
    var used = 0
    var best = -1
    var fence = null
    var opener = ''
    var i = 0
    for (; i < lines.length; i++) {
      var c = Math.max(1, Math.ceil(lines[i].length / LINE_CHARS))
      if (used + c > budget) break
      used += c
      var f = md ? FENCE.exec(lines[i]) : null
      if (f) {
        if (fence == null) {
          fence = f[1]
          opener = lines[i]
        } else if (lines[i].trim().indexOf(fence) === 0) fence = null
      }
      if (fence == null && !lines[i].trim() && used >= budget / 2) best = i
    }
    if (i === 0) {
      var line = lines[0]
      var at = line.lastIndexOf(' ', budget * LINE_CHARS)
      if (at <= 0) at = budget * LINE_CHARS
      return [line.slice(0, at).replace(/\s+$/, ''), [line.slice(at).replace(/^\s+/, '')].concat(lines.slice(1)).join('\n')]
    }
    if (best > 0) return [lines.slice(0, best).join('\n'), lines.slice(best + 1).join('\n')]
    var shown = lines.slice(0, i)
    var rest = lines.slice(i)
    if (fence != null) {
      shown.push(fence)
      rest.unshift(opener)
    }
    return [shown.join('\n'), rest.join('\n')]
  }
  // A body longer than FOLD_LINES (a folded quote counts as its one line): the parts that show while it is folded and
  // the rest; null when it is short
  function cut(ps, md) {
    var total = 0
    for (var i = 0; i < ps.length; i++) total += ps[i].quote != null ? 1 : count(ps[i].text)
    if (total <= FOLD_LINES) return null
    var budget = SHOW_LINES
    var head = []
    for (var k = 0; k < ps.length; k++) {
      var p = ps[k]
      if (p.quote != null) {
        if (budget < 1) break
        head.push(p)
        budget -= 1
        continue
      }
      var c = count(p.text)
      if (c <= budget) {
        head.push(p)
        budget -= c
        continue
      }
      if (budget < 1) break
      var two = split(p.text, budget, md)
      if (two[0]) head.push({ text: two[0] })
      return { head: head, rest: (two[1] ? [{ text: two[1] }] : []).concat(ps.slice(k + 1)) }
    }
    return { head: head, rest: ps.slice(k) }
  }

  function textOf(m) {
    return m.text == null ? '' : String(m.text)
  }
  function isEvent(m) {
    return m.kind === 'event'
  }
  // a message drawn in a box of its own, one that stands apart from the chat, such as a mail or a task's opening post
  function isBoxed(m) {
    return !!m.box && !isEvent(m)
  }
  // a value given as text or as {html}, as thimble.recordCard takes its parts
  function words(v) {
    return v != null && typeof v === 'object' && v.html != null ? String(v.html) : esc(v == null ? '' : v)
  }
  function plainOf(v) {
    return v != null && typeof v === 'object' && v.html != null ? String(v.html).replace(/<[^>]*>/g, '') : v == null ? '' : String(v)
  }

  var HOSTED = typeof WeakMap === 'function' ? new WeakMap() : null // a mount -> the messages it holds, which new ones there retire

  function Messages(opts) {
    var self = this
    this.mount = ctl.el(opts.mount)
    this.dead = false
    this.bars = shared.bars(opts)
    this.restampAll = function () {
      if (!self.dead) self.recolour()
    }
    this.format = opts.format === 'plain' ? 'plain' : 'markdown'
    this.mentions = Array.isArray(opts.mentions) ? opts.mentions : null // as thimble.text takes them, such as #123 or @agent-08
    this.onPick = typeof opts.onPick === 'function' ? opts.onPick : null
    this.list = [] // the messages as given
    this.rows = [] // as drawn: {m, key, s, cont, reply, day (its date differs from the line above it), line and lineNode
    //                (the date line it opens), lead (it takes its group's head under the label filter), node}
    this.opened = {} // `${key}\n${fold}` -> true while a fold shows, `fold` "more" or "q<i>"
    this.chosen = null // the key of the message picked last, marked as the open one is (.active)
    this.o = {}
    if (!this.mount) return
    var before = HOSTED && HOSTED.get(this.mount)
    if (before) before.retire()
    if (HOSTED) HOSTED.set(this.mount, this)
    this.mount.classList.add('thimble-msg-list')
    this.heard = {
      click: function (e) {
        self.click(e)
      },
      // Enter or Space on a message picks it; ↑ and ↓ go to the message above or below
      keydown: function (e) {
        var node = e.target
        if (!self.onPick || !node.classList || !node.classList.contains('thimble-msg') || !self.mount.contains(node)) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          self.pick(node)
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          var next = self.step(node, e.key === 'ArrowDown' ? 1 : -1)
          if (!next) return
          e.preventDefault()
          next.focus({ preventScroll: true })
          if (typeof next.scrollIntoView === 'function') next.scrollIntoView({ block: 'nearest' })
        }
      },
      // the search goes to a match in a fold: that fold opens, and the folds around it
      'thimble-unfold': function (e) {
        if (!e.target || !e.target.closest) return
        var node = e.target.closest('.thimble-msg')
        var row = node && self.rowOf(node)
        if (!row) return
        for (var f = e.target; f && f !== node; f = f.parentElement) {
          var k = f.getAttribute('data-fold-key')
          if (k) self.opened[row.key + '\n' + k] = true
        }
        self.redraw(row)
      },
    }
    for (var type in this.heard) this.mount.addEventListener(type, this.heard[type])
    // the label filter hides a record's element (viewer_bridge.js data-thimble-drop): the heads and date lines follow
    if (typeof MutationObserver === 'function') {
      this.watch = new MutationObserver(function () {
        if (!self.dead) self.relead()
      })
      this.watch.observe(this.mount, { subtree: true, attributes: true, attributeFilter: ['data-thimble-drop'] })
    }
    // a chosen message is the view changed from how it opens, as the row opened is: Reset leaves none chosen
    if (typeof shared.part === 'function')
      this.checkReset = shared.part({
        changed: function () {
          return !self.dead && self.chosen != null && self.mount.isConnected
        },
        reset: function () {
          if (!self.dead) self.choose(null)
        },
      })
  }
  // made again on its mount: the one before hears and draws nothing more
  Messages.prototype.retire = function () {
    this.dead = true
    for (var type in this.heard) this.mount.removeEventListener(type, this.heard[type])
    if (this.watch) this.watch.disconnect()
  }
  function gone(node) {
    return node.getAttribute('data-thimble-drop') === 'hide'
  }
  // The heads and date lines as the label filter leaves the messages: a message whose group lost every message above it
  // takes the head itself (row.lead), and a date line with no message left under it hides. Only the messages whose head
  // changes are drawn again.
  Messages.prototype.relead = function () {
    var headShown = false
    var day = null // the date line over the rows since, and whether a message under it shows
    var dayShown = false
    for (var i = 0; i < this.rows.length; i++) {
      var row = this.rows[i]
      if (!row.node) continue
      if (row.lineNode) {
        if (day) day.hidden = !dayShown
        day = row.lineNode
        dayShown = false
      }
      if (!row.cont) headShown = false
      if (gone(row.node)) continue
      dayShown = true
      var lead = row.cont && !headShown
      headShown = true
      if (!!row.lead !== lead) {
        row.lead = lead
        this.redraw(row)
      }
    }
    if (day) day.hidden = !dayShown
  }
  // the message `dir` (1 or -1) from `node` that the label filter leaves, or null
  Messages.prototype.step = function (node, dir) {
    var all = this.mount.querySelectorAll('.thimble-msg')
    var at = Array.prototype.indexOf.call(all, node)
    for (var i = at + dir; at >= 0 && i >= 0 && i < all.length; i += dir) if (!gone(all[i])) return all[i]
    return null
  }
  // what Color by reads of a message: its record, else the message
  function recordOf(m) {
    return m.record != null ? m.record : m
  }
  Messages.prototype.colourAttr = function (m) {
    return this.bars.attr(recordOf(m))
  }
  // Color by's choices changed: each message's bar stamped again in place, so the folds and the scroll stay
  Messages.prototype.recolour = function () {
    var nodes = this.mount.querySelectorAll('.thimble-msg')
    for (var i = 0; i < nodes.length; i++) {
      var row = this.rowOf(nodes[i])
      if (row) this.bars.stamp(nodes[i], recordOf(row.m))
    }
  }
  Messages.prototype.rowOf = function (node) {
    return this.rows[Number(node.getAttribute('data-msg'))] || null
  }
  Messages.prototype.isOpen = function (row, fold) {
    return !!this.opened[row.key + '\n' + fold]
  }
  // whether message `b` shares the head of message `a` before it: both messages (no event), by one author, with the same
  // parent, within GROUP_S of each other on the same day, or both without a time
  function follows(a, b) {
    if (!a || isEvent(a) || isEvent(b) || isBoxed(a) || isBoxed(b)) return false
    if (String(a.author == null ? '' : a.author) !== String(b.author == null ? '' : b.author)) return false
    if (String(a.parent == null ? '' : a.parent) !== String(b.parent == null ? '' : b.parent)) return false
    var x = secs(a.t)
    var y = secs(b.t)
    if (x == null || y == null) return x == null && y == null
    return Math.abs(y - x) <= GROUP_S && dayKey(x) === dayKey(y)
  }
  // The rows in the order they are drawn: each message whose parent is not drawn, in the order given; after the last of
  // those that share its head, the replies to any of them, in the order given, one level in however deep they are
  Messages.prototype.layout = function () {
    var list = this.list
    var byRef = {}
    for (var i = 0; i < list.length; i++) if (list[i].ref != null && byRef[String(list[i].ref)] == null) byRef[String(list[i].ref)] = i
    // the message a reply hangs under: its farthest drawn ancestor; in a loop of parents, the loop's first message given,
    // so every message of the loop is drawn
    var roots = {}
    function rootOf(i) {
      var path = []
      var place = {}
      var at = i
      var root = null
      while (root == null) {
        if (roots[at] != null) {
          root = roots[at]
          break
        }
        place[at] = path.length
        path.push(at)
        var p = list[at].parent
        var up = p == null || p === '' ? null : byRef[String(p)]
        if (up == null) root = at
        else if (place[up] != null) {
          root = up
          for (var c = place[up]; c < path.length; c++) root = Math.min(root, path[c])
        } else at = up
      }
      for (var q = 0; q < path.length; q++) roots[path[q]] = root
      return root
    }
    var kids = {}
    var tops = []
    for (var k = 0; k < list.length; k++) {
      var r = rootOf(k)
      if (r === k) tops.push(k)
      else (kids[r] = kids[r] || []).push(k)
    }
    var order = [] // [index, reply]
    for (var g = 0; g < tops.length; ) {
      var run = [tops[g]]
      while (g + run.length < tops.length && follows(list[run[run.length - 1]], list[tops[g + run.length]])) run.push(tops[g + run.length])
      var replies = []
      run.forEach(function (idx) {
        order.push([idx, false])
        replies = replies.concat(kids[idx] || [])
      })
      replies.sort(function (a, b) { return a - b }).forEach(function (idx) {
        order.push([idx, true])
      })
      g += run.length
    }
    var rows = []
    var lastDay = null
    var prev = null
    order.forEach(function (o) {
      var m = list[o[0]]
      var reply = o[1]
      var s = secs(m.t)
      var day = s != null ? dayKey(s) : null
      var row = { m: m, key: m.ref != null && m.ref !== '' ? String(m.ref) : '#' + o[0], s: s, reply: reply, cont: false, day: false, line: null }
      // a date line opens each day; a reply sits under its parent whatever its day, its time saying its date
      if (!reply && day != null && day !== lastDay) {
        row.line = dayName(s)
        lastDay = day
      }
      if (reply && day != null && lastDay != null && day !== lastDay) row.day = true
      row.cont = !row.line && !!prev && prev.reply === reply && follows(prev.m, m)
      rows.push(row)
      prev = row
    })
    this.rows = rows
  }
  // A body's html: its parts, words drawn by thimble.text into each .thimble-msg-text once the html is in the page
  // (fill), a quote folded behind "…" until opened, and past FOLD_LINES the rest folded behind Show more
  Messages.prototype.bodyHtml = function (row, text) {
    var md = this.format === 'markdown'
    var ps = parts(text, md)
    if (!ps.length) return ''
    var self = this
    var q = 0
    function partsHtml(list) {
      return list.map(function (p) {
        if (p.quote == null) return self.slot(p.text)
        var key = 'q' + q++
        var open = self.isOpen(row, key)
        return (
          '<div class="thimble-msg-quote">' +
          '<button type="button" class="thimble-msg-dots" data-msg-fold="' + key + '" aria-expanded="' + open + '" aria-label="' + (open ? 'Hide' : 'Show') + ' the quoted text" title="' + (open ? 'Hide' : 'Show') + ' the quoted text" data-thimble-chrome>…</button>' +
          '<div class="thimble-msg-fold" data-thimble-fold data-fold-key="' + key + '"' + (open ? '' : ' hidden') + '>' + self.slot(p.quote) + '</div>' +
          '</div>'
        )
      }).join('')
    }
    var long = cut(ps, md)
    if (!long) return '<div class="thimble-msg-body">' + partsHtml(ps) + '</div>'
    var open = this.isOpen(row, 'more')
    var button = '<button type="button" class="thimble-msg-more" data-msg-fold="more" aria-expanded="' + open + '" data-thimble-chrome>' + (open ? 'Show less' : 'Show more') + '</button>'
    if (open) return '<div class="thimble-msg-body">' + partsHtml(ps) + '</div>' + button
    return (
      '<div class="thimble-msg-body">' + partsHtml(long.head) +
      '<div class="thimble-msg-rest" data-thimble-fold data-fold-key="more" hidden>' + partsHtml(long.rest) + '</div></div>' + button
    )
  }
  // a place for words, which fill gives them
  Messages.prototype.slot = function (text) {
    this.pending.push(text)
    return '<div class="thimble-msg-text" data-msg-text="' + (this.pending.length - 1) + '"></div>'
  }
  // the words of every place under `root`, drawn by thimble.text in the format (it folds nothing in a mount: the
  // messages fold the body themselves, across its quotes), or as plain lines on a page without it
  Messages.prototype.fill = function (root) {
    var slots = root.querySelectorAll('[data-msg-text]')
    var opts = this.mentions ? { format: this.format, mentions: this.mentions } : { format: this.format }
    for (var i = 0; i < slots.length; i++) {
      var el = slots[i]
      var text = this.pending[Number(el.getAttribute('data-msg-text'))]
      el.removeAttribute('data-msg-text')
      if (text == null) continue
      if (typeof thimble.text === 'function' && ctl.safe(function () { return thimble.text(el, text, opts) }, null)) continue
      el.classList.add('is-plain')
      el.textContent = text
    }
    this.pending = []
  }
  Messages.prototype.rowHtml = function (row, i) {
    var m = row.m
    var ev = isEvent(m)
    var signed = m.author != null && m.author !== ''
    var author = signed ? String(m.author) : '(unsigned)'
    // under a shared head, unless the label filter hid every message above it in its group (relead)
    var cont = row.cont && !row.lead
    var cls = 'thimble-msg' + (ev ? ' thimble-msg-event' : '') + (isBoxed(m) ? ' is-boxed' : '') + (cont ? ' is-cont' : '') + (row.reply ? ' is-reply' : '') +
      (this.onPick ? ' is-act' : '') + (this.chosen != null && this.chosen === row.key ? ' active' : '')
    var said = ev ? plainOf(m.said) : ''
    var gist = ev ? (signed ? author + ' ' : '') + said + (textOf(m) ? ' ' + textOf(m) : '') : (m.title ? plainOf(m.title) + ' · ' : '') + textOf(m)
    var attrs =
      ' data-msg="' + i + '"' +
      (row.key.charAt(0) !== '#' ? ' data-anchor="' + esc(row.key) + '" data-anchor-text="' + esc(gist.replace(/\s+/g, ' ').trim().slice(0, 300)) + '"' : '') +
      (row.s != null ? ' data-t="' + row.s + '"' : '') +
      this.colourAttr(m) +
      (this.onPick ? ' tabindex="0"' : '')
    var body = this.bodyHtml(row, textOf(m))
    if (ev) {
      // an event with no author, such as a session that ended, says what happened alone
      return (
        '<div class="' + cls + '"' + attrs + '>' +
        '<div class="thimble-msg-rail" data-thimble-chrome>' + iconHtml(m.icon) + '</div>' +
        '<div class="thimble-msg-main"><div class="thimble-msg-line">' +
        '<span class="thimble-msg-said">' + (signed ? '<b class="thimble-msg-author" data-thimble-chrome>' + esc(author) + '</b> ' : '') + words(m.said) + '</span>' +
        timeHtml(row.s, 'thimble-msg-time', row.day) + '</div>' + body + '</div></div>'
      )
    }
    var prev = i > 0 ? this.rows[i - 1] : null
    var to = m.to != null && m.to !== '' && !(cont && prev && String(prev.m.to) === String(m.to)) ? '<div class="thimble-msg-to" data-thimble-chrome>to ' + words(m.to) + '</div>' : ''
    var subject = m.title != null && m.title !== '' ? '<div class="thimble-msg-subject">' + words(m.title) + '</div>' : ''
    if (isBoxed(m)) {
      // a box beside the avatar: its head the author, what they did and the time, as an event's line, over the words
      var inside = to + subject + body
      return (
        '<div class="' + cls + '"' + attrs + '>' +
        '<div class="thimble-msg-rail" data-thimble-chrome>' + avatarHtml(m.author) + '</div>' +
        '<div class="thimble-msg-main"><div class="thimble-msg-box">' +
        '<div class="thimble-msg-line thimble-msg-boxhead" data-thimble-chrome><span class="thimble-msg-said"><b class="thimble-msg-author">' + esc(author) + '</b>' +
        (m.said != null && m.said !== '' ? ' ' + words(m.said) : '') + '</span>' + timeHtml(row.s, 'thimble-msg-time', row.day) + '</div>' +
        (inside ? '<div class="thimble-msg-boxbody">' + inside + '</div>' : '') +
        '</div></div></div>'
      )
    }
    var head = cont ? '' : '<div class="thimble-msg-head" data-thimble-chrome><b class="thimble-msg-author">' + esc(author) + '</b>' + timeHtml(row.s, 'thimble-msg-time', row.day) + '</div>'
    var rail = cont ? timeHtml(row.s, 'thimble-msg-railtime', row.day) : avatarHtml(m.author)
    return (
      '<div class="' + cls + '"' + attrs + '>' +
      '<div class="thimble-msg-rail" data-thimble-chrome>' + rail + '</div>' +
      '<div class="thimble-msg-main">' + head + to + subject + body + '</div></div>'
    )
  }
  Messages.prototype.draw = function (messages, o) {
    if (!this.mount || this.dead) return
    this.o = o || {}
    this.list = Array.isArray(messages) ? messages.filter(function (m) { return m && typeof m === 'object' }) : []
    this.layout()
    this.pending = []
    var self = this
    var out = []
    var o2 = this.o
    if (o2.title != null) {
      var events = this.list.filter(isEvent).length
      var n = this.list.length - events
      out.push(
        '<div class="thimble-msg-header" data-thimble-chrome><span class="thimble-msg-header-title">' + esc(o2.title) + '</span>' +
        '<span class="thimble-msg-header-n">' + num(n) + (n === 1 ? ' message' : ' messages') + (events ? ' · ' + num(events) + (events === 1 ? ' event' : ' events') : '') + '</span>' +
        (o2.sub ? '<span class="thimble-msg-header-sub">' + esc(o2.sub) + '</span>' : '') + '</div>'
      )
    }
    this.rows.forEach(function (row, i) {
      if (row.line) out.push('<div class="thimble-msg-day" data-thimble-chrome><span>' + esc(row.line) + '</span></div>')
      out.push(self.rowHtml(row, i))
    })
    if (!this.rows.length) out.push('<div class="thimble-msg-none" data-thimble-chrome>' + esc(o2.empty || 'No messages') + '</div>')
    this.mount.classList.toggle('thimble-msg-headed', o2.title != null)
    this.mount.innerHTML = out.join('')
    this.bars.watch(this.mount, this.restampAll)
    this.fill(this.mount)
    var nodes = this.mount.querySelectorAll('.thimble-msg')
    for (var k = 0; k < nodes.length; k++) {
      var r = this.rows[Number(nodes[k].getAttribute('data-msg'))]
      if (!r) continue
      r.node = nodes[k]
      if (r.line) r.lineNode = nodes[k].previousElementSibling
    }
  }
  // one message drawn again in its place; a fold's button that had the focus keeps it
  Messages.prototype.redraw = function (row) {
    var node = row && row.node
    if (!node || !node.parentNode) return
    var i = this.rows.indexOf(row)
    this.pending = []
    var tmp = document.createElement('div')
    tmp.innerHTML = this.rowHtml(row, i)
    var fresh = tmp.firstChild
    this.fill(fresh)
    var had = document.activeElement && node.contains(document.activeElement) ? document.activeElement : null
    node.replaceWith(fresh)
    row.node = fresh
    if (!had) return
    var key = had.getAttribute('data-msg-fold')
    var again = had === node ? fresh : key != null ? fresh.querySelector('[data-msg-fold="' + key + '"]') : null
    if (again) again.focus({ preventScroll: true })
  }
  Messages.prototype.pick = function (node) {
    var row = this.rowOf(node)
    if (!row || !this.onPick) return
    var self = this
    this.choose(row.key)
    ctl.safe(function () {
      self.onPick(row.m)
    })
  }
  // the message with this key marked as the chosen one, or none
  Messages.prototype.choose = function (key) {
    this.chosen = key
    this.rows.forEach(function (r) {
      if (r.node) r.node.classList.toggle('active', key != null && r.key === key)
    })
    if (this.checkReset) this.checkReset()
  }
  Messages.prototype.click = function (e) {
    var t = e.target
    if (!t || !t.closest) return
    var b = t.closest('[data-msg-fold]')
    var node = t.closest('.thimble-msg')
    if (!node || !this.mount.contains(node)) return
    var row = this.rowOf(node)
    if (!row) return
    if (b) {
      var key = b.getAttribute('data-msg-fold')
      var id = row.key + '\n' + key
      var was = !!this.opened[id]
      this.opened[id] = !was
      this.redraw(row)
      // Show less: the button stays in view, the message's top with it when it was above
      var again = row.node.querySelector('[data-msg-fold="' + key + '"]')
      if (was && again && typeof again.scrollIntoView === 'function') {
        var r = again.getBoundingClientRect()
        if (r.top < 0 || r.bottom > innerHeight) again.scrollIntoView({ block: 'nearest' })
      }
      return
    }
    if (!this.onPick || t.closest('a,button,input,select,textarea,summary,label')) return
    // a drag that selected words in the message is no pick
    var sel = window.getSelection && window.getSelection()
    if (sel && !sel.isCollapsed && sel.rangeCount && node.contains(sel.getRangeAt(0).commonAncestorContainer)) return
    this.pick(node)
  }
  Messages.prototype.find = function (ref) {
    for (var i = 0; i < this.rows.length; i++) if (this.rows[i].key === String(ref)) return this.rows[i]
    return null
  }
  // a cited message: its folds opened, in the middle of its box, its highlight fading as the transcript's
  Messages.prototype.reveal = function (ref) {
    var row = this.find(ref)
    if (!row || !row.node) return false
    var ps = parts(textOf(row.m), this.format === 'markdown')
    var q = 0
    var changed = false
    for (var i = 0; i < ps.length; i++) if (ps[i].quote != null) changed = this.openFold(row, 'q' + q++) || changed
    changed = this.openFold(row, 'more') || changed
    if (changed) this.redraw(row)
    var node = row.node
    var box = this.mount
    // highlighted first, which draws it even out of view (content-visibility), so its height is its own
    node.classList.remove('thimble-msg-hit')
    void node.offsetWidth
    node.classList.add('thimble-msg-hit')
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: node.getBoundingClientRect().height > (box.clientHeight || innerHeight) ? 'start' : 'center' })
    setTimeout(function () {
      node.classList.remove('thimble-msg-hit')
    }, HIT_MS)
    return true
  }
  Messages.prototype.openFold = function (row, fold) {
    var id = row.key + '\n' + fold
    if (this.opened[id]) return false
    this.opened[id] = true
    return true
  }
  Messages.prototype.set = function (ref, patch) {
    var row = this.find(ref)
    if (!row || !patch || typeof patch !== 'object') return
    var same = true
    for (var k in patch) {
      if (k === 'author' || k === 't' || k === 'parent' || k === 'kind' || k === 'ref' || k === 'to' || k === 'box') same = same && patch[k] === row.m[k]
      row.m[k] = patch[k]
    }
    // what places it or the message after it (its author, time, parent, kind, `to` or box) draws them all again; anything
    // else draws it alone
    if (same) this.redraw(row)
    else this.draw(this.list, this.o)
  }

  /** a conversation's messages as a chat app draws them, whoever writes them (see the top of this file) */
  thimble.messages = function (opts) {
    var conv = new Messages(opts || {})
    return {
      draw: function (messages, o) {
        conv.draw(messages, o)
      },
      reveal: function (ref) {
        return conv.reveal(ref)
      },
      set: function (ref, patch) {
        conv.set(ref, patch)
      },
      /** the messages as last drawn */
      get messages() {
        return conv.list.slice()
      },
    }
  }
})()
