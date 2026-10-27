import pg from 'pg'
import type { ConnectionConfig, QueryResult, TableInfo } from '@shared/types'
import { elapsed, normalize, type Driver } from './driver'

// int8 (COUNT, bigserial) as numbers when they fit
pg.types.setTypeParser(20, (v) => {
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : v
})

type PgResult = pg.QueryResult<unknown[]>

export class PostgresDriver implements Driver {
  readonly dialect = 'postgres' as const
  private constructor(private client: pg.Client) {}

  static async connect(c: ConnectionConfig): Promise<PostgresDriver> {
    const client = new pg.Client({
      host: c.host || 'localhost',
      port: c.port || 5432,
      user: c.user,
      password: c.password,
      database: c.database,
      ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000
    })
    await client.connect()
    return new PostgresDriver(client)
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const t0 = performance.now()
    const res = (await this.client.query({ text: sql, rowMode: 'array' })) as PgResult | PgResult[]
    const all = Array.isArray(res) ? res : [res]
    const last = all[all.length - 1]
    if (!last?.fields?.length) {
      return { columns: [], rows: [], changes: last?.rowCount ?? 0, truncated: false, durationMs: elapsed(t0) }
    }
    return {
      columns: last.fields.map((f) => f.name),
      rows: last.rows.slice(0, maxRows).map((r) => r.map(normalize)),
      truncated: last.rows.length > maxRows,
      durationMs: elapsed(t0)
    }
  }

  async dryRun(sql: string): Promise<number> {
    await this.client.query('BEGIN')
    try {
      const res = (await this.client.query(sql)) as PgResult | PgResult[]
      return (Array.isArray(res) ? res : [res]).reduce((n, r) => n + (r.fields?.length ? 0 : r.rowCount ?? 0), 0)
    } finally {
      await this.client.query('ROLLBACK')
    }
  }

  async schema(): Promise<TableInfo[]> {
    const cols = await this.client.query<{ s: string; t: string; c: string; type: string; nullable: string; kind: string }>(`
      SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c, c.data_type AS type,
             c.is_nullable AS nullable, tb.table_type AS kind
      FROM information_schema.columns c
      JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position`)
    const keys = await this.client.query<{ s: string; t: string; c: string; type: string; rs: string; rt: string; rc: string }>(`
      SELECT kcu.table_schema AS s, kcu.table_name AS t, kcu.column_name AS c, tc.constraint_type AS type,
             ccu.table_schema AS rs, ccu.table_name AS rt, ccu.column_name AS rc
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.table_schema
      WHERE tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`)
    const label = (s: string, t: string): string => (s === 'public' ? t : `${s}.${t}`)
    const tables = new Map<string, TableInfo>()
    for (const r of cols.rows) {
      const name = label(r.s, r.t)
      if (!tables.has(name)) tables.set(name, { name, kind: r.kind === 'VIEW' ? 'view' : 'table', columns: [], foreignKeys: [] })
      tables.get(name)!.columns.push({ name: r.c, type: r.type, nullable: r.nullable === 'YES', pk: false })
    }
    for (const k of keys.rows) {
      const t = tables.get(label(k.s, k.t))
      if (!t) continue
      if (k.type === 'PRIMARY KEY') {
        const col = t.columns.find((c) => c.name === k.c)
        if (col) col.pk = true
      } else if (k.rt) {
        t.foreignKeys.push({ column: k.c, refTable: label(k.rs, k.rt), refColumn: k.rc })
      }
    }
    return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async close(): Promise<void> {
    await this.client.end()
  }
}
