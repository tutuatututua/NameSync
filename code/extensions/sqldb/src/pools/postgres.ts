import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { ConnectionPool, KyselyDB } from './pool'

export default class PostgresPool implements ConnectionPool {
  private db: KyselyDB | null = null

  async connect(): Promise<KyselyDB> {
    if (this.db) return this.db
    this.db = new Kysely({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: process.env.DATABASE_URL }),
      }),
    })
    return this.db
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.destroy()
      this.db = null
    }
  }
}