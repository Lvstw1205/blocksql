import { DatabaseSync } from 'node:sqlite'
import type { ForeignKey, QueryResult, TableInfo } from '@shared/types'
import { splitStatements } from '@shared/doctor/tokenizer'
import { elapsed, normalize, type Driver } from './driver'

export class SqliteDriver implements Driver {
  readonly dialect = 'sqlite' as const
  private db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const t0 = performance.now()
    let result: QueryResult = { columns: [], rows: [], truncated: false, durationMs: 0 }
    for (const { text } of splitStatements(sql)) {
      const stmt = this.db.prepare(text)
      const cols = stmt.columns()
      if (cols.length) {
        stmt.setReturnArrays(true)
        stmt.setReadBigInts(true)
        const rows: QueryResult['rows'] = []
        let truncated = false
        for (const r of stmt.iterate() as Iterable<unknown[]>) {
          if (rows.length >= maxRows) {
            truncated = true
            break
          }
          rows.push(r.map(normalize))
        }
        result = { columns: cols.map((c) => c.name), rows, truncated, durationMs: 0 }
      } else {
        const r = stmt.run()
        result = { columns: [], rows: [], changes: Number(r.changes), truncated: false, durationMs: 0 }
      }
    }
    result.durationMs = elapsed(t0)
    return result
  }

  async dryRun(sql: string): Promise<number> {
    let changes = 0
    this.db.exec('BEGIN')
    try {
      for (const { text } of splitStatements(sql)) {
        const stmt = this.db.prepare(text)
        if (stmt.columns().length) continue
        changes += Number(stmt.run().changes)
      }
    } finally {
      this.db.exec('ROLLBACK')
    }
    return changes
  }

  async schema(): Promise<TableInfo[]> {
    const objects = this.db
      .prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string; type: 'table' | 'view' }[]
    const colStmt = this.db.prepare('SELECT name, type, "notnull" AS nn, pk FROM pragma_table_info(?)')
    const fkStmt = this.db.prepare('SELECT "from" AS col, "table" AS ref, "to" AS refcol FROM pragma_foreign_key_list(?)')
    return objects.map((o) => {
      const columns = (colStmt.all(o.name) as { name: string; type: string; nn: number; pk: number }[]).map((c) => ({
        name: c.name,
        type: c.type,
        nullable: !c.nn,
        pk: c.pk > 0
      }))
      const foreignKeys: ForeignKey[] = (fkStmt.all(o.name) as { col: string; ref: string; refcol: string | null }[]).map((f) => ({
        column: f.col,
        refTable: f.ref,
        refColumn: f.refcol ?? 'id'
      }))
      return { name: o.name, kind: o.type, columns, foreignKeys }
    })
  }

  async close(): Promise<void> {
    if (this.db.isOpen) this.db.close()
  }
}
