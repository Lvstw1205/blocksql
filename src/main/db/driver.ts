import type { Cell, Dialect, QueryResult, TableInfo } from '@shared/types'

export interface Driver {
  readonly dialect: Dialect
  /** Run one or more statements; returns the last result set. */
  query(sql: string, maxRows: number): Promise<QueryResult>
  /** Run inside a transaction, roll back, and report how many rows would change. */
  dryRun(sql: string): Promise<number>
  schema(): Promise<TableInfo[]>
  close(): Promise<void>
}

/** bigints that fit in a double become numbers so the UI can sort and chart them */
export const normalize = (v: unknown): Cell => {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
  if (v instanceof Buffer) return new Uint8Array(v)
  if (v === undefined) return null
  return v as Cell
}

export const elapsed = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10
