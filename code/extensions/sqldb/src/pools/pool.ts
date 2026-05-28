import { Kysely } from 'kysely'

export type KyselyDB = Kysely<any>

export interface ConnectionPool {
  connect(): Promise<KyselyDB>
  close(): Promise<void>
}