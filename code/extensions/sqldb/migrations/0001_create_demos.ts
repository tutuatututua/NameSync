import { Kysely } from 'kysely'

/**
 * Sample migration for the sqldb extension. Consumers (e.g. the API) ship their
 * own `migrations/` folder resolved from their cwd; this one exists so the
 * extension's own test suite has a schema to run against.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('demos')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('count', 'integer')
    .addColumn('score', 'real')
    .addColumn('metadata', 'text')
    .addColumn('active', 'integer')
    .addColumn('created_at', 'text')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('demos').ifExists().execute()
}
