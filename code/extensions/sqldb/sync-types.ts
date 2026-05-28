#!/usr/bin/env tsx

import fs from 'fs'
import path from 'path'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect, Migrator, FileMigrationProvider } from 'kysely'
import { generate, SqliteDialect as CodegenSqliteDialect } from 'kysely-codegen'

async function main() {
  // run all migrations against in-memory db
  const database = new SQLite(':memory:')

  const db = new Kysely<any>({
    dialect: new SqliteDialect({ database }),
  })

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs: fs.promises,
      path,
      migrationFolder: path.resolve(process.cwd(), 'migrations'),
    }),
  })

  const { error, results } = await migrator.migrateToLatest()
  results?.forEach(r => console.log(`[${r.status}] ${r.migrationName}`))
  if (error) { console.error(error); process.exit(1) }

  // generate types against the same live in-memory db instance
  await generate({
    db,
    dialect: new CodegenSqliteDialect(),
    outFile: path.resolve(process.cwd(), 'src/db.types.ts'),
  })

  await db.destroy()
  console.log('✓ src/db.types.ts updated')
}

main()