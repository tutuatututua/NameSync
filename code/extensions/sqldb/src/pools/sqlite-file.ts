import * as fs from 'fs'
import * as path from 'path'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { ConnectionPool, KyselyDB } from './pool'

const DB_PATH = 'database.sqlite'

export default class SqliteFilePool implements ConnectionPool {
  private db: KyselyDB | null = null

  private resolveDbPath(): string {
    const filePath = process.env.DATABASE_FILE
      ? path.resolve(process.env.DATABASE_FILE)
      : path.resolve(process.cwd(), DB_PATH)

    if (!fs.existsSync(path.dirname(filePath))) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
    }

    return filePath
  }

  async connect(): Promise<KyselyDB> {
    if (this.db) return this.db
    this.db = new Kysely({ dialect: new SqliteDialect({ database: new SQLite(this.resolveDbPath()) }) })
    return this.db
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.destroy()
      this.db = null
    }
  }
}