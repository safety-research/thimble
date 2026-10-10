// thimble's formatted text for a view's page, part of the view kit: views.frame_document loads it after
// viewer_controls.js, with the kit's markdown parser just before it (frontend/src/lib/kitMarkdown.ts, which vite build
// writes as kit/markdown.js), and before viewer_range.js; viewer_parts.css styles it. A record's text, such as a pull
// request's body, a comment, a post, an email or a wiki page, drawn as markdown or as plain text in thimble's look:
//
//   thimble.text('#body', pr.body, { ref: pr.ref })            draws the text in a mount and returns its element
//   thimble.text.html(post.text, { format: 'plain' })          the same as html, for recordCard's {html}, a table
//                                                              column's html or thimble.messages
//
// 'markdown', the default, is CommonMark with GitHub's tables, task lists (as disabled checkboxes), strikethrough and
// autolinks. Raw HTML in the text shows as text, never parsed, and an image is not loaded: its alt text shows in a
// neutral chip. A link to a URL shows its address on hover and opens nothing, since the frame has no network; a link to
// a corpus path, such as `runs/r3.jsonl#L88`, or to a view's unit, `view:<slug>/<key>`, opens with thimble.navigate, a
// relative path read from the folder of `ref`'s file as a browser reads it. 'plain' is the text as written, its line
// breaks kept and its URLs links. `mentions` turns matches into links that open with thimble.navigate, such as a forge's
// #123 or a board's @agent-08: [{ match: /#(\d+)/g, ref: (m) => 'view:forge/pull/' + m[1] }]. `fold` folds a text longer
// than that many lines after its first `fold` lines, with Show more and Show less (12 in html(), none in a mount); a
// line counts once per LINE_CHARS characters, as it wraps. The folded text stays in the page, hidden, in elements with
// data-thimble-fold, so thimble.search finds it and opens the fold, as a citation's quote does. `ref` is the element's
// data-anchor: a label marks it, a ⌘-click asks about it, and a quote of the record's source, its ** and ` and list
// markers and all, is found in it (viewer_bridge.js quoteNeedles). Without the parser (an unbuilt checkout) markdown
// shows as plain text.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var ctl = kit.shared.controls

  var FOLD = 12 // lines html() shows before Show more
  var LINE_CHARS = 100 // characters a line counts as one line for, as a long line wraps
  var MIN_FOLD = 4 // lines a fold hides at least; a shorter rest shows, as in the diff
  // the elements a new line starts at, and those whose spaces between their children are no text
  var BLOCK = { P: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, PRE: 1, TR: 1, HR: 1, BLOCKQUOTE: 1, SECTION: 1, DIV: 1, DT: 1, DD: 1 }
  var HOLDS = { DIV: 1, UL: 1, OL: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, BLOCKQUOTE: 1, SECTION: 1, DL: 1 }
  var NO_LINK = 'a,code,pre,button' // where a mention or a URL is never found
  var AS_WRITTEN = 'pre,.thimble-text-plain' // where the text keeps its line breaks and spaces
  var URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi
  var SCHEME = /^[a-z][a-z0-9+.-]*:/i
  var KEPT = 500 // markdown texts whose html is kept, so a list drawn again parses none of them again
  var KEPT_CHARS = 10000 // characters a text has at most for its html to be kept

  // the inert document the text is built in: an image or a link in it loads nothing
  var tpl = document.createElement('template')
  var doc = tpl.content.ownerDocument

  function make(tag, cls, text) {
    var el = doc.createElement(tag)
    if (cls) el.className = cls
    if (text != null) el.textContent = text
    return el
  }
  function tryDecode(s) {
    try {
      return decodeURI(s)
    } catch (e) {
      return s
    }
  }
  // a relative link's corpus path, read from the folder of `base` (a file's ref) as a browser reads it; a path from /
  // is from the corpus folder
  function corpusPath(href, base) {
    var hash = href.indexOf('#')
    var frag = hash >= 0 ? href.slice(hash) : ''
    var path = (hash >= 0 ? href.slice(0, hash) : href).replace(/\?.*$/, '')
    if (!path) return null
    var parts = path[0] === '/' || !base ? [] : base.split('#')[0].split('/').slice(0, -1)
    path.split('/').forEach(function (p) {
      if (p === '..') parts.pop()
      else if (p && p !== '.') parts.push(p)
    })
    return parts.length ? tryDecode(parts.join('/')) + tryDecode(frag) : null
  }
  // a link that opens a ref in thimble, or goes to a place in the text: an <a> without an address, so a link to a
  // keyboard and a screen reader by its role and tabindex
  function refLink(a, ref) {
    a.className = 'thimble-text-ref'
    a.setAttribute('data-thimble-ref', ref)
    a.setAttribute('title', ref)
    a.setAttribute('role', 'link')
    a.setAttribute('tabindex', '0')
    return a
  }
  // a link to an address outside: it shows the address and opens nothing
  function urlLink(a, url) {
    a.className = 'thimble-text-url'
    a.setAttribute('title', tryDecode(url))
    return a
  }

  // Each match of `re` in the text under `root`, outside links and code, made the element `link(m)` gives, whose text
  // is the match or its start (the rest stays text); a match it gives none for stays text
  function linkify(root, re, link) {
    var walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    var nodes = []
    for (var n = walk.nextNode(); n; n = walk.nextNode()) if (!n.parentElement.closest(NO_LINK)) nodes.push(n)
    var g = new RegExp(re.source, re.flags.indexOf('g') < 0 ? re.flags + 'g' : re.flags)
    nodes.forEach(function (t) {
      var s = t.data
      var at = 0
      var frag = null
      g.lastIndex = 0
      for (var m = g.exec(s); m; m = g.exec(s)) {
        var el = m[0] ? link(m) : null
        if (!m[0]) g.lastIndex++
        if (!el) continue
        frag = frag || doc.createDocumentFragment()
        if (m.index > at) frag.appendChild(doc.createTextNode(s.slice(at, m.index)))
        frag.appendChild(el)
        at = g.lastIndex = m.index + Math.max(1, Math.min(m[0].length, el.textContent.length))
      }
      if (!frag) return
      if (at < s.length) frag.appendChild(doc.createTextNode(s.slice(at)))
      t.parentNode.replaceChild(frag, t)
    })
  }
  // the URLs of plain text as links, a URL's closing punctuation left out as GitHub leaves it out
  function urls(root) {
    var count = function (s, c) {
      return s.split(c).length - 1
    }
    linkify(root, URL_RE, function (m) {
      var u = m[0]
      while (/[.,:;!?'"*_~\]}>]$/.test(u) || (/\)$/.test(u) && count(u, '(') < count(u, ')'))) u = u.slice(0, -1)
      return /^(?:https?:\/\/|www\.)[^/.]/i.test(u) ? urlLink(make('a', null, u), u) : null
    })
  }

  // The links micromark drew, their addresses taken off: a corpus path or a view's ref opens with thimble.navigate, a
  // link to a place in the text (a footnote) goes there, a URL shows its address; an image is its alt text in a chip
  function tidyMarkdown(root, base) {
    var a = root.querySelectorAll('a[href]')
    for (var i = 0; i < a.length; i++) {
      var href = a[i].getAttribute('href') || ''
      a[i].removeAttribute('href')
      a[i].removeAttribute('aria-describedby')
      if (href[0] === '#') {
        a[i].className = 'thimble-text-ref'
        a[i].setAttribute('data-thimble-jump', tryDecode(href.slice(1)))
        a[i].setAttribute('role', 'link')
        a[i].setAttribute('tabindex', '0')
      } else if (/^view:/i.test(href)) refLink(a[i], tryDecode(href))
      else if (SCHEME.test(href) || href.slice(0, 2) === '//') urlLink(a[i], href)
      else {
        var ref = corpusPath(href, base)
        if (ref) refLink(a[i], ref)
        else urlLink(a[i], href)
      }
    }
    var imgs = root.querySelectorAll('img')
    for (var j = 0; j < imgs.length; j++) {
      var chip = make('span', 'chip chip-sans chip-tone-neutral thimble-text-img')
      chip.appendChild(make('span', 'chip-text', imgs[j].getAttribute('alt') || 'image'))
      if (imgs[j].getAttribute('src')) chip.setAttribute('title', tryDecode(imgs[j].getAttribute('src')))
      imgs[j].parentNode.replaceChild(chip, imgs[j])
    }
    // the footnotes' heading, for a screen reader alone
    var label = root.querySelectorAll('section.footnotes > h2')
    for (var k = 0; k < label.length; k++) label[k].remove()
    // raw HTML between blocks, which micromark escapes, as a block of its own with its line breaks
    var kids = [].slice.call(root.childNodes)
    kids.forEach(function (n) {
      if (n.nodeType !== 3 || !/\S/.test(n.data)) return
      var p = make('p', 'thimble-text-plain', n.data.replace(/^\n+|\n+$/g, ''))
      root.replaceChild(p, n)
    })
  }

  // ---------------------------------------------------------------- the fold
  // Where the text's line `budget` starts: {before: element}, or {node, offset} in a text node; null when the text has
  // fewer than MIN_FOLD lines past it. A line starts at each block (a paragraph, an item, a row, a heading), each line
  // break, and every LINE_CHARS characters of a long line, at a space.
  function lineAt(root, budget) {
    var lines = 0
    var col = 0
    var started = false
    var at = null
    function brk(pos) {
      if (!started) return
      lines++
      col = 0
      started = false
      if (lines === budget && !at) at = pos
    }
    function walk(node) {
      for (var n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1) {
          if (n.classList.contains('thimble-text-more')) continue
          if (BLOCK[n.tagName]) brk({ before: n })
          if (n.tagName === 'HR' || n.tagName === 'INPUT') started = true
          walk(n)
        } else if (n.nodeType === 3) {
          var s = n.data
          var keeps = !!n.parentElement.closest(AS_WRITTEN)
          if (!keeps && !/\S/.test(s) && (node === root || HOLDS[node.tagName])) continue
          for (var i = 0; i < s.length; i++) {
            var c = s[i]
            if (c === '\n') {
              if (keeps) started = true
              brk({ node: n, offset: i + 1 })
            } else if (/\s/.test(c)) {
              if (started && ++col >= LINE_CHARS) brk({ node: n, offset: i + 1 })
            } else {
              started = true
              col++
            }
          }
        }
      }
    }
    walk(root)
    if (started) lines++
    return at && lines - budget >= MIN_FOLD ? at : null
  }
  function hide(el) {
    el.hidden = true
    el.setAttribute('data-thimble-fold', '')
    el.classList.add('thimble-text-fold')
  }
  // a node after the fold's start hidden: an element itself, a text in a span of its own (a space between blocks stays)
  function hidePart(n) {
    if (n.nodeType === 1) return hide(n)
    if (n.nodeType !== 3 || !n.data) return
    if (!/\S/.test(n.data) && !n.parentElement.closest(AS_WRITTEN)) return
    var s = make('span')
    n.parentNode.insertBefore(s, n)
    s.appendChild(n)
    hide(s)
  }
  // Everything after `at` hidden, in place, so the text opens as it was drawn: the rest of a line's text, the items of
  // a list and the rows of a table each hidden, and the blocks that follow in one fold
  function foldAt(root, at) {
    var cur = at.before || (at.offset > 0 ? at.node.splitText(at.offset) : at.node)
    while (cur && cur.parentNode !== root) {
      var parent = cur.parentNode
      for (var n = cur; n; ) {
        var next = n.nextSibling
        hidePart(n)
        n = next
      }
      var up = parent
      while (up.parentNode !== root && !up.nextSibling) up = up.parentNode
      cur = up.nextSibling
    }
    if (cur) {
      var rest = make('div')
      hide(rest)
      root.insertBefore(rest, cur)
      while (rest.nextSibling) rest.appendChild(rest.nextSibling)
    }
    var more = make('button', 'btn btn-ghost btn-sm thimble-text-more', 'Show more')
    more.type = 'button'
    more.setAttribute('aria-expanded', 'false')
    more.setAttribute('data-thimble-chrome', '')
    root.appendChild(more)
  }
  // a text's fold opened, or folded again; `on` true opens it
  function toggle(root, on) {
    var more = root.lastElementChild
    if (!more || !more.classList.contains('thimble-text-more')) return
    var open = on === undefined ? more.getAttribute('aria-expanded') !== 'true' : !!on
    var parts = root.querySelectorAll('.thimble-text-fold')
    for (var i = 0; i < parts.length; i++) if (parts[i].closest('.thimble-text') === root) parts[i].hidden = !open
    more.textContent = open ? 'Show less' : 'Show more'
    more.setAttribute('aria-expanded', String(open))
  }

  // ---------------------------------------------------------------- the text as html
  var parsed = new Map() // a markdown text -> its html, the latest KEPT
  function parse(md, text) {
    var got = parsed.get(text)
    if (got !== undefined) {
      parsed.delete(text)
    } else {
      got = md.render(text)
      if (text.length > KEPT_CHARS) return got
      if (parsed.size >= KEPT) parsed.delete(parsed.keys().next().value)
    }
    parsed.set(text, got)
    return got
  }
  function options(o, mount) {
    o = o || {}
    var fold = o.fold === undefined ? (mount ? 0 : FOLD) : Math.floor(Number(o.fold)) || 0
    return {
      format: o.format === 'plain' ? 'plain' : 'markdown',
      ref: o.ref == null || o.ref === '' ? null : String(o.ref),
      mentions: Array.isArray(o.mentions) ? o.mentions : [],
      fold: fold > 0 ? fold : 0,
    }
  }
  function build(text, o) {
    text = text == null ? '' : String(text)
    var root = make('div', 'thimble-text')
    if (o.ref) root.setAttribute('data-anchor', o.ref)
    var md = o.format === 'markdown' && window.__thimbleMarkdown
    var html = md ? ctl.safe(function () { return parse(md, text) }, null) : null
    if (html != null) {
      tpl.innerHTML = html
      root.appendChild(tpl.content)
      tidyMarkdown(root, o.ref && !/^view:/.test(o.ref) ? o.ref : null)
    } else if (text) {
      root.appendChild(make('p', 'thimble-text-plain', text))
      urls(root)
    }
    o.mentions.forEach(function (m) {
      if (!m || !m.match || typeof m.ref !== 'function') return
      var re = m.match instanceof RegExp ? m.match : new RegExp(String(m.match), 'g')
      linkify(root, re, function (hit) {
        var ref = ctl.safe(function () { return m.ref(hit) }, null)
        return ref == null || ref === '' ? null : refLink(make('a', null, hit[0]), String(ref))
      })
    })
    var at = o.fold ? lineAt(root, o.fold) : null
    if (at) foldAt(root, at)
    return root.outerHTML
  }

  // a click on Show more or less, or on a link; a ⌘-click is the bridge's, which asks about the record. It stops there,
  // so a card the text is in does not open as well
  document.addEventListener(
    'click',
    function (e) {
      if (e.metaKey || e.ctrlKey || !e.target || !e.target.closest) return
      var root = e.target.closest('.thimble-text')
      if (!root) return
      var more = e.target.closest('.thimble-text-more')
      var link = e.target.closest('.thimble-text-ref')
      if (more && more.parentNode === root) toggle(root)
      else if (link) go(link)
      else return
      e.stopPropagation()
    },
    true,
  )
  // Enter on a link opens it as a click does, and Enter or Space on Show more is the button's own click; each stops
  // there too, so a card the text is in does not take the key as well
  document.addEventListener(
    'keydown',
    function (e) {
      if (!e.target || !e.target.closest || !e.target.closest('.thimble-text')) return
      var link = e.key === 'Enter' ? e.target.closest('.thimble-text-ref') : null
      var more = e.key === 'Enter' || e.key === ' ' ? e.target.closest('.thimble-text-more') : null
      if (link) {
        e.preventDefault()
        go(link)
      } else if (!more) return
      e.stopPropagation()
    },
    true,
  )
  function go(link) {
    var ref = link.getAttribute('data-thimble-ref')
    if (ref) return thimble.navigate(ref)
    var id = link.getAttribute('data-thimble-jump')
    var root = link.closest('.thimble-text')
    var to = null
    var all = id && root ? root.querySelectorAll('[id]') : []
    for (var i = 0; i < all.length && !to; i++) if (all[i].id === id) to = all[i]
    if (!to) return
    if (to.closest('[data-thimble-fold][hidden]')) toggle(root, true)
    to.scrollIntoView({ block: 'nearest' })
  }
  // the search, or a citation's quote, goes to a match in a fold: the fold opens
  document.addEventListener('thimble-unfold', function (e) {
    var f = e.target
    var root = f && f.classList && f.classList.contains('thimble-text-fold') ? f.closest('.thimble-text') : null
    if (root) toggle(root, true)
  })

  /** a record's text as markdown or plain text, drawn in `mount` (see the top of this file): {format, ref, mentions,
   *  fold}; returns the text's element, null without a mount */
  thimble.text = function (mount, text, opts) {
    var el = ctl.el(mount)
    if (!el) return null
    el.innerHTML = build(text, options(opts, true))
    return el.firstElementChild
  }
  /** the same text as html, for a part that takes markup: recordCard's {html}, a table column's html, thimble.messages;
   *  it folds after 12 lines unless `fold` says otherwise */
  thimble.text.html = function (text, opts) {
    return build(text, options(opts, false))
  }
})()
