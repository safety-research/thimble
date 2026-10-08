// thimble's side panel for a view's page, part of the view kit: views.frame_document loads it after viewer_controls.js
// and before viewer_range.js; viewer_parts.css styles it. A record, or a row's children, open in a wide panel at the
// right of the list, never under the row: the list keeps its place and narrows beside the panel.
//
//   const side = thimble.side({ mount: '#body', width: 0.4, onClose })   `mount` holds the list; the panel stands at its
//                                                                        right and the list takes the rest
//   side.open({ title, sub, ref, html })      or render(body) in place of html; `ref` names the record it shows
//   side.close()
//
// The panel opens wide enough to read a record, `width` of the mount (0.4 by default), never narrower than `min` px. A
// drag of its left edge resizes it, a double click on the edge puts it back, and thimble keeps its width per view (as a
// share of the mount, viewer_colour.js `parts`). Escape in the panel or its × closes it.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var shared = kit.shared
  var ctl = shared.controls

  var CLOSE = '<svg class="thimble-colour-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'

  function Side(opts) {
    var self = this
    this.mount = ctl.el(opts.mount)
    this.name = 'side:' + (opts.key || (this.mount && this.mount.id) || 'side')
    this.share = Number(opts.width) > 0 && Number(opts.width) < 1 ? Number(opts.width) : 0.4
    this.min = Number(opts.min) > 0 ? Number(opts.min) : 280
    this.onClose = typeof opts.onClose === 'function' ? opts.onClose : null
    this.onResize = typeof opts.onResize === 'function' ? opts.onResize : null
    this.ref = null
    if (!this.mount) return
    this.mount.classList.add('thimble-side-host')
    this.el = document.createElement('aside')
    this.el.className = 'thimble-side'
    this.el.setAttribute('aria-label', 'Details')
    this.el.hidden = true
    this.el.innerHTML =
      '<div class="thimble-side-grip thimble-part" role="separator" aria-orientation="vertical" aria-label="Resize the panel" tabindex="0" data-thimble-chrome><span></span></div>' +
      '<div class="thimble-side-head thimble-part" data-thimble-chrome><div class="thimble-side-titles"><div class="thimble-side-title"></div><div class="thimble-side-sub"></div></div>' +
      '<button type="button" class="btn btn-ghost btn-sm btn-square thimble-side-close" aria-label="Close">' + CLOSE + '</button></div>' +
      '<div class="thimble-side-body"></div>'
    this.mount.appendChild(this.el)
    this.grip = this.el.querySelector('.thimble-side-grip')
    this.titleEl = this.el.querySelector('.thimble-side-title')
    this.subEl = this.el.querySelector('.thimble-side-sub')
    this.body = this.el.querySelector('.thimble-side-body')
    this.el.querySelector('.thimble-side-close').addEventListener('click', function () {
      self.close(true)
    })
    this.el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        self.close(true)
      }
    })
    this.grip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return
      e.preventDefault()
      self.drag = { x: e.clientX, w: self.el.getBoundingClientRect().width }
      if (self.grip.setPointerCapture) self.grip.setPointerCapture(e.pointerId)
      self.grip.setAttribute('data-drag', '')
    })
    this.grip.addEventListener('pointermove', function (e) {
      if (!self.drag) return
      self.setWidth(self.drag.w + self.drag.x - e.clientX)
    })
    var up = function () {
      if (!self.drag) return
      self.drag = null
      self.grip.removeAttribute('data-drag')
      self.keep()
    }
    this.grip.addEventListener('pointerup', up)
    this.grip.addEventListener('pointercancel', up)
    this.grip.addEventListener('dblclick', function () {
      delete ctl.kept(self.name).share
      ctl.save()
      self.fit()
    })
    this.grip.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      self.setWidth(self.el.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 1 : -1) * (e.shiftKey ? 80 : 20))
      self.keep()
    })
    // Reset puts the view back as it opens, with no panel open
    shared.part({
      changed: function () {
        return !self.el.hidden
      },
      reset: function () {
        self.close(true)
      },
    })
    if (typeof ResizeObserver === 'function') {
      var w = -1
      new ResizeObserver(function () {
        if (self.el.hidden || self.mount.clientWidth === w) return
        w = self.mount.clientWidth
        self.fit()
      }).observe(this.mount)
    }
  }
  // the width the panel takes: the share kept for the view, else the one it opens at, within its bounds
  Side.prototype.fit = function () {
    var s = ctl.kept(this.name).share
    this.setWidth((typeof s === 'number' && s > 0 && s < 1 ? s : this.share) * this.mount.clientWidth)
  }
  Side.prototype.setWidth = function (px) {
    var W = this.mount.clientWidth
    // the list keeps a third of the mount at least, the panel `min` px where the mount has room for both
    var max = Math.max(this.min, W - Math.max(240, W / 3))
    var w = Math.round(Math.max(Math.min(this.min, W * 0.9), Math.min(max, px)))
    this.el.style.width = w + 'px'
    var self = this
    if (this.onResize) ctl.safe(function () { self.onResize(w) })
  }
  Side.prototype.keep = function () {
    var W = this.mount.clientWidth
    if (!W) return
    ctl.kept(this.name).share = Math.round((this.el.getBoundingClientRect().width / W) * 1000) / 1000
    ctl.save()
  }
  Side.prototype.open = function (o) {
    if (!this.mount) return
    o = o || {}
    var was = this.el.hidden
    this.ref = o.ref != null ? String(o.ref) : null
    this.titleEl.textContent = o.title == null ? '' : String(o.title)
    this.subEl.textContent = o.sub == null ? '' : String(o.sub)
    this.subEl.hidden = !o.sub
    if (typeof o.render === 'function') {
      this.body.innerHTML = ''
      var body = this.body
      ctl.safe(function () { o.render(body) })
    } else this.body.innerHTML = o.html == null ? '' : String(o.html)
    this.body.scrollTop = 0
    this.el.hidden = false
    this.mount.classList.add('thimble-side-open')
    if (was) this.fit()
  }
  Side.prototype.close = function (byHand) {
    if (!this.mount || this.el.hidden) return
    this.el.hidden = true
    this.mount.classList.remove('thimble-side-open')
    var ref = this.ref
    this.ref = null
    this.body.innerHTML = ''
    var self = this
    if (byHand && this.onClose) ctl.safe(function () { self.onClose(ref) })
  }
  /** a wide side panel beside the list, for a record or a row's children (see the top of this file) */
  thimble.side = function (opts) {
    var s = new Side(opts || {})
    return {
      open: function (o) {
        s.open(o)
      },
      close: function () {
        s.close(false)
      },
      /** whether the panel shows */
      get isOpen() {
        return !!(s.el && !s.el.hidden)
      },
      /** the ref of the record the panel shows, or null */
      get ref() {
        return s.ref
      },
      /** the panel's body, which the page may draw into */
      get body() {
        return s.body || null
      },
      /** the panel's width in px */
      get width() {
        return s.el && !s.el.hidden ? Math.round(s.el.getBoundingClientRect().width) : 0
      },
    }
  }
})()
