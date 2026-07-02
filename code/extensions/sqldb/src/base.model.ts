import * as fs from 'fs'
import * as path from 'path'
import { Kysely, Migrator, FileMigrationProvider } from 'kysely'
import type { DB } from './db.types'
import { ConnectionPool, KyselyDB } from './pools/pool'
import PostgresPool from './pools/postgres'
import SqliteFilePool from './pools/sqlite-file'
import SqliteMemoryPool from './pools/sqlite-mem'

export abstract class DBModel {
  private static _pool: ConnectionPool | null = null
  private static poolPromise: Promise<ConnectionPool> | null = null

  static get pool(): ConnectionPool | null {
    return DBModel._pool
  }

  // Assigning null also clears any in-flight initialization, so the next
  // getPool() rebuilds from scratch (tests rely on this to force a fresh pool).
  static set pool(value: ConnectionPool | null) {
    DBModel._pool = value
    if (value === null) DBModel.poolPromise = null
  }

  private static createPool(): ConnectionPool {
    // Explicit override — used by the API (DB_ENGINE=postgres) and integration tests.
    switch (process.env.DB_ENGINE) {
      case 'postgres': return new PostgresPool()
      case 'sqlite-file': return new SqliteFilePool()
      case 'sqlite-mem': return new SqliteMemoryPool()
    }
    // Legacy ENVIRONMENT selector — kept so this extension's own tests are unchanged.
    if (process.env.ENVIRONMENT === 'PROD') return new PostgresPool()
    if (process.env.ENVIRONMENT === 'TEST') return new SqliteFilePool()
    // Convenience: a Postgres connection string implies Postgres.
    if (process.env.DATABASE_URL && /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL)) {
      return new PostgresPool()
    }
    return new SqliteMemoryPool()
  }

  private static async migrate(db: KyselyDB): Promise<void> {
    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({
        fs: fs.promises,
        path,
        migrationFolder: path.resolve(process.cwd(), 'migrations'),
      }),
    })
    const { error } = await migrator.migrateToLatest()
    if (error) throw error
  }

  static async getPool(): Promise<ConnectionPool> {
    if (DBModel._pool) return DBModel._pool

    // Share one in-flight initialization so concurrent callers don't each build a
    // pool. The pool is only published after migrations succeed; on failure the
    // promise is cleared so a later call can retry rather than reuse an
    // unmigrated database.
    if (!DBModel.poolPromise) {
      DBModel.poolPromise = (async () => {
        const pool = DBModel.createPool()
        const db = await pool.connect()
        await DBModel.migrate(db)
        DBModel._pool = pool
        return pool
      })().catch((err) => {
        DBModel.poolPromise = null
        throw err
      })
    }

    return DBModel.poolPromise
  }

  static async closePool(): Promise<void> {
    const pool = DBModel._pool
    DBModel.pool = null // clears _pool and poolPromise
    if (pool) await pool.close()
  }

  protected static async getKyselyDB(): Promise<Kysely<DB>> {
    const pool = await DBModel.getPool()
    return pool.connect() as Promise<Kysely<DB>>
  }
}
