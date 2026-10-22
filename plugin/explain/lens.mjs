// lens.mjs: the explain and heads lenses of the observer's look (observer/lenses.mjs). Pure.
//
//   explain   explain marks on the words of the answer a reader would stop at (a term of art, a name the work coined, a
//             name from the files). Its digest: the terms already explained in this conversation (st.glossed).
//   heads     at most one important detail of the answer the analyst should know before they rely on it (a caveat said
//             in passing, a surprising fact, a limit of the scope, a correction), as an orange mark on its words that
//             opens a short card. Its digest: the heads-ups the analyst already saw (st.headsGiven).
// What each gives is placed on the words of the look's messages by explain/seam.ts explainMerge.
const bullets = xs => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '(none)')
const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])

export const explain = {
  name: 'explain',
  feature: 'lens-explain',
  option: 'explain',
  skeleton: '"glosses": []',
  read: reply => (Array.isArray(reply?.glosses) ? reply.glosses : []),
  raw: d => d?.glosses,
  digest: st => ({ GLOSSED: bullets(strs(st?.glossed).slice(-100)) }),
  when: () => [],
}

export const heads = {
  name: 'heads',
  feature: 'lens-heads',
  option: 'details',
  skeleton: '"heads": null',
  read: reply => (reply && reply.heads && typeof reply.heads === 'object' && !Array.isArray(reply.heads) ? reply.heads : null),
  raw: d => d?.heads,
  digest: st => ({ HEADS: bullets(strs(st?.headsGiven).slice(-20)) }),
  when: () => [],
}
