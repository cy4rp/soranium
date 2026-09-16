import { readFile } from 'node:fs/promises'
import { importTx } from './store.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: npm run wallet:import -- <file>')
  process.exitCode = 1
} else {
  const text = await readFile(file, 'utf8')
  let imported = 0
  let added = 0
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    let hex = value
    try {
      const parsed = JSON.parse(value) as { ef?: unknown }
      if (typeof parsed.ef === 'string') hex = parsed.ef
    } catch { /* plain hex line */ }
    if (!/^[0-9a-f]+$/i.test(hex)) continue
    const row = importTx(hex)
    imported++
    added += row.added
  }
  console.log(JSON.stringify({ file, imported, added }))
}
