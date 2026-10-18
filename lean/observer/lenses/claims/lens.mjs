// The claims lens: the turn's claims with what each means (precisely, based on, judgment, not stated), each claim said
// again by its id, each correction with the id it revises, and the renames of grown clusters. Its digest is the
// claims and clusters so far; its merge places them in the session's Claims (verbs/claims/claims.js applyTurn, through
// the observer, which knows the turn's messages).
import { grownLines, promptLines } from '../../../verbs/claims/claims.js'

export default {
  name: 'claims',
  feature: 'lens-claims',
  skeleton: '"claims": []',
  read: reply => ({ claims: Array.isArray(reply?.claims) ? reply.claims : [], clusters: Array.isArray(reply?.clusters) ? reply.clusters : [] }),
  raw: d => (d ? { claims: d.claims, clusters: d.clusters } : null),
  digest: st => {
    if (!st.store) return { CLAIMS: '(none yet)', CLUSTERS: '(none yet)', GROWN: '' }
    const sofar = promptLines(st.store)
    const grown = st.grown || []
    return { CLAIMS: sofar.claims, CLUSTERS: sofar.clusters, GROWN: grown.length ? `\nGrown clusters, which you can rename or split:\n${grownLines(grown)}\n` : '' }
  },
  when: () => [],
  async merge(value, ctx) {
    await ctx.claims(value)
  },
}
