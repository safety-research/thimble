// The claims lens: the turn's claims with what each means (precisely, based on, judgment, not stated), each claim said
// again by its id, each correction with the id it revises, and the renames of grown clusters. Its digest is the
// claims and clusters so far; its merge places them in the session's Claims (verbs/claims/claims.js applyTurn, through
// the observer, which knows the turn's messages).
import { claimless, grownLines, nearLines, promptLines } from '../../../verbs/claims/claims.js'

export default {
  name: 'claims',
  feature: 'lens-claims',
  skeleton: '"claims": []',
  read: reply => ({ claims: Array.isArray(reply?.claims) ? reply.claims : [], clusters: Array.isArray(reply?.clusters) ? reply.clusters : [] }),
  raw: d => (d ? { claims: d.claims, clusters: d.clusters } : null),
  // the claims so far: all of them ({{CLAIMS}}, lens-claims v1), or those that bear on this turn ({{NEAR}}, v2), so the
  // digest stays about the same size as the session grows
  digest: st => {
    if (!st.store) return { CLAIMS: '(none yet)', NEAR: '(none yet)', LEFT_OUT: '', CLUSTERS: '(none yet)', GROWN: '' }
    const sofar = promptLines(st.store)
    const near = nearLines(st.store, st.turnText || '')
    const grown = st.grown || []
    return {
      CLAIMS: sofar.claims, NEAR: near.claims, LEFT_OUT: near.left ? `; ${near.left} older claims that share no words with it are left out` : '',
      CLUSTERS: sofar.clusters, GROWN: grown.length ? `\nGrown clusters, which you can rename or split:\n${grownLines(grown)}\n` : '',
    }
  },
  // a turn whose words state nothing that could be true or false: the fragment's `quiet` rule (v2) says to give none
  when: st => (st.turnText != null && claimless(st.turnText) ? ['quiet'] : []),
  async merge(value, ctx) {
    await ctx.claims(value)
  },
}
