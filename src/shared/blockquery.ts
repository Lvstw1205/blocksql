/**
 * The query a user assembles from blocks, as a plain tree, and the SQL it compiles to.
 * Blockly-free so it can be tested on its own.
 */
import type { Dialect } from './types'
import { quoteIdent, quoteString, quoteTable } from './sql'
import { t } from './i18n'

export type AggFn = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT_DISTINCT'
export type ScalarFn = 'UPPER' | 'LOWER' | 'LENGTH' | 'TRIM' | 'ABS' | 'YEAR' | 'MONTH' | 'DAY' | 'ROUND'
export type CmpOp = '=' | '!=' | '>' | '>=' | '<' | '<='

export type Node =
  | { k: 'col'; table: string; name: string }
  | { k: 'num'; v: string }
  | { k: 'text'; v: string }
  | { k: 'today' }
  | { k: 'agg'; fn: AggFn; arg: Node | null }
  | { k: 'arith'; op: '+' | '-' | '*' | '/'; a: Node | null; b: Node | null }
  | { k: 'fn'; fn: ScalarFn; arg: Node | null; digits?: number }
  | { k: 'concat'; a: Node | null; b: Node | null }
  | { k: 'coalesce'; a: Node | null; b: Node | null }
  | { k: 'case'; cond: Node | null; then: Node | null; else: Node | null }
  | { k: 'raw'; sql: string }
  | { k: 'cmp'; op: CmpOp; a: Node | null; b: Node | null }
  | { k: 'logic'; op: 'AND' | 'OR'; a: Node | null; b: Node | null }
  | { k: 'not'; a: Node | null }
  | { k: 'like'; mode: 'contains' | 'starts' | 'ends'; a: Node | null; text: string }
  | { k: 'isnull'; not: boolean; a: Node | null }
  | { k: 'between'; a: Node | null; lo: Node | null; hi: Node | null }
  | { k: 'in'; a: Node | null; list: string }

export type Step =
  | { k: 'show'; expr: Node | null; alias?: string }
  | { k: 'showAll' }
  | { k: 'distinct' }
  | { k: 'where'; cond: Node | null }
  | { k: 'join'; type: 'INNER' | 'LEFT'; table: string; cond: Node | null }
  | { k: 'group'; expr: Node | null }
  | { k: 'having'; cond: Node | null }
  | { k: 'order'; expr: Node | null; dir: 'ASC' | 'DESC' }
  | { k: 'limit'; n: number }

export interface BlockQuery {
  table: string
  steps: Step[]
}

export interface CompileResult {
  sql: string
  /** number of empty slots; the query should not run while > 0 */
  holes: number
}

/** column type lookup, used to decide whether "20" should be quoted */
export type ColumnTypeOf = (table: string, column: string) => string | undefined

const NUMERIC = /^-?\d+(\.\d+)?$/
const TEXTY = /char|text|clob|string|uuid|enum/i

export function compile(q: BlockQuery, dialect: Dialect, typeOf: ColumnTypeOf = () => undefined): CompileResult {
  let holes = 0
  const qualify = q.steps.some((s) => s.k === 'join')
  const id = (n: string): string => quoteIdent(n, dialect)

  const isTextColumn = (n: Node | null): boolean => n?.k === 'col' && TEXTY.test(typeOf(n.table, n.name) ?? '')
  /** a typed-in value compared against `other` */
  const valueFor = (n: Node | null, other: Node | null): string => {
    if (n?.k === 'text' && NUMERIC.test(n.v.trim()) && !/^-?0\d/.test(n.v.trim()) && !isTextColumn(other)) return n.v.trim()
    return ex(n)
  }
  const listValue = (raw: string, other: Node | null): string =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => valueFor({ k: 'text', v: s }, other))
      .join(', ')

  const wrap = (n: Node | null, parentOp: string): string => {
    const s = ex(n)
    if (n?.k === 'arith' && parentOp !== '+' ) return `(${s})`
    if (n?.k === 'logic' && n.op !== parentOp) return `(${s})`
    return s
  }

  function ex(n: Node | null): string {
    if (!n) {
      holes++
      return '___'
    }
    switch (n.k) {
      case 'col':
        return qualify ? `${quoteTable(n.table, dialect)}.${id(n.name)}` : id(n.name)
      case 'num':
        return NUMERIC.test(n.v.trim()) ? n.v.trim() : '0'
      case 'text':
        return quoteString(n.v)
      case 'today':
        return 'CURRENT_DATE'
      case 'agg':
        if (n.fn === 'COUNT_DISTINCT') return `COUNT(DISTINCT ${ex(n.arg)})`
        if (n.fn === 'COUNT' && !n.arg) return 'COUNT(*)'
        return `${n.fn}(${ex(n.arg)})`
      case 'arith': {
        const a = wrap(n.a, n.op)
        const b = wrap(n.b, n.op)
        if (n.op === '/' && dialect !== 'mysql') return `${a} * 1.0 / ${b}`
        return `${a} ${n.op} ${b}`
      }
      case 'fn':
        return scalar(n.fn, ex(n.arg), n.digits ?? 0, dialect)
      case 'concat':
        return dialect === 'mysql' ? `CONCAT(${ex(n.a)}, ${ex(n.b)})` : `${ex(n.a)} || ${ex(n.b)}`
      case 'coalesce':
        return `COALESCE(${ex(n.a)}, ${ex(n.b)})`
      case 'case':
        return `CASE WHEN ${ex(n.cond)} THEN ${ex(n.then)} ELSE ${ex(n.else)} END`
      case 'raw':
        if (!n.sql.trim()) holes++
        return n.sql.trim() || '___'
      case 'cmp':
        return `${ex(n.a)} ${n.op === '!=' ? '<>' : n.op} ${valueFor(n.b, n.a)}`
      case 'logic':
        return `${wrap(n.a, n.op)} ${n.op} ${wrap(n.b, n.op)}`
      case 'not':
        return `NOT (${ex(n.a)})`
      case 'like': {
        const v = n.text.replace(/'/g, "''")
        const pat = n.mode === 'contains' ? `%${v}%` : n.mode === 'starts' ? `${v}%` : `%${v}`
        return `${ex(n.a)} LIKE '${pat}'`
      }
      case 'isnull':
        return `${ex(n.a)} IS ${n.not ? 'NOT ' : ''}NULL`
      case 'between':
        return `${ex(n.a)} BETWEEN ${valueFor(n.lo, n.a)} AND ${valueFor(n.hi, n.a)}`
      case 'in': {
        const list = listValue(n.list, n.a)
        if (!list) holes++
        return `${ex(n.a)} IN (${list || '___'})`
      }
    }
  }

  const of = <K extends Step['k']>(k: K): Extract<Step, { k: K }>[] =>
    q.steps.filter((s): s is Extract<Step, { k: K }> => s.k === k)

  const groups = of('group').map((g) => ex(g.expr))
  const shows = of('show')
  let select: string[]
  if (shows.length) {
    select = shows.map((s) => ex(s.expr) + (s.alias?.trim() ? ` AS ${id(s.alias.trim())}` : ''))
    if (of('showAll').length) select.unshift(qualify ? `${quoteTable(q.table, dialect)}.*` : '*')
  } else if (groups.length) {
    select = [...groups, `COUNT(*) AS ${id(t('countAlias'))}`]
  } else {
    select = ['*']
  }

  const lines: string[] = []
  lines.push(`SELECT ${of('distinct').length ? 'DISTINCT ' : ''}${select.join(', ')}`)
  if (!q.table) holes++
  lines.push(`FROM ${q.table ? quoteTable(q.table, dialect) : '___'}`)
  for (const j of of('join')) {
    lines.push(`${j.type === 'LEFT' ? 'LEFT JOIN' : 'JOIN'} ${quoteTable(j.table, dialect)} ON ${ex(j.cond)}`)
  }
  const wheres = of('where').map((w) => wrap(w.cond, 'AND'))
  if (wheres.length) lines.push(`WHERE ${wheres.join(' AND ')}`)
  if (groups.length) lines.push(`GROUP BY ${groups.join(', ')}`)
  const havings = of('having').map((h) => wrap(h.cond, 'AND'))
  if (havings.length) lines.push(`HAVING ${havings.join(' AND ')}`)
  const orders = of('order').map((o) => `${ex(o.expr)}${o.dir === 'DESC' ? ' DESC' : ''}`)
  if (orders.length) lines.push(`ORDER BY ${orders.join(', ')}`)
  const limit = of('limit').at(-1)
  if (limit) lines.push(`LIMIT ${Math.max(0, Math.floor(limit.n))}`)

  return { sql: lines.join('\n'), holes }
}

function scalar(fn: ScalarFn, arg: string, digits: number, dialect: Dialect): string {
  const part = (p: 'YEAR' | 'MONTH' | 'DAY'): string => {
    if (dialect === 'sqlite') return `CAST(strftime('${{ YEAR: '%Y', MONTH: '%m', DAY: '%d' }[p]}', ${arg}) AS INTEGER)`
    if (dialect === 'postgres') return `EXTRACT(${p} FROM ${arg})`
    return `${p}(${arg})`
  }
  switch (fn) {
    case 'YEAR':
    case 'MONTH':
    case 'DAY':
      return part(fn)
    case 'LENGTH':
      return dialect === 'mysql' ? `CHAR_LENGTH(${arg})` : `LENGTH(${arg})`
    case 'ROUND':
      return dialect === 'postgres' ? `ROUND(CAST(${arg} AS NUMERIC), ${digits})` : `ROUND(${arg}, ${digits})`
    default:
      return `${fn}(${arg})`
  }
}
