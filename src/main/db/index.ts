import type { ConnectionConfig } from '@shared/types'
import { t } from '@shared/i18n'
import type { Driver } from './driver'
import { MysqlDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { SqliteDriver } from './sqlite'

export type { Driver }

export async function openDriver(c: ConnectionConfig): Promise<Driver> {
  switch (c.kind) {
    case 'sqlite':
      if (!c.file) throw new Error(t('noSqlitePath'))
      return new SqliteDriver(c.file)
    case 'postgres':
      return PostgresDriver.connect(c)
    case 'mysql':
      return MysqlDriver.connect(c)
  }
}
