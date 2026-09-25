// The deck editor's layouts (report/model.ts): the picker's presets and the one a slide marks, a layout changed
// without losing the slide's cells, card slots added and removed, a card dropped onto a slide filling its slots, and
// the save carrying the slots and the grid. Invented slides; no DOM.
import { describe, expect, test } from 'vitest'
import { addSlot, applyPreset, deckBody, dropCard, editSlide, newSlide, PRESETS, presetOf, removeSlot, slotsOf, type EditSlide } from '../../src/report/model.ts'

let n = 0
const mint = () => `id${++n}`
const card = (id: string) => ({ id: `f-${id}`, cell: `card:${id}`, caption: '' })
const slide = (patch: Partial<EditSlide> = {}): EditSlide => ({ ...newSlide(mint), heading: 'Beds', lines: [{ id: 'l1', text: 'The north bed flowered.' }], ...patch })

describe('presets', () => {
  test('every preset marks itself once applied, and the picker offers the layouts asked for', () => {
    for (const p of PRESETS) expect(presetOf(applyPreset(slide(), p.id))).toBe(p.id)
    expect(PRESETS.map((p) => p.id)).toEqual(['title', 'bullets', 'paragraph', 'bullets + card', 'paragraph + card', 'card', 'two cards', 'three cards', 'four cards', 'card grid', 'quote'])
  })

  test('a layout changed away and back keeps every line and card', () => {
    const s = slide({ layout: 'figures', slots: 3, figures: [card('a'), card('b'), card('c')] })
    const alone = applyPreset(s, 'card')
    expect([slotsOf(alone), alone.figures.length, alone.lines.length]).toEqual([1, 3, 1])
    const back = applyPreset(alone, 'three cards')
    expect(back.figures.map((f) => f.cell)).toEqual(['card:a', 'card:b', 'card:c'])
    expect(applyPreset(back, 'paragraph').bullets).toBe(false)
    expect(applyPreset(applyPreset(back, 'paragraph'), 'bullets + card').bullets).toBe(true)
  })

  test('lines beside two cards still mark their preset and keep both slots when the lines turn to prose', () => {
    const two = { ...applyPreset(slide(), 'bullets + card'), slots: 2 }
    expect(presetOf(two)).toBe('bullets + card')
    expect(slotsOf(applyPreset(two, 'paragraph + card'))).toBe(2)
  })
})

describe('card slots', () => {
  test('a slot added and removed walks the layouts, and a card past the slots stays on the slide', () => {
    let s = slide()
    const steps: string[] = []
    for (let i = 0; i < 2; i++) {
      s = addSlot(s)!
      steps.push(`${presetOf(s)}:${slotsOf(s)}`)
    }
    expect(steps).toEqual(['bullets + card:1', 'bullets + card:2'])
    expect(addSlot(s)).toBeNull()
    let c = applyPreset(slide({ figures: [card('a'), card('b')] }), 'card')
    c = addSlot(c)!
    expect(presetOf(c)).toBe('two cards')
    c = addSlot(addSlot(c)!)!
    expect([presetOf(c), addSlot(c)]).toEqual(['four cards', null])
    const grid = applyPreset(c, 'card grid')
    expect(presetOf(removeSlot(grid)!)).toBe('three cards')
    const down = removeSlot(removeSlot(removeSlot(c)!)!)!
    expect([presetOf(down), down.figures.length]).toEqual(['card', 2])
    expect(presetOf(removeSlot(down)!)).toBe('title')
    expect(removeSlot(slide())).toBeNull()
    expect(addSlot(applyPreset(slide(), 'quote'))).toBeNull()
  })
})

describe('dropping a card', () => {
  test('fills the first empty slot, then adds a slot where the layout has room, then takes the last slot', () => {
    let s = applyPreset(slide(), 'three cards')
    s = dropCard(s, 'a', mint)
    s = dropCard(s, 'b', mint)
    expect([presetOf(s), s.figures.map((f) => f.cell)]).toEqual(['three cards', ['card:a', 'card:b']])
    s = dropCard(dropCard(s, 'c', mint), 'd', mint)
    expect([presetOf(s), s.figures.length]).toEqual(['four cards', 4])
    s = dropCard(s, 'e', mint)
    expect(s.figures.map((f) => f.cell)).toEqual(['card:a', 'card:b', 'card:c', 'card:e'])
  })

  test('onto the lines alone gives them a card beside them, then a second, keeping the lines', () => {
    let s = dropCard(slide(), 'a', mint)
    expect([presetOf(s), slotsOf(s)]).toEqual(['bullets + card', 1])
    s = dropCard(s, 'b', mint)
    expect([presetOf(s), slotsOf(s), s.lines.length]).toEqual(['bullets + card', 2, 1])
  })

  test('onto a slot replaces its card, a card the slide shows moves, and one past the slots comes into view', () => {
    const s = applyPreset(slide({ figures: [card('a'), card('b')] }), 'two cards')
    expect(dropCard(s, 'c', mint, 0).figures.map((f) => f.cell)).toEqual(['card:c', 'card:b'])
    expect(dropCard(s, 'a', mint, 1).figures.map((f) => f.cell)).toEqual(['card:b', 'card:a'])
    expect(dropCard(s, 'a', mint)).toBe(s)
    const alone = applyPreset(s, 'card')
    const grown = dropCard(alone, 'c', mint)
    expect([presetOf(grown), grown.figures.map((f) => f.cell)]).toEqual(['two cards', ['card:a', 'card:c', 'card:b']])
  })
})

describe('the save', () => {
  test('carries the slots and the grid, and a stored slide reads back as it was saved', () => {
    const grid = applyPreset(slide({ id: 's1', figures: [card('a')] }), 'card grid')
    const beside = { ...applyPreset(slide({ id: 's2' }), 'paragraph + card'), slots: 2, side: 'left' as const }
    const body = deckBody('Beds', [grid, beside, applyPreset(slide({ id: 's3' }), 'card')])
    expect(body.slides.map((s) => [s.layout, s.format])).toEqual([
      ['figures', { slots: 4, grid: true }],
      ['figure', { side: 'left', width: 50, slots: 2 }],
      ['card', null],
    ])
    const read = editSlide({ id: 's1', heading: 'Beds', layout: 'figures', format: { slots: 4, grid: true }, sentences: [], figures: [card('a')] })
    expect([presetOf(read), slotsOf(read)]).toEqual(['card grid', 4])
    // an older deck: a figure slide shows one card, two figures side by side as many slots as cards
    expect(slotsOf(editSlide({ id: 'o1', heading: 'Old', layout: 'figure', sentences: [], figures: [card('a'), card('b')] }))).toBe(1)
    expect(presetOf(editSlide({ id: 'o2', heading: 'Old', layout: 'figures', sentences: [], figures: [card('a'), card('b')] }))).toBe('two cards')
  })
})
