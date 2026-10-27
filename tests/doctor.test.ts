import { beforeAll, describe, expect, it } from 'vitest'
import { setLang, t } from '@shared/i18n'
import { applyEdits, lint } from '@shared/doctor/lint'
import { explain } from '@shared/doctor/explain'
import { friendlyError } from '@shared/doctor/errors'
import { splitStatements, tokenize } from '@shared/doctor/tokenizer'
import type { TableInfo } from '@shared/types'

const tables: TableInfo[] = [
  {
    name: 'customers',
    kind: 'table',
    foreignKeys: [],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, pk: true },
      { name: 'name', type: 'TEXT', nullable: true, pk: false },
      { name: 'city', type: 'TEXT', nullable: true, pk: false }
    ]
  },
  {
    name: 'orders',
    kind: 'table',
    foreignKeys: [{ column: 'customer_id', refTable: 'customers', refColumn: 'id' }],
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, pk: true },
      { name: 'customer_id', type: 'INTEGER', nullable: true, pk: false },
      { name: 'total', type: 'REAL', nullable: true, pk: false }
    ]
  }
]
const ctx = { dialect: 'sqlite' as const, tables }
const codes = (sql: string): string[] => lint(sql, ctx).map((i) => i.code)
const fix = (sql: string, code: string): string => {
  const issue = lint(sql, ctx).find((i) => i.code === code)
  expect(issue?.fix).toBeDefined()
  return applyEdits(sql, issue!.fix!.edits)
}

describe('tokenizer', () => {
  it('keeps strings, comments and Korean identifiers intact', () => {
    const t = tokenize("SELECT 'it''s; ok', 이름 -- hi;\nFROM t")
    expect(t.filter((x) => x.type === 'string')[0].value).toBe("'it''s; ok'")
    expect(t.some((x) => x.type === 'ident' && x.value === '이름')).toBe(true)
  })
  it('splits statements on top-level semicolons only', () => {
    const parts = splitStatements("SELECT ';'; SELECT 2;\n-- end")
    expect(parts.map((p) => p.text)).toEqual(["SELECT ';'", 'SELECT 2'])
  })
  it('does not split inside trigger bodies', () => {
    const sql = 'CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET x = 1; END; SELECT 1'
    expect(splitStatements(sql)).toHaveLength(2)
  })
})

describe('lint', () => {
  it('clean query has no errors', () => {
    const issues = lint('SELECT name, city FROM customers WHERE city = \'Seoul\' LIMIT 10', ctx)
    expect(issues.filter((i) => i.severity !== 'tip')).toEqual([])
  })
  it('flags UPDATE/DELETE without WHERE', () => {
    expect(codes('DELETE FROM customers')).toContain('no-where')
    expect(codes('UPDATE customers SET city = NULL')).toContain('no-where')
    expect(codes('UPDATE customers SET city = NULL WHERE id = 1')).not.toContain('null-compare')
  })
  it('fixes = NULL', () => {
    expect(fix('SELECT * FROM customers WHERE city = NULL', 'null-compare')).toBe('SELECT * FROM customers WHERE city IS NULL')
    expect(fix('SELECT * FROM customers WHERE city <> NULL', 'null-compare')).toBe('SELECT * FROM customers WHERE city IS NOT NULL')
  })
  it('fixes keyword typos', () => {
    expect(fix('SELECT name FORM customers', 'typo')).toBe('SELECT name FROM customers')
    expect(fix('SELEC name FROM customers', 'typo')).toBe('SELECT name FROM customers')
  })
  it('suggests unknown tables and columns', () => {
    expect(fix('SELECT name FROM customer', 'unknown-table')).toBe('SELECT name FROM customers')
    expect(fix('SELECT nme FROM customers', 'unknown-column')).toBe('SELECT name FROM customers')
    expect(fix('SELECT c.nam FROM customers c', 'unknown-column')).toBe('SELECT c.name FROM customers c')
  })
  it('does not flag aliases or functions as unknown columns', () => {
    const sql = 'SELECT city, COUNT(*) AS cnt FROM customers c GROUP BY city ORDER BY cnt DESC LIMIT 5'
    expect(codes(sql)).toEqual([])
  })
  it('adds a missing GROUP BY', () => {
    const fixed = fix('SELECT city, COUNT(*) FROM customers ORDER BY 2', 'missing-group-by')
    expect(fixed).toBe('SELECT city, COUNT(*) FROM customers GROUP BY city\nORDER BY 2')
  })
  it('removes trailing commas', () => {
    expect(fix('SELECT name, FROM customers', 'trailing-comma')).toBe('SELECT name FROM customers')
  })
  it('reports unbalanced parens and quotes', () => {
    expect(codes("SELECT (1 FROM customers")).toContain('paren')
    expect(codes("SELECT 'abc FROM customers")).toContain('unterminated')
  })
  it('catches double-quoted strings', () => {
    expect(fix('SELECT * FROM customers WHERE city = "Seoul"', 'double-quote-string')).toBe("SELECT * FROM customers WHERE city = 'Seoul'")
  })
  it('warns on mixed AND/OR but not BETWEEN', () => {
    expect(codes('SELECT * FROM orders WHERE total > 1 OR total < 0 AND id = 1 LIMIT 1')).toContain('and-or')
    expect(codes('SELECT * FROM orders WHERE total BETWEEN 1 AND 5 OR id = 2 LIMIT 1')).not.toContain('and-or')
  })
  it('flags JOIN without ON', () => {
    expect(codes('SELECT * FROM orders o JOIN customers c LIMIT 1')).toContain('join-no-on')
  })
  it('expands SELECT * for a single table', () => {
    expect(fix('SELECT * FROM customers LIMIT 1', 'select-star')).toBe('SELECT id, name, city FROM customers LIMIT 1')
  })
})

describe('i18n', () => {
  it('defaults to English and switches to Korean', () => {
    setLang('en')
    expect(lint('DELETE FROM orders', ctx)[0].message).toBe('No WHERE: every row will be deleted')
    expect(friendlyError('no such table: customer', tables)).toEqual({ title: "No table named 'customer'", hint: "Did you mean 'customers'?" })
    expect(t('rows', { n: 1234 })).toBe('1,234 rows')
    setLang('ko')
    expect(lint('DELETE FROM orders', ctx)[0].message).toBe('WHERE가 없어 모든 행이 지워져요')
  })
})

describe('explain', () => {
  beforeAll(() => setLang('ko'))
  it('describes a select in execution order', () => {
    const [e] = explain('SELECT city, COUNT(*) FROM customers WHERE id > 3 GROUP BY city ORDER BY 2 DESC LIMIT 5')
    expect(e.steps.map((s) => s.tag)).toEqual(['FROM', 'WHERE', 'GROUP BY', 'SELECT', 'ORDER BY', 'LIMIT'])
    expect(e.steps[4].text).toContain('큰 순')
  })
  it('warns for deletes without where', () => {
    const [e] = explain('DELETE FROM orders')
    expect(e.steps[0].text).toContain('모든 행')
  })
})

describe('friendlyError', () => {
  beforeAll(() => setLang('ko'))
  it('translates common engine errors with suggestions', () => {
    expect(friendlyError('no such table: customer', tables)).toEqual({ title: "'customer' 테이블이 없어요", hint: "혹시 'customers'?" })
    expect(friendlyError('column "nme" does not exist', tables).hint).toBe("혹시 'name'?")
    expect(friendlyError("Unknown column 'citi' in 'field list'", tables).hint).toBe("혹시 'city'?")
    expect(friendlyError('something odd').title).toBe('실행 중 오류가 났어요')
  })
})
