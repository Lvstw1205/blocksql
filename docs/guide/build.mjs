// Builds docs/SQL-Guide-ko.pdf: runs every <pre class="sql run"> example against a fresh
// BlockSQL sample database, inserts the real result under it, then prints with Electron.
// Usage: npm run guide
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { createSampleDb } from '../../src/main/sample.ts'
import { splitStatements, tokenize } from '../../src/shared/doctor/tokenizer.ts'

const here = dirname(fileURLToPath(import.meta.url))
const MAX_ROWS = 10

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function highlight(sql) {
  const toks = tokenize(sql)
  return toks
    .map((t, i) => {
      const v = esc(t.value)
      if (t.type === 'keyword') return `<span class="k">${v}</span>`
      if (t.type === 'string') return `<span class="s">${v}</span>`
      if (t.type === 'number') return `<span class="n">${v}</span>`
      if (t.type === 'comment') return `<span class="c">${v}</span>`
      if (t.type === 'ident' && toks[i + 1]?.value === '(') return `<span class="f">${v}</span>`
      return v
    })
    .join('')
}

function cell(v) {
  if (v === null) return '<td class="null">NULL</td>'
  if (typeof v === 'number') {
    const s = Number.isInteger(v) ? (Math.abs(v) >= 10000 ? v.toLocaleString('ko-KR') : String(v)) : String(Math.round(v * 100) / 100)
    return `<td class="num">${s}</td>`
  }
  return `<td>${esc(v)}</td>`
}

function run(db, sql) {
  let result = null
  let changes = 0
  db.exec('BEGIN')
  try {
    for (const { text } of splitStatements(sql)) {
      const stmt = db.prepare(text)
      const cols = stmt.columns()
      if (cols.length) {
        stmt.setReturnArrays(true)
        result = { columns: cols.map((c) => c.name), rows: stmt.all() }
      } else {
        changes += Number(stmt.run().changes)
      }
    }
  } finally {
    db.exec('ROLLBACK')
  }
  if (!result) return `<table class="result"><caption>${changes.toLocaleString('ko-KR')}행 변경 (예제 실행 후 되돌림)</caption></table>`
  let { columns, rows } = result
  if (columns.includes('detail') && columns.includes('parent')) {
    // EXPLAIN QUERY PLAN: only the readable part
    rows = rows.map((r) => [r[columns.indexOf('detail')]])
    columns = ['detail']
  }
  const shown = rows.slice(0, MAX_ROWS)
  const notes = []
  if (rows.length > MAX_ROWS) notes.push(`${rows.length.toLocaleString('ko-KR')}행 중 ${MAX_ROWS}행 표시`)
  else notes.push(`${rows.length}행`)
  if (changes) notes.push(`앞 문장들로 ${changes.toLocaleString('ko-KR')}행 변경 후 되돌림`)
  return (
    `<table class="result"><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>` +
    `<tbody>${shown.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody>` +
    `<caption>${notes.join(' · ')}</caption></table>`
  )
}

const work = mkdtempSync(join(tmpdir(), 'blocksql-guide-'))
const dbFile = join(work, 'sample.sqlite')
createSampleDb(dbFile, 'ko')
const db = new DatabaseSync(dbFile)

let count = 0
const failures = []
const html = readFileSync(join(here, 'guide.ko.html'), 'utf8').replace(
  /<pre class="sql( run)?">([\s\S]*?)<\/pre>/g,
  (_, runIt, body) => {
    const sql = decode(body)
    let out = `<pre class="sql">${highlight(sql)}</pre>`
    if (runIt) {
      count++
      try {
        out = `<div class="example">${out}${run(db, sql)}</div>`
      } catch (e) {
        failures.push(`${e.message}\n---\n${sql}`)
      }
    }
    return out
  }
)
db.close()
if (failures.length) {
  console.error(`${failures.length} example(s) failed:\n\n${failures.join('\n\n')}`)
  process.exit(1)
}

const htmlOut = join(work, 'guide.html')
writeFileSync(htmlOut, html)
const pdfOut = join(here, '..', 'SQL-Guide-ko.pdf')
const r = spawnSync(electron, [join(here, 'print.cjs'), htmlOut, pdfOut], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)
console.log(`ran ${count} examples → ${pdfOut}`)
