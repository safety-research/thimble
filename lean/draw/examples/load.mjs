// load.mjs: the example objects, as the kernel will hand objects to the renderers: {id, v, title, program, data}.
// index.json lists them; each has its program (a function body) and its data in files of their own.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

export function exampleIndex() {
  return JSON.parse(readFileSync(HERE + 'index.json', 'utf8'))
}

export function loadExample(id) {
  const e = exampleIndex().find(x => x.id === id || `${x.id}@${x.v}` === id)
  if (!e) throw new Error(`no example "${id}"; the examples are ${exampleIndex().map(x => x.id).join(', ')}`)
  return {
    id: e.id, v: e.v, title: e.title, question: e.question,
    program: readFileSync(HERE + e.program, 'utf8'),
    data: JSON.parse(readFileSync(HERE + e.data, 'utf8')),
  }
}

export function loadExamples() {
  return exampleIndex().map(e => loadExample(e.id))
}
