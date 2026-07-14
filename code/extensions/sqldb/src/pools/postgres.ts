import { Pool, types } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { ConnectionPool, KyselyDB } from './pool'

// The API contract models timestamps as ISO strings (the SQLite era stored text).
// node-postgres parses timestamptz/timestamp into Date objects by default; return
// them as ISO strings instead so response schemas (z.string()) validate unchanged.
// (The parser is only invoked for non-null values.)
types.setTypeParser(1184, (v) => new Date(v).toISOString()) // timestamptz
types.setTypeParser(1114, (v) => new Date(v).toISOString()) // timestamp

export default class PostgresPool implements ConnectionPool {
  private db: KyselyDB | null = null

  async connect(): Promise<KyselyDB> {
    if (this.db) return this.db
    // DB_SCHEMA pins the search_path so unqualified table names resolve inside a
    // specific schema (e.g. `lakeshore` inside the shared `onewebdb` database).
    // Left unset, behaviour is unchanged (default search_path).
    const schema = process.env.DB_SCHEMA?.trim()
    this.db = new Kysely({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString: process.env.DATABASE_URL,
          ...(schema ? { options: `-c search_path=${schema}` } : {}),
        }),
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