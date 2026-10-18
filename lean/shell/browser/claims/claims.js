// claims.js: the Claims page. The session's claims (thimble/claims/<session>.json, CONTRACT 7) drawn as a force graph
// on a canvas, with no library. A dot is a claim, in the color of its cluster, larger when it was said again (×N), and
// hollow when a later claim revised it; a faint ? beside it says its denominator or window was not stated. Each
// cluster is named above its claims. No line is drawn at rest. Pointing at a claim shows the card of what it means and
// draws its links (a revision as a faint dashed amber line); the rest fades. A click opens the message where it was
// said. Replay (or r) grows the graph again in the order the claims were made; any key stops it.
//
// It reads the store from the page server (/api/claims, with its ETag) and asks again every few seconds while the page
// is visible, so the claims a later turn adds grow in place.
(function () {
  'use strict'
  const $ = (s, r) => (r || document).querySelector(s)
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // ------------------------------------------------------------------------------------------------ where it reads
  const params = new URLSearchParams(location.search)
  const HASH = location.hash
  const READY = /(^|[#&])ready\b/.test(HASH)
  const EMBED = params.get('embed') === '1'
  const token = location.pathname.split('/').filter(Boolean)[0] || ''
  const BASE = params.get('base') || (token && token !== 'claims' ? '/' + token : '')
  const SRC = params.get('src') || `${BASE}/api/claims`
  const POLL_MS = 2500
  const enc = encodeURIComponent
  if (EMBED) document.documentElement.classList.add('embed')

  // ------------------------------------------------------------------------------------------------ colors
  const PAL = ['#1f5fbf', '#d7781f', '#0f5b3a', '#1f9e8f', '#7a6a12', '#b34a7a', '#6d4fd8', '#8a5a2b']
  const PAL_DARK = ['#6aa2f0', '#f0a050', '#4fbf86', '#4fd0c0', '#c9b54a', '#ea86b2', '#a593f5', '#d09a66']
  let DARK = false
  const T = { bg: '#fcfbf8', ink: '#1f1e1c', ink2: '#4a4945', mut: '#85837c', halo: 'rgba(252,251,248,.92)', warn: '#b7791f', edge: '#9c978d' }
  function readTheme() {
    const cs = getComputedStyle(document.documentElement)
    const v = n => cs.getPropertyValue(n).trim()
    DARK = (matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light') || document.documentElement.dataset.theme === 'dark'
    Object.assign(T, { bg: v('--view'), ink: v('--ink'), ink2: v('--ink2'), mut: v('--mut'), halo: v('--halo'), warn: v('--warn') })
    T.edge = DARK ? '#8f8c85' : '#9c978d'
    T.font = getComputedStyle(document.body).fontFamily
  }
  function hexA(hex, a) {
    if (!hex || hex[0] !== '#') return hex
    const v = parseInt(hex.slice(1), 16)
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`
  }
  const solid = (c, fallback) => (String(c || '').startsWith('#') ? c : fallback)

  // ------------------------------------------------------------------------------------------------ the graph's state
  let STORE = null
  const N = []
  let byId = {}
  let EDGES = []
  const CLUSTERS = []
  let CBY = {}
  const S = { hover: null, loaded: false, etag: '', replaying: 0 }
  let seed = 17
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

  const colorOf = n => { const c = CBY[n.cluster]; return c ? c.color : T.mut }
  const radiusOf = n => Math.min(12, 5.2 + Math.sqrt(Math.max(0, n.n - 1)) * 2.8)
  // revised once the claim that revises it is there (a replay grows it later)
  const revised = (n, now) => !!n.revised_by && !!byId[n.revised_by] && !(now < byId[n.revised_by].born)
  function layoutAnchors() {
    const used = CLUSTERS.filter(c => N.some(n => n.cluster === c.key))
    const m = used.length
    const rx = 170 + 14 * Math.sqrt(N.length)
    const ry = rx * 0.55
    used.forEach((c, i) => {
      const a = Math.PI + (i / Math.max(1, m)) * Math.PI * 2 + 0.3
      c.ax = m === 1 ? 0 : Math.cos(a) * rx
      c.ay = m === 1 ? 0 : Math.sin(a) * ry
    })
  }

  /** The store's claims and clusters into the graph; claims already there keep their place. The springs (a cluster's
   *  claims in the order said, claims said one after the other in a message, a revision) shape the layout only: no
   *  line is drawn for them. */
  function ingest(store) {
    const claims = (Array.isArray(store.claims) ? store.claims : []).filter(c => c && c.id != null && c.text)
    const clusters = (Array.isArray(store.clusters) ? store.clusters : []).filter(c => c && c.id != null)
    const loose = claims.some(c => !c.cluster || !clusters.some(k => String(k.id) === String(c.cluster)))
    for (const c of [...clusters, ...(loose ? [{ id: null, name: 'between clusters' }] : [])]) {
      const key = c.id == null ? '' : String(c.id)
      if (CBY[key]) { CBY[key].name = String(c.name || key); continue }
      const i = CLUSTERS.filter(x => x.id != null).length
      const k = { id: c.id == null ? null : key, key, name: String(c.name || 'between clusters'), i, cx: 0, cy: 0, ax: 0, ay: 0, lx: 0 }
      k.color = k.id == null ? '#9c978d' : (DARK ? PAL_DARK : PAL)[i % PAL.length]
      CLUSTERS.push(k)
      CBY[key] = k
    }
    const keep = new Set(claims.map(c => String(c.id)))
    for (let i = N.length - 1; i >= 0; i--) if (!keep.has(N[i].id)) N.splice(i, 1)
    const added = []
    claims.forEach((c, i) => {
      const id = String(c.id)
      const cluster = c.cluster != null && CBY[String(c.cluster)] ? String(c.cluster) : ''
      const said = (Array.isArray(c.said) ? c.said : []).filter(p => p && typeof p === 'object')
      const sources = (Array.isArray(c.sources) ? c.sources : []).map(s => (typeof s === 'string' ? { ref: s, label: s } : s)).filter(s => s && s.ref)
      const fields = {
        text: String(c.text), by: c.by || 'claude', cluster, turn: typeof c.turn === 'number' ? c.turn : null, said, sources, n: Math.max(1, said.length),
        revises: c.revises || null, revised_by: c.revised_by || null, order: i, row: said[0] && said[0].row, start: said[0] && typeof said[0].start === 'number' ? said[0].start : 0,
        precisely: c.precisely || '', based_on: c.based_on || '', judgment: c.judgment || '', unstated: c.unstated || '',
      }
      if (byId[id]) Object.assign(byId[id], fields)
      else {
        const n = Object.assign({ id, x: 0, y: 0, vx: 0, vy: 0, live: false, born: 0, va: 1, hv: 0, adj: [] }, fields)
        N.push(n)
        added.push(n)
      }
    })
    byId = {}
    N.sort((a, b) => a.order - b.order)
    N.forEach(n => { byId[n.id] = n; n.adj = []; n.r = radiusOf(n) })
    EDGES = []
    const link = (a, b, t) => { if (!a || !b || a === b) return; const e = { a, b, t }; EDGES.push(e); a.adj.push({ n: b, t, e }); b.adj.push({ n: a, t, e }) }
    const lastIn = {}
    const lastRow = {}
    N.forEach(n => {
      if (lastIn[n.cluster]) link(lastIn[n.cluster], n, 'c')
      lastIn[n.cluster] = n
      const prev = n.row && lastRow[n.row]
      if (prev && prev.cluster !== n.cluster) link(prev, n, 'm')
      if (n.row) lastRow[n.row] = n
    })
    N.forEach(n => { if (n.revised_by && byId[n.revised_by]) link(n, byId[n.revised_by], 'r') })
    layoutAnchors()
    return added
  }

  /** The claims a claim links to, as the terminal's graph has them (shell/claimgraph.js neighbours): the revision it is
   *  part of, the claims said just before and after it in the same message, those that share a source (six at most). */
  function neighbours(n) {
    const out = new Map()
    if (n.revised_by && byId[n.revised_by]) out.set(byId[n.revised_by], 'revised')
    if (n.revises && byId[n.revises]) out.set(byId[n.revises], 'revised')
    if (n.row) {
      const same = N.filter(x => x.row === n.row).sort((a, b) => a.start - b.start)
      const k = same.indexOf(n)
      for (const x of [same[k - 1], same[k + 1]]) if (x && !out.has(x)) out.set(x, 'link')
    }
    const refs = new Set(n.sources.map(s => s.ref))
    for (const x of N) {
      if (out.size >= 6) break
      if (x !== n && !out.has(x) && x.sources.some(s => refs.has(s.ref))) out.set(x, 'link')
    }
    out.delete(n)
    return out
  }

  /** The claims in the order they were made: by turn, the person's words before Claude's in a turn, the corpus
   *  orientation's last, and in the order said. */
  function madeOrder() {
    const rank = n => [n.turn == null ? 1e9 : n.turn, n.by === 'person' ? 0 : n.by === 'orientation' ? 2 : 1, n.order]
    return N.slice().sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] })
  }

  // ------------------------------------------------------------------------------------------------ the simulation
  const SIM = { alpha: 0, target: 0, decay: 1 - Math.pow(0.001, 1 / 320), vdecay: 0.56 }
  const live = () => N.filter(n => n.live)
  function tick() {
    const L = live()
    const a = SIM.alpha
    if (a < 0.002) return
    for (let i = 0; i < L.length; i++) {
      const p = L[i]
      for (let j = i + 1; j < L.length; j++) {
        const q = L[j]
        let dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy
        if (l2 > 360000) continue
        if (l2 < 1) { dx = rnd() - 0.5; dy = rnd() - 0.5; l2 = dx * dx + dy * dy }
        const w = ((p.cluster === q.cluster ? -130 : -230) * a) / Math.max(l2, 120)
        p.vx += dx * w; p.vy += dy * w; q.vx -= dx * w; q.vy -= dy * w
      }
    }
    for (const e of EDGES) {
      const s = e.a, t = e.b
      if (!s.live || !t.live) continue
      const cross = s.cluster !== t.cluster
      const dist = e.t === 'r' ? 70 : cross ? 150 : 42
      const str = e.t === 'm' ? 0.04 : e.t === 'r' ? (cross ? 0.08 : 0.4) : 0.5
      let dx = t.x + t.vx - s.x - s.vx, dy = t.y + t.vy - s.y - s.vy
      let l = Math.sqrt(dx * dx + dy * dy) || 1
      l = ((l - dist) / l) * a * str
      dx *= l; dy *= l
      t.vx -= dx * 0.5; t.vy -= dy * 0.5; s.vx += dx * 0.5; s.vy += dy * 0.5
    }
    for (const c of CLUSTERS) {
      const ms = L.filter(n => n.cluster === c.key)
      if (!ms.length) continue
      let cx = 0, cy = 0
      ms.forEach(n => { cx += n.x; cy += n.y })
      cx /= ms.length; cy /= ms.length
      c.cx = cx; c.cy = cy
      const g = 0.1 * a * Math.min(1, ms.length / 3)
      ms.forEach(n => {
        n.vx += (cx - n.x) * g + (c.ax - n.x) * 0.02 * a
        n.vy += (cy - n.y) * g + (c.ay - n.y) * 0.02 * a
      })
    }
    const discs = []
    for (const c of CLUSTERS) {
      const ms = L.filter(n => n.cluster === c.key)
      if (!ms.length) continue
      let s2 = 0
      ms.forEach(n => { s2 += (n.x - c.cx) ** 2 + (n.y - c.cy) ** 2 })
      discs.push({ ms, x: c.cx, y: c.cy, r: Math.sqrt(s2 / ms.length) * 1.3 + 34 })
    }
    for (let i = 0; i < discs.length; i++) {
      for (let j = i + 1; j < discs.length; j++) {
        const p = discs[i], q = discs[j]
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1
        const gap = p.r + q.r - d
        if (gap <= 0) continue
        const f = (gap / d) * 0.12 * a
        const wp = q.ms.length / (p.ms.length + q.ms.length), wq = 1 - wp
        p.ms.forEach(n => { n.vx -= dx * f * wp; n.vy -= dy * f * wp })
        q.ms.forEach(n => { n.vx += dx * f * wq; n.vy += dy * f * wq })
      }
    }
    L.forEach(n => { n.vx *= SIM.vdecay; n.vy *= SIM.vdecay; n.x += n.vx; n.y += n.vy })
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const p = L[i], q = L[j]
        const min = p.r + q.r + 12
        let dx = q.x - p.x, dy = q.y - p.y
        const l2 = dx * dx + dy * dy
        if (l2 >= min * min) continue
        const l = Math.sqrt(l2) || 0.01, m = ((min - l) / l) * 0.5 * 0.7
        dx *= m; dy *= m
        p.x -= dx; p.y -= dy; q.x += dx; q.y += dy
      }
    }
    SIM.alpha += (SIM.target - SIM.alpha) * SIM.decay
  }
  const reheat = v => { SIM.alpha = Math.max(SIM.alpha, v) }
  function place(n) {
    const nb = n.adj.map(x => x.n).filter(m => m.live)
    const c = CBY[n.cluster]
    if (nb.length) { const m = nb[0], ang = rnd() * Math.PI * 2; n.x = m.x + Math.cos(ang) * 30; n.y = m.y + Math.sin(ang) * 30 }
    else if (c) { const has = N.some(m => m.live && m.cluster === c.key); n.x = (has ? c.cx : c.ax) + (rnd() - 0.5) * 40; n.y = (has ? c.cy : c.ay) + (rnd() - 0.5) * 40 }
    else { n.x = (rnd() - 0.5) * 60; n.y = (rnd() - 0.5) * 60 }
    n.vx = n.vy = 0
    n.live = true
  }
  function settle(now) {
    SIM.target = 0.28
    SIM.alpha = 0.5
    N.forEach((n, i) => { place(n); for (let k = 0; k < 3; k++) tick(); if (i % 8 === 7) reheat(0.5) })
    for (let i = 0; i < 260; i++) tick()
    SIM.target = 0
    for (let i = 0; i < 420; i++) tick()
    grow(now, READY ? 0 : 2000)
  }
  /** Each claim born in the order made, over `ms`: the graph grows. */
  function grow(now, ms) {
    const order = madeOrder()
    const step = order.length ? Math.min(140, ms / order.length) : 0
    order.forEach((n, i) => { n.born = now + i * step })
    return order.length * step
  }

  // ------------------------------------------------------------------------------------------------ the replay
  const btn = $('#replay')
  const btnWords = $('#replay span')
  let replayEnd = 0
  /** Where a replay is: "turn 2 of 4" (the turn of the claim it grew last), "the corpus", or "replay". */
  function replayWhere(now) {
    let last = null
    for (const n of N) if (n.born <= now && (!last || n.born > last.born)) last = n
    if (!last) return 'replay'
    if (last.by === 'orientation') return 'the corpus'
    const turns = N.map(n => n.turn).filter(t => t != null)
    return last.turn == null ? 'replay' : `turn ${last.turn} of ${Math.max(...turns)}`
  }
  function replay() {
    S.hover = null
    hideCard()
    const now = performance.now()
    replayEnd = now + grow(now, 3200) + 600
    S.replaying = replayEnd
    btn.classList.add('on')
    btnWords.textContent = 'replay'
  }
  function stopReplay() {
    if (!S.replaying) return false
    const now = performance.now()
    N.forEach(n => { n.born = Math.min(n.born, now - 1200) })
    S.replaying = 0
    btn.classList.remove('on')
    btnWords.textContent = 'Replay'
    return true
  }
  btn.addEventListener('click', e => { e.currentTarget.blur(); if (!stopReplay()) replay() })

  // ------------------------------------------------------------------------------------------------ the view
  const cv = $('#g'), gw = $('#gwrap'), ctx = cv.getContext('2d')
  let W = 900, H = 600
  const DPR = Math.max(1, window.devicePixelRatio || 1)
  function size() {
    W = gw.clientWidth; H = gw.clientHeight
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR)
    cv.style.width = W + 'px'; cv.style.height = H + 'px'
  }
  const cam = { x: 0, y: 0, k: 1.2 }
  const toScreen = n => [W / 2 + (n.x - cam.x) * cam.k, H / 2 + 8 + (n.y - cam.y) * cam.k]
  const rScreen = n => n.r * Math.max(0.8, Math.min(1.25, cam.k))
  function fitCamera(snap) {
    const L = live()
    if (!L.length) return 0
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    L.forEach(n => { x0 = Math.min(x0, n.x - n.r - 60); x1 = Math.max(x1, n.x + n.r + 60); y0 = Math.min(y0, n.y - n.r - 46); y1 = Math.max(y1, n.y + n.r + 30) })
    let k = Math.min((W - 40) / Math.max(1, x1 - x0), (H - 30) / Math.max(1, y1 - y0), 1.45)
    k = Math.max(k, 0.35)
    const tx = (x0 + x1) / 2, ty = (y0 + y1) / 2
    const f = snap ? 1 : 0.06
    const mv = Math.abs(tx - cam.x) * cam.k + Math.abs(ty - cam.y) * cam.k + Math.abs(k - cam.k) * 400
    cam.x += (tx - cam.x) * f; cam.y += (ty - cam.y) * f; cam.k += (k - cam.k) * f
    return mv
  }
  const ease = t => (t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3))
  const back = t => { if (t <= 0) return 0; if (t >= 1) return 1; const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) }
  const font = (w, px) => `${w} ${px}px ${T.font || 'sans-serif'}`

  function dot(n, sx, sy, r, alpha, now) {
    const col = colorOf(n)
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(0.1, r), 0, 7)
    if (revised(n, now)) {
      // revised: a hollow dot, nothing more
      ctx.fillStyle = hexA(solid(T.bg, '#fcfbf8'), alpha); ctx.fill()
      ctx.strokeStyle = hexA(col, Math.max(0.12, alpha)); ctx.lineWidth = 1.6; ctx.stroke()
    } else {
      ctx.fillStyle = hexA(col, Math.max(0.08, alpha)); ctx.fill()
      ctx.lineWidth = 1.5; ctx.strokeStyle = hexA(DARK ? '#191817' : '#ffffff', 0.9 * alpha); ctx.stroke()
    }
    // its denominator or window was not stated: a faint ? beside it
    if (n.unstated) { ctx.font = font(600, 10); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = hexA(col, 0.45 * Math.max(0.3, alpha)); ctx.fillText('?', sx + r + 2.5, sy - r * 0.55) }
  }

  function draw(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const L = live().filter(n => now >= n.born)
    const focus = S.hover && L.includes(S.hover) ? S.hover : null
    const near = focus ? neighbours(focus) : new Map()
    L.forEach(n => {
      const t = !focus || n === focus || near.has(n) ? 1 : 0.16
      n.va += (t - n.va) * 0.18
      n.hv += ((n === focus ? 1 : 0) - n.hv) * 0.25
    })
    // links as thin lines, a revision dashed in a faint amber: the hovered claim's, or, while a replay runs, those of
    // the claims it just grew (marked)
    const links = (n, near, alpha) => {
      const [x1, y1] = toScreen(n)
      for (const [m, kind] of near) {
        if (!L.includes(m)) continue
        const [x2, y2] = toScreen(m)
        ctx.save()
        if (kind === 'revised') { ctx.setLineDash([4, 4]); ctx.strokeStyle = hexA(solid(T.warn, '#b7791f'), 0.5 * alpha) } else ctx.strokeStyle = hexA(T.edge, 0.7 * alpha)
        ctx.lineWidth = 1.2
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
        ctx.restore()
      }
    }
    const fresh = S.replaying && !focus ? L.filter(n => now - n.born < 700) : []
    if (focus) links(focus, near, 1)
    for (const n of fresh) {
      const [sx, sy] = toScreen(n)
      ctx.beginPath(); ctx.arc(sx, sy, rScreen(n) + 7, 0, 7); ctx.fillStyle = DARK ? 'rgba(120,98,40,.55)' : 'rgba(246,227,168,.85)'; ctx.fill()
      links(n, neighbours(n), 1 - (now - n.born) / 700)
    }
    // the claims, each growing in when it is born
    L.forEach(n => {
      const [sx, sy] = toScreen(n)
      const e = back((now - n.born) / 520)
      const r = rScreen(n) * e * (1 + 0.22 * n.hv)
      const p = (now - n.born) / 1100
      if (p < 1) { ctx.beginPath(); ctx.arc(sx, sy, rScreen(n) + 4 + 16 * ease(p), 0, 7); ctx.strokeStyle = hexA(colorOf(n), 0.45 * (1 - p)); ctx.lineWidth = 1.5; ctx.stroke() }
      dot(n, sx, sy, r, n.va, now)
    })
    // the clusters' names, above their claims
    CLUSTERS.forEach(c => {
      const ms = L.filter(n => n.cluster === c.key)
      if (!ms.length) return
      let top = Infinity, cx = 0
      ms.forEach(n => { const [x, y] = toScreen(n); top = Math.min(top, y - rScreen(n)); cx += x })
      cx /= ms.length
      c.lx = c.lx ? c.lx + (cx - c.lx) * 0.2 : cx
      ctx.font = font(600, 13)
      const w = ctx.measureText(c.name).width
      const x = Math.max(6, Math.min(W - 6 - w, c.lx - w / 2)), y = Math.max(18, top - 12)
      const fade = focus && focus.cluster !== c.key ? 0.35 : 1
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
      ctx.lineWidth = 3; ctx.strokeStyle = T.halo; ctx.strokeText(c.name, x, y)
      ctx.fillStyle = hexA(solid(T.ink2, '#4a4945'), fade); ctx.fillText(c.name, x, y)
    })
    if (focus) placeCard(focus, near)
  }

  // ------------------------------------------------------------------------------------------------ the card
  const hc = $('#hc')
  let cardFor = null
  /** A sparkline of a source's values, when the claim rests on one. */
  function sparkSvg(values) {
    const v = values.filter(x => typeof x === 'number' && Number.isFinite(x))
    if (v.length < 2) return ''
    const lo = Math.min(0, ...v), hi = Math.max(...v), w = 64, h = 14
    const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 1 - ((x - lo) / (hi - lo || 1)) * (h - 2)).toFixed(1)}`).join(' ')
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`
  }
  function sourcesWords(n) {
    return n.sources.slice(0, 3).map(s => {
      const m = /^(q\d+)(?:#(.*))?$/.exec(s.ref)
      if (m) { let w = m[2] || ''; try { w = decodeURIComponent(w) } catch { /* as written */ } return [m[1], w.replace(/&/g, ' ').replace('@', ' · ')].filter(Boolean).join(' · ') }
      const [path, loc] = s.ref.split('#')
      const line = /^L(\d+)/.exec(loc || '')
      return path.split('/').pop() + (line ? ':' + line[1] : '')
    }).join(', ')
  }
  /** What the claim means, in at most five lines: ● the claim as said, precisely, based on, judgment, not stated. */
  function cardHtml(n) {
    const based = n.based_on || sourcesWords(n)
    const vals = (n.sources.find(s => Array.isArray(s.values) && s.values.length > 1) || {}).values
    const row = (k, v, cls = '') => `<div class="r ${cls}"><span class="k">${k}</span><span>${v}</span></div>`
    return `<div class="t"><i style="background:${colorOf(n)}"></i><span>${esc(n.text)}</span></div>` +
      (n.precisely ? row('precisely', esc(n.precisely)) : '') +
      (based || vals ? row('based on', `<span class="cite">${esc(based)}</span>${vals ? `<span class="cite">${sparkSvg(vals)}</span>` : ''}`) : '') +
      (n.judgment ? row('judgment', esc(n.judgment)) : '') +
      (n.unstated ? row('not stated', esc(n.unstated), 'un') : '')
  }
  /** The card beside its claim, on the side where it covers the fewest of its links. */
  function placeCard(n, near) {
    if (cardFor !== n) { hc.innerHTML = cardHtml(n); hc.classList.add('on'); cardFor = n }
    const w = hc.offsetWidth, h = hc.offsetHeight
    const [sx, sy] = toScreen(n)
    const r = rScreen(n) + 10
    const tries = [[sx + r, sy - 14], [sx - r - w, sy - 14], [sx - w / 2, sy + r], [sx - w / 2, sy - r - h], [sx + r, sy - h + 14], [sx - r - w, sy - h + 14]]
    const pts = [...near.keys()].map(toScreen)
    let best = null
    for (const [x0, y0] of tries) {
      const x = Math.max(8, Math.min(W - w - 8, x0)), y = Math.max(8, Math.min(H - h - 8, y0))
      // never over the claim itself
      if (sx > x - 6 && sx < x + w + 6 && sy > y - 6 && sy < y + h + 6) continue
      const cost = pts.filter(([px, py]) => px > x - 8 && px < x + w + 8 && py > y - 8 && py < y + h + 8).length
      if (!best || cost < best.cost) best = { x, y, cost }
      if (!cost) break
    }
    if (!best) best = { x: Math.max(8, Math.min(W - w - 8, sx + r)), y: Math.max(8, Math.min(H - h - 8, sy + r)) }
    hc.style.transform = `translate(${Math.round(best.x)}px, ${Math.round(best.y)}px)`
  }
  function hideCard() { hc.classList.remove('on'); cardFor = null }

  // ------------------------------------------------------------------------------------------------ the frame loop
  let changed = 0
  let sig = ''
  function frame(now) {
    const s = [S.hover && S.hover.id, N.length, S.replaying].join('|')
    if (s !== sig) { sig = s; changed = now }
    if (S.replaying && now > replayEnd) { S.replaying = 0; btn.classList.remove('on'); btnWords.textContent = 'Replay' }
    else if (S.replaying) { const w = replayWhere(now); if (btnWords.textContent !== w) btnWords.textContent = w }
    tick()
    const mv = fitCamera(false)
    const arriving = N.some(n => now - n.born < 1200)
    if (SIM.alpha > 0.002 || mv > 0.3 || arriving || now - changed < 1200) draw(now)
    if (!S.hover && cardFor) hideCard()
    requestAnimationFrame(frame)
  }

  // ------------------------------------------------------------------------------------------------ pointer
  const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
  function pick(px, py) {
    const now = performance.now()
    let best = null, bd = Infinity
    live().forEach(n => {
      if (now < n.born) return
      const [sx, sy] = toScreen(n), d = Math.hypot(sx - px, sy - py)
      if (d < rScreen(n) + 7 && d < bd) { best = n; bd = d }
    })
    return best
  }
  cv.addEventListener('mousemove', e => {
    const n = pick(...local(e))
    if (S.hover !== n) { S.hover = n; cv.classList.toggle('hand', !!(n && n.row)) }
  })
  cv.addEventListener('mouseleave', () => { S.hover = null })
  const post = m => { try { if (window.parent !== window) window.parent.postMessage(m, '*') } catch { /* no parent page */ } }
  /** A click on a claim: the message where it was said, in the chat around this page, or the mirror. */
  cv.addEventListener('click', e => {
    const n = pick(...local(e))
    const p = n && n.said.find(x => x.row)
    if (!p) return
    if (window.parent !== window) { post({ type: 'thimble:row', row: p.row }); return }
    window.open(`${BASE}/mirror/#row=${enc(p.row)}`, '_blank', 'noopener')
  })

  // ------------------------------------------------------------------------------------------------ keys
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // any key stops a replay
    if (stopReplay()) { e.preventDefault(); return }
    if (e.key === 'r') { replay(); e.preventDefault() }
  })

  // ------------------------------------------------------------------------------------------------ loading
  function empty(html) {
    const el = $('#empty')
    el.innerHTML = html ? `<div>${html}</div>` : ''
    el.classList.toggle('on', !!html)
    btn.style.display = html ? 'none' : ''
  }
  async function fetchStore() {
    const embedded = window.CLAIMS_STORE || (document.getElementById('claims-store') && JSON.parse(document.getElementById('claims-store').textContent))
    if (embedded) return { store: embedded }
    try {
      const headers = S.etag ? { 'if-none-match': S.etag } : {}
      const r = await fetch(SRC + (SRC.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store', headers })
      if (r.status === 304) return { same: true }
      if (!r.ok) return { error: `${r.status} ${(await r.text()).slice(0, 120)}` }
      S.etag = r.headers.get('etag') || ''
      const j = await r.json()
      const store = j && j.store ? j.store : j
      return store && Array.isArray(store.claims) ? { store } : { error: 'the answer is not a claims store' }
    } catch (e) { return { error: String(e.message || e) } }
  }
  function count() {
    const used = new Set(N.map(n => n.cluster).filter(Boolean)).size
    $('#sub').textContent = `${N.length} claim${N.length === 1 ? '' : 's'} · ${used} cluster${used === 1 ? '' : 's'}`
    document.title = `Claims · ${N.length}`
  }
  async function load(first) {
    const got = await fetchStore()
    if (got.same) return
    if (got.error) {
      if (first || !STORE) { $('#sub').textContent = 'no claims yet'; empty(`<b>No claims yet.</b><br>They are read after each turn of work in the terminal, from what Claude and you said.<br><span style="font-size:12px">(${esc(got.error)})</span>`) }
      return
    }
    const store = got.store
    if (STORE && store.updated && store.updated === STORE.updated && store.claims.length === STORE.claims.length) return
    STORE = store
    readTheme()
    if (!store.claims.length) { empty('<b>No claims yet.</b><br>They are read after each turn of work in the terminal, from what Claude and you said.'); count(); return }
    empty('')
    const added = ingest(store)
    const now = performance.now()
    if (!S.loaded) {
      settle(now)
      fitCamera(true)
      S.loaded = true
    } else if (added.length) {
      added.forEach((n, i) => { place(n); n.born = now + i * 200 })
      SIM.target = 0
      reheat(0.35)
    }
    if (cardFor) { const n = cardFor; cardFor = null; if (byId[n.id]) placeCard(byId[n.id], neighbours(byId[n.id])) }
    count()
  }

  readTheme()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); CLUSTERS.forEach(c => { if (c.id != null) c.color = (DARK ? PAL_DARK : PAL)[c.i % PAL.length] }); changed = performance.now() })
  addEventListener('resize', () => { size(); changed = performance.now() })
  if (window.ResizeObserver) new ResizeObserver(() => { size(); changed = performance.now() }).observe(gw)
  // the page around this one can point at a claim: its card shows, as on a hover
  addEventListener('message', e => { const m = e.data; if (m && m.type === 'thimble:open-claim' && byId[m.claim]) { S.hover = byId[m.claim]; changed = performance.now() } })
  size()
  const FIXED = !!window.CLAIMS_STORE
  load(true).then(() => {
    requestAnimationFrame(frame)
    document.body.dataset.ready = '1'
    setInterval(() => { if (document.visibilityState === 'visible' && !FIXED) load(false) }, POLL_MS)
  })
  window.Claims = {
    S, N, CLUSTERS, cam, replay, stopReplay, get byId() { return byId },
    nodeAt(id) { const n = byId[id]; if (!n) return null; const [x, y] = toScreen(n); const r = cv.getBoundingClientRect(); return [r.left + x, r.top + y] },
    hover(id) { S.hover = byId[id] || null; changed = performance.now() },
    card: () => (hc.classList.contains('on') ? hc.innerText : ''),
    where: () => (S.replaying ? btnWords.textContent : ''),
  }
})()
