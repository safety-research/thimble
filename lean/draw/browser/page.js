// page.js: the browser demo. It runs each object's program in the sandbox, draws it with svg.js, and keeps the
// selection in the URL hash (handoff.js), so the terminal can open the browser on the same object and region, and
// the browser can hand the same selection back as a command.
//
// Keys: tab and shift+tab move between regions, ← → flip examples, esc clears the selection.
// (Bundled by build.mjs after svg.js, handoff.js and sandbox.js, so their names are in scope.)

const OBJECTS = JSON.parse(document.getElementById('objects').textContent)
const KIT_SOURCE = document.getElementById('kit-src').textContent
const PAGE_CW = 7.8
const sandbox = makeSandbox(KIT_SOURCE)
const measureType = canvasMeasure(document)
const $ = sel => document.querySelector(sel)
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const view = { ref: null, region: null, hover: null, wForced: null, drawing: null, result: null, ex: 0, theme: 'light' }

function columns() { return view.wForced || Math.max(60, Math.min(140, Math.floor(($('#stage').clientWidth - 8) / PAGE_CW))) }
function current() {
  const r = parseRef(view.ref) || {}
  return OBJECTS.find(o => o.id === r.object && (r.v == null || o.v === r.v)) || OBJECTS[0]
}

async function load() {
  const o = current()
  view.ref = objectRef(o)
  view.drawing = await sandbox.run(o, { w: columns(), h: 24 })
  if (view.region && !view.drawing.regions.some(r => r.id === view.region) && !(view.drawing.cites || {})[view.region]) view.region = null
  nav()
  draw()
}

function draw() {
  const res = renderSvg(view.drawing, { w: columns(), cw: PAGE_CW, measure: measureType, selected: view.region, hover: view.hover, theme: view.theme })
  view.result = res
  $('#stage').innerHTML = res.svg
  detail()
  const sel = { object: current().id, v: current().v, region: view.region || undefined, w: view.wForced || undefined }
  history.replaceState(null, '', toHash(sel))
}

function nav() {
  $('#objects-nav').innerHTML = OBJECTS.map(o => `<button data-ref="${esc(objectRef(o))}" class="${objectRef(o) === view.ref ? 'on' : ''}">${esc(o.title)}</button>`).join('')
}

function fillFmt(fmt, rec) {
  const filled = esc(String(fmt).replace(/\{([\w.]+)\}/g, (m, key) => {
    const v = key.split('.').reduce((x, p) => (x == null ? undefined : x[p]), rec)
    return v === undefined ? m : '\u0000' + String(v).replace(/\*/g, '\u0001') + '\u0000'
  }))
  return filled.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\u0000/g, '').replace(/\u0001/g, '*').replace(/\n/g, '<br>')
}

function rowsTable(rows) {
  if (!rows || !rows.length) return ''
  const keys = []
  rows.forEach(r => Object.keys(r || {}).forEach(k => { if (!keys.includes(k)) keys.push(k) }))
  return `<table class="rows"><thead><tr>${keys.map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${keys.map(k => `<td class="${typeof r[k] === 'number' ? 'num' : ''}">${esc(r[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}

function detail() {
  const box = $('#detail')
  const d = view.drawing
  const r = view.result.regions.find(x => x.id === view.region)
  const sel = { object: current().id, v: current().v, region: view.region || undefined }
  if (!r) {
    box.innerHTML = `<p class="hint">${view.result.regions.filter(x => x.rects.length).length} parts · tab or a click selects one · <code>${esc(toCommand(sel))}</code> opens this in the terminal</p>`
    return
  }
  const cite = r.meta.cite && d.cites[r.meta.cite]
  const ex = r.meta.examples && d.examples[r.meta.examples]
  let html = `<div class="head"><b>${esc(r.meta.label || r.id)}</b><span class="id">${esc(r.id)}</span><span class="back">back to terminal <code>${esc(toCommand(sel))}</code></span></div>`
  if (cite) {
    html += `<section><h4>cite</h4>${cite.text ? `<p>${esc(cite.text)}</p>` : ''}<p class="src">${cite.source ? esc(cite.source) : ''}${cite.query ? ` · <code>${esc(cite.query)}</code>` : ''}</p>${rowsTable(cite.rows)}${cite.more ? `<p class="more">+ ${esc(cite.more.toLocaleString('en-US'))} more rows</p>` : ''}${cite.note ? `<p class="note">${esc(cite.note)}</p>` : ''}</section>`
  }
  if (ex && ex.records.length) {
    const i = ((view.ex % ex.records.length) + ex.records.length) % ex.records.length
    const rec = ex.records[i]
    html += `<section><h4>examples <span class="dim">${i + 1} of ${esc(ex.total.toLocaleString('en-US'))}${ex.label ? ' · ' + esc(ex.label) : ''}</span> <button data-ex="-1">‹</button><button data-ex="1">›</button></h4>`
    html += ex.fmt && rec && typeof rec === 'object' ? `<blockquote>${fillFmt(ex.fmt, rec)}</blockquote>` : rowsTable([rec])
    html += `</section>`
  }
  if (r.meta.note) html += `<p class="note">${esc(r.meta.note)}</p>`
  box.innerHTML = html
}

function select(id) { view.region = id; view.ex = 0; draw() }
function step(dir) {
  const list = view.result.regions.filter(r => r.rects.length).slice().sort((a, b) => a.rects[0].y - b.rects[0].y || a.rects[0].x - b.rects[0].x)
  if (!list.length) return
  const i = list.findIndex(r => r.id === view.region)
  select(list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length].id)
}

$('#stage').addEventListener('click', e => { const t = e.target.closest('[data-region]'); select(t ? t.dataset.region : null) })
$('#stage').addEventListener('mousemove', e => {
  const t = e.target.closest('[data-region]')
  const id = t ? t.dataset.region : null
  if (id !== view.hover) { view.hover = id; draw() }
})
$('#stage').addEventListener('mouseleave', () => { if (view.hover) { view.hover = null; draw() } })
$('#objects-nav').addEventListener('click', e => { const b = e.target.closest('button[data-ref]'); if (b) { view.ref = b.dataset.ref; view.region = null; load() } })
$('#detail').addEventListener('click', e => { const b = e.target.closest('button[data-ex]'); if (b) { view.ex += Number(b.dataset.ex); detail() } })
addEventListener('keydown', e => {
  if (e.key === 'Tab') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
  else if (e.key === 'Escape') select(null)
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { view.ex += e.key === 'ArrowRight' ? 1 : -1; detail() }
})
addEventListener('resize', () => { if (!view.wForced) load() })

// the handoff: #o=<id>@<v>&r=<region>&w=<columns>
const sel0 = fromHash(location.hash)
if (sel0) { view.ref = sel0.v != null ? `${sel0.object}@${sel0.v}` : sel0.object; view.region = sel0.region || null; view.wForced = sel0.w || null }
load().then(() => { document.body.dataset.ready = '1' })
