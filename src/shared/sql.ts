import type { Dialect } from './types'
import { KEYWORDS } from './doctor/tokenizer'

// lowercase ASCII and Hangul read the same quoted or not in SQLite, PostgreSQL and MySQL
const SIMPLE_IDENT = /^[a-z_\uAC00-\uD7A3][a-z0-9_\uAC00-\uD7A3]*$/

/** Quote an identifier only when it needs it, so generated SQL stays readable. */
export function quoteIdent(name: string, dialect: Dialect): string {
  if (SIMPLE_IDENT.test(name) && !KEYWORDS.has(name.toUpperCase())) return name
  if (dialect === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  return '"' + name.replace(/"/g, '""') + '"'
}

/** Quote a possibly schema-qualified table name ("sales.orders"). */
export function quoteTable(name: string, dialect: Dialect): string {
  const dot = name.indexOf('.')
  if (dialect === 'postgres' && dot > 0) {
    return quoteIdent(name.slice(0, dot), dialect) + '.' + quoteIdent(name.slice(dot + 1), dialect)
  }
  return quoteIdent(name, dialect)
}

export function quoteString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

const NUMBER = /^-?\d+(\.\d+)?$/

/** Turn user-typed text into a SQL literal: numbers stay numbers, everything else is a string. */
export function literal(value: string): string {
  const v = value.trim()
  if (NUMBER.test(v) && !/^-?0\d/.test(v)) return v
  return quoteString(value)
}

export function sqlValue(value: unknown, dialect: Dialect): string {
  if (value === null || value === undefined || value === '') return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return dialect === 'postgres' ? String(value) : value ? '1' : '0'
  if (value instanceof Date) return quoteString(value.toISOString())
  return quoteString(String(value))
}

export const DIALECT_LABEL: Record<Dialect, string> = {
  sqlite: 'SQLite',
  postgres: 'PostgreSQL',
  mysql: 'MySQL'
}
