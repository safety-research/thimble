// echo's hint: a phrase for this object, which the hint row and the `?` list show. Return null where the verb would
// not help. A real verb says what it would do for THIS object, as in "the 840 reruns as a curve".
export function applies(object) {
  const n = object && object.data && typeof object.data === 'object' ? Object.keys(object.data).length : 0
  return n ? `say back its ${n} part${n === 1 ? '' : 's'} of data and their rows` : null
}
