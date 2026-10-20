// append.mjs FILE: appends what it reads on stdin to FILE in one write (O_APPEND), creating its folder. The hooks
// module has no append ($.fs.write writes a whole file), and the kernel appends to the same file from its own process,
// so the hooks' lines go through this child and no line of either is lost.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const file = process.argv[2]
let text = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { text += d })
process.stdin.on('end', () => {
  if (!file || !text) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, text.endsWith('\n') ? text : text + '\n')
})
