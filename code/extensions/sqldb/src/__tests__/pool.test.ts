import { DBModel } from '../base.model'
import SqliteFilePool from '../pools/sqlite-file'
import SqliteMemoryPool from '../pools/sqlite-mem'
import { createTempDbPath, cleanupDb, useTestDb, resetPool } from './helpers'

describe('pool singleton', () => {
  let dbPath: string

  beforeEach(async () => {
    dbPath = createTempDbPath()
    await useTestDb(dbPath)
  })

  afterEach(async () => {
    await DBModel.closePool()
    cleanupDb(dbPath)
  })

  it('pool is null before any use', () => {
    expect(DBModel.pool).toBeNull()
  })

  it('pool is set after getPool()', async () => {
    await DBModel.getPool()
    expect(DBModel.pool).not.toBeNull()
  })

  it('same pool instance is returned on repeated calls', async () => {
    await DBModel.getPool()
    const pool1 = DBModel.pool

    await DBModel.getPool()
    const pool2 = DBModel.pool

    expect(pool1).toBe(pool2)
  })

  it('resetting pool to null forces a new instance', async () => {
    await DBModel.getPool()
    const pool1 = DBModel.pool

    await resetPool()
    await DBModel.getPool()
    const pool2 = DBModel.pool

    expect(pool2).not.toBe(pool1)
    expect(pool2).not.toBeNull()
  })

  it('concurrent getPool() calls do not create multiple instances', async () => {
    await Promise.all([DBModel.getPool(), DBModel.getPool(), DBModel.getPool()])

    const p1 = DBModel.pool
    await DBModel.getPool()
    expect(DBModel.pool).toBe(p1)
  })
})

describe('pool environment selection', () => {
  let savedEnv: string | undefined
  let savedDbFile: string | undefined
  const tempPaths: string[] = []

  beforeEach(async () => {
    savedEnv    = process.env.ENVIRONMENT
    savedDbFile = process.env.DATABASE_FILE
    await DBModel.closePool()
  })

  afterEach(async () => {
    await DBModel.closePool()
    if (savedEnv === undefined) delete process.env.ENVIRONMENT
    else process.env.ENVIRONMENT = savedEnv
    if (savedDbFile === undefined) delete process.env.DATABASE_FILE
    else process.env.DATABASE_FILE = savedDbFile
    for (const p of tempPaths.splice(0)) cleanupDb(p)
  })

  it('ENVIRONMENT=TEST creates a SqliteFilePool', async () => {
    const dbPath = createTempDbPath()
    tempPaths.push(dbPath)
    process.env.DATABASE_FILE = dbPath
    process.env.ENVIRONMENT = 'TEST'

    await DBModel.getPool()

    expect(DBModel.pool).toBeInstanceOf(SqliteFilePool)
  })

  it('no ENVIRONMENT variable creates a SqliteMemoryPool', async () => {
    delete process.env.ENVIRONMENT
    delete process.env.DATABASE_FILE

    await DBModel.getPool()

    expect(DBModel.pool).toBeInstanceOf(SqliteMemoryPool)
  })
})