import type { Lang } from './i18n'

export type Dialect = 'sqlite' | 'postgres' | 'mysql'

export interface ConnectionConfig {
  id: string
  name: string
  kind: Dialect
  /** SQLite file path */
  file?: string
  host?: string
  port?: number
  user?: string
  /** Only sent renderer -> main when saving. Never returned to the renderer. */
  password?: string
  hasPassword?: boolean
  database?: string
  ssl?: boolean
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  pk: boolean
}

export interface ForeignKey {
  column: string
  refTable: string
  refColumn: string
}

export interface TableInfo {
  name: string
  kind: 'table' | 'view'
  columns: ColumnInfo[]
  foreignKeys: ForeignKey[]
}

export type Cell = string | number | bigint | boolean | null | Date | Uint8Array

export interface QueryResult {
  columns: string[]
  rows: Cell[][]
  /** Rows changed by the last non-SELECT statement */
  changes?: number
  truncated: boolean
  durationMs: number
}

export interface DbError {
  message: string
  code?: string
}

export type Ok<T> = { ok: true; value: T }
export type Fail = { ok: false; error: DbError }
export type Res<T> = Ok<T> | Fail

export interface ImportResult {
  table: string
  rows: number
  connection: ConnectionConfig
}

export interface Settings {
  lang: Lang
  maxRows: number
  safeMode: boolean
  autoRun: boolean
}

export interface HistoryItem {
  sql: string
  at: number
  connection?: string
}
