import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DBModel } from '../base.model'

export function createTempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  )
}

export function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

export async function useTestDb(dbPath: string): Promise<void> {
  process.env.DATABASE_FILE = dbPath
  process.env.ENVIRONMENT = 'TEST'
  // Close any open handle so a fresh pool is built and the previous DB file can
  // be removed — Windows keeps a lock on open SQLite files.
  await DBModel.closePool()
}

export async function resetPool(): Promise<void> {
  await DBModel.closePool()
}