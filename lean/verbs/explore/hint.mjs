// The hint for Explore: a few words on what x would let the person do with THIS object, or null when there is
// nothing to explore. It reads the object as the kernel keeps it and runs nothing, so the shell can call it on every
// object it draws. The shell puts the key in front: "x turn lr scale", "x scrub 97 steps", "x explore 28 days".
//
//   applies(object, { reply }) -> string | null
//     object  the object (thimble/objects/<id>.json), or null for a bare reply
//     reply   { text } of a reply with no object

/** What Explore would do for this object, in two or three words; null when it has nothing to explore. */
export function applies(object, o = {}) {
  if (!object) return replyHint(o.reply)
  const program = String(object.program || '')
  // a knob Claude already wrote: say what turning it changes
  const knob = /\bk\.knob\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{([^}]*)\}/.exec(program)
  if (knob) {
    const label = /label:\s*['"`]([^'"`]+)['"`]/.exec(knob[2])
    const name = label ? label[1] : knob[1]
    return /\bstep|turn|event|call|message\b/i.test(name + ' ' + knob[1]) ? `scrub ${name}` : `turn ${name}`
  }
  // a list of rows that keep their source rows: name it by its own key
  const list = rowLists(object.data).sort((a, b) => b.n - a.n)[0]
  if (list) return `explore ${list.n.toLocaleString('en-US')} ${noun(list.key, list.n)}`
  if (hasNumbers(object.data) || /\d/.test(String(object.text || ''))) return 'explore'
  return null
}

function replyHint(reply) {
  const t = String((reply && reply.text) || '')
  // a reply worth exploring states numbers about something; a reply of prose alone has nothing to turn
  const nums = t.match(/\b\d[\d,.]*%?/g) || []
  return nums.length >= 2 ? 'explore' : null
}

// arrays of objects in the data whose rows keep `_rows` (bound from `lean q`), with the key that holds them
function rowLists(data, key = 'rows', out = []) {
  if (Array.isArray(data)) {
    if (data.length && data.every(x => x && typeof x === 'object' && !Array.isArray(x)) && data.some(x => Array.isArray(x._rows) || typeof x._ref === 'string')) out.push({ key, n: data.length })
    return out
  }
  if (data && typeof data === 'object') for (const [k, v] of Object.entries(data)) if (!k.startsWith('_')) rowLists(v, k, out)
  return out
}

function hasNumbers(v, depth = 0) {
  if (depth > 6) return false
  if (typeof v === 'number') return true
  if (Array.isArray(v)) return v.some(x => hasNumbers(x, depth + 1))
  if (v && typeof v === 'object') return Object.values(v).some(x => hasNumbers(x, depth + 1))
  return false
}

// "days" stays "days"; "by_day" reads "by day"; one of them reads singular
function noun(key, n) {
  const w = String(key).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim() || 'rows'
  if (n === 1 && w.endsWith('s')) return w.slice(0, -1)
  return w
}
