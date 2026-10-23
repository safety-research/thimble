// chips.tsx: the Client module that draws the squeeze chips under an answer (ui.ts names it by this file and hands it
// what to draw as props). It holds no logic of the chips: it draws them and sends the hooks module what the person
// did, and the hooks answer with the chips as they are now.
//
//   props: {items: [{id, n, name, levels, level, word, picked}], plus: what is typed after + (null when nothing is),
//           catchup: {n, replies} (null when the row offers no catch-up), width, ack}
//   one row of chips, wrapped to the width: each its digit, its name, its dots and its level (`1 Length ○●○○○ short`),
//   the picked chip in the warning color; then the catch-up, when replies piled up (`4 Catch up on 2 replies`); then
//   `+`, which adds a chip of the person's own; then `s close`, its key drawn as the bar draws its keys, which closes
//   the chips (not while words are typed after +, where s is a letter)
//
// It sends {events: [{n, press}] | [{n, key}]}: a press on a chip's name or level words (`chip-<id>`, `word-<id>`), on
// one of its dots (`lvl-<id>-<i>`), on the catch-up (`catchup`), on + (`add`), on s close (`close`); and each key while a click has given it the
// keyboard (Claude Code keeps tab, the arrows, enter and esc in its prompt otherwise; Escape gives the keyboard back). Each post carries every
// event the hooks have not answered yet, numbered; ui.ts handles each number once and answers the last as `ack`.
import type { ClientModule, ClientSurface } from 'claude-code'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Item = { id: string; n: number; name: string; levels: string[]; level: number; word: string; picked: boolean }
type Instance = { id: string; n: number; queue: Array<Record<string, unknown>> }
const instances = new WeakMap<object, Instance>()

const Chips: ClientModule<Any> = (props: Any, surface: ClientSurface) => {
  const E = surface.elements as Any
  let I = instances.get(surface)
  if (!I) {
    I = { id: Math.random().toString(36).slice(2, 10), n: 0, queue: [] }
    instances.set(surface, I)
  }
  const me = I
  const ack = Number(props?.ack?.[me.id]) || 0
  if (ack) me.queue = me.queue.filter(x => Number(x.n) > ack)
  const send = (ev: Record<string, unknown>) => {
    me.queue = [...me.queue, { n: ++me.n, ...ev }].slice(-20)
    surface.post({ client: me.id, events: me.queue })
  }
  surface.onKey(ev => {
    if (ev.ctrl || ev.meta) return
    send({ key: ev.key, ...(ev.shift ? { shift: true } : {}) })
  })

  const items: Item[] = Array.isArray(props?.items) ? props.items : []
  const plus = typeof props?.plus === 'string' ? props.plus : null
  const press = (id: string, label: string, kids: Any[]) => E.Button({ key: id, plain: true, label, onPress: () => send({ press: id }), children: kids })
  const chip = (c: Item) => {
    const tone = c.picked ? { color: 'warning' } : { dimColor: true }
    const dots = c.levels.map((lv, i) => press(`lvl-${c.id}-${i}`, `${c.name}: ${lv}`, [E.Text({ ...tone, children: i === c.level ? '●' : '○' })]))
    return E.Box({ key: `c-${c.id}`, flexDirection: 'row', marginRight: 3, children: [
      press(`chip-${c.id}`, `${c.name}: ${c.word}`, [E.Text({ ...tone, children: `${c.n} ` }), E.Text({ ...tone, bold: c.picked, children: `${c.name} ` })]),
      ...dots,
      press(`word-${c.id}`, `${c.name}: ${c.word}`, [E.Text({ bold: c.picked, ...(c.picked ? { color: 'warning' } : {}), children: ` ${c.word}` })]),
    ] })
  }
  const cu = props?.catchup && typeof props.catchup === 'object' ? props.catchup : null
  const catchup = cu ? [E.Box({ key: 'c-catchup', flexDirection: 'row', marginRight: 3, children: [
    press('catchup', `catch up on ${cu.replies} replies`, [E.Text({ dimColor: true, children: `${cu.n} ` }), E.Text({ children: `Catch up on ${cu.replies} replies` })]),
  ] })] : []
  const add = press('add', 'add a chip of your own', [E.Text(plus != null ? { color: 'warning', bold: true, children: `+ ${plus}▏` } : { dimColor: true, children: '+' })])
  // s close, its key as the bar draws its keys (bar.tsx KEY_COLOR), so leaving is named where the person looks
  const close = plus == null ? [E.Box({ key: 'c-close', flexDirection: 'row', marginLeft: 3, children: [
    press('close', 's close', [E.Text({ color: 'suggestion', bold: true, children: 's' }), E.Text({ dimColor: true, children: ' close' })]),
  ] })] : []
  return E.Box({ flexDirection: 'row', flexWrap: 'wrap', width: Number(props?.width) || surface.columns || 80, children: [...items.map(chip), ...catchup, add, ...close] })
}

export default Chips
