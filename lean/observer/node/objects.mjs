// objects.mjs: a session's objects in a folder, slimmed for the observer (evidence.js slim): everything its digest
// reads and nothing else. It reads the files itself, so an object over the engine's 4 MiB read is read too.
//
//   node --permission --allow-fs-read=<lean> --allow-fs-read=<root>/thimble objects.mjs <root> <session>
//     -> [{id, version, session, updated, title, question, text, hints, verb, lineage: {...}}], newest first
//
// Objects a verb the person pressed made carry another session and are left out: they are not Claude's.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { slim } from '../evidence.js'

const [root, session] = process.argv.slice(2)
const dir = join(root || '.', 'thimble', 'objects')
const out = []
let names = []
try { names = readdirSync(dir).filter(f => f.endsWith('.json')) } catch { names = [] }
for (const f of names) {
  try {
    const o = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    if (o && o.session === session) out.push(slim(o))
  } catch {
    // a file being written: the next look reads it
  }
}
out.sort((a, b) => Date.parse(String(b.updated || '')) - Date.parse(String(a.updated || '')))
process.stdout.write(JSON.stringify(out))
