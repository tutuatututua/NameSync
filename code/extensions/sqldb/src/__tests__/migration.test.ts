import { sql } from 'kysely'
import { DBModel } from '../base.model'
import { createTempDbPath, cleanupDb, useTestDb, resetPool } from './helpers'

let dbPath: string

beforeAll(async () => {
  dbPath = createTempDbPath()
  await useTestDb(dbPath)
  await DBModel.getPool()
})

afterAll(async () => {
  await DBModel.closePool()
  delete process.env.DATABASE_FILE
  delete process.env.ENVIRONMENT
  cleanupDb(dbPath)
})

describe('migration lifecycle', () => {
  it('getPool() resolves without error', async () => {
    await expect(DBModel.getPool()).resolves.toBeDefined()
  })

  it('is idempotent — safe to run migrations multiple times', async () => {
    await resetPool()
    process.env.ENVIRONMENT = 'TEST'
    await expect(DBModel.getPool()).resolves.toBeDefined()
  })
})

describe('demos table schema', () => {
  interface PragmaColumn {
    cid: number
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }

  let columns: PragmaColumn[]

  beforeAll(async () => {
    const pool = await DBModel.getPool()
    const db = await pool.connect()
    const result = await sql<PragmaColumn>`PRAGMA table_info(demos)`.execute(db)
    columns = result.rows
  })

  it('creates the demos table', () => {
    expect(columns.length).toBeGreaterThan(0)
  })

  it('has exactly 7 columns', () => {
    expect(columns.length).toBe(7)
  })

  it.each([
    ['id',         'INTEGER'],
    ['name',       'VARCHAR'],
    ['count',      'INTEGER'],
    ['score',      'REAL'],
    ['metadata',   'TEXT'],
    ['active',     'INTEGER'],
    ['created_at', 'TEXT'],
  ] as const)('has column "%s" of type containing "%s"', (colName, typeFragment) => {
    const col = columns.find((c) => c.name === colName)
    expect(col).toBeDefined()
    expect(col!.type.toUpperCase()).toContain(typeFragment.toUpperCase())
  })

  it('id is the primary key', () => {
    const col = columns.find((c) => c.name === 'id')
    expect(col!.pk).toBe(1)
  })

  it('name is NOT NULL', () => {
    const col = columns.find((c) => c.name === 'name')
    expect(col!.notnull).toBe(1)
  })
})