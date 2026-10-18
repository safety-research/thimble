// route.mjs: the Atlas page's routes on the page server (shell/node/serve.mjs calls atlasRoute once, after its host
// and token checks). Until the page server serves the pages under shell/browser/ and objects as JSON itself, these
// three routes do it for Atlas:
//
//   GET /<token>/atlas/[index.html | atlas.js | atlas.css]   the page's own files, and nothing else from disk
//   GET /<token>/o/<id>.json[?v=<k>]                         the object as JSON ("atlas" names the newest atlas)
//   GET /<token>/o/<id>                                      for an atlas object: the Atlas page on it (302)
//
// It reads only the page's three files and the folder's thimble/objects/, as serve.mjs does.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FILES = { 'index.html': 'text/html; charset=utf-8', 'atlas.js': 'text/javascript; charset=utf-8', 'atlas.css': 'text/css; charset=utf-8' }

/** The id of the newest atlas object in the folder, or null. */
export function newestAtlasId(root) {
  const dir = join(root, 'thimble', 'objects')
  if (!existsSync(dir)) return null
  let best = null
  for (const f of readdirSync(dir).filter(x => /(^|-)atlas\.json$/.test(x))) {
    try {
      const o = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (Array.isArray(o?.data?.claims) && (!best || String(o.updated) > String(best.updated))) best = { id: o.id, updated: o.updated }
    } catch { /* a file being written */ }
  }
  return best ? best.id : null
}

/**
 * Answer a request for the Atlas page or an object's JSON. `parts` is the path split on "/" (parts[0], the token, is
 * checked already). Returns true when it answered.
 * @param {{root: string, token: string, objectFile: (root: string, id: string, v?: string|null) => string|null,
 *          send: (code: number, type: string, body: string, headers?: object) => void}} o
 */
export function atlasRoute(req, url, parts, { root, token, objectFile, send }) {
  if (req.method !== 'GET') return false
  if (parts[1] === 'atlas' && parts.length <= 3) {
    const name = parts[2] || 'index.html'
    if (!FILES[name]) { send(404, 'text/plain', 'not found'); return true }
    if (parts.length === 2 && !url.pathname.endsWith('/')) { send(302, 'text/plain', '', { location: `/${token}/atlas/${url.search}` }); return true }
    send(200, FILES[name], readFileSync(join(HERE, name), 'utf8'))
    return true
  }
  if (parts[1] === 'o' && parts[2] && parts.length === 3) {
    const raw = decodeURIComponent(parts[2])
    const json = raw.endsWith('.json')
    let id = json ? raw.slice(0, -5) : raw
    if (id === 'atlas') id = newestAtlasId(root) || id
    const file = objectFile(root, id, url.searchParams.get('v'))
    if (!file) {
      if (json) { send(404, 'application/json', JSON.stringify({ error: `no object ${id} in ${root}/thimble/objects` })); return true }
      return false
    }
    const text = readFileSync(file, 'utf8')
    if (json) { send(200, 'application/json', text); return true }
    let o = null
    try { o = JSON.parse(text) } catch { return false }
    if (o && o.verb === 'atlas' && Array.isArray(o.data?.claims)) {
      const hash = url.searchParams.get('r') ? `#c=${encodeURIComponent(String(url.searchParams.get('r')).replace(/^claim-/, ''))}` : ''
      send(302, 'text/plain', '', { location: `/${token}/atlas/?o=${encodeURIComponent(o.id)}${hash}` })
      return true
    }
    return false
  }
  return false
}
