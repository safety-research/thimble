// The tour's example report (src/example/report.ts, through src/example/server.ts): what the Report asks about the
// example's report, its drafts, cards and refs is answered as thimble's server answers it; an editor's save is
// reconciled as the server reconciles it, so what the person did not change keeps its ids and comments; a lock, a
// comment, Done and Restore are kept for the frame and told on its bus; and what needs Claude, or would take the
// example out of the frame (Export), is refused with a line that says so.
import { afterEach, expect, test } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import type { DocHistory, Writeup } from '../../src/lib/types.ts'
import { NO_EXPORT, sentencesOf } from '../../src/example/report.ts'
import { createServer, EXAMPLE, NEEDS_CLAUDE } from '../../src/example/server.ts'
import { blocksFromDoc } from '../../src/report/model.ts'

const offs: (() => void)[] = []
afterEach(() => offs.splice(0).forEach((off) => off()))

const C = `/api/corpora/${EXAMPLE}`
const W = `/api/ws/${EXAMPLE}`
const R = `${W}/investigations/main/types/report`

const sentences = (d: Writeup) => d.sections.flatMap((s) => s.paragraphs.flatMap((p) => p.sentences))
const idOf = (d: Writeup, start: string) => sentences(d).find((x) => x.text.startsWith(start))!.id
const put = (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body) })
const post = (body: unknown = {}) => ({ method: 'POST', body: JSON.stringify(body) })

test('the report, its drafts, its cards and the refs it cites are the server’s own', async () => {
  const s = createServer()
  const get = async (url: string) => {
    const r = await s.answer(url)
    expect(r.status, url).toBe(200)
    return r.json()
  }
  expect((await get(`${W}/investigations/main/types`)).report).toMatchObject({ exists: true, generation: 2, renderer: 'document', open_comments: 2, name: 'Report' })
  const doc: Writeup = await get(R)
  expect(await get(`${R}/frame`)).toEqual(doc)
  expect(doc.title).toBe('How three agents fixed the gift box total')
  expect(doc.sections.map((x) => x.heading)).toEqual(['What went wrong', 'The fix', 'What is still open'])
  expect(sentences(doc)).toHaveLength(8)
  // a figure from a card, and a comment of each check that is on, on its sentence
  const figure = doc.sections[1].figures![0]
  expect(figure.caption).toMatch(/^A member now pays 49.20/)
  expect(doc.comments!.map((c) => [c.check, sentences(doc).find((x) => x.id === c.sentence_id)?.text.slice(0, 20)])).toEqual([
    ['heads-up', 'With the change, the'],
    ['explainers', 'Reading the checkout'],
  ])
  // its drafts: the first kept as it stood, the current one as it stands
  const history: DocHistory = await get(`${R}/versions`)
  expect(history.versions.map((v) => [v.n, v.current, v.words])).toEqual([
    [2, true, 169],
    [1, false, 66],
  ])
  expect(sentences(await get(`${R}/versions/1`))).toHaveLength(4)
  expect(await get(`${R}/versions/2`)).toEqual(doc)
  expect((await s.answer(`${R}/versions/7`)).status).toBe(404)
  // the cards, a figure's card resolved, and a cited record as the server resolved it
  const canvas = await get(`${W}/canvas`)
  expect(canvas.cells.map((c: { title: string }) => c.title)).toEqual(['what the step does', 'What does a member pay for a 48.00 tin in a gift box?', 'How long did each agent work, and in how many turns?'])
  expect(await get(`${C}/ref?ref=${encodeURIComponent(String(figure.cell))}`)).toMatchObject({ kind: 'cell', record: { title: 'What does a member pay for a 48.00 tin in a gift box?' } })
  const cited = await get(`${C}/ref?ref=${encodeURIComponent('agents/agent-2.jsonl#L14')}`)
  expect(cited).toMatchObject({ kind: 'record', path: 'agents/agent-2.jsonl', line: 14 })
  expect(cited.excerpt).toContain('a member pays 48.60')
})

test('an editor save keeps what the person did not change; what they changed is theirs, and a dropped passage takes its comments', async () => {
  const s = createServer()
  const told: unknown[] = []
  offs.push(bus.on('wsEvent', (e) => told.push(e)))
  const json = async (url: string, init?: RequestInit) => (await s.answer(url, init)).json()
  const doc: Writeup = await json(R)
  const wire = blocksFromDoc(doc)
  // saved as the editor holds it: every id, ref and comment stays
  const same: Writeup = await json(`${R}/blocks`, put({ ...wire, client: 'tab-1' }))
  expect(sentences(same).map((x) => [x.id, x.refs])).toEqual(sentences(doc).map((x) => [x.id, x.refs]))
  expect(same.comments).toEqual(doc.comments)
  expect(told.at(-1)).toMatchObject({ type: 'report', slug: 'report', status: 'edited', client: 'tab-1' })
  // a sentence the person changed is theirs, under a new id; the sentences around it and the comments stay
  const first = wire.blocks.find((b) => b.type === 'paragraph')!
  const changed = { ...first, text: first.text!.replace('where the right total is 49.20.', 'where the right total is 49.20, as the README says.') }
  const edited: Writeup = await json(`${R}/blocks`, put({ ...wire, blocks: wire.blocks.map((b) => (b === first ? changed : b)) }))
  const mine = sentences(edited).find((x) => x.text.endsWith('as the README says.'))!
  expect(mine).toMatchObject({ pinned: true, by: 'analyst', refs: ['agents/agent-2.jsonl#L14'] })
  expect(sentences(doc).map((x) => x.id)).not.toContain(mine.id)
  expect(idOf(edited, 'Reading the checkout')).toBe(idOf(doc, 'Reading the checkout'))
  expect(edited.comments).toHaveLength(2)
  // the paragraph with the explainer's sentence gone: its comment goes with it, the heads-up stays
  const fewer: Writeup = await json(`${R}/blocks`, put({ ...wire, blocks: wire.blocks.filter((b) => b !== first) }))
  expect(fewer.comments!.map((c) => c.check)).toEqual(['heads-up'])
  // a figure needs a card of the canvas: another card is placed, an unknown one is left out
  const team = (await json(`${W}/canvas`)).cells[2].id
  const more: Writeup = await json(`${R}/blocks`, put({ ...wire, blocks: [...wire.blocks, { id: 'fig-new', type: 'figure', cell: `card:${team}`, caption: '' }, { id: 'fig-bad', type: 'figure', cell: 'card:nope', caption: '' }] }))
  expect(more.sections.at(-1)!.figures!.map((f) => [f.id, f.cell])).toEqual([['fig-new', `card:${team}`]])
})

test('a sentence never splits inside a citation, after an initial or an abbreviation; a bare citation stays with its sentence', () => {
  expect(sentencesOf('It paid [[48.60|a.jsonl#L4]] for a 48.00 tin. A test failed.')).toEqual(['It paid [[48.60|a.jsonl#L4]] for a 48.00 tin.', 'A test failed.'])
  expect(sentencesOf('J. Smith read it, e.g. twice. It held.')).toEqual(['J. Smith read it, e.g. twice.', 'It held.'])
  expect(sentencesOf('The fee came first. [[a.jsonl#L8]] Then the discount.')).toEqual(['The fee came first. [[a.jsonl#L8]]', 'Then the discount.'])
  expect(sentencesOf('  ')).toEqual([])
})

test('a lock, a comment, Done and Restore are kept for the frame and told on its bus', async () => {
  const s = createServer()
  const told: unknown[] = []
  offs.push(bus.on('report', (e) => told.push(e)))
  const json = async (url: string, init?: RequestInit) => (await s.answer(url, init)).json()
  const doc: Writeup = await json(R)
  const para = doc.sections[0].paragraphs[0].id
  expect((await json(`${R}/locks/${para}`, put({ locked: true }))).sections[0].paragraphs[0].locked).toBe(true)
  expect((await json(`${R}/locks/${para}`, put({ locked: false }))).sections[0].paragraphs[0].locked).toBeUndefined()
  expect((await s.answer(`${R}/locks/nope`, put({ locked: true }))).status).toBe(404)
  // the person's own comment, then Done on the heads-up
  const sid = idOf(doc, 'Customers said')
  const r = await s.answer(`${R}/comments`, post({ sentence_id: sid, text: 'Is this the total the customers saw?' }))
  expect(r.status).toBe(201)
  expect(await r.json()).toMatchObject({ sentence_id: sid, author: 'analyst', status: 'open' })
  const heads = doc.comments!.find((c) => c.check === 'heads-up')!
  const done: Writeup = await json(`${R}/comments/${heads.id}/dismiss`, post())
  expect(done.comments!.map((c) => c.status)).toEqual(['dismissed', 'open', 'open'])
  expect((await json(`${W}/investigations/main/types`)).report.open_comments).toBe(2)
  // Restore: the first draft is the newest again, the person's; the second stays in History
  const restored: Writeup = await json(`${R}/versions/1/restore`, post())
  expect(restored.generation).toBe(3)
  expect(sentences(restored)).toHaveLength(4)
  const history: DocHistory = await json(`${R}/versions`)
  expect(history.versions.map((v) => [v.n, v.current, v.source, v.restored ?? null])).toEqual([
    [3, true, 'analyst', { n: 1, rev: null }],
    [2, false, 'terminal', null],
    [1, false, 'first', null],
  ])
  expect(sentences(await json(`${R}/versions/2`))).toHaveLength(8)
  // the comment on words the first draft has too follows them; the explainer, whose words it does not have, is
  // superseded
  expect(restored.comments!.filter((c) => c.status === 'open').map((c) => [c.author, sentences(restored).find((x) => x.id === c.sentence_id)?.text.slice(0, 14)])).toEqual([['analyst', 'Customers said']])
  expect(told.map((e) => (e as { status: string }).status)).toEqual(['edited', 'edited', 'commented', 'commented', 'edited'])
})

test('what needs Claude is refused with the line that says so, and Export with its own', async () => {
  const s = createServer()
  const told: unknown[] = []
  offs.push(bus.on('checks', (e) => told.push(e)))
  for (const [url, init] of [
    [`${W}/write`, post({ doc: 'report' })],
    [`${W}/report-types/new`, post({ kind: 'page' })],
    [`${W}/chats`, post({ anchor: 'report:report', text: 'why?' })],
    [`${W}/checks`, post({ name: 'Money', prompt: 'Comment on every price.' })],
    [`${W}/checks/heads-up/run`, post({ doc: 'report' })],
    [`${W}/checks/heads-up`, { method: 'PATCH', body: JSON.stringify({ prompt: 'Comment on more.' }) }],
    // a check that has not commented on the report would run on it once on
    [`${W}/checks/judgment`, { method: 'PATCH', body: JSON.stringify({ shown: true }) }],
  ] as const) {
    const r = await s.answer(url, init)
    expect(r.status, url).toBe(403)
    expect((await r.json()).detail).toBe(NEEDS_CLAUDE)
  }
  // a check that has commented turns off and on again, as its switch does
  const off = await s.answer(`${W}/checks/heads-up`, { method: 'PATCH', body: JSON.stringify({ shown: false }) })
  expect(await off.json()).toMatchObject({ id: 'heads-up', shown: false })
  expect((await (await s.answer(`${W}/checks`)).json()).find((c: { id: string }) => c.id === 'heads-up').shown).toBe(false)
  expect(told).toEqual([{ id: 'heads-up' }])
  // Export lists the server's formats, none of which leaves the frame
  const formats = (await (await s.answer(`${R}/exports`)).json()).formats
  expect(formats.map((f: { name: string; ok: boolean; why: string }) => [f.name, f.ok, f.why])).toEqual([
    ['Markdown', false, NO_EXPORT],
    ['HTML', false, NO_EXPORT],
    ['PDF', false, NO_EXPORT],
  ])
  expect((await s.answer(`${R}/export/markdown`)).status).toBe(409)
})
