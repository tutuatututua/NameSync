import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { ConnectionPool, KyselyDB } from './pool'

export default class SqliteMemoryPool implements ConnectionPool {
  private db: KyselyDB | null = null

  async connect(): Promise<KyselyDB> {
    if (this.db) return this.db
    this.db = new Kysely({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
    return this.db
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.destroy()
      this.db = null
    }
  }
}