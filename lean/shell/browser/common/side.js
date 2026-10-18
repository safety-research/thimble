// side.js: the sidebar every page shows: this session (the only one: the browser mirrors one terminal session) and
// the cards it saved, each a click from its detail page. Nothing in it is made up.
import { api, esc, pageUrl } from './base.js'
import { plain } from './marks.js'

const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="#d97757" stroke-width="2.5" stroke-linecap="round">' +
  [0, 30, 60, 90, 120, 150].map(a => `<line x1="12" y1="2.8" x2="12" y2="21.2"${a ? ` transform="rotate(${a} 12 12)"` : ''}/>`).join('') + '</g></svg>'

/** The session's title: its first prompt, cut. */
export const titleOf = info => {
  const t = plain(info?.title || '').replace(/\s+/g, ' ').trim()
  return t ? (t.length > 60 ? t.slice(0, 59) + '…' : t) : 'This session'
}

const ago = at => {
  if (!at) return ''
  const s = (Date.now() - Date.parse(at)) / 1000
  return !isFinite(s) ? '' : s < 90 ? 'now' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

/**
 * Draw the sidebar into `el`: {info} from api/session, {objects} from api/objects, `on` the card shown (its id), or
 * 'session' on the mirror. `live` whether the server's stream is open.
 */
export function drawSide(el, { info, objects = [], on = 'session', live = true }) {
  const folder = info?.folder || ''
  el.innerHTML = `<div class="brand">${MARK}<span>thimble</span><small>browser</small></div>
    <div class="slabel">Session</div>
    <a class="sess${on === 'session' ? ' on' : ''}" href="${pageUrl('mirror')}"><b>${esc(titleOf(info))}</b><small><span class="live${live ? '' : ' off'}"></span>${esc(folder)} · ${live ? 'live' : 'not connected'}${info?.started ? ' · ' + ago(info.started) : ''}</small></a>
    ${objects.length ? `<div class="slabel">Cards</div><div class="cardlist">${objects.map(o => `<a class="sess${on === o.id ? ' on' : ''}" href="${pageUrl('card', { o: o.id })}" data-card="${esc(o.id)}"><b>${esc(o.title)}</b><small>${esc(o.id)} · v${esc(o.version)}</small></a>`).join('')}</div>` : ''}
    <div class="sidefoot">${live ? 'one terminal session<br>127.0.0.1 · this machine only' : '<span class="down">the terminal session is not connected</span><br>open it again with /browser'}</div>`
}

/** api/session and api/objects together. */
export async function sideData() {
  const [info, objs] = await Promise.all([api('session'), api('objects')])
  return { info: info.error ? null : info, objects: objs.objects || [] }
}
