// The explain lens: explain marks on the words of the answer a reader would stop at (a term of art, a name the work
// coined, a name from the files). Its digest is the terms already explained in this session; what the person opened
// and asked is in the session the pass reads. Its merge hands the marks to the observer, which places them by their
// words in the answer's record and remembers each term placed (shell/message.js glossesOf).
const bullets = xs => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '(none)')

export default {
  name: 'explain',
  feature: 'lens-explain',
  skeleton: '"glosses": []',
  read: reply => (Array.isArray(reply?.glosses) ? reply.glosses : []),
  raw: d => d?.glosses,
  digest: st => ({ GLOSSED: bullets((st.glossed || []).slice(-100)) }),
  when: () => [],
  async merge(list, ctx) {
    ctx.glosses = list
  },
}
