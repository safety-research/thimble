// page.js: one object in the browser, the other side of the terminal's `↵ open in browser`. It runs the object's
// program in the browser's sandbox (draw/browser/sandbox.js), draws it with draw/svg.js, and keeps the selection in
// the URL hash (draw/handoff.js), so the page opens on the region the terminal had selected. A click selects a
// region; its cite, its examples and its source rows (`lean resolve`, through the local server) show under the
// drawing. "back to terminal" sends the selection to the terminal, which opens its detail view on that region.
//
// Keys: tab and shift+tab move between regions, ← → flip examples, esc clears the selection, enter sends it back.
// (Bundled by serve.mjs after svg.js, handoff.js, sandbox.js and shell/object.js, so their names are in scope.)

const OBJECT = forDrawing(JSON.parse(document.getElementById('object').textContent))
const BASE = JSON.parse(document.getElementById('base').textContent)
const KIT_SOURCE = document.getElementById('kit-src').textContent
const PAGE_CW = 7.8
const sandbox = makeSandbox(KIT_SOURCE)
const measureType = canvasMeasure(document)
const $ = sel => document.querySelector(sel)
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const view = { region: null, cite: null, hover: null, wForced: null, drawing: null, result: null, ex: 0, said: null, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }
const resolved = new Map()

function columns() { return view.wForced || Math.max(60, Math.min(140, Math.floor(($('#stage').clientWidth - 8) / PAGE_CW))) }
function selection() { return { object: OBJECT.id, v: OBJECT.v, region: view.region || undefined } }

async function load() {
  view.drawing = await sandbox.run(OBJECT, { w: columns(), h: 24 })
  if (view.region && !regionMeta(view.drawing, view.region)) view.region = null
  head()
  words()
  draw()
}

function head() {
  $('#head').innerHTML = `<h1>${esc(OBJECT.title || OBJECT.id)}</h1><span class="id">${esc(objectRef(OBJECT))}</span>
    <span class="back"><span class="said" id="said"></span><button id="back" title="enter">back to terminal</button></span>
    ${OBJECT.question ? `<p class="q">${esc(OBJECT.question)}</p>` : ''}`
  said()
}

function said() {
  const el = $('#said')
  if (!el) return
  const s = view.said
  el.className = 'said' + (s && s.ok ? ' ok' : '')
  el.innerHTML = !s ? (view.region ? `carries ▸ ${esc(view.region)}` : 'carries the object')
    : s.ok ? `sent: the terminal shows ${esc(s.region ? '▸ ' + s.region : s.object)}`
    : `not sent (${esc(s.error)}); in the terminal type <code>${esc(toCommand(selection(), 'obj'))}</code>`
}

// the object's words, each citation a link that opens its rows
function words() {
  const text = String(OBJECT.text || '')
  if (!text) { $('#words').innerHTML = ''; return }
  let i = 0
  const html = esc(text).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, ref) => `<a data-cite="${i++}" data-ref="${ref}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')
  $('#words').innerHTML = `<p>${html}</p>`
}

function draw() {
  const res = renderSvg(view.drawing, { w: columns(), cw: PAGE_CW, measure: measureType, selected: view.region, hover: view.hover, theme: view.theme })
  view.result = res
  $('#stage').innerHTML = res.svg
  detail()
  history.replaceState(null, '', toHash({ ...selection(), w: view.wForced || undefined }))
  said()
}

function rowsTable(records) {
  if (!records || !records.length) return ''
  return `<table class="rows"><tbody>${records.map(r => `<tr><td class="ref">${esc(r.ref)}</td><td title="${esc(r.text)}">${esc(r.text)}</td></tr>`).join('')}</tbody></table>`
}

function plainTable(rows) {
  if (!rows || !rows.length) return ''
  const keys = []
  rows.forEach(r => Object.keys(r || {}).forEach(k => { if (!keys.includes(k) && k !== '_rows') keys.push(k) }))
  return `<table class="rows"><thead><tr>${keys.map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${keys.map(k => `<td class="${typeof r[k] === 'number' ? 'num' : ''}">${esc(typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}

function fillFmt(fmt, rec) {
  const filled = esc(String(fmt).replace(/\{([\w.]+)\}/g, (m, key) => {
    const v = key.split('.').reduce((x, p) => (x == null ? undefined : x[p]), rec)
    return v === undefined ? m : '\u0000' + String(v).replace(/\*/g, '\u0001') + '\u0000'
  }))
  return filled.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\u0000/g, '').replace(/\u0001/g, '*').replace(/\n/g, '<br>')
}

// the source rows behind refs: fetched once each from the local server, drawn as they come
function rowsFor(refs, how) {
  if (!refs.length) return ''
  return refs.slice(0, 3).map(ref => {
    const r = resolved.get(ref)
    if (r === undefined) {
      resolved.set(ref, null)
      fetch(`${BASE}/resolve?ref=${encodeURIComponent(ref)}&n=5`).then(x => x.json()).then(j => { resolved.set(ref, j); detail() }, e => { resolved.set(ref, { error: String(e) }); detail() })
    }
    if (!r) return `<section><h4>rows</h4><p class="dim">resolving <code>${esc(ref)}</code>…</p></section>`
    const c = chainWords(r)
    const more = r.count != null && r.count > c.records.length ? `<p class="more">+ ${(r.count - c.records.length).toLocaleString('en-US')} more · <code>lean resolve ${esc(ref)}</code></p>` : ''
    const code = (r.chain || []).find(s => s.step === 'query' && s.code)
    return `<section><h4>rows <span class="dim">${how && how !== 'named' ? '· ' + esc(how) : ''}</span></h4>
      ${c.error ? `<p class="problem">${esc(c.notes[0])}</p>` : `<p>← ${esc(c.line)}</p>`}
      ${c.error ? '' : c.notes.map(n => `<p class="note">${esc(n)}</p>`).join('')}
      ${rowsTable(c.records)}${more}
      ${code ? `<details><summary>the code of ${esc(code.id)}</summary><pre>${esc(code.code)}</pre></details>` : ''}</section>`
  }).join('')
}

function detail() {
  const box = $('#detail')
  const d = view.drawing
  if (view.cite != null) {
    const c = objectRefs(OBJECT)[view.cite]
    box.innerHTML = c ? `<div class="head"><b>${esc(c.label)}</b><span class="id">${esc(c.ref)}</span></div>${c.problem ? `<p class="problem">${esc(c.problem)}</p>` : ''}${rowsFor([c.ref], 'cited in the words')}` : ''
    return
  }
  const r = view.result.regions.find(x => x.id === view.region)
  if (!r) {
    const n = view.result.regions.filter(x => x.rects.length).length
    box.innerHTML = `<p class="hint">${n} part${n === 1 ? '' : 's'} · click one or press tab · <b>back to terminal</b> carries what you select</p>`
    return
  }
  const cite = r.meta.cite && d.cites[r.meta.cite]
  const ex = r.meta.examples && d.examples[r.meta.examples]
  let html = `<div class="head"><b>${esc(r.meta.label || r.id)}</b><span class="id">${esc(r.id)}</span></div>`
  if (cite) {
    html += `<section><h4>cite</h4>${cite.text ? `<p>${esc(cite.text)}</p>` : ''}<p class="src">${cite.source ? esc(cite.source) : ''}${cite.query ? ` · <code>${esc(cite.query)}</code>` : ''}</p>${plainTable(cite.rows)}${cite.more ? `<p class="more">+ ${esc(cite.more.toLocaleString('en-US'))} more rows</p>` : ''}${cite.note ? `<p class="note">${esc(cite.note)}</p>` : ''}</section>`
  }
  const { refs, how } = regionRefs(OBJECT, d, r.id)
  html += rowsFor(refs, how)
  if (ex && ex.records.length) {
    const i = ((view.ex % ex.records.length) + ex.records.length) % ex.records.length
    const rec = ex.records[i]
    html += `<section><h4>examples <span class="dim">${i + 1} of ${esc(ex.total.toLocaleString('en-US'))}${ex.label ? ' · ' + esc(ex.label) : ''}</span> <button data-ex="-1">‹</button><button data-ex="1">›</button></h4>`
    html += ex.fmt && rec && typeof rec === 'object' ? `<blockquote>${fillFmt(ex.fmt, rec)}</blockquote>` : plainTable([rec])
    html += `</section>`
  }
  if (r.meta.note) html += `<p class="note">${esc(r.meta.note)}</p>`
  box.innerHTML = html
}

function select(id) { view.region = id; view.cite = null; view.ex = 0; view.said = null; draw() }
function step(dir) {
  const list = view.result.regions.filter(r => r.rects.length).slice().sort((a, b) => a.rects[0].y - b.rects[0].y || a.rects[0].x - b.rects[0].x)
  if (!list.length) return
  const i = list.findIndex(r => r.id === view.region)
  select(list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length].id)
}

async function back() {
  const sel = selection()
  try {
    const r = await fetch(`${BASE}/back`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sel) })
    view.said = r.ok ? { ok: true, ...sel } : { error: `the server said ${r.status}` }
  } catch (e) {
    view.said = { error: 'the terminal is not listening' }
  }
  said()
}

$('#stage').addEventListener('click', e => { const t = e.target.closest('[data-region]'); select(t ? t.dataset.region : null) })
$('#stage').addEventListener('mousemove', e => {
  const t = e.target.closest('[data-region]')
  const id = t ? t.dataset.region : null
  if (id !== view.hover) { view.hover = id; draw() }
})
$('#stage').addEventListener('mouseleave', () => { if (view.hover) { view.hover = null; draw() } })
$('#words').addEventListener('click', e => { const a = e.target.closest('a[data-cite]'); if (a) { view.cite = Number(a.dataset.cite); view.region = null; draw() } })
$('#detail').addEventListener('click', e => { const b = e.target.closest('button[data-ex]'); if (b) { view.ex += Number(b.dataset.ex); detail() } })
$('#head').addEventListener('click', e => { if (e.target.closest('#back')) back() })
addEventListener('keydown', e => {
  if (e.key === 'Tab') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
  else if (e.key === 'Escape') select(null)
  else if (e.key === 'Enter' && !e.target.closest('button')) back()
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { view.ex += e.key === 'ArrowRight' ? 1 : -1; detail() }
})
addEventListener('resize', () => { if (!view.wForced) load() })

// the handoff: #o=<id>@<v>&r=<region>&w=<columns>
const sel0 = fromHash(location.hash)
if (sel0 && sel0.object === OBJECT.id) { view.region = sel0.region || null; view.wForced = sel0.w || null }
load().then(() => { document.body.dataset.ready = '1' })
