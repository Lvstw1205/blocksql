import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteDriver } from '../src/main/db/sqlite'
import { cleanName, importSheet, readSheets } from '../src/main/importer'
import { createSampleDb } from '../src/main/sample'
import { compile, type Node, type Step } from '@shared/blockquery'
import { buildReport, duplicateSql, profileSql } from '@shared/health'
import { lint } from '@shared/doctor/lint'

const dir = mkdtempSync(join(tmpdir(), 'blocksql-'))
const drivers: SqliteDriver[] = []
const open = (name: string): SqliteDriver => {
  const d = new SqliteDriver(join(dir, name))
  drivers.push(d)
  return d
}
afterAll(async () => {
  for (const d of drivers) await d.close()
})

describe('SqliteDriver', () => {
  it('runs scripts and returns the last result', async () => {
    const db = open('a.sqlite')
    const r = await db.query("CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'x'), (2, 'y'); SELECT * FROM t ORDER BY a", 10)
    expect(r.columns).toEqual(['a', 'b'])
    expect(r.rows).toEqual([[1, 'x'], [2, 'y']])
  })
  it('truncates at maxRows', async () => {
    const db = open('b.sqlite')
    const r = await db.query('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50) SELECT i FROM n', 10)
    expect(r.rows).toHaveLength(10)
    expect(r.truncated).toBe(true)
  })
  it('dry-runs writes without keeping them', async () => {
    const db = open('c.sqlite')
    await db.query('CREATE TABLE t (a); INSERT INTO t VALUES (1), (2), (3)', 0)
    expect(await db.dryRun('DELETE FROM t WHERE a > 1')).toBe(2)
    expect((await db.query('SELECT COUNT(*) FROM t', 1)).rows[0][0]).toBe(3)
  })
})

describe('importer', () => {
  it('cleans names', () => {
    expect(cleanName(' Order Date (KST) ', 'x')).toBe('order_date_kst')
    expect(cleanName('주문 금액', 'x')).toBe('주문_금액')
    expect(cleanName('2024', 'x')).toBe('_2024')
    expect(cleanName('!!', 'col_1')).toBe('col_1')
  })

  it('reads CSV and infers types', async () => {
    const csv = '이름,금액,우편번호,날짜\n김민준,"1,200",01234,2026-01-02\n이서연,3.5,04567,\n'
    const bytes = Buffer.from(new TextEncoder().encode(csv))
    const file = join(dir, 'utf8.csv')
    writeFileSync(file, bytes)
    const [sheet] = await readSheets(file)
    expect(sheet.headers).toEqual(['이름', '금액', '우편번호', '날짜'])

    const db = open('import.sqlite')
    const r = await importSheet(db, sheet, new Set())
    expect(r).toEqual({ table: 'utf8', rows: 2 })
    const schema = await db.schema()
    expect(schema[0].columns.map((c) => `${c.name}:${c.type}`)).toEqual(['이름:TEXT', '금액:REAL', '우편번호:TEXT', '날짜:TEXT'])
    const rows = (await db.query('SELECT * FROM utf8', 10)).rows
    expect(rows[0]).toEqual(['김민준', 1200, '01234', '2026-01-02'])
    expect(rows[1][3]).toBeNull()
  })

  it('decodes EUC-KR files', async () => {
    // "이름,값\n가,1" encoded as EUC-KR
    const euckr = Buffer.from([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xb0, 0xaa, 0x0a, 0xb0, 0xa1, 0x2c, 0x31, 0x0a])
    const file = join(dir, 'korean.csv')
    writeFileSync(file, euckr)
    const [sheet] = await readSheets(file)
    expect(sheet.headers).toEqual(['이름', '값'])
    expect(sheet.rows).toEqual([['가', '1']])
  })

  it('never overwrites an existing table', async () => {
    const db = open('dupe.sqlite')
    const sheet = { name: 'Sales', headers: ['a'], rows: [['1']] }
    const existing = new Set<string>()
    expect((await importSheet(db, sheet, existing)).table).toBe('sales')
    expect((await importSheet(db, sheet, existing)).table).toBe('sales_2')
  })
})

describe('sample database end to end', () => {
  const file = join(dir, 'sample.sqlite')
  createSampleDb(file)
  const db = open('sample.sqlite')

  it('has related tables', async () => {
    const schema = await db.schema()
    expect(schema.map((t) => t.name)).toEqual(['customers', 'orders', 'products'])
    expect(schema.find((t) => t.name === 'orders')!.foreignKeys).toHaveLength(2)
  })

  it('runs a block-built join + group query', async () => {
    const { sql, holes } = compile(
      {
        table: 'orders',
        steps: [
          { k: 'join', type: 'INNER', table: 'products', cond: { k: 'cmp', op: '=', a: { k: 'col', table: 'orders', name: 'product_id' }, b: { k: 'col', table: 'products', name: 'id' } } },
          { k: 'show', expr: { k: 'col', table: 'products', name: 'category' } },
          { k: 'show', expr: { k: 'agg', fn: 'SUM', arg: { k: 'arith', op: '*', a: { k: 'col', table: 'orders', name: 'qty' }, b: { k: 'col', table: 'products', name: 'price' } } }, alias: '매출' },
          { k: 'group', expr: { k: 'col', table: 'products', name: 'category' } },
          { k: 'order', expr: { k: 'agg', fn: 'SUM', arg: { k: 'arith', op: '*', a: { k: 'col', table: 'orders', name: 'qty' }, b: { k: 'col', table: 'products', name: 'price' } } }, dir: 'DESC' }
        ]
      },
      'sqlite'
    )
    expect(holes).toBe(0)
    const schema = await db.schema()
    expect(lint(sql, { dialect: 'sqlite', tables: schema }).filter((i) => i.severity === 'error')).toEqual([])
    const r = await db.query(sql, 100)
    expect(r.columns).toEqual(['category', '매출'])
    expect(r.rows.length).toBe(5)
  })

  it('runs every function block on SQLite', async () => {
    const c = (name: string): Node => ({ k: 'col', table: 'orders', name })
    const num = (v: string): Node => ({ k: 'num', v })
    const text = (v: string): Node => ({ k: 'text', v })
    const when = text('2026-06-11 14:30:00')
    const run = async (exprs: Node[], extra: Step[] = []): Promise<unknown[][]> => {
      const { sql, holes } = compile({ table: 'orders', steps: [...exprs.map((expr): Step => ({ k: 'show', expr })), ...extra] }, 'sqlite')
      expect(holes).toBe(0)
      return (await db.query(sql, 3)).rows
    }

    const [scalars] = await run([
      { k: 'slice', side: 'left', a: when, n: num('4') },
      { k: 'slice', side: 'right', a: when, n: num('2') },
      { k: 'substr', a: when, start: num('6'), len: num('2') },
      { k: 'replace', a: text('a-b-c'), find: text('-'), to: text('') },
      { k: 'find', a: text('me@x.io'), b: text('@') },
      { k: 'arith', op: '^', a: num('3'), b: num('2') },
      { k: 'arith', op: '%', a: num('7'), b: num('3') },
      { k: 'dateAdd', a: when, n: num('1'), unit: 'month' },
      { k: 'dateDiff', a: text('2026-06-01'), b: when },
      ...(['LTRIM', 'HOUR', 'QUARTER', 'WEEKDAY', 'YEARMONTH', 'DATE', 'TO_NUMBER'] as const).map(
        (fn): Node => ({ k: 'fn', fn, arg: fn === 'LTRIM' ? text('  x') : fn === 'TO_NUMBER' ? text('1.5') : when })
      ),
      ...(['CEIL', 'FLOOR', 'SQRT'] as const).map((fn): Node => ({ k: 'fn', fn, arg: num('2.25') }))
    ])
    expect(scalars).toEqual(['2026', '00', '06', 'abc', 3, 9, 1, '2026-07-11', 10, 'x', 14, 2, 4, '2026-06', '2026-06-11', 1.5, 3, 2, 1.5])

    const windows = await run(
      [
        c('id'),
        { k: 'rank', fn: 'ROW_NUMBER', order: c('id'), dir: 'ASC', part: null },
        { k: 'window', fn: 'RUNSUM', arg: num('1'), order: c('id'), dir: 'ASC', part: null },
        { k: 'window', fn: 'PREV', arg: c('id'), order: c('id'), dir: 'ASC', part: null },
        { k: 'window', fn: 'PCT', arg: num('1'), order: null, dir: 'ASC', part: null }
      ],
      [{ k: 'order', expr: c('id'), dir: 'ASC' }]
    )
    expect(windows.slice(0, 2)).toEqual([
      [1, 1, 1, null, 0.2],
      [2, 2, 2, 1, 0.2]
    ])

    const [[list]] = await run([{ k: 'agg', fn: 'LIST', arg: c('status') }], [{ k: 'group', expr: c('customer_id') }])
    expect(String(list)).toContain(', ')
  })

  it('health check finds the planted problems', async () => {
    const t = (await db.schema()).find((x) => x.name === 'customers')!
    const prof = await db.query(profileSql(t, 'sqlite'), 1)
    const dup = await db.query(duplicateSql(t, 'sqlite')!, 1)
    const report = buildReport(t, prof.columns, prof.rows[0], Number(dup.rows[0][0]))
    expect(report.rows).toBe(62)
    expect(report.duplicateRows).toBe(2)
    expect(report.columns.find((c) => c.name === 'email')!.empty).toBeGreaterThan(0)
    expect(report.score).toBeLessThan(90)
  })
})
