import { beforeAll, describe, expect, it } from 'vitest'
import { setLang } from '@shared/i18n'
import { compile, type BlockQuery, type Node } from '@shared/blockquery'
import { buildReport, duplicateSql, profileSql } from '@shared/health'
import type { TableInfo } from '@shared/types'

const col = (name: string, table = 'sales') => ({ k: 'col' as const, table, name })
const types: Record<string, string> = { 'sales.region': 'TEXT', 'sales.amount': 'REAL', 'sales.zip': 'TEXT' }
const typeOf = (t: string, c: string): string | undefined => types[`${t}.${c}`]

describe('compile', () => {
  it('defaults to SELECT *', () => {
    expect(compile({ table: 'sales', steps: [] }, 'sqlite').sql).toBe('SELECT *\nFROM sales')
  })

  it('orders clauses regardless of block order', () => {
    const q: BlockQuery = {
      table: 'sales',
      steps: [
        { k: 'limit', n: 5 },
        { k: 'order', expr: { k: 'agg', fn: 'SUM', arg: col('amount') }, dir: 'DESC' },
        { k: 'group', expr: col('region') },
        { k: 'show', expr: col('region') },
        { k: 'show', expr: { k: 'agg', fn: 'SUM', arg: col('amount') }, alias: '합계' },
        { k: 'where', cond: { k: 'cmp', op: '>', a: col('amount'), b: { k: 'text', v: '100' } } }
      ]
    }
    expect(compile(q, 'sqlite', typeOf).sql).toBe(
      'SELECT region, SUM(amount) AS 합계\nFROM sales\nWHERE amount > 100\nGROUP BY region\nORDER BY SUM(amount) DESC\nLIMIT 5'
    )
  })

  it('quotes numbers compared to text columns', () => {
    const q: BlockQuery = { table: 'sales', steps: [{ k: 'where', cond: { k: 'cmp', op: '=', a: col('zip'), b: { k: 'text', v: '12345' } } }] }
    expect(compile(q, 'postgres', typeOf).sql).toContain("zip = '12345'")
  })

  it('counts holes so incomplete queries do not run', () => {
    const q: BlockQuery = { table: 'sales', steps: [{ k: 'where', cond: { k: 'cmp', op: '=', a: null, b: null } }] }
    const r = compile(q, 'sqlite')
    expect(r.holes).toBe(2)
  })

  it('adds a count when only grouping', () => {
    const q: BlockQuery = { table: 'sales', steps: [{ k: 'group', expr: col('region') }] }
    expect(compile(q, 'mysql').sql).toBe('SELECT region, COUNT(*) AS count\nFROM sales\nGROUP BY region')
    setLang('ko')
    expect(compile(q, 'mysql').sql).toBe('SELECT region, COUNT(*) AS 개수\nFROM sales\nGROUP BY region')
    setLang('en')
  })

  it('qualifies columns and writes joins', () => {
    const q: BlockQuery = {
      table: 'orders',
      steps: [
        { k: 'join', type: 'LEFT', table: 'customers', cond: { k: 'cmp', op: '=', a: col('customer_id', 'orders'), b: col('id', 'customers') } },
        { k: 'show', expr: col('name', 'customers') }
      ]
    }
    expect(compile(q, 'sqlite').sql).toBe('SELECT customers.name\nFROM orders\nLEFT JOIN customers ON orders.customer_id = customers.id')
  })

  it('uses dialect specific functions', () => {
    const year = { k: 'fn' as const, fn: 'YEAR' as const, arg: col('day') }
    const q = (): BlockQuery => ({ table: 'sales', steps: [{ k: 'show', expr: year }] })
    expect(compile(q(), 'sqlite').sql).toContain("strftime('%Y', day)")
    expect(compile(q(), 'postgres').sql).toContain('EXTRACT(YEAR FROM day)')
    expect(compile(q(), 'mysql').sql).toContain('YEAR(day)')
  })

  it('compiles text, number and date functions per dialect', () => {
    const show = (expr: Node) => (d: 'sqlite' | 'postgres' | 'mysql') =>
      compile({ table: 'sales', steps: [{ k: 'show', expr }] }, d).sql.split('\n')[0].slice(7)
    const n = (v: string): Node => ({ k: 'num', v })
    const s = (v: string): Node => ({ k: 'text', v })

    const right = show({ k: 'slice', side: 'right', a: col('zip'), n: n('3') })
    expect([right('sqlite'), right('postgres'), right('mysql')]).toEqual(['SUBSTR(zip, -3)', 'RIGHT(zip, 3)', 'RIGHT(zip, 3)'])

    const find = show({ k: 'find', a: col('region'), b: s('@') })
    expect([find('sqlite'), find('postgres')]).toEqual(["INSTR(region, '@')", "STRPOS(region, '@')"])

    expect(show({ k: 'replace', a: col('zip'), find: s('-'), to: s('') })('mysql')).toBe("REPLACE(zip, '-', '')")
    expect(show({ k: 'arith', op: '^', a: col('amount'), b: n('2') })('sqlite')).toBe('POWER(amount, 2)')
    expect(show({ k: 'arith', op: '%', a: { k: 'arith', op: '+', a: col('amount'), b: n('1') }, b: n('2') })('sqlite')).toBe('(amount + 1) % 2')

    const add = show({ k: 'dateAdd', a: col('day'), n: n('-7'), unit: 'day' })
    expect([add('sqlite'), add('postgres'), add('mysql')]).toEqual([
      "DATE(day, '-7 days')",
      "CAST(CAST(day AS DATE) + -7 * INTERVAL '1 day' AS DATE)",
      'DATE_ADD(day, INTERVAL -7 DAY)'
    ])
    const diff = show({ k: 'dateDiff', a: col('day'), b: { k: 'today' } })
    expect([diff('sqlite'), diff('postgres'), diff('mysql')]).toEqual([
      'CAST(julianday(CURRENT_DATE) - julianday(day) AS INTEGER)',
      '(CAST(CURRENT_DATE AS DATE) - CAST(day AS DATE))',
      'DATEDIFF(CURRENT_DATE, day)'
    ])
    const ym = show({ k: 'fn', fn: 'YEARMONTH', arg: col('day') })
    expect([ym('sqlite'), ym('postgres'), ym('mysql')]).toEqual([
      "strftime('%Y-%m', day)",
      "TO_CHAR(CAST(day AS DATE), 'YYYY-MM')",
      "DATE_FORMAT(day, '%Y-%m')"
    ])
    const list = show({ k: 'agg', fn: 'LIST', arg: col('region') })
    expect([list('sqlite'), list('postgres'), list('mysql')]).toEqual([
      "GROUP_CONCAT(region, ', ')",
      "STRING_AGG(CAST(region AS TEXT), ', ')",
      "GROUP_CONCAT(region SEPARATOR ', ')"
    ])
  })

  it('compiles rank and window functions', () => {
    const show = (expr: Node) => compile({ table: 'sales', steps: [{ k: 'show', expr }] }, 'postgres')
    expect(show({ k: 'rank', fn: 'RANK', order: col('amount'), dir: 'DESC', part: col('region') }).sql).toContain(
      'RANK() OVER (PARTITION BY region ORDER BY amount DESC)'
    )
    expect(show({ k: 'window', fn: 'RUNSUM', arg: col('amount'), order: col('day'), dir: 'ASC', part: null }).sql).toContain(
      'SUM(amount) OVER (ORDER BY day)'
    )
    expect(show({ k: 'window', fn: 'PCT', arg: col('amount'), order: null, dir: 'ASC', part: null }).sql).toContain(
      'amount * 100.0 / SUM(amount) OVER ()'
    )
    // a rank needs something to order by; partition and window order are optional
    expect(show({ k: 'rank', fn: 'ROW_NUMBER', order: null, dir: 'DESC', part: null }).holes).toBe(1)
    expect(show({ k: 'window', fn: 'PREV', arg: col('amount'), order: null, dir: 'ASC', part: null }).holes).toBe(0)
  })

  it('parenthesizes mixed logic and keeps division decimal', () => {
    const q: BlockQuery = {
      table: 'sales',
      steps: [
        { k: 'show', expr: { k: 'arith', op: '/', a: col('amount'), b: { k: 'num', v: '3' } } },
        {
          k: 'where',
          cond: {
            k: 'logic',
            op: 'AND',
            a: { k: 'logic', op: 'OR', a: { k: 'isnull', not: false, a: col('region') }, b: { k: 'like', mode: 'starts', a: col('region'), text: "O'" } },
            b: { k: 'in', a: col('zip'), list: '1, 2' }
          }
        }
      ]
    }
    expect(compile(q, 'sqlite', typeOf).sql).toBe(
      "SELECT amount * 1.0 / 3\nFROM sales\nWHERE (region IS NULL OR region LIKE 'O''%') AND zip IN ('1', '2')"
    )
  })
})

describe('health', () => {
  beforeAll(() => setLang('ko'))
  const t: TableInfo = {
    name: 'people',
    kind: 'table',
    foreignKeys: [],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, pk: true },
      { name: 'email', type: 'TEXT', nullable: true, pk: false },
      { name: 'note', type: 'TEXT', nullable: true, pk: false }
    ]
  }
  it('builds profile and duplicate queries', () => {
    expect(profileSql(t, 'sqlite')).toContain('COUNT(DISTINCT email) AS c1_d')
    expect(duplicateSql(t, 'sqlite')).toContain('GROUP BY email, note')
  })
  it('scores problems', () => {
    const cols = ['n', 'c0_nn', 'c0_d', 'c1_nn', 'c1_d', 'c1_e', 'c2_nn', 'c2_d', 'c2_e']
    const r = buildReport(t, cols, [10, 10, 10, 10, 10, 0, 0, 0, 0], 2)
    expect(r.columns[1].findings[0].text).toContain('키 후보')
    expect(r.columns[2].findings[0].text).toBe('전부 비어 있음')
    expect(r.findings[0].text).toBe('중복 행 2개')
    expect(r.score).toBe(77)
  })
})
