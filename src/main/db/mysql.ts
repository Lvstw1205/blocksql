import mysql from 'mysql2/promise'
import type { ConnectionConfig, QueryResult, TableInfo } from '@shared/types'
import { elapsed, normalize, type Driver } from './driver'

type Header = mysql.ResultSetHeader
type Rows = unknown[][]

const isHeader = (r: unknown): r is Header => !!r && !Array.isArray(r) && typeof r === 'object' && 'affectedRows' in r

export class MysqlDriver implements Driver {
  readonly dialect = 'mysql' as const
  private constructor(private conn: mysql.Connection) {}

  static async connect(c: ConnectionConfig): Promise<MysqlDriver> {
    const conn = await mysql.createConnection({
      host: c.host || 'localhost',
      port: c.port || 3306,
      user: c.user,
      password: c.password,
      database: c.database,
      ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
      multipleStatements: true,
      rowsAsArray: true,
      supportBigNumbers: true,
      dateStrings: true,
      connectTimeout: 10000
    })
    return new MysqlDriver(conn)
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const t0 = performance.now()
    const [res, fields] = await this.conn.query(sql)
    // multiple statements → arrays of results; fields becomes an array per statement
    const multi = Array.isArray(fields) && fields.length > 0 && (Array.isArray(fields[0]) || fields[0] === undefined)
    const results = multi ? (res as unknown[]) : [res]
    const fieldSets = multi ? (fields as unknown as (mysql.FieldPacket[] | undefined)[]) : [fields as mysql.FieldPacket[] | undefined]
    const i = results.length - 1
    const last = results[i]
    if (isHeader(last) || !fieldSets[i]) {
      return { columns: [], rows: [], changes: isHeader(last) ? last.affectedRows : 0, truncated: false, durationMs: elapsed(t0) }
    }
    const rows = last as Rows
    return {
      columns: fieldSets[i]!.map((f) => f.name),
      rows: rows.slice(0, maxRows).map((r) => r.map(normalize)),
      truncated: rows.length > maxRows,
      durationMs: elapsed(t0)
    }
  }

  async dryRun(sql: string): Promise<number> {
    await this.conn.query('START TRANSACTION')
    try {
      const [res] = await this.conn.query(sql)
      const list = Array.isArray(res) && res.length && isHeader(res[0]) ? (res as Header[]) : [res]
      return list.reduce((n: number, r) => n + (isHeader(r) ? r.affectedRows : 0), 0)
    } finally {
      await this.conn.query('ROLLBACK')
    }
  }

  async schema(): Promise<TableInfo[]> {
    const [cols] = await this.conn.query({
      sql: `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_KEY, t.TABLE_TYPE
            FROM information_schema.COLUMNS c
            JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
            WHERE c.TABLE_SCHEMA = DATABASE()
            ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      rowsAsArray: false
    })
    const [fks] = await this.conn.query({
      sql: `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
      rowsAsArray: false
    })
    const tables = new Map<string, TableInfo>()
    for (const r of cols as Record<string, string>[]) {
      const name = r.TABLE_NAME
      if (!tables.has(name)) tables.set(name, { name, kind: r.TABLE_TYPE === 'VIEW' ? 'view' : 'table', columns: [], foreignKeys: [] })
      tables.get(name)!.columns.push({ name: r.COLUMN_NAME, type: r.COLUMN_TYPE, nullable: r.IS_NULLABLE === 'YES', pk: r.COLUMN_KEY === 'PRI' })
    }
    for (const r of fks as Record<string, string>[]) {
      tables.get(r.TABLE_NAME)?.foreignKeys.push({ column: r.COLUMN_NAME, refTable: r.REFERENCED_TABLE_NAME, refColumn: r.REFERENCED_COLUMN_NAME })
    }
    return [...tables.values()]
  }

  async close(): Promise<void> {
    await this.conn.end()
  }
}
